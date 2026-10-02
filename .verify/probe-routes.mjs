/**
 * 只读侦察：把 DeepSeek 页面自己 JS 包里出现的 /api/v0/... 接口名挖出来。
 * 用途：确认「读会话消息 / 删会话」这类接口到底叫什么，别靠猜。
 * 零额度：只 fetch 页面自己的静态 bundle，不发模型请求。
 *
 * 用法：node .verify/probe-routes.mjs
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
  async eval(expression, timeoutMs = 120000) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
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

const out = await page.eval(`(async () => {
  const urls = new Set();
  for (const s of document.querySelectorAll('script[src]')) urls.add(s.src);
  for (const l of document.querySelectorAll('link[href]')) {
    if ((l.getAttribute('rel') || '').includes('modulepreload')) urls.add(l.href);
  }
  const routes = new Set();
  const sources = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { credentials: 'include' });
      const t = await r.text();
      sources.push(u.split('/').pop() + ':' + t.length);
      const m = t.match(/\\/api\\/v[0-9]+\\/[a-z0-9_\\/\\-]+/g) || [];
      for (const x of m) routes.add(x);
    } catch (e) { sources.push(u + ':ERR ' + e); }
  }
  return JSON.stringify({ count: urls.size, sources, routes: [...routes].sort() });
})()`);

const parsed = JSON.parse(out);
console.log('扫了 ' + parsed.count + ' 个 bundle：', parsed.sources.join('  '));
console.log('\n--- 页面用到的接口 ---');
for (const r of parsed.routes) console.log('  ' + r);
page.ws.close();
