/* 她"亲眼看一眼屏幕"这条路的端到端验收。
 *
 * 【验的是什么】不是多模态通不通（那已经被 probe-vision-focus.mjs 验过了），而是
 * **这一条新链路**：
 *     壳定时截屏 → 缩到 512 → 把鼠标位置画成圈 → 交给页面
 *       → 页面上传 + 用定稿提示词问她 → 她答"在做什么 + 重点" → 回传给壳
 *         → 壳下一轮把它拼进【他屏幕上】
 *
 * 【为什么能验"重点"】前台放的是 .verify/see-target.ps1 那个内容固定的窗口，
 * 上面唯一一块深红色的字是 `* release code 7788` —— 那就是这块板子的"重点"。
 * 她要是不光念大标题、还把 7788 抄了出来，说明"圈 + 提示词"这条路真的把她的注意力
 * 落到了正确的地方。拿主人的真实屏幕验不出这个：没有可断言的期望值，还会把屏幕内容
 * 传到账号里。
 *
 * 前置（不满足就退出，脚本不负责起这些东西）：
 *   ① app 用**隔离数据目录** + CDP 起来，且那份 config.json 里
 *      screen_watch=true、screen_see=true（壳起来后 15 秒内必然自己截第一次）
 *   ② .verify/see-target.ps1 已经在跑、并在前台
 *
 * 用法：$env:DSC_ALLOW_REAL_DATA='1'; node .verify/verify-screen-see.mjs
 */
import { requireIsolation } from './_env.mjs';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROUNDS = Number(process.env.DSC_SEE_ROUNDS || 14);

function send(target, method, params = {}, timeoutMs = 120000) {
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
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
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

async function findTarget(match, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(`${BASE}/json/list`)).json();
      const t = list.find((x) => x.url && x.url.includes(match));
      if (t) return t;
    } catch {}
    if (Date.now() > deadline) throw new Error('等不到 ' + match);
    await sleep(300);
  }
}

console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com');

// 【顺序有讲究】门禁（requireIsolation）是问**设置窗口**要数据目录的，所以必须先把它
// 叫出来，门禁才走得通。第一版把门禁放在最前面，结果它自己把脚本拦了（exit 2）。
await evalIn(main, `window.__TAURI_INTERNALS__.invoke('open_settings')`);
let settings = null;
try {
  settings = await findTarget('settings.html', 40000);
} catch {
  console.log('FAIL  叫不出设置窗口 —— open_settings 失败？');
  process.exit(2);
}
await requireIsolation();

// ── 武装：把两个开关打开 ──────────────────────────────────────────────
// 【为什么要走设置页】`config_set` 只允许本地设置窗口调（远程页面没有这个权限）——
// 而"手写一份 config.json"这条路走不通：它不是全字段可选，缺一个 `cadence` 就会被
// 当成坏文件隔离掉、然后拿默认值启动（实测踩过，现象是"开关开了但一个截图都没有"）。
//
// 【字段名必须是 camelCase】AppConfig 上有 `serde(rename_all = "camelCase")`，所以前端
// 看到的是 `screenWatch` / `screenSee`。按 Rust 那边的 snake_case 写，等于**加了个新字段**：
// serde 忽略未知字段、原字段还是 false，而回读拿到的也是 undefined —— 现象就是
// `[arm] {}`：既没报错、开关也没开。这个坑在 Quill 的 AI 参数上踩过一次（maxTokens）。
// 【要一个干净的起点】这条链路有两道去重：①壳"同一屏内容只造一张图" ②注入块
// "和上一轮一样就不再注入"。它们平时是对的（同一页盯半小时不该反复花额度），但验收
// 里会让"第二次跑同一块板子"看起来像坏了（板子的 OCR 文本一模一样）。
// 清起点走**关一次开关**这条路：壳关开关时会清掉去重状态（`forget_last_injected`）。
await evalIn(main, `window.__DSC_LAST_SHOT__ = null`);
const armed = await evalIn(
  settings,
  `(async () => {
     const inv = window.__TAURI_INTERNALS__.invoke;
     const cfg = await inv('config_get');
     cfg.screenWatch = false;
     await inv('config_set', { cfg: cfg });
     cfg.screenWatch = true;
     cfg.screenSee = true;
     cfg.screenEveryMinutes = 1;
     await inv('config_set', { cfg: cfg });
     const back = await inv('config_get');
     return JSON.stringify({
       watch: back.screenWatch, see: back.screenSee, every: back.screenEveryMinutes,
     });
   })()`,
  60000,
);
console.log('[arm] ' + armed);
if (!/"watch":true/.test(String(armed)) || !/"see":true/.test(String(armed))) {
  console.log('FAIL  开关没打开');
  process.exit(1);
}

// ── 把验收窗口抢回前台 + 把鼠标停到它中间 ──────────────────────────────
// 开关这一步把注意力给了设置窗口，而壳截的是**前台窗口** —— 不抢回来的话它截到的是
// 它自己（会被"在看自己"跳过）。鼠标位置就是图里那个圈，所以也得摆进去。
const { spawnSync } = await import('node:child_process');
const focusPs1 = new URL('./focus-window.ps1', import.meta.url).pathname.replace(/^\//, '');
const focus = spawnSync(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', focusPs1, '-PutCursor'],
  { encoding: 'utf8' },
);
console.log('[focus] ' + String(focus.stdout || '').trim() + (focus.error ? ' ERR ' + focus.error : ''));
if (!/fg=True/.test(String(focus.stdout || ''))) {
  console.log('FAIL  验收窗口没抢到前台（前台是被谁占着？see-target.ps1 起了吗？）');
  process.exit(2);
}

// ── 手动截一次：不用等那个分钟级的节拍器 ──────────────────────────────
const snap = await evalIn(settings, `window.__TAURI_INTERNALS__.invoke('dsc_screen_now')`, 90000);
console.log(
  `[shot] 壳截了一次：${snap && snap.size} ${snap && snap.ms}ms lines=${snap && snap.lines}` +
    ` skipped=${JSON.stringify((snap && snap.skipped) || '')}`,
);
if (snap && snap.skipped) {
  console.log('   ⚠ 这次被跳过了 —— 前台窗口不对（敏感软件 / 壳自己），后面多半拿不到图');
}

const hasProbe = await evalIn(main, `typeof window.__DSC_REPORT_TURN__ === 'function'`);
if (!hasProbe) {
  console.log('FAIL  页面里没有 __DSC_REPORT_TURN__ —— 注入脚本没加载？');
  process.exit(1);
}

/** 拉一次这一轮的观察值：注入块 + 最近一张图的情况 */
async function observe() {
  const raw = await evalIn(
    main,
    `JSON.stringify({
       screen: (window.__DSC_TURN__ && window.__DSC_TURN__.screen) || '',
       front: (window.__DSC_TURN__ && window.__DSC_TURN__.front) || '',
       shot: window.__DSC_LAST_SHOT__ || null
     })`,
  );
  return JSON.parse(raw || '{}');
}

console.log('[wait] 等壳自己截一次（tick 15 秒醒一次，手上没图时第一次到点就截）…');
let seen = null;
let shotAt = 0;
const started = Date.now();
for (let i = 1; i <= ROUNDS; i++) {
  await evalIn(main, `window.__DSC_REPORT_TURN__('')`, 60000);
  await sleep(6000);
  const o = await observe();
  const secs = Math.round((Date.now() - started) / 1000);
  if (o.shot && !shotAt) {
    shotAt = Date.now();
    console.log(`  [${secs}s] 页面收到图：${o.shot.size} ${Math.round(o.shot.bytes / 1024)}KB` +
      ` 截的是 ${o.shot.screen} 圈=${o.shot.cursor ? '有' : '无'}`);
    console.log(`        前台是：${(o.front || '').split('\n')[0].slice(0, 70)}`);
  }
  if (o.shot && o.shot.text) {
    console.log(`  [${secs}s] 她看完了：${o.shot.text.replace(/\n/g, ' / ').slice(0, 100)}`);
  }
  if (/你自己看了一眼/.test(o.screen)) {
    seen = o;
    break;
  }
  if (i % 3 === 0) console.log(`  [${secs}s] 还在等（第 ${i} 轮）…`);
}

console.log('');
if (!seen) {
  const last = await observe();
  console.log('FAIL  等不到【他屏幕上】走"亲眼看过"那一版');
  console.log('  最后一次看到：screen=' + JSON.stringify(String(last.screen || '').slice(0, 160)));
  console.log('  最近一张图：' + JSON.stringify(last.shot));
  console.log('  排查顺序：① 前台是不是被 DS Companion 自己占了（那会被"在看自己"跳过）');
  console.log('            ② config.json 里 screen_see 有没有开 ③ 壳日志里有没有 [screen] 行');
  process.exit(1);
}

const shot = seen.shot || {};
const text = String(shot.text || '');
const block = String(seen.screen || '');
console.log('──────── 她看到的（原话）────────');
console.log(text.trim() || '（空）');
console.log('────────────────────────────────');
console.log('──────── 下一轮注入进对话的【他屏幕上】────────');
console.log(block.trim());
console.log('────────────────────────────────────────────');

const checks = [
  ['壳把截图交给了页面', !!shot.size, `图 ${shot.size}，${Math.round((shot.bytes || 0) / 1024)}KB`],
  ['图上画了鼠标圈', shot.cursor === true, `cursor=${shot.cursor}`],
  ['图片是按 512 宽缩过的', /^512x\d+$/.test(String(shot.size)), `size=${shot.size}`],
  ['她抄出了重点那行（7788）', /7788/.test(text), /7788/.test(text) ? '抄到了' : '没提 7788'],
  ['她也读到了大标题', /VERIFY/i.test(text), /VERIFY/i.test(text) ? '读到了' : '没提 VERIFY'],
  ['注入块走的是"亲眼看过"那一版', /你自己看了一眼/.test(block), block.split('\n')[0].slice(0, 40)],
  ['注入块里带上了她抄的那行', /7788/.test(block), /7788/.test(block) ? '在' : '不在'],
];

let bad = 0;
for (const [name, ok, ev] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${ev}`);
}
console.log('');
console.log(bad === 0 ? `★ 全过：${checks.length}/${checks.length} —— 焦点这条路通了 ★` : `${checks.length - bad}/${checks.length} 过，${bad} 条没过`);
process.exit(bad === 0 ? 0 : 1);
