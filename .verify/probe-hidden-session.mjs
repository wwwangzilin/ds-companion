/**
 * 只读侦察：把 ds-companion 隐藏会话（localStorage['dsc-memory-session']）的真实消息树读出来。
 *
 * 回答两个问题（都零额度，不发模型请求）：
 *   ① 我们历次请求在会话里到底是什么形状 —— 是「同一条根消息的兄弟分支」（UI 上看着像被改写），
 *      还是一条条往下接的链？→ 决定「往下接着用」怎么实现。
 *   ② parent_message_id 到底吃整数 id 还是 uuid？
 *
 * 用法：node .verify/probe-hidden-session.mjs [--sid <会话id>]
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CDP = 'http://127.0.0.1:9222';
// 落在脚本自己旁边（而不是写死某台机器的绝对路径）—— 这样别人 clone 下来也能直接用
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out-hidden-session.json');

const argv = process.argv.slice(2);
const sidArg = argv.includes('--sid') ? argv[argv.indexOf('--sid') + 1] : '';

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

const sid = sidArg || (await page.eval(`localStorage.getItem('dsc-memory-session') || ''`));
if (!sid) throw new Error('没有隐藏会话 id（还没跑过 B 链路？）');
console.log('隐藏会话:', sid);

// 两种姿势都试（POST json 与 GET query），谁通用谁
const expr = `(async () => {
  const util = window.__DSC_DS_UTIL__;
  const sid = ${JSON.stringify(sid)};
  const base = util.clientHeaders();
  const H = Object.assign({ 'content-type': 'application/json' }, base);
  const tries = [];
  const shapes = [
    { name: 'POST count', init: { method: 'POST', headers: H, credentials: 'include', body: JSON.stringify({ chat_session_id: sid, count: 50 }) }, url: '/api/v0/chat/history_messages' },
    { name: 'POST size',  init: { method: 'POST', headers: H, credentials: 'include', body: JSON.stringify({ chat_session_id: sid, size: 50 }) },  url: '/api/v0/chat/history_messages' },
    { name: 'GET count',  init: { method: 'GET',  headers: base, credentials: 'include' }, url: '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sid) + '&count=50' },
  ];
  for (const s of shapes) {
    try {
      const r = await fetch(s.url, s.init);
      const t = await r.text();
      tries.push(s.name + ' → HTTP ' + r.status + ' len=' + t.length);
      if (r.ok && t.length > 2) return JSON.stringify({ how: s.name, status: r.status, body: t });
    } catch (e) {
      tries.push(s.name + ' → ERR ' + e);
    }
  }
  return JSON.stringify({ how: null, status: 0, body: '', tries });
})()`;

const raw = await page.eval(expr);
const res = JSON.parse(raw);
if (!res.how) {
  console.log('三种姿势都不通：', raw.slice(0, 400));
  process.exit(1);
}
console.log('读到了（' + res.how + '，HTTP ' + res.status + '，' + res.body.length + ' 字节）');
writeFileSync(OUT, res.body, 'utf8');
console.log('原始响应已写:', OUT);

let obj;
try {
  obj = JSON.parse(res.body);
} catch (e) {
  console.log('响应不是 JSON：', res.body.slice(0, 300));
  process.exit(1);
}

// 挖出消息数组（形状未知，宽容找）
const findArrays = (node, path, acc) => {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    const p = path ? path + '.' + k : k;
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') acc.push([p, v]);
    else if (v && typeof v === 'object') findArrays(v, p, acc);
  }
};
const acc = [];
findArrays(obj, '', acc);
console.log('\n--- 响应里的对象数组 ---');
for (const [p, v] of acc) console.log(`  ${p}  (${v.length} 条)  首条键: ${Object.keys(v[0]).join(',')}`);

const msgs = (acc.find(([p]) => /message/i.test(p)) || [])[1];
if (!msgs) {
  console.log('\n没找到消息数组，看顶层：', JSON.stringify(obj).slice(0, 600));
  process.exit(0);
}

console.log(`\n--- 消息树（共 ${msgs.length} 条，按 id 排序）---`);
const pick = (o, ...names) => {
  for (const n of names) if (o[n] !== undefined) return o[n];
  return undefined;
};
const rows = msgs
  .map((m) => ({
    id: pick(m, 'message_id', 'id'),
    parent: pick(m, 'parent_id', 'parentId'),
    role: pick(m, 'role'),
    status: pick(m, 'status'),
    text: (() => {
      const c = pick(m, 'content', 'text');
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x && x.text) || '').join('');
      return '';
    })(),
  }))
  .sort((a, b) => Number(a.id) - Number(b.id));

for (const r of rows) {
  const one = String(r.text).replace(/\s+/g, ' ').slice(0, 54);
  console.log(`  #${String(r.id).padStart(4)}  parent=${String(r.parent).padStart(5)}  ${String(r.role).padEnd(9)}  ${one}`);
}

const roots = rows.filter((r) => r.parent === null || r.parent === undefined || r.parent === 0);
console.log(`\n根消息（parent 为空）: ${roots.length} 条 → id ${roots.map((r) => r.id).join(', ')}`);
console.log('结论：' + (roots.length > 1
  ? '历次请求是**同一根下的兄弟分支**（UI 上就是同一条消息被改写）'
  : '历次请求已经是**一条链**'));
page.ws.close();
