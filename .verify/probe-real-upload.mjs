/* 抓一次「真实的上传 + 引用」请求 —— 用模拟粘贴的方式走一遍上游自己的流程。
 *
 * 【为什么必须这么干】我们照着自己拼的请求，格式对、模型对，业务层还是回
 * `biz_code 9 invalid ref file id`。再猜下去就是浪费额度了 —— 直接让**上游自己的代码**
 * 走一遍，把它发出去的请求抄下来。
 *
 * 做法：
 *   ① 先在页面里 hook fetch / XHR（必须赶在上传之前装好）
 *   ② 造一张小图，塞进页面的 file input 并派发 change（这是上游真正接文件的口子）
 *   ③ 往输入框填一句话，点发送
 *   ④ 把抓到的请求打出来 —— 重点是 completion 的 body 长什么样
 *
 * ⚠ 会真的在主人账号里发一条带图的消息（他选了这条路）。所以 prompt 写明了是测试。
 *
 * 用法：node .verify/probe-real-upload.mjs
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

async function evalIn(target, expression, timeoutMs = 60000) {
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

// ── ① 装 hook（赶在上传之前）──────────────────────────────────────────
await evalIn(
  main,
  `(function(){
     if (window.__DSC_REQ_LOG__) return 'already';
     var LOG = [];
     window.__DSC_REQ_LOG__ = LOG;
     function brief(body) {
       try {
         if (body == null) return null;
         if (typeof body === 'string') return body.length > 4000 ? body.slice(0, 4000) + '…(' + body.length + ')' : body;
         if (body instanceof FormData) {
           var out = [];
           body.forEach(function (v, k) {
             out.push(k + '=' + (v && v.name ? 'File(' + v.name + ',' + v.size + 'B,' + v.type + ')' : String(v)));
           });
           return 'FormData{' + out.join('; ') + '}';
         }
         if (body instanceof Blob) return 'Blob(' + body.size + 'B,' + body.type + ')';
         return String(body).slice(0, 500);
       } catch (e) { return 'unreadable:' + e; }
     }
     var of = window.fetch;
     window.fetch = function (input, init) {
       try {
         var url = typeof input === 'string' ? input : (input && input.url) || '';
         LOG.push({ via: 'fetch', url: String(url).slice(0, 200), method: (init && init.method) || 'GET', body: brief(init && init.body), at: Date.now() });
       } catch (e) {}
       return of.apply(this, arguments);
     };
     var XO = XMLHttpRequest.prototype.open;
     XMLHttpRequest.prototype.open = function (m, u) {
       try { this.__dscU = u; this.__dscM = m; } catch (e) {}
       return XO.apply(this, arguments);
     };
     var XS = XMLHttpRequest.prototype.send;
     XMLHttpRequest.prototype.send = function (b) {
       try {
         LOG.push({ via: 'xhr', url: String(this.__dscU || '').slice(0, 200), method: this.__dscM || 'GET', body: brief(b), at: Date.now() });
       } catch (e) {}
       return XS.apply(this, arguments);
     };
     return 'hooked';
   })()`,
);
console.log('[hook] 装好了');

// ── ② 造图 + 塞进 file input ──────────────────────────────────────────
const setup = await evalIn(
  main,
  `(async function(){
     function probeCanvas() {
       var c = document.createElement('canvas');
       c.width = 360; c.height = 140;
       var g = c.getContext('2d');
       g.fillStyle = '#101018'; g.fillRect(0, 0, c.width, c.height);
       g.fillStyle = '#eae6ff'; g.font = '30px sans-serif';
       g.fillText('主人正在看 Tauri 文档', 16, 60);
       g.fillStyle = '#a78bfa'; g.font = '20px sans-serif';
       g.fillText('real-upload probe', 16, 106);
       return new Promise(function (r) { c.toBlob(r, 'image/png'); });
     }
     var blob = await probeCanvas();
     var file = new File([blob], 'dsc-real-probe.png', { type: 'image/png' });
     var inputs = Array.prototype.slice.call(document.querySelectorAll('input[type=file]'));
     if (!inputs.length) return JSON.stringify({ ok: false, why: '页面上找不到 input[type=file]' });
     var input = inputs[0];
     var dt = new DataTransfer();
     dt.items.add(file);
     input.files = dt.files;
     input.dispatchEvent(new Event('change', { bubbles: true }));
     return JSON.stringify({ ok: true, inputs: inputs.length, size: blob.size });
   })()`,
  60000,
);
console.log('[file] ' + setup);
const s = JSON.parse(setup || '{}');
if (!s.ok) {
  console.log('FAIL  ' + s.why);
  process.exit(1);
}

// 等上传跑完（看日志里出现 upload_file）
let uploaded = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const n = await evalIn(
    main,
    `(window.__DSC_REQ_LOG__ || []).filter(r => /upload_file|file\\//.test(r.url)).length`,
  );
  if (Number(n) > 0) {
    uploaded = true;
    break;
  }
}
console.log('[upload] ' + (uploaded ? '抓到了上传请求' : '没看到上传请求（可能它走了别的口子）'));

// ── ③ 填字 + 点发送 ───────────────────────────────────────────────────
await sleep(2500); // 等文件解析
const typed = await evalIn(
  main,
  `(function(){
     var ta = document.querySelector('textarea');
     if (!ta) return JSON.stringify({ ok: false, why: '没有 textarea' });
     var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
     setter.call(ta, '（这是 ds-companion 的多模态通道探针，抓到请求后我自己会删掉这条）');
     ta.dispatchEvent(new Event('input', { bubbles: true }));
     return JSON.stringify({ ok: true, value: ta.value.slice(0, 30) });
   })()`,
);
console.log('[type] ' + typed);

const clicked = await evalIn(
  main,
  `(function(){
     var cands = Array.prototype.slice.call(document.querySelectorAll('button, [role=button], div[class*=send]'));
     var vis = cands.filter(function (b) {
       var r = b.getBoundingClientRect();
       if (r.width < 12 || r.height < 12) return false;
       var hay = (b.getAttribute('aria-label') || '') + ' ' + (b.className || '') + ' ' + (b.textContent || '');
       return /发送|send/i.test(hay);
     });
     if (!vis.length) return JSON.stringify({ ok: false, why: '找不到发送按钮', tried: cands.length });
     var b = vis[vis.length - 1];
     b.click();
     return JSON.stringify({ ok: true, cls: String(b.className).slice(0, 60) });
   })()`,
);
console.log('[send] ' + clicked);

// ── ④ 等 completion 请求，把 body 抓出来 ──────────────────────────────
let completionBody = null;
for (let i = 0; i < 30; i++) {
  await sleep(600);
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
    completionBody = JSON.parse(hit);
    break;
  }
}
console.log('');
console.log('=== ★ 真实 completion 请求的 body ★ ===');
console.log(completionBody ? completionBody.body : '（没抓到 —— 可能它没走 fetch/xhr，或者发送没生效）');

console.log('');
console.log('=== 抓到的全部请求 ===');
const all = await evalIn(
  main,
  `JSON.stringify((window.__DSC_REQ_LOG__ || []).map(function (r) {
     return r.via + ' ' + r.method + ' ' + r.url + '  body=' + (r.body ? String(r.body).slice(0, 220) : '-');
   }))`,
);
JSON.parse(all || '[]').forEach((l) => console.log('  ' + l));
