/* 健壮的"开设置窗口"：等主页面就绪 -> invoke open_settings -> 等设置页出现
 *
 * 【为什么不能只 invoke 一次】壳刚起来时 WebView2 的 CDP 端点可能还没开始监听
 * （首次启动、刚换过 exe、刚删过用户数据目录都会慢几秒）。原来的探针只试一次，
 * 于是"CDP 还没起来"会被误读成"壳没跑"，验收就假红了 —— 那是脚本的问题，不是产品的问题。
 *
 * 用法：node .verify/probe-open-settings.mjs [port]
 */
const PORT = Number(process.argv[2] || 9222);
const CDP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  return await (await fetch(`${CDP}/json/list`)).json();
}

async function waitFor(match, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const t = (await targets()).find(match);
      if (t) return t;
    } catch {
      /* CDP 还没起来：继续等 */
    }
    if (Date.now() > deadline) return null;
    await sleep(400);
  }
}

const main = await waitFor((x) => x.url && x.url.includes('deepseek.com'), 60000);
if (!main) {
  console.error('主页面 60 秒内没出现（壳没跑？或 CDP 端口不对）');
  process.exit(1);
}

if (await waitFor((x) => x.url && x.url.includes('settings.html'), 500)) {
  console.log('设置窗口本来就开着');
  process.exit(0);
}

const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
const out = await new Promise((res) => {
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === 1) res(m.result);
  });
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression:
          "window.__TAURI_INTERNALS__.invoke('open_settings').then(() => 'ok').catch(e => 'ERR ' + e)",
        returnByValue: true,
        awaitPromise: true,
      },
    }),
  );
});
setTimeout(() => {
  try {
    ws.close();
  } catch {}
}, 100);
console.log('open_settings →', out && out.result ? out.result.value : out);

const settings = await waitFor((x) => x.url && x.url.includes('settings.html'), 20000);
if (!settings) {
  console.error('设置窗口没起来');
  process.exit(1);
}
console.log('设置窗口已开：', settings.url);
process.exit(0);
