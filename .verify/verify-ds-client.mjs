/**
 * B 链路管道自检：token → 建会话 → PoW(wasm) → 发请求 → 解析 SSE。
 *
 * 会**真发一条请求**（默认"只回复两个字符：OK"），因此会：
 *   · 在主人的 DeepSeek 侧边栏里留下一个**自检专用**的会话（ping 那条链，长期复用往下接）
 *   · 花掉极小一点网页额度
 * 用法：node .verify/verify-ds-client.mjs
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const LOG = join(tmpdir(), 'ds-companion.log');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
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
}

const target = (await (await fetch(CDP + '/json/list')).json()).find((t) => t.url && t.url.includes('deepseek.com'));
if (!target) throw new Error('主页面不在（exe 没跑？）');
const page = new Page(target.webSocketDebuggerUrl);
await page.open();

// 0) 前提：登录态 + 注入脚本在
const prelude = JSON.parse(
  await page.eval(`JSON.stringify({
    hasToken: !!localStorage.getItem('userToken'),
    hasClient: typeof window.__DSC_PING__ === 'function',
    wasmB64Len: (window.__DSC_POW_WASM_B64__ || '').length,
    bypassHeaderConst: (window.__DSC_DS_UTIL__ || {}).BYPASS_HEADER,
    seenBefore: (window.__DSC_STATE__ || {}).seen
  })`),
);
check('页面有登录 token', prelude.hasToken === true, 'localStorage.userToken');
check('自请求通道已注入', prelude.hasClient === true);
check('PoW wasm 已内联', prelude.wasmB64Len > 30000, `base64=${prelude.wasmB64Len} 字符`);
check('bypass 头常量就位', prelude.bypassHeaderConst === 'x-dsc-bypass', String(prelude.bypassHeaderConst));

if (!prelude.hasToken) {
  console.log('\n主人在这个窗口里还没登录 chat.deepseek.com —— 先登录再跑这条。');
  process.exit(2);
}

// 1) 跑自检（真发一条）
const logLenBefore = (() => {
  try {
    return readFileSync(LOG, 'utf8').length;
  } catch {
    return 0;
  }
})();

const result = await page.eval(`window.__DSC_PING__({ prompt: '请只回复两个字符：OK' }).then(r => JSON.stringify(r))`);
const r = JSON.parse(result);
check('自检没抛错', r.ok === true, r.error || '');
check('真的拿到了答复', typeof r.text === 'string' && r.text.length > 0, JSON.stringify((r.text || '').slice(0, 60)));
check('答复内容合理（含 OK）', /OK/i.test(r.text || ''), JSON.stringify((r.text || '').slice(0, 60)));
check('会话 id 拿到了', typeof r.sessionId === 'string' && r.sessionId.length > 8, String(r.sessionId));
check('延迟合理（<30s）', r.latencyMs > 0 && r.latencyMs < 30000, `${r.latencyMs}ms`);

// 2) 我们自己的请求不能被自家注入钩子改（bypass 生效）
const after = JSON.parse(
  await page.eval(`JSON.stringify({ seen: (window.__DSC_STATE__ || {}).seen, injected: (window.__DSC_STATE__ || {}).injected })`),
);
check('自请求没被自家钩子计入', after.seen === prelude.seenBefore, `seen ${prelude.seenBefore} -> ${after.seen}`);

// 3) 自检走**它自己的**会话（不再和记忆整理挤在一起），并且链状态落盘
const cached = await page.eval(`localStorage.getItem('dsc-ping-session')`);
check('自检会话 id 已缓存待复用', cached === r.sessionId, String(cached));
const pingChain = JSON.parse(await page.eval(`localStorage.getItem('dsc-chain-ping') || 'null'`));
check(
  '自检链状态落盘（下次接着往下写，不再从根发）',
  !!pingChain && pingChain.sessionId === r.sessionId && Number(pingChain.lastMessageId) > 0 && Number(pingChain.turns) >= 1,
  JSON.stringify(pingChain),
);
check('从 SSE 里抠到了消息 id（往下接靠它）', Number(r.messageId) > 0, String(r.messageId));
const memSession = await page.eval(`localStorage.getItem('dsc-memory-session')`);
check(
  '自检不再碰记忆整理那条会话',
  !memSession || memSession !== r.sessionId,
  `memory=${String(memSession)} ping=${r.sessionId}`,
);

const added = (() => {
  try {
    return readFileSync(LOG, 'utf8').slice(logLenBefore);
  } catch {
    return '';
  }
})();
const lines = added
  .split('\n')
  .filter((l) => l.includes('[page] DS'))
  .slice(-3)
  .join(' | ');
check('日志里有可追溯记录', /DS session=|DS reply\(/.test(added), lines);

console.log(`\n${failed === 0 ? 'B 链路管道全通' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
