/* 验收：换了人设时那条提醒。
 *
 * 【为什么要验"不该提醒时闭嘴"】假阳性比漏报烦人得多 —— 每换一次人设都弹一句、
 * 哪怕这条会话干干净净，主人很快就学会无视它了，那这条提醒就等于没做。
 * 所以四条断言：该响、响了内容对不对、同一人设重复推不响、首页（没有会话）不响。
 *
 * 【怎么造"换人设"】页面本来就是靠 `__DSC_SET_CONFIG__` 接收配置推送的，脚本直接推
 * 两次不同的 personaId 即可 —— 走的是和设置窗口一模一样的那条路，不是特制的测试口。
 * 每次推都用当前 CFG 做底再改 personaId，免得把别的字段推空影响页面状态。
 *
 * 用真实数据跑（要的就是真实会话里真实存在的角色）：
 *   $env:DSC_ALLOW_REAL_DATA='1'; $env:DSC_CDP='http://127.0.0.1:9223'; node .verify/verify-persona-switch.mjs
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

/** 推一次配置：拿当前 CFG 做底，只换 personaId / personaName */
const PUSH = (id, name) => `(() => {
  const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  const base = (typeof window.__DSC_CFG__ === 'function' && window.__DSC_CFG__()) || {};
  const next = Object.assign({}, base, { personaId: ${JSON.stringify(id)}, personaName: ${JSON.stringify(name)} });
  if (typeof window.__DSC_SET_CONFIG__ !== 'function') return 'no-hook';
  window.__DSC_SET_CONFIG__(next);
  return 'ok';
})()`;

const noticeText = `(window.__DSC_NOTICE_TEXT__ ? window.__DSC_NOTICE_TEXT__() : '（没有探针）')`;

console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com');

// ── ① 挑一条"有主"的真实会话 ────────────────────────────────────────────
// 【为什么按名字挑、不按 characterId】留档的 Markdown 头以前只写角色**显示名**，
// id 是后加进格式的（老记录一律没有）。这条提醒按名字判，所以验收也按名字挑。
const pick = await evalIn(
  main,
  `(async () => {
     const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
     if (!inv) return JSON.stringify({ err: '拿不到 IPC' });
     const rows = await inv('chat_recent', { limit: 60 });
     const mine = (rows || []).filter((r) => r && r.session && r.character);
     if (!mine.length) return JSON.stringify({ err: '留档里没有带角色的轮次' });
     const last = mine[mine.length - 1];
     // 会话 id 在留档里只有前 12 位、还带省略号 —— 剥掉才是能拼进 URL 的那种
     const sid = String(last.session).replace(/…/g, '').trim();
     return JSON.stringify({ sid, name: String(last.character || '') });
   })()`,
);
const target = JSON.parse(String(pick));
if (target.err) {
  console.log('[跳过] ' + target.err);
  process.exit(1);
}
console.log(`[目标会话] ${target.sid}  说话的是「${target.name}」`);

// 换一个**不同**的角色名来触发提醒
const otherId = target.name === '露娜模式' ? 'dsh-deepseek' : 'dsh-luna';
const otherName = otherId === 'dsh-luna' ? '露娜模式' : 'DeepSeek 娘';

// ── ② 进那条会话 ────────────────────────────────────────────────────────
await evalIn(main, `location.assign('/a/chat/s/${target.sid}'); true`);
for (let i = 0; i < 40; i++) {
  const u = await evalIn(main, `location.pathname`).catch(() => '');
  if (String(u).includes(target.sid)) break;
  await sleep(500);
}
await sleep(2500);

const checks = [];

// ── ③ 同一人设重复推：不该响 ────────────────────────────────────────────
// 用一个假的基准 id 打底：这样"没换"和"换了"两个方向都能干净地测，
// 不必去猜壳当前激活的到底是哪一个。
const BASE_ID = 'dsc-verify-baseline';
await evalIn(main, PUSH(BASE_ID, target.name));
await sleep(400);
await evalIn(main, PUSH(BASE_ID, target.name));
await sleep(1200);
const same = String(await evalIn(main, noticeText));
checks.push(['同一个人设重复推 → 不响（别自己吓自己）', same === '', same || '（空）']);

// ── ④ 真的换了：该响，而且要点名是谁 ────────────────────────────────────
const r1 = String(await evalIn(main, PUSH(otherId, otherName)));
await sleep(1500);
const text = String(await evalIn(main, noticeText));
console.log('[提醒文案] ' + JSON.stringify(text));
checks.push(['推送钩子还在（没把页面搞坏）', r1 === 'ok', r1]);
checks.push(['换了人设 → 响了', text.length > 0, text ? '响了' : '没响']);
checks.push([
  '文案里点名了**上一位**是谁',
  text.includes(target.name || '\u0000'),
  text.includes(target.name) ? '有' : `没有「${target.name}」`,
]);
checks.push(['文案里给了出口（开新会话）', text.includes('新会话'), text.includes('新会话') ? '有' : '没有']);

// ── ⑤ 首页（没有会话）不响 ──────────────────────────────────────────────
await evalIn(main, `location.assign('/'); true`);
await sleep(3500);
const el = await evalIn(main, `!!document.getElementById('dsc-notice')`).catch(() => true);
if (el) await evalIn(main, `(() => { const n = document.getElementById('dsc-notice'); if (n) n.remove(); return true; })()`);
await evalIn(main, PUSH(BASE_ID, target.name));
await sleep(400);
await evalIn(main, PUSH(otherId, otherName));
await sleep(1500);
const home = String(await evalIn(main, noticeText));
checks.push(['首页（没会话）换人设 → 不响', home === '', home || '（空）']);

let bad = 0;
console.log('');
for (const [name, ok, ev] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${ev}`);
}
console.log('');
console.log(bad === 0 ? `★ 全过：${checks.length}/${checks.length} ★` : `${checks.length - bad}/${checks.length} 过`);
process.exit(bad === 0 ? 0 : 1);
