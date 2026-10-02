/* 一次性探针：主页面（chat.deepseek.com）的 CDP 还能不能正常 eval。
 * 用途：verify-persona-default.mjs 卡住时判断"是页面侧的问题还是脚本的问题"。
 * 用法：node .verify/probe-chat-cdp.mjs
 */
const CDP = 'http://127.0.0.1:9222';

const withTimeout = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('超时：' + what)), ms)),
  ]);

const list = await (await fetch(CDP + '/json/list')).json();
console.log('targets:');
for (const t of list) console.log('  -', t.type, t.url);

const chat = list.find((t) => t.url && t.url.includes('deepseek.com'));
if (!chat) {
  console.log('没有主页面 target');
  process.exit(1);
}

const ws = new WebSocket(chat.webSocketDebuggerUrl);
await withTimeout(
  new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  }),
  5000,
  'WebSocket 打开',
);
console.log('ws 已连接');

let seq = 0;
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return withTimeout(
    new Promise((res) => {
      const h = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) {
          ws.removeEventListener('message', h);
          res(m);
        }
      };
      ws.addEventListener('message', h);
    }),
    8000,
    method,
  );
};

const r1 = await send('Runtime.evaluate', { expression: '1+1', returnByValue: true });
console.log('1+1 =>', JSON.stringify(r1.result && r1.result.result));
const r2 = await send('Runtime.evaluate', {
  expression: "typeof window.__DSC_CFG__ === 'function' ? JSON.stringify(window.__DSC_CFG__()).slice(0,120) : 'no __DSC_CFG__'",
  returnByValue: true,
});
console.log('cfg =>', JSON.stringify(r2.result && r2.result.result));
ws.close();
process.exit(0);
