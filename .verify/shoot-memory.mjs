/**
 * 记忆页签截图：临时造两条演示记忆 → 切到记忆页 → 选中一条 → 截图 → 删干净。
 * 用法：node .verify/shoot-memory.mjs <输出png>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// 数据隔离门禁：脚本会真存真删，跑在主人的真实数据上就是拿记忆当沙包（见 _env.mjs）
import { requireIsolation } from './_env.mjs';
await requireIsolation();

const CDP = 'http://127.0.0.1:9222';
const OUT = resolve(process.argv[2] || 'preview/settings-memory.png');
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

const target = (await (await fetch(CDP + '/json/list')).json()).find((t) => t.url && t.url.includes('settings.html'));
if (!target) throw new Error('设置窗口没开');
const page = new Page(target.webSocketDebuggerUrl);
await page.open();

const demo = [
  { name: '主人只喝美式', content: '不加糖不加奶，早上必喝一杯。', keys: ['咖啡', '美式'], importance: 4, pinned: false, characterId: '' },
  { name: '露娜的约定', content: '叫主人「主人」，被夸会嘴硬但尾巴在摇。', keys: ['露娜', '称呼'], importance: 5, pinned: true, characterId: 'dsh-luna' },
  { name: '主人在做写作软件', content: '叫 Quill，Tauri + Markdown，本地 git 版本管理。', keys: ['Quill', '写作'], importance: 3, pinned: false, characterId: '' },
];

const ids = [];
for (const d of demo) {
  const saved = await page.eval(
    `window.__TAURI__.core.invoke('memory_save', { item: ${JSON.stringify({ id: '', createdAt: 0, lastAccessedAt: 0, accessCount: 0, ...d })} })`,
  );
  if (saved && saved.id) ids.push(saved.id);
}

await page.eval(`document.querySelector('.tb-tab[data-tab="memory"]').click()`);
await sleep(600);
// 选中第二条（有钉住、有角色归属，信息最全）
await page.eval(`(() => { const c = document.querySelectorAll('#mem-list .card')[1]; if (c) c.click(); })()`);
await sleep(400);

const shot = await page.send('Page.captureScreenshot', { format: 'png' });
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));

// 清干净，不留演示数据
for (const id of ids) {
  await page.eval(`window.__TAURI__.core.invoke('memory_delete', { id: ${JSON.stringify(id)} })`);
}
await page.eval(`document.querySelector('.tb-tab[data-tab="persona"]').click()`);
const left = await page.eval(`window.__TAURI__.core.invoke('memory_list').then(l => l.length)`);
console.log('截图:', OUT, '| 演示记忆已清理，剩余', left, '条');
process.exit(0);
