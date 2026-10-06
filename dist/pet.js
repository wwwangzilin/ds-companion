/* 桌宠页面（纯原生，无构建步骤）。
 *
 * 【它为什么不跟页面里那份立绘共用代码】页面那份（inject.js 的 AVATAR）跑在远程
 * DeepSeek 页面里，手上有一整套每轮都在动的 CFG（身体层、心跳、活动、HUD、出戏…）。
 * 这里是个 200×344 的透明小窗，只要"谁、哪张图、正在干什么"三件事。
 * 共用的部分是**判定**（哪张差分）—— 那个在壳里算，见 pet.rs 的 variant_of。
 *
 * 【为什么要交叉淡入】差分是整张换的，直接换 src 会"啪"地跳一下；两张图层叠着
 * 淡入淡出才像表情变了。旧图不动到新图加载完，中间不会闪白。
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

async function tick() {
  let s;
  try {
    s = await invoke('dsc_pet_state', { have: shownKey || null });
  } catch (e) {
    return; // 壳还没起来 / 命令还没注册：下一拍再来
  }
  if (!s || !s.enabled) return; // 开关关着时窗口本来就该被关掉

  if (s.dataUrl && s.key !== shownKey) {
    shownKey = s.key;
    crossFade(s.dataUrl);
  }
  const text = String(s.activity || '').trim();
  $('bubble-text').textContent = text;
  $('bubble').classList.toggle('off', !text);
  document.body.classList.toggle('asleep', !!s.asleep);

  // 验收脚本要能问"现在画出来的是谁、哪个表情"—— 别让它去猜图片内容
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
    now: s.now,
  };
}

window.__DSC_PET_TICK__ = tick;

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
