/* 手动验证：她到底"看见"他在用什么软件。
 *
 * 【为什么单开一个】这是**唯一**能证明裸 FFI 真的读到东西的办法 —— 编译通过只说明
 * 符号链得上，读不读得到是另一回事（权限、前台窗口是系统窗口、等等）。
 *
 * 用法（先带 DSC_DATA_DIR + 9223 端口起一个实例，并把 config 里的 watchApp 打开）：
 *   node .verify/probe-front.mjs
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
      if (m.error) return reject(new Error(JSON.stringify(m.error)));
      resolve(m.result);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP 连接失败'));
    };
  });
}

async function evalIn(target, expression, timeoutMs) {
  const r = await send(
    target,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r && r.result ? r.result.value : undefined;
}

const list = await (await fetch(`${BASE}/json/list`)).json();
const settings = list.find((x) => x.url && x.url.includes('settings.html'));
const main = list.find((x) => x.url && x.url.includes('deepseek.com'));
if (!settings && !main) throw new Error('找不到任何窗口');

// 主窗口先把设置窗口叫起来（命令只给了设置窗口那份 capability）
if (!settings && main) {
  await evalIn(main, `window.__TAURI_INTERNALS__.invoke('open_settings').then(()=>1).catch(e=>String(e))`);
  await sleep(2500);
}
const target =
  (await (await fetch(`${BASE}/json/list`)).json()).find(
    (x) => x.url && x.url.includes('settings.html'),
  ) || main;

const call = async (expr) => {
  const raw = await evalIn(
    target,
    `(async () => { try { const v = await window.__TAURI_INTERNALS__.invoke(${expr});
        return JSON.stringify({ ok: true, v }); }
      catch (e) { return JSON.stringify({ ok: false, err: String(e) }); } })()`,
  );
  const o = JSON.parse(raw);
  if (!o.ok) throw new Error(`${expr.slice(0, 60)} → ${o.err}`);
  return o.v;
};

console.log('[target] ' + (target.url || '').slice(0, 50));
console.log('');
console.log('=== 她此刻"看见"的 ===');
const first = await call(`'dsc_front_app'`);
console.log(JSON.stringify(first, null, 2));

if (!first.enabled) {
  console.log('');
  console.log('！watchApp 还没打开 —— 改 config.json 里的 watchApp: true 再看一次');
  process.exit(0);
}

// 前台是哪个进程会随"谁在前台"变；这里连续采几次，看它是不是真的跟着动
console.log('');
console.log('=== 连采 3 次（你自己切一下窗口试试）===');
for (let i = 0; i < 3; i++) {
  const got = await call(`'dsc_front_app'`);
  console.log(`  ${i + 1}. exe=${JSON.stringify(got.exe)} kind=${got.kind} busy=${got.busy} → ${got.text}`);
  await sleep(1500);
}
