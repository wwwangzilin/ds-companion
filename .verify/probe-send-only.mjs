/* 只做「点发送」这一步 —— 图还挂在输入框里，不重新上传（每传一张都留在账号里）。
 *
 * 【为什么要单独一步】上一轮 hook 装好了、图也传上去了，只有发送键没找着：
 * 按 className / aria-label 猜是猜不中的（110 个候选中没一个匹配）。
 * 这次换个笨办法：把所有可见按钮按位置列出来（发送键就在输入框右边、页面偏下），
 * 顺便把特征打出来 —— 就算还是没点中，也能一眼看出它长什么样。
 *
 * 用法：node .verify/probe-send-only.mjs
 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 120000) {
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

async function evalIn(target, expression, timeoutMs = 120000) {
  const r = await send(
    target,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r && r.result ? r.result.value : undefined;
}

async function findTarget(match, timeoutMs = 45000) {
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

// hook 还在不在？（页面没刷新就还在）
const hooked = await evalIn(main, `Array.isArray(window.__DSC_REQ_LOG__)`);
console.log('[hook] ' + (hooked ? '还在（页面没刷新）' : '没了 —— 得重跑 probe-real-upload'));
if (!hooked) process.exit(1);

// 输入框里还有没有东西
const state = await evalIn(
  main,
  `(function(){
     var ta = document.querySelector('textarea');
     var attach = document.querySelectorAll('[class*=file], [class*=attach], img[src^="blob:"], img[src^="data:"]');
     return JSON.stringify({
       text: ta ? ta.value.slice(0, 40) : null,
       attachNodes: attach.length
     });
   })()`,
);
console.log('[input] ' + state);

// 列出可见按钮（按 y 从下往上），并挑最靠右下那个点掉
const clicked = await evalIn(
  main,
  `(function(){
     var all = Array.prototype.slice.call(document.querySelectorAll('button, [role=button], [class*=send]'));
     var vis = all.map(function (b) {
       var r = b.getBoundingClientRect();
       return { b: b, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
     }).filter(function (o) { return o.w >= 8 && o.h >= 8; });
     vis.sort(function (a, b) { return (b.y + b.x / 10) - (a.y + a.x / 10); });
     var top = vis.slice(0, 8).map(function (o) {
       return o.x + ',' + o.y + ' ' + o.w + 'x' + o.h +
         ' cls=' + String(o.b.className).slice(0, 50) +
         ' aria=' + (o.b.getAttribute('aria-label') || '-') +
         ' dis=' + !!o.b.disabled;
     });
     var pick = null;
     // 优先找 aria-label 明确是"发送"的；找不到就取最靠右下的那个
     for (var i = 0; i < vis.length; i++) {
       var a = (vis[i].b.getAttribute('aria-label') || '') + ' ' + String(vis[i].b.className);
       if (/send|发送/i.test(a)) { pick = vis[i]; break; }
     }
     var how = 'aria';
     if (!pick && vis.length) { pick = vis[0]; how = 'bottom-right'; }
     if (!pick) return JSON.stringify({ ok: false, tried: all.length });
     pick.b.click();
     return JSON.stringify({ ok: true, how: how, top: top, clicked: pick.x + ',' + pick.y });
   })()`,
);
console.log('[send] ' + clicked);

// 等 completion
let body = null;
for (let i = 0; i < 40; i++) {
  await sleep(700);
  const hit = await evalIn(
    main,
    `(function(){
       var L = window.__DSC_REQ_LOG__ || [];
       for (var i = L.length - 1; i >= 0; i--) {
         if (/chat\\/completion/.test(L[i].url)) return JSON.stringify(L[i]);
       }
       return null;
     })()`,
  );
  if (hit) {
    body = JSON.parse(hit);
    break;
  }
}
console.log('');
console.log('=== ★ 真实 completion 的 body ★ ===');
console.log(body ? body.body : '（还是没抓到）');

// 顺带把回复文本也读出来（证明这条消息真的发出去了、模型真的看到了图）
if (body) {
  await sleep(6000);
  const reply = await evalIn(
    main,
    `(function(){
       var nodes = document.querySelectorAll('[class*=markdown], [class*=message]');
       var last = nodes.length ? nodes[nodes.length - 1] : null;
       return last ? String(last.textContent).slice(0, 300) : '(没找到回复节点)';
     })()`,
  );
  console.log('');
  console.log('=== 她的回复（最后一条消息）===');
  console.log(reply);
}
