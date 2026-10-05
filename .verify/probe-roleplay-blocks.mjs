/* 一次性排查：augment 出来的正文里，那几个新块的标记到底在不在、在第几处 */
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
      res(m.result && m.result.result ? m.result.result.value : JSON.stringify(m.result).slice(0, 400));
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

console.log(
  'CFG 里那几栏：',
  await ev(`JSON.stringify({
    scene: (window.__DSC_CFG__()||{}).sceneText,
    relation: ((window.__DSC_CFG__()||{}).relationText||'').slice(0,20),
    pending: (window.__DSC_CFG__()||{}).pendingText,
    avoid: (window.__DSC_CFG__()||{}).boundariesAvoid,
    ooc: (window.__DSC_CFG__()||{}).oocToken,
  })`),
);
console.log(
  'augment 里各标记的位置：',
  await ev(`(() => {
    const out = window.__DSC_AUGMENT__(JSON.stringify({prompt:'喂 // 出来一下', chat_session_id:'probe'}), 'probe');
    const s = typeof out === 'string' ? out : JSON.stringify(out);
    const marks = ['【场景】','【关系】','【待回访】','【边界】','【出戏】','【状态】','【回忆】'];
    const at = {};
    for (const m of marks) at[m] = s.indexOf(m);
    return JSON.stringify({ len: s.length, at });
  })()`),
);
console.log(
  '正文里带【的那几行：',
  await ev(`(() => {
    const out = window.__DSC_AUGMENT__(JSON.stringify({prompt:'喂 // 出来一下', chat_session_id:'probe'}), 'probe');
    const s = typeof out === 'string' ? out : JSON.stringify(out);
    return s.split('\\n').filter(l => l.includes('【')).join(' | ');
  })()`),
);
ws.close();
process.exit(0);
