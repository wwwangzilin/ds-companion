/* 她"亲眼看一眼屏幕"这条路的端到端验收（含"一次看最近 3 张"）。
 *
 * 【验的是什么】
 *     壳定时截屏 → 缩到 512 → 把鼠标位置画成圈 → 攒成滑动窗口（最近 N 张）
 *       → 交给页面 → 页面上传（重叠的那几张复用 file_id）+ 用定稿提示词问她
 *         → 她答"在做什么 / 重点 / 变化" → 回传给壳 → 壳下一轮拼进【他屏幕上】
 *
 * 【为什么用两块内容不同的板子】壳那边"内容没变就不造图"会把一样的屏去重掉 ——
 * 只用一块板子的话窗口永远只有 1 张，验不出"一次发 3 张"。所以交替把
 * `see-target.ps1 -Tag A` / `-Tag B` 抢到前台，每次手动截一张：A → B → A。
 * 去重只跟**窗口里最后一张**比，所以这三张都会进来。
 *
 * 【验"复用"】第一次发出去 3 张（全是新上传）；再截一张 B 之后窗口变成 [B,A,B]，
 * 其中两张上一轮传过了 —— 第二次发时应该 `reused=2`，只有新那张要真上传。
 * 这是这个功能能不能用的关键：不然每轮重传 3 张，一次请求要等十几秒。
 *
 * 前置：两块板子已经起了（见 README 的验收一节），壳以隔离数据目录 + CDP 起来。
 * 用法：$env:DSC_CDP='http://127.0.0.1:9223'; node .verify/verify-screen-see.mjs
 */
import { requireIsolation } from './_env.mjs';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function findTarget(match, timeoutMs = 40000) {
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
// 叫出来。主页面有 `open_settings` 权限。
await evalIn(main, `window.__TAURI_INTERNALS__.invoke('open_settings')`);
let settings = null;
try {
  settings = await findTarget('settings.html', 40000);
} catch {
  console.log('FAIL  叫不出设置窗口 —— open_settings 失败？');
  process.exit(2);
}
await requireIsolation();

// ── 武装：开关打开、每次看 3 张、清一个干净的起点 ──────────────────────
// 【字段名必须是 camelCase】AppConfig 上有 `serde(rename_all = "camelCase")`，按 Rust 的
// snake_case 写等于**加了个新字段**：serde 忽略它、原字段还是旧值，回读也是 undefined。
// 【为什么要"关一次再开"】这条链路有两道去重（壳的"同一屏只造一张"、注入块的"和上轮一样
// 就不注入"）。它们平时是对的，但会让"第二次跑同一块板子"看起来像坏了 —— 关一次开关，
// 壳会把去重状态清掉。
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
     cfg.screenSeeBatch = 3;
     await inv('config_set', { cfg: cfg });
     const back = await inv('config_get');
     return JSON.stringify({
       watch: back.screenWatch, see: back.screenSee,
       every: back.screenEveryMinutes, batch: back.screenSeeBatch,
     });
   })()`,
  60000,
);
console.log('[arm] ' + armed);
if (!/"batch":3/.test(String(armed))) {
  console.log('FAIL  「每次看几张」没设成 3');
  process.exit(1);
}

const { spawnSync } = await import('node:child_process');
const focusPs1 = new URL('./focus-window.ps1', import.meta.url).pathname.replace(/^\//, '');

// ── 造两条"主对话"，验「她能看到你刚说了什么」──────────────────────────
// 【为什么要造】验收跑在隔离数据目录里，没有真实对话 —— 而这条链路要验的正是
// "把主对话最近几句带给她"。走的 `dsc_chat_append` 就是页面每轮真实对话后调的同一个口子。
// （日期必须给**本地**日期：壳按天存文件，`chat_recent` 从今天往回读。）
const seeded = await evalIn(
  main,
  `(async () => {
     const inv = window.__TAURI_INTERNALS__.invoke;
     const d = new Date();
     const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
       String(d.getDate()).padStart(2, '0');
     const mk = (user, assistant, clock) => ({
       at: Date.now(), day: day, clock: clock, character: '露娜',
       characterId: 'dsh-deepseek', session: 'verify', user: user, assistant: assistant,
     });
     await inv('dsc_chat_append', { turn: mk('我在核对两版的发布代码，A 版和 B 版的校验和好像不一样', '嗯，我帮你看看', '20:00') });
     await inv('dsc_chat_append', { turn: mk('先别管别的，就看这个 7788 的 release code', '好', '20:02') });
     const back = await inv('chat_recent', { limit: 4 });
     return JSON.stringify({ n: (back || []).length });
   })()`,
  60000,
);
console.log('[seed] 造了两条主对话，壳里能读回 ' + seeded);

/** 把某块板子抢到前台，然后手动截一张 —— 不用等那个分钟级的节拍器 */
async function board(tag) {
  const f = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      focusPs1,
      '-PutCursor',
      '-Title',
      `DSC SEE TARGET ${tag}`,
    ],
    { encoding: 'utf8' },
  );
  if (!/fg=True/.test(String(f.stdout || ''))) {
    console.log(`FAIL  板子 ${tag} 没抢到前台：${String(f.stdout || '').trim()}`);
    process.exit(2);
  }
  await sleep(800);
  const s = await evalIn(settings, `window.__TAURI_INTERNALS__.invoke('dsc_screen_now')`, 90000);
  console.log(
    `[shot] 板子 ${tag}：${s && s.size} ${s && s.ms}ms lines=${s && s.lines}` +
      ` skipped=${JSON.stringify((s && s.skipped) || '')}`,
  );
  if (s && s.skipped) {
    console.log('   ⚠ 这一次被跳过了 —— 前台窗口不对（敏感软件 / 壳自己）');
  }
}

/** 拉一次观察值 */
async function observe() {
  const raw = await evalIn(
    main,
    `JSON.stringify({
       screen: (window.__DSC_TURN__ && window.__DSC_TURN__.screen) || '',
       shot: window.__DSC_LAST_SHOT__ || null
     })`,
  );
  return JSON.parse(raw || '{}');
}

/** 反复 report 直到她看完这一批（返回那次的观察值） */
async function pumpUntilSee(prevText, rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await evalIn(main, `window.__DSC_REPORT_TURN__('')`, 60000);
    await sleep(6000);
    const o = await observe();
    if (o.shot && o.shot.text && o.shot.text !== prevText) return o;
  }
  return null;
}

// ── 第一轮：造 3 张不同的图，看她能不能一次看 3 张 ──────────────────────
console.log('[plan] 交替切两块板子，攒出 3 张内容不同的截图…');
await board('A');
await board('B');
await board('A');

const first = await pumpUntilSee('');
if (!first) {
  console.log('');
  console.log('FAIL  等不到她看完第一轮');
  const last = await observe();
  console.log('  最近一张图：' + JSON.stringify(last.shot));
  console.log('  排查：① 板子起没起（标题 DSC SEE TARGET A/B）② 前台是不是被壳自己占了');
  process.exit(1);
}
console.log('');
console.log('──────── 她看到的（第一轮）────────');
console.log(String(first.shot.text).trim());
console.log('──────────────────────────────────');

// ── 第二轮：再截一张 B → 窗口变 [B,A,B]，其中两张该复用 ────────────────
console.log('');
console.log('[plan] 再截一张 B —— 窗口会变成 [B,A,B]，其中两张上一轮传过了，该复用…');
await board('B');
const second = await pumpUntilSee(first.shot.text);
if (!second) {
  console.log('');
  console.log('FAIL  等不到第二轮（新图进来之后她该再看一次）');
  process.exit(1);
}
console.log('');
console.log('──────── 她看到的（第二轮）────────');
console.log(String(second.shot.text).trim());
console.log('──────────────────────────────────');

const block = String(second.screen || '');
console.log('');
console.log('──────── 注入进对话的【他屏幕上】────────');
console.log(block.trim());
console.log('────────────────────────────────────────');

const f1 = first.shot || {};
const f2 = second.shot || {};
const t2 = String(f2.text || '');
// 四行：在做什么 / 重点 / 变化 / 他大概在干嘛。最后那行就是主人要的"意图推测"。
const seeLines = t2
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);
const checks = [
  ['第一轮一次看了 3 张', f1.count === 3, `count=${f1.count}`],
  ['第一轮全是新上传的（起点干净）', f1.reused === 0, `reused=${f1.reused}`],
  ['图上画了鼠标圈', f2.cursor === true, `cursor=${f2.cursor}`],
  ['图片是按 512 宽缩过的', /^512x\d+$/.test(String(f2.size)), `size=${f2.size}`],
  ['第二轮同样是 3 张', f2.count === 3, `count=${f2.count}`],
  ['★重叠的那两张复用了，没重传★', f2.reused === 2, `reused=${f2.reused}（期望 2）`],
  ['她抄出了重点那行（7788）', /7788/.test(t2), /7788/.test(t2) ? '抄到了' : '没提 7788'],
  ['她给了跨张的「变化」', /变化/.test(t2), /变化/.test(t2) ? '有这一行' : '没有'],
  ['★她给了「意图」那一行（四行齐全）★', seeLines.length >= 4, `${seeLines.length} 行`],
  [
    '★提示词里带上了主对话最近几句★',
    /7788|核对/.test(String(f2.talk || '')),
    String(f2.talk || '').replace(/\n/g, ' / ').slice(0, 70) || '（空）',
  ],
  ['四行没被截断（她的话完整落地）', t2.length < 420 || !/…$/.test(t2), `${t2.length} 字`],
  ['注入块走的是"亲眼看过"那一版', /你自己看了一眼/.test(block), block.split('\n')[0].slice(0, 40)],
  ['注入块里带上了她抄的那行', /7788/.test(block), /7788/.test(block) ? '在' : '不在'],
];

let bad = 0;
console.log('');
for (const [name, ok, ev] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  —  ' + ev : ''}`);
}
console.log('');
console.log(
  bad === 0
    ? `★ 全过：${checks.length}/${checks.length} —— 多张 + 复用这条路通了 ★`
    : `${checks.length - bad}/${checks.length} 过，${bad} 条没过`,
);
process.exit(bad === 0 ? 0 : 1);
