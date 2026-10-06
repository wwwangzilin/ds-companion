/* 用**已经传上去的那张图**验引用格式（不再新增上传 —— 每传一张都留在账号里）。
 *
 * 用法：node .verify/probe-vision-ask.mjs <fileId 或裸 uuid>
 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const RAW_ID = process.argv[2] || 'file-a652a00f-ac53-4e30-822a-008eff626f61';
const MODEL = process.argv[3] || 'default';
const UUID = RAW_ID.replace(/^file-/, '');
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
console.log(`[file] ${RAW_ID}   model_type=${MODEL}`);
console.log('[ask] 引用它，问图上写了什么…');

const raw = await evalIn(
  main,
  `(async () => {
     const util = window.__DSC_DS_UTIL__;
     try {
       const r = await util.ask(
         'see',
         '这张图上写着什么？用一句话原样说出来（不要解释、不要客套）。看不到图就回"没看到图"。',
         { refFileIds: [${JSON.stringify(RAW_ID)}], modelType: ${JSON.stringify(MODEL)} }
       );
       return JSON.stringify({ ok: true, text: (r && r.text) || '', raw: JSON.stringify(r).slice(0, 300) });
     } catch (e) {
       return JSON.stringify({ ok: false, err: String((e && e.message) || e) });
     }
   })()`,
  120000,
);
const o = JSON.parse(raw || '{}');
console.log('[result] ' + JSON.stringify(o).slice(0, 500));
console.log('');
if (!o.ok) {
  console.log('FAIL  ' + o.err);
  process.exit(1);
}
console.log('她看到的是：');
console.log('  ' + String(o.text || '').slice(0, 300));
const sawIt = /Tauri/.test(String(o.text || '')) || /主人/.test(String(o.text || ''));
console.log('');
console.log(sawIt ? '★ PASS  图上的字她真的读出来了 —— 多模态通了 ★' : 'FAIL  还是没读到');
const lastRaw = await evalIn(main, `String(window.__DSC_LAST_RAW__ || '').slice(0, 600)`);
console.log('');
console.log('[上游原始响应] ' + lastRaw);
