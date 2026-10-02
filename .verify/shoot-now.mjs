/**
 * 只读截图：切到记忆页、选中第一条、截图、切回人设页。
 * **不创建也不删除任何数据** —— 用来给主人看真实状态的界面。
 * 用法：node .verify/shoot-now.mjs <输出png>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const OUT = resolve(process.argv[2] || 'preview/settings-now.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t = (await (await fetch(CDP + '/json/list')).json()).find(
  (x) => x.url && x.url.includes('settings.html'),
);
if (!t) throw new Error('设置窗口没开');

const ws = new WebSocket(t.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const slot = pending.get(m.id);
  if (slot) {
    pending.delete(m.id);
    slot(m);
  }
});
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const out = r.result || {};
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
  return out.result ? out.result.value : undefined;
};

await send('Page.enable');
await send('Runtime.enable');

const tab = process.argv[3] || 'memory';
await evaluate(`document.querySelector('.tb-tab[data-tab="${tab}"]').click()`);
await sleep(900);
// 只读选中：状态页会自动选中当前角色，记忆页点第一张卡只是打开编辑器（不写盘）
await evaluate(
  `(() => { const sel = ${JSON.stringify(tab === 'state' ? '#st-list' : '#mem-list')}; const c = document.querySelector(sel + ' .card'); if (c) c.click(); })()`,
);
await sleep(500);

const shot = await send('Page.captureScreenshot', { format: 'png' });
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));

// 界面回到人设页（只切页签，不改任何数据）
await evaluate(`document.querySelector('.tb-tab[data-tab="persona"]').click()`);
console.log('截图:', OUT);
const left = await evaluate(`window.__TAURI__.core.invoke('memory_list').then(l => l.length)`);
console.log('记忆库条数（未改动）:', left);
ws.close();
process.exit(0);
