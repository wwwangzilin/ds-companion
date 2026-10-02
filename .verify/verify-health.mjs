/* 运行体检（健康度）验收：确认「她是不想干活，还是坏了」真的能一眼看出来
 *
 * 【为什么不用真对话验收】每一次真实对话都在烧主人的网页套餐额度，而这块面板要证明的
 * 是**数据链路**：页面侧计数 → 写进日志 → 设置页解析 → 渲染成块。所以这里全程用页面里的
 * 探针直接驱动（__DSC_HEALTH_BUMP__ / __DSC_PUBLISH_HEALTH__），一次模型请求都不发。
 *
 * 【副作用】会往 %TEMP%\ds-companion.log 追加一行带 reason=probe 的 [health] 行，
 * 并把页面侧的内存计数 +1（重启即归零）。都是诊断产物，不碰记忆 / 状态 / 人设。
 *
 * 前置：壳以隔离数据 + CDP 启动（见 verify-run.ps1），主窗口与设置窗口都开着
 *   .\verify-run.ps1
 *   node .verify\verify-health.mjs
 *
 * 用法：node .verify\verify-health.mjs [port]
 */

import { requireIsolation } from './_env.mjs';

const PORT = Number(process.argv[2] || process.env.DSC_CDP_PORT || 9222);
const CDP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await requireIsolation();

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 220) : ''}`);
}

class Page {
  constructor(ws) {
    this.ws = new WebSocket(ws);
    this.seq = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      const slot = this.pending.get(m.id);
      if (slot) {
        this.pending.delete(m.id);
        slot(m);
      }
    });
    await this.send('Runtime.enable');
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const out = r.result || {};
    if (out.exceptionDetails) {
      throw new Error(JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails));
    }
    return out.result ? out.result.value : undefined;
  }
  close() {
    setTimeout(() => {
      try {
        this.ws.close();
      } catch {}
    }, 50);
  }
}

const targets = async () => await (await fetch(`${CDP}/json/list`)).json();

/**
 * 挂到一个 target 上；probe 为真才认（页面可能不止一个同源 target，
 * 没注入的那一个上面什么都没有，直接问它的全局量最省事）
 */
async function attach(match, probe) {
  let list = [];
  try {
    list = await targets();
  } catch {
    return null;
  }
  for (const t of list.filter((x) => x.url && x.url.includes(match))) {
    const p = new Page(t.webSocketDebuggerUrl);
    try {
      await p.open();
      if (!probe) return p;
      const ok = await p.eval(probe);
      if (ok) return p;
      p.close();
    } catch {
      try {
        p.close();
      } catch {}
    }
  }
  return null;
}

/** 页面侧 health 的字段表（漏字段就是静默丢数据，必须逐个点名） */
const FIELDS = [
  'turns',
  'replies',
  'emptyReplies',
  'thinkOnly',
  'toolCalls',
  'toolRuns',
  'toolFailures',
  'toolSends',
  'toolFallbacks',
  'toolBlocked',
  'lastReplyLen',
  'lastTurnAt',
  'lastError',
  'at',
  'uptimeSec',
];

// ── ① 页面侧：计数真的在动 ────────────────────────────────────────────────
const chat = await attach(
  'chat.deepseek.com',
  'typeof window.__DSC_HEALTH__ === "object" && !!window.__DSC_HEALTH__ && typeof window.__DSC_PUBLISH_HEALTH__ === "function"',
);
if (!chat) {
  check('主窗口页面已注入（能拿到 health 对象）', false, '没找到注入好的 chat.deepseek.com target');
  console.log('\n提示：先跑 .\\verify-run.ps1 起隔离实例（带 CDP），并等主窗口把 DeepSeek 页面加载完');
  process.exit(1);
}
check('主窗口页面已注入（能拿到 health 对象）', true);

const obj = JSON.parse(await chat.eval('JSON.stringify(window.__DSC_HEALTH__)'));
const missing = FIELDS.filter((f) => !(f in obj));
check('health 字段齐全', missing.length === 0, missing.length ? '缺：' + missing.join(', ') : '');

const before = Number(obj.turns) || 0;
const after = await chat.eval("window.__DSC_HEALTH_BUMP__('turns'); window.__DSC_HEALTH__.turns");
check('计数能推进（turns +1）', after === before + 1, `${before} -> ${after}`);

const bumps = await chat.eval(
  "(function(){ window.__DSC_HEALTH_BUMP__('toolCalls'); window.__DSC_HEALTH_BUMP__('toolRuns'); return window.__DSC_HEALTH__.toolCalls + '/' + window.__DSC_HEALTH__.toolRuns; })()",
);
check('工具计数也能推进', /^\d+\/\d+$/.test(String(bumps)), bumps);

// ── ② 上报：页面 → 日志 ──────────────────────────────────────────────────
const tag = 'verify-health-' + Date.now();
const published = await chat.eval(
  `(function(){ window.__DSC_HEALTH__.probeTag = ${JSON.stringify(tag)}; window.__DSC_PUBLISH_HEALTH__('probe'); return true; })()`,
);
check('上报调用没有抛错', published === true);

const st = await attach('settings.html', 'typeof window.__TAURI_INTERNALS__ === "object"');
if (!st) {
  check('设置窗口可用（读日志 / 渲染体检块）', false, '没找到 settings.html target');
  console.log('\n提示：设置窗口要开着（托盘「设置」或点角标）');
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
check('设置窗口可用（读日志 / 渲染体检块）', true);

await sleep(300);
const logRaw = await st.eval(
  "window.__TAURI_INTERNALS__.invoke('log_tail',{lines:400}).then(v=>JSON.stringify({path:v.path,total:v.total,lines:v.lines.filter(l=>l.indexOf('[health] ')>=0).slice(-3)}))",
);
const logInfo = JSON.parse(logRaw);
const hit = (logInfo.lines || []).find((l) => l.includes(tag));
check('日志里出现了本次 [health] 行', !!hit, hit ? '日志共 ' + logInfo.total + ' 行' : '最近 health 行：' + JSON.stringify(logInfo.lines));

let parsed = null;
if (hit) {
  try {
    parsed = JSON.parse(hit.slice(hit.indexOf('[health] ') + '[health] '.length));
  } catch (e) {
    parsed = { __parseError: String(e && e.message ? e.message : e) };
  }
}
check('[health] 行是能解析的 JSON', !!parsed && !parsed.__parseError, parsed && parsed.__parseError);
check('JSON 里带全部关键字段', !!parsed && FIELDS.every((f) => f in parsed), parsed ? 'reason=' + parsed.reason : '');
check('reason 标成 probe（可溯源）', !!parsed && parsed.reason === 'probe', parsed && parsed.reason);

// ── ③ 设置页：解析 + 渲染 ────────────────────────────────────────────────
await st.eval("(function(){ setTab('log'); return refreshLog(); })()");
await sleep(200);

const cells = await st.eval("document.querySelectorAll('#health-grid .health-cell').length");
check('体检块渲染出 12 个格子', cells === 12, '实际 ' + cells);
const sub = String(await st.eval("document.getElementById('health-sub').textContent"));
check('显示上报时间与运行时长', /上报于/.test(sub) && /秒/.test(sub), sub);
const note = String(await st.eval("document.getElementById('health-note').textContent") || '');
check('给出判读结论', note.trim().length > 0, note);
const seen = JSON.parse(await st.eval('JSON.stringify(window.__DSC_HEALTH__)'));
check('设置页拿到的正是刚上报的那一份', !!seen && seen.probeTag === tag, seen ? 'tag=' + seen.probeTag : 'null');
check('设置页读到的 turns 与页面侧一致', !!seen && seen.turns === after, seen ? `${seen.turns} vs ${after}` : '');

// 坏行 / 截断行不能让整块数据消失（日志被切一半是常态）
const robust = await st.eval(
  `(function(){ return JSON.stringify(parseHealth(['x [health] {"turns":3,"replies":2}', 'y [health] {"broken', 'z 与体检无关的一行'])); })()`,
);
check('截断的 JSON 行被跳过、保留上一条好数据', robust === '{"turns":3,"replies":2}', robust);

const emptyCell = await st.eval(
  "(function(){ renderHealth(null); return JSON.stringify({ empty: document.querySelectorAll('#health-grid .health-empty').length, state: window.__DSC_HEALTH__ }); })()",
);
const emptyObj = JSON.parse(emptyCell);
check('没有数据时给出明确空态', emptyObj.empty === 1 && emptyObj.state === null, JSON.stringify(emptyObj));

// ── ④ 通路自检：摆成"饿着没人管"，告警必须响 ───────────────────────────
//
// 这一档防的是"机制没坏、通路断了"（情绪冻结 / 饿着没人管 / 好感停滞）——
// 以前这类问题都要人主动去翻日志才发现。判据有两条：
//   ① 卡住了要出声（带数字 + 带"怎么办"）
//   ② 修好了要闭嘴（不消失就是狼来了，几次之后人就不看了）
const character = String(
  await st.eval("window.__TAURI__.core.invoke('config_get').then(c => c.activePersona || '')"),
);
if (!character) {
  check('有激活角色（通路自检的前提）', false, '隔离实例要先跑 seed-persona.mjs');
} else {
  const stSnap = await st.eval(
    `window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(character)} }).then(s => JSON.stringify(s))`,
  );
  // 摆成"饿着 + 很久没喂"：这正是今天真实踩到的那个状态
  await st.eval(
    `window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(character)} })
       .then(s => { s.body.hunger = 0.95; s.turns = 100; s.lastFedTurn = 40; return window.__TAURI__.core.invoke('state_save', { state: s }); })
       .then(() => true)`,
  );
  await chat.eval(`window.__DSC_REPORT_TURN__('嗯')`);
  await sleep(600);
  const vitals = JSON.parse(
    await chat.eval('JSON.stringify(window.__DSC_HEALTH__.vitals || [])'),
  );
  const h = vitals.find((v) => v.key === 'hunger');
  check('通路自检报出了「饿着没人管」', !!h, JSON.stringify(vitals).slice(0, 220));
  check('告警带数字（多少轮没喂）', !!h && /\d+ 轮/.test(h.text || ''), h && h.text);
  check('告警带「怎么办」', !!h && !!h.hint, h && h.hint);
  check('级别是 warn/bad', !!h && ['warn', 'bad'].includes(h.level), h && h.level);

  await st.eval('refreshLog()');
  await sleep(300);
  const noteHungry = String(await st.eval("document.getElementById('health-note').textContent"));
  check('设置页的体检块里也能看见这条告警', /饿/.test(noteHungry), noteHungry.slice(0, 160));

  // 喂一顿 → 告警必须消失
  await st.eval(
    `window.__TAURI__.core.invoke('state_feed', { characterId: ${JSON.stringify(character)} }).then(() => true)`,
  );
  await chat.eval(`window.__DSC_REPORT_TURN__('嗯')`);
  await sleep(600);
  const vitals2 = JSON.parse(
    await chat.eval('JSON.stringify(window.__DSC_HEALTH__.vitals || [])'),
  );
  check(
    '喂过之后告警消失（不刷屏，不然就成狼来了）',
    !vitals2.some((v) => v.key === 'hunger'),
    JSON.stringify(vitals2).slice(0, 220),
  );

  // 还原（这段改动的是真状态）
  await st.eval(
    `window.__TAURI__.core.invoke('state_save', { state: ${stSnap} }).then(() => true)`,
  );
}

// 收尾：把真实数据渲染回来，别把界面留在「无数据」上
await st.eval('refreshLog()');
const restored = await st.eval('!!window.__DSC_HEALTH__');
check('收尾恢复正常渲染', restored === true);

chat.close();
st.close();
console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
