/* 桌宠端到端验收：一个置顶透明的小窗，把立绘搬到桌面上。
 *
 * 【为什么要验得这么细】桌宠有两个"看不出来"的失败面：
 *   ① **它挡住了你**。"置顶 + 透明"如果不带点击穿透，她就会变成一个永远压在最上层、
 *      点哪儿都点到她的隐形障碍 —— 而这在截图里完全看不出来。所以必须去查 Win32 的
 *      扩展样式位（`dsc_pet_window()` 把 WS_EX_TRANSPARENT / WS_EX_LAYERED / WS_EX_TOPMOST
 *      读出来），不能只看"窗口开出来了"。
 *   ② **它什么都没画**。"窗口在、DOM 里有 img 标签"不等于图显示出来了（Quill 那边
 *      用 naturalWidth 抓到过这个）。所以断言必须落在 naturalWidth > 0 上。
 *
 * 用法（PowerShell，先停真实例 —— 单实例锁）：
 *   $env:DSC_DATA_DIR="$env:TEMP\dsc-verify-pet"
 *   Remove-Item -Recurse -Force $env:DSC_DATA_DIR -ErrorAction SilentlyContinue
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   .\src-tauri\target\debug\ds-companion.exe
 *   node .verify/verify-pet.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
process.env.DSC_CDP = BASE;
const { requireIsolation } = await import('./_env.mjs');

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── CDP ─────────────────────────────────────────────────────────────
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
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r && r.result ? r.result.value : undefined;
}

async function targets() {
  try {
    return await (await fetch(`${BASE}/json/list`)).json();
  } catch {
    return [];
  }
}

async function findTarget(match, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = (await targets()).find((x) => x.url && x.url.includes(match));
    if (t) return t;
    if (Date.now() > deadline) return null;
    await sleep(300);
  }
}

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

async function setCfg(patch) {
  const cur = await call(`'config_get'`);
  await call(`'config_set', { cfg: ${JSON.stringify({ ...cur, ...patch })} }`);
}

/** 截图留给人看 —— 本小姐看不见图，她长什么样只能主人亲眼过一遍 */
async function shot(target, name) {
  try {
    const r = await send(target, 'Page.captureScreenshot', { format: 'png' });
    const out = join(here, '..', 'preview', name);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(r.data, 'base64'));
    console.log(`[shot] preview/${name}`);
  } catch (e) {
    console.log('[shot] 失败 ' + e);
  }
}

// ── 开跑 ────────────────────────────────────────────────────────────
console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com', 45000);
if (!main) throw new Error('主窗口没起来');
await evalIn(main, `window.__TAURI_INTERNALS__.invoke('open_settings').then(()=>1).catch(e=>String(e))`);
const settings = await findTarget('settings.html', 25000);
if (!settings) throw new Error('设置窗口没起来');
console.log(`[target] settings = ${settings.url.slice(0, 60)}`);
await requireIsolation();

/** 角色 id：桌宠用的是 active_character_id（没选角色时是内置那个） */
const cfg0 = await call(`'config_get'`);
const activeRaw = cfg0.activePersona == null ? '' : String(cfg0.activePersona);
const CID = activeRaw === 'off' ? '' : activeRaw || 'dsh-deepseek';
console.log(`[char] ${JSON.stringify(CID)}（activePersona=${JSON.stringify(cfg0.activePersona)}）`);

const dpr = await evalIn(settings, `window.devicePixelRatio`);
console.log(`[dpr] ${dpr}`);

// ══════════════════════ A. 默认必须是关的 ══════════════════════
console.log('\n=== A. 默认必须是关的 ===');
check('配置里 petEnabled 默认 false', cfg0.petEnabled === false, String(cfg0.petEnabled));
const w0 = await call(`'dsc_pet_window'`);
check('壳说桌宠窗口没开', w0.open === false, JSON.stringify(w0));
const t0 = (await targets()).filter((x) => x.url && x.url.includes('pet.html'));
check('CDP 里也没有 pet 页面', t0.length === 0, `找到 ${t0.length} 个`);

// 设置界面：真实点一下「日志」页签（桌宠开关在那一页）
const clicked = await evalIn(
  settings,
  `(() => { const b = document.querySelector('.tb-tab[data-tab="log"]'); if (b) b.click(); return !!b; })()`,
);
check('设置界面里有「日志」页签可点', clicked === true);
await sleep(800);
const ui = JSON.parse(
  (await evalIn(
    settings,
    `JSON.stringify({
       has: !!document.getElementById('pet-enabled'),
       checked: !!(document.getElementById('pet-enabled') || {}).checked,
       sub: (document.getElementById('pet-sub') || {}).textContent || '',
       corners: document.querySelectorAll('#pet-corner button[data-v]').length
     })`,
  )) || '{}',
);
check('设置界面上有桌宠开关', ui.has === true, JSON.stringify(ui));
check('开关初始是关的（跟配置一致）', ui.checked === false, JSON.stringify(ui));
check('有四个角落可选', ui.corners === 4, String(ui.corners));

// ══════════════════════ B. 打开：窗口真的建出来、且不挡路 ══════════════════════
console.log('\n=== B. 打开它 ===');
await setCfg({ petEnabled: true });
await sleep(1800);
const w1 = await call(`'dsc_pet_window'`);
check('桌宠窗口开出来了', w1.open === true, JSON.stringify(w1));
const pet = await findTarget('pet.html', 12000);
check('CDP 里有 pet 页面（说明 webview 真的起来了，不是空壳）', !!pet, pet ? pet.url : '没等到');

const screenW = await evalIn(settings, `screen.width`);
const screenH = await evalIn(settings, `screen.height`);
check(
  '尺寸是 200×344 逻辑像素',
  Math.abs(w1.width - 200 * dpr) <= 2 && Math.abs(w1.height - 344 * dpr) <= 2,
  `${w1.width}×${w1.height}（dpr=${dpr}）`,
);
check('★置顶★（WS_EX_TOPMOST）', w1.topmost === true && w1.alwaysOnTop === true, JSON.stringify(w1));
check(
  '★点击穿透★（WS_EX_TRANSPARENT + WS_EX_LAYERED）—— 她绝不能挡住你点东西',
  w1.clickThrough === true,
  JSON.stringify(w1),
);
check('不进任务栏 / 不参与 Alt+Tab（WS_EX_TOOLWINDOW）', w1.toolWindow === true, JSON.stringify(w1));
// 右下角：x 在该在的位置（留 24 逻辑像素的边）
const wantRight = (screenW - 200 - 24) * dpr;
const wantBottom = (screenH - 344 - 24 - 48) * dpr;
check('待在右下角', Math.abs(w1.x - wantRight) <= 4, `x=${w1.x} 期望≈${Math.round(wantRight)}`);
check('贴着下边（留边 + 任务栏）', Math.abs(w1.y - wantBottom) <= 4, `y=${w1.y} 期望≈${Math.round(wantBottom)}`);

// ══════════════════════ C. 她真的画出来了 ══════════════════════
console.log('\n=== C. 她真的画出来了（不是"DOM 里有 img 标签"）===');
if (!pet) {
  check('pet 页面在（后面几条的前提）', false, '窗口没起来，C/D 段跳过');
} else {
  await evalIn(pet, `window.__DSC_PET_TICK__ && window.__DSC_PET_TICK__()`);
  await sleep(1200);
  const view = JSON.parse(
    (await evalIn(pet, `JSON.stringify(window.__DSC_PET_VIEW__ || null)`)) || 'null',
  );
  check('桌宠页面拿到了状态', !!view && !!view.id, JSON.stringify(view));
  const img = JSON.parse(
    (await evalIn(
      pet,
      `(function(){
         const el = document.querySelector('.layer.on');
         return JSON.stringify({
           has: !!el,
           nw: el ? el.naturalWidth : 0,
           nh: el ? el.naturalHeight : 0,
           isData: el ? String(el.src).indexOf('data:image') === 0 : false
         });
       })()`,
    )) || '{}',
  );
  // ★这条才是"图显示出来了"★ —— DOM 里有 img 完全不等于画出来了
  check('立绘真的加载了（naturalWidth > 0）', img.nw > 0 && img.nh > 0, JSON.stringify(img));
  check('立绘是从壳里来的（data URL，不是外链）', img.isData === true, JSON.stringify(img));
  check(
    '画的是当前角色的差分',
    !!view && ['neutral', 'happy', 'smug', 'angry', 'sad', 'sleepy', 'shy'].includes(view.variant),
    view && view.variant,
  );
  const bubble = await evalIn(pet, `document.getElementById('bubble-text').textContent`);
  const bubbleOff = await evalIn(
    pet,
    `document.getElementById('bubble').classList.contains('off')`,
  );
  const wantAct = String((await call(`'dsc_pet_state'`)).activity || '').trim();
  // 没活动时**必须收起**：留一个空白小框在头顶比不显示更难看
  check(
    wantAct ? '头顶那条小字 = 壳里"她正在做的事"' : '此刻没有活动 → 气泡是收起的（不留一个空框）',
    wantAct ? String(bubble || '') === wantAct : bubbleOff === true,
    `bubble=${JSON.stringify(bubble)} off=${bubbleOff} want=${JSON.stringify(wantAct)}`,
  );
  await shot(pet, 'pet-window.png');

  // ══════════════════════ D. 表情跟着状态走 ══════════════════════
  console.log('\n=== D. 表情跟着状态走 ===');
  const before = JSON.parse(
    (await evalIn(pet, `JSON.stringify(window.__DSC_PET_VIEW__ || {})`)) || '{}',
  );
  // 造一个"炸毛"的状态：数值看着不错，但模型手写的词是"烦躁" —— 词优先
  const st = await call(`'state_get', { characterId: ${JSON.stringify(CID)} }`);
  const angry = {
    ...st,
    mood: '有点烦躁',
    valence: 0.6,
    arousal: 0.8,
    body: { ...st.body, asleep: false, sleepiness: 0.1, heart_rate: 72, warmth: 0.5 },
  };
  await call(`'state_save', { state: ${JSON.stringify(angry)} }`);
  await sleep(500);
  await evalIn(pet, `window.__DSC_PET_TICK__ && window.__DSC_PET_TICK__()`);
  await sleep(1400);
  const v2 = JSON.parse(
    (await evalIn(pet, `JSON.stringify(window.__DSC_PET_VIEW__ || {})`)) || '{}',
  );
  check('心情变"烦躁" → 差分变 angry', v2.variant === 'angry', `${v2.variant}（之前 ${before.variant}）`);
  const img2 = JSON.parse(
    (await evalIn(
      pet,
      `(function(){ const el = document.querySelector('.layer.on');
         return JSON.stringify({ nw: el ? el.naturalWidth : 0, src: el ? String(el.src).slice(0, 40) : '' }); })()`,
    )) || '{}',
  );
  check('换差分之后新图也真的加载了', img2.nw > 0, JSON.stringify(img2));
  await shot(pet, 'pet-angry.png');

  // 她在做的事也要跟着走
  await call(
    `'state_save', { state: ${JSON.stringify({ ...angry, activity: '验收：正在拆你的耳机线' })} }`,
  );
  await sleep(400);
  await evalIn(pet, `window.__DSC_PET_TICK__ && window.__DSC_PET_TICK__()`);
  await sleep(700);
  const b2 = await evalIn(pet, `document.getElementById('bubble-text').textContent`);
  check('她正在做的事也画出来了', b2 === '验收：正在拆你的耳机线', String(b2));
  const on = await evalIn(pet, `!document.getElementById('bubble').classList.contains('off')`);
  check('有活动时气泡是可见的', on === true);

  // ══════════════════════ E. 换角落 ══════════════════════
  console.log('\n=== E. 换角落 ===');
  await setCfg({ petCorner: 'tl' });
  await sleep(700);
  const w2 = await call(`'dsc_pet_window'`);
  check('切到左上 → 窗口跑到左上角', w2.x < screenW * dpr * 0.5 && w2.y < screenH * dpr * 0.5, JSON.stringify(w2));
  check('角落名也回报成了 tl', w2.corner === 'tl', String(w2.corner));
  await setCfg({ petCorner: 'br' });
  await sleep(700);
  const w3 = await call(`'dsc_pet_window'`);
  check('切回右下 → 又回到右下', Math.abs(w3.x - wantRight) <= 4, `x=${w3.x}`);
}

// ══════════════════════ F. 关掉 ══════════════════════
console.log('\n=== F. 关掉 ===');
await setCfg({ petEnabled: false });
await sleep(1200);
const w4 = await call(`'dsc_pet_window'`);
check('关掉后窗口没了', w4.open === false, JSON.stringify(w4));
let gone = false;
for (let i = 0; i < 20; i++) {
  const t = (await targets()).filter((x) => x.url && x.url.includes('pet.html'));
  if (t.length === 0) {
    gone = true;
    break;
  }
  await sleep(300);
}
check('CDP 里的 pet 页面也没了', gone === true);
const cfgEnd = await call(`'config_get'`);
check('收尾：配置恢复成默认关', cfgEnd.petEnabled === false, String(cfgEnd.petEnabled));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
