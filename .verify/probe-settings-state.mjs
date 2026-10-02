/* 诊断探针：设置窗口的状态页为什么没渲染出角色卡
 *
 * 用法：node .verify/probe-settings-state.mjs [port]
 */
const PORT = Number(process.argv[2] || 9222);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find((x) => x.url && x.url.includes('settings.html'));
if (!t) {
  console.error('设置窗口没开');
  process.exit(1);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const expr = `JSON.stringify({
  tab: (document.querySelector('.tb-tab.on') || { dataset: {} }).dataset.tab || null,
  stCurrentId: (typeof stCurrent !== 'undefined' && stCurrent) ? stCurrent.characterId : null,
  samplesInCurrent: (typeof stCurrent !== 'undefined' && stCurrent) ? (stCurrent.samples || []).length : -1,
  samplesInStates: (typeof states !== 'undefined' && states && typeof stCurrent !== 'undefined' && stCurrent)
    ? ((states[stCurrent.characterId] || {}).samples || []).length : -1,
  sparkHTML: (document.getElementById('st-spark') || { innerHTML: '' }).innerHTML.slice(0, 220),
  sparkEmpty: !!document.querySelector('#st-spark .spark-empty'),
  polys: document.querySelectorAll('#st-spark polyline').length
})`;
const out = await new Promise((res) => {
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === 1) res(m.result && m.result.result ? m.result.result.value : JSON.stringify(m));
  });
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }),
  );
});
console.log(out);
setTimeout(() => {
  try {
    ws.close();
  } catch {}
}, 100);
process.exit(0);
