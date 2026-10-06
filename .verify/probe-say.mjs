/* 探针：桌宠**此刻嘴里那句话**是哪来的 —— 她看到了什么、被挑中的是哪一行。
 *
 * 【为什么需要它】"她老说同一句"这种事，光看桌宠是查不出来的：气泡只显示最终那句，
 * 看不出它是从 `重点` 还是从 `在做什么` 挑的。而 `screen::Snapshot`（`see` / `say` /
 * `see_for`）只活在内存里、不落盘，只有 `dsc_screen_state` 这一条命令能读到它。
 *
 * 【为什么绕一道设置窗口】那条命令只开给本地设置窗口（capabilities/settings.json），
 * 注入页没有这个权限 —— 所以先让注入页把设置窗口叫起来，再在那边问。
 *
 * 【只读】不改配置、不触发截图、不写文件。
 *
 * 用法：$env:DSC_CDP='http://127.0.0.1:9223'; node .verify/probe-say.mjs
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

async function listTargets() {
  try {
    return await (await fetch(`${BASE}/json/list`)).json();
  } catch {
    return [];
  }
}

async function findTarget(match, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = (await listTargets()).find((x) => x.url && x.url.includes(match));
    if (t) return t;
    if (Date.now() > deadline) throw new Error('等不到 ' + match);
    await sleep(300);
  }
}

// 用 __TAURI_INTERNALS__（注入页没有 __TAURI__，见 inject.js 的 invoke 包装）
const INVOKE = `
  const inv = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
`;

console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com');

// 设置窗口可能已经开着（上一轮验收留下的），先看看
let settings = (await listTargets()).find((x) => x.url && x.url.includes('settings'));
if (!settings) {
  console.log('[开窗] 叫一下设置窗口…');
  await evalIn(
    main,
    `(async () => { ${INVOKE} await inv('open_settings'); return true; })()`,
  ).catch((e) => console.log('[开窗] 失败：' + e.message));
  settings = await findTarget('settings', 25000);
}

const raw = await evalIn(
  settings,
  `(async () => {
     ${INVOKE}
     const snap = await inv('dsc_screen_state');
     const pet = await inv('dsc_pet_state', { have: null });
     return JSON.stringify({ snap, pet });
   })()`,
);
const o = JSON.parse(String(raw));
const s = o.snap || {};
const pet = o.pet || {};

const ago = (t) => {
  if (!t) return '（没有）';
  const d = Number(pet.now || Date.now()) - Number(t);
  return d < 0 ? '刚刚' : Math.round(d / 1000) + ' 秒前';
};

console.log('');
console.log('── 桌宠此刻显示 ──────────────────────────────');
console.log('  气泡(activity) = ' + JSON.stringify(pet.activity || ''));
console.log('  那句话(say)    = ' + JSON.stringify(pet.say || ''));
console.log('  那句话说的时刻 = ' + ago(pet.sayAt));
console.log('  表情           = ' + pet.variant + ' / 实际用 ' + pet.actual + '（' + pet.source + '）');

console.log('');
console.log('── 她最近一眼看到了什么 ──────────────────────');
console.log('  see_at   = ' + ago(s.seeAt));
console.log('  see_size = ' + (s.seeSize || '（没有）'));
console.log('  see（她亲眼看到的原文）:');
console.log(
  String(s.see || '（空）')
    .split('\n')
    .map((l) => '      ' + l)
    .join('\n'),
);
console.log('');
console.log('  本地 OCR 那一版（text, ' + (s.chars || 0) + ' 字, ' + (s.ms || 0) + 'ms）:');
console.log(
  String(s.text || '（空）')
    .split('\n')
    .slice(0, 6)
    .map((l) => '      ' + l)
    .join('\n'),
);
console.log('');
console.log('  这一屏和 see 对不对得上（seeFor == text ？）: ' + (s.seeFor === s.text));
console.log('  上一次没看的原因: ' + (s.skipped || '（没有跳过）'));
