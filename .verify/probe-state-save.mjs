/** 状态页保存按钮的定点探针（只读 + 一次真点保存，跑完把状态写回原样） */
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
  if (!mainT) throw new Error('主窗口也没开');
  const m = new Page(mainT.webSocketDebuggerUrl);
  await m.open();
  await m.eval(`window.__TAURI_INTERNALS__.invoke('open_settings')`);
  for (let i = 0; i < 40 && !t; i++) {
    await sleep(250);
    t = (await (await fetch(CDP + '/json/list')).json()).find((x) => x.url && x.url.includes('settings.html'));
  }
}
if (!t) throw new Error('设置窗口没开');
const p = new Page(t.webSocketDebuggerUrl);
await p.open();
await sleep(400);

const cfg = JSON.parse(await p.eval(`window.__TAURI__.core.invoke('config_get').then(c => JSON.stringify(c))`));
const ch = cfg.activePersona;
const snap = await p.eval(`window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(ch)} }).then(s => JSON.stringify(s))`);
console.log('角色:', ch, '| 原状态 arc=', JSON.parse(snap).arc, 'aff=', JSON.parse(snap).affinity);

// 收集页面上的报错
await p.eval(`(function(){ window.__ERR__ = []; window.addEventListener('error', function(e){ window.__ERR__.push(String(e.message)); }); return true; })()`);

await p.eval(`document.querySelector('.tb-tab[data-tab="state"]').click()`);
await sleep(1200);
console.log('切页后 stCurrent:', await p.eval(`JSON.stringify(stCurrent ? {id: stCurrent.characterId, arc: stCurrent.arc, turns: stCurrent.turns} : null)`));
console.log('卡片数:', await p.eval(`document.querySelectorAll('#st-list .card').length`));
console.log('保存键 disabled:', await p.eval(`document.getElementById('st-save').disabled`));

await p.eval(`document.querySelector('#st-list .card').click()`);
await sleep(500);
console.log('点卡片后 stCurrent:', await p.eval(`JSON.stringify(stCurrent ? {id: stCurrent.characterId, turns: stCurrent.turns} : null)`));
console.log('保存键 disabled:', await p.eval(`document.getElementById('st-save').disabled`));

const setRes = await p.eval(`(function(){
  try {
    document.getElementById('sf-arc').value = 'PROBE-ARC';
    document.getElementById('sf-anchors').value = 'PROBE-A\\nPROBE-B';
    return 'ok';
  } catch(e) { return 'THREW ' + e.message; }
})()`);
console.log('填字段:', setRes);

const clickRes = await p.eval(`(function(){
  try { document.getElementById('st-save').click(); return 'clicked'; } catch(e){ return 'THREW ' + e.message; }
})()`);
console.log('点保存:', clickRes);
await sleep(1000);
console.log('save-note:', await p.eval(`document.getElementById('st-save-note').textContent`));
console.log('toast:', await p.eval(`document.getElementById('toast').textContent`), '| err class:', await p.eval(`document.getElementById('toast').classList.contains('err')`));
console.log('页面报错:', await p.eval(`JSON.stringify(window.__ERR__ || [])`));

const after = JSON.parse(await p.eval(`window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(ch)} }).then(s => JSON.stringify(s))`));
console.log('保存后磁盘:', 'arc=', after.arc, 'anchors=', JSON.stringify(after.anchors), 'aff=', after.affinity);

// 写回原样
await p.eval(`window.__TAURI__.core.invoke('state_save', { state: ${snap} })`);
const back = JSON.parse(await p.eval(`window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(ch)} }).then(s => JSON.stringify(s))`));
console.log('已还原: arc=', back.arc, 'aff=', back.affinity);
await p.eval(`document.querySelector('.tb-tab[data-tab="persona"]').click()`);
process.exit(0);
