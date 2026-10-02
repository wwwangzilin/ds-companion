/** 记忆页「新建并保存」按钮的定点探针（顺带看有没有 JS 报错） */
// 会真的写记忆 → 先过隔离门禁（见 _env.mjs）
await (await import('./_env.mjs')).requireIsolation();
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
    if (out.exceptionDetails) {
      const e = out.exceptionDetails;
      return 'THREW: ' + (e.exception ? e.exception.description || e.exception.value : e.text);
    }
    return out.result ? out.result.value : undefined;
  }
}

const list = await (await fetch(CDP + '/json/list')).json();
let t = list.find((x) => x.url && x.url.includes('settings.html'));
if (!t) {
  const mainT = list.find((x) => x.url && x.url.includes('deepseek.com'));
  const m = new Page(mainT.webSocketDebuggerUrl);
  await m.open();
  await m.eval(`window.__TAURI_INTERNALS__.invoke('open_settings')`);
  for (let i = 0; i < 40 && !t; i++) {
    await sleep(250);
    t = (await (await fetch(CDP + '/json/list')).json()).find((x) => x.url && x.url.includes('settings.html'));
  }
}
const p = new Page(t.webSocketDebuggerUrl);
await p.open();
await sleep(400);

console.log('绑定是否在位:', await p.eval(`typeof newMemory + '/' + typeof saveMemory`));
console.log('元素:', await p.eval(`JSON.stringify(['mem-new','mem-save','mf-name','mf-keys','mf-content','mf-pinned','mf-char'].map(id => id + '=' + !!document.getElementById(id)))`));
console.log('点新建:', await p.eval(`(function(){ try { document.getElementById('mem-new').click(); return 'ok'; } catch(e){ return 'THREW ' + e.message; } })()`));
await sleep(200);
console.log('保存键 disabled:', await p.eval(`document.getElementById('mem-save').disabled`));
console.log('memCurrent:', await p.eval(`JSON.stringify(memCurrent)`));

const name = 'PROBE-MEM-' + Date.now();
console.log(
  '填字段并保存:',
  await p.eval(`(function(){
    try {
      document.getElementById('mf-name').value = ${JSON.stringify(name)};
      document.getElementById('mf-keys').value = 'a, b';
      document.getElementById('mf-content').value = 'x';
      document.getElementById('mem-save').click();
      return 'clicked';
    } catch(e){ return 'THREW ' + e.message; }
  })()`),
);
await sleep(1500);
console.log('toast:', await p.eval(`document.getElementById('toast').textContent`), '| err:', await p.eval(`document.getElementById('toast').classList.contains('err')`));
const found = await p.eval(`window.__TAURI__.core.invoke('memory_list').then(l => JSON.stringify(l.filter(m => m.name.indexOf('PROBE-MEM') === 0)))`);
console.log('落盘:', found);

// 清理
for (const id of JSON.parse(found).map((m) => m.id)) {
  await p.eval(`window.__TAURI__.core.invoke('memory_delete', { id: ${JSON.stringify(id)} })`);
}
console.log('已清理，剩余:', await p.eval(`window.__TAURI__.core.invoke('memory_list').then(l => l.length)`));
process.exit(0);
