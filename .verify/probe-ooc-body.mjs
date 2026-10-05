/* 专项探针：出戏那一轮，块里写了什么 + **身体层**是不是真被推上去了 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const list = await (await fetch(BASE + '/json/list')).json();
const t = list.find((x) => x.url && x.url.includes('deepseek.com'));
if (!t) throw new Error('主页面没开');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
function ev(expression) {
  return new Promise((res) => {
    const id = Math.floor(Math.random() * 1e6);
    const h = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', h);
      if (m.result && m.result.exceptionDetails) {
        res('THREW ' + JSON.stringify(m.result.exceptionDetails).slice(0, 200));
        return;
      }
      res(m.result && m.result.result ? m.result.result.value : undefined);
    };
    ws.addEventListener('message', h);
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });
}

// ⓪ 先给这个隔离实例配上暗号（新数据目录里它是空的，没配就不加【出戏】块）
console.log(
  '配暗号：',
  await ev(`(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const cfg = await inv('config_get');
    cfg.oocToken = '出戏';
    cfg.boundariesAvoid = '体重';
    await inv('config_set', { cfg });
    return 'ok';
  })()`),
);
await new Promise((r) => setTimeout(r, 800));

// ① 出戏块的完整文案（要能看到 心跳/磕巴/思考/露娜 四个关键词）
console.log(
  '【出戏】块全文：\n' +
    (await ev(`(() => {
      const o = window.__DSC_AUGMENT__(JSON.stringify({prompt:'喂 出戏 出来一下', chat_session_id:'probe'}), 'probe');
      const s = typeof o === 'string' ? o : JSON.stringify(o);
      const i = s.indexOf('【出戏】');
      return i < 0 ? '(没有出戏块！)' : s.slice(i, i + 420);
    })()`)),
);

// ② 身体层：ooc=true 那一发之后，心跳/体温有没有真的上去
const before = await ev(
  `window.__TAURI_INTERNALS__.invoke('dsc_turn_report', {userText:'普通一句', hour:21, day:window.__DSC_LOCAL_DAY__()}).then(r => JSON.stringify({hr:r.state.body.heartRate, warm:r.state.body.warmth}))`,
);
const after = await ev(
  `window.__TAURI_INTERNALS__.invoke('dsc_turn_report', {userText:'出戏', hour:21, day:window.__DSC_LOCAL_DAY__(), ooc:true}).then(r => JSON.stringify({hr:r.state.body.heartRate, warm:r.state.body.warmth, lang:r.state.body.language}))`,
);
console.log('普通一轮：', before);
console.log('出戏那一轮：', after);
ws.close();
process.exit(0);
