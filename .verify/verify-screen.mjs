/* 「她看得见你屏幕上写了什么」端到端验收。
 *
 * 【为什么这一项要验得比别的都细】它是全项目里最重的一个开关 —— 读的是屏幕上的字。
 * 三个失败面各自都很安静：
 *   ① **确认卡形同虚设**（点了开关就开，或者勾选框没生效）—— 界面上完全看不出来，
 *      只有"必须先勾选才能按打开"这条真交互能验出来。
 *   ② **偷偷落盘**：截图写进临时文件却没删。这个只有盯着 ocr.ps1 回来的 `mode=memory`
 *      才发现得了（`temp` 就是走了临时文件那条退路）。
 *   ③ **敏感软件也照截**：密码管理器在前台时本该整趟跳过。
 *
 * 用法（PowerShell，先停真实例 —— 单实例锁）：
 *   $env:DSC_DATA_DIR="$env:TEMP\dsc-verify-screen"
 *   Remove-Item -Recurse -Force $env:DSC_DATA_DIR -ErrorAction SilentlyContinue
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   .\src-tauri\target\debug\ds-companion.exe
 *   node .verify/verify-screen.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
process.env.DSC_CDP = BASE;
const { requireIsolation } = await import('./_env.mjs');

const PROBE_DIR = join(tmpdir(), 'dsc-front-probe');
const NORMAL_EXE = 'dsc-front-probe.exe';
const SECRET_EXE = 'keepass-dsc-probe.exe';
/// 探针窗口上的字 —— 屏幕上没字的话 OCR 出来是空的，验不出东西
const PROBE_TITLE = '验收用的屏幕内容 - dsc-front-probe';

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('CDP 超时 ' + method));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
      }, 50);
      if (m.error) return reject(new Error(JSON.stringify(m.error)));
      resolve(m.result);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP 连接失败'));
    };
  });
}

async function evalIn(target, expression, timeoutMs) {
  const r = await send(
    target,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r && r.result ? r.result.value : undefined;
}

async function findTarget(match, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(`${BASE}/json/list`)).json();
      const t = list.find((x) => x.url && x.url.includes(match));
      if (t) return t;
    } catch {}
    if (Date.now() > deadline) return null;
    await sleep(300);
  }
}

/** 编一次探针 exe（rustc 单文件）；编不出来就跳过前面台那两段，绝不假装验过 */
function buildProbe() {
  mkdirSync(PROBE_DIR, { recursive: true });
  const src = join(process.cwd(), '.verify', 'front-probe.rs');
  if (!existsSync(src)) return '源码不在：' + src;
  const r = spawnSync('rustc', ['-O', src, '-o', join(PROBE_DIR, NORMAL_EXE)], {
    stdio: 'ignore',
    timeout: 120000,
  });
  if (r.error) return 'rustc 起不来：' + String(r.error.message || r.error);
  if (r.status !== 0) return 'rustc 退出码 ' + r.status;
  copyFileSync(join(PROBE_DIR, NORMAL_EXE), join(PROBE_DIR, SECRET_EXE));
  return '';
}

const probes = [];
function launch(name, args = []) {
  const p = spawn(join(PROBE_DIR, name), args, { stdio: 'ignore' });
  probes.push(p);
  return p;
}
function killProbes() {
  for (const p of probes.splice(0)) {
    try {
      p.kill();
    } catch {}
  }
}

/** 把某个进程的窗口切到前台（Windows 前台锁：必须 AttachThreadInput，见 probe-fg.ps1） */
function activate(pid) {
  const sig =
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); ' +
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid); ' +
    '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f); ' +
    '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); ' +
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); ' +
    '[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h); ' +
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);';
  const ps = [
    "$ErrorActionPreference='SilentlyContinue';",
    "Add-Type -MemberDefinition '" + sig + "' -Name Fg -Namespace DscProbe | Out-Null;",
    '$p = Get-Process -Id ' + pid + '; $p.Refresh();',
    '$h = $p.MainWindowHandle;',
    'if ($h -eq 0) { "no-window"; exit 0 };',
    '$fg = [DscProbe.Fg]::GetForegroundWindow();',
    '$fp = 0;',
    '$ft = [DscProbe.Fg]::GetWindowThreadProcessId($fg, [ref]$fp);',
    '$mt = [DscProbe.Fg]::GetCurrentThreadId();',
    '[void][DscProbe.Fg]::AttachThreadInput($mt, $ft, $true);',
    '[void][DscProbe.Fg]::ShowWindow($h, 9);',
    '[void][DscProbe.Fg]::BringWindowToTop($h);',
    '$r = [DscProbe.Fg]::SetForegroundWindow($h);',
    '[void][DscProbe.Fg]::AttachThreadInput($mt, $ft, $false);',
    'if ($r) { "ok" } else { "refused" }',
  ].join(' ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 25000,
  });
  return String(r.stdout || '').trim();
}
async function bringToFront(proc) {
  for (let i = 0; i < 10; i++) {
    if (activate(proc.pid) === 'ok') return true;
    await sleep(400);
  }
  return false;
}

// ── 开跑 ────────────────────────────────────────────────────────────
console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com', 45000);
if (!main) throw new Error('主窗口没起来');
await evalIn(main, `window.__TAURI_INTERNALS__.invoke('open_settings').then(()=>1).catch(e=>String(e))`);
const settings = await findTarget('settings.html', 25000);
if (!settings) throw new Error('设置窗口没起来');
await requireIsolation();

async function call(expr) {
  const raw = await evalIn(
    settings,
    `(async () => { try { const v = await window.__TAURI_INTERNALS__.invoke(${expr});
        return JSON.stringify({ ok: true, v }); }
      catch (e) { return JSON.stringify({ ok: false, err: String(e) }); } })()`,
  );
  const o = JSON.parse(raw);
  if (!o.ok) throw new Error(`${expr.slice(0, 70)} → ${o.err}`);
  return o.v;
}

// ══════════════════ A. 默认必须是关的 ══════════════════
console.log('\n=== A. 默认必须是关的 ===');
// 先归零：隔离目录会被上一轮动过（脚本半路崩掉更会留下 true）
const fresh = await call(`'config_get'`);
await call(
  `'config_set', { cfg: ${JSON.stringify({ ...fresh, screenWatch: false, screenEveryMinutes: 5, screenChars: 240 })} }`,
);
await sleep(400);
const cfg0 = await call(`'config_get'`);
check('摆回默认后 screenWatch 是 false', cfg0.screenWatch === false, String(cfg0.screenWatch));

const clickedTab = await evalIn(
  settings,
  `(() => { const b = document.querySelector('.tb-tab[data-tab="tools"]'); if (b) b.click(); return !!b; })()`,
);
check('能切到「工具」页', clickedTab === true);
await sleep(1000);
const ui = JSON.parse(
  (await evalIn(
    settings,
    `JSON.stringify({
       has: !!document.getElementById('sc-enabled'),
       checked: !!(document.getElementById('sc-enabled') || {}).checked,
       every: document.querySelectorAll('#sc-every button[data-v]').length,
       chars: document.querySelectorAll('#sc-chars button[data-v]').length,
       maskHidden: (document.getElementById('screen-mask') || { classList: { contains: () => true } }).classList.contains('hidden'),
       now: (document.getElementById('sc-now') || {}).textContent || ''
     })`,
  )) || '{}',
);
check('设置界面上有那个开关', ui.has === true, JSON.stringify(ui));
check('开关初始是关的', ui.checked === false);
check('间隔有 6 档可选（1/2/5/10/15/30）', ui.every === 6, String(ui.every));
check('字数有 3 档可选（200/240/300）', ui.chars === 3, String(ui.chars));
check('确认卡初始是收起的', ui.maskHidden === true);
check('读数明说"还没有看过"', /还没有看过/.test(ui.now), ui.now);

// ══════════════════ B. 打开必须过确认卡 ══════════════════
console.log('\n=== B. 打开必须过确认卡（这一条是这一项的命门）===');
// 真实点一下开关 —— 它**不该**直接打开，而该弹确认卡
await evalIn(settings, `document.getElementById('sc-enabled').click()`);
await sleep(400);
const afterClick = JSON.parse(
  (await evalIn(
    settings,
    `JSON.stringify({
       cb: document.getElementById('sc-enabled').checked,
       maskOpen: !document.getElementById('screen-mask').classList.contains('hidden'),
       confirmDisabled: document.getElementById('sc-confirm').disabled,
       ack: document.getElementById('sc-ack').checked
     })`,
  )) || '{}',
);
check('点开关**没有**直接打开（勾退回去了）', afterClick.cb === false, JSON.stringify(afterClick));
check('弹出了确认卡', afterClick.maskOpen === true);
check('没勾选前「打开」是禁用的', afterClick.confirmDisabled === true);
check('勾选框初始未勾', afterClick.ack === false);

// 没勾选就点「打开」—— 按钮是 disabled，点了不该有任何效果
await evalIn(settings, `document.getElementById('sc-confirm').click()`);
await sleep(300);
const stillOff = await call(`'config_get'`);
check('没勾选时点「打开」不会生效', stillOff.screenWatch === false, String(stillOff.screenWatch));

// 勾上 → 按钮可用 → 点它
await evalIn(settings, `document.getElementById('sc-ack').click()`);
await sleep(200);
const acked = await evalIn(settings, `document.getElementById('sc-confirm').disabled`);
check('勾选之后「打开」才可用', acked === false);
await evalIn(settings, `document.getElementById('sc-confirm').click()`);
await sleep(900);
const cfgOn = await call(`'config_get'`);
check('确认之后配置真的开了', cfgOn.screenWatch === true, String(cfgOn.screenWatch));
const maskClosed = await evalIn(
  settings,
  `document.getElementById('screen-mask').classList.contains('hidden')`,
);
check('确认卡自动收起', maskClosed === true);
const uiOn = JSON.parse(
  (await evalIn(
    settings,
    `JSON.stringify({
       cb: document.getElementById('sc-enabled').checked,
       sub: (document.getElementById('sc-sub') || {}).textContent || ''
     })`,
  )) || '{}',
);
check('开关勾上了、小字说明也更新了', uiOn.cb === true && /每 5 分钟/.test(uiOn.sub), JSON.stringify(uiOn));

// 再关一次 → 重开必须**再走一遍**确认卡（确认状态不落盘）
await evalIn(settings, `document.getElementById('sc-enabled').click()`);
await sleep(600);
check('关掉是即时的（不用确认）', (await call(`'config_get'`)).screenWatch === false);
await evalIn(settings, `document.getElementById('sc-enabled').click()`);
await sleep(400);
const reopened = await evalIn(
  settings,
  `!document.getElementById('screen-mask').classList.contains('hidden')`,
);
check('★再打开还要再确认一遍★（确认状态不落盘）', reopened === true);
// 重新打开，后面几段要它开着
await evalIn(settings, `document.getElementById('sc-ack').click()`);
await sleep(150);
await evalIn(settings, `document.getElementById('sc-confirm').click()`);
await sleep(800);
check('重新开启成功', (await call(`'config_get'`)).screenWatch === true);

// ══════════════════ C. 真的截屏 + 真的认字（且不落盘）══════════════════
console.log('\n=== C. 真的截了屏、真的认出了字 ===');
const buildErr = buildProbe();
if (buildErr) {
  check('探针 exe 编出来了（C/D 段的前提）', false, buildErr);
} else {
  // 前台若是设置窗口自己，壳会跳过（"在看自己"）—— 所以先把前台钉到一个**有字的窗口**上
  const a = launch(NORMAL_EXE, [PROBE_TITLE]);
  await sleep(900);
  const front = await bringToFront(a);
  check('能把探针切到前台', front === true);
  await sleep(500);

  const snap = await call(`'dsc_screen_now'`);
  check('这次真的看了（没被跳过）', !snap.skipped, JSON.stringify(snap).slice(0, 140));
  check('认出了字（行数 > 0）', Number(snap.lines) > 0, `lines=${snap.lines}`);
  check('喂给她的那段落非空', String(snap.text || '').trim().length > 0, JSON.stringify(snap.text || '').slice(0, 80));
  check(
    '字数守住了上限（≤ 300）',
    Number(snap.chars) <= 300,
    `chars=${snap.chars}`,
  );
  // ★这一条才是隐私承诺★
  check('★截图全程没落盘★（mode=memory）', snap.mode === 'memory', String(snap.mode));
  check('耗时可读（没卡住）', Number(snap.ms) > 0 && Number(snap.ms) < 20000, `${snap.ms}ms`);
  console.log(`    ↳ 认到的内容：${JSON.stringify(String(snap.text || '').slice(0, 60))}`);
  console.log(`    ↳ ${snap.size} / ${snap.lines} 行 / ${snap.chars} 字 / ${snap.ms}ms / ${snap.mode}`);

  // 汉字之间那个空格必须被说掉（Windows OCR 逐字给框）
  const hasSpacedHan = /[\u4e00-\u9fff] [\u4e00-\u9fff]/.test(String(snap.text || ''));
  check('汉字之间的空格被说掉了', hasSpacedHan === false, JSON.stringify(String(snap.text || '').slice(0, 60)));

  // ══════════════════ D. 敏感软件在前台：这一趟根本不截 ══════════════════
  console.log('\n=== D. 密码管理器在前台时不截 ===');
  const beforeMs = Number(snap.ms);
  const b = launch(SECRET_EXE, ['我的密码库']);
  await sleep(900);
  await bringToFront(b);
  await sleep(500);
  const snap2 = await call(`'dsc_screen_now'`);
  check('被跳过了', !!snap2.skipped, JSON.stringify(snap2).slice(0, 140));
  check('跳过理由说的是敏感软件', /敏感/.test(String(snap2.skipped || '')), String(snap2.skipped));
  // 【怎么证明"根本没截"】看耗时：跑过一次 OCR 的 ms 是实打实的一千多毫秒；
  // 跳过那一趟一次都没跑，ms 还停在上一次的值上。text 留着上一次的内容是**刻意的**
  // （不能因为他切了个窗口，就把她本来已经知道的那段抹掉）。
  check(
    '★没有偷偷跑 OCR★（耗时还停在上一次的值上）',
    Number(snap2.ms) === beforeMs,
    `ms=${snap2.ms} 上一次=${beforeMs}`,
  );
  check('跳过也记了时间（读数会更新成"刚刚没看"）', Number(snap2.at) >= Number(snap.at), `${snap2.at} vs ${snap.at}`);
  killProbes();
}

// ══════════════════ E. 送进对话，而且一样就不重复送 ══════════════════
console.log('\n=== E. 送进对话 ===');
async function driveTurn(text) {
  await evalIn(main, `window.__DSC_REPORT_TURN__(${JSON.stringify(text)})`);
  await sleep(1100);
}
async function readTurn() {
  const raw = await evalIn(main, `JSON.stringify(Object.assign({}, window.__DSC_TURN__ || {}))`);
  return JSON.parse(raw || '{}');
}
// 先造一次快照（前台刚才可能被切走了，无所谓 —— 只要内存里有一段就算数）
if (!buildErr) {
  const c = launch(NORMAL_EXE, [PROBE_TITLE]);
  await sleep(800);
  await bringToFront(c);
  await sleep(400);
  await call(`'dsc_screen_now'`);
  await sleep(300);
}
await driveTurn('验收：屏幕那块进没进 prompt');
const t1 = await readTurn();
check('壳把【他屏幕上】带回来了', String(t1.screen || '').indexOf('【他屏幕上】') >= 0, String(t1.screen || '').slice(0, 60));
const prompt = await evalIn(
  main,
  `(function(){
     const body = window.__DSC_AUGMENT__(JSON.stringify({prompt:'x', chat_session_id:'probe-screen'}), 'probe');
     const p = body ? (JSON.parse(body).prompt || '') : '';
     return p.indexOf('【他屏幕上】') >= 0;
   })()`,
);
check('这一块真的拼进了发给模型的 prompt', prompt === true);
// 一模一样就不再送（同一个页面盯久了不该每轮都花额度）
await driveTurn('验收：再问一次');
const t2 = await readTurn();
check('两轮之间内容没变 → 不再重复注入', String(t2.screen || '') === '', JSON.stringify(String(t2.screen || '').slice(0, 40)));

// ══════════════════ F. 关掉 ══════════════════
console.log('\n=== F. 关掉 ===');
await call(
  `'config_set', { cfg: ${JSON.stringify({ ...(await call(`'config_get'`)), screenWatch: false })} }`,
);
await sleep(400);
await driveTurn('验收：关掉之后');
const t3 = await readTurn();
check('关掉之后不再注入', String(t3.screen || '') === '', JSON.stringify(String(t3.screen || '').slice(0, 40)));
const snapOff = await call(`'dsc_screen_state'`);
check('关掉之后也不会再去截（读数里是"没开"）', /没开/.test(String(snapOff.skipped || '')), String(snapOff.skipped));

killProbes();
try {
  rmSync(join(PROBE_DIR, SECRET_EXE), { force: true });
} catch {}
const cfgEnd = await call(`'config_get'`);
check('收尾：配置恢复成默认关', cfgEnd.screenWatch === false, String(cfgEnd.screenWatch));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
