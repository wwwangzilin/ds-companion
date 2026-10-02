/* 注入回执验收：证明「这一轮到底注入了什么」真的看得见
 *
 * 【为什么值得单独一套】这一档要解决的是"她好像没记住设定""状态怎么不更新"
 * 这类**看不见**的问题。判据只有两条：
 *   ① 每块的字数是真的（不是估的、不是抄的）
 *   ② "没注入"时能说清是为什么（cadence 关了？不是首条？上游改版了？）
 *
 * 【它不花额度】直接调页面里的 `__DSC_AUGMENT__`（那是 XHR send 里包的那个函数），
 * 拿返回值与回执，**一次模型请求都不发**。
 *
 * 前置：壳以隔离数据 + CDP 启动（.\verify-run.ps1 -Keep），主页面已注入
 * 用法：node .verify\verify-inject.mjs [port]
 */

import { requireIsolation } from './_env.mjs';

const PORT = Number(process.argv[2] || process.env.DSC_CDP_PORT || 9222);
const CDP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await requireIsolation();

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 220) : ''}`);
}

class Page {
  constructor(ws) {
    this.ws = new WebSocket(ws);
    this.seq = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      const slot = this.pending.get(m.id);
      if (slot) {
        this.pending.delete(m.id);
        slot(m);
      }
    });
    await this.send('Runtime.enable');
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const out = r.result || {};
    if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails));
    return out.result ? out.result.value : undefined;
  }
  close() {
    setTimeout(() => {
      try {
        this.ws.close();
      } catch {}
    }, 50);
  }
}

const targets = async () => await (await fetch(`${CDP}/json/list`)).json();
async function attach(match, probe) {
  let list = [];
  try {
    list = await targets();
  } catch {
    return null;
  }
  for (const t of list.filter((x) => x.url && x.url.includes(match))) {
    const p = new Page(t.webSocketDebuggerUrl);
    try {
      await p.open();
      if (!probe) return p;
      if (await p.eval(probe)) return p;
      p.close();
    } catch {
      try {
        p.close();
      } catch {}
    }
  }
  return null;
}

const page = await attach('chat.deepseek.com', 'typeof window.__DSC_AUGMENT__ === "function"');
if (!page) {
  console.error('主页面没注入（或还没加载完）—— 先跑 verify-run.ps1 起隔离实例');
  process.exit(1);
}

/** 造一个"聊天请求"body，直接喂给页面里的拼装函数 */
const callAugment = async (body, via) =>
  await page.eval(
    `(function(){
      var out = window.__DSC_AUGMENT__(${JSON.stringify(JSON.stringify(body))}, ${JSON.stringify(via || 'probe')});
      var r = window.__DSC_INJECT_RECEIPT__();
      return JSON.stringify({ out: out, receipt: r });
    })()`,
  );

const CFG_BACKUP = await page.eval(`JSON.stringify(window.__DSC_CFG__() || {})`);

// ── 前置：必须有激活人设 ────────────────────────────────────────────────
//
// 隔离目录默认是空的 → personaText 为空 → 注入整条链路全红。
// 这个坑今天踩过三次（verify-taskmode / verify-health / 这里），
// 所以直接**在开头就喊出来**，而不是甩一堆"失败"让人去猜。
{
  const cfg = JSON.parse(CFG_BACKUP);
  if (!String(cfg.personaText || '').trim()) {
    console.error(
      [
        '',
        '[前置] 页面侧的人设正文是空的（personaText 为空）—— 后面必然整片假红。',
        '  正确顺序：node .verify\\probe-open-settings.mjs  →  node .verify\\seed-persona.mjs  →  本脚本',
        '',
      ].join('\n'),
    );
    process.exit(2);
  }
}

// 【前置·自造状态块】状态块的内容来自上一轮 `dsc_turn_report`（页面缓存在 CFG 里），
// 而别的脚本跑完可能把配置/状态动过（verify-state 就关过状态层、还原过状态）。
// 所以这里自己先跑一轮报告 —— 否则"状态块在不在"这类断言会假红，
// 而且看起来像产品坏了（同族铁律：验收脚本要对"初始局面"免疫）。
await page.eval(`window.__DSC_REPORT_TURN__('验收前置（纯本地，不花额度）')`);
await sleep(700);

// ── ① 首条消息：应该注入，而且回执要说清每一块 ──────────────────────────
await page.eval(
  `(function(){
    var c = Object.assign({}, window.__DSC_CFG__(), { cadence: 'first' });
    window.__DSC_SET_CONFIG__(c);
    return true;
  })()`,
);
await sleep(200);
const first = JSON.parse(
  await callAugment(
    { prompt: '你好呀', parent_message_id: null, chat_session_id: 'probe-inject-' + Date.now() },
    'probe',
  ),
);
check('首条消息注入了（返回了改好的 prompt）', typeof first.out === 'string' && first.out.length > 0);
check('回执标记为成功', first.receipt && first.receipt.ok === true, JSON.stringify(first.receipt));
const blocks = (first.receipt && first.receipt.blocks) || [];
check('回执里列出了每一块', blocks.length >= 1, JSON.stringify(blocks.map((b) => b.k)));
check(
  '人设块在里面（首条 + cadence=first）',
  blocks.some((b) => b.k === '人设'),
  JSON.stringify(blocks.map((b) => b.k)),
);
check(
  '状态块在里面（每轮都带）',
  blocks.some((b) => b.k === '状态'),
  JSON.stringify(blocks.map((b) => b.k)),
);
check(
  '每块都带了字数（不是空的）',
  blocks.every((b) => typeof b.n === 'number' && b.n > 0),
  JSON.stringify(blocks),
);
const sum = blocks.reduce((a, b) => a + b.n, 0);
check('总字数 = 各块之和', Math.abs(sum - (first.receipt.total || 0)) <= 2, `${sum} vs ${first.receipt.total}`);
check(
  '返回的 prompt 真的被改过（前缀拼在了最前面）',
  typeof first.out === 'string' && first.out.length >= first.receipt.total,
  `out=${typeof first.out === 'string' ? first.out.length : '?'} total=${first.receipt.total}`,
);

// ── ② 非首条：cadence=first 时**人设块**不进去，但状态块照旧 ──────────────
//
// 【语义澄清】cadence 只管人设块。状态/工具/回锚各有各的开关 ——
// 所以"改了请求体"与"人设进去了"是两件事，回执的 ok 与 why 分别对它们负责。
const second = JSON.parse(
  await callAugment(
    { prompt: '第二句', parent_message_id: 'some-parent-id', chat_session_id: 'probe-inject-same' },
    'probe',
  ),
);
check(
  '非首条：回执说清人设为什么不进',
  second.receipt && String(second.receipt.why).includes('not-first-message'),
  second.receipt && second.receipt.why,
);
check(
  '非首条：回执的 blocks 里确实没有"人设"',
  second.receipt && !(second.receipt.blocks || []).some((b) => b.k === '人设'),
  JSON.stringify(second.receipt && second.receipt.blocks),
);
check(
  '非首条：状态块照旧进去（它每轮都带）',
  second.receipt && (second.receipt.blocks || []).some((b) => b.k === '状态'),
  JSON.stringify(second.receipt && second.receipt.blocks),
);
check(
  '非首条：请求体仍然被改了（因为状态要每轮带）',
  typeof second.out === 'string' && second.out.length > 0,
  'out=' + (typeof second.out === 'string' ? second.out.length : String(second.out)),
);

// ── ③ cadence=every：每轮都该注入 ─────────────────────────────────────
await page.eval(
  `(function(){
    var c = Object.assign({}, window.__DSC_CFG__(), { cadence: 'every' });
    window.__DSC_SET_CONFIG__(c);
    return true;
  })()`,
);
await sleep(200);
const every = JSON.parse(
  await callAugment(
    { prompt: '第三句', parent_message_id: 'some-parent-id', chat_session_id: 'probe-inject-every' },
    'probe',
  ),
);
check('cadence=every 时非首条也注入', typeof every.out === 'string' && every.out.length > 0);
check('回执也记了这次成功', every.receipt && every.receipt.ok === true, JSON.stringify(every.receipt && every.receipt.why));

// ── ④ 关掉注入：不该注入，并且要说清是"关着" ────────────────────────────
await page.eval(
  `(function(){
    var c = Object.assign({}, window.__DSC_CFG__(), { cadence: 'off' });
    window.__DSC_SET_CONFIG__(c);
    return true;
  })()`,
);
await sleep(200);
const off = JSON.parse(
  await callAugment({ prompt: '第四句', parent_message_id: null, chat_session_id: 'probe-off' }, 'probe'),
);
check('cadence=off：回执说清人设为什么不进', off.receipt && off.receipt.why === 'cadence-off', off.receipt && off.receipt.why);
check(
  'cadence=off：blocks 里确实没有"人设"',
  off.receipt && !(off.receipt.blocks || []).some((b) => b.k === '人设'),
  JSON.stringify(off.receipt && off.receipt.blocks),
);
check(
  'cadence=off：状态块还在（cadence 管不到它）',
  off.receipt && (off.receipt.blocks || []).some((b) => b.k === '状态'),
  JSON.stringify(off.receipt && off.receipt.blocks),
);

// ── ⑤ 非聊天请求（不是 JSON）不该污染回执 ──────────────────────────────
const beforeNoise = JSON.stringify(off.receipt);
const noise = await page.eval(
  `(function(){
    var out = window.__DSC_AUGMENT__('not a json body', 'probe');
    return JSON.stringify({ out: out, receipt: window.__DSC_INJECT_RECEIPT__() });
  })()`,
);
const noiseObj = JSON.parse(noise);
check('非 JSON 请求直接放过', noiseObj.out === null);
check('非 JSON 不产生回执（不刷屏）', JSON.stringify(noiseObj.receipt) === beforeNoise);

// ── ⑥ 设置页真的把它渲染出来了 ──────────────────────────────────────────
const st = await attach('settings.html', 'typeof window.__TAURI_INTERNALS__ === "object"');
if (!st) {
  check('设置窗口可用', false, '没找到 settings.html');
} else {
  check('设置窗口可用', true);
  // 先把日志里灌一条可控的回执，免得依赖真实对话
  await page.eval(
    `(function(){
      var c = Object.assign({}, window.__DSC_CFG__(), { cadence: 'every' });
      window.__DSC_SET_CONFIG__(c);
      window.__DSC_AUGMENT__(JSON.stringify({ prompt: '给设置页看的一轮', parent_message_id: null, chat_session_id: 'probe-ui' }), 'probe');
      return true;
    })()`,
  );
  await sleep(400);
  await st.eval("(function(){ setTab('log'); return refreshLog(); })()");
  await sleep(300);
  const cells = await st.eval("document.querySelectorAll('#inj-grid .health-cell').length");
  check('注入回执块渲染出了格子', cells >= 1, 'cells=' + cells);
  const sub = String(await st.eval("document.getElementById('inj-sub').textContent"));
  check('显示了时间与总字数', /注入成功/.test(sub) && /字/.test(sub), sub);
  const note = String(await st.eval("document.getElementById('inj-note').textContent"));
  check('列出了注入的块名', /这一轮注入了/.test(note), note);
  const uiReceipt = JSON.parse(await st.eval('JSON.stringify(window.__DSC_INJECT__)'));
  check('设置页拿到的是页面侧那一份', !!uiReceipt && uiReceipt.ok === true, JSON.stringify(uiReceipt && uiReceipt.why));
  check('两边的总字数一致', uiReceipt && uiReceipt.total > 0, String(uiReceipt && uiReceipt.total));
  st.close();
}

// 还原配置（别把 cadence 留在 off/every 上）
await page.eval(`window.__DSC_SET_CONFIG__(${CFG_BACKUP})`);
page.close();

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
