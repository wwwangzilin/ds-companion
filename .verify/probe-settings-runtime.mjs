/* 探设置窗口的运行时状态：data_dir 能不能调、DOM 绑定装没装上、有没有报错
 * 用法：node .verify/probe-settings-runtime.mjs [port]
 */
const PORT = Number(process.argv[2] || 9222);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find((x) => x.url && x.url.includes('settings.html'));
if (!t) throw new Error('设置窗口不在');

const logs = [];
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Log.entryAdded') logs.push(JSON.stringify(m.params).slice(0, 300));
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + JSON.stringify(m.params).slice(0, 400));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
const send = (method, params) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
};
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) return 'EXCEPTION: ' + JSON.stringify(r.exceptionDetails).slice(0, 300);
  return r && r.result ? r.result.value : undefined;
};

await send('Runtime.enable');
await send('Log.enable');

const probes = {
  'typeof __TAURI_INTERNALS__': 'typeof window.__TAURI_INTERNALS__',
  'data_dir 直调': "window.__TAURI_INTERNALS__.invoke('data_dir').then(v=>'OK '+JSON.stringify(v)).catch(e=>'ERR '+e)",
  'dataDirInfo 全局': 'JSON.stringify(window.__DSC_DATA_DIR_INFO__ || null)',
  'refreshDataDir 存在吗': "typeof refreshDataDir",
  '行文本': "document.getElementById('data-row').innerText.replace(/\\n/g,' | ')",
  'settings.js 加载了吗': "typeof invoke",
};
for (const [k, expr] of Object.entries(probes)) {
  console.log(`${k}: ${await evaluate(expr)}`);
}
await new Promise((r) => setTimeout(r, 1200));
console.log('--- 控制台/异常 ---');
console.log(logs.length ? logs.join('\n') : '（空）');
ws.close();
process.exit(0);
