/* 截图：设置页「状态」页签上的**曲线卡 + 日记卡**（一次把两个待过目的东西截进来）。
 *
 * 【为什么要有这个】本机没有视觉能力（describe_image 缺 provider、无 modlens engine），
 * 所以"好不好看"只能留在 preview/ 里给主人自己看；脚本这边负责把状态摆到位
 * （进状态页、把卡片滚到视口里），免得截出一张空页面。
 *
 * 用法（对着**隔离实例**跑，端口 9223）：
 *   $env:DSC_DATA_DIR="$env:TEMP\dsc-verify-diary-card"; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   .\src-tauri\target\debug\ds-companion.exe
 *   node .verify/verify-diary-card.mjs      # 先种两天日记 + 验收
 *   node .verify/shoot-diary-card.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const OUT = resolve(process.argv[2] || 'preview/diary-card.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await this.send('Page.enable');
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
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
}

async function findTarget(match) {
  const list = await (await fetch(BASE + '/json/list')).json();
  return list.find((t) => t.url && t.url.includes(match));
}

let target = await findTarget('settings.html');
if (!target) throw new Error('设置窗口没开（先跑 verify-diary-card.mjs，它会 open_settings）');

let page = new Page(target.webSocketDebuggerUrl);
await page.open();

// 进「状态」页，并把曲线卡顶到视口上边 —— 这样曲线卡与它下面的日记卡同框
await page.eval(
  `(() => {
     const b = document.querySelector('.tb-tab[data-tab="state"]'); if (b) b.click();
     return true;
   })()`,
);
await sleep(1500);
await page.eval(
  `(() => {
     const c = document.getElementById('curve-card');
     if (c) c.scrollIntoView({ block: 'start' });
     return true;
   })()`,
);
await sleep(700);

// 回到**默认状态**（摊开最新那篇）：验收脚本最后点的是早一天，
// 直接截会截出"点了别的日子"的样子 —— 图要代表主人第一次打开时看到的画面
await page.eval(
  `(() => { const b = document.querySelector('#diary-days .diary-day'); if (b) b.click(); return true; })()`,
);
await sleep(700);

const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));

const info = await page.eval(
  `(() => {
     const d = document.getElementById('diary-days');
     const b = document.getElementById('diary-body');
     return {
       w: innerWidth, h: innerHeight,
       days: d ? d.querySelectorAll('.diary-day').length : 0,
       sub: (document.getElementById('diary-sub') || {}).textContent,
       bodyChars: b ? (b.textContent || '').length : 0,
     };
   })()`,
);
console.log('截图:', OUT, JSON.stringify(info));
process.exit(0);
