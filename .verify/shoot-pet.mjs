/**
 * 只读截图：把**桌宠窗口 / 设置窗口**拍下来给主人看（透明窗口先垫一层底色再拍）。
 *
 * 【为什么要垫底色】桌宠窗是 transparent + 无边框的，直接截图得到的是带 alpha 的 PNG ——
 * 在大多数看图器里会被显示成黑底或者花格子，看不出她长什么样、气泡贴不贴。
 * 用 CDP 的默认背景色覆盖临时垫一层，拍完立刻还原（不改页面、不改数据）。
 *
 * 用法：node .verify/shoot-pet.mjs [输出png] [底色 r,g,b] [--settings]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wantSettings = process.argv.includes('--settings');
const OUT = resolve(args[0] || (wantSettings ? 'preview/settings-now.png' : 'preview/pet-now.png'));
const RGB = (args[1] || '32,32,40').split(',').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t = (await (await fetch(BASE + '/json/list')).json()).find((x) =>
  wantSettings ? x.url && x.url.includes('settings.html') : x.url && x.url.includes('pet.html'),
);
if (!t) throw new Error(wantSettings ? '设置窗口没开' : '桌宠窗口没开');

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

await send('Page.enable');
// 【为什么不用 Emulation.setDefaultBackgroundColorOverride】实测试了没用：WebView2 拍出来
// 还是把透明处合成到纯黑上（深色的她和黑底糊成一片，看不清）。改成临时给 html 垫一层底色，
// 拍完立刻把那个 style 摘掉 —— 页面本身没变，数据更没碰。
const bg = `rgb(${RGB[0]},${RGB[1]},${RGB[2]})`;
if (!wantSettings) {
  await send('Runtime.evaluate', {
    expression: `(() => {
      const s = document.createElement('style');
      s.id = 'dsc-shot-bg';
      s.textContent = 'html,body{background:${bg} !important}';
      document.head.appendChild(s);
      return true;
    })()`,
  });
  await sleep(400);
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (!wantSettings) {
  await send('Runtime.evaluate', {
    expression: `(() => { const s = document.getElementById('dsc-shot-bg'); if (s) s.remove(); return true; })()`,
  });
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log('截图:', OUT);
await sleep(200);
process.exit(0);
