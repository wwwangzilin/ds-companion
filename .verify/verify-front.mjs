/* 「她看得见你在用什么软件」端到端验收。
 *
 * 【为什么单开一个脚本】这一层跨了三个完全不同的失败面：
 *   ① **隐私契约**（壳）：默认必须关；敏感进程（密码管理器/银行）连进程名都不许出去；
 *      返回值里不许出现窗口标题。坏了不会报错，只会**静默泄**。
 *   ② **真的读得到**（壳）：裸 FFI 编得过 ≠ 读得到（权限、前台是系统窗口、API 用法）。
 *      而且"读到一次"和"跟着前台走"是两件事 —— 切了窗口读数不变，等于它卡住了。
 *   ③ **真的送进 prompt**（页面）：壳算完带回来、页面却没用它，界面上一切正常，
 *      只是她永远不知道你在干什么。这条只能靠 augment 出来的正文来断。
 *
 * 【为什么造一个假进程】"敏感进程连名字都不给"这条，只有**真的有一个叫
 * keepass-xxx.exe 的窗口跑到前台**才验得出来。系统自带的记事本改名的路子靠不住
 * （Win11 的 System32\notepad.exe 只是转发器，真起来的叫 Notepad.exe）。所以用
 * rustc 单文件编一个只弹 MessageBox 的极小程序，复制成两个名字来验。
 *
 * 用法（PowerShell，先停真实例 —— 单实例锁）：
 *   $env:DSC_DATA_DIR="$env:TEMP\dsc-verify-front"
 *   Remove-Item -Recurse -Force $env:DSC_DATA_DIR -ErrorAction SilentlyContinue
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   .\src-tauri\target\debug\ds-companion.exe
 *   node .verify/verify-front.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
process.env.DSC_CDP = BASE;
const { requireIsolation } = await import('./_env.mjs');

const here = dirname(fileURLToPath(import.meta.url));
const PROBE_DIR = join(tmpdir(), 'dsc-front-probe');
const NORMAL_EXE = 'dsc-front-probe.exe';
const SECRET_EXE = 'keepass-dsc-probe.exe';

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CDP ─────────────────────────────────────────────────────────────
function send(target, method, params = {}, timeoutMs = 25000) {
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
      // 不要在 onmessage 里立刻 close：会让 node 的 ws 在 uv 收尾阶段断言崩掉
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
      }, 50);
      if (m.error) {
        reject(new Error(JSON.stringify(m.error)));
        return;
      }
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
    } catch {
      /* 还没起 */
    }
    if (Date.now() > deadline) throw new Error(`等不到窗口：${match}`);
    await sleep(300);
  }
}

// ── 探针进程 ─────────────────────────────────────────────────────────
/** 编一次探针 exe（rustc 单文件，不需要 cargo 工程）；编不出来就退掉 C 段，绝不假装验过 */
function buildProbe() {
  mkdirSync(PROBE_DIR, { recursive: true });
  const src = join(here, 'front-probe.rs');
  if (!existsSync(src)) return '源码不在：' + src;
  const r = spawnSync('rustc', ['-O', src, '-o', join(PROBE_DIR, NORMAL_EXE)], {
    stdio: 'ignore',
    timeout: 120000,
  });
  if (r.error) return 'rustc 起不来：' + String(r.error.message || r.error);
  if (r.status !== 0) return 'rustc 退出码 ' + r.status;
  if (!existsSync(join(PROBE_DIR, NORMAL_EXE))) return '没产出 exe';
  copyFileSync(join(PROBE_DIR, NORMAL_EXE), join(PROBE_DIR, SECRET_EXE));
  return '';
}

function launch(name) {
  // stdio 一律 ignore：不抓子进程输出，省掉一堆管道上的麻烦
  return spawn(join(PROBE_DIR, name), [], { stdio: 'ignore' });
}

/**
 * 把某个进程的窗口切到前台。
 *
 * 【为什么要这么一长串】Windows 有"前台锁定"：不是前台进程的进程调
 * SetForegroundWindow 会被直接拒掉（实测返回 False，前台还是原来那个，而且**不报错**）。
 * AppActivate 那一套走 COM，对这种没有标题栏的顶层窗口经常干脆返回 false 什么都不说。
 * 能过锁的组合是：先 AttachThreadInput 把自己的线程挂到当前前台线程的输入队列上，
 * 再 ShowWindow(SW_RESTORE) + BringWindowToTop + SetForegroundWindow。
 * （`.verify/probe-fg.ps1` 是这段的实测现场：plain=False，attach=True。）
 *
 * 返回 'ok' / 'refused' / 'no-window' —— 调用方要重试（窗口刚起来时句柄可能还是 0）。
 */
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

/** 反复试着把它切到前台（窗口刚起来时句柄为 0，一次不成就放弃会假红） */
async function bringToFront(proc) {
  for (let i = 0; i < 10; i++) {
    if (activate(proc.pid) === 'ok') return true;
    await sleep(400);
  }
  return false;
}

const probes = [];
function killProbes() {
  for (const p of probes.splice(0)) {
    try {
      p.kill();
    } catch {}
  }
}

// ── 开跑 ────────────────────────────────────────────────────────────
console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com', 45000);
await evalIn(main, `window.__TAURI_INTERNALS__.invoke('open_settings').then(()=>1).catch(e=>String(e))`);
const settings = await findTarget('settings.html', 25000);
console.log(`[target] settings = ${settings.url.slice(0, 60)}`);
await requireIsolation();

/** 设置窗口里调一条壳命令，失败直接抛（别让断言拿到 undefined 去静默 PASS） */
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

async function readFront() {
  return call(`'dsc_front_app'`);
}

/** 连采几次，直到满足条件（切前台是异步的，一次取样会假红） */
async function sampleUntil(ok, tries = 14) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await readFront();
    if (ok(last)) return last;
    await sleep(400);
  }
  return last;
}

/** 把 watchApp 打开/关掉（读-改-写，绝不整份盲写） */
async function setWatch(on) {
  const cur = await call(`'config_get'`);
  await call(`'config_set', { cfg: ${JSON.stringify({ ...cur, watchApp: on })} }`);
}

/** 页面侧：当前各块文本（只读看板，见 inject.js 的 __DSC_TURN__） */
async function readTurn() {
  const raw = await evalIn(
    main,
    `JSON.stringify(Object.assign({}, window.__DSC_TURN__ || {}))`,
  );
  return JSON.parse(raw || '{}');
}

/** 页面侧：驱动一轮 reportTurn（就是"主人说了一句话"走的那条路） */
async function driveTurn(text) {
  await evalIn(main, `window.__DSC_REPORT_TURN__(${JSON.stringify(text)})`);
  await sleep(1100);
}

/**
 * 页面侧：augment 出来的正文里有没有这块。
 *
 * 【规矩】别把正文送回 node 再判断（augment 返回的是 JSON 字符串，CDP 再包一层，
 * 解析出 null 时会静默变成空 prompt → 断言假红，verify-taskmode 踩过）。
 * 在页面里判断完，只把布尔结果送回来。
 */
async function promptHasBlock(marker) {
  const raw = await evalIn(
    main,
    `(function(){
       const body = window.__DSC_AUGMENT__(JSON.stringify({prompt:'x', chat_session_id:'probe-front'}), 'probe');
       if (!body) return JSON.stringify({ err: 'augment 返回空' });
       const p = JSON.parse(body).prompt || '';
       return JSON.stringify({ has: p.indexOf(${JSON.stringify(marker)}) >= 0, len: p.length });
     })()`,
  );
  return JSON.parse(raw || '{}');
}

// ══════════════════════ A. 默认关 ══════════════════════
console.log('\n=== A. 默认必须是关的 ===');
const cfg0 = await call(`'config_get'`);
check('配置里 watchApp 默认就是 false', cfg0.watchApp === false, String(cfg0.watchApp));
const off = await readFront();
check('关着时 dsc_front_app 说 enabled=false', off.enabled === false, JSON.stringify(off));
check('关着时连一个字节的读数都不返回', off.text === '', JSON.stringify(off.text));

// 设置界面：真实点一下「工具」页签（不直接调内部函数，否则验不出接线）
const clicked = await evalIn(
  settings,
  `(() => { const b = document.querySelector('.tb-tab[data-tab="tools"]'); if (b) b.click(); return !!b; })()`,
);
check('设置界面里有「工具」页签可点', clicked === true);
await sleep(900);
const ui0 = await evalIn(
  settings,
  `JSON.stringify({
     has: !!document.getElementById('tl-front'),
     checked: !!(document.getElementById('tl-front') || {}).checked,
     now: (document.getElementById('tl-front-now') || {}).textContent || '',
     sub: (document.getElementById('tl-front-sub') || {}).textContent || ''
   })`,
);
const u0 = JSON.parse(ui0 || '{}');
check('设置界面上有那个开关', u0.has === true);
check('开关初始是关的（跟配置一致）', u0.checked === false, JSON.stringify(u0));
check('读数位置明说"关着"，不是留空', /关着/.test(u0.now), u0.now);

// ══════════════════════ B. 打开后真的读得到 ══════════════════════
console.log('\n=== B. 打开之后真的读得到 ===');
await setWatch(true);
await sleep(400);
const on = await sampleUntil((r) => r.enabled === true && !!r.text, 8);
check('打开后 enabled=true', on.enabled === true, JSON.stringify(on));
check('拿到了一个进程名', typeof on.exe === 'string' && on.exe.length > 0, String(on.exe));
const KINDS = ['ide', 'terminal', 'browser', 'chat', 'media', 'game', 'other'];
check('kind 是约定里的那一档', KINDS.indexOf(on.kind) >= 0, String(on.kind));
check('text 就是"进程名（在干什么）"这句话', on.text.indexOf(on.exe) === 0, on.text);
check('busy 只跟 ide/terminal 有关', on.busy === (on.kind === 'ide' || on.kind === 'terminal'), `kind=${on.kind} busy=${on.busy}`);
// ★结构层面的隐私断言★：一旦有人往里塞 title/winTitle，这条立刻红
const keys = Object.keys(on).sort().join(',');
check('返回值里只有约定字段，没有任何标题类字段', keys === 'busy,enabled,exe,kind,sinceMs,text', keys);

// ══════════════════════ C. 跟着前台走 + 敏感打码 ══════════════════════
console.log('\n=== C. 真的跟着前台走 / 敏感进程连名字都不给 ===');
const buildErr = buildProbe();
if (buildErr) {
  check('探针 exe 编出来了（C 段的前提）', false, buildErr);
} else {
  // 普通探针：进程名不在任何白名单里 → other，但名字要如实报出来
  const a = launch(NORMAL_EXE);
  probes.push(a);
  await sleep(900);
  const gotA = await bringToFront(a);
  check('能把窗口切到前台（前台锁得靠 AttachThreadInput 才过得去）', gotA === true, String(gotA));
  const ra = await sampleUntil((r) => r.exe === NORMAL_EXE);
  check('切到普通探针 → 读到的就是它', ra.exe === NORMAL_EXE, JSON.stringify(ra));
  check('没见过的进程归 other，但名字照样给', ra.kind === 'other' && ra.exe === NORMAL_EXE, JSON.stringify(ra));

  // ★敏感探针★：名字里带 keepass → 必须被打码
  const b = launch(SECRET_EXE);
  probes.push(b);
  await sleep(900);
  const gotB = await bringToFront(b);
  check('能把敏感探针切到前台', gotB === true, String(gotB));
  const rb = await sampleUntil((r) => r.kind === 'other' && r.exe === '');
  check('敏感进程的进程名一个字都不给', rb.exe === '', JSON.stringify(rb));
  check('敏感进程的读数只说"在别的软件里"', rb.text === '在别的软件里', String(rb.text));
  check('敏感进程也不算 busy（不泄露"在哪类软件里"）', rb.busy === false, String(rb.busy));

  // 切回普通探针：证明读数是真的在跟前台走，不是卡在第一个值上
  await bringToFront(a);
  const rc = await sampleUntil((r) => r.exe === NORMAL_EXE);
  check('再切回普通探针 → 又读得到它（真的在跟随前台）', rc.exe === NORMAL_EXE, JSON.stringify(rc));
}

// ══════════════════════ D. 真的送进 prompt ══════════════════════
console.log('\n=== D. 这一块真的拼进了发给模型的正文 ===');
// 前台此刻停着探针（C 段切过去的）——正好用来验"壳读到的 = 页面拿到的"
await driveTurn('验收：她看不看得见我在用什么');
const t1 = await readTurn();
check('壳把【他此刻】带回到页面了', String(t1.front || '').indexOf('【他此刻】') >= 0, String(t1.front || '').slice(0, 70));
const expectExe = buildErr ? '' : NORMAL_EXE;
if (expectExe) {
  check('带回来的就是你此刻真的在前台的那个进程', String(t1.front).indexOf(expectExe) >= 0, String(t1.front).slice(0, 70));
}
const p1 = await promptHasBlock('【他此刻】');
check('这一块真的拼进了发给模型的 prompt', p1.has === true, JSON.stringify(p1));
const hasExeInPrompt = expectExe
  ? await evalIn(
      main,
      `(function(){
         const body = window.__DSC_AUGMENT__(JSON.stringify({prompt:'x', chat_session_id:'probe-front'}), 'probe');
         const p = body ? (JSON.parse(body).prompt || '') : '';
         return p.indexOf(${JSON.stringify(expectExe)}) >= 0;
       })()`,
    )
  : null;
if (expectExe) check('prompt 里带着那个进程名', hasExeInPrompt === true);

// 关掉之后：下一轮必须什么都不注入（一个字节都不加）
await setWatch(false);
await sleep(300);
await driveTurn('验收：关掉之后');
const t2 = await readTurn();
check('关掉之后，页面手里那块被清空了', (t2.front || '') === '', JSON.stringify(t2.front));
const p2 = await promptHasBlock('【他此刻】');
check('关掉之后 prompt 里也没有这一块', p2.has === false, JSON.stringify(p2));
const off2 = await readFront();
check('关掉之后读数回到 enabled=false', off2.enabled === false, JSON.stringify(off2));

// ══════════════════════ 收尾 ══════════════════════
killProbes();
try {
  rmSync(join(PROBE_DIR, SECRET_EXE), { force: true });
} catch {}
const cfgEnd = await call(`'config_get'`);
check('收尾：配置恢复到默认关（不留一个开着的隐私开关）', cfgEnd.watchApp === false, String(cfgEnd.watchApp));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
