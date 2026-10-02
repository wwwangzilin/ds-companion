/**
 * 收尾 + 截图：
 *   1. 把验收时激活的人设清掉（别让主人一开聊天就是「三千代」）
 *   2. 打开导入进来的那个人设，让编辑器是填充状态
 *   3. 截设置窗口的图存到 preview/settings-ui.png
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const OUT = resolve(process.argv[2] || '.verify/../../preview/settings-ui.png');

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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
}

const list = await (await fetch(CDP + '/json/list')).json();
const target = list.find((t) => t.url && t.url.includes('settings.html'));
if (!target) throw new Error('设置窗口没开');

const page = new Page(target.webSocketDebuggerUrl);
await page.open();

// 1) 清掉激活（保留导入进来的人设本体）
await page.eval(`(async () => {
  const inv = window.__TAURI__.core.invoke;
  const cfg = await inv('config_get');
  cfg.activePersona = null;
  await inv('config_set', { cfg });
  return true;
})()`);

// 2) 刷新界面状态 + 打开第一个卡片，让编辑器有内容
await page.eval(`location.reload()`);
await sleep(1200);
const page2 = new Page((await (await fetch(CDP + '/json/list')).json()).find((t) => t.url.includes('settings.html')).webSocketDebuggerUrl);
await page2.open();
await page2.eval(`(() => { const c = document.querySelector('#list .card'); if (c) c.click(); return !!c; })()`);
await sleep(500);

// 3) 截图
const shot = await page2.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
const size = await page2.eval(`({ w: innerWidth, h: innerHeight, personas: document.querySelectorAll('#list .card').length })`);
console.log('截图:', OUT, JSON.stringify(size));
process.exit(0);
