/* 探针：注入块在**真实消息 DOM** 里落在哪一段 —— 藏它之前必须先看清边界。
 *
 * 【为什么不能靠 MARK_TAIL 切】注入块的顺序是
 *     工作模式 → 人设(开头是 MARK_HEAD、结尾是 MARK_TAIL) → 工具 → 状态 → 回锚 → 回忆
 *     → 场景 → 关系 → …
 * 也就是说 MARK_TAIL 在**中间**，它后面还有一大串块 —— 拿它当"注入块到此为止"会漏掉一半。
 * 而"主人自己那句话"在旧消息里排在整段注入**之后**、在新消息里排在**之前**，两个方向都有。
 *
 * 【所以这个探针要回答三件事】
 *   ① 每条带注入的消息里，MARK_HEAD（`【人设】`）落在第几个字符 —— 0 说明注入块在最前面
 *      （旧消息），大于 0 说明前面是主人自己的话（换序之后的新消息）。
 *   ② MARK_HEAD 之前那截是什么（那就是主人自己的话）。
 *   ③ 块的头部（`【…】`）在整段里都出现在哪些位置 —— 用来判断"能不能靠一组头部认出整段注入"。
 *
 * 只读，不改任何东西。
 *
 * 用法：$env:DSC_CDP='http://127.0.0.1:9223'; node .verify/probe-inject-dom.mjs
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

// 【为什么要先开一条会话】刚启动时页面停在首页（`https://chat.deepseek.com/`），
// 一条消息都没有 —— 那探针只会回 "0 个消息格"，什么也说明不了。
// 挑**真人会话**（跳过带 `.dsc-sys-session` 的，那些是我们自己开的），只做导航，不动内容。
const nav = await evalIn(
  main,
  `(() => {
     const links = Array.from(document.querySelectorAll('a[href*="/a/chat/s/"]'))
       .filter((a) => !a.classList.contains('dsc-sys-session'));
     const withText = links.filter((a) => (a.innerText || '').trim().length > 0);
     const pick = withText[0] || links[0];
     if (!pick) return JSON.stringify({ err: '侧栏里找不到能开的会话' });
     const href = pick.getAttribute('href');
     location.assign(href);
     return JSON.stringify({ going: href, title: (pick.innerText || '').trim().slice(0, 40) });
   })()`,
);
const n = JSON.parse(String(nav));
if (n.err) {
  console.log('[开会话] ' + n.err);
} else {
  console.log('[开会话] ' + n.title + '  →  ' + n.going);
}

// 等消息渲染出来（导航之后 CDP 目标还是同一个，等 DOM 就行）
for (let i = 0; i < 40; i++) {
  const c = await evalIn(main, `document.querySelectorAll('.ds-collapsible-text').length`).catch(() => 0);
  if (Number(c) > 0) break;
  await sleep(500);
}
await sleep(1500);

const raw = await evalIn(
  main,
  `(() => {
     const HEAD = '【人设】';
     const out = { url: location.href.slice(0, 100), total: 0, withInject: 0, rows: [] };

     // 正文都在 .ds-collapsible-text 里（实测：一个 span 的纯文本，注入块与人话之间没有元素边界）
     const cells = document.querySelectorAll('.ds-collapsible-text');
     out.total = cells.length;

     cells.forEach((el, i) => {
       const t = el.innerText || '';
       const at = t.indexOf(HEAD);
       if (at < 0) return;
       out.withInject++;

       // 这一整条消息的文本（往上找几层，拿"整条"而不只是折叠区）
       let box = el;
       for (let k = 0; k < 5 && box.parentElement; k++) box = box.parentElement;
       const full = box.innerText || '';

       // 整段里所有 \`【…】\` 头部的位置（最多 20 个）—— 看能不能靠它们认出注入段
       const heads = [];
       const re = /【[^】\\n]{1,10}】/g;
       let m;
       while ((m = re.exec(full)) && heads.length < 20) heads.push({ at: m.index, s: m[0] });

       out.rows.push({
         i,
         cellLen: t.length,
         fullLen: full.length,
         headAtInCell: at,
         headAtInFull: full.indexOf(HEAD),
         before: full.slice(0, Math.max(0, full.indexOf(HEAD))).slice(-120),
         afterHead: full.slice(full.indexOf(HEAD), full.indexOf(HEAD) + 90).replace(/\\n/g, ' / '),
         heads: heads.map((h) => h.at + ':' + h.s),
       });
     });

     // 折叠态：上游给 .ds-collapsible-text 挂了 max-height 就说明这条是折起来的
     out.folded = [];
     cells.forEach((el) => {
       const s = el.getAttribute('style') || '';
       if (s.indexOf('max-height') >= 0) out.folded.push(el.style.maxHeight);
     });
     return JSON.stringify(out);
   })()`,
);

const o = JSON.parse(String(raw));
console.log('[页面] ' + o.url);
console.log('[消息格] ' + o.total + ' 个，其中带注入块的 ' + o.withInject + ' 条');
console.log('[折叠] max-height 值：' + (o.folded.length ? o.folded.join(', ') : '（一条都没折）'));
console.log('');

for (const r of o.rows.slice(-8)) {
  console.log('── 第 ' + r.i + ' 格  正文 ' + r.fullLen + ' 字 ──');
  console.log('   【人设】在整段的第 ' + r.headAtInFull + ' 个字符' +
    (r.headAtInFull === 0 ? '  ← 注入块在最前面（旧消息）' : '  ← 前面是主人自己的话（新消息）'));
  console.log('   它前面那截：' + JSON.stringify(r.before));
  console.log('   从头部开始：' + JSON.stringify(r.afterHead));
  console.log('   整段里的块头：' + r.heads.join('  '));
  console.log('');
}
