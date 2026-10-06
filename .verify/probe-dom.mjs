/* 探 DOM（第三版）：注入块在 `ds-collapsible-text` 里到底是怎么分的。
 *
 * 【为什么必须看清这一层】上游自己有个 `ds-collapsible-text`（长消息折叠成前几行）。
 * 我们的注入块排在消息最前面 —— 所以它一折叠，露出来的就是【人设】【状态】那些块，
 * 而不是主人真正说的话。要修就得知道：注入块和用户的话是**同一个文本节点**，
 * 还是分成了多个子元素（能单独隐藏）。
 *
 * 用法：$env:DSC_CDP='http://127.0.0.1:9223'; node .verify/probe-dom.mjs
 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 60000) {
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

const main = await findTarget('deepseek.com');
console.log('[cdp] ' + BASE);

const raw = await evalIn(
  main,
  `(() => {
     const el = document.querySelector('.ds-collapsible-text');
     if (!el) return JSON.stringify({ err: '页面上没有 .ds-collapsible-text' });
     const out = {};

     // 这个元素本身的形态
     out.self = {
       tag: el.tagName.toLowerCase(),
       cls: String(el.className || ''),
       style: String(el.getAttribute('style') || '').slice(0, 200),
       textLen: (el.innerText || '').length,
       childCount: el.children.length,
     };

     // 它的直接子节点（元素 + 文本）逐个列出来 —— 注入块是不是独立元素就看这个
     out.kids = [];
     Array.from(el.childNodes).slice(0, 20).forEach((n) => {
       if (n.nodeType === 3) {
         out.kids.push({ t: '#text', text: String(n.nodeValue || '').trim().slice(0, 70) });
       } else {
         const c = String(n.className || '');
         out.kids.push({
           t: n.tagName.toLowerCase() + (c ? '.' + c.split(/\\s+/).join('.') : ''),
           text: (n.innerText || '').replace(/\\n/g, ' ⏎ ').trim().slice(0, 90),
         });
       }
     });

     // 往上找"整条消息"的容器，看它有哪些可用的把手
     let box = el;
     for (let i = 0; i < 6 && box.parentElement; i++) box = box.parentElement;
     out.msgCls = String(box.className || '').slice(0, 120);
     out.msgTextLen = (box.innerText || '').length;

     // 上游折叠用的 class 还有哪些（找同族）
     const fam = new Set();
     document.querySelectorAll('[class*="collaps"]').forEach((x) => {
       String(x.className || '').split(/\\s+/).forEach((c) => { if (c) fam.add(c); });
     });
     out.collapsClasses = Array.from(fam).slice(0, 12);

     // 折叠按钮长什么样
     const btns = [];
     document.querySelectorAll('button, [role="button"], div, span').forEach((x) => {
       const t = (x.innerText || '').trim();
       if (t === '展开' || t === '收起' || t === '展开全部') {
         btns.push({ tag: x.tagName.toLowerCase(), cls: String(x.className || '').slice(0, 60), text: t });
       }
     });
     out.foldButtons = btns.slice(0, 6);
     return JSON.stringify(out);
   })()`,
);
const o = JSON.parse(String(raw));
console.log(JSON.stringify(o, null, 1));

// ── 侧栏实况 ───────────────────────────────────────────────────────────────
// 【为什么要单看一段】折叠侧栏靠 `a[href*="/a/chat/s/"]` + localStorage 里的
// `dsc-*-session`。上一版探针在页面开了很久之后数到 100 条链接，但刚启动时可能是 0 ——
// 「认出了 6 个 id 却一条都没藏住」必须在这里分清是**链接还没渲染**还是**选择器不对**。
console.log('');
console.log('[侧栏]');
const side = await evalIn(
  main,
  `(() => {
     const out = {};
     out.url = location.href.slice(0, 120);
     out.sel = document.querySelectorAll('a[href*="/a/chat/s/"]').length;
     out.allA = document.querySelectorAll('a').length;
     const sample = [];
     document.querySelectorAll('a').forEach((a) => {
       if (sample.length >= 8) return;
       sample.push(String(a.getAttribute('href') || '').slice(0, 60));
     });
     out.sampleHrefs = sample;
     out.style = !!document.getElementById('dsc-sys-style');
     out.bar = !!document.getElementById('dsc-sys-bar');
     const keys = [];
     try {
       for (let i = 0; i < localStorage.length; i++) {
         const k = localStorage.key(i);
         if (k && k.indexOf('dsc-') === 0) keys.push(k + '=' + String(localStorage.getItem(k) || '').slice(0, 45));
       }
     } catch (e) {}
     out.dscKeys = keys;
     return JSON.stringify(out);
   })()`,
);
console.log(JSON.stringify(JSON.parse(String(side)), null, 1));
