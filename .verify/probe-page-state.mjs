/* 只读：看页面里注入脚本到底装上了没有（排查"没加载"这类问题第一步）。
 *
 * 用法：node .verify/probe-page-state.mjs
 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 20000) {
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

async function evalIn(target, expression, timeoutMs = 20000) {
  const r = await send(
    target,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
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
const out = await evalIn(
  main,
  `JSON.stringify({
     url: location.href.slice(0, 70),
     readyState: document.readyState,
     injected: typeof window.__DSC_INJECTED__,
     again: window.__DSC_INJECTED_AGAIN__ || 0,
     util: typeof window.__DSC_DS_UTIL__,
     utilKeys: window.__DSC_DS_UTIL__ ? Object.keys(window.__DSC_DS_UTIL__).join(',') : null,
     vision: typeof window.__DSC_VISION_TRY__,
     reportTurn: typeof window.__DSC_REPORT_TURN__,
     avatar: typeof window.__DSC_AVATAR__,
     lastRaw: typeof window.__DSC_LAST_RAW__
   })`,
);
console.log(out);
