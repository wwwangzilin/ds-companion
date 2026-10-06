/* 验收：桌宠那口状态有多慢 —— 以及"立绘没变时不该重算 dataUrl"。
 *
 * 【为什么要专门量它】`dsc_pet_state` 是**同步命令**（跑在主线程），而它每次都无条件
 * 调 `avatar_view()` → 把内置立绘（~2 MB PNG）base64 成 ~2.7 MB 的字符串，
 * 然后再看 `have` 是否匹配、匹配就把这串**丢掉**。桌宠每 60 秒自己拉一次，
 * 壳里 19 处 `push_config` 又各会 ping 一次 —— 每一次都是白算。
 *
 * 【为什么手感会受影响】debug 构建下这种逐字节循环慢几十倍，主线程被占住的这几百毫秒
 * 就是"桌宠反应有点迟钝"的来源（同一个进程里的窗口一起卡）。
 *
 * 【不变量】`have` 与 `key` 相同时，返回的 `dataUrl` 必须是**空串**；而且这条路径
 * 必须显著快于"真的要图"那条。只断言 dataUrl 为空是不够的 —— 算完再丢也满足它。
 *
 * 用法：$env:DSC_CDP='http://127.0.0.1:9223'; node .verify/verify-pet-latency.mjs
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
const pet = await findTarget('pet.html');

const raw = await evalIn(
  pet,
  `(async () => {
     const inv =
       (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
       (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
     if (!inv) return JSON.stringify({ err: '这个窗口里找不到 Tauri IPC' });

     const once = async (args) => {
       const t0 = performance.now();
       const r = await inv('dsc_pet_state', args);
       return {
         ms: Math.round((performance.now() - t0) * 10) / 10,
         urlLen: r && r.dataUrl ? r.dataUrl.length : 0,
         key: r && r.key,
         variant: r && r.variant,
       };
     };

     // 预热：第一次会把命令注册/序列化那套的固定开销算进来，不能算在稳态里
     const warm = await once({ have: null });
     const key = warm.key;

     const same = [];   // have 命中 → 理论上不该造 dataUrl
     for (let i = 0; i < 12; i++) same.push(await once({ have: key }));
     const full = [];   // have 不命中 → 真要那张图
     for (let i = 0; i < 5; i++) full.push(await once({ have: null }));
     return JSON.stringify({ warm, key, same, full });
   })()`,
);

const o = JSON.parse(String(raw));
if (o.err) {
  console.log('FAIL  ' + o.err);
  process.exit(1);
}

const stat = (arr) => {
  const ms = arr.map((x) => x.ms).sort((a, b) => a - b);
  const mid = ms[Math.floor(ms.length / 2)];
  const p95 = ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))];
  return { mid, p95, max: ms[ms.length - 1] };
};
const s = stat(o.same);
const f = stat(o.full);

console.log(`[状态] key=${o.key} variant=${o.variant}`);
console.log(
  `[命中 have] 中位 ${s.mid}ms  p95 ${s.p95}ms  最慢 ${s.max}ms  返回 dataUrl 长度 ${o.same[0].urlLen}`,
);
console.log(
  `[不命中]   中位 ${f.mid}ms  p95 ${f.p95}ms  最慢 ${f.max}ms  返回 dataUrl 长度 ${o.full[0].urlLen}`,
);
console.log('');

const checks = [];
checks.push([
  '命中 have 时不返回 dataUrl',
  o.same.every((x) => x.urlLen === 0),
  `长度 ${Array.from(new Set(o.same.map((x) => x.urlLen))).join('/')}`,
]);
checks.push([
  '不命中时确实把图给了',
  o.full.every((x) => x.urlLen > 100000),
  `长度 ${Array.from(new Set(o.full.map((x) => x.urlLen))).join('/')}`,
]);
// 【这条才是核心】算完再丢也会让 dataUrl 为空 —— 所以必须比"没算"慢得多才算过
checks.push([
  '命中那条路真的省掉了编码（不能算完再丢）',
  s.mid * 3 < f.mid,
  `命中 ${s.mid}ms vs 不命中 ${f.mid}ms（要 < 1/3）`,
]);
checks.push([
  '命中那条路本身够快（< 50ms，不然就是主线程卡顿来源）',
  s.mid < 50,
  `${s.mid}ms`,
]);

let bad = 0;
for (const [name, ok, ev] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${ev}`);
}
console.log('');
console.log(bad === 0 ? `★ 全过：${checks.length}/${checks.length} ★` : `${checks.length - bad}/${checks.length} 过`);
process.exit(bad === 0 ? 0 : 1);
