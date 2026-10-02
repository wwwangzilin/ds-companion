/**
 * 注入链路验收：确认钩子真的改到了 body.prompt。
 *
 * 手法：在主页面里发一条 XHR 到 /api/v0/chat/completion，body 是合成的最小载荷
 * （parent_message_id: null ⇒ 走「仅首条」分支），**send 之后立刻 abort**：
 * 钩子在 send() 里同步执行完并把结果写进壳日志，请求本身不会真的产生一条对话。
 *
 * 用法：node .verify/verify-injection.mjs
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const LOG = join(tmpdir(), 'ds-companion.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

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
    if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails));
    return out.result ? out.result.value : undefined;
  }
}

const list = await (await fetch(CDP + '/json/list')).json();
const target = list.find((t) => t.url && t.url.includes('deepseek.com'));
if (!target) throw new Error('主页面不在（exe 没跑或没登录？）');

const page = new Page(target.webSocketDebuggerUrl);
await page.open();

// 记一下日志当前长度，只看新增部分（免得读到上一轮的记录）
const before = (() => {
  try {
    return readFileSync(LOG, 'utf8').length;
  } catch {
    return 0;
  }
})();

// 1) 先确认脚本活着、配置已到位
const beforeState = await page.eval(`JSON.stringify({
  hasState: !!window.__DSC_STATE__,
  hasSetCfg: typeof window.__DSC_SET_CONFIG__,
  state: window.__DSC_STATE__ || null
})`);
const bs = JSON.parse(beforeState);
check('注入脚本在页面上', bs.hasState && bs.hasSetCfg === 'function', beforeState);
check('配置已推送到页面', !!bs.state, JSON.stringify(bs.state));

// 【前置】必须有**生效的人设**：否则钩子会正确地跳过注入（why=no-persona-text），
// 而后面那些断言会整片假红 —— 看起来像"注入坏了"，其实是配置里选的是「原版」。
// 按项目纪律：前置不满足要**明说**，别让它伪装成功能回归。
//
// 注意读的是 `__DSC_CFG__()`（页面拿到的配置），不是 `__DSC_STATE__`（那只是个计数器）。
const cfgJson = await page.eval(
  "typeof window.__DSC_CFG__ === 'function' ? JSON.stringify(window.__DSC_CFG__()) : 'null'",
);
const pageCfg = cfgJson === 'null' ? null : JSON.parse(cfgJson);
if (!pageCfg || !pageCfg.personaText) {
  console.error(
    [
      '',
      `[前置] 当前没有生效的人设（personaText 为空，cadence=${pageCfg && pageCfg.cadence}）—— 后面必然整片假红。`,
      '  多半是配置里选着「原版（不注入人设）」。',
      '  正确顺序：node .verify\\probe-open-settings.mjs  →  node .verify\\seed-persona.mjs  →  本脚本',
      '',
    ].join('\n'),
  );
  process.exit(2);
}
check('前置：有生效的人设', !!pageCfg.personaText, String(pageCfg.personaName));

// 2) 发一条合成 XHR（立刻 abort，不产生真实消息）
const probe = await page.eval(`(function(){
  try {
    var x = new XMLHttpRequest();
    x.open('POST', '/api/v0/chat/completion');
    x.setRequestHeader('Content-Type', 'application/json');
    x.send(JSON.stringify({
      chat_session_id: null,
      parent_message_id: null,
      prompt: 'DSCOMPANION_HOOK_PROBE',
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false
    }));
    x.abort();
    return 'sent';
  } catch (e) { return 'throw:' + e; }
})()`);
check('合成请求已发出', probe === 'sent', probe);

await sleep(900);

// 3) 读壳日志里新增的行
let added = '';
try {
  added = readFileSync(LOG, 'utf8').slice(before);
} catch {}
const injected = /INJECTED\(xhr\)/.test(added);
check('钩子真的注入进 body.prompt', injected, added.trim().split('\n').filter((l) => l.includes('[page]')).slice(-3).join(' | '));

// 4) 看脚本自己的计数
const after = await page.eval(`JSON.stringify(window.__DSC_STATE__)`);
const st = JSON.parse(after);
check('脚本计数 seen 增加', st.seen >= 1, `seen=${st.seen}`);
check('走的是 XHR 路径', st.viaXhr >= 1, `viaXhr=${st.viaXhr} viaFetch=${st.viaFetch}`);
check('记到了真实端点', (st.urls || []).some((u) => u.includes('/api/v0/chat/completion')), JSON.stringify(st.urls));
check('没有钩子异常', st.errors === 0, `errors=${st.errors}`);
check('没有 skip 掉（cadence/人设都该允许）', st.skipped === 0 || injected, `skipped=${st.skipped}`);

console.log(`\n${failed === 0 ? '注入链路全通' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
