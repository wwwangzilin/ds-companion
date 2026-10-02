/**
 * 「隐藏会话往下接着用」的离线回归。
 *
 * 盯的是四个曾经出过错、或最容易退化的地方：
 *   ① 接着上一条往下写（parent = 链上的消息 id），不再每次从根发
 *   ② 老会话没有链状态时，先认下活跃分支的尾巴（否则又开一条兄弟分支 = 主人看到的现象）
 *   ③ 攒够 hiddenChainTurns 次换新会话（成本闸），且 0 = 不轮换
 *   ④ SSE 没带消息 id 时回读兜底；第一次失败会换会话重试
 *   ⑤ 三种用途（memory / judge / ping）各自一条链，互不串味
 *
 * 全程用假 util（不花网页额度、不建真会话），跑完把链状态与配置原样还原。
 * 用法：node .verify/verify-chain.mjs
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const LOG = join(tmpdir(), 'ds-companion.log');

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

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
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const out = r.result || {};
    if (out.exceptionDetails) {
      throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    }
    return out.result ? out.result.value : undefined;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const KEYS = [
  'dsc-chain-memory', 'dsc-chain-judge', 'dsc-chain-ping',
  'dsc-memory-session', 'dsc-judge-session', 'dsc-ping-session',
];

/** 假 util：三个网络动作全拦下来，行为由 window.__DSC_FAKE__ 控制 */
const FAKE_JS = `(function(){
  if (!window.__DSC_CHAIN_REAL__) window.__DSC_CHAIN_REAL__ = window.__DSC_DS_UTIL__;
  window.__DSC_FAKE__ = {
    calls: 0, parent: 'unset', sessionId: null, kind: '',
    ensureCalls: 0, forced: 0, tailCalls: 0,
    tailLastId: 0, responseMessageId: 8, failFirst: 0
  };
  var fake = Object.assign({}, window.__DSC_CHAIN_REAL__, {
    ensureSession: function(force, kind){
      window.__DSC_FAKE__.ensureCalls++;
      window.__DSC_FAKE__.forced = force ? 1 : 0;
      window.__DSC_FAKE__.kind = String(kind || '');
      return Promise.resolve('s-' + (kind || 'memory') + '-probe');
    },
    historyTail: function(sid){
      window.__DSC_FAKE__.tailCalls++;
      window.__DSC_FAKE__.tailSid = sid;
      var n = window.__DSC_FAKE__.tailLastId;
      return Promise.resolve({
        count: n ? 2 : 0, ids: n ? [n - 1, n] : [], lastId: n,
        lastAssistantId: n, currentMessageId: n
      });
    },
    completion: function(opts){
      window.__DSC_FAKE__.calls++;
      window.__DSC_FAKE__.parent = opts.parentMessageId === null ? 'null' : String(opts.parentMessageId);
      window.__DSC_FAKE__.sessionId = opts.sessionId;
      window.__DSC_FAKE__.promptHead = String(opts.prompt || '').slice(0, 24);
      if (window.__DSC_FAKE__.failFirst > 0) {
        window.__DSC_FAKE__.failFirst--;
        return Promise.reject(new Error('假装第一次失败'));
      }
      return Promise.resolve({
        text: '{"items":[]}', raw: '', latencyMs: 5,
        responseMessageId: window.__DSC_FAKE__.responseMessageId, requestMessageId: 1
      });
    }
  });
  window.__DSC_DS_UTIL__ = fake;
  return true;
})()`;

const RESTORE_JS = `(function(){
  if (window.__DSC_CHAIN_REAL__) window.__DSC_DS_UTIL__ = window.__DSC_CHAIN_REAL__;
  window.__DSC_CHAIN_REAL__ = null;
  window.__DSC_FAKE__ = null;
  return true;
})()`;

const main = async () => {
  const target = (await (await fetch(CDP + '/json/list')).json()).find(
    (t) => t.url && t.url.includes('deepseek.com'),
  );
  if (!target) throw new Error('主页面不在（exe 没跑？）');
  const page = new Page(target.webSocketDebuggerUrl);
  await page.open();

  const hasAsk = await page.eval(`typeof (window.__DSC_DS_UTIL__ || {}).ask === 'function'`);
  if (!hasAsk) throw new Error('页面上的 deepseek-client 还是旧版（没有 ask）——先重新编译启动');

  // 快照：链状态 + 隐藏会话 id + 配置（全都要还原）
  const saved = {};
  for (const k of KEYS) saved[k] = await page.eval(`localStorage.getItem(${JSON.stringify(k)})`);
  const cfgBefore = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_CFG__() || {})`));

  const chainOf = async (k) =>
    JSON.parse(await page.eval(`localStorage.getItem(${JSON.stringify(k)}) || 'null'`));
  const seed = async (k, obj) => {
    await page.eval(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(JSON.stringify(obj))})`);
  };
  const setFake = async (patch) => {
    for (const [k, v] of Object.entries(patch)) {
      await page.eval(`window.__DSC_FAKE__[${JSON.stringify(k)}] = ${JSON.stringify(v)}`);
    }
  };
  const ask = async (kind) =>
    JSON.parse(
      await page.eval(
        `window.__DSC_DS_UTIL__.ask(${JSON.stringify(kind)}, '探针提示词').then(r => JSON.stringify({
           text: r.text, messageId: r.messageId, parentMessageId: r.parentMessageId,
           turns: r.turns, rotated: r.rotated, adopted: r.adopted, sessionId: r.sessionId
         }))`,
      ),
    );

  try {
    await page.eval(FAKE_JS);
    const limit = Number((await page.eval(`(window.__DSC_CFG__() || {}).hiddenChainTurns ?? 20`)));
    check('配置里有 hiddenChainTurns（页面拿得到）', Number.isFinite(limit), String(limit));

    // ── ① 接着上一条往下写 ────────────────────────────────────────────
    await seed('dsc-chain-memory', { sessionId: 's-mem', lastMessageId: 7, turns: 3 });
    await setFake({ calls: 0, responseMessageId: 8, tailCalls: 0, tailLastId: 0, forced: 0 });
    let r = await ask('memory');
    let f = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_FAKE__)`));
    check('① parent = 链上的消息 id（不再从根发）', f.parent === '7', f.parent);
    check('① 用的还是那条会话', f.sessionId === 's-mem', f.sessionId);
    check('① 没有重复建会话', f.forced === 0 && f.ensureCalls === 0, `forced=${f.forced} ensure=${f.ensureCalls}`);
    check('① 只发一次请求', f.calls === 1, String(f.calls));
    check('① 返回新消息 id', r.messageId === 8, String(r.messageId));
    check('① 轮数推进 3 → 4', r.turns === 4, String(r.turns));
    let c = await chainOf('dsc-chain-memory');
    check(
      '① 链落盘（新 id + 轮数）',
      c && Number(c.lastMessageId) === 8 && Number(c.turns) === 4 && c.sessionId === 's-mem',
      JSON.stringify(c),
    );

    // ── ② 攒够上限换新会话 ────────────────────────────────────────────
    await seed('dsc-chain-memory', { sessionId: 's-mem', lastMessageId: 7, turns: limit });
    await setFake({ calls: 0, forced: 0, responseMessageId: 8, tailCalls: 0, tailLastId: 0 });
    r = await ask('memory');
    f = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_FAKE__)`));
    check(`② 到第 ${limit} 次会换新会话（成本闸）`, f.forced === 1, `forced=${f.forced}`);
    check('② 换会话后从根起（parent=null）', f.parent === 'null', f.parent);
    check('② 结果里标了 rotated', r.rotated === true, String(r.rotated));
    c = await chainOf('dsc-chain-memory');
    check('② 轮数从 1 重新数', c && Number(c.turns) === 1, JSON.stringify(c));

    // ── ③ 上限 = 0 表示不轮换 ────────────────────────────────────────
    await page.eval(`(function(){ var c = window.__DSC_CFG__(); c.hiddenChainTurns = 0; window.__DSC_SET_CONFIG__(c); return true; })()`);
    await seed('dsc-chain-memory', { sessionId: 's-mem', lastMessageId: 42, turns: 999 });
    await setFake({ calls: 0, forced: 0, responseMessageId: 43 });
    r = await ask('memory');
    f = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_FAKE__)`));
    check('③ 上限设 0 就永不轮换（一直往下接）', f.forced === 0 && r.rotated === false, `forced=${f.forced}`);
    check('③ 仍然接着 42 往下写', f.parent === '42', f.parent);
    await page.eval(`(function(){ var c = window.__DSC_CFG__(); c.hiddenChainTurns = ${JSON.stringify(cfgBefore.hiddenChainTurns ?? 20)}; window.__DSC_SET_CONFIG__(c); return true; })()`);

    // ── ④ 老会话：认下活跃分支的尾巴 ─────────────────────────────────
    await seed('dsc-chain-memory', { sessionId: 's-mem', lastMessageId: 0, turns: 0 });
    await setFake({ calls: 0, forced: 0, tailCalls: 0, tailLastId: 9, responseMessageId: 10 });
    r = await ask('memory');
    f = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_FAKE__)`));
    check('④ 没有链状态时先回读分支尾巴', f.tailCalls >= 1, String(f.tailCalls));
    check('④ 接着尾巴往下写（不再开兄弟分支）', f.parent === '9', f.parent);
    check('④ 结果里标了 adopted', r.adopted === true, String(r.adopted));

    // ── ⑤ 帧里没带 id 时回读兜底 ────────────────────────────────────
    await seed('dsc-chain-memory', { sessionId: 's-mem', lastMessageId: 0, turns: 0 });
    await setFake({ calls: 0, forced: 0, tailCalls: 0, tailLastId: 11, responseMessageId: 0 });
    r = await ask('memory');
    c = await chainOf('dsc-chain-memory');
    check('⑤ SSE 没 id 时用回读的消息 id 兜底', r.messageId === 11 && Number(c.lastMessageId) === 11, JSON.stringify(c));

    // ── ⑥ 第一次失败 → 换会话重试一次 ───────────────────────────────
    await seed('dsc-chain-memory', { sessionId: 's-mem', lastMessageId: 5, turns: 1 });
    await setFake({ calls: 0, forced: 0, failFirst: 1, responseMessageId: 6, tailLastId: 0 });
    r = await ask('memory');
    f = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_FAKE__)`));
    check('⑥ 失败后确实重试了（共 2 次请求）', f.calls === 2, String(f.calls));
    check('⑥ 重试换了新会话', f.forced === 1 && r.rotated === true, `forced=${f.forced}`);
    check('⑥ 重试结果仍然可用', r.messageId === 6, String(r.messageId));

    // ── ⑦ 三种用途各自一条链，互不串味 ──────────────────────────────
    // 故意**不**给 judge 预置 sessionId：这样 asks 必须去要一条新会话，
    // 才测得到"用途名有没有正确传下去"（预置了就短路，压根不调 ensureSession）
    await seed('dsc-chain-memory', { sessionId: 's-mem', lastMessageId: 100, turns: 2 });
    await seed('dsc-chain-judge', { lastMessageId: 3, turns: 1 });
    await setFake({ calls: 0, forced: 0, responseMessageId: 4, tailLastId: 0 });
    r = await ask('judge');
    f = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_FAKE__)`));
    check('⑦ judge 要的是自己的会话（用途名传到位）', f.kind === 'judge', f.kind);
    check('⑦ judge 用自己的会话', f.sessionId === 's-judge-probe', f.sessionId);
    check('⑦ judge 接着自己的链（parent=3）', f.parent === '3', f.parent);
    const memChain = await chainOf('dsc-chain-memory');
    check(
      '⑦ memory 那条链没被动过',
      memChain && Number(memChain.lastMessageId) === 100 && Number(memChain.turns) === 2,
      JSON.stringify(memChain),
    );
    const judgeChain = await chainOf('dsc-chain-judge');
    check(
      '⑦ judge 链自己推进到 4',
      judgeChain && Number(judgeChain.lastMessageId) === 4 && Number(judgeChain.turns) === 2,
      JSON.stringify(judgeChain),
    );

    // ── ⑧ 日志里留得下痕迹（出问题能追溯） ──────────────────────────
    const log = (() => {
      try {
        return readFileSync(LOG, 'utf8');
      } catch {
        return '';
      }
    })();
    check('⑧ 日志里有 ASK[...] 的链记录', /ASK\[(memory|judge)\]/.test(log), '');
  } finally {
    await page.eval(RESTORE_JS);
    // 链状态 / 隐藏会话 id 原样还原
    for (const k of KEYS) {
      if (saved[k] === null || saved[k] === undefined) {
        await page.eval(`localStorage.removeItem(${JSON.stringify(k)})`);
      } else {
        await page.eval(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(saved[k])})`);
      }
    }
    // 配置还原（③ 那一步临时改过 hiddenChainTurns）
    await page.eval(`window.__DSC_SET_CONFIG__(${JSON.stringify(cfgBefore)})`);

    let back = true;
    for (const k of KEYS) {
      const now = await page.eval(`localStorage.getItem(${JSON.stringify(k)})`);
      const want = saved[k] === undefined ? null : saved[k];
      if ((now === null ? null : String(now)) !== want) {
        back = false;
        console.log(`   ⚠ ${k} 没还原：${String(now)} ≠ ${String(want)}`);
      }
    }
    check('链状态 / 隐藏会话 id 已还原', back, '');
    check(
      '配置已还原（hiddenChainTurns）',
      Number((await page.eval(`(window.__DSC_CFG__() || {}).hiddenChainTurns ?? 20`))) ===
        Number(cfgBefore.hiddenChainTurns ?? 20),
      String(cfgBefore.hiddenChainTurns),
    );
    page.close();
  }

  console.log(`\n${failed ? `✗ ${failed} 项失败` : '✓ 会话接续链路全通'}`);
  process.exit(failed ? 1 : 0);
};

main().catch((e) => {
  console.error('验收脚本自己炸了：', e);
  process.exit(2);
});
