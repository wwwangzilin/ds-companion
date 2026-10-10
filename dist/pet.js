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
// 【为什么待机那个名字写死在这】所有池子都从壳里来（见下面的「动作池」），只有待机这一段
// 是**兜底**：素材还没取回来、或者池子里没配待机时，总得有东西可播。这个名字来自
// dsh-pet 的 `assets/config.jsonc`，`tools/fetch-pet-assets.mjs` 下的就是它 —— 一边下、
// 一边播，对不上就是"下了却永远播不到"。改那边要跟着改这里。
const CLIP_IDLE = '待机呼吸休闲';

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

// ─────────────────────── 动作池 / 掷骰 / 右键菜单 ───────────────────────
//
// 【池子为什么从壳里来】池子的事实来源是上游 dsh-pet 的 `assets/config.jsonc`
// （idle/turn/drag/clicks/moves/categories/events + 权重），那份被抄进了
// `src-tauri/assets/pet-pools.json`。壳读它、**过滤到本地真装了的素材**再发下来 ——
// 菜单里出现点不动的名字比没有菜单更糟（上游注释：名字即文件名，404 → 点了没反应）。
// 页面只管"抽哪一段、什么时候抽"，池子的账目不在这里。
let pools = null;
/** 她接不接鼠标（配置 `petInteract`）：影响命中框上报和右键菜单 */
let interactOn = true;
/** 她自己动不动（配置 `petWander`）：关掉就只有待机 + 主人触发的那几段 */
let wanderOn = true;
/** 她的朝向。素材原样朝左；朝右 = 镜像（见 pet.css 的 `#stage.flip`）。 */
let facing = 'left';
/** 正在播"被主人触发的那一段"（点一下 / 拖动 / 差分变化）—— 这时随机链让路 */
let reacting = false;
let chainTimer = null;
let dragTimer = null;
/** 各段素材有多长（秒）。第一次播之前是不知道的，取不到就按 3 秒算。 */
const clipDur = {};
/** 上一次"工作状态"（events.workStatus 用） */
let lastStage = '';

const poolList = (k) => (pools && Array.isArray(pools[k]) ? pools[k] : []);

/** 等概率抽一个；`exclude` 用来避免连续重复（上游 `pick` 的同款语义：排除后池空就退回原池） */
function pick(pool, exclude) {
  if (!pool || !pool.length) return null;
  const src = exclude ? pool.filter((n) => n !== exclude) : pool;
  const use = src.length ? src : pool;
  return use[Math.floor(Math.random() * use.length)];
}

/** 事件档位取值：字符串槽位原样返回（固定播），数组槽位 = 档内候选随机抽 */
function pickSlot(slot, exclude) {
  if (typeof slot === 'string') return slot;
  if (!Array.isArray(slot) || !slot.length) return null;
  const src = exclude ? slot.filter((n) => n !== exclude) : slot;
  const use = src.length ? src : slot;
  return use[Math.floor(Math.random() * use.length)];
}

/** 按权重抽一个"随机动作"分类；带文字的那一类（noMirror）在朝右时不播（镜像会把字翻过来） */
function pickCategory(cats, facingNow) {
  const use = (cats || []).filter((c) => c && Array.isArray(c.actions) && c.actions.length);
  if (!use.length) return null;
  const filtered = use.filter((c) => !(c.noMirror && facingNow === 'right'));
  const pool = filtered.length ? filtered : use;
  const total = pool.reduce((s, c) => s + (Number(c.weight) || 0), 0) || 1;
  let t = Math.random() * total;
  for (const c of pool) {
    t -= Number(c.weight) || 0;
    if (t <= 0) return c;
  }
  return pool[pool.length - 1];
}

/** 掷骰：下一段该播哪一类（上游 `rollKind` 的同款口径，权重之和不必是 100） */
function rollKind() {
  const w = (pools && pools.weight) || { idle: 10, turn: 5, move: 5 };
  const idle = Number(w.idle) || 0;
  // 关掉"自己动"时把转向/移动两档按 0 算 —— 它们的份额自然落到"原地随机动作"，
  // 与上游 fixedEnabled 的处理一致（不归一化，idle 的绝对概率原样不动）
  const turn = wanderOn ? Number(w.turn) || 0 : 0;
  const move = wanderOn ? Number(w.move) || 0 : 0;
  const r = Math.random() * 100;
  if (r < idle) return 'idle';
  if (r < idle + turn) return 'turn';
  if (r < idle + turn + move) return 'move';
  return 'action';
}

/** 朝左/朝右（朝右是镜像）。立绘那条路不翻 —— 那是整幅画，翻了看着像印错了。 */
function setFacing(f) {
  facing = videoMode && f === 'right' ? 'right' : 'left';
  $('stage').classList.toggle('flip', facing === 'right');
}

/** 走一步的距离系数：上游的距离以「基准宠物宽 462px」为准，按**她本人**的宽度等比缩放。
 *  她的宽度 = 帧里内容宽 × 缩放系数，所以系数化简成 `s × 640 / 462`（s = 帧→CSS 的缩放）。
 *  量不出她多大（fit 失败）时按 1 算 —— 宁可步子偏大，也不要走不动。 */
function moveScale() {
  if (!fitGeom) return 1;
  return (fitGeom.s * 640) / 462;
}

/** 一段素材多长（秒）；没取过就 0 */
function clipDuration(name) {
  return Number(clipDur[name]) || 0;
}

function busyMenu() {
  return $('menu') && $('menu').classList.contains('on');
}

// ── 随机链：她自己在待机/转头/走两步/做个小动作之间自己切 ──
function scheduleChain(ms) {
  clearTimeout(chainTimer);
  chainTimer = null;
  if (!videoMode || !pools) return;
  chainTimer = setTimeout(chainStep, Math.max(300, ms));
}

function chainStep() {
  chainTimer = null;
  if (!videoMode || !pools || reacting || busyMenu()) return;
  const kind = rollKind();
  if (kind === 'idle') {
    // 待机是一直播的，没有"播完"，所以隔一会儿再掷一次
    ensureClip(pick(poolList('idle'), playing) || CLIP_IDLE, true);
    scheduleChain(6000 + Math.random() * 9000);
    return;
  }
  if (kind === 'turn') {
    const name = pick(poolList('turn'), playing);
    if (name) {
      ensureClip(name, false);
      return; // 播完在 clipFinished 里翻朝向，再继续掷
    }
  } else if (kind === 'move') {
    if (startMove()) return;
  } else {
    const cat = pickCategory(pools.categories, facing);
    const name = (cat && pick(cat.actions, playing)) || pick(poolList('idle'), playing);
    if (name) {
      ensureClip(name, false);
      return;
    }
  }
  scheduleChain(1500);
}

/** 挑一段"走"的动作：距离、朝向、什么时候真把窗口挪过去 */
function startMove() {
  const moves = (pools && pools.moves) || {};
  const acts = Array.isArray(moves.actions) ? moves.actions : [];
  const def = moves.default || { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 };
  const act = pick(acts.filter((a) => a && a.name));
  if (!act) return false;
  const p = Object.assign({}, def, act.params || {});
  const dir = Math.random() < 0.5 ? -1 : 1;
  const min = Number(p.minDist) || 60;
  const max = Math.max(min, Number(p.maxDist) || 240);
  const dist = (min + Math.random() * (max - min)) * moveScale();
  const lead = Math.max(0, Number(p.leadSec) || 0) * 1000;
  const tail = Math.max(0, Number(p.tailSec) || 0) * 1000;
  const dur = clipDuration(act.name) * 1000 || 3000;
  const walkMs = Math.max(400, dur - lead - tail);
  setFacing(dir < 0 ? 'left' : 'right');
  reacting = true;
  ensureClip(act.name, false);
  // 动画开头是"起步"的那几秒：先原地站住，到点了再把窗口平移过去
  setTimeout(() => {
    invoke('dsc_pet_walk', { dx: dir * dist, ms: walkMs }).catch(() => {});
  }, lead);
  return true;
}

/** 一段（非循环）播完了 */
function clipFinished(name) {
  playing = '';
  if (name && poolList('turn').indexOf(name) >= 0) {
    // 上游口径：转向那一段演完**才**翻朝向
    setFacing(facing === 'right' ? 'left' : 'right');
  }
  reacting = false;
  if (pools) ensureClip(pick(poolList('idle'), playing) || CLIP_IDLE, true);
  scheduleChain(600 + Math.random() * 1200);
}

/** 主人触发的那一段（点一下 / 落地 / 右键点播） */
function reactClip(name, pool, loop) {
  const n = name || pick(poolList(pool), playing);
  if (!n) return;
  reacting = true;
  ensureClip(n, !!loop);
}

/** 工作状态档位 → `events.workStatus[index]`。
 *  档位顺序取自上游（勿在中间插档，插了含义就全错位）：
 *  0 思考 / 1 干活 / 2 整理 / 3 等你确认 / 4 搞定 / 5 出错。 */
const WORK_STAGE_INDEX = { thinking: 0, working: 1, result: 2, waiting: 3, success: 4, error: 5 };

function playWorkStatus(stage) {
  const idx = WORK_STAGE_INDEX[stage];
  if (idx === undefined) return;
  const pool = (pools && pools.events && pools.events.workStatus) || [];
  const name = pickSlot(pool[idx], playing);
  if (name) reactClip(name, null, false);
}

// ── 右键菜单：三级（分类 → 分类名 → 动作），自己画，不用系统菜单 ──
//
// 【为什么不用 Tauri 的原生菜单】桌宠窗只有 200×345，原生菜单会跑到窗口外面去，
// 而且样式跟这套暗色气泡完全不搭。自己画一层浮在她上面，还能顺着她的尺寸走。
let menuPath = [];

function rootMenuItems() {
  const items = [];
  const add = (label, names) => {
    if (names && names.length) items.push({ label, names });
  };
  add('待机', poolList('idle'));
  add('转向', poolList('turn'));
  add('拖动', poolList('drag'));
  add('点击回应', poolList('clicks'));
  add(
    '走动',
    (((pools || {}).moves || {}).actions || []).map((a) => a && a.name).filter(Boolean),
  );
  const cats = ((pools || {}).categories || []).filter((c) => c && c.actions && c.actions.length);
  if (cats.length) items.push({ label: '随机动作', cats });
  const evs = (pools && pools.events) || {};
  const evNames = [];
  for (const key of Object.keys(evs)) {
    for (const slot of evs[key] || []) {
      if (typeof slot === 'string') evNames.push(slot);
      else if (Array.isArray(slot)) evNames.push(...slot);
    }
  }
  if (evNames.length) items.push({ label: '事件', names: evNames });
  items.push({ label: '回角落', home: true });
  return items;
}

function menuShow() {
  if (!interactOn) return;
  menuPath = [{ title: '', items: rootMenuItems() }];
  renderMenu();
  $('menu').classList.add('on');
  // 菜单盖住了整个窗口：这期间命中框要报**整个窗口**，否则光标一离开她的身体，
  // 壳就把穿透打开，菜单立刻点不动了
  reportHitbox();
}

function menuHide() {
  menuPath = [];
  $('menu').classList.remove('on');
  $('menu').textContent = '';
  reportHitbox();
}

function renderMenu() {
  const box = $('menu');
  box.textContent = '';
  const level = menuPath[menuPath.length - 1];
  if (!level) return;
  if (menuPath.length > 1) {
    box.appendChild(menuRow('‹ ' + (level.title || '返回'), () => {
      menuPath.pop();
      renderMenu();
    }, 'back'));
  }
  for (const it of level.items) {
    box.appendChild(
      menuRow(it.label, () => {
        if (it.names) {
          menuPath.push({
            title: it.label,
            items: it.names.map((n) => ({ label: n, play: n })),
          });
          renderMenu();
        } else if (it.cats) {
          menuPath.push({
            title: '随机动作',
            items: it.cats.map((c) => ({ label: c.id, cat: c })),
          });
          renderMenu();
        } else if (it.cat) {
          menuPath.push({
            title: it.label,
            items: it.cat.actions.map((n) => ({ label: n, play: n })),
          });
          renderMenu();
        } else if (it.play) {
          menuHide();
          reactClip(it.play, null, false);
        } else if (it.home) {
          menuHide();
          invoke('dsc_pet_home').catch(() => {});
        }
      }),
    );
  }
}

function menuRow(label, onPick, extra) {
  const row = document.createElement('div');
  row.className = 'row' + (extra ? ' ' + extra : '');
  row.textContent = label;
  row.addEventListener('pointerdown', (e) => {
    // 菜单里按下不该被当成"抓住她"：这里拦掉，别让 pointerdown 冒到 document 上
    e.stopPropagation();
  });
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    onPick();
  });
  return row;
}

// ── 鼠标：拖她、点她、右键菜单 ──
//
// 【为什么要报 screenX/screenY】拖拽时窗口是**跟着光标走**的，光标相对窗口几乎不动，
// 页面可能一个 pointermove 都收不到 —— 用 clientX 判断"动了没"永远是"没动"。
// 屏幕上有没有动，只有 screenX/screenY 知道。
let downAt = null;
/** 验收用：页面到底收没收到鼠标（"点了没反应"要能一眼分清是没收还是没处理） */
window.__DSC_PET_INPUT__ = { down: 0, up: 0, move: 0, ctx: 0, last: '' };

function wireInput() {
  // 菜单开着的时候：点任何地方（包括她身上）都算"收起菜单"。
  // 【为什么必须有】菜单一开，命中框就按**整个窗口**报，壳于是不让鼠标穿过去；
  // 要是没有这条出口，主人点来点去都收不掉它，她会一直被一块板子盖着。
  document.addEventListener('pointerdown', (e) => {
    window.__DSC_PET_INPUT__.down++;
    window.__DSC_PET_INPUT__.last = 'down button=' + e.button;
    if (busyMenu()) {
      if (!e.target.closest('#menu')) menuHide();
      return;
    }
    if (e.button !== 0 || !interactOn) return;
    downAt = { x: e.screenX, y: e.screenY, t: Date.now(), moved: false };
    invoke('dsc_pet_grab', { ox: e.clientX, oy: e.clientY, down: true }).catch(() => {});
    clearTimeout(dragTimer);
    // 抓起来先别急着摆姿势：点一下不该闪出"被拎起来"的样子
    dragTimer = setTimeout(() => {
      if (downAt && downAt.moved) reactClip(null, 'drag', true);
    }, 160);
  });
  document.addEventListener('pointermove', (e) => {
    window.__DSC_PET_INPUT__.move++;
    if (!downAt) return;
    if (Math.abs(e.screenX - downAt.x) + Math.abs(e.screenY - downAt.y) > 4) downAt.moved = true;
  });
  document.addEventListener('pointerup', (e) => {
    window.__DSC_PET_INPUT__.up++;
    window.__DSC_PET_INPUT__.last = 'up moved=' + (downAt ? downAt.moved : '?');
    if (!downAt) return;
    const d = downAt;
    downAt = null;
    clearTimeout(dragTimer);
    invoke('dsc_pet_grab', { ox: 0, oy: 0, down: false })
      .then((r) => {
        window.__DSC_PET_INPUT__.verdict = r;
        window.__DSC_PET_INPUT__.dt = Date.now() - d.t;
        // 壳告诉我们这一下算"点了一下"还是"拖起来扔了"（它按窗口真的动了没有判）。
        // 判定放在壳里是因为**只有它知道窗口动没动** —— 窗口跟着光标走，页面看不出来。
        const moved = r && r.moved;
        const threw = r && r.threw;
        if (!moved && Date.now() - d.t < 400) {
          reactClip(null, 'clicks', false); // 点一下：抽一段回应
        } else if (threw) {
          // 甩出去了：等她落地那一刻再演（壳会发 dsc:pet-act）
          reacting = true;
        }
      })
      .catch(() => {});
  });
  document.addEventListener('contextmenu', (e) => {
    window.__DSC_PET_INPUT__.ctx++;
    e.preventDefault();
    if (!interactOn) return;
    // 菜单开着再右键一次 = 收起（不然"再点一下"会变成重画一遍，看着像没反应）
    if (busyMenu()) menuHide();
    else menuShow();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && busyMenu()) menuHide();
  });
}

/** 把"她身体的矩形"报给壳（壳按它决定吃不吃鼠标）。菜单开着时报整个窗口。 */
function reportHitbox() {
  if (!interactOn) return;
  if (busyMenu()) {
    invoke('dsc_pet_hitbox', { x: 0, y: 0, w: innerWidth, h: innerHeight }).catch(() => {});
    return;
  }
  const r = bodyRect();
  if (!r) return;
  invoke('dsc_pet_hitbox', r).catch(() => {});
}

/** 她身体在窗口里的矩形（CSS px）；量不出来就 null（那就不接手鼠标） */
function bodyRect() {
  const stage = $('stage').getBoundingClientRect();
  if (!videoMode) {
    // 立绘撑满舞台：整个舞台都是"她"
    return { x: stage.left, y: stage.top, w: stage.width, h: stage.height };
  }
  if (!fitGeom || !fitBox) return null;
  const r = frontAnim().getBoundingClientRect();
  const sc = Math.min(r.width / 640, r.height / 360);
  const ox = r.left + (r.width - 640 * sc) / 2;
  const oy = r.top + (r.height - 360 * sc) / 2;
  return {
    x: ox + fitBox.minX * sc,
    y: oy + fitBox.minY * sc,
    w: (fitBox.maxX - fitBox.minX + 1) * sc,
    h: (fitBox.maxY - fitBox.minY + 1) * sc,
  };
}

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
  // 她多大了（= 命中框）刚变，顺手告诉壳一声 —— 不然"点得到她"还停在旧尺寸上
  reportHitbox();
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

/** 一段动作播完了（非循环的那种）→ 收尾（回待机 / 翻朝向 / 继续掷骰），见 clipFinished */

/** 把 `name` 那段放上图层交叉淡入。loop=true 是待机那种一直播的。 */
function startClip(name, loop) {
  const next = animFront === 'a' ? $('anim-b') : $('anim-a');
  const shown = animFront === 'a' ? $('anim-a') : $('anim-b');
  next.loop = !!loop;
  // 反应/链子上那一段播完自己收尾；待机是循环的，没有"播完"这回事
  next.onended = loop ? null : () => clipFinished(name);
  // 时长只有播过一次才知道 —— 走步要用它算"什么时候该挪窗口"
  next.onloadedmetadata = () => {
    if (next.duration && isFinite(next.duration)) clipDur[name] = next.duration;
  };
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

  // ── 池子与两个行为开关 ──
  pools = s.pools && typeof s.pools === 'object' ? s.pools : null;
  wanderOn = s.wander !== false;
  const wasInteract = interactOn;
  interactOn = s.interact !== false;
  if (!videoMode) $('stage').classList.remove('flip');
  if (interactOn !== wasInteract || (!interactOn && busyMenu())) {
    if (!interactOn) menuHide();
    else reportHitbox();
  }
  // 工作状态档位（壳报的：thinking/working/result/waiting/success/error，空串 = 空闲）
  const stage = String(s.stage || '');

  if (videoMode) {
    // 量一次她有多大（内部自带"量过了就不再来"的开关）。量不到就不加 `.fitted`，
    // 气泡会停在立绘那套位置、她也还是按整帧缩的小样子，虽然不好看，但不会错位到别处
    startFitProbe();
    // 【`!want` 这一半不能少】只写 `!playing` 的话，一段"回应"正在取素材的空档里这一拍会
    // 顺手去请求待机，把 `want` 覆盖掉 —— 回应加载回来一看"想播的不是我了"就自己放弃，
    // 表现成"点了没反应"。这个竞态是验收脚本抓出来的（点播 1.5 秒后还在播待机）。
    if (!playing && !want && !reacting) ensureClip(CLIP_IDLE, true);
    // 【第一根线】她的差分一变，就从回应池里抽一段播一次 —— 这是 ds-companion 自己那套
    // 心情/身体状态接上 dsh-pet 那些动作池的地方。
    if (lastVariant && s.variant !== lastVariant && !downAt) reactClip(null, 'clicks', false);
    lastVariant = s.variant;
    // 【第二根线】工作状态档位（她正在替你干活时的样子）：壳一报新档位就播 events.workStatus
    if (stage && stage !== lastStage) playWorkStatus(stage);
    lastStage = stage;
    // 随机链：第一次拿到池子就起个头（之后自己一拍一拍往下走）
    if (!chainTimer && !reacting && !busyMenu()) scheduleChain(2500 + Math.random() * 3000);
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
    // ── 她自己多大（量出来之后才有）──
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
    // ── 她自己动这条链 ──
    facing,
    wander: wanderOn,
    interact: interactOn,
    reacting,
    stage,
  };
}

window.__DSC_PET_TICK__ = tick;
// 验收用：关掉右键菜单（走的是它**真实**的关闭路径 —— 菜单是页面自己画的一层，
// 用 Esc 之类的外部事件是关不掉的，脚本收尾必须调这个，否则会留一个盖住她的菜单）。
window.__DSC_PET_MENU_HIDE__ = menuHide;
// 验收用：直接点播一段动作（和右键菜单/状态触发走的是同一个 ensureClip）。
// 不加这个的话"反应那段"就只能靠真去改角色状态才能验，脚本没法造。
window.__DSC_PET_PLAY__ = function (name, loop) {
  playing = '';
  want = '';
  // 走 reactClip（= 右键菜单点播那条路）：她自己的随机链会让路，不然刚点的这段会被顶掉
  reactClip(String(name || ''), null, !!loop);
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
    facing,
    reacting,
    menu: busyMenu(),
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
  // 壳那套"手脚"报回来的事：她落地了（甩出去之后）→ 演一下摔懵的样子
  ev.listen('dsc:pet-act', (e) => {
    const kind = e && e.payload && e.payload.kind;
    if (kind === 'landed') reactClip(null, 'clicks', false);
  });
}
wireInput();
// 窗口尺寸一变（DPI 换了、显示器换了）命中框和气泡的锚点都要重报
window.addEventListener('resize', () => {
  reportHitbox();
});
setInterval(() => {
  tick();
}, 60000);

tick();
