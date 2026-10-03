/* 一次性排查：界面那两个旋钮的 change 到底有没有跑、跑的时候抛了什么 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const list = await (await fetch(BASE + '/json/list')).json();
const t = list.find((x) => x.url && x.url.includes('settings.html'));
if (!t) throw new Error('设置窗口没开');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
function ev(expression) {
  return new Promise((res) => {
    const id = Math.floor(Math.random() * 1e6);
    const h = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', h);
      res(m.result && m.result.result ? m.result.result.value : JSON.stringify(m.result));
    };
    ws.addEventListener('message', h);
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });
}

console.log('setGate 是全局吗:', await ev('typeof setGate'));
console.log('quietHour 是全局吗:', await ev('typeof quietHour'));
console.log('输入框在不在:', await ev(`!!document.getElementById('sf-quiet-from')`));
console.log(
  '手动派发 change（带 try/catch 抓错）:',
  await ev(`(async () => {
    const el = document.getElementById('sf-quiet-from');
    el.value = '23';
    try { el.dispatchEvent(new Event('change')); } catch (e) { return 'THREW ' + e.message; }
    await new Promise(r => setTimeout(r, 1200));
    const cfg = await window.__TAURI_INTERNALS__.invoke('config_get');
    return JSON.stringify({ from: cfg.proactiveQuietFrom, to: cfg.proactiveQuietTo });
  })()`),
);
console.log(
  '直接调 setGate:',
  await ev(`(async () => {
    try { await setGate({ proactiveQuietFrom: 23, proactiveQuietTo: 8 }); }
    catch (e) { return 'setGate THREW ' + (e && e.message ? e.message : String(e)); }
    const cfg = await window.__TAURI_INTERNALS__.invoke('config_get');
    return JSON.stringify({ from: cfg.proactiveQuietFrom, to: cfg.proactiveQuietTo });
  })()`),
);
ws.close();
process.exit(0);
