/* 最小 CDP 探针：在指定窗口里 invoke 一条命令，用来确认命令/ACL 是通的
 * 用法：node .verify/probe-invoke.mjs [port] [cmd] [target: deepseek|settings]
 *
 * 【为什么必须能选窗口】远程页面（chat.deepseek.com）与本地设置窗口走的是**两套
 * capability 白名单**：settings-only 的命令从主页面调只会得到 "not allowed"。
 * 拿主页面去测设置命令，会得到"命令不存在"的假结论（踩过一次）。
 */
const PORT = Number(process.argv[2] || 9222);
const CMD = process.argv[3] || 'data_dir';
const WHICH = process.argv[4] || 'settings';
const MATCH = WHICH === 'deepseek' ? 'deepseek.com' : 'settings.html';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find((x) => x.url && x.url.includes(MATCH));
if (!t) throw new Error(`找不到目标窗口（${MATCH}）`);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
const out = await new Promise((res) => {
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === 1) res(m.result);
  };
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `window.__TAURI_INTERNALS__.invoke('${CMD}').then(v => 'OK ' + JSON.stringify(v)).catch(e => 'ERR ' + e)`,
        returnByValue: true,
        awaitPromise: true,
      },
    }),
  );
});
ws.close();
const v = out && out.result ? out.result.value : JSON.stringify(out);
console.log(`${CMD} →`, v);
process.exit(String(v).startsWith('OK') ? 0 : 1);
