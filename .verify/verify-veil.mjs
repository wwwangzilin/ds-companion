/* 验收：注入块在消息里**真的被藏掉了**。
 *
 * 【为什么要专门验它】改拼法（把注入块挪到主人那句话后面）只解决"折叠露出来的是谁"，
 * 而且只管以后发的消息 —— 服务器上存着的历史消息里，注入块还在最前面。
 * 更要命的是短消息：只打「继续」两个字时，折叠的那 192px 里「继续」之后还剩一大片，
 * 提示词照样露出来。所以必须验"**可见文本里没有提示词**"，而不是"折叠位置对不对"。
 *
 * 【为什么不能只看 .dsc-veil 存在】存在不等于藏对：把他的话也一起塞进去同样满足"存在"。
 * 所以两条断言都要：
 *   ① 每条消息的**可见文字**里不含 `【人设】`
 *   ② DOM 里的**总字数**没有变少（一个字都没被吃掉）
 *
 * 用真实数据跑（要的就是真实的历史消息）：
 *   $env:DSC_ALLOW_REAL_DATA='1'; $env:DSC_CDP='http://127.0.0.1:9223'; node .verify/verify-veil.mjs
 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('CDP 超时 ' + method));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
      }, 50);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP 连接失败'));
    };
  });
}

async function evalIn(target, expression, timeoutMs = 90000) {
  const r = await send(
    target,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r && r.result ? r.result.value : undefined;
}

async function findTarget(match, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(`${BASE}/json/list`)).json();
      const t = list.find((x) => x.url && x.url.includes(match));
      if (t) return t;
    } catch {}
    if (Date.now() > deadline) throw new Error('等不到 ' + match);
    await sleep(300);
  }
}

console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com');

// 开一条真人会话（跳过我们自己的系统会话）——首页没有消息可验
const nav = await evalIn(
  main,
  `(() => {
     if (document.querySelectorAll('.ds-collapsible-text').length > 0) return JSON.stringify({ ok: 1 });
     const links = Array.from(document.querySelectorAll('a[href*="/a/chat/s/"]'))
       .filter((a) => !a.classList.contains('dsc-sys-session') && (a.innerText || '').trim());
     if (!links.length) return JSON.stringify({ err: '侧栏里找不到能开的会话' });
     location.assign(links[0].getAttribute('href'));
     return JSON.stringify({ going: links[0].getAttribute('href') });
   })()`,
);
console.log('[开会话] ' + String(nav));
for (let i = 0; i < 40; i++) {
  const c = await evalIn(main, `document.querySelectorAll('.ds-collapsible-text').length`).catch(() => 0);
  if (Number(c) > 0) break;
  await sleep(500);
}
await sleep(2500); // 留档是异步拉的，切第二遍要等它回来

const raw = await evalIn(
  main,
  `(() => {
     const cells = Array.from(document.querySelectorAll('.ds-collapsible-text'));
     const rows = cells.map((cell) => {
       const veil = cell.querySelector('.dsc-veil');
       const shown = cell.innerText || '';
       // 可见文字（innerText 会跳过 display:none）vs DOM 里的全文
       const domText = Array.from(cell.childNodes)
         .map((n) => n.textContent || '')
         .join('');
       return {
         shownLen: shown.length,
         shownHead: shown.replace(/\\s+/g, ' ').trim().slice(0, 50),
         leaksPrompt: shown.indexOf('【人设】') >= 0,
         domLen: domText.length,
         hasVeil: !!veil,
         veilLen: veil ? veil.textContent.length : 0,
       };
     });
     return JSON.stringify({ probe: window.__DSC_VEIL__ ? window.__DSC_VEIL__() : null, rows });
   })()`,
);
const o = JSON.parse(String(raw));
const rows = o.rows || [];

console.log('[探针] ' + JSON.stringify(o.probe));
console.log('');
for (const [i, r] of rows.entries()) {
  console.log(
    `  第 ${i} 条  可见 ${String(r.shownLen).padStart(4)} 字  藏了 ${String(r.veilLen).padStart(4)} 字  ` +
      `DOM 共 ${r.domLen} 字  ${r.leaksPrompt ? '★可见文字里有【人设】★' : '干净'}  「${r.shownHead}」`,
  );
}
console.log('');

const checks = [];
const 有注入 = rows.filter((r) => r.hasVeil);
checks.push(['页面上确实有被处理过的消息', rows.length > 0, `${rows.length} 条消息，${有注入.length} 条藏了`]);
checks.push([
  '可见文字里一条都不含【人设】',
  rows.every((r) => !r.leaksPrompt),
  rows.filter((r) => r.leaksPrompt).length + ' 条还在露',
]);
checks.push([
  '藏掉的是注入块、不是他的话（藏的字数远大于可见字数）',
  有注入.every((r) => r.veilLen > r.shownLen),
  有注入.map((r) => `${r.veilLen}>${r.shownLen}`).join('  '),
]);
checks.push([
  '隐藏那截用的是 display:none（复制会跳过它）',
  await evalIn(
    main,
    `(() => { const v = document.querySelector('.dsc-veil'); return v ? getComputedStyle(v).display : '（没有 .dsc-veil）'; })()`,
  ).then((d) => d === 'none'),
  String(
    await evalIn(
      main,
      `(() => { const v = document.querySelector('.dsc-veil'); return v ? getComputedStyle(v).display : '（没有）'; })()`,
    ),
  ),
]);
// ★这条是防"切丢了字"的★ 留下的 + 藏起来的，必须正好等于原文（两边都 trim 过，差几个空白）
const probe = o.probe || { rows: [] };
const exact = (probe.rows || []).filter((r) => r.fullLen > 0);
checks.push([
  '一个字都没被吃掉（留下的 + 藏起来的 = 原文）',
  exact.length > 0 && exact.every((r) => r.shownLen + r.hiddenLen <= r.fullLen && r.shownLen + r.hiddenLen >= r.fullLen - 12),
  exact.map((r) => `${r.shownLen}+${r.hiddenLen}=${r.shownLen + r.hiddenLen} vs 原文 ${r.fullLen}`).join('  '),
]);

let bad = 0;
for (const [name, ok, ev] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${ev}`);
}
console.log('');
console.log(bad === 0 ? `★ 全过：${checks.length}/${checks.length} ★` : `${checks.length - bad}/${checks.length} 过`);
process.exit(bad === 0 ? 0 : 1);
