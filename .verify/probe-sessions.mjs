/**
 * 只读侦察：ds-companion 现在占用了哪些隐藏会话、各自的链走到哪了。
 * 零额度（只读 localStorage 与 chat_session/fetch_page）。
 *
 * 用法：node .verify/probe-sessions.mjs
 */
const CDP = 'http://127.0.0.1:9222';

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
}

const target = (await (await fetch(CDP + '/json/list')).json()).find(
  (t) => t.url && t.url.includes('deepseek.com'),
);
if (!target) throw new Error('主页面不在（exe 没跑？）');
const page = new Page(target.webSocketDebuggerUrl);
await page.open();

const keys = JSON.parse(
  await page.eval(`JSON.stringify(Object.keys(localStorage)
    .filter(k => k.indexOf('dsc-') === 0)
    .sort()
    .map(k => [k, String(localStorage.getItem(k)).slice(0, 160)]))`),
);
console.log('--- ds-companion 在 localStorage 里的状态 ---');
for (const [k, v] of keys) console.log(`  ${k}\n      ${v}`);

const mine = new Set();
for (const [k, v] of keys) {
  if (k.endsWith('-session')) mine.add(v);
  if (k.startsWith('dsc-chain-')) {
    try {
      mine.add(JSON.parse(v).sessionId);
    } catch {}
  }
}

const listed = JSON.parse(
  await page.eval(`(async () => {
    var u = window.__DSC_DS_UTIL__;
    var H = Object.assign({ 'content-type': 'application/json' }, u.clientHeaders());
    var r = await fetch('/api/v0/chat_session/fetch_page', {
      method: 'POST', headers: H, credentials: 'include',
      body: JSON.stringify({ count: 30 })
    });
    var t = await r.text();
    if (!r.ok) return JSON.stringify({ err: 'HTTP ' + r.status + ' ' + t.slice(0, 200) });
    var j = JSON.parse(t);
    var biz = (j.data || {}).biz_data || {};
    var arr = biz.chat_sessions || biz.sessions || biz.chat_session_list || [];
    return JSON.stringify({ n: arr.length, arr: arr.map(function(s){
      return { id: s.id, title: s.title, up: Math.round(s.updated_at || 0), empty: s.is_empty };
    }) });
  })()`),
);

if (listed.err) {
  console.log('\n会话列表没读到：', listed.err);
} else {
  console.log(`\n--- 侧边栏最近 ${listed.n} 条会话（★ = ds-companion 的隐藏会话）---`);
  for (const s of listed.arr) {
    const star = mine.has(s.id) ? '★' : ' ';
    const when = s.up ? new Date(s.up * 1000).toLocaleString('zh-CN') : '?';
    console.log(`  ${star} ${s.id}  ${when}  ${s.title || '(无标题)'}`);
  }
}
page.ws.close();
