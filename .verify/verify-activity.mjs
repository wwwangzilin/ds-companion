/* 「她正在做什么」端到端验收：本地挑法 + 两处落位 + 回传进【状态】块。
 *
 * 【为什么单开一个脚本】这个功能横跨三层，每层的坏法都不一样：
 *   ① **挑法**（页面）：确定性伪随机 + 条件标签。坏起来最阴的是"标签写错一个字，
 *      那条活动从此再也不出现" —— 没有报错、没有痕迹，只有它悄悄消失。
 *   ② **落位**（页面）：有立绘贴立绘、没立绘落 HUD。这里最容易出的错是
 *      "算出来了但屏幕上什么都没有"（比如 placeActivity 用 cssText 整体重写样式，
 *      把 display 冲掉），所以断言必须看 offsetWidth，不能看 DOM 里有没有那个 div。
 *   ③ **回传与注入**（壳）：页面挑的那条要存进 state、再拼进【状态】块，
 *      她聊天时才引用得到。存漏了/注入漏了，界面上一切正常，只是她永远不提这事。
 *
 * 用法（PowerShell，先停真实例 —— 单实例锁）：
 *   $env:DSC_DATA_DIR="$env:TEMP\dsc-verify-activity"
 *   Remove-Item -Recurse -Force $env:DSC_DATA_DIR -ErrorAction SilentlyContinue
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   .\src-tauri\target\debug\ds-companion.exe
 *   node .verify/verify-activity.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
process.env.DSC_CDP = BASE;
const { requireIsolation } = await import('./_env.mjs');

const here = dirname(fileURLToPath(import.meta.url));
/** 截图留给人看 —— 本小姐看不见图，界面好不好看只能主人亲眼过一遍 */
async function shot(target, name) {
  try {
    const r = await send(target, 'Page.captureScreenshot', { format: 'png' });
    const out = join(here, '..', 'preview', name);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(r.data, 'base64'));
    console.log(`[shot] ${name}`);
  } catch (e) {
    console.log('[shot] 失败 ' + e);
  }
}

/** 探针人设 id（测多行活动池的存取往返） */
const PID = 'act-probe';
/** 探针活动文案：故意带条件标签，好验"标签真的在筛" */
const POOL = ['[困] 困的时候才做的事', '常年都能做的事甲', '常年都能做的事乙', '# 这行是注释，不该被选中', '   ', '常年都能做的事丙'].join('\n');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 25000) {
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
      // 不要在 onmessage 里立刻 close：会让 node 的 ws 在 uv 收尾阶段断言崩掉
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
      }, 50);
      if (m.error) {
        reject(new Error(JSON.stringify(m.error)));
        return;
      }
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
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r && r.result ? r.result.value : undefined;
}

async function findTarget(match, timeoutMs = 30000) {
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

// ── 开跑 ────────────────────────────────────────────────────────────
console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com', 45000);
await evalIn(main, `window.__TAURI_INTERNALS__.invoke('open_settings').then(()=>1).catch(e=>String(e))`);
const settings = await findTarget('settings.html', 25000);
console.log(`[target] settings = ${settings.url.slice(0, 60)}`);
await requireIsolation();

/** 设置窗口里调一条壳命令，失败直接抛（别让断言拿到 undefined 去静默 PASS） */
async function call(expr) {
  const raw = await evalIn(
    settings,
    `(async () => { try { const v = await window.__TAURI_INTERNALS__.invoke(${expr});
        return JSON.stringify({ ok: true, v }); }
      catch (e) { return JSON.stringify({ ok: false, err: String(e) }); } })()`,
  );
  const o = JSON.parse(raw);
  if (!o.ok) throw new Error(`${expr.slice(0, 70)} → ${o.err}`);
  return o.v;
}
/** 主窗口的探针 */
async function probe(fn, arg) {
  const raw = await evalIn(main, `JSON.stringify(window.${fn}(${arg === undefined ? '' : JSON.stringify(arg)}))`);
  return raw ? JSON.parse(raw) : null;
}
async function ready() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await evalIn(main, `typeof window.__DSC_ACTIVITY__ === 'function'`)) === true) return true;
    } catch {
      /* 还没起 */
    }
    await sleep(500);
  }
  return false;
}

const ok = await ready();
check('注入脚本就绪（__DSC_ACTIVITY__ 可用）', ok);
if (!ok) {
  console.log('\n注入还没起来，后面没法验 —— 中止。');
  process.exit(1);
}

// ── A. 页面的挑法 ──────────────────────────────────────────────────
let av = null;
for (let i = 0; i < 40; i++) {
  av = await probe('__DSC_ACTIVITY__');
  if (av && av.pool > 0 && av.text) break;
  await sleep(400);
}
// 页面上的池子原文：用来对行数，也用来对"挑出来的确实是池子里的行"
const poolRows = String(await evalIn(main, `(window.__DSC_CFG__().activities || '')`))
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && l.charAt(0) !== '#')
  .map((l) => l.replace(/^(\[[^\]\s]{1,6}\]\s*)+/, '').trim());
check('活动池已下发到页面（出厂人设里就写了）', poolRows.length >= 5, `${poolRows.length} 行`);
check(
  '页面报的 pool 与池子实际行数一致（注释行/空行不算）',
  !!(av && av.pool === poolRows.length),
  av ? `pool=${av.pool} 实际=${poolRows.length}` : 'null',
);
// 这一段只验"挑出来了"：**显示与否归 B 段**（那边要先预热一轮，turns>0 才谈得上显示）
check('此刻挑出了一条活动', !!(av && av.text), av ? av.text : '');
check('★ 显示的那条不是注释行', !!(av && av.text && !av.text.startsWith('#')), av ? av.text : '');

// 确定性：同一个时间块连问 20 次，必须是同一条
const det = await evalIn(
  main,
  `(() => {
     const first = window.__DSC_ACTIVITY_AT__(987654);
     for (let i = 0; i < 20; i++) {
       if (window.__DSC_ACTIVITY_AT__(987654) !== first) return 'DIFF:' + first + '|' + window.__DSC_ACTIVITY_AT__(987654);
     }
     return 'SAME:' + first;
   })()`,
);
check('★ 同一个时间块 → 同一条（确定性，刷新不漂移）', String(det).startsWith('SAME:'), String(det).slice(0, 80));

// 散开：喂 300 个连续块，看它是不是真的在池子里铺开
const spreadRaw = await evalIn(
  main,
  `(() => {
     const seen = {};
     for (let b = 1000000; b < 1000300; b++) {
       const t = window.__DSC_ACTIVITY_AT__(b);
       if (t) seen[t] = (seen[t] || 0) + 1;
     }
     return JSON.stringify(seen);
   })()`,
);
const spread = JSON.parse(spreadRaw);
const kinds = Object.keys(spread);
check('★ 300 个时间块铺开了（不是永远同一条）', kinds.length >= 4, `${kinds.length} 种：${JSON.stringify(spread)}`);
check(
  '挑出来的都是池子里的行（没越界、没串到别的角色）',
  kinds.every((k) => poolRows.indexOf(k) !== -1),
  `池子 ${poolRows.length} 行，命中 ${kinds.length} 种`,
);

// 条件标签：当前不困 → 带 [困] 的那条一次都不该出现
const bodyNow = await evalIn(main, `JSON.stringify((window.__DSC_CFG__().state || {}).body || {})`);
const b = JSON.parse(bodyNow || '{}');
const sleepy = b.asleep || (b.sleepiness || 0) >= 0.6;
const hasSleepyRow = kinds.some((k) => k === '困的时候才做的事');
check(
  sleepy ? '此刻是困的 → 带 [困] 的活动允许出现' : '★ 此刻不困 → 带 [困] 的活动一次都没出现',
  sleepy ? true : !hasSleepyRow,
  `asleep=${!!b.asleep} sleepiness=${b.sleepiness} 命中=${hasSleepyRow}`,
);

// 标签判定本身（不认识的标签必须放行）
const fitsEmpty = await probe('__DSC_ACTIVITY_FITS__', '');
const fitsJunk = await probe('__DSC_ACTIVITY_FITS__', '乱写的标签,ZZZ');
const fitsSleepy = await probe('__DSC_ACTIVITY_FITS__', '困');
check('不带标签 → 任何时候都成立', fitsEmpty === true, `fits=${fitsEmpty}`);
check('★ 不认识的标签一律放行（写错一个字不该让那条永远消失）', fitsJunk === true, `fits=${fitsJunk}`);
check('带 [困] 的判定跟着身体状态走', fitsSleepy === sleepy, `fits=${fitsSleepy} 实际困=${sleepy}`);

// ── B. 落位：有立绘贴立绘右边，没有就落 HUD ────────────────────────
// 【预热 turns】活动落在 HUD 位时要求 `state.turns > 0`（没聊过就没有"她"可言），
// 而隔离目录里 turns 是 0。
// ★不能在设置窗口调 dsc_turn_report 来预热★ —— 那个返回值是回给**设置窗口**的，
// 主窗口的 CFG 根本不知道，于是 turns 还是 0（实测就是这么假红了一轮）。
// 直接置主窗口的 CFG 才对。
await evalIn(
  main,
  `(() => { const c = window.__DSC_CFG__(); c.state = c.state || {}; c.state.turns = Math.max(1, c.state.turns || 0); return c.state.turns; })()`,
);
await evalIn(main, `window.__DSC_ACTIVITY_REPAINT__()`);
await sleep(300);
// 【诊断】落位没走立绘分支时，把判据的每个输入都打出来 —— 猜是没用的
console.log(
  '[diag] ' +
    (await evalIn(
      main,
      `(() => {
         const c = window.__DSC_CFG__();
         const av = document.getElementById('dsc-avatar');
         const el = document.getElementById('dsc-activity');
         return JSON.stringify({
           avatarEnabled: c.avatarEnabled,
           avatarEnabledType: typeof c.avatarEnabled,
           hudEnabled: c.hudEnabled,
           stateEnabled: c.stateEnabled,
           turns: (c.state || {}).turns,
           avOff: av ? av.offsetWidth : -1,
           avRight: av ? Math.round(av.getBoundingClientRect().right) : -1,
           actParent: el && el.parentNode ? el.parentNode.id || el.parentNode.tagName : 'none',
         });
       })()`,
    )),
);
const withAv = await probe('__DSC_ACTIVITY__');
check('★ 立绘开着 → 活动贴在立绘旁边', withAv.where === 'avatar', `where=${withAv.where}`);
check('★ 而且真的在立绘**右侧**（不是压在立绘上）', withAv.left >= withAv.avatarRight, `left=${withAv.left} avatarRight=${withAv.avatarRight}`);
check(
  '★ 贴立绘的那一档不吃鼠标事件（塞进 HUD 时不要求：点它等于点 HUD，那是有意的）',
  withAv.where !== 'avatar' || withAv.pointerEvents === 'none',
  `where=${withAv.where} pe=${withAv.pointerEvents}`,
);
check(
  '★ 不挡点击（elementFromPoint 命中的不是它）',
  (await evalIn(
    main,
    `(() => {
       const el = document.getElementById('dsc-activity');
       if (!el) return 'no-el';
       const r = el.getBoundingClientRect();
       const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
       return hit ? (hit.id || hit.tagName) : 'none';
     })()`,
  )) !== 'dsc-activity',
  '',
);

// 关掉立绘 → 应该搬进 HUD。
// 【走真的配置推送】只改 CFG 再调 REPAINT 不够：HUD 自己的 display 是 paintHud 算的，
// 那条路不会重算 —— 实测就这么假红过一次（activity 自己是 display:block，
// 但 offsetWidth=0，因为它爹 HUD 还挂着 none）。
const cfgOff = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_CFG__())`));
cfgOff.avatarEnabled = false;
cfgOff.hudEnabled = true;
cfgOff.state = cfgOff.state || {};
cfgOff.state.turns = Math.max(1, cfgOff.state.turns || 0);
await evalIn(main, `window.__DSC_SET_CONFIG__(${JSON.stringify(cfgOff)})`);
await sleep(500);
const noAv = await probe('__DSC_ACTIVITY__');
check('★ 关掉立绘 → 活动搬进 HUD', noAv.where === 'hud', `where=${noAv.where} shown=${noAv.shown}`);
check('搬进 HUD 之后照样看得见（不是搬丢了）', noAv.shown === true, `shown=${noAv.shown} display=${noAv.display}`);
await shot(main, 'activity-hud.png');

// 再打开 → 搬回立绘旁边
cfgOff.avatarEnabled = true;
await evalIn(main, `window.__DSC_SET_CONFIG__(${JSON.stringify(cfgOff)})`);
await sleep(500);
const backAv = await probe('__DSC_ACTIVITY__');
check('★ 立绘再打开 → 又搬回立绘旁边', backAv.where === 'avatar', `where=${backAv.where}`);
await shot(main, 'activity-avatar.png');

// ── C. 回传 + 注入（壳侧）──────────────────────────────────────────
const MARK = '验收用的活动·甲';
const r1 = await call(`'dsc_turn_report', { userText: '验收', hour: 12, activity: '${MARK}' }`);
check('★ 回传落进 state.activity', r1 && r1.state && r1.state.activity === MARK, r1 && r1.state ? String(r1.state.activity) : 'null');
check(
  '★★ 而且真的**注入进【状态】块**（这才是"接上聊天"）',
  !!(r1 && r1.stateText && r1.stateText.indexOf('正在做的事：' + MARK) !== -1),
  r1 && r1.stateText ? r1.stateText.split('\n').slice(0, 4).join(' / ').slice(0, 150) : 'null',
);

// 空串**不该**清空 —— 否则某一轮没挑到就把她手上那件事抹了
const r2 = await call(`'dsc_turn_report', { userText: '验收', hour: 12, activity: '' }`);
check('★ 回传空串不会清空已有活动（否则她会"突然什么都不干"）', r2 && r2.state && r2.state.activity === MARK, r2 && r2.state ? String(r2.state.activity) : 'null');

// 超长的会被截断（防人设里写了一整段）
const LONG = '很长很长的一条活动'.repeat(12);
const r3 = await call(`'dsc_turn_report', { userText: '验收', hour: 12, activity: '${LONG}' }`);
const kept = (r3 && r3.state && r3.state.activity) || '';
// clip_chars 是"截到 40 字 + 省略号"，所以 41 个字符才是对的（这条断言把语义钉住）
check('★ 超长活动被截断（40 字 + 省略号：注入是按字数花钱的）', kept.length === 41, `len=${kept.length}`);

// 「工作模式下状态块是压缩版、不加活动那一行」这条**本脚本不验**：taskMode 是每轮按
// 对话内容实时判的（见 state::sense_task），脚本里造不出那个状态 —— 硬写只会得到一条
// 永远为真的假断言，而假断言比没有断言更坏（它让人以为验过了）。
console.log('SKIP  「工作模式下不加活动行」需要真实触发 taskMode，本脚本不假装验过');

// ── D. 人设里多行活动池的存取往返 ──────────────────────────────────
try {
  await call(`'persona_delete', { id: '${PID}' }`);
} catch {
  /* 第一次跑没有这个探针人设 */
}
const saved = await call(
  `'persona_save', { persona: { id: '${PID}', name: '活动探针', description: 't', source: 'manual', body: '正文', activities: ${JSON.stringify(POOL)} } }`,
);
check('人设能存下去（带多行活动池）', !!(saved && saved.id === PID), JSON.stringify(saved).slice(0, 120));
const got = await call(`'persona_get', { id: '${PID}' }`);
check(
  '★ 多行活动池原样读回来（frontmatter 是手写的，多行要转义）',
  !!(got && got.activities === POOL),
  got ? JSON.stringify(got.activities).slice(0, 160) : 'null',
);
check('★ 注释行与空行也在（不做静默清洗）', !!(got && got.activities.indexOf('# 这行是注释') !== -1), '');

// 设置界面那张：切回人设页、点开这份带活动池的探针人设，好截到那个编辑框
await evalIn(
  settings,
  `(async () => {
     const b = document.querySelector('.tb-tab[data-tab="persona"]');
     if (b) b.click();
     // 刚存进去的人设还在页面的列表外面 —— 先 reload 一次，openEditor 才找得到它
     if (typeof reload === 'function') await reload();
     if (typeof openEditor === 'function') openEditor('${PID}');
     return 1;
   })()`,
);
await sleep(700);
await shot(settings, 'activity-settings.png');

// ── E. 编辑区布局：新加的字段绝不能把正文挤掉 ──────────────────────
// 【为什么值得专门验】`.field.grow` 原来写的是 `flex: 1`（basis 0%）—— 正文的高度
// 全由"剩余空间"决定。新加一个字段就会把它压扁，而且**没有任何报错**、控制台干干净净，
// 只有肉眼看得见。主人就是这么发现的：「原来的人设设置给挤掉了」。
const layout = JSON.parse(
  await evalIn(
    settings,
    `(() => {
       const body = document.getElementById('f-body');
       const act = document.getElementById('f-activities');
       const grow = document.querySelector('#tab-persona .field.grow') || document.querySelector('.field.grow');
       const fields = document.querySelector('#tab-persona .fields') || document.querySelector('.fields');
       const br = body ? body.getBoundingClientRect() : { height: 0 };
       const ar = act ? act.getBoundingClientRect() : { height: 0 };
       const gr = grow ? grow.getBoundingClientRect() : { height: 0 };
       return JSON.stringify({
         growH: Math.round(gr.height),
         bodyH: Math.round(br.height),
         actH: Math.round(ar.height),
         winH: innerHeight,
         overflowPx: fields ? fields.scrollHeight - fields.clientHeight : 0,
         overflowY: fields ? getComputedStyle(fields).overflowY : '',
       });
     })()`,
  ),
);
// 量「正文那一整块」（.field.grow）—— 它才是"有没有被挤掉"的答案；
// 里面的 textarea 会再少掉标签与间距那 20 来像素。
check(
  '★ 正文那一块没被新字段挤掉（整块 ≥ 200px）',
  layout.growH >= 200,
  `growH=${layout.growH} 输入框=${layout.bodyH} 窗口高=${layout.winH}`,
);
check('★ 正文输入框本身也够用（≥ 170px ≈ 13 行）', layout.bodyH >= 170, `bodyH=${layout.bodyH}`);
check('活动池那个框自己也看得见（高度 ≥ 60px）', layout.actH >= 60, `actH=${layout.actH}`);
check(
  '★ 真挤不下时内容区能滚（不是"压扁了还滚不动"）',
  layout.overflowPx <= 0 || layout.overflowY === 'auto',
  `溢出 ${layout.overflowPx}px overflowY=${layout.overflowY}`,
);

await call(`'persona_delete', { id: '${PID}' }`).catch(() => 0);

// ── F. 让模型写那条：**机制层**（不真发请求）──────────────────────
// 真链路由 .verify/probe-activity-ask.mjs 手动跑 —— 它真花一次额度，而且结果取决于
// 模型当时的发挥，拿它当断言就是间歇性假红。这里只验"该不该问"和"收到之后怎么收拾"，
// 这两样才是会**静默**出错的地方（多问一次就是白烧一次；清洗漏了就是难看的一行）。
await evalIn(
  main,
  `(() => {
     const c = window.__DSC_CFG__();
     c.state = c.state || {};
     c.state.turns = Math.max(1, c.state.turns || 0);
     window.__DSC_ACTIVITY_SEED__('主人：帮我看下这个报错', '你：行，我盯着');
     return 1;
   })()`,
);
const ask0 = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_ACTIVITY_ASK_STATE__())`));
check('默认就是「让她自己想」（auto）', ask0.mode === 'auto', `mode=${ask0.mode}`);
check('★ 闸门齐了就该问（刚聊过 + 有状态）', ask0.wouldAsk === true, JSON.stringify(ask0));

// 【这条守着一个真 bug】原来"有没有活动池"也是闸门之一 —— 而露娜还没写池子，
// 于是这功能对她**完全不工作**（池子只是"本地兜底 + 风格参考"，不该当闸门）。
const savedPool = await evalIn(main, `window.__DSC_CFG__().activities`);
await evalIn(main, `(() => { window.__DSC_CFG__().activities = ''; return 1; })()`);
const askNoPool = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_ACTIVITY_ASK_STATE__())`));
check(
  '★ 没写活动池的角色也该问（池子是兜底，不是闸门）',
  askNoPool.wouldAsk === true && askNoPool.hasPool === false,
  JSON.stringify(askNoPool),
);
check(
  '★ 池子为空时 prompt 里不出现空的「你平时会做的事」',
  String(await evalIn(main, `window.__DSC_ACTIVITY_PROMPT__()`)).indexOf('【你平时会做的事】') === -1,
  '',
);
await evalIn(main, `(() => { window.__DSC_CFG__().activities = ${JSON.stringify(savedPool)}; return 1; })()`);

// 切成 local → 一次都不该问（这是"零请求"那条承诺的唯一保证）
await evalIn(main, `(() => { window.__DSC_CFG__().activityMode = 'local'; return 1; })()`);
const askLocal = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_ACTIVITY_ASK_STATE__())`));
check('★ 切成 local → 一个请求都不发', askLocal.wouldAsk === false, JSON.stringify(askLocal));
await evalIn(main, `(() => { window.__DSC_CFG__().activityMode = 'auto'; return 1; })()`);

// 同一个时间块里不许问第二次 —— 否则 15 秒的节拍会变成"15 秒一次请求"
await evalIn(main, `window.__DSC_ACTIVITY_MARK_ASKED__()`);
const askDup = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_ACTIVITY_ASK_STATE__())`));
check(
  '★ 同一块内不会问第二次（否则节拍会变成 15 秒一次请求）',
  askDup.wouldAsk === false && askDup.askedBlock === askDup.block,
  JSON.stringify(askDup),
);

// 清洗：模型爱自作主张的那几种写法
for (const [raw, want, why] of [
  ['「翻你的日志」', '翻你的日志', '去掉两头的引号'],
  ['我正在：拆你的耳机线', '拆你的耳机线', '去掉「我正在：」这种前缀'],
  ['在算那道题\n（顺便解释一下）', '在算那道题', '只留第一行'],
  ['   ', '', '全是空白 → 空串（宁可保留旧的那条）'],
]) {
  const got = await evalIn(main, `window.__DSC_ACTIVITY_CLEAN__(${JSON.stringify(raw)})`);
  check(
    `清洗：${why}`,
    got === want,
    `${JSON.stringify(raw)} → ${JSON.stringify(got)}（想要 ${JSON.stringify(want)}）`,
  );
}
const cutLong = await evalIn(
  main,
  `window.__DSC_ACTIVITY_CLEAN__(${JSON.stringify('很长很长的一条活动'.repeat(6))})`,
);
check('清洗：超长截到 40 字（跟壳侧一个口径）', String(cutLong).length === 40, `len=${String(cutLong).length}`);

// prompt 里得有"刚聊了什么"和活动池 —— 少了任何一样，她就只能凭空编
const actPrompt = String(await evalIn(main, `window.__DSC_ACTIVITY_PROMPT__()`));
check('★ prompt 带上了刚聊的那轮（否则接不上场景）', actPrompt.indexOf('帮我看下这个报错') !== -1, `${actPrompt.length} 字`);
check(
  '★ prompt 把活动池给她当风格参考',
  actPrompt.indexOf('【你平时会做的事】') !== -1 && actPrompt.indexOf(poolRows[0]) !== -1,
  '',
);
check('prompt 明确要求「只输出这一行」（防她写小作文）', actPrompt.indexOf('只输出这一行') !== -1, '');

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
process.exit(failed ? 1 : 0);
