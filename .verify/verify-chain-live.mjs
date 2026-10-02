/**
 * 真机实证：「隐藏会话往下接着用」到底成没成 —— 读消息树为证，不靠嘴说。
 *
 * 会真发 2 条极短请求（约几个 token）。做完断言：
 *   ① 第二次的 parentMessageId = 第一次的 messageId（真的接上了）
 *   ② 该会话的消息树里，活跃分支是一串**递增的链**（parent 指向前一条），
 *      而不是"永远 1 问 1 答"（那正是主人抱怨的"一直修改一条消息"）
 *
 * 用法：node .verify/verify-chain-live.mjs
 */
const CDP = 'http://127.0.0.1:9222';

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

const target = (await (await fetch(CDP + '/json/list')).json()).find(
  (t) => t.url && t.url.includes('deepseek.com'),
);
if (!target) throw new Error('主页面不在（exe 没跑？）');
const page = new Page(target.webSocketDebuggerUrl);
await page.open();

const ping = async (prompt) =>
  JSON.parse(
    await page.eval(
      `window.__DSC_PING__({ prompt: ${JSON.stringify(prompt)} }).then(r => JSON.stringify(r))`,
    ),
  );

// 先看这条链现在什么样
const before = JSON.parse(await page.eval(`localStorage.getItem('dsc-chain-ping') || 'null'`));
const sid = before && before.sessionId ? before.sessionId : null;
const treeBefore = sid
  ? JSON.parse(await page.eval(`window.__DSC_DS_UTIL__.historyTail(${JSON.stringify(sid)}).then(t => JSON.stringify(t))`))
  : null;
console.log('链状态（发之前）:', JSON.stringify(before));
if (treeBefore) console.log(`会话现有活跃分支: ${treeBefore.count} 条消息, ids=${JSON.stringify(treeBefore.ids)}`);

console.log('\n>>> 连发两条极短请求（各几个 token）…');
const a = await ping('请只回复两个字符：OK');
const b = await ping('请只回复两个字：好');
console.log('第一条:', JSON.stringify(a));
console.log('第二条:', JSON.stringify(b));

check('两次都成功', a.ok === true && b.ok === true, `${a.error || ''} ${b.error || ''}`);
check('第一次拿到了消息 id', Number(a.messageId) > 0, String(a.messageId));
check('第二次拿到了消息 id', Number(b.messageId) > 0, String(b.messageId));
check(
  '第二次接在第一次后面（parent = 上一条 id）',
  Number(b.parentMessageId) === Number(a.messageId),
  `parent=${b.parentMessageId} vs 上一条=${a.messageId}`,
);
check('两次用的是同一条会话（没乱建会话）', a.sessionId === b.sessionId, `${a.sessionId} / ${b.sessionId}`);
check('消息 id 递增（说明是往后长，不是覆盖同一个位置）', Number(b.messageId) > Number(a.messageId), `${a.messageId} → ${b.messageId}`);

// ── 读消息树：活跃分支是不是一串链 ──────────────────────────────────
const tree = JSON.parse(
  await page.eval(`window.__DSC_DS_UTIL__.historyTail(${JSON.stringify(a.sessionId)}).then(t => JSON.stringify(t))`),
);
console.log(`\n会话活跃分支现在有 ${tree.count} 条消息: ids=${JSON.stringify(tree.ids)}`);
check('活跃分支变长了（不再是永远 1 问 1 答）', tree.count >= 4, `${tree.count} 条`);

// 逐条读 parent，确认是一串链
const shape = JSON.parse(
  await page.eval(`(async () => {
    var sid = ${JSON.stringify(a.sessionId)};
    var u = window.__DSC_DS_UTIL__;
    var res = await fetch(u.ROUTES.historyMessages + '?chat_session_id=' + encodeURIComponent(sid) + '&count=50', { credentials: 'include', headers: u.clientHeaders() });
    var j = await res.json();
    var msgs = ((j.data || {}).biz_data || {}).chat_messages || [];
    return JSON.stringify(msgs.map(function(m){ return { id: m.message_id, parent: m.parent_id, role: m.role }; }));
  })()`),
);
console.log('\n--- 活跃分支的消息链 ---');
for (const m of shape) console.log(`  #${m.id}  parent=${m.parent}  ${m.role}`);
let chained = true;
for (let i = 1; i < shape.length; i++) {
  if (Number(shape[i].parent) !== Number(shape[i - 1].id)) chained = false;
}
check('每条消息都挂在前一条下面（一串链，不是兄弟版本）', chained, '');
check('链尾就是我们刚发的那两条', Number(shape[shape.length - 1].id) === Number(b.messageId), `尾=${shape[shape.length - 1].id} / 期望=${b.messageId}`);

page.close();
console.log(`\n${failed ? `✗ ${failed} 项失败` : '✓ 真机确实是往下接的'}`);
process.exit(failed ? 1 : 0);
