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

  if (videoMode) {
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
