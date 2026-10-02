/** 探针：调 window_show_main，把主窗口顶到前台（好让 Win32 能拿到它的句柄） */
const CDP = 'http://127.0.0.1:9222';
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
    const out = r.result || {};
    if (out.exceptionDetails) return 'THREW: ' + (out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    return out.result ? out.result.value : undefined;
  }
}
const list = await (await fetch(CDP + '/json/list')).json();
let t = list.find((x) => x.url && x.url.includes('settings.html'));
if (!t) {
  const m = list.find((x) => x.url && x.url.includes('deepseek.com'));
  const p0 = new Page(m.webSocketDebuggerUrl);
  await p0.open();
  await p0.eval(`window.__TAURI_INTERNALS__.invoke('open_settings')`);
  for (let i = 0; i < 40 && !t; i++) {
    await sleep(250);
    t = (await (await fetch(CDP + '/json/list')).json()).find((x) => x.url && x.url.includes('settings.html'));
  }
}
const p = new Page(t.webSocketDebuggerUrl);
await p.open();
await sleep(300);
console.log('show_main →', await p.eval(`window.__TAURI__.core.invoke('window_show_main').then(() => 'ok')`));
await sleep(800);
// 顺便把设置窗口挪开，免得它抢 MainWindow 的位置
console.log('autostart_get →', await p.eval(`window.__TAURI__.core.invoke('autostart_get')`));
console.log('log_tail →', JSON.stringify(await p.eval(`window.__TAURI__.core.invoke('log_tail', { lines: 3 }).then(r => ({ total: r.total, size: r.size, last: r.lines[r.lines.length-1].slice(0,50) }))`)));
process.exit(0);
