/** 只读：把当前【状态】块与主人状态打出来，量一下每轮成本 */
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
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    return out.result ? out.result.value : undefined;
  }
}
const list = await (await fetch(CDP + '/json/list')).json();
const t = list.find((x) => x.url && x.url.includes('deepseek.com'));
const p = new Page(t.webSocketDebuggerUrl);
await p.open();
const cfg = JSON.parse(await p.eval(`JSON.stringify(window.__DSC_CFG__())`));
const st = cfg.state || {};
const u = cfg.userState || {};
console.log('=== 【状态】块（每轮注入）===');
console.log(cfg.stateText || '(空)');
console.log('\n=== 字数 / 粗估 token ===');
const len = (cfg.stateText || '').length;
console.log(`状态块 ${len} 字 ≈ ${Math.round(len * 0.6)} token`);
console.log(`回锚块 ${(cfg.anchorText || '').length} 字 ≈ ${Math.round((cfg.anchorText || '').length * 0.6)} token（每 ${cfg.anchorEveryTurns} 轮一次）`);
console.log(`人设   ${(cfg.personaText || '').length} 字（节奏 ${cfg.cadence}）`);
console.log(`记忆   ${(cfg.memories || []).length} 条可用，预算 ${cfg.memoryBudget} token`);
console.log('\n=== 角色状态 ===');
console.log(JSON.stringify({ mood: st.mood, affinity: st.affinity, energy: st.energy, turns: st.turns, body: st.body }, null, 1));
console.log('\n=== 主人状态 ===');
console.log(JSON.stringify(u, null, 1));
process.exit(0);
