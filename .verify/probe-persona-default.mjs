/* 一次性探针：把 verify-persona-default.mjs 的每一步写进 %TEMP%\dsc-probe.log
 * （用文件而不是 stdout —— 脚本被超时杀掉时管道里的输出会丢，看不到卡在哪一步） */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const L = join(tmpdir(), 'dsc-probe.log');
const log = (s) => appendFileSync(L, `[${Date.now() % 100000}] ${s}\n`);

class Page {
  constructor(ws, tag) {
    this.ws = new WebSocket(ws);
    this.tag = tag;
    this.seq = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    log(this.tag + ': ws open');
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      const slot = this.pending.get(m.id);
      if (slot) {
        this.pending.delete(m.id);
        slot(m);
      }
    });
    await this.send('Runtime.enable');
    log(this.tag + ': Runtime.enable ok');
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
    if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails));
    return out.result ? out.result.value : undefined;
  }
}

log('=== probe start ===');
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
log('targets: ' + list.map((t) => t.url).join(' , '));
const stT = list.find((x) => x.url.includes('settings.html'));
const chT = list.find((x) => x.url.includes('deepseek.com'));

const st = new Page(stT.webSocketDebuggerUrl, 'settings');
await st.open();
log('config_get ...');
const raw = await st.eval(
  `window.__TAURI_INTERNALS__.invoke('config_get').then(v => JSON.stringify(v)).catch(e => JSON.stringify({e:String(e)}))`,
);
log('config_get -> ' + String(raw).slice(0, 120));

const chat = new Page(chT.webSocketDebuggerUrl, 'chat');
await chat.open();
const v = await chat.eval('1+1');
log('chat 1+1 -> ' + v);

log('config_set off ...');
const cfgObj = JSON.parse(raw);
const setRes = await st.eval(
  `window.__TAURI_INTERNALS__.invoke('config_set', {cfg: ${JSON.stringify({ ...cfgObj, activePersona: 'off' })}})
     .then(()=> 'ok').catch(e => 'err:'+String(e))`,
);
log('config_set -> ' + String(setRes).slice(0, 200));

log('chat cfg ...');
const cc = await chat.eval(
  "typeof window.__DSC_CFG__ === 'function' ? JSON.stringify(window.__DSC_CFG__()).slice(0,140) : 'none'",
);
log('chat cfg -> ' + String(cc));
log('=== probe done ===');
process.exit(0);
