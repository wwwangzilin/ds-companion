/* 诊断：已经传上去的那张图，后端到底认成什么样了（不重传，只查）。
 *
 * 用法：node .verify/probe-vision-why.mjs [fileId]
 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const FILE_ID = process.argv[2] || 'file-c525897e-462c-40c5-af36-200b78be8359';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 40000) {
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

async function evalIn(target, expression, timeoutMs = 40000) {
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
console.log(`[file] ${FILE_ID}`);

const files = await evalIn(
  main,
  `(async () => {
     const util = window.__DSC_DS_UTIL__;
     try {
       const r = await util.fetchFiles(${JSON.stringify([FILE_ID])});
       return JSON.stringify(r);
     } catch (e) {
       return JSON.stringify({ error: String((e && e.message) || e) });
     }
   })()`,
  60000,
);
console.log('');
console.log('=== fetch_files ===');
console.log(files);

const raw = await evalIn(
  main,
  `String(window.__DSC_LAST_RAW__ || '(没有留档)').slice(0, 2000)`,
);
console.log('');
console.log('=== 上游原始响应（最近一次）===');
console.log(raw);
