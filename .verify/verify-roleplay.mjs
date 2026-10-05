/* 角色扮演层端到端验收：场景 / 关系与称呼 / 伏笔待回访 / 边界与出戏。
 *
 * 【为什么这四条必须一起验】它们的共同点是"**注入面**变了" —— 有没有那块、内容对不对、
 * 空的时候会不会白注 —— 而这些只有把页面和壳一起跑起来才看得见：
 *   ① 三个新块（场景/关系/待回访）由**壳**算、页面贴，中间隔着一次 IPC 序列化；
 *   ② 伏笔是"一次性"的：问过就必须消失，这一条错了两头都安静（她变成复读机）；
 *   ③ 边界/出戏是**页面**自己拼的（配置从 push_config 来），壳那边一个字不知道。
 *
 * 用法（PowerShell，先停真实例 —— 单实例锁）：
 *   $env:DSC_DATA_DIR="$env:TEMP\dsc-verify-roleplay"
 *   Remove-Item -Recurse -Force $env:DSC_DATA_DIR -ErrorAction SilentlyContinue
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   .\src-tauri\target\debug\ds-companion.exe
 *   node .verify/verify-roleplay.mjs
 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
process.env.DSC_CDP = BASE;
const { requireIsolation } = await import('./_env.mjs');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget(match, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(`${BASE}/json/list`)).json();
      const t = list.find((x) => x.url && x.url.includes(match));
      if (t) return t;
    } catch {
      /* 还没起 */
    }
    if (Date.now() > deadline) throw new Error(`等不到窗口：${match}`);
    await sleep(300);
  }
}

function evalIn(target, expression, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('CDP 超时'));
    }, timeoutMs);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
      }, 50);
      if (m.result && m.result.exceptionDetails) {
        reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300)));
        return;
      }
      resolve(m.result && m.result.result ? m.result.result.value : undefined);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP 连接失败'));
    };
  });
}

async function call(page, cmd, args) {
  const expr =
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}` +
    (args ? `, ${JSON.stringify(args)}` : '') +
    `).then(v => JSON.stringify({ ok: 1, v })).catch(e => JSON.stringify({ ok: 0, e: String(e) }))`;
  const out = JSON.parse(await evalIn(page, expr));
  if (!out.ok) throw new Error(`${cmd} 失败：${out.e}`);
  return out.v;
}

// ── 开跑 ────────────────────────────────────────────────────────────
const page = await findTarget('deepseek.com');
await call(page, 'open_settings').catch(() => {});
const info = await requireIsolation();
const win = await findTarget('settings.html');
const TODAY = await evalIn(page, 'window.__DSC_LOCAL_DAY__()');
const CID = await evalIn(page, 'window.__DSC_CFG__ && window.__DSC_CFG__().personaId');
console.log(`[day] ${TODAY}  [cid] ${CID}`);
check('页面报的本地日期是 10 位（补零）', /^\d{4}-\d{2}-\d{2}$/.test(String(TODAY)), String(TODAY));

const turn = (userText) => call(page, 'dsc_turn_report', { userText, hour: 21, day: TODAY });

// ① 称呼：给一个显式配了「她叫你」的人设，并激活它
await call(win, 'persona_save', {
  persona: {
    id: 'verify-luna',
    name: '验收娘',
    description: '验收用',
    source: 'manual',
    body: '你是「验收娘」，一个只在这台机器上存在的角色。',
    address: '主人',
  },
});
const cfg = await call(win, 'config_get');
await call(win, 'config_set', { cfg: { ...cfg, activePersona: 'verify-luna', stateEnabled: true } });
// 等下一条 turn_report，让页面拿到新的人设名
let r = await turn('在吗');
check('换人设后壳认了这个人设', !!r && r.ok === true, JSON.stringify(r && r.ok));

// ② 场景：写进状态 → 下一轮 turn_report 就该带回来
const st = await call(win, 'state_get', { characterId: 'verify-luna' });
await call(win, 'state_save', {
  state: {
    ...st,
    scene: { name: '雨天便利店', text: '雨夜的便利店门口，屋檐在滴水，手里捧着一杯热的', since: Date.now() },
  },
});
r = await turn('在吗');
check('场景进了 turn_report', !!r && String(r.sceneText).includes('屋檐在滴水'), JSON.stringify(r && r.sceneText));
check(
  '块标题与预设名都在正文里',
  !!r && String(r.sceneText).startsWith('【场景】') && String(r.sceneText).includes('｜雨天便利店'),
  JSON.stringify(r && r.sceneText),
);

// ③ 关系与称呼
check(
  '关系块：第几天 + 阶段 + 好感',
  !!r && /第 \d+ 天/.test(String(r.relationText)) && String(r.relationText).includes('好感') && String(r.relationText).includes('刚认识'),
  JSON.stringify(r && r.relationText),
);
check('关系块带上她怎么叫你', !!r && String(r.relationText).includes('她叫你「主人」'), JSON.stringify(r && r.relationText));

// ④ 伏笔：搭在情绪感知那条链上（模型回什么，壳收什么）
await call(page, 'dsc_sense_apply', {
  sense: { valence: 0.3, arousal: 0.4, mood: '平静', confidence: 0.9, followup: { what: '面试', due: TODAY } },
});
// 先走"主动开口"那条：她该优先把这件事问出来，而且**真说出口了才标记**
const proCfg = await call(win, 'config_get');
await call(win, 'config_set', { cfg: { ...proCfg, proactiveMode: 'local', proactiveDailyCap: 50 } });
const pro = await call(page, 'dsc_proactive', { day: TODAY, cap: 50, hour: 12 });
check('主动开口拿到了到期的伏笔', !!(pro && Array.isArray(pro.pending) && pro.pending.includes('面试')), JSON.stringify(pro && pro.pending));
check('本地话术里问出来了', !!pro && String(pro.text).includes('面试'), JSON.stringify(pro && pro.text));
await call(page, 'dsc_proactive_done', { text: pro.text, pending: '面试' });
r = await turn('嗯');
check('★她问过之后，注入里就没有了★', !!r && String(r.pendingText) === '', JSON.stringify(r && r.pendingText));

// 再来一件：这次走注入那条路（turn_report 里 take 掉）
await call(page, 'dsc_sense_apply', {
  sense: { valence: 0.3, confidence: 0.9, followup: { what: '体检', due: TODAY } },
});
r = await turn('还有件事');
check('到期的伏笔进了【待回访】块', !!r && String(r.pendingText).includes('体检'), JSON.stringify(r && r.pendingText));
check('块里带着别罗列的约束', !!r && String(r.pendingText).includes('别罗列'), JSON.stringify(r && r.pendingText));
r = await turn('好');
check('★同一件事不会问第二遍★', !!r && String(r.pendingText) === '', JSON.stringify(r && r.pendingText));

// 还没到日子的：不该出现
await call(page, 'dsc_sense_apply', {
  sense: { valence: 0.3, confidence: 0.9, followup: { what: '下周体检', due: addDays(TODAY, 5) } },
});
r = await turn('嗯嗯');
check('没到日子的伏笔先压着', !!r && String(r.pendingText) === '', JSON.stringify(r && r.pendingText));

// ⑤ 边界与出戏：这两块是**页面**拼的（配置从 push_config 来）
const cfg2 = await call(win, 'config_get');
await call(win, 'config_set', {
  cfg: { ...cfg2, boundariesAvoid: '体重\n前任', oocToken: '//' },
});
await sleep(500);
// ★`__DSC_AUGMENT__` 收的是**请求体的 JSON 字符串**（它自己 JSON.parse，解析不了就返回 null）★
// 第一版传了纯文本 → 拿到 null，三条断言里两条假绿（null 里当然没有【出戏】）。
const probe = (prompt) =>
  evalIn(
    page,
    `(() => { const out = window.__DSC_AUGMENT__(JSON.stringify({ prompt: ${JSON.stringify(
      prompt,
    )}, chat_session_id: 'verify' }), 'probe'); return typeof out === 'string' ? out : JSON.stringify(out); })()`,
  );
const plain = await probe('普通的一句话');
check('【边界】块进了正文', String(plain).includes('【边界】') && String(plain).includes('体重'), String(plain).slice(0, 120));
check('没打暗号就不加【出戏】', !String(plain).includes('【出戏】'));
const ooc = await probe('喂 // 出来一下');
check('打了暗号才加【出戏】', String(ooc).includes('【出戏】'), String(ooc).slice(0, 120));
check('出戏块说清了"跟本人说话"', String(ooc).includes('你本人'), String(ooc).slice(0, 200));
// ★这两条是补上一次翻车的：块里必须同时钉住「思考仍是露娜」和「身体先说话」★
// （上一版只写了「用你自己的身份、平实的话」，结果它把整层皮都扒了，连内心独白都成了助手腔）
check(
  '出戏块要求身体先说话（心跳/脸红/磕巴）',
  String(ooc).includes('心跳') && String(ooc).includes('磕巴'),
  String(ooc).slice(0, 300),
);
check('出戏块钉住了：思考仍是露娜', String(ooc).includes('思考') && String(ooc).includes('露娜'), String(ooc).slice(0, 300));
// ★暗号要放在**远离末尾**的地方才算"历史"★
// 第一版写成了 `长文本 + 暗号`（暗号在最后）—— 那它当然落在"末尾 600 字"里，
// 断言必然红：错的不是实现，是我造的样本。
const historyOoc = await probe('// 早年的暗号' + 'x'.repeat(1000));
check('★历史里的暗号不算这一轮★（只看末尾 600 字）', !String(historyOoc).includes('【出戏】'));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);

function addDays(day, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n);
  const p = (x) => (x < 10 ? '0' : '') + x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
