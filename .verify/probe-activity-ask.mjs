/* 手动验证：**真发一次**隐藏链，看模型写的那条活动长什么样。
 *
 * 【为什么不进验收脚本】它真的花一次网页额度，而且结果取决于模型当时的发挥 ——
 * 拿这个当断言就是"间歇性假红"。验收脚本那边只验**机制**（三道闸、prompt 内容、
 * 清洗函数），真链路靠这个脚本手动跑。
 *
 * 用法（先带 DSC_DATA_DIR + 9223 端口起一个实例）：
 *   node .verify/probe-activity-ask.mjs
 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 30000) {
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
const main = list.find((x) => x.url && x.url.includes('deepseek.com'));
if (!main) throw new Error('找不到主窗口');
console.log(`[target] ${main.url.slice(0, 50)}`);

// 等注入脚本起来
for (let i = 0; i < 60; i++) {
  if ((await evalIn(main, `typeof window.__DSC_ACTIVITY_ASK_NOW__ === 'function'`)) === true) break;
  await sleep(500);
}

// 造一轮「刚聊过」+ 把 turns 抬起来（三道闸里有两道要看它）
await evalIn(
  main,
  `(() => {
     const c = window.__DSC_CFG__();
     c.state = c.state || {};
     c.state.turns = Math.max(1, c.state.turns || 0);
     window.__DSC_ACTIVITY_SEED__(
       '我在给 ds-companion 加「她空闲时在做什么」，活动池和位置分流都弄好了，现在想让她自己按场景写一条。',
       '行，那我盯着这边；你先把那条链跑通，别又像上次那样"算出来了屏幕上什么都没有"。'
     );
     return 1;
   })()`,
);

const st0 = await evalIn(main, `JSON.stringify(window.__DSC_ACTIVITY_ASK_STATE__())`);
console.log('[闸] ' + st0);
console.log('[本地那条] ' + (await evalIn(main, `window.__DSC_ACTIVITY__().text`)));

const prompt = await evalIn(main, `window.__DSC_ACTIVITY_PROMPT__()`);
console.log('──── prompt（' + String(prompt).length + ' 字）────');
console.log(prompt);
console.log('───────────────────────────────');

const before = await evalIn(main, `window.__DSC_ACTIVITY__().text`);
console.log('[ask] 真发一次隐藏链…');
await evalIn(main, `window.__DSC_ACTIVITY_ASK_NOW__()`);

let got = '';
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  const now = await evalIn(main, `window.__DSC_ACTIVITY__().text`);
  if (now && now !== before) {
    got = now;
    break;
  }
}
console.log('');
console.log(got ? `★ 模型写的：「${got}」` : `✗ 45 秒内没换（本地那条仍是「${before}」）`);

const logTail = await evalIn(
  main,
  `(window.__DSC_STATE__ && window.__DSC_STATE__().logTail) || ''`,
).catch(() => '');
if (logTail) console.log('[日志尾] ' + String(logTail).split('\n').slice(-6).join('\n'));
