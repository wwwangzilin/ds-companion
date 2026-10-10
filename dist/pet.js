/* 桌宠页面（纯原生，无构建步骤）。
 *
 * 【它为什么不跟页面里那份立绘共用代码】页面那份（inject.js 的 AVATAR）跑在远程
 * DeepSeek 页面里，手上有一整套每轮都在动的 CFG（身体层、心跳、活动、HUD、出戏…）。
 * 这里是个 200×344 的透明小窗，只要"谁、哪张图 / 哪段动作、正在干什么"三件事。
 * 共用的部分是**判定**（哪张差分）—— 那个在壳里算，见 pet.rs 的 variant_of。
 *
 * 【为什么要交叉淡入】差分是整张换的，直接换 src 会"啪"地跳一下；两张图层叠着
 * 淡入淡出才像表情变了。旧图不动到新图加载完，中间不会闪白。
 *
 * 【两条路都留着】`img` 那对是立绘（一张图交叉淡入）；`video` 那对是**动作素材**
 * （透明 webm，从 dsh-pet 摘的，MIT，见仓库根 NOTICE）。壳那边 `clips` 非空才走视频 ——
 * "没下素材"是常态之一，不能因为少了它就白屏。
 */

const $ = (id) => document.getElementById(id);

function invoke(cmd, args) {
  const t = window.__TAURI__;
  if (t && t.core && t.core.invoke) return t.core.invoke(cmd, args);
  if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
    return window.__TAURI_INTERNALS__.invoke(cmd, args);
  }
  return Promise.reject(new Error('找不到 Tauri IPC'));
}

// ─────────────────────── 立绘那条路 ───────────────────────
/** 手上这张图是哪一张（`<id>|<差分>|<版本>`）。回传给壳，一样就不重复下载。 */
let shownKey = '';
/** 现在显示的是哪一层（a / b 交替，用来做交叉淡入） */
let front = 'a';

function crossFade(url) {
  const next = front === 'a' ? $('layer-b') : $('layer-a');
  const shown = front === 'a' ? $('layer-a') : $('layer-b');
  const flip = () => {
    next.classList.add('on');
    shown.classList.remove('on');
    front = front === 'a' ? 'b' : 'a';
  };
  next.onload = flip;
  // 图挂了也要把旧的撤下去，否则会永远停在上一个表情（而且看不出是坏了）
  next.onerror = flip;
  next.src = url;
}

// ─────────────────────── 动作素材那条路 ───────────────────────
//
// 【为什么名字写死在这】这两个名字来自 dsh-pet 的 `assets/config.jsonc`（`animations.idle`
// 与 `animations.clicks`），而 `tools/fetch-pet-assets.mjs` 下的就是这几个 —— 一边下、
// 一边播，对不上就是"下了却永远播不到"。改那边要跟着改这里。
const CLIP_IDLE = '待机呼吸休闲';
const CLIP_REACTIONS = [
  '点击回应-开心跃动',
  '点击回应-害羞惊讶',
  '点击回应-傲娇生气',
  '点击回应-挠痒咯咯笑',
  '点击回应-元气挥手',
];

let clips = []; // 壳说有哪几段（空 = 没下过素材）
let clipUrl = {}; // 名字 → dataUrl（取到了）| false（取不到，别再试）| null（正在取）
let animFront = 'a';
/** 现在**真正在播**的那段（反应播完会回到待机） */
let playing = '';
/** 现在**想**播的那段 —— 异步取素材回来时靠它判断"还要不要播" */
let want = '';
/** 上一次看到的差分；变了就播一段"回应" */
let lastVariant = '';
let videoMode = false;

// ─────────────────────── 她本人有多大 ───────────────────────
//
// 【为什么不量 `#stage`】stage 是 200×300 的盒子，而 640×360 的素材按 `object-fit: contain`
// 缩进去只占盒子中间那一条 —— **盒子的几何不是她的几何**。实测那张帧里她只占 214×269
// （整帧的 33%×75%），照盒子缩放等于把她缩成 67×85 的小不点，气泡还孤零零飘在窗口顶上。
//
// 【为什么扫 alpha】素材四面都是透明留白，只有像素自己知道她在哪。把当前那一帧画进
// 离屏 canvas，扫一遍非透明像素求外接矩形 —— 这是唯一"眼见为实"的口径。
//
// 【为什么连采几帧取并集】待机那段有 10 秒长，姿势一直在动（实测同一段素材里她的
// 外接矩形前后差 8px 多）。只量一帧会量到一个"收着"的姿势，等她张开手臂就顶出窗口、
// 被切掉一块。并集只会偏大一点，而偏大只是让她稍微站低一点，偏小才是真出事。
//
// 【为什么边量边改】等满一整圈再定位的话，前 10 秒她得先以旧尺寸（67px 高的小不点）
// 站着、然后"啪"地跳一下。并集是单调变大的，量到新的边界就顺手更新一次 —— 收敛在
// 一圈之内，中间每次变化都只有几个像素。
//
// 【量不出来就退回老样子】canvas 万一被判污染、视频还没出帧…… 一律不加 `.fitted`：
// 宁可小，也不能白屏或者把她裁掉半个。
const FIT = {
  everyMs: 300, // 采样间隔
  maxMs: 12000, // 最多量这么久（素材没报时长时的兜底）
  padW: 14, // 左右留白：姿势会往外张，贴着窗口边就容易切到
  padH: 8, // 头顶留白
  padB: 4, // 脚底留白
  minPct: 0.02,
  maxPct: 0.95,
};
let fitGeom = null; // 量出来之后：{ cw, ch, s } —— 内容尺寸（帧坐标）与缩放系数
let fitTimer = null;
let fitBox = null; // 已经写进 CSS 的那个矩形（帧坐标）
let fitSamples = 0;
let fitStopped = false;
let fitCanvas = null;

/** 现在露在外面的那一层（要量的是"正在播的那一个"，不是固定的 a） */
function frontAnim() {
  const a = $('anim-a');
  return a.classList.contains('on') ? a : $('anim-b');
}

/** 扫 alpha 求非透明像素的外接矩形（帧坐标）。取不到可用的帧 → null。 */
function alphaBox(v) {
  const w = v.videoWidth;
  const h = v.videoHeight;
  if (!w || !h || v.readyState < 2) return null;
  if (!fitCanvas) fitCanvas = document.createElement('canvas');
  if (fitCanvas.width !== w || fitCanvas.height !== h) {
    fitCanvas.width = w;
    fitCanvas.height = h;
  }
  const ctx = fitCanvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(v, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let hit = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        hit++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!hit) return null;
  const pct = hit / (w * h);
  // 几乎全透明（等于没画面）或几乎不透明（多半是解码出了底色，不是她）—— 都不可信
  if (pct < FIT.minPct || pct > FIT.maxPct) return null;
  return { minX, minY, maxX, maxY, hit };
}

/** b 有没有跑到 a 的外面去（哪怕一条边）——"还要不要再摆一次"的判据 */
function grewOutside(a, b) {
  if (!a) return true;
  return b.minX < a.minX || b.minY < a.minY || b.maxX > a.maxX || b.maxY > a.maxY;
}

function unionBox(a, b) {
  if (!a) return b;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function syncFitClasses() {
  const on = videoMode && !!fitGeom;
  $('stage').classList.toggle('fitted', on);
  document.body.classList.toggle('fitted', on);
}

/** 把素材摆正：她本人撑满窗口宽、脚底贴舞台底（留一点边，姿势外张时不会切到她）。 */
function applyFit(box, v) {
  const stage = $('stage');
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const cw = box.maxX - box.minX + 1;
  const ch = box.maxY - box.minY + 1;
  const s = Math.min((sw - FIT.padW) / cw, (sh - FIT.padH - FIT.padB) / ch);
  if (!(s > 0) || !isFinite(s)) return false;
  const st = stage.style;
  st.setProperty('--anim-w', (v.videoWidth * s).toFixed(1) + 'px');
  st.setProperty('--anim-h', (v.videoHeight * s).toFixed(1) + 'px');
  st.setProperty('--anim-left', ((sw - cw * s) / 2 - box.minX * s).toFixed(1) + 'px');
  st.setProperty('--anim-top', (sh - FIT.padB - (box.maxY + 1) * s).toFixed(1) + 'px');
  const rt = document.documentElement.style;
  // 她头顶离窗口底边多远 —— 气泡就挂在这个高度的上面（见 pet.css 的 body.fitted）
  rt.setProperty('--pet-head', (FIT.padB + ch * s).toFixed(1) + 'px');
  rt.setProperty('--pet-w', (cw * s).toFixed(1) + 'px');
  fitGeom = { cw, ch, s };
  syncFitClasses();
  return true;
}

/** 待机那段一出来就开始量：一整圈里每隔 FIT.everyMs 采一帧，外接矩形取并集。 */
function startFitProbe() {
  if (fitStopped || fitTimer || !videoMode) return;
  const v = frontAnim();
  if (v.readyState < 2 || !v.videoWidth) return;
  const span = Math.min(Math.max((v.duration || 0) * 1000 + 400, 2000), FIT.maxMs);
  const t0 = Date.now();
  let bad = 0;
  fitTimer = setInterval(() => {
    // 采样期间素材可能被换掉（一段"回应"插了进来）—— 那一帧不算数，否则量到别人的姿势
    if (v.classList.contains('on') && playing === CLIP_IDLE) {
      let box = null;
      try {
        box = alphaBox(v);
      } catch (e) {
        bad++; // 多半是 canvas 被判污染：这条路走不通，别再重试
      }
      if (box) {
        fitSamples++;
        const merged = unionBox(fitBox, box);
        if (grewOutside(fitBox, merged) && applyFit(merged, v)) fitBox = merged;
      }
    }
    if (bad >= 2 || Date.now() - t0 >= span) {
      clearInterval(fitTimer);
      fitTimer = null;
      fitStopped = true; // 一圈量完了（素材是静态的，不会自己再变大）
    }
  }, FIT.everyMs);
}

/** 一段动作播完了（非循环的那种）→ 回到待机 */
function backToIdle() {
  playing = '';
  ensureClip(CLIP_IDLE, true);
}

/** 把 `name` 那段放上图层交叉淡入。loop=true 是待机那种一直播的。 */
function startClip(name, loop) {
  const next = animFront === 'a' ? $('anim-b') : $('anim-a');
  const shown = animFront === 'a' ? $('anim-a') : $('anim-b');
  next.loop = !!loop;
  // 反应播完自己回待机；待机是循环的，没有"播完"这回事
  next.onended = loop ? null : backToIdle;
  next.oncanplay = () => {
    const p = next.play();
    if (p && p.catch) p.catch(() => {});
    next.classList.add('on');
    shown.classList.remove('on');
    animFront = animFront === 'a' ? 'b' : 'a';
    playing = name;
    want = ''; // 想播的已经播上了，别再拦着下一段
    // 待机那段一出来就顺便量一下她有多大（气泡要贴着她的头，见 FIT 那一段）
    if (name === CLIP_IDLE) startFitProbe();
  };
  next.src = clipUrl[name];
}

/** 想播某一段；素材没取过就先取（壳那边有缓存，第二次就是内存里的）。 */
function ensureClip(name, loop) {
  if (!name) return;
  // 待机已经在播了就别重来一遍 —— 重设 src 会让它从第一帧跳回去，看着像卡了一下
  if (loop && playing === CLIP_IDLE) return;
  want = name;
  const url = clipUrl[name];
  if (url === undefined) {
    clipUrl[name] = null;
    invoke('dsc_pet_clip', { name })
      .then((r) => {
        clipUrl[name] = r && r.ok ? r.dataUrl : false;
        if (!clipUrl[name]) {
          // 取不到就别一直挂着 —— 挂着的话待机那段会被 `!want` 拦在门外
          if (want === name) want = '';
          return;
        }
        if (want === name) startClip(name, loop);
      })
      .catch(() => {
        clipUrl[name] = false;
        if (want === name) want = '';
      });
    return;
  }
  if (url) startClip(name, loop);
  else if (want === name) want = '';
}

// ─────────────────────── 一拍 ───────────────────────
async function tick() {
  let s;
  try {
    s = await invoke('dsc_pet_state', { have: shownKey || null });
  } catch (e) {
    return; // 壳还没起来 / 命令还没注册：下一拍再来
  }
  if (!s || !s.enabled) return; // 开关关着时窗口本来就该被关掉

  // ── 走哪条路 ──
  clips = Array.isArray(s.clips) ? s.clips : [];
  videoMode = clips.indexOf(CLIP_IDLE) >= 0;
  $('stage').classList.toggle('video', videoMode);
  syncFitClasses();

  if (videoMode) {
    // 量一次她有多大（内部自带"量过了就不再来"的开关）。量不到就不加 `.fitted`，
    // 气泡会停在立绘那套位置、她也还是按整帧缩的小样子，虽然不好看，但不会错位到别处
    startFitProbe();
    // 【`!want` 这一半不能少】只写 `!playing` 的话，一段"回应"正在取素材的空档里这一拍会
    // 顺手去请求待机，把 `want` 覆盖掉 —— 回应加载回来一看"想播的不是我了"就自己放弃，
    // 表现成"点了没反应"。这个竞态是验收脚本抓出来的（点播 1.5 秒后还在播待机）。
    if (!playing && !want) ensureClip(CLIP_IDLE, true);
    // 【第一根线】她的差分一变，就从动作池里抽一段播一次 —— 这是 ds-companion 自己那套
    // 心情/身体状态接上 dsh-pet 那个动作池的地方（将来要接的是"她此刻在干什么"那些池）。
    if (lastVariant && s.variant !== lastVariant) {
      const pool = CLIP_REACTIONS.filter((n) => clips.indexOf(n) >= 0);
      if (pool.length) ensureClip(pool[Math.floor(Math.random() * pool.length)], false);
    }
    lastVariant = s.variant;
  } else if (s.dataUrl && s.key !== shownKey) {
    shownKey = s.key;
    crossFade(s.dataUrl);
  }

  const text = String(s.activity || '').trim();
  $('bubble-text').textContent = text;

  // 「她看见你屏幕上的东西，顺口说一句」—— 那句话有保鲜期：超过 5 分钟就不摆了
  //（不然你半小时后瞥一眼桌宠，她还挂着一句你早就不在看的东西）
  const say = String(s.say || '').trim();
  const sayAt = Number(s.sayAt) || 0;
  const fresh = !!say && sayAt > 0 && Number(s.now || Date.now()) - sayAt < 5 * 60 * 1000;
  $('say-text').textContent = say;
  $('say').classList.toggle('on', fresh);
  // 有话说的时候把"正在做的事"收起来 —— 一次只说一件事
  $('bubble').classList.toggle('off', !text || fresh);
  document.body.classList.toggle('asleep', !!s.asleep);

  // 验收脚本要能问"现在画出来的是谁、哪张差分 / 哪段动作"—— 别让它去猜
  const v = $('anim-a').classList.contains('on') ? $('anim-a') : $('anim-b');
  window.__DSC_PET_VIEW__ = {
    key: shownKey,
    id: s.id,
    name: s.name,
    variant: s.variant,
    actual: s.actual,
    source: s.source,
    activity: text,
    mood: s.mood,
    asleep: !!s.asleep,
    corner: s.corner,
    say,
    sayFresh: fresh,
    now: s.now,
    // ── 动作素材这条路 ──
    mode: videoMode ? 'video' : 'png',
    clips: clips.length,
    clip: playing,
    // 视频有没有**真的**解出画面（`readyState >= 2` 才有当前帧；
    // videoWidth > 0 才说明尺寸也拿到了 —— "DOM 里有 video"证明不了它在放）
    readyState: v.readyState,
    videoW: v.videoWidth,
    videoH: v.videoHeight,
    // ── 她本人被摆成多大（量出来之后才有）──
    // 【为什么要把这个报出来】气泡的位置是从 `--pet-head` 推出来的，验收要能一眼
    // 看出"量到了没有、量成了多大"，而不是拿 DOM 里有没有 `.fitted` 当证据。
    fitted: videoMode && !!fitGeom,
    fit: fitGeom
      ? {
          w: +(fitGeom.cw * fitGeom.s).toFixed(1),
          h: +(fitGeom.ch * fitGeom.s).toFixed(1),
          samples: fitSamples,
        }
      : null,
  };
}

window.__DSC_PET_TICK__ = tick;
// 验收用：直接点播一段动作（和右键菜单/状态触发走的是同一个 ensureClip）。
// 不加这个的话"反应那段"就只能靠真去改角色状态才能验，脚本没法造。
window.__DSC_PET_PLAY__ = function (name, loop) {
  playing = '';
  want = '';
  ensureClip(String(name || ''), !!loop);
};
/* 验收用：动作层的**实时**状态。
 *
 * 【为什么不复用 `__DSC_PET_VIEW__`】那个是 tick 时拍下来的快照 —— 点播一段动作不会
 * 触发 tick，于是快照里还写着上一段。验收脚本拿它去断言"反应在播"，只会得到一句
 * 假失败（本小姐就被自己这个快照骗过一轮：DOM 上明明已经换层了，快照还说没变）。
 * 要问"此刻在播什么"，就得问活的。 */
window.__DSC_PET_ANIM__ = function () {
  const a = $('anim-a');
  const b = $('anim-b');
  const on = a.classList.contains('on') ? a : b;
  return {
    playing,
    want,
    front: animFront,
    mode: videoMode ? 'video' : 'png',
    clips: clips.length,
    fitted: videoMode && !!fitGeom,
    loaded: Object.keys(clipUrl).filter((k) => !!clipUrl[k]).length,
    layerA: { on: a.classList.contains('on'), readyState: a.readyState, w: a.videoWidth },
    layerB: { on: b.classList.contains('on'), readyState: b.readyState, w: b.videoWidth },
    onReadyState: on.readyState,
    onWidth: on.videoWidth,
  };
};

// 状态一变壳会主动叫一声（push_config 那条路）；60 秒的兜底是防"事件丢了就永远不动"。
const ev = window.__TAURI__ && window.__TAURI__.event;
if (ev && typeof ev.listen === 'function') {
  ev.listen('dsc:pet', () => {
    tick();
  });
}
setInterval(() => {
  tick();
}, 60000);

tick();
