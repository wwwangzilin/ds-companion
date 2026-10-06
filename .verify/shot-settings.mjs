/* 把设置窗口截一张图存下来 —— 界面这东西最后还得眼睛过一遍。
 *
 * 用法：$env:DSC_CDP='http://127.0.0.1:9223'; node .verify/shot-settings.mjs [页签名] [输出名]
 *   node .verify/shot-settings.mjs tools preview/settings-screen-see.png
 */
import { writeFileSync } from 'node:fs';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const TAB = process.argv[2] || 'tools';
const OUT = process.argv[3] || 'preview/settings.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('CDP 超时 ' + method));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
      }, 50);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP 连接失败'));
    };
  });
}

async function evalIn(target, expression) {
  const r = await send(target, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r && r.result ? r.result.value : undefined;
}

async function findTarget(match, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(`${BASE}/json/list`)).json();
      const t = list.find((x) => x.url && x.url.includes(match));
      if (t) return t;
    } catch {}
    if (Date.now() > deadline) throw new Error('等不到 ' + match);
    await sleep(300);
  }
}

const main = await findTarget('deepseek.com');
await evalIn(main, `window.__TAURI_INTERNALS__.invoke('open_settings')`);
const settings = await findTarget('settings.html');
// 【来回切一次页签】设置页在切换时才重新量那些 seg 滑块的位置。直接点一下 tools
// 有时量到的还是"元素还藏着"时的宽度（0），pill 就会停在两档中间 —— 那是量测时机问题，
// 不是布局坏了。要让截图反映真实观感，就得走一遍"真的切过去"这条路。
await evalIn(
  settings,
  `(async () => {
     const park = () => new Promise((r) => setTimeout(r, 450));
     const other = document.querySelector('.tb-tab[data-tab="persona"]');
     const want = document.querySelector('.tb-tab[data-tab="${TAB}"]');
     if (other) other.click();
     await park();
     if (want) want.click();
     await park();
     window.scrollTo(0, 0);
     return true;
   })()`,
);
await sleep(800);
const shot = await send(settings, 'Page.captureScreenshot', { format: 'png' });
const bytes = Buffer.from(shot.data, 'base64');
writeFileSync(OUT, bytes);
console.log(`[shot] ${OUT}  ${Math.round(bytes.length / 1024)}KB  页签=${TAB}`);
