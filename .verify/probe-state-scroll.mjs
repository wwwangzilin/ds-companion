/* 诊断探针：状态页到底能不能滚（用户视角 = 滚轮，不是程序化 scrollTop）
 *
 * 【为什么要单独写这个】verify-state 里的那条回归用的是 `f.scrollTop = 99999` ——
 * 那只证明"容器可滚"，**不证明"用户能滚"**。两件事会分家：
 *   · 内容被 flex 压扁（容器可滚但内容是塌的）
 *   · 滚轮事件根本没落到滚动容器上（或者被 overflow 计算吃掉）
 * 所以这里既量几何，也发**真实滚轮事件**（CDP Input.dispatchMouseEvent）。
 *
 * 用法：node .verify/probe-state-scroll.mjs [port]
 */
const PORT = Number(process.argv[2] || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find((x) => x.url && x.url.includes('settings.html'));
if (!t) {
  console.error('设置窗口没开');
  process.exit(1);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const slot = pending.get(m.id);
  if (slot) {
    pending.delete(m.id);
    slot(m);
  }
});
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
};
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result && r.result.result ? r.result.result.value : undefined;
};

await send('Page.enable');
// 强制重载：保证测的是**磁盘上最新的 CSS**（读缓存会让人误判"改了没用"）
await send('Page.reload', { ignoreCache: true });
await sleep(1500);

// 先确认样式表里到底有没有那条新规则（"改了没用"最常见的两个原因：
// 缓存，或规则根本没进样式表）
const cssAudit = await evalJs(`(function(){
  var sheets = [];
  var hit = [];
  for (var i = 0; i < document.styleSheets.length; i++) {
    var s = document.styleSheets[i];
    var n = -1;
    try { n = s.cssRules ? s.cssRules.length : -1; } catch (e) { n = 'ERR:' + e.message; }
    sheets.push((s.href || '(inline)') + ' rules=' + n);
    try {
      var rules = s.cssRules || [];
      for (var j = 0; j < rules.length; j++) {
        var sel = rules[j].selectorText;
        if (sel && sel.indexOf('#tab-state') >= 0) hit.push(sel + ' → ' + rules[j].style.cssText);
      }
    } catch (e) { /* 跨域表读不了 */ }
  }
  return JSON.stringify({ sheets: sheets, tabStateRules: hit });
})()`);
console.log('样式表审计：', cssAudit);

await evalJs(`document.querySelector('.tb-tab[data-tab="state"]').click()`);
await sleep(700);

const geo = JSON.parse(
  await evalJs(`(function(){
    var f = document.querySelector('#tab-state .fields');
    if (!f) return JSON.stringify({ found: false });
    var btn = document.getElementById('sf-feed');
    var row = btn ? btn.closest('.row') : null;
    var r = f.getBoundingClientRect();
    // 父链：谁把高度算成了 0
    var chain = [];
    var el = f;
    while (el && el !== document.body) {
      var cs = getComputedStyle(el);
      var rr = el.getBoundingClientRect();
      var cls = (typeof el.className === 'string' && el.className) ? '.' + el.className.split(' ').join('.') : '';
      chain.push({
        sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls,
        h: Math.round(rr.h), y: Math.round(rr.y),
        display: cs.display, flex: cs.flex, minH: cs.minHeight,
        height: cs.height, overflowY: cs.overflowY
      });
      el = el.parentElement;
    }
    return JSON.stringify({
      found: true,
      scrollH: f.scrollHeight, clientH: f.clientHeight,
      scrollW: f.scrollWidth, clientW: f.clientWidth,
      canScrollY: f.scrollHeight > f.clientHeight + 1,
      canScrollX: f.scrollWidth > f.clientWidth + 1,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      fieldsRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      winH: window.innerHeight,
      rowW: row ? Math.round(row.getBoundingClientRect().width) : -1,
      rowRight: row ? Math.round(row.getBoundingClientRect().right) : -1,
      rowOverflow: row ? Math.round(row.scrollWidth - row.clientWidth) : -1,
      feedBtnW: btn ? Math.round(btn.getBoundingClientRect().width) : -1,
      chain: chain
    });
  })()`),
);
console.log('几何：', JSON.stringify(geo, null, 1));
console.log('父链：');
for (const n of geo.chain || []) {
  console.log(
    `  ${String(n.h).padStart(5)}px  y=${String(n.y).padStart(5)}  ${n.sel.padEnd(34)} display=${n.display.padEnd(10)} flex=${String(n.flex).padEnd(14)} minH=${String(n.minH).padEnd(8)} overflowY=${n.overflowY}`,
  );
}

// 真实滚轮 —— 这才是"用户划不划得动"。
// 注意滚的是**滚动容器**：状态页现在是 .content 整页滚（.fields 已按内容展开、不再自己滚）
const scroller = await evalJs(
  `(function(){
    var f = document.querySelector('#tab-state .fields');
    var c = document.querySelector('#tab-state .content');
    return JSON.stringify({
      fieldsH: Math.round(f.getBoundingClientRect().h || f.getBoundingClientRect().height),
      cScrollH: c.scrollHeight, cClientH: c.clientHeight,
      cOverflow: c.scrollHeight > c.clientHeight + 1,
      fScrollTop: f.scrollTop, cScrollTop: c.scrollTop
    });
  })()`,
);
console.log('滚动容器：', scroller);

const cx = Math.round(geo.fieldsRect.x + geo.fieldsRect.w / 2);
// 【坐标必须在窗口内】.fields 的 y 可能因为内容滚动而落到视口下方（实测 693+120=813 > 761），
// 那时 elementFromPoint 返回 null、滚轮事件也没有落点 —— 探针会得到"滚不动"的假象
const cy = Math.round(Math.min(geo.winH - 40, Math.max(80, geo.fieldsRect.y + 40)));
const before = await evalJs(`document.querySelector('#tab-state .content').scrollTop`);
for (let i = 0; i < 3; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: cx,
    y: cy,
    deltaX: 0,
    deltaY: 160,
    button: 'none',
    pointerType: 'mouse',
  });
  await sleep(90);
}
const after = await evalJs(`document.querySelector('#tab-state .content').scrollTop`);
console.log(`真实滚轮（在 ${cx},${cy} 处 deltaY=160×3）：.content.scrollTop ${before} → ${after}`);

// 滚轮底下到底是谁
const hit = await evalJs(`(function(){
  var el = document.elementFromPoint(${cx}, ${cy});
  if (!el) return 'null';
  var path = [];
  while (el && path.length < 6) { path.push(el.tagName + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')); el = el.parentElement; }
  return path.join(' < ');
})()`);
console.log('该点命中链路：', hit);

setTimeout(() => {
  try {
    ws.close();
  } catch {}
}, 100);
process.exit(0);
