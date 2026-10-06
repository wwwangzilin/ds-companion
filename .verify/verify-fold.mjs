/* 验收：①注入块拼在主人那句话**后面**（折叠态才显示得对）②侧栏里的系统会话被折叠。
 *
 * 【为什么要静态断言拼法】"注入块在前还是在后"这件事没法从 DOM 上验 —— 要验它得真发一条
 * 消息（花额度）。而它就是源码里的一行拼接，所以直接读源码断言，快且确定。
 * （真正的端到端验证是他自己发一句看折叠态显示对不对，见脚本末尾的提示。）
 *
 * 【为什么用真实数据目录】这一条要看的是**主人侧栏里那些真实存在的系统会话** ——
 * 隔离目录里一条都没有，验不了。脚本只**读** DOM + 加显示层的 class，不动任何数据。
 * 所以用 DSC_ALLOW_REAL_DATA=1 跑。
 *
 * 用法：$env:DSC_ALLOW_REAL_DATA='1'; $env:DSC_CDP='http://127.0.0.1:9223'; node .verify/verify-fold.mjs
 */
import { readFileSync } from 'node:fs';
import { requireIsolation } from './_env.mjs';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 60000) {
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

async function evalIn(target, expression, timeoutMs = 60000) {
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

await requireIsolation();

const checks = [];

// ── ① 静态：注入块拼在主人那句话后面 ────────────────────────────────────
const src = readFileSync(
  new URL('../src-tauri/inject/inject.js', import.meta.url),
  'utf8',
);
checks.push([
  '注入块拼在主人那句话**后面**',
  src.includes("body.prompt = body.prompt + '\\n\\n' + prefix"),
  src.includes("body.prompt = body.prompt + '\\n\\n' + prefix") ? '源码里对上了' : '没找到新拼法',
]);
checks.push([
  '旧的"拼在前面"已经没了',
  !src.includes('body.prompt = prefix + body.prompt'),
  src.includes('body.prompt = prefix + body.prompt') ? '还留着旧的' : '已清掉',
]);
checks.push([
  '去重判断跟着改成"包含"（否则会重复注入）',
  src.includes("if (body.prompt.indexOf(MARK_HEAD) >= 0) return { ok: false, why: 'already-injected' };"),
  '看源码',
]);

// ── ② DOM：侧栏折叠 ────────────────────────────────────────────────────
console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com');

let st = await evalIn(main, `JSON.stringify(window.__DSC_FOLD_SYS__ ? window.__DSC_FOLD_SYS__() : null)`);
let o = JSON.parse(String(st));
if (!o) {
  // 注入脚本可能还没跑到那一段（页面刚加载）—— 等一下再看
  await sleep(3000);
  st = await evalIn(main, `JSON.stringify(window.__DSC_FOLD_SYS__ ? window.__DSC_FOLD_SYS__() : null)`);
  o = JSON.parse(String(st));
}
console.log('[侧栏] ' + JSON.stringify(o));
checks.push([
  '认出了系统会话（localStorage 里的 dsc-*-session / dsc-chain-*）',
  o && o.ids > 0,
  `认出 ${o && o.ids} 个 id，侧栏可见 ${o && o.links} 条链接`,
]);
checks.push(['有个"点开"的开关行', o && o.bar === true, o && o.bar ? '在' : '没有']);

// ── ②b 回归：我这段绝不能把整条注入链带下去 ─────────────────────────────
// 【为什么专门盯这个】注入脚本和 deepseek-client 在**同一个注入块里顺序执行**，
// 而折叠这段排在它们中间。实测踩过一次：`ensureSysStyle()` 在 `document_start`
// 抛错 → 后面的 `__DSC_REPORT_TURN__` 与整个 `__DSC_DS_UTIL__` 全变 undefined，
// 屏幕感知跟着废。折叠本身只是锦上添花，绝不允许它掀桌子。
const chain = JSON.parse(
  String(
    await evalIn(
      main,
      `JSON.stringify({
         reportTurn: typeof window.__DSC_REPORT_TURN__,
         dsUtil: typeof window.__DSC_DS_UTIL__,
         injected: typeof window.__DSC_INJECTED__,
         turn: typeof window.__DSC_TURN__,
       })`,
    ),
  ),
);
console.log('[注入链] ' + JSON.stringify(chain));
checks.push([
  '折叠这段没把后面的注入链带崩（deepseek-client 还在）',
  chain.dsUtil === 'object' && chain.reportTurn === 'function',
  `dsUtil=${chain.dsUtil} reportTurn=${chain.reportTurn} injected=${chain.injected} turn=${chain.turn}`,
]);
// 【这条才是真不变量】不能断言 hidden === ids：有的 id 侧栏里压根没渲染出来
// （更早的会话、或还折叠在下面）。能要求的是"凡是侧栏里存在的，一条都没漏"。
const want = o ? o.ids - (o.miss ? o.miss.length : 0) : -1;
checks.push([
  '侧栏里存在的系统会话一条都没漏',
  o && o.hidden === want && want > 0,
  `藏了 ${o && o.hidden} 条 / 应藏 ${want} 条（侧栏里没有的：${o && o.miss && o.miss.join(',') || '无'}）`,
]);

// ── ③ 开关能双向切换 ───────────────────────────────────────────────────
if (o && o.hidden > 0) {
  const off = await evalIn(
    main,
    `(() => {
       document.getElementById('dsc-sys-bar').click();
       return JSON.stringify(window.__DSC_FOLD_SYS__());
     })()`,
  );
  await sleep(600);
  const offSt = JSON.parse(String(await evalIn(main, `JSON.stringify(window.__DSC_FOLD_SYS__())`)));
  checks.push(['点一下能把它们放出来', offSt.hidden === 0, `hidden=${offSt.hidden}`]);

  await evalIn(
    main,
    `(() => { document.getElementById('dsc-sys-bar').click(); return true; })()`,
  );
  await sleep(600);
  const onSt = JSON.parse(String(await evalIn(main, `JSON.stringify(window.__DSC_FOLD_SYS__())`)));
  checks.push(['再点一下又收回去了', onSt.hidden > 0, `hidden=${onSt.hidden}`]);
} else {
  checks.push(['开关能双向切换', false, '没藏住，跳过']);
}

// ── ④ 汇报 ─────────────────────────────────────────────────────────────
let bad = 0;
console.log('');
for (const [name, ok, ev] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${ev}`);
}
console.log('');
console.log(
  bad === 0
    ? `★ 全过：${checks.length}/${checks.length} ★  下一步：你自己发一句话，看折叠态显示的是不是你打的那句`
    : `${checks.length - bad}/${checks.length} 过`,
);
process.exit(bad === 0 ? 0 : 1);
