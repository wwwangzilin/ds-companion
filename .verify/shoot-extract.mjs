/**
 * 「整理后」界面截图：真跑一次提取（网络回复是假的，不花额度），
 * 把结果留在界面上截图，然后清干净。
 * 用法：node .verify/shoot-extract.mjs <输出png>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// 数据隔离门禁：脚本会真存真删，跑在主人的真实数据上就是拿记忆当沙包（见 _env.mjs）
import { requireIsolation } from './_env.mjs';
await requireIsolation();

const CDP = 'http://127.0.0.1:9222';
const OUT = resolve(process.argv[2] || 'preview/settings-extract.png');
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

const pick = async (needle) => {
  for (let i = 0; i < 40; i++) {
    const t = (await (await fetch(CDP + '/json/list')).json()).find((x) => x.url && x.url.includes(needle));
    if (t) {
      const p = new Page(t.webSocketDebuggerUrl);
      await p.open();
      return p;
    }
    await sleep(250);
  }
  throw new Error('找不到页面：' + needle);
};

const settings = await pick('settings.html');
const main = await pick('deepseek.com');

const MARK = '演示整理';
const SESSION = 'shoot-extract-session';
const REPLY = JSON.stringify({
  items: [
    {
      op: 'add',
      name: `${MARK}·主人在做 DS Companion`,
      content: '主人正在做一个把 DeepSeek 网页装进原生窗口、自动注入人设的桌面程序',
      keys: ['DS Companion', '注入', '人设'],
      importance: 5,
      reason: '正在做的项目',
    },
    {
      op: 'add',
      name: `${MARK}·主人对成本敏感`,
      content: '主人很在意 token 花销，功能都要先设计好成本闸',
      keys: ['成本', '额度', 'token'],
      importance: 4,
    },
    {
      op: 'add',
      name: `${MARK}·主人喜欢暗色毛玻璃`,
      content: '界面偏好暗色沉浸 + 毛玻璃 + 紫蓝粉霓虹',
      keys: ['界面', '配色', '毛玻璃'],
      importance: 3,
    },
  ],
});

// 清掉上一轮残留
for (const m of (await settings.eval(
  `window.__TAURI__.core.invoke('memory_list').then(l => l.filter(m => m.name.indexOf(${JSON.stringify(MARK)}) >= 0))`,
)) || []) {
  await settings.eval(`window.__TAURI__.core.invoke('memory_delete', { id: ${JSON.stringify(m.id)} })`);
}

await main.eval(
  `window.__DSC_REMEMBER_TURN__(${JSON.stringify(SESSION)}, '我在做一个把 DeepSeek 网页装进原生窗口的桌面程序，人设和记忆都能注入进去', '听起来很有意思！主人打算怎么控制 token 花销呀？还有界面上有什么偏好吗？')`,
);
await main.eval(`(function(){
  window.__DSC_SHOOT_REAL__ = window.__DSC_DS_UTIL__;
  window.__DSC_DS_UTIL__ = Object.assign({}, window.__DSC_DS_UTIL__, {
    ensureSession: function(){ return Promise.resolve('shoot-session'); },
    completion: function(){ return Promise.resolve({ text: ${JSON.stringify(REPLY)}, raw: '', latencyMs: 900 }); }
  });
  return true;
})()`);

const r = JSON.parse(await main.eval(`window.__DSC_EXTRACT__().then(r => JSON.stringify(r))`));
console.log('提取结果:', JSON.stringify(r));
await main.eval(`(function(){ window.__DSC_DS_UTIL__ = window.__DSC_SHOOT_REAL__; window.__DSC_FORGET_TRANSCRIPT__(); return true; })()`);

await settings.eval(`document.querySelector('.tb-tab[data-tab="memory"]').click()`);
await settings.eval(`document.getElementById('mem-extract-hint').textContent = ${JSON.stringify(
  `上次整理：新增 ${r.added}`,
)}`);
await sleep(700);
await settings.eval(`(() => { const c = document.querySelectorAll('#mem-list .card')[0]; if (c) c.click(); })()`);
await sleep(400);

const shot = await settings.send('Page.captureScreenshot', { format: 'png' });
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));

for (const id of (await settings.eval(
  `window.__TAURI__.core.invoke('memory_list').then(l => l.filter(m => m.name.indexOf(${JSON.stringify(MARK)}) >= 0).map(m => m.id))`,
)) || []) {
  await settings.eval(`window.__TAURI__.core.invoke('memory_delete', { id: ${JSON.stringify(id)} })`);
}
const left = await settings.eval(`window.__TAURI__.core.invoke('memory_list').then(l => l.length)`);
// 界面回到人设页：留下记忆页在前台会让下一个脚本量到 0px 的隐藏元素（假红）
await settings.eval(`document.querySelector('.tb-tab[data-tab="persona"]').click()`);
console.log('截图:', OUT, '| 演示数据已清理，剩余', left, '条');
process.exit(0);
