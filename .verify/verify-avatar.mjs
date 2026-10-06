/* 立绘层端到端验收：内置 DeepSeek 娘 + 自建角色上传自己的图。
 *
 * 【为什么这几条必须真跑起来验】立绘是"壳与页面两边凑出来的一张图"：
 *   ① 素材在**壳**里（内置的编进 exe，上传的落在数据目录），页面只有一次 IPC 拿到它；
 *   ② 显示要过 CSP 那一关 —— `data:` URL 塞进 `<img>` 完全可能被页面的 img-src 拦掉，
 *      而那时 DOM 里**照样有个 img 标签、src 也照样写着**，只有 naturalWidth 是 0。
 *      所以这脚本的核心断言是 naturalWidth（DOM 有图 ≠ 图出来了）。
 *   ③ 立绘是浮层，浮在页面左下角 —— 它绝不能吃掉主人的点击（pointer-events）。
 *
 * 用法（PowerShell，先停真实例 —— 单实例锁）：
 *   $env:DSC_DATA_DIR="$env:TEMP\dsc-verify-avatar"
 *   Remove-Item -Recurse -Force $env:DSC_DATA_DIR -ErrorAction SilentlyContinue
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   .\src-tauri\target\debug\ds-companion.exe
 *   node .verify/verify-avatar.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
process.env.DSC_CDP = BASE;
const { requireIsolation } = await import('./_env.mjs');
const { CDP } = await import('./_env.mjs');

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DSC_DATA_DIR || '';
const PROBE_ID = 'avatar-probe-role';

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CDP 小工具（跟其它验收脚本同一套） ──────────────────────────────
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

// ── 造一张真 PNG（8×8 红块），用来验"上传自己的图"那条路 ─────────────
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 4;
      raw[o] = 0xff;
      raw[o + 3] = 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 开跑 ────────────────────────────────────────────────────────────
console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com', 45000);
console.log(`[target] main = ${main.url.slice(0, 60)}`);

// 隔离门禁要问壳要数据目录，而它走的是设置窗口 —— 所以先把设置窗口叫起来。
// （open_settings 只是开窗，不算碰数据。）
await evalIn(main, `window.__TAURI_INTERNALS__.invoke('open_settings').then(()=>1).catch(e=>String(e))`);
const settings = await findTarget('settings.html', 25000);
console.log(`[target] settings = ${settings.url.slice(0, 60)}`);
await requireIsolation();

// 等注入脚本就绪（它在 document-start 挂，但页面加载要时间）
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    ready = (await evalIn(main, `typeof window.__DSC_AVATAR__ === 'function'`)) === true;
  } catch {
    ready = false;
  }
  if (ready) break;
  await sleep(500);
}
check('注入脚本就绪（__DSC_AVATAR__ 可用）', ready);
if (!ready) {
  console.log('\n注入还没起来，后面没法验 —— 中止。');
  process.exit(1);
}

check('#dsc-avatar 浮层挂上了', (await evalIn(main, `!!document.getElementById('dsc-avatar')`)) === true);
check('#dsc-avatar-img 在浮层里', (await evalIn(main, `!!document.querySelector('#dsc-avatar > #dsc-avatar-img')`)) === true);

// 等素材到手（1MB 上下，过一次 IPC）
let av = null;
for (let i = 0; i < 60; i++) {
  const raw = await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`);
  av = raw ? JSON.parse(raw) : null;
  if (av && av.urlLen > 0) break;
  await sleep(400);
}
check('取到立绘素材（dataURL 非空）', !!(av && av.urlLen > 100000), av ? `urlLen=${av.urlLen}` : 'null');
check('来源是内置素材（隔离目录里没有用户图）', !!(av && av.id === 'dsh-deepseek'), av ? `id=${av.id}` : '');
check(
  '★ 图真的解码出来了（naturalWidth>0，不是只有个 img 标签）',
  !!(av && av.natW > 0 && av.natH > 0),
  av ? `${av.natW}×${av.natH}` : '',
);
check('就是那张 1280×1920 的 DeepSeek 娘', !!(av && av.natW === 1280 && av.natH === 1920), av ? `${av.natW}×${av.natH}` : '');
check('浮层可见（opacity=1）', !!(av && av.opacity === '1'), av ? `opacity=${av.opacity}` : '');

// 几何 + 不吃事件
const geoRaw = await evalIn(
  main,
  `(() => {
     const box = document.getElementById('dsc-avatar');
     const img = document.getElementById('dsc-avatar-img');
     const r = box.getBoundingClientRect();
     const ir = img.getBoundingClientRect();
     const cs = getComputedStyle(box);
     const cx = Math.round(ir.left + ir.width / 2);
     const cy = Math.round(Math.max(ir.top + 8, 8));
     const hit = document.elementFromPoint(cx, cy);
     const right = {};
     for (const id of ['dsc-badge', 'dsc-hud', 'dsc-say']) {
       const el = document.getElementById(id);
       right[id] = el ? Math.round(el.getBoundingClientRect().left) : null;
     }
     return JSON.stringify({
       left: Math.round(r.left), bottom: Math.round(r.bottom), top: Math.round(r.top),
       iw: Math.round(ir.width), ih: Math.round(ir.height),
       vw: innerWidth, vh: innerHeight,
       pe: cs.pointerEvents, pos: cs.position, z: cs.zIndex,
       hitId: hit ? (hit.id || hit.tagName) : null,
       right,
     });
   })()`,
);
const geo = JSON.parse(geoRaw);
check('贴在左下角、底边对齐视口底', geo.left <= 40 && Math.abs(geo.bottom - geo.vh) <= 2, `left=${geo.left} bottom=${geo.bottom} vh=${geo.vh}`);
check('在视口内（没超出右边/上边）', geo.left >= 0 && geo.top >= 0 && geo.left + geo.iw <= geo.vw, `w=${geo.iw} left=${geo.left} vw=${geo.vw}`);
check('立绘有实际尺寸（不是 0 高）', geo.ih > 120 && geo.iw > 40, `${geo.iw}×${geo.ih}`);
check('★ 不吃鼠标事件（pointer-events:none）', geo.pe === 'none', `pointerEvents=${geo.pe}`);
check('★ 立绘不挡点击（elementFromPoint 不是它）', geo.hitId !== 'dsc-avatar' && geo.hitId !== 'dsc-avatar-img', `命中=${geo.hitId}`);
check('z-index 低于右下角那三件套（不抢它们的点击）', Number(geo.z) < 2147483647, `z=${geo.z}`);
check('右下角三件套仍在右侧（没被立绘挤走）', geo.right['dsc-badge'] > geo.vw / 2, JSON.stringify(geo.right));

// ── 自建角色上传自己的图 ──────────────────────────────────────────
const pngB64 = makePng(8, 8).toString('base64');
const setRes = await evalIn(
  settings,
  `window.__TAURI_INTERNALS__.invoke('dsc_avatar_set', { id: '${PROBE_ID}', data: '${pngB64}' })
     .then(v => JSON.stringify({ ok: true, source: v.source, hasUser: v.hasUser, w: v.width, h: v.height }))
     .catch(e => JSON.stringify({ ok: false, err: String(e) }))`,
);
const setObj = JSON.parse(setRes);
check('上传自己的图：命令成功', setObj.ok === true, setRes.slice(0, 200));
check('上传后回读为 user 且量到尺寸 8×8', setObj.source === 'user' && setObj.w === 8 && setObj.h === 8, setRes.slice(0, 200));

const probePath = dataDir ? join(dataDir, 'avatars', `${PROBE_ID}.png`) : '';
check('图真的落到数据目录 avatars/', !!probePath && existsSync(probePath), probePath);
if (probePath && existsSync(probePath)) {
  const b = readFileSync(probePath);
  check('落盘内容与上传的一模一样', b.toString('base64') === pngB64, `${b.length} bytes`);
}

// 非 PNG 必须被拒（否则用户传个 jpg 进来会得到一个破图）
const badRes = await evalIn(
  settings,
  `window.__TAURI_INTERNALS__.invoke('dsc_avatar_set', { id: '${PROBE_ID}', data: 'bm90IGEgcG5n' })
     .then(() => 'accepted').catch(e => 'rejected:' + String(e))`,
);
check('非 PNG 被拒绝（不是静默存下来）', String(badRes).startsWith('rejected'), String(badRes).slice(0, 120));

// 页面侧能取到探针角色的图（换角色 = 换图这条链路）
const probeGet = JSON.parse(
  await evalIn(
    main,
    `window.__TAURI_INTERNALS__.invoke('dsc_avatar_get', { id: '${PROBE_ID}' })
       .then(v => JSON.stringify({ source: v.source, w: v.width, h: v.height }))
       .catch(e => JSON.stringify({ err: String(e) }))`,
  ),
);
check('页面侧按角色 id 取到那张 8×8（角色隔离成立）', probeGet.source === 'user' && probeGet.w === 8, JSON.stringify(probeGet));

// 清除后回落到「没有」（这个角色没有内置素材）
const clearRes = JSON.parse(
  await evalIn(
    settings,
    `window.__TAURI_INTERNALS__.invoke('dsc_avatar_clear', { id: '${PROBE_ID}' })
       .then(v => JSON.stringify({ source: v.source, hasUser: v.hasUser }))
       .catch(e => JSON.stringify({ err: String(e) }))`,
  ),
);
check('清除后 source=none、hasUser=false', clearRes.source === 'none' && clearRes.hasUser === false, JSON.stringify(clearRes));
check('清除后文件真的没了', !probePath || !existsSync(probePath), probePath);

// ── 设置界面那张卡片（主人就是靠它传图的） ────────────────────────
// 卡片在「状态」页签里：进页签才会 autoPickState → openStEditor → 初始化编辑器。
// 这里走**真实点击**（.tb-tab[data-tab=state]），不直接调内部函数 —— 否则验不出
// 「主人点得到」这件事。
await evalIn(
  settings,
  `(() => { const b = document.querySelector('.tb-tab[data-tab="state"]'); if (b) b.click(); return !!b; })()`,
);
await sleep(1500);
let ui = null;
for (let i = 0; i < 30; i++) {
  ui = JSON.parse(
    await evalIn(
      settings,
      `(() => {
         const img = document.getElementById('av-img');
         const meta = document.getElementById('av-meta');
         const clear = document.getElementById('av-clear');
         const sw = document.getElementById('st-avatar');
         const card = document.querySelector('.avatar-card');
         const r = card ? card.getBoundingClientRect() : null;
         return JSON.stringify({
           hasCard: !!card, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
           srcLen: img && img.src ? img.src.length : 0,
           natW: img ? img.naturalWidth : 0,
           meta: meta ? meta.textContent : null,
           clearDisabled: clear ? clear.disabled : null,
           switchOn: sw ? sw.checked : null,
         });
       })()`,
    ),
  );
  if (ui.hasCard && ui.srcLen > 0) break;
  await sleep(400);
}
check('设置界面有立绘卡片', ui.hasCard === true, JSON.stringify(ui).slice(0, 170));
check('卡片里的预览真的解码出了内置立绘', ui.natW === 1280, `natW=${ui.natW}`);
check(
  '卡片标了来源与尺寸',
  // 【为什么不再要求「内置 DeepSeek 娘」】卡片上加了一排表情格子之后，这条
  // 文字改说「**当前选中的那一格** + 图来自哪」（角色身份由页签和编辑器决定，
  // 不必在这儿重复）。"内置素材"这个关键区分还在，它才是这条断言要守的东西
  // —— 别把"内置"和"你传的"看混，那是主人唯一需要一眼分辨的事。
  /内置素材/.test(ui.meta || '') && /1280×1920/.test(ui.meta || ''),
  String(ui.meta),
);
check('没传图时「清除」是禁用的', ui.clearDisabled === true, `disabled=${ui.clearDisabled}`);
check('「显示立绘」开关是打开状态', ui.switchOn === true, `checked=${ui.switchOn}`);

// ── 开关链路：关掉 → 页面立绘收起来；再打开 → 回来 ────────────────
const flip = (on) =>
  evalIn(
    settings,
    `(() => { const sw = document.getElementById('st-avatar'); sw.checked = ${on}; sw.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`,
  );
const waitOpacity = async (want) => {
  for (let i = 0; i < 30; i++) {
    const raw = await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`);
    const a = raw ? JSON.parse(raw) : null;
    if (a && a.opacity === want) return true;
    await sleep(400);
  }
  return false;
};
await flip(false);
check('★ 设置里关掉开关 → 页面立绘真的收起来了（配置推送链路通）', await waitOpacity('0'));
await flip(true);
check('★ 再打开 → 立绘回来了', await waitOpacity('1'));

// ── 动效：待机呼吸 + 状态驱动 + 说话反应 ──────────────────────────
// 放在**开关测试之后**：这组会临时改 CFG.state，别让它污染前面的断言。
const pageHidden = (await evalIn(main, `document.hidden === true`)) === true;
let anim = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`));
check(
  '★ 立绘在呼吸（有动画对象，不是静止贴纸）',
  anim.anims > 0 && (pageHidden || anim.animState === 'running'),
  `hidden=${pageHidden} anims=${anim.anims} state=${anim.animState}`,
);
check(
  '呼吸参数来自状态（带档位 / 时长 / 幅度）',
  !!anim.breathTag && anim.breathDur > 2000 && anim.breathY > 0,
  `${anim.breathTag} ${anim.breathDur}ms ${anim.breathY}px`,
);

const setState = (patch) =>
  evalIn(
    main,
    `(() => { const c = window.__DSC_CFG__(); c.state = c.state || {};
       c.state.arousal = ${patch.arousal};
       c.state.body = Object.assign({}, c.state.body, { sleepiness: ${patch.sleepiness}, asleep: false });
       window.__DSC_AVATAR_REPOSE__(); return true; })()`,
  );

await setState({ arousal: 0.05, sleepiness: 0.9 });
await sleep(350);
const sleepy = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`));
await setState({ arousal: 1, sleepiness: 0 });
await sleep(350);
const lively = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`));
check(
  '★ 困的时候呼吸更慢（状态真的驱动了动效）',
  sleepy.breathDur > lively.breathDur,
  `困=${sleepy.breathDur}ms（${sleepy.breathTag}） vs 精神=${lively.breathDur}ms（${lively.breathTag}）`,
);
check(
  '困的时候幅度更大（慢而深 / 快而浅）',
  sleepy.breathY > lively.breathY,
  `困 ${sleepy.breathY}px vs 精神 ${lively.breathY}px`,
);

// 心情差 → 往下坠一点（很轻，但得有）
await evalIn(
  main,
  `(() => { const c = window.__DSC_CFG__(); c.state.valence = 0; window.__DSC_AVATAR_REPOSE__(); return true; })()`,
);
await sleep(250);
const sad = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`));
check('心情差时姿态往下坠', /translateY\(2px\)/.test(sad.pose || ''), sad.pose);

// ── 「她正在说话」的两个来源 ────────────────────────────────────────
check('★ XHR 观察已挂上（她回复时立绘才会动）', anim.talkHooked === true, `talkHooked=${anim.talkHooked}`);
check('常态下没在说话', anim.talking === false && anim.bubble === false && anim.speaking === false);

// 来源 A：页面上她正在回复（completion 请求在飞）。
// 真发一条消息要花钱 —— **链路归链路、状态机归状态机**：talkHooked 证明观察挂上了，
// 下面用探针验状态机与动效档位。
await evalIn(main, `window.__DSC_AVATAR_TALK__(true)`);
await sleep(500);
const talking = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`));
check(
  '★ 她说话时切成 talking 档（快而浅 + 左右摆）',
  talking.breathTag === 'talking' && talking.breathRot > 0,
  `${talking.breathTag} dur=${talking.breathDur} y=${talking.breathY} rot=${talking.breathRot}`,
);
check('★ 说话时立绘往前凑', /translateY\(-10px\)/.test(talking.pose || ''), talking.pose);
check(
  '★ 说话时**不**定住（静止是最不容易被察觉的）',
  pageHidden ? true : talking.animState === 'running',
  `state=${talking.animState}`,
);
check(
  '说话档比平静档更快、幅度更小（快而浅 = 在讲话）',
  talking.breathDur < anim.breathDur && talking.breathY < anim.breathY,
  `talking ${talking.breathDur}ms/${talking.breathY}px vs 平静 ${anim.breathDur}ms/${anim.breathY}px`,
);

// 来源 B：气泡（只在空闲主动搭话时弹）
await evalIn(
  main,
  `(() => { window.__DSC_AVATAR_TALK__(false); const s = document.getElementById('dsc-say');
     s.style.display = 'block'; s.style.opacity = '1'; return true; })()`,
);
await sleep(800);
const bubbled = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`));
check(
  '气泡弹出时也算说话',
  bubbled.bubble === true && bubbled.speaking === true && bubbled.breathTag === 'talking',
  `bubble=${bubbled.bubble} speaking=${bubbled.speaking} tag=${bubbled.breathTag}`,
);

await evalIn(
  main,
  `(() => { const s = document.getElementById('dsc-say'); s.style.opacity = '0'; s.style.display = 'none'; return true; })()`,
);
await sleep(1000);
const settled = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`));
check(
  '说完回到常态呼吸',
  settled.speaking === false && settled.breathTag !== 'talking',
  `tag=${settled.breathTag} speaking=${settled.speaking} pose=${settled.pose}`,
);

// ── 表情差分：变体选择 + 素材缺失时的回落 ────────────────────────────
const v0 = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`));
check('默认想要 neutral', v0.variant === 'neutral', `variant=${v0.variant}`);
check('Rust 会回报名单（设置界面与排查都用得上）', Array.isArray(v0.variants), JSON.stringify(v0.variants));

// 内置娘目前只生成了 neutral：请求别的变体必须**回落到 neutral**，而不是空白立绘
const fb = JSON.parse(
  await evalIn(
    main,
    `window.__TAURI_INTERNALS__.invoke('dsc_avatar_get', { id: null, variant: 'zzz-not-a-variant' })
       .then(v => JSON.stringify({ variant: v.variant, source: v.source, len: (v.dataUrl || '').length }))
       .catch(e => JSON.stringify({ err: String(e) }))`,
  ),
);
check(
  '★ 不认识的变体名会回落到 neutral（不会变空白立绘）',
  !fb.err && fb.variant === 'neutral' && fb.len > 100000,
  JSON.stringify(fb).slice(0, 140),
);

const setMood = (p) =>
  evalIn(
    main,
    `(() => { const c = window.__DSC_CFG__(); c.state = c.state || {};
       c.state.mood = ${JSON.stringify(p.mood)};
       c.state.valence = ${p.valence}; c.state.arousal = ${p.arousal};
       c.state.body = Object.assign({}, c.state.body, ${JSON.stringify(p.body)});
       window.__DSC_AVATAR_REPOSE__(); return true; })()`,
  );

await setMood({
  mood: '炸毛',
  valence: -0.8,
  arousal: 0.8,
  body: { asleep: false, sleepiness: 0.1, heartRate: 72, warmth: 0.4 },
});
await sleep(800);
const vAngry = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`));
check(
  '★ 炸毛时要 angry 那张',
  vAngry.variant === 'angry',
  `想要=${vAngry.variant} 实得=${vAngry.usedVariant}`,
);

await setMood({
  mood: '雀跃',
  valence: 0.8,
  arousal: 0.9,
  body: { asleep: false, sleepiness: 0.05, heartRate: 74, warmth: 0.5 },
});
await sleep(800);
const vSmug = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`));
check(
  '★ 心情好又兴奋 → smug（得意）',
  vSmug.variant === 'smug',
  `想要=${vSmug.variant} 实得=${vSmug.usedVariant}`,
);

// 身体层必须盖过心情：明明睡着了，不该还在笑
await setMood({ mood: '雀跃', valence: 0.8, arousal: 0.9, body: { asleep: true, sleepiness: 0.9 } });
await sleep(800);
const vSleep = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`));
check(
  '★ 睡着了就 sleepy（身体层盖过心情）',
  vSleep.variant === 'sleepy',
  `想要=${vSleep.variant}（mood 写的是"雀跃"）`,
);

// 脸红心跳 = 被撩到 → shy（这条不看心情，只看身体）
await setMood({
  mood: '平静',
  valence: 0.2,
  arousal: 0.6,
  body: { asleep: false, sleepiness: 0.1, heartRate: 104, warmth: 0.72 },
});
await sleep(800);
const vShy = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`));
check('★ 心跳快 + 体温高 → shy（被撩到）', vShy.variant === 'shy', `想要=${vShy.variant}`);

// 素材齐了之后，这三条才是重点：**真的切过去了**，而不是回落 neutral
check(
  '★ 内置娘现在有全套差分（7 张都认到了）',
  v0.variants.length === 7 && v0.variants.includes('smug') && v0.variants.includes('shy'),
  JSON.stringify(v0.variants),
);
check(
  '★ 变体真的切过去了（实得 = 想要，不是回落）',
  vAngry.usedVariant === 'angry' &&
    vSmug.usedVariant === 'smug' &&
    vSleep.usedVariant === 'sleepy' &&
    vShy.usedVariant === 'shy',
  `angry=${vAngry.usedVariant} smug=${vSmug.usedVariant} sleepy=${vSleep.usedVariant} shy=${vShy.usedVariant}`,
);

// ── 页面上的立绘开关（不用翻设置翻到「状态」页） ──────────────────────
const eye = JSON.parse(
  await evalIn(
    main,
    `(() => { const el = document.getElementById('dsc-avatar-eye');
       return JSON.stringify({ mounted: !!el, text: el ? el.textContent : '', title: el ? el.title : '' }); })()`,
  ),
);
check('页面上有立绘开关（眼睛图标）', eye.mounted === true, JSON.stringify(eye));
check('图标显示的是"显示中"（实心）', eye.text === '◉', `${eye.text} / ${eye.title}`);

// 真点一下 → 立绘收起，**并且配置真的落盘**（不只是页面状态变了）
await evalIn(main, `(() => { document.getElementById('dsc-avatar-eye').click(); return true; })()`);
await sleep(1000);
const offState = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`));
const cfgOff = await evalIn(
  main,
  `window.__TAURI_INTERNALS__.invoke('dsc_get_config').then(c => String(c.avatarEnabled))`,
);
check(
  '★ 点一下 → 立绘收起，且配置真的落盘了',
  offState.opacity === '0' && cfgOff === 'false',
  `opacity=${offState.opacity} cfg.avatarEnabled=${cfgOff}`,
);

// 再点回来 → 立绘与配置都回来
await evalIn(main, `(() => { document.getElementById('dsc-avatar-eye').click(); return true; })()`);
await sleep(1000);
const onState = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_AVATAR__())`));
const cfgOn = await evalIn(
  main,
  `window.__TAURI_INTERNALS__.invoke('dsc_get_config').then(c => String(c.avatarEnabled))`,
);
check(
  '★ 再点一下 → 回来（配置也回来了）',
  onState.opacity === '1' && cfgOn === 'true',
  `opacity=${onState.opacity} cfg.avatarEnabled=${cfgOn}`,
);

// ── 截图（给主人肉眼看的） ────────────────────────────────────────
try {
  const shot = await send(main, 'Page.captureScreenshot', { format: 'png' });
  const out = join(here, '..', 'preview', 'avatar-stage.png');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`\n[shot] ${out}`);
} catch (e) {
  console.log(`\n[shot] 聊天页截图失败：${e}`);
  failed++;
}
try {
  const shot2 = await send(settings, 'Page.captureScreenshot', { format: 'png' });
  const out2 = join(here, '..', 'preview', 'avatar-settings.png');
  writeFileSync(out2, Buffer.from(shot2.data, 'base64'));
  console.log(`[shot] ${out2}`);
} catch (e) {
  console.log(`[shot] 设置页截图失败：${e}`);
}

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
