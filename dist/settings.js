/* 设置界面逻辑（纯原生，无构建步骤） */

const $ = (id) => document.getElementById(id);

function invoke(cmd, args) {
  const t = window.__TAURI__;
  if (t && t.core && t.core.invoke) return t.core.invoke(cmd, args);
  if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
    return window.__TAURI_INTERNALS__.invoke(cmd, args);
  }
  return Promise.reject(new Error('找不到 Tauri IPC'));
}

let personas = [];
let current = null;
let cfg = { activePersona: null, cadence: 'first' };
let memories = [];
let memCurrent = null;
let memFilter = 'all';
let memImportance = 3;

/**
 * 改配置的唯一出口：**先读盘、再合并、后落盘**，只盖自己真正改了的字段。
 *
 * 为什么不能把内存里那份 cfg 整份提交：设置窗口可能开着很久，期间别的窗口
 * （或验收脚本、将来的自动流程）改了配置 —— 整份提交会把人家的改动悄悄回滚。
 * 实测被自己的验收脚本这么坑过一次：主人的「露娜 / 每轮」被打回「三千代 / 仅首条」。
 * 与 Quill 那条「persist 前先读盘」是同一类错误：读-改-写，永远不要盲写整份。
 */
// 写配置的串行队列（见 patchCfg 里的说明）。声明必须在函数之前：`let` 在声明执行前
// 处于暂时性死区，提前调用会直接 ReferenceError。
let cfgWriteChain = Promise.resolve();

async function patchCfg(patch) {
  // 【为什么还要一条队列】"读-改-写"只保证"不覆盖别人的改动"，保证不了**自己两次修改
  // 不互相覆盖**：两次调用挤在一起时，后一次读到的可能是前一次写盘之前那份 ——
  // 于是后一次会把前一次的改动一起带回去（实测：连着改安静时段的两个输入框，
  // 第一个框的值被第二个框的保存抹掉了）。串行化就够：前一次写完，后一次再读再写。
  const run = cfgWriteChain.then(async () => {
    const fresh = await invoke('config_get');
    cfg = { ...fresh, ...patch };
    await invoke('config_set', { cfg });
    return cfg;
  });
  // 队列本身必须能继续往下走：某一次失败不能把后来的人全卡死
  cfgWriteChain = run.catch(() => {});
  return run;
}

// ── 小工具 ───────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, isErr) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function fail(e) {
  toast(String(e && e.message ? e.message : e), true);
}

/** 本地日期（当日额度分桶用；与页面侧 localDay() 口径一致，不在这里做时区推断） */
function localDay() {
  const d = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 名字 → 稳定的色相，给每个人设一张有辨识度的头像 */
function hueOf(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

function avatarStyle(text) {
  const h = hueOf(text);
  return `background:linear-gradient(135deg,hsl(${h} 78% 68%),hsl(${(h + 58) % 360} 74% 58%))`;
}

/** 粗估 token：中文一字约 0.6，其余约 4 字符 1 个（只用于给主人一个量级感） */
function estimateTokens(text) {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const rest = text.length - cjk;
  return Math.round(cjk * 0.6 + rest / 4);
}

const CADENCE_HINT = {
  off: '当前不注入任何人设，行为与原生网页一致。',
  first:
    '只在**新对话的第一句**注入 —— 省额度，人设靠对话上下文延续。注意：已经在聊的对话里不会再重复注入；想立刻验证就开一个新对话。',
  every:
    '每轮都注入 —— 人设最稳（含已在聊的对话），但每轮都要多花一段上下文额度。',
};
const CADENCE_SHORT = { off: '关闭', first: '仅首条', every: '每轮' };

/** 自动整理的选项（0 = 关）。文案得把"会自己花额度"说清楚 */
const AUTO_OPTIONS = [
  { v: 0, label: '关', hint: '只有点「立即整理」才会花额度。' },
  { v: 10, label: '10 轮', hint: '每聊完 10 轮自动整理一次。' },
  { v: 20, label: '20 轮', hint: '每聊完 20 轮自动整理一次。' },
  { v: 50, label: '50 轮', hint: '每聊完 50 轮自动整理一次。' },
];

/** 状态页的三个闸。每一项都要把成本说清楚 —— 这是主人唯一能控制花不花钱的地方 */
const ANCHOR_OPTIONS = [0, 10, 20, 50];
const SENSE_OPTIONS = [
  { v: 'off', label: '关', hint: '完全不感知，心情只按本地词表慢慢飘。' },
  { v: 'local', label: '本地', hint: '关键词启发式，零额度、每轮即时；看不懂语境。' },
  { v: 'model', label: '模型', hint: '让模型读对话判断情绪，更准，但**每次多花一次网页额度**。' },
];
const PROACTIVE_OPTIONS = [
  { v: 'off', label: '关', hint: '不主动说话。' },
  { v: 'local', label: '本地', hint: '空闲够久时用本地话术自己冒一句，零额度。' },
  { v: 'model', label: '模型', hint: '空闲时让模型按人设现想一句，**多花一次网页额度**。' },
];

// ── 窗口按钮 ─────────────────────────────────────────────────────────────
function bindWindowButtons() {
  const api = window.__TAURI__ && window.__TAURI__.window;
  if (!api || !api.getCurrentWindow) return;
  const w = api.getCurrentWindow();
  $('win-min').addEventListener('click', () => w.minimize());
  $('win-max').addEventListener('click', () => w.toggleMaximize());
  $('win-close').addEventListener('click', () => w.close());
}

// ── 渲染 ─────────────────────────────────────────────────────────────────
function renderList() {
  const box = $('list');
  box.innerHTML = '';
  if (!personas.length) {
    box.innerHTML =
      '<div class="empty">还没有人设<br><span style="color:#5c5578">新建一个，或从 DSH 导入现成的</span></div>';
  }
  const effNow = effectivePersona();
  for (const p of personas) {
    // 激活标记要跟着**实际生效**的角色 —— 没选过的时候生效的是出厂默认角色
    const isActive = !!effNow && effNow.id === p.id;
    const card = document.createElement('div');
    card.className = 'card' + (current && current.id === p.id ? ' on' : '');
    card.dataset.id = p.id;
    card.title = p.description || p.name;

    const av = document.createElement('div');
    av.className = 'avatar';
    av.setAttribute('style', avatarStyle(p.name));
    av.textContent = (p.name || '?').trim().charAt(0).toUpperCase();
    card.appendChild(av);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = p.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = p.description || `${(p.body || '').length} 字`;
    meta.appendChild(nm);
    meta.appendChild(sub);
    card.appendChild(meta);

    if (isActive) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = '激活中';
      card.appendChild(b);
    } else if (p.source && p.source.startsWith('dsh:')) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.style.opacity = '.6';
      b.textContent = 'DSH';
      card.appendChild(b);
    }

    card.addEventListener('click', () => openEditor(p.id));
    box.appendChild(card);
  }
  $('list-foot').textContent = personas.length ? `${personas.length} 个` : '空';
}

function renderActiveOptions() {
  const sel = $('active');
  sel.innerHTML = '';
  for (const p of personas) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  // 「原版」是**另一回事**，不再等于"什么都没选"：
  //   不选 / 选默认角色 → 出厂默认角色（DeepSeek 娘）生效
  //   选「原版」          → 人设不注入，状态与角色记忆也都不参与（就是没装这个软件的样子）
  const off = document.createElement('option');
  off.value = 'off';
  off.textContent = '原版（不注入人设）';
  sel.appendChild(off);
  // 配置里"没选过"（null）时视觉上落在出厂默认角色上 —— 她本来就是默认生效的那一个
  const builtin = personas.find((p) => p.source === 'builtin') || personas[0];
  sel.value = cfg.activePersona || (builtin ? builtin.id : '');
}

/** 当前**实际生效**的角色 id：与 Rust 的 `personas::active_character_id` 同一套语义。
 *  没选 → 出厂默认角色的 id（她的状态/记忆挂在这个 id 下）；选「原版」→ 空串。 */
function effectiveCharacterId() {
  if (cfg.activePersona === 'off') return '';
  if (cfg.activePersona) return cfg.activePersona;
  const b = personas.find((p) => p.source === 'builtin') || personas[0];
  return b ? b.id : '';
}

/** 当前实际生效的人设对象（「原版」时是 null） */
function effectivePersona() {
  if (cfg.activePersona === 'off') return null;
  return (
    personas.find((p) => p.id === cfg.activePersona) ||
    personas.find((p) => p.source === 'builtin') ||
    null
  );
}

function renderCadence() {
  const btns = [...$('cadence').querySelectorAll('button')];
  let active = null;
  for (const b of btns) {
    const on = b.dataset.v === cfg.cadence;
    b.classList.toggle('on', on);
    if (on) active = b;
  }
  // 滑块位置：按当前按钮的实测几何算（改窗口宽度/字号也不会错位）
  placePill('seg-pill', active);
  $('cost-hint').textContent = CADENCE_HINT[cfg.cadence] || '';
}

function renderMute() {
  const seg = $('mute');
  if (!seg) return;
  // 没配过这个字段 = 开着（老 config.json 里没有它，语义上就是"照常注入"）
  const cur = cfg.injectEnabled === false ? 'off' : 'on';
  let active = null;
  for (const b of seg.querySelectorAll('button')) {
    const on = b.dataset.v === cur;
    b.classList.toggle('on', on);
    if (on) active = b;
  }
  placePill('mute-pill', active);
}

/** 静音总开关：关掉之后页面侧整条注入路径直接跳过（连轮数都不推进）。 */
async function setMute(v) {
  const want = v !== 'off';
  if ((cfg.injectEnabled !== false) === want) return; // 没变就别写盘
  cfg.injectEnabled = want;
  renderMute();
  try {
    await patchCfg({ injectEnabled: want });
  } catch (e) {
    fail(e);
  }
}

function renderStatus() {
  const active = effectivePersona();
  const on = !!active && cfg.cadence !== 'off';
  $('hero-dot').classList.toggle('on', on);
  // 三种情况要分得清：原版 / 有人设但节奏关着 / 有人设且在跑
  $('status').textContent = active
    ? `${active.name} · ${CADENCE_SHORT[cfg.cadence]}`
    : cfg.activePersona === 'off'
      ? '原版 DeepSeek（不注入人设）'
      : '还没选角色';
}

function renderCount() {
  const t = $('f-body').value || '';
  $('f-count').textContent = `${t.length} 字 · 约 ${estimateTokens(t)} tokens`;
}

function renderAll() {
  renderList();
  renderActiveOptions();
  renderCadence();
  renderMute();
  renderStatus();
  // 人设变了，状态页的角色列表也要跟着变（用缓存，不额外读盘）
  if ($('st-list')) renderStList();
  if ($('curve')) renderCurve();
}

function openEditor(id) {
  const p = personas.find((x) => x.id === id);
  if (!p) return;
  current = { ...p };
  $('f-name').value = p.name;
  $('f-desc').value = p.description || '';
  $('f-address').value = p.address || '';
  $('f-body').value = p.body || '';
  // 活动池是**多行**的（一行一件事）—— 原样灌进去，别动行首的 [标签]
  $('f-activities').value = p.activities || '';
  $('editor-title').textContent = p.name;
  $('editor-meta').textContent = `${p.id} · 来源 ${p.source || 'manual'}`;
  $('btn-save').disabled = false;
  $('btn-delete').disabled = false;
  renderCount();
  renderList();
}

function newPersona() {
  current = { id: '', name: '', description: '', source: 'manual', body: '', address: '', activities: '' };
  $('f-name').value = '';
  $('f-desc').value = '';
  $('f-address').value = '';
  $('f-body').value = '';
  $('f-activities').value = '';
  $('editor-title').textContent = '新建人设';
  $('editor-meta').textContent = '填好名字与正文后保存';
  $('btn-save').disabled = false;
  $('btn-delete').disabled = true;
  renderCount();
  renderList();
  $('f-name').focus();
}

// ── 数据流 ───────────────────────────────────────────────────────────────
async function reload() {
  personas = await invoke('persona_list');
  cfg = await invoke('config_get');
  memories = await invoke('memory_list');
  renderAll();
  renderMemAll();
}

async function saveCurrent() {
  const name = $('f-name').value.trim();
  if (!name) return toast('名字不能为空', true);
  const payload = {
    id: current && current.id ? current.id : '',
    name,
    description: $('f-desc').value.trim(),
    address: $('f-address').value.trim(),
    source: (current && current.source) || 'manual',
    body: $('f-body').value,
    // ★必须一起交给壳★ personas.rs 的存盘清单是**手写**的（不是 serde 自动的），
    // 漏一个字段就是"界面上填得进去、存下去就没了"，而且一声不响 —— address 丢过一次。
    activities: $('f-activities').value,
  };
  try {
    const saved = await invoke('persona_save', { persona: payload });
    toast('已保存');
    await reload();
    openEditor(saved.id);
  } catch (e) {
    fail(e);
  }
}

async function deleteCurrent() {
  if (!current || !current.id) return;
  if (!confirm(`删除「${current.name}」？\n会移到 personas-trash 目录，可以找回。`)) return;
  try {
    await invoke('persona_delete', { id: current.id });
    toast('已删除（可在 personas-trash 找回）');
    current = null;
    $('editor-title').textContent = '未选择人设';
    $('editor-meta').textContent = '';
    $('f-name').value = '';
    $('f-desc').value = '';
    $('f-body').value = '';
    $('btn-save').disabled = true;
    $('btn-delete').disabled = true;
    renderCount();
    await reload();
  } catch (e) {
    fail(e);
  }
}

async function setActive(id) {
  cfg.activePersona = id || null;
  try {
    await patchCfg({ activePersona: id || null });
    renderAll();
    toast(
      id === 'off' ? '已切回原版（人设不注入）' : id ? '已激活' : '已切回默认角色',
    );
  } catch (e) {
    fail(e);
  }
}

async function setCadence(v) {
  cfg.cadence = v;
  try {
    await patchCfg({ cadence: v });
    renderCadence();
    renderStatus();
  } catch (e) {
    fail(e);
  }
}

// ── DSH 导入 ─────────────────────────────────────────────────────────────
function presetCard(p, onImport) {
  const card = document.createElement('div');
  card.className = 'card';

  const av = document.createElement('div');
  av.className = 'avatar';
  av.setAttribute('style', avatarStyle(p.name));
  av.textContent = (p.name || '?').trim().charAt(0).toUpperCase();
  card.appendChild(av);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = `${p.name} · ${p.chars} 字`;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = p.stub ? '⚠ 只有一行占位文本（真身在运行时插件里）' : p.description || '';
  meta.appendChild(nm);
  meta.appendChild(sub);
  card.appendChild(meta);

  const btn = document.createElement('button');
  btn.className = 'btn ghost';
  btn.textContent = p.imported ? '重新导入' : '导入';
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onImport(p);
  });
  card.appendChild(btn);
  return card;
}

async function openImport() {
  $('import-mask').classList.remove('hidden');
  const box = $('import-list');
  box.innerHTML = '<div class="empty">正在扫描 ~/.dsh/.agent-presets …</div>';
  let list = [];
  try {
    list = await invoke('dsh_preset_scan');
  } catch (e) {
    box.innerHTML = '';
    return fail(e);
  }
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML =
      '<div class="empty">没找到带 persona 的 preset<br><span style="color:#5c5578">看看 ~/.dsh/.agent-presets 下有没有 agent.cordis.yml</span></div>';
    return;
  }
  for (const p of list) {
    box.appendChild(
      presetCard(p, async (preset) => {
        try {
          const got = await invoke('dsh_preset_import', { id: preset.id });
          toast(`已导入「${got.name}」`);
          await reload();
          openEditor(got.id);
          openImport();
        } catch (e) {
          fail(e);
        }
      }),
    );
  }
}

// ── 通用：把分段控件的滑块摆到当前项上 ─────────────────────────────────
// （改窗口宽度 / 页签切换后都要重摆，所以抽出来，别在两处各写一遍）
function placePill(pillId, activeBtn) {
  const pill = $(pillId);
  if (!pill) return;
  if (!activeBtn) {
    pill.style.opacity = '0';
    return;
  }
  pill.style.width = activeBtn.offsetWidth + 'px';
  pill.style.transform = `translateX(${activeBtn.offsetLeft - 3}px)`;
  pill.style.opacity = '1';
}

// ── 她今天怎么样（日报）────────────────────────────────────────────────
//
// 数字卡片用 grid 排，不用 flex：flex 子项默认 min-width:auto，像"第 1234 天"这种
// 长值会把整列顶宽（这个坑在 Quill 上踩过一次）。渲染失败时**不清空界面** ——
// 宁可留着上一次的内容，也不要变成一片空白让人以为坏了。
async function refreshToday() {
  try {
    const cid = (stCurrent && stCurrent.characterId) || '';
    const d = await invoke('daily_digest', { characterId: cid, day: '' });
    $('today-sub').textContent = d.day ? `${d.day} · ${d.name}` : '还没有记录';
    $('today-headline').textContent = d.headline || '—';
    $('today-stats').innerHTML = (d.stats || [])
      .map(
        (s) =>
          `<div class="ts"><div class="ts-label">${escapeHtml(s.label)}</div>` +
          `<div class="ts-value">${escapeHtml(s.value)}</div>` +
          (s.hint ? `<div class="ts-hint">${escapeHtml(s.hint)}</div>` : '') +
          '</div>',
      )
      .join('');
    $('today-lines').innerHTML = (d.lines || []).map((l) => `<li>${escapeHtml(l)}</li>`).join('');
  } catch (e) {
    $('today-headline').textContent = '读不出来：' + String(e && e.message ? e.message : e);
  }
}

// ── 页签 ────────────────────────────────────────────────────────────────
function setTab(name) {
  for (const b of document.querySelectorAll('.tb-tab')) b.classList.toggle('on', b.dataset.tab === name);
  $('tab-persona').classList.toggle('hidden', name !== 'persona');
  $('tab-state').classList.toggle('hidden', name !== 'state');
  $('tab-memory').classList.toggle('hidden', name !== 'memory');
  $('tab-tools').classList.toggle('hidden', name !== 'tools');
  $('tab-log').classList.toggle('hidden', name !== 'log');
  // 隐藏时 offsetWidth 是 0，滑块会摆错位置 —— 显示出来之后重摆一次
  requestAnimationFrame(() => {
    renderCadence();
    renderStPills();
    renderMemPills();
  });
  if (name === 'state')
    (async () => {
      // 【先重新拉一次配置】内存里的 cfg 是页面加载时那份 —— 而激活角色可能在别处被改过
      // （托盘菜单就是一条：右键换个角色，设置页却还按旧角色选中/标记）。
      // 状态页的"当前角色"完全依赖 cfg，陈旧一次就会选错人、进而把值改到别的角色上。
      try {
        cfg = await invoke('config_get');
      } catch {}
      await refreshStates();
      // 先自动选（会 openStEditor 灌表单）；已经选过了就再灌一次 ——
      // 否则第二次进页面时表单还停在上一次的值（验收抓到的"自订设定显示不出来"）
      if (!autoPickState() && stCurrent) openStEditor(stCurrent.characterId);
      renderStAll();
      // 日报跟着选中的角色走（换角色卡片时"今天"也要换人）
      refreshToday();
      // 日记也是（而且它只在进这个页签时读一次盘就够了）
      syncDiary();
    })().catch(fail);
  if (name === 'memory') reloadMemories().catch(fail);
  if (name === 'tools') refreshTools().catch(fail);
  if (name === 'log') startLogFollow();
  else stopLogFollow();
}

// ── 工具页 ──────────────────────────────────────────────────────────────
//
// 这一页管的其实是**信任边界**：工具唯一能碰的目录、开关、以及每次调用的记录。
// 所以默认值一律保守：工具默认关、工作区默认空（空 = 全部拒绝）。
let toolsInfo = null;

async function refreshTools() {
  const info = await invoke('tools_status', { day: localDay() });
  toolsInfo = info;
  $('tl-enabled').checked = !!info.enabled;
  if (document.activeElement !== $('tl-ws')) $('tl-ws').value = info.workspace || '';
  // 写工具：默认关，而且关着的时候她**不知道有这个工具**（不是"知道了但会被拒"）
  $('tl-write').checked = !!info.writeEnabled;
  $('tl-write-sub').textContent = info.writeEnabled
    ? '开着 · 写 / 改 / 跑命令，每次都要你确认'
    : '关着 · 她不知道有这三个工具';
  const pend = info.pending || [];
  $('tl-pending-wrap').classList.toggle('hidden', pend.length === 0);
  if (pend.length) {
    const p = pend[pend.length - 1];
    const tag = p.tool === 'edit_file' ? '【改】' : p.tool === 'run_command' ? '【跑】' : '【写】';
    $('tl-pending').textContent = `${tag} ${p.path}\n\n${p.preview}`;
    window.__DSC_PENDING__ = p;
  } else {
    window.__DSC_PENDING__ = null;
  }
  $('tl-dot').classList.toggle('on', !!info.enabled && !!info.workspaceOk);
  $('tl-summary').textContent = !info.workspaceOk
    ? '未设置工作区（工具不会注入，也不会执行）'
    : info.enabled
      ? `已启用 · 今日还可调用 ${info.leftToday}/${info.dailyCap} 次`
      : '工作区已就绪 · 工具未启用';
  $('tl-hint').textContent = info.workspaceOk
    ? `当前工作区：${info.workspace}`
    : info.workspace
      ? `工作区路径无效：${info.workspace}`
      : '还没有工作区 —— 她不知道能在哪里干活，所以工具不会生效。';
  $('tl-names').textContent = `${(info.names || []).length} 个：${(info.names || []).join(' / ')}`;
  const rows = info.recent || [];
  $('tl-log').textContent = rows.length ? rows.join('\n') : '（还没有调用记录）';
  $('tl-log-sub').textContent = rows.length ? `最近 ${rows.length} 条` : '';
  window.__DSC_TOOLS_INFO__ = info;
  // 前台窗口感知不是"工具"，但它是同一类东西 —— 她对外部世界的一只眼睛，所以放在这页
  await refreshFront().catch(() => {});
}

/**
 * 她看得见你在用什么软件（前台窗口）────────────────────────────────────
 *
 * 【为什么读数就摆在开关旁边】隐私开关最忌讳"开着，但它到底读到了什么我不知道"。
 * 这里直接问一次真实读数并显示出来 —— 看得见才敢开。读数里**没有窗口标题**，
 * 因为那一层从来就没读过（见 front.rs 顶部的说明）。
 *
 * 【为什么不轮询】点一下看一眼就够。自动轮询会让设置窗口一直戳系统 API，
 * 而且主人切窗口时读数会闪个不停，反倒像在盯人。
 */
async function refreshFront() {
  const c = await invoke('config_get');
  const on = !!c.watchApp;
  $('tl-front').checked = on;
  if (!on) {
    $('tl-front-sub').textContent = '关着';
    $('tl-front-now').textContent = '关着 —— 她不知道你在用什么';
    window.__DSC_FRONT__ = { enabled: false };
    return;
  }
  $('tl-front-sub').textContent = '开着 · 只报进程名';
  try {
    const r = await invoke('dsc_front_app');
    // 这一行就是她**实际会看到**的那句话，一字不差（含"在别的软件里"那种被打码的）
    $('tl-front-now').textContent = r.text || '（读不到）';
    window.__DSC_FRONT__ = r;
  } catch (e) {
    $('tl-front-now').textContent = '读不到：' + (e && e.message ? e.message : e);
    window.__DSC_FRONT__ = { enabled: true, error: String(e) };
  }
}

// ── 日志页 ──────────────────────────────────────────────────────────────
// 主人明确要求：不要单独一个黑框窗口，日志放进设置里。所以这里是唯一的日志出口。
let logTimer = null;

/**
 * 运行体检 ────────────────────────────────────────────────────────────
 *
 * 主人真正要回答的问题只有一个：**她是不想干活，还是坏了**。
 * 这两种在界面上长得一模一样（都不说话），所以要靠计数把它们分开。
 *
 * 数据源是页面侧定期写进日志的 `[health] {...}` 行 —— 页面（chat.deepseek.com）
 * 与设置窗口（tauri.localhost）是两个不同的源，localStorage 不共享，而 dsc_log
 * 是现成通道，于是借日志传。取**最后一条**（那是当前状态）。
 *
 * 判读规则：
 *   完全没数据       → 页面侧没上报过（注入没跑起来，或她今天没在这个浏览器里活动）
 *   有轮次但正文=0   → 回复解析出了问题（空正文会带 raw-tail 日志，一眼能看见）
 *   有调用但没执行   → 被额度/本轮上限拦住了（toolBlocked）
 *   执行了但没回灌   → 结果没交回去（toolSends=0 而 toolRuns>0）
 * 光想不说（thinkOnly）**不算故障** —— 那是模型自己的选择，只是记一笔。
 */
function parseHealth(lines) {
  let last = null;
  for (const line of lines) {
    const i = line.indexOf('[health] ');
    if (i < 0) continue;
    try {
      last = JSON.parse(line.slice(i + '[health] '.length));
    } catch (e) {
      // 日志被截断时会剩半行 JSON —— 跳过它，别让一行坏数据把整块搞没
    }
  }
  return last;
}

function fmtAgo(ms) {
  if (!ms) return '—';
  const d = Date.now() - ms;
  if (d < 5000) return '刚刚';
  if (d < 60000) return Math.round(d / 1000) + ' 秒前';
  if (d < 3600000) return Math.round(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.round(d / 3600000) + ' 小时前';
  return Math.round(d / 86400000) + ' 天前';
}

function renderHealth(h) {
  const grid = $('health-grid');
  const note = $('health-note');
  if (!grid || !note) return;
  // 验收脚本读这个（页面侧的真相以它为准）
  window.__DSC_HEALTH__ = h || null;
  if (!h) {
    grid.innerHTML =
      '<div class="health-empty">还没有体检数据 —— 页面侧还没上报过（注入脚本没跑起来，或者她今天没在这个浏览器里活动过）。</div>';
    $('health-sub').textContent = '无数据';
    note.textContent = '';
    return;
  }
  const cells = [
    { k: '对话轮次', v: h.turns || 0, cls: '' },
    { k: '有正文', v: h.replies || 0, cls: h.turns && !h.replies ? 'bad' : 'ok' },
    { k: '空回复', v: h.emptyReplies || 0, cls: h.emptyReplies ? 'warn' : '' },
    { k: '光想不说', v: h.thinkOnly || 0, cls: h.thinkOnly ? 'warn' : '' },
    { k: '工具调用', v: h.toolCalls || 0, cls: '' },
    { k: '工具执行', v: h.toolRuns || 0, cls: '' },
    { k: '执行失败', v: h.toolFailures || 0, cls: h.toolFailures ? 'bad' : '' },
    { k: '结果已交回', v: h.toolSends || 0, cls: '' },
    { k: '走旁路兜底', v: h.toolFallbacks || 0, cls: h.toolFallbacks ? 'warn' : '' },
    { k: '被拦下', v: h.toolBlocked || 0, cls: h.toolBlocked ? 'warn' : '' },
    { k: '最后回复', v: (h.lastReplyLen || 0) + ' 字', cls: '' },
    { k: '末次对话', v: fmtAgo(h.lastTurnAt), cls: '' },
  ];
  grid.innerHTML = cells
    .map((c) => `<div class="health-cell ${c.cls}"><span class="k">${c.k}</span><span class="v">${c.v}</span></div>`)
    .join('');
  $('health-sub').textContent = `上报于 ${fmtAgo(h.at)} · 页面侧已跑 ${h.uptimeSec || 0} 秒 · 请求 ${h.seen || 0}/注入 ${h.injected || 0}`;

  const bad = [];
  if (!h.turns) bad.push('还没认领过任何一轮对话（她没说话，或注入没生效）');
  else if (!h.replies) bad.push('认领了轮次但正文一直是空的 —— 多半是回复帧格式变了，看日志里的 raw-tail');
  if (h.toolCalls && !h.toolRuns) bad.push('模型给了工具调用却一次都没执行 —— 被额度或本轮上限拦住了');
  if (h.toolRuns && !h.toolSends) bad.push('工具执行了但结果一次都没交回去（回灌通道失败）');
  if (h.toolFailures) bad.push(h.toolFailures + ' 次工具执行失败');
  if (h.errors) bad.push(h.errors + ' 次请求层错误');
  // 【通路自检】壳每轮算的"卡住"告警（情绪冻结 / 饿着没人管 / 好感停滞…）——
  // 这类问题以前都要人主动去翻日志才发现，现在跟着体检一起报上来
  for (const v of h.vitals || []) {
    bad.push(`【${v.key}】${v.text} → ${v.hint}`);
  }
  if (h.lastError) bad.push('最近一次：' + h.lastError);
  note.textContent = bad.length ? '⚠ ' + bad.join('；') : '这一轮没看出问题。';
  note.style.color = bad.length ? 'var(--p)' : '';
}

/**
 * 注入回执 ────────────────────────────────────────────────────────────
 *
 * 数据是页面侧每轮写进日志的 `[inject] {...}` 行：**每块的名字与字数**，
 * 外加"为什么没注入"（注入链路里 decide() 的 why）。
 *
 * 为什么字数才是重点：「人设块压根没进去」和「进去了但只有 200 字」是两种完全
 * 不同的病 —— 前者查注入节奏/激活角色，后者查人设文本本身。
 */
function parseInject(lines) {
  let last = null;
  for (const line of lines) {
    const i = line.indexOf('[inject] ');
    if (i < 0) continue;
    try {
      last = JSON.parse(line.slice(i + '[inject] '.length));
    } catch (e) {
      /* 日志被截断时会剩半行 JSON —— 跳过它 */
    }
  }
  return last;
}

/** decide() 的 why 是链路暗号，界面不该照抄给主人看 */
function whyHint(why) {
  const w = String(why || '');
  const map = [
    ['cadence-off', '注入节奏是「关」'],
    ['not-first-message', '节奏是「只注首条」，而这不是本会话第一条'],
    ['already-injected', '这条消息已经带过前缀了'],
    ['no-persona-text', '激活人设的正文是空的'],
    ['page-send-in-flight', '工具回灌那一发（不重复注入）'],
    ['not-json', '不是聊天请求'],
  ];
  for (const [k, v] of map) if (w.includes(k)) return v;
  if (w.startsWith('no-prompt-string')) return '请求体里没有 prompt 字段（上游可能改版了）';
  return '翻日志里的 skip 行';
}

function renderInject(r) {
  const grid = $('inj-grid');
  const note = $('inj-note');
  if (!grid || !note) return;
  window.__DSC_INJECT__ = r || null; // 验收脚本读它
  if (!r) {
    grid.innerHTML =
      '<div class="health-empty">还没有注入记录 —— 她还没在你的聊天里发过消息。</div>';
    $('inj-sub').textContent = '无数据';
    note.textContent = '';
    return;
  }
  const d = new Date(r.at || 0);
  const pad = (n) => String(n).padStart(2, '0');
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  $('inj-sub').textContent = r.ok
    ? `${clock} 注入成功 · 共 ${r.total} 字（${r.via}）`
    : `${clock} 这一轮没注入`;
  const blocks = r.blocks || [];
  const cells = blocks.length
    ? blocks.map((b) => ({ k: b.k, v: b.n + ' 字', cls: '' }))
    : [{ k: '注入内容', v: '空', cls: 'bad' }];
  grid.innerHTML = cells
    .map(
      (c) =>
        `<div class="health-cell ${c.cls}"><span class="k">${c.k}</span><span class="v">${c.v}</span></div>`,
    )
    .join('');
  const bad = [];
  if (!r.ok) {
    bad.push(`没注入的理由：${whyHint(r.why)}（${r.why || '?'}）`);
  } else {
    const has = (k) => blocks.some((b) => b.k === k);
    if (!has('人设')) bad.push('人设块不在里面 —— 查注入节奏与激活角色');
    if (!has('状态')) bad.push('状态块不在里面 —— 查状态层开关');
  }
  note.textContent = bad.length
    ? '⚠ ' + bad.join('；')
    : '这一轮注入了：' + blocks.map((b) => b.k).join(' + ');
  note.style.color = bad.length ? 'var(--p)' : '';
}

async function refreshLog() {
  try {
    const info = await invoke('log_tail', { lines: 400 });
    const view = $('log-view');
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
    view.textContent = info.lines.length ? info.lines.join('\n') : '（日志还是空的）';
    $('log-status').textContent = `${(info.size / 1024).toFixed(1)} KB · ${info.total} 行`;
    $('log-hint').textContent = info.path;
    $('log-sub').textContent = info.truncated
      ? `显示最后 ${info.lines.length} 行`
      : `全部 ${info.lines.length} 行`;
    if ($('log-follow').checked && atBottom) view.scrollTop = view.scrollHeight;
    renderHealth(parseHealth(info.lines));
    renderInject(parseInject(info.lines));
  } catch (e) {
    $('log-status').textContent = '读日志失败：' + (e && e.message ? e.message : e);
  }
}

/**
 * 数据目录：她的记忆、状态、人设到底存在哪 —— 得让主人看得见。
 *
 * 顺带是验收脚本的门禁信号：`isolated=false` 意味着脚本跑在**真实数据**上，
 * 那种情况下它是拿主人的记忆当沙包（memory-trash 里堆过 100+ 条测试残留）。
 * 所以这里不只显示路径，还把"隔离开了没有"明确标出来。
 */
let dataDirInfo = null;
async function refreshDataDir() {
  try {
    dataDirInfo = await invoke('data_dir');
    $('data-path').textContent = dataDirInfo.path;
    $('data-flag').textContent = dataDirInfo.isolated
      ? '已隔离（DSC_DATA_DIR）'
      : `${dataDirInfo.memories} 条记忆`;
    $('data-flag').classList.toggle('warn', !dataDirInfo.isolated && dataDirInfo.memories > 0);
    window.__DSC_DATA_DIR_INFO__ = dataDirInfo;
  } catch (e) {
    $('data-path').textContent = '读不到：' + (e && e.message ? e.message : e);
  }
}

function startLogFollow() {
  stopLogFollow();
  refreshLog();
  refreshDataDir();
  // 1.5 秒一次足够"像实时"，又不会把 IPC 打满
  logTimer = setInterval(refreshLog, 1500);
}

function stopLogFollow() {
  if (logTimer) clearInterval(logTimer);
  logTimer = null;
}

async function refreshAutostart() {
  try {
    $('log-autostart').checked = await invoke('autostart_get');
  } catch (e) {
    /* 读不到就当关着 */
  }
}

// ── 状态 ────────────────────────────────────────────────────────────────
// 心状态得看得见：这里既能看（数值 + 趋势曲线），也能改（拖滑块 / 编锚点），
// 还能调三个成本闸（回锚 / 感知 / 空闲主动）。
let states = {};
let stCurrent = null;
let userState = null;

async function refreshStates() {
  const next = {};
  for (const p of personas) {
    try {
      next[p.id] = await invoke('state_get', { characterId: p.id });
    } catch (e) {
      /* 单个读失败不该让整页空掉 */
    }
  }
  states = next;
  try {
    userState = await invoke('user_state_get');
  } catch (e) {
    /* 用户状态读不到不影响角色那部分 */
  }
}

/**
 * 进状态页就自动选中一个角色（当前激活的，其次第一个）。
 * 不自动选的话整页是空的（曲线、摘要都依赖选中项）—— "做完默认要可见"的老教训。
 */
function autoPickState() {
  if (stCurrent && states[stCurrent.characterId]) return false;
  const effId = effectiveCharacterId();
  const want = effId && states[effId] ? effId : personas[0] && personas[0].id;
  if (!want) return false;
  openStEditor(want);
  return true;
}

function stOf(id) {
  return states[id] || { characterId: id, mood: '—', affinity: 0, energy: 0, valence: 0, arousal: 0, turns: 0, samples: [], anchors: [], arc: '' };
}

// ── 状态曲线：好感（粉）与情绪（蓝）的长期走势 ──────────────────────────
//
// 【数据从哪来】Rust 侧的 `CharState.daily` —— 一天一行、最多 90 天。
// 它比 `samples`（只留最近 40 次）更能回答"这一个月她对我怎么变的"：
// 40 轮很可能只是一个晚上聊出来的。
//
// 【日期为什么在页面上】Rust 的 std 只有 UTC，本地日期一直是页面报上去的
// （和 senseDay / proactiveDay 同一条路）。所以老状态文件里没有 daily 是正常的，
// 取不到就**明说"还画不出"**，绝不画一条假线糊弄过去。
var CURVE_W = 100;
var CURVE_H = 34;
var CURVE_PAD = 2;

function renderCurve() {
  const box = $('curve');
  if (!box) return;
  const s = stCurrent ? stOf(stCurrent.characterId) : null;
  const daily = s && Array.isArray(s.daily) ? s.daily.filter((d) => d && d.day) : [];
  const sub = $('curve-sub');
  const hint = $('curve-hint');

  if (daily.length < 2) {
    box.innerHTML = '<div class="curve-empty">还画不出曲线 —— 至少要有两天的记录</div>';
    if (sub) sub.textContent = daily.length ? '只有 1 天' : '还没有历史';
    if (hint) {
      hint.textContent =
        '每聊一轮就把当天并进一行（一天一行，最多留 90 天）。明天再来就有线了。';
    }
    return;
  }

  const yOf = (v) => CURVE_H - CURVE_PAD - v * (CURVE_H - CURVE_PAD * 2);
  const xOf = (i) => CURVE_PAD + (i / (daily.length - 1)) * (CURVE_W - CURVE_PAD * 2);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  const affPts = daily
    .map((d, i) => xOf(i).toFixed(2) + ',' + yOf(clamp01((d.affinity || 0) / 100)).toFixed(2))
    .join(' ');
  const valPts = daily
    .map((d, i) => xOf(i).toFixed(2) + ',' + yOf(clamp01(((d.valence || 0) + 1) / 2)).toFixed(2))
    .join(' ');

  // 50% 虚标线：好感 50 分 / 情绪中性都落在这一条上 —— 有它才看得出"在线上还是线下"
  const mid = yOf(0.5).toFixed(2);
  // vector-effect：viewBox 被 preserveAspectRatio="none" 横向拉伸时，
  // 描边也会跟着变形；加上它线宽才是恒定 1px。
  box.innerHTML =
    '<svg class="curve-svg" viewBox="0 0 ' + CURVE_W + ' ' + CURVE_H + '" ' +
    'preserveAspectRatio="none" role="img" aria-label="好感与情绪走势">' +
    '<line class="curve-mid" x1="0" y1="' + mid + '" x2="' + CURVE_W + '" y2="' + mid +
    '" vector-effect="non-scaling-stroke"/>' +
    '<polyline class="curve-val" points="' + valPts + '" vector-effect="non-scaling-stroke"/>' +
    '<polyline class="curve-aff" points="' + affPts + '" vector-effect="non-scaling-stroke"/>' +
    '</svg>';

  const first = String(daily[0].day).slice(5);
  const last = String(daily[daily.length - 1].day).slice(5);
  const nowAff = daily[daily.length - 1].affinity || 0;
  const totalTurns = daily.reduce((n, d) => n + (d.turns || 0), 0);
  if (sub) sub.textContent = daily.length + ' 天 · 好感 ' + nowAff + ' · 共 ' + totalTurns + ' 轮';
  if (hint) {
    hint.textContent =
      first + ' → ' + last + '　粉线 = 好感（0-100），蓝线 = 情绪（低—高），虚线是中线。';
  }
}

// ── 她的日记（一天一篇，她自己写）──────────────────────────────────
//
// 【为什么这里必须能看】日记是她的私人物品：不注入回对话、不进记忆库 ——
// 那它就得有个"主人能翻"的地方，否则写了也没人看得见。
// 数据全部来自壳（`dsc_diary_days` / `dsc_diary_read`），页面不碰文件系统。
var diaryDays = [];
var diaryOpen = '';
// 这份列表是**哪个角色**的：角色没变就不用反复读盘
var diaryFor = '';
// 【为什么要单独一个「拉过了没有」】不能拿 `diaryFor === ''` 当「还没拉过」：
// 全新安装（没有自定义人设）时 `effectiveCharacterId()` 可能就是空串，
// 那样第一次同步会被判成「角色没变」直接 return —— 她明明写了日记，卡片却永远空着。
var diaryLoaded = false;

function renderDiary() {
  const box = $('diary-days');
  if (!box) return;
  const sub = $('diary-sub');
  const hint = $('diary-hint');
  const body = $('diary-body');
  const who = (personas.find((p) => p.id === effectiveCharacterId()) || {}).name || '她';

  if (!diaryDays.length) {
    box.innerHTML = '<div class="diary-empty">' + escapeHtml(who) + '还没写过日记</div>';
    if (body) body.textContent = '';
    if (sub) sub.textContent = '还没有';
    if (hint) {
      hint.textContent =
        '一天一篇：第二天第一次聊天时回顾前一天，写完就躺在数据目录的 diary/ 里 —— 不注回对话、不进记忆。';
    }
    return;
  }

  box.innerHTML = diaryDays
    .map(
      (d) =>
        '<button class="diary-day' + (d.day === diaryOpen ? ' on' : '') + '" data-day="' +
        escapeHtml(d.day) + '"><span>' + escapeHtml(String(d.day).slice(5)) +
        '</span><span class="dc">' + (d.chars || 0) + ' 字</span></button>',
    )
    .join('');
  for (const b of box.querySelectorAll('.diary-day')) {
    b.addEventListener('click', () => openDiaryDay(b.dataset.day));
  }

  const total = diaryDays.reduce((n, d) => n + (d.chars || 0), 0);
  if (sub) sub.textContent = diaryDays.length + ' 篇 · 共 ' + total + ' 字';
  if (hint) {
    hint.textContent =
      (diaryOpen || diaryDays[0].day) + '　点某一天看她那天写了什么。这些字只在这里和 diary/ 目录里。';
  }
}

async function openDiaryDay(day) {
  if (!day) return;
  diaryOpen = day;
  for (const b of document.querySelectorAll('#diary-days .diary-day')) {
    b.classList.toggle('on', b.dataset.day === day);
  }
  const hint = $('diary-hint');
  if (hint) hint.textContent = day + '　点某一天看她那天写了什么。这些字只在这里和 diary/ 目录里。';
  const body = $('diary-body');
  if (!body) return;
  body.textContent = '读…';
  try {
    body.textContent = String((await invoke('dsc_diary_read', { day })) || '').trim() || '（这天是空的）';
  } catch (e) {
    body.textContent = '读不出来：' + String(e && e.message ? e.message : e);
  }
}

/** 拉一次列表。角色被换掉时也要重来（那是壳按 config 解析的，跟页面选中谁无关）。
 *
 * 【默认摊开最新那篇为什么放在这里、不放在 renderDiary】renderDiary 会被反复调用
 *（每次重画角色列表都会来一次），而 openDiaryDay 是一次真实的读盘请求 ——
 * 放进 renderDiary 等于每重画一次就多读一次盘。所以「摊开哪篇」只在真拉了新列表之后决定。
 */
async function refreshDiary() {
  try {
    diaryDays = (await invoke('dsc_diary_days')) || [];
  } catch (e) {
    diaryDays = [];
  }
  diaryLoaded = true;
  if (!diaryOpen || !diaryDays.some((d) => d.day === diaryOpen)) {
    diaryOpen = diaryDays.length ? diaryDays[0].day : '';
  }
  renderDiary();
  if (diaryOpen) openDiaryDay(diaryOpen);
}

/** 跟当前角色同步。角色没变就只重画（人设名可能刚加载完），不重新读盘。 */
function syncDiary() {
  const cid = effectiveCharacterId();
  if (diaryLoaded && cid === diaryFor) {
    renderDiary();
    return;
  }
  diaryFor = cid;
  diaryOpen = '';
  refreshDiary();
}

function renderStList() {
  const box = $('st-list');
  box.innerHTML = '';
  if (!personas.length) {
    box.innerHTML = '<div class="empty">还没有人设<br><span style="color:#5c5578">状态是跟着角色走的，先去「人设」建一个</span></div>';
    $('st-foot').textContent = '空';
    return;
  }
  for (const p of personas) {
    const s = stOf(p.id);
    const card = document.createElement('div');
    card.className = 'card' + (stCurrent && stCurrent.characterId === p.id ? ' on' : '');
    card.dataset.id = p.id;
    card.title = s.arc || '（还没记下处境）';

    const av = document.createElement('div');
    av.className = 'avatar';
    av.setAttribute('style', avatarStyle(p.name));
    av.textContent = (p.name || '?').trim().charAt(0);
    card.appendChild(av);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = p.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${s.mood || '—'} · 好感 ${s.affinity || 0} · ${s.turns || 0} 轮`;
    meta.appendChild(nm);
    meta.appendChild(sub);
    card.appendChild(meta);

    if (effectiveCharacterId() === p.id) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = '激活中';
      card.appendChild(b);
    }
    card.addEventListener('click', () => openStEditor(p.id));
    box.appendChild(card);
  }
  $('st-foot').textContent = `${personas.length} 个角色`;
  // 角色列表变了，曲线跟着换人
  renderCurve();
  // 日记也跟着换人（内部会判"还是同一个角色"就不重复读盘）
  syncDiary();
}

function renderStSummary() {
  const on = cfg.stateEnabled !== false;
  $('st-dot').classList.toggle('on', on);
  if (!stCurrent) {
    $('st-summary').textContent = '左边选一个角色';
    $('st-hint').textContent =
      '状态每轮都注进对话（几十个 token）：她靠它记住心情、好感和你俩聊到哪了。' +
      (on ? '' : ' 注意：状态注入现在是关的。');
    return;
  }
  const s = stCurrent;
  $('st-summary').textContent = `${s.mood || '—'} · 好感 ${s.affinity || 0}/100 · 精力 ${Math.round(
    (s.energy || 0) * 100,
  )}% · 已聊 ${s.turns || 0} 轮`;
  $('st-hint').textContent =
    (s.arc ? `处境：${s.arc}　` : '') +
    `情绪倾向 ${Math.round(((s.valence || 0) + 1) * 50)}% 正向、活跃度 ${Math.round(
      (s.arousal || 0) * 100,
    )}%。` +
    (on ? '' : '（状态注入已关闭，这些不会进对话）');
}

/** 趋势曲线：紫线=情绪倾向，粉线=好感。曲线在动，才说明状态是"连贯"的 */
function renderStSpark() {
  const box = $('st-spark');
  const s = stCurrent;
  const samples = (s && s.samples) || [];
  if (samples.length < 2) {
    box.innerHTML = '<div class="spark-empty">还没有足够的数据画趋势（多聊几轮就有了）</div>';
    return;
  }
  const n = samples.length;
  const px = (i) => (i / (n - 1)) * 100;
  const vy = (v) => 14.5 - ((Math.max(-1, Math.min(1, v)) + 1) / 2) * 13;
  const ay = (a) => 14.5 - (Math.max(0, Math.min(100, a)) / 100) * 13;
  const poly = (f) =>
    samples.map((sm, i) => `${px(i).toFixed(2)},${f(sm).toFixed(2)}`).join(' ');
  box.innerHTML =
    '<svg viewBox="0 0 100 16" preserveAspectRatio="none">' +
    `<polyline points="${poly((sm) => ay(sm.affinity || 0))}" fill="none" stroke="#f472b6" stroke-width="0.7" stroke-opacity="0.9" />` +
    `<polyline points="${poly((sm) => vy(sm.valence || 0))}" fill="none" stroke="#a78bfa" stroke-width="0.7" />` +
    '</svg>' +
    '<div class="spark-legend"><span><i style="background:#a78bfa"></i>情绪</span><span><i style="background:#f472b6"></i>好感</span></div>';
}

/** 「空闲主动」那一行的时间口径：多久算离开 + 安静时段（留空就说清是全天）。 */
function proactiveTimingHint(mode) {
  if (mode === 'off') return '';
  const idle = ` 空闲 ${cfg.proactiveIdleMinutes || 20} 分钟起`;
  const f = cfg.proactiveQuietFrom;
  const t = cfg.proactiveQuietTo;
  const unset = f === null || f === undefined || t === null || t === undefined;
  return idle + (unset ? '；全天都能说。' : `；${f} 点到 ${t} 点不打扰。`);
}

function renderStGateHint() {
  const sense = SENSE_OPTIONS.find((o) => o.v === (cfg.senseMode || 'local')) || SENSE_OPTIONS[1];
  const pro = PROACTIVE_OPTIONS.find((o) => o.v === (cfg.proactiveMode || 'off')) || PROACTIVE_OPTIONS[0];
  const anchor = Number(cfg.anchorEveryTurns || 0);
  const s = stCurrent || {};
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate(),
  ).padStart(2, '0')}`;
  // 今日用量：花了多少额度得看得见，不然"怎么又超了"查不出来
  const used = [];
  if (pro.v !== 'off') {
    const n = s.proactiveDay === todayStr ? s.proactiveCount || 0 : 0;
    used.push(`今天主动 ${n}/${cfg.proactiveDailyCap || 6} 次`);
  }
  if (sense.v === 'model') {
    const n = s.senseDay === todayStr ? s.senseCount || 0 : 0;
    used.push(`今天模型感知 ${n}/${cfg.senseDailyCap || 30} 次`);
  }
  const parts = [
    `回锚：${anchor ? `每 ${anchor} 轮补一次【回锚】` : '关'}` +
      (cfg.cadence === 'every' ? '（节奏是「每轮」时回锚会自动跳过，人设本来就在）' : ''),
    `情绪感知：${sense.hint}` + (sense.v === 'model' ? ` 间隔 ≥${cfg.senseEveryTurns || 12} 轮。` : ''),
    `空闲主动：${pro.hint}` + proactiveTimingHint(pro.v),
    used.join(' · '),
  ];
  $('st-gate-hint').textContent = parts.filter(Boolean).join('　');
}

/** 把今天的额度清零：主人自己花超了、想再来一次时用 */
async function clearQuota() {
  if (!stCurrent) return;
  try {
    const saved = await invoke('state_save', {
      state: { ...stCurrent, proactiveDay: '', proactiveCount: 0, senseDay: '', senseCount: 0 },
    });
    states[saved.characterId] = saved;
    stCurrent = JSON.parse(JSON.stringify(saved));
    renderStAll();
    toast('今日额度已清零');
  } catch (e) {
    fail(e);
  }
}

function renderStPills() {
  const seg = (id, pillId, val) => {
    const b = [...$(id).querySelectorAll('button')].find((x) => String(x.dataset.v) === String(val));
    placePill(pillId, b);
  };
  seg('st-anchor', 'st-anchor-pill', Number(cfg.anchorEveryTurns || 0));
  seg('st-review', 'st-review-pill', cfg.selfReviewMode || 'manual');
  seg('st-sense', 'st-sense-pill', cfg.senseMode || 'local');
  seg('st-proactive', 'st-proactive-pill', cfg.proactiveMode || 'off');
  seg('st-task', 'st-task-pill', cfg.taskMode || 'auto');
}

// ── 自我修订：提案箱 ──────────────────────────────────────────────
// 【安全边界】她只能提案。采纳才写进 addendum/锚点/处境；原始人设一个字不动。
let proposals = [];

async function refreshProposals() {
  if (!stCurrent) {
    proposals = [];
    return;
  }
  try {
    proposals = (await invoke('proposal_list', { characterId: stCurrent.characterId })) || [];
  } catch (e) {
    proposals = [];
  }
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function propStatusLabel(s) {
  if (s === 'accepted') return '已采纳';
  if (s === 'rejected') return '已驳回';
  return '待审阅';
}

function renderProposals() {
  const box = $('prop-list');
  if (!box) return;
  box.innerHTML = '';
  const pending = proposals.filter((p) => p.status === 'pending');
  // 顶部跳转按钮上挂个"待审 N"角标 —— 提案在页面很下面，得让人知道有东西等着
  if ($('jump-prop')) $('jump-prop').textContent = pending.length ? String(pending.length) : '';
  const rest = proposals.filter((p) => p.status !== 'pending').slice(-4).reverse();
  if (!proposals.length) {
    box.innerHTML =
      '<div class="empty">她还没提过自我修订<br><span style="color:#5c5578">点「让她反思一下」，或者把反思时机设成「每 30 轮」</span></div>';
    return;
  }
  for (const p of pending.concat(rest)) {
    const el = document.createElement('div');
    el.className = 'prop ' + p.status;
    const head = document.createElement('div');
    head.className = 'prop-head';
    head.innerHTML = `<span>${propStatusLabel(p.status)}</span><span>第 ${p.turn || 0} 轮 · ${fmtTime(
      p.createdAt,
    )}</span>`;
    el.appendChild(head);
    const body = document.createElement('div');
    body.className = 'prop-body';
    const bits = [];
    if (p.personaAddendum) bits.push(`自订设定：<b>${escapeHtml(p.personaAddendum)}</b>`);
    if (p.anchors && p.anchors.length) bits.push(`新约定：${p.anchors.map(escapeHtml).join('；')}`);
    if (p.arc) bits.push(`近况：${escapeHtml(p.arc)}`);
    if (p.reason) bits.push(`<em>她的理由：${escapeHtml(p.reason)}</em>`);
    body.innerHTML = bits.join('<br>') || '（空）';
    el.appendChild(body);
    if (p.status === 'pending') {
      const acts = document.createElement('div');
      acts.className = 'prop-actions';
      const ok = document.createElement('button');
      ok.className = 'btn primary small';
      ok.textContent = '采纳';
      ok.addEventListener('click', () => acceptProposal(p));
      const no = document.createElement('button');
      no.className = 'btn ghost small';
      no.textContent = '驳回';
      no.addEventListener('click', () => rejectProposal(p));
      acts.appendChild(ok);
      acts.appendChild(no);
      el.appendChild(acts);
    }
    box.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function acceptProposal(p) {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  try {
    await invoke('proposal_accept', { characterId: p.characterId || stCurrent.characterId, id: p.id, day });
    toast('已采纳：写进她的自订设定');
    await refreshStates();
    await refreshProposals();
    stCurrent = JSON.parse(JSON.stringify(states[stCurrent.characterId]));
    openStEditor(stCurrent.characterId);
  } catch (e) {
    fail(e);
  }
}

async function rejectProposal(p) {
  try {
    await invoke('proposal_reject', { characterId: p.characterId || stCurrent.characterId, id: p.id });
    toast('已驳回（记录留着，方便回看）');
    await refreshProposals();
    renderProposals();
  } catch (e) {
    fail(e);
  }
}

/** 状态页很长，顶部那排按钮点一下滚到对应小节 */
function scrollToSection(id) {
  const el = document.getElementById(id);
  const f = document.querySelector('#tab-state .fields');
  if (!el) return;
  if (!f) {
    el.scrollIntoView({ block: 'start' });
    return;
  }
  // 用 rect 差值算目标位置：offsetTop 依赖 offsetParent，页面结构一动就偏
  const fr = f.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  f.scrollTo({ top: Math.max(0, f.scrollTop + (er.top - fr.top) - 6), behavior: 'smooth' });
}

/** 手动让她反思（走页面的 B 链路；额度在 Rust 侧先扣） */
async function reviewNow() {
  const note = $('st-review-note');
  const btn = $('st-review-now');
  // 反思是在**页面**上跑的，页面只认「当前激活角色」（推过去的 payload 里那个 personaId）。
  // 所以这里必须按 activePersona 判断 —— 曾经写成 cfg.personaId：那个字段只存在于 payload，
  // 设置窗口的配置（AppConfig）里根本没有，于是 !undefined 恒真，按钮永远只弹「先激活一个角色」，
  // 一次都没真跑起来。而验收脚本只调页面里的 __DSC_SELF_REVIEW__()、从没点过这个按钮，
  // 所以这个 bug 一直没被发现（已补「真点按钮」的断言，别再退回去）。
  const activeId = effectiveCharacterId();
  if (!activeId) return toast('先激活一个角色', true);
  const nameOf = (id) => (personas.find((p) => p.id === id) || {}).name || id;
  const selId = (stCurrent && stCurrent.characterId) || '';
  if (selId && selId !== activeId) {
    // 拦下来而不是照跑：提案会挂在**激活角色**名下，跟眼前这个人对不上，
    // 而且白花一次网页额度（成本是他最在意的）
    return toast(
      `反思的是当前激活角色「${nameOf(activeId)}」——想让她以「${nameOf(selId)}」的身份反省，先把「${nameOf(selId)}」设为激活`,
      true,
    );
  }
  btn.disabled = true;
  note.textContent = '她在反省…（会花一次网页额度）';
  try {
    await invoke('review_now');
  } catch (e) {
    btn.disabled = false;
    note.textContent = String((e && e.message) || e);
    fail(e);
    return;
  }
  // 结果走事件回来（页面跑完会发 dsc:proposal）；等不到就给个超时提示，
  // 别让按钮永远卡在"她在反省…"
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(async () => {
    btn.disabled = false;
    note.textContent = '没等到结果 —— 看「日志」页，可能是额度用完或者没登录';
    await refreshProposals();
    renderProposals();
  }, 60000);
}

let reviewTimer = null;

/** 页面的提案回来了（手动触发或 auto 模式都会走这里） */
async function onProposalEvent() {
  clearTimeout(reviewTimer);
  const btn = $('st-review-now');
  if (btn) btn.disabled = false;
  const note = $('st-review-note');
  if (note) note.textContent = '她提了一条，看下面';
  toast('她提了一条自我修订');
  await refreshStates();
  await refreshProposals();
  renderProposals();
  renderStList();
}

function renderMilestones() {
  const box = $('ms-list');
  if (!box) return;
  box.innerHTML = '';
  const list = (stCurrent && stCurrent.milestones) || [];
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有里程碑（聊几轮她就会记下第一条）</div>';
    return;
  }
  for (const m of list) {
    const el = document.createElement('span');
    el.className = 'ms-item';
    el.innerHTML = `<b>${escapeHtml(m.title)}</b><em style="opacity:.6;font-style:normal">${
      m.auto ? '自动' : '手写'
    }</em>`;
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = '删掉这条里程碑';
    del.addEventListener('click', async () => {
      const next = { ...stCurrent, milestones: list.filter((x) => x.id !== m.id) };
      try {
        const saved = await invoke('state_save', { state: next });
        states[saved.characterId] = saved;
        stCurrent = JSON.parse(JSON.stringify(saved));
        renderMilestones();
        toast('已删掉');
      } catch (e) {
        fail(e);
      }
    });
    el.appendChild(del);
    box.appendChild(el);
  }
}

async function addMilestone() {
  const title = $('ms-new').value.trim();
  if (!title) return;
  if (!stCurrent) return;
  const list = (stCurrent.milestones || []).concat([
    { id: 'm-' + Date.now(), at: Date.now(), title, note: '', auto: false },
  ]);
  try {
    const saved = await invoke('state_save', { state: { ...stCurrent, milestones: list } });
    states[saved.characterId] = saved;
    stCurrent = JSON.parse(JSON.stringify(saved));
    $('ms-new').value = '';
    renderMilestones();
    toast('记下了');
  } catch (e) {
    fail(e);
  }
}

/** 场景的预设：名字 + 一句话背景。挑一个 = 换场景，也可以自己写。 */
// 【为什么是按露娜写的】这几个场景全部长在她的设定里：尾巴、蝙蝠翅膀、偷吃零食、
// 少女漫画、魔界裂隙口、还有角上那道裂纹 —— 换成别的角色（铃/三千代）就该重写一份，
// 或者直接用下面那个输入框自己写一句。
const SCENE_PRESETS = [
  ['人间书桌', '你在电脑前干活，她趴在桌角，尾巴有一下没一下地敲你的手背'],
  ['深夜偷吃', '凌晨的厨房，她踩着凳子翻零食柜，嘴上说「本小姐只是检查有没有过期」'],
  ['雷雨天', '外面在打雷，她嘴上讲「本小姐才不怕」，人却越坐越近，翅膀不自觉收了起来'],
  ['魔界裂隙口', '人间与魔界交界的那道缝边上，风是往里吹的 —— 回魔界的路，她其实不太想走'],
  ['被窝窝', '睡前的被窝，她缩成一团只露出尾巴尖，少女漫画压在枕头下面'],
  ['她闹脾气', '你把她晾了大半天，她背对着你坐在窗台上，尾巴竖得笔直（等你来哄）'],
];

// ── 场景（我们此刻在哪）────────────────────────────────────────────
//
// 【为什么值得一张卡】角色扮演的细节全靠场景锚定。没有它，她只能在真空里撒娇，
// 三句就开始重复 —— 她其实一直在**自己编场景**，只是没有地方把它放下来。
function renderScene() {
  const box = $('scene-presets');
  if (!box) return;
  const s = (stCurrent && stCurrent.scene) || {};
  const text = String(s.text || '');
  $('sf-scene').value = text;
  box.innerHTML = SCENE_PRESETS.map(
    (p) =>
      '<button class="scene-chip' +
      (s.name === p[0] ? ' on' : '') +
      '" data-name="' +
      escapeHtml(p[0]) +
      '" data-text="' +
      escapeHtml(p[1]) +
      '">' +
      escapeHtml(p[0]) +
      '</button>',
  ).join('');
  for (const b of box.querySelectorAll('.scene-chip')) {
    b.addEventListener('click', () => saveScene(b.dataset.name, b.dataset.text));
  }
  const sub = $('scene-sub');
  if (sub) sub.textContent = text ? s.name || '自定义' : '没设';
  const hint = $('scene-hint');
  if (hint) {
    hint.textContent = text
      ? '她此刻把「' + text + '」当作背景；改一个字都算换场景。'
      : '没设场景 = 不加【场景】块（零注入）。挑一个预设，或者自己写一句。';
  }
}

/** 存场景。走既有的 `state_save`（不新开命令）—— 它本来就是整份状态写回。 */
async function saveScene(name, text) {
  if (!stCurrent) {
    toast('先选一个角色', true);
    return;
  }
  try {
    const saved = await invoke('state_save', {
      state: {
        ...stCurrent,
        scene: { name: name || '', text: String(text || '').trim(), since: Date.now() },
      },
    });
    states[saved.characterId] = saved;
    stCurrent = JSON.parse(JSON.stringify(saved));
    renderStAll();
    toast(name ? '场景换成「' + name + '」' : '场景已设置');
  } catch (e) {
    fail(e);
  }
}

// ── 边界与出戏 ────────────────────────────────────────────────────
function renderBoundary() {
  if (!$('sf-avoid')) return;
  $('sf-avoid').value = cfg.boundariesAvoid || '';
  $('sf-ooc').value = cfg.oocToken || '';
  const avoid = String(cfg.boundariesAvoid || '').trim();
  const tok = String(cfg.oocToken || '').trim();
  const sub = $('boundary-sub');
  if (sub) {
    const bits = [];
    if (avoid) bits.push('有雷点');
    if (tok) bits.push('暗号「' + tok + '」');
    sub.textContent = bits.length ? bits.join(' · ') : '都没配';
  }
  const hint = $('boundary-hint');
  if (hint) {
    hint.textContent =
      '雷点进【边界】块（每轮都带，零成本）；暗号只在**这一轮消息**里出现时才触发【出戏】块 —— 打完这一轮她就自动回去继续演。';
  }
}

// ── 立绘（聊天窗口左下角） ─────────────────────────────────────────
//
// 一个角色**一套**图：内置角色走 exe 里编好的 DeepSeek 娘，自建角色传自己的 PNG。
// 下面那排格子就是表情差分：`avVariant` = "正在编辑哪一格"，上传与「清掉这张」都
// 只作用于它。落盘、清洗、大小限制、**回落的四级顺序**全在 Rust（avatar.rs），
// 这儿只管预览与选择 —— 判定逻辑不在两边各抄一份。
let avView = null;
/** 后端的格子元数据（每个变体一行：来源、实际用到哪张、能不能单独清） */
let avSlots = [];
/** 正在编辑哪一格表情 */
let avVariant = 'neutral';

/** 变体名的中文说法。**只用于界面**：Rust 侧与文件名一律用英文名，别名即失联。 */
const AV_LABEL = {
  neutral: '默认',
  happy: '开心',
  smug: '得意',
  angry: '生气',
  sad: '难过',
  sleepy: '困倦',
  shy: '害羞',
};
const avLabel = (v) => AV_LABEL[v] || v;

/** 立绘跟着「编辑器里正在编辑的角色」走；没开编辑器就跟着激活角色。 */
function avatarTargetId() {
  if (stCurrent && stCurrent.characterId) return stCurrent.characterId;
  const ap = cfg.activePersona;
  return ap && ap !== 'off' ? ap : '';
}

/** 画那排表情格子。 */
async function renderAvatarSlots() {
  const box = $('av-slots');
  if (!box) return;
  try {
    avSlots = await invoke('dsc_avatar_matrix', { id: avatarTargetId() || null });
  } catch (e) {
    avSlots = [];
  }
  // 换了角色之后，原来选中的那一格可能压根不存在 → 拉回默认
  if (!avSlots.some((s) => s.variant === avVariant)) avVariant = 'neutral';
  box.innerHTML = '';
  for (const s of avSlots) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `avatar-slot src-${s.source}${s.variant === avVariant ? ' on' : ''}`;
    b.dataset.variant = s.variant;
    b.title =
      s.source === 'user'
        ? `${avLabel(s.variant)}：你传的图`
        : s.source === 'builtin'
          ? `${avLabel(s.variant)}：内置素材自带`
          : `${avLabel(s.variant)}：还空着，会回落成「${avLabel(s.actual || 'neutral')}」`;
    const dot = document.createElement('span');
    dot.className = 'avatar-slot-dot';
    const name = document.createElement('span');
    name.textContent = avLabel(s.variant);
    b.append(dot, name);
    b.addEventListener('click', () => {
      avVariant = s.variant;
      renderAvatar();
    });
    box.appendChild(b);
  }
}

async function renderAvatar() {
  if (!$('av-img')) return;
  await renderAvatarSlots();
  const slot = avSlots.find((s) => s.variant === avVariant) || {};
  try {
    avView = await invoke('dsc_avatar_get', {
      id: avatarTargetId() || null,
      variant: avVariant,
    });
  } catch (e) {
    $('av-hint').textContent = '读不出来：' + e;
    return;
  }
  const v = avView || {};
  if (v.dataUrl) {
    $('av-img').src = v.dataUrl;
    $('av-img').style.display = 'block';
    $('av-empty').style.display = 'none';
  } else {
    $('av-img').removeAttribute('src');
    $('av-img').style.display = 'none';
    $('av-empty').style.display = 'flex';
  }
  // 「来源」要说清是三件事：你专门给这格传的 / 内置自带 / 靠单图兜的
  const who =
    v.source === 'builtin'
      ? '内置素材'
      : v.source === 'user'
        ? slot.actual === 'single'
          ? '借用你传的单图'
          : '你传的这张'
        : '没有';
  $('av-meta').textContent =
    `「${avLabel(avVariant)}」　${who}` + (v.width ? `　${v.width}×${v.height}` : '');
  $('av-clear').disabled = !slot.hasUser;
  $('av-clear-all').disabled = !avSlots.some((s) => s.hasUser);
  $('av-hint').textContent = slot.hasUser
    ? `「${avLabel(avVariant)}」这张是你传的；清掉它就回落到默认那张`
    : slot.actual === 'single'
      ? `「${avLabel(avVariant)}」没有单独的图，现在借用你传的那张单图`
      : v.source === 'builtin'
        ? `「${avLabel(avVariant)}」是内置素材自带的（MIT）；想换就选一张 PNG 覆盖它`
        : '这一格还空着，传一张 PNG（要透明背景）就有了';
}

async function uploadAvatar(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return fail('图太大了，上限 8 MB');
  try {
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result || ''));
      r.onerror = () => rej(r.error || new Error('读文件失败'));
      r.readAsDataURL(file);
    });
    await invoke('dsc_avatar_set', {
      id: avatarTargetId(),
      data: dataUrl,
      variant: avVariant,
    });
    await renderAvatar();
    toast(`「${avLabel(avVariant)}」换好了（聊天窗口刷新一下就生效）`);
  } catch (e) {
    fail(e);
  }
}

function renderStAll() {
  renderStList();
  renderStSummary();
  renderStSpark();
  renderStGateHint();
  renderStPills();
  renderProposals();
  renderMilestones();
  $('sf-addendum').value = (stCurrent && stCurrent.addendum) || '';
  $('st-review-note').textContent = '';
  $('st-enabled').checked = cfg.stateEnabled !== false;
  $('st-hud').checked = cfg.hudEnabled !== false;
  $('st-avatar').checked = cfg.avatarEnabled !== false;
  $('st-actmode').value = cfg.activityMode || 'auto';
  $('st-body').checked = cfg.bodyEnabled !== false;
  $('st-user').checked = cfg.userStateEnabled !== false;
  $('sf-idle').value = cfg.proactiveIdleMinutes || 20;
  renderScene();
  renderBoundary();
  renderAvatar();
  // 安静时段：空串 = 那一侧没配（跟 Rust 侧一个判据：两侧都配齐才生效）
  $('sf-quiet-from').value = cfg.proactiveQuietFrom === null || cfg.proactiveQuietFrom === undefined ? '' : cfg.proactiveQuietFrom;
  $('sf-quiet-to').value = cfg.proactiveQuietTo === null || cfg.proactiveQuietTo === undefined ? '' : cfg.proactiveQuietTo;
  // 每天最多：★不能拿 `|| 6` 兜底★ —— 0 是「不限」，`0 || 6` 会把它悄悄改成 6
  $('sf-procap').value = cfg.proactiveDailyCap === null || cfg.proactiveDailyCap === undefined ? 6 : cfg.proactiveDailyCap;
}

/** 身体那几个滑块 + 心跳 + 睡着 + 派生出来的身体语言 */
function bodyOf(s) {
  return (s && s.body) || { sleepiness: 0.2, stamina: 0.85, hunger: 0.25, warmth: 0.5, heartRate: 72, asleep: false, language: '' };
}

function renderBodyFields() {
  const b = bodyOf(stCurrent);
  $('sf-sleep').value = Math.round((b.sleepiness || 0) * 100);
  $('sf-stamina').value = Math.round((b.stamina || 0) * 100);
  $('sf-hunger').value = Math.round((b.hunger || 0) * 100);
  $('sf-warmth').value = Math.round((b.warmth || 0) * 100);
  $('sf-heart').value = b.heartRate || 72;
  $('sf-asleep').checked = !!b.asleep;
  $('sf-language').value = b.language || '（保存后由数值推出来）';
  renderBodyLabels();
}

function renderBodyLabels() {
  $('sf-sleep-val').textContent = `${$('sf-sleep').value}%`;
  $('sf-stamina-val').textContent = `${$('sf-stamina').value}%`;
  $('sf-hunger-val').textContent = `${$('sf-hunger').value}%`;
  $('sf-warmth-val').textContent = `${$('sf-warmth').value}%`;
}

/** 主人（对方）状态 */
function renderUserFields() {
  const u = userState || {};
  $('uf-mood').value = u.mood && u.mood !== '平静' ? u.mood : u.mood || '';
  $('uf-arc').value = u.arc || '';
  $('uf-energy').value = Math.round((u.energy || 0) * 100);
  $('uf-engagement').value = Math.round((u.engagement || 0) * 100);
  $('uf-valence').value = Math.round((u.valence || 0) * 100);
  renderUserLabels();
  const advice = [];
  if (u.busy) advice.push('在忙');
  if (u.tired) advice.push('累/困');
  if (u.turns) advice.push(`已聊 ${u.turns} 轮`);
  if (u.streak >= 3) advice.push(`连着说了 ${u.streak} 条`);
  if (u.avgLen) advice.push(`平均 ${Math.round(u.avgLen)} 字`);
  $('uf-advice').textContent = advice.length
    ? `观察到的：${advice.join(' · ')}（判定持续生效，改滑块只覆盖当前值）`
    : '还没有观察到对方状态（聊几轮就有了）';
}

function renderUserLabels() {
  $('uf-energy-val').textContent = `${$('uf-energy').value}%`;
  $('uf-engagement-val').textContent = `${$('uf-engagement').value}%`;
  $('uf-valence-val').textContent = `${$('uf-valence').value}%`;
}

function stSynced() {
  return {
    mood: $('sf-mood').value.trim(),
    arc: $('sf-arc').value.trim(),
    anchors: $('sf-anchors')
      .value.split('\n')
      .map((x) => x.trim())
      .filter(Boolean),
    valence: Number($('sf-valence').value) / 100,
    arousal: Number($('sf-arousal').value) / 100,
    affinity: Number($('sf-affinity').value),
    energy: Number($('sf-energy').value) / 100,
    addendum: $('sf-addendum').value,
    body: {
      ...(stCurrent && stCurrent.body),
      sleepiness: Number($('sf-sleep').value) / 100,
      stamina: Number($('sf-stamina').value) / 100,
      hunger: Number($('sf-hunger').value) / 100,
      warmth: Number($('sf-warmth').value) / 100,
      heartRate: Math.max(40, Math.min(200, Number($('sf-heart').value) || 72)),
      asleep: $('sf-asleep').checked,
    },
  };
}

/** 主人那半边的表单一并收出来（和角色状态一起保存，一次点完） */
function userSynced() {
  return {
    ...(userState || {}),
    mood: $('uf-mood').value.trim(),
    arc: $('uf-arc').value.trim(),
    energy: Number($('uf-energy').value) / 100,
    engagement: Number($('uf-engagement').value) / 100,
    valence: Number($('uf-valence').value) / 100,
  };
}

function renderStSliderLabels() {
  $('sf-valence-val').textContent = `${$('sf-valence').value}%`;
  $('sf-arousal-val').textContent = `${$('sf-arousal').value}%`;
  $('sf-affinity-val').textContent = $('sf-affinity').value;
  $('sf-energy-val').textContent = `${$('sf-energy').value}%`;
}

function openStEditor(characterId) {
  const s = stOf(characterId);
  stCurrent = JSON.parse(JSON.stringify(s));
  stCurrent.characterId = characterId;
  $('st-editor-title').textContent = charName(characterId);
  $('st-editor-meta').textContent = `${s.turns || 0} 轮 · 采样 ${(s.samples || []).length} 点`;
  $('sf-mood').value = s.mood && s.mood !== '—' ? s.mood : '';
  $('sf-arc').value = s.arc || '';
  $('sf-anchors').value = (s.anchors || []).join('\n');
  $('sf-valence').value = Math.round((s.valence || 0) * 100);
  $('sf-arousal').value = Math.round((s.arousal || 0) * 100);
  $('sf-affinity').value = s.affinity || 0;
  $('sf-energy').value = Math.round((s.energy || 0) * 100);
  renderStSliderLabels();
  renderBodyFields();
  renderUserFields();
  // 这三样原来只在 renderStAll 里渲染，而进页面时 stCurrent 还是空的 ——
  // 于是"自动选中角色"之后它们一直空着（验收抓到的假空）
  $('sf-addendum').value = s.addendum || '';
  renderMilestones();
  refreshProposals().then(renderProposals).catch(() => {});
  $('st-save').disabled = false;
  $('st-save-note').textContent = '';
  renderStSummary();
  renderStSpark();
  renderStList();
}

async function saveSt() {
  if (!stCurrent) return;
  const patch = stSynced();
  const next = { ...stCurrent, ...patch };
  // 身体语言由壳按新数值重算，这里不猜
  if (next.body) next.body.language = '';
  try {
    const saved = await invoke('state_save', { state: next });
    states[saved.characterId] = saved;
    stCurrent = JSON.parse(JSON.stringify(saved));
    // 主人那半边一起存（同一张表单，一次点完）
    try {
      userState = await invoke('user_state_save', { state: userSynced() });
    } catch (e) {
      /* 用户状态存失败不该让角色那半边的成功白费 */
    }
    $('st-save-note').textContent = '已保存';
    toast('状态已保存');
    renderStAll();
    openStEditor(saved.characterId);
  } catch (e) {
    fail(e);
  }
}

async function resetSt() {
  if (!stCurrent) return;
  if (!confirm(`重置「${charName(stCurrent.characterId)}」的状态？\n心情/好感/锚点都会回到初始值（旧文件进 state-trash 可以找回）。`)) return;
  try {
    await invoke('state_reset', { characterId: stCurrent.characterId });
    delete states[stCurrent.characterId];
    stCurrent = null;
    $('st-save').disabled = true;
    $('st-editor-title').textContent = '未选择角色';
    $('st-editor-meta').textContent = '';
    await refreshStates();
    renderStAll();
    toast('已重置（可在 state-trash 找回）');
  } catch (e) {
    fail(e);
  }
}

// ── 记忆 ────────────────────────────────────────────────────────────────
async function reloadMemories() {
  memories = await invoke('memory_list');
  renderMemAll();
}

function memVisible() {
  if (memFilter === 'global') return memories.filter((m) => !m.characterId);
  if (memFilter === 'char') return memories.filter((m) => !!m.characterId);
  if (memFilter === 'active') {
    const me = effectiveCharacterId();
    return memories.filter((m) => !m.characterId || m.characterId === me);
  }
  return memories;
}

/**
 * 【为什么要单独排一次】默认视图原来是**纯按权重降序** —— 而权重是跨角色的
 * 同一个量纲，于是三个角色的记忆按分数交错排列，一眼扫过去就是"记串了"
 * （主人就是这么反馈的）。改成**先按角色聚块**：当前角色的排最前、全局次之、
 * 其余角色各聚一块，块内再按权重。
 */
function memSorted(list) {
  const me = effectiveCharacterId();
  const rank = (m) => (me && m.characterId === me ? 0 : !m.characterId ? 1 : 2);
  return list.slice().sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if ((a.characterId || '') !== (b.characterId || '')) {
      return String(a.characterId || '').localeCompare(String(b.characterId || ''));
    }
    return (b.weight || 0) - (a.weight || 0);
  });
}

function charName(id) {
  const p = personas.find((x) => x.id === id);
  return p ? p.name : id || '全局';
}

function renderMemList() {
  const box = $('mem-list');
  const list = memSorted(memVisible());
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = memoryEmptyHint();
  }
  const effIdForMem = effectiveCharacterId();
  for (const m of list) {
    const isActive = !!effIdForMem && m.characterId === effIdForMem;
    const card = document.createElement('div');
    card.className = 'card' + (memCurrent && memCurrent.id === m.id ? ' on' : '');
    card.dataset.id = m.id;
    card.title = m.content;

    const av = document.createElement('div');
    av.className = 'avatar';
    av.setAttribute('style', avatarStyle(m.name));
    av.textContent = (m.name || '?').trim().charAt(0);
    card.appendChild(av);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = m.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    // 权重就是"注入时的排序分"：importance 打底、随时间衰减、被用到回血（memory::weight_of）。
    // 摆在列表里主人才能看出"为什么这条排在前面" —— 否则衰减是个看不见的机制。
    const w = typeof m.weight === 'number' ? ` · 权重 ${m.weight.toFixed(2)}` : '';
    sub.textContent =
      (m.characterId ? charName(m.characterId) : '全局') + ' · ' + (m.keys || []).join('/') + w;
    meta.appendChild(nm);
    meta.appendChild(sub);
    card.appendChild(meta);

    const imp = document.createElement('div');
    imp.className = 'imp';
    for (let i = 1; i <= 5; i++) {
      const dot = document.createElement('i');
      if (i <= m.importance) dot.className = 'on';
      imp.appendChild(dot);
    }
    card.appendChild(imp);

    if (m.pinned) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = '钉';
      card.appendChild(b);
    } else if (isActive) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = '当前角色';
      card.appendChild(b);
    }

    card.addEventListener('click', () => openMemEditor(m.id));
    box.appendChild(card);
  }
  $('mem-foot').textContent = memories.length ? `${list.length}/${memories.length} 条` : '空';
}

function memoryEmptyHint() {
  if (!memories.length) {
    return '<div class="empty">还没有记忆<br><span style="color:#5c5578">新建一条，或等自动整理攒出来</span></div>';
  }
  return '<div class="empty">这个筛选下没有条目</div>';
}

function renderMemStatus() {
  const on = cfg.memoryEnabled !== false;
  $('mem-dot').classList.toggle('on', on);
  const active = effectivePersona();
  const effId = effectiveCharacterId();
  const visible = memories.filter((m) => !m.characterId || m.characterId === effId).length;
  const auto = Number(cfg.extractEveryTurns || 0);
  $('mem-status').textContent = on
    ? `${visible} 条可见 · 预算 ${cfg.memoryBudget || 500} tokens/轮` +
      (auto ? ` · 每 ${auto} 轮自动整理` : '')
    : '已关闭';
  $('mem-enabled').checked = on;
  $('mem-budget').value = cfg.memoryBudget || 500;
  $('mem-budget-val').textContent = cfg.memoryBudget || 500;
  const autoOpt = AUTO_OPTIONS.find((o) => o.v === auto) || AUTO_OPTIONS[0];
  $('mem-hint').textContent =
    (active
      ? `当前角色「${active.name}」：注入 全局记忆 + 它的角色记忆；其他角色的记忆不可见。`
      : '当前没有人设被激活：只注入**全局记忆**，带角色的记忆一条都不可见。') +
    (on
      ? ` 自动整理${auto ? '已开' : '关闭'}：${autoOpt.hint}`
      : '');
}

function renderAutoPills() {
  const auto = Number(cfg.extractEveryTurns || 0);
  const b = [...$('mem-auto').querySelectorAll('button')].find((x) => Number(x.dataset.v) === auto);
  placePill('mem-auto-pill', b);
  // 会话接续上限：隐藏会话接着往下写才不会表现成"一条消息被反复改写"，
  // 但每次请求都会带上已有历史，所以要有这个封顶（0 = 不轮换）
  const chain = Number(cfg.hiddenChainTurns ?? 20);
  const cb = [...$('mem-chain').querySelectorAll('button')].find((x) => Number(x.dataset.v) === chain);
  placePill('mem-chain-pill', cb);
}

function renderMemPills() {
  const f = [...$('mem-filter').querySelectorAll('button')].find((b) => b.dataset.v === memFilter);
  placePill('mem-filter-pill', f);
  const imp = [...$('mf-importance').querySelectorAll('button')].find((b) => Number(b.dataset.v) === memImportance);
  placePill('mf-imp-pill', imp);
  renderAutoPills();
}

function renderMemCharOptions() {
  const sel = $('mf-char');
  sel.innerHTML = '';
  const g = document.createElement('option');
  g.value = '';
  g.textContent = '全局（所有角色都可见）';
  sel.appendChild(g);
  for (const p of personas) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  }
}

function renderMemAll() {
  renderMemList();
  renderMemStatus();
  renderMemCharOptions();
  renderMemPills();
}

function renderMemCount() {
  const t = $('mf-content').value || '';
  $('mf-count').textContent = `${t.length} 字 · 约 ${estimateTokens(t)} tokens`;
}

function openMemEditor(id) {
  const m = memories.find((x) => x.id === id);
  if (!m) return;
  memCurrent = { ...m };
  memImportance = m.importance || 3;
  $('mf-name').value = m.name;
  $('mf-keys').value = (m.keys || []).join(', ');
  $('mf-content').value = m.content;
  $('mf-char').value = m.characterId || '';
  $('mf-pinned').checked = !!m.pinned;
  $('mem-editor-title').textContent = m.name;
  const src = m.source === 'extract' ? '自动整理抽出' : '手动添加';
  $('mem-editor-meta').textContent = `${m.id} · ${src} · 用过 ${m.accessCount || 0} 次`;
  $('mem-save').disabled = false;
  $('mem-delete').disabled = false;
  renderMemCount();
  renderMemPills();
  renderMemList();
}

function newMemory() {
  // 新记忆默认挂到**实际生效**的角色上（没选过时就是出厂默认角色）——
  // 挂空串会变成"全局记忆"，那是另一个意思
  const effId = effectiveCharacterId();
  memCurrent = { id: '', characterId: effId, name: '', content: '', keys: [], importance: 3, pinned: false };
  memImportance = 3;
  $('mf-name').value = '';
  $('mf-keys').value = '';
  $('mf-content').value = '';
  $('mf-char').value = effId;
  $('mf-pinned').checked = false;
  $('mem-editor-title').textContent = '新建记忆';
  $('mem-editor-meta').textContent = '标题与内容填好后保存';
  $('mem-save').disabled = false;
  $('mem-delete').disabled = true;
  renderMemCount();
  renderMemPills();
  renderMemList();
  $('mf-name').focus();
}

async function saveMemory() {
  const name = $('mf-name').value.trim();
  if (!name) return toast('标题不能为空', true);
  const item = {
    id: (memCurrent && memCurrent.id) || '',
    characterId: $('mf-char').value || '',
    name,
    content: $('mf-content').value,
    keys: $('mf-keys')
      .value.split(/[,，、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    importance: memImportance,
    pinned: $('mf-pinned').checked,
    createdAt: (memCurrent && memCurrent.createdAt) || 0,
    lastAccessedAt: (memCurrent && memCurrent.lastAccessedAt) || 0,
    accessCount: (memCurrent && memCurrent.accessCount) || 0,
  };
  try {
    const saved = await invoke('memory_save', { item });
    toast('已保存');
    await reloadMemories();
    openMemEditor(saved.id);
  } catch (e) {
    fail(e);
  }
}

async function deleteMemory() {
  if (!memCurrent || !memCurrent.id) return;
  if (!confirm(`删除记忆「${memCurrent.name}」？\n会移到 memory-trash 目录，可以找回。`)) return;
  try {
    await invoke('memory_delete', { id: memCurrent.id });
    toast('已删除（可在 memory-trash 找回）');
    memCurrent = null;
    $('mem-editor-title').textContent = '未选择记忆';
    $('mem-editor-meta').textContent = '';
    $('mf-name').value = '';
    $('mf-keys').value = '';
    $('mf-content').value = '';
    $('mem-save').disabled = true;
    $('mem-delete').disabled = true;
    renderMemCount();
    await reloadMemories();
  } catch (e) {
    fail(e);
  }
}

async function setMemoryEnabled(on) {
  cfg.memoryEnabled = !!on;
  try {
    await patchCfg({ memoryEnabled: !!on });
    renderMemStatus();
    toast(on ? '记忆已启用' : '记忆已关闭');
  } catch (e) {
    fail(e);
  }
}

/** 改自动整理节奏 —— 这是唯一一个会"不点也花额度"的开关，落盘要立刻可见 */async function setAutoExtract(v) {
  const prev = Number(cfg.extractEveryTurns || 0);
  const next = Number(v) || 0;
  cfg.extractEveryTurns = next;
  renderMemStatus();
  renderAutoPills();
  try {
    await patchCfg({ extractEveryTurns: next });
    const o = AUTO_OPTIONS.find((x) => x.v === next) || AUTO_OPTIONS[0];
    toast(next ? `自动整理已开：${o.hint}会用到网页额度` : '自动整理已关：不会再自动花额度');
  } catch (e) {
    cfg.extractEveryTurns = prev;
    renderMemStatus();
    renderAutoPills();
    fail(e);
  }
}

/**
 * 改隐藏会话的接续上限 —— 接着往下写才留得下可回看的记录，
 * 但每次请求都会带上该会话已有的历史，所以这个封顶是成本闸（0 = 不轮换）。
 */
async function setChainTurns(v) {
  const prev = Number(cfg.hiddenChainTurns ?? 20);
  const next = Number(v) || 0;
  cfg.hiddenChainTurns = next;
  renderAutoPills();
  try {
    await patchCfg({ hiddenChainTurns: next });
    toast(next ? `整理会话已设：每 ${next} 次换个新会话` : '整理会话会一直往下接 —— 上下文会越来越长');
  } catch (e) {
    cfg.hiddenChainTurns = prev;
    renderAutoPills();
    fail(e);
  }
}

let budgetTimer = null;
function setMemoryBudget(v) {
  cfg.memoryBudget = Number(v);
  $('mem-budget-val').textContent = cfg.memoryBudget;
  clearTimeout(budgetTimer);
  // 拖动时每格都写盘没必要，停手 400ms 再落
  budgetTimer = setTimeout(async () => {
    try {
      await patchCfg({ memoryBudget: cfg.memoryBudget });
      renderMemStatus();
    } catch (e) {
      fail(e);
    }
  }, 400);
}

// ── 立即整理（B 链路：让主窗口里那页自己去整理） ──────────────────────────
let extractTimer = null;

function extractHint(text, isErr) {
  const el = $('mem-extract-hint');
  el.textContent = text || '';
  el.style.color = isErr ? '#ff8fa8' : '';
}

function setExtractBusy(busy) {
  const btn = $('mem-extract');
  btn.disabled = busy;
  btn.textContent = busy ? '整理中…' : '立即整理';
  $('mem-dot').classList.toggle('busy', busy);
}

async function runExtract() {
  setExtractBusy(true);
  extractHint('已把请求交给 DeepSeek 窗口，正在整理最近几轮对话…');
  try {
    await invoke('memory_extract');
  } catch (e) {
    setExtractBusy(false);
    extractHint(String((e && e.message) || e), true);
    return;
  }
  // 页面跑完会发 dsc:memory-ingest 事件；没等到就当超时（别把按钮永久锁住）
  clearTimeout(extractTimer);
  extractTimer = setTimeout(() => {
    setExtractBusy(false);
    extractHint('等了两分钟还没回来 —— 看下主窗口是不是没登录，或 %TEMP%\\ds-companion.log', true);
  }, 120000);
}

/** 页面侧的整理结果（成功/失败都会来一条） */
async function onIngestEvent(event) {
  clearTimeout(extractTimer);
  setExtractBusy(false);
  const r = event.payload || {};
  await reloadMemories();
  if (r.error) {
    extractHint('整理失败：' + r.error, true);
    toast('整理失败，看设置里的说明', true);
    return;
  }
  const parts = [];
  if (r.added) parts.push(`新增 ${r.added}`);
  if (r.updated) parts.push(`更新 ${r.updated}`);
  if (r.skipped) parts.push(`跳过 ${r.skipped}`);
  extractHint('上次整理：' + (parts.length ? parts.join(' · ') : '没有值得记的新内容'));
  toast(parts.length ? `记忆已整理：${parts.join('，')}` : '这轮没有值得记的内容');
}

function bindProposalEvents() {
  const api = window.__TAURI__;
  if (!api || !api.event || !api.event.listen) return false;
  api.event.listen('dsc:proposal', onProposalEvent);
  return true;
}

function bindIngestEvents() {
  const api = window.__TAURI__;
  if (!api || !api.event || !api.event.listen) return false;
  api.event.listen('dsc:memory-ingest', onIngestEvent);
  return true;
}

// ── 状态页的三个成本闸 ──────────────────────────────────────────────────
/**
 * 只改一个字段就走读-改-写（patchCfg）。
 * 这三个闸直接关系到"会不会自己花钱"，所以落盘必须立刻可见、失败要能回滚。
 */
async function setGate(patch, msg) {
  const before = { ...cfg };
  try {
    await patchCfg(patch);
    renderStAll();
    if (msg) toast(msg);
  } catch (e) {
    cfg = before;
    renderStAll();
    fail(e);
  }
}

// ── 绑定 ─────────────────────────────────────────────────────────────────
$('av-pick').addEventListener('click', () => $('av-file').click());
$('av-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = ''; // 同一个文件连选两次也要能触发
  uploadAvatar(f);
});
$('av-clear').addEventListener('click', async () => {
  try {
    await invoke('dsc_avatar_clear', { id: avatarTargetId(), variant: avVariant });
    await renderAvatar();
    toast(`「${avLabel(avVariant)}」清掉了`);
  } catch (e) {
    fail(e);
  }
});
$('av-clear-all').addEventListener('click', async () => {
  const n = avSlots.filter((s) => s.hasUser).length;
  if (!confirm(`把这 ${n} 张你传的立绘全清掉？\n内置素材不受影响。`)) return;
  try {
    await invoke('dsc_avatar_clear', { id: avatarTargetId() });
    await renderAvatar();
    toast('立绘全清掉了');
  } catch (e) {
    fail(e);
  }
});
$('st-avatar').addEventListener('change', (e) =>
  setGate(
    { avatarEnabled: e.target.checked },
    e.target.checked ? '立绘已显示' : '立绘已隐藏',
  ),
);
$('st-actmode').addEventListener('change', (e) =>
  setGate(
    { activityMode: e.target.value },
    e.target.value === 'auto' ? '她会照当前场景自己想' : '只用列表里那几条',
  ),
);
$('btn-new').addEventListener('click', newPersona);
$('btn-save').addEventListener('click', saveCurrent);
$('btn-delete').addEventListener('click', deleteCurrent);
$('btn-import').addEventListener('click', openImport);
$('btn-import-close').addEventListener('click', () => $('import-mask').classList.add('hidden'));
$('import-mask').addEventListener('mousedown', (e) => {
  if (e.target === $('import-mask')) $('import-mask').classList.add('hidden');
});
$('f-body').addEventListener('input', renderCount);
$('active').addEventListener('change', (e) => setActive(e.target.value));
for (const b of $('cadence').querySelectorAll('button')) {
  b.addEventListener('click', () => setCadence(b.dataset.v));
}
for (const b of $('mute').querySelectorAll('button')) {
  b.addEventListener('click', () => setMute(b.dataset.v));
}

// 日志页的绑定
$('log-refresh').addEventListener('click', refreshLog);
$('data-row').addEventListener('click', async () => {
  try {
    await invoke('data_reveal');
  } catch (e) {
    fail(e);
  }
});
$('log-follow').addEventListener('change', refreshLog);
$('log-open').addEventListener('click', async () => {
  try {
    await invoke('log_reveal');
  } catch (e) {
    fail(e);
  }
});
$('log-clear').addEventListener('click', async () => {
  if (!confirm('清空日志？（当前这份会留成 ds-companion.log.1）')) return;
  try {
    await invoke('log_clear');
    await refreshLog();
    toast('日志已清空');
  } catch (e) {
    fail(e);
  }
});
$('log-autostart').addEventListener('change', async (e) => {
  const want = e.target.checked;
  try {
    const real = await invoke('autostart_set', { on: want });
    e.target.checked = !!real;
    toast(real ? '已设置开机自启' : '已取消开机自启');
    if (real !== want) toast('系统没接受这个设置（可能被策略挡了）', true);
  } catch (err) {
    e.target.checked = !want;
    fail(err);
  }
});
$('log-show-main').addEventListener('click', () => invoke('window_show_main').catch(fail));

// 工具页的绑定
$('tl-refresh').addEventListener('click', () => refreshTools().catch(fail));
$('tl-reveal').addEventListener('click', async () => {
  // 没有工作区时点了它也没意义：先用"设为工作区"填一个
  if (!toolsInfo || !toolsInfo.workspaceOk) {
    toast('先设置一个有效的工作区', true);
    return;
  }
  try {
    await invoke('data_reveal');
  } catch (e) {
    fail(e);
  }
});
$('tl-ws-save').addEventListener('click', async () => {
  const path = $('tl-ws').value.trim();
  if (!path) {
    toast('先填一个目录路径', true);
    return;
  }
  try {
    const saved = await invoke('tools_set_workspace', { path });
    toast(`工作区已设为 ${saved}`);
    await refreshTools();
  } catch (e) {
    fail(e);
  }
});
$('tl-ws-clear').addEventListener('click', async () => {
  try {
    await invoke('tools_set_workspace', { path: '' });
    toast('工作区已清空（工具将不再注入）');
    await refreshTools();
  } catch (e) {
    fail(e);
  }
});
$('tl-enabled').addEventListener('change', async (e) => {
  const want = e.target.checked;
  try {
    const real = await invoke('tools_set_enabled', { on: want });
    e.target.checked = !!real;
    toast(real ? '工具已启用' : '工具已关闭');
  } catch (err) {
    // 没工作区时 Rust 会拒绝 —— 把开关按回去，别让界面显示成"开着"
    e.target.checked = !want;
    fail(err);
  }
  await refreshTools().catch(fail);
});
// 写工具开关：它**只管"她知不知道有这回事"**，真正写下去还要她在聊天窗口里拿到你的确认
$('tl-write').addEventListener('change', async (e) => {
  const want = e.target.checked;
  try {
    const real = await invoke('tools_set_write_enabled', { on: want });
    e.target.checked = !!real;
    toast(real ? '她可以提出写入了（每次仍需你确认）' : '写工具已关闭');
  } catch (err) {
    e.target.checked = !want;
    fail(err);
  }
  await refreshTools().catch(fail);
});
// 前台窗口感知 —— **默认关**，而且必须主人自己点头才开。
// 这一层读的不是聊天内容，是"他在干什么"，性质不同，所以不给任何默认值。
$('tl-front').addEventListener('change', async (e) => {
  const want = e.target.checked;
  try {
    await patchCfg({ watchApp: want });
    toast(
      want
        ? '开了 —— 她只知道你在用哪个软件，看不到里面的内容'
        : '关了 —— 她不会再看你的屏幕'
    );
  } catch (err) {
    e.target.checked = !want;
    fail(err);
  }
  await refreshFront().catch(fail);
});
$('tl-front-probe').addEventListener('click', () => refreshFront().catch(fail));

/** 设置页补处理：卡片丢了（页面刷新/关掉了）也能决定，只是不会有回灌 */
async function decidePending(allow) {
  const p = window.__DSC_PENDING__;
  if (!p) {
    toast('现在没有待确认的写入', true);
    return;
  }
  if (allow && !window.confirm(`确定要写入 ${p.path} 吗？`)) return;
  try {
    const out = await invoke('dsc_tool_proposal_decide', { id: p.id, allow });
    toast(out && out.ok ? `已写入 ${p.path}` : `没有写入：${(out && out.error) || '已丢弃'}`);
  } catch (e) {
    fail(e);
  }
  await refreshTools().catch(fail);
}
$('tl-pending-allow').addEventListener('click', () => decidePending(true));
$('tl-pending-deny').addEventListener('click', () => decidePending(false));
// 设置窗口被 Rust 侧打开到某一页（托盘「看日志」等）
if (window.__TAURI__ && window.__TAURI__.event) {
  try {
    window.__TAURI__.event.listen('dsc:open-tab', (ev) => setTab(String(ev.payload || 'persona')));
  } catch (e) {
    /* 拿不到就用默认页签 */
  }
}
// 回收站封顶：历史垃圾不会自己消失（旧的 prune 只在"又删了一个"时才跑），给它一个手动出口
$('data-prune').addEventListener('click', async () => {
  try {
    const removed = await invoke('trash_prune');
    await refreshDataDir();
    toast(removed > 0 ? `回收站整理完成：清掉 ${removed} 份旧备份` : '回收站已经在上限内，没动');
  } catch (e) {
    fail(e);
  }
});
$('log-quit').addEventListener('click', async () => {
  if (!confirm('退出 DS Companion？\n关窗只是收进托盘，这个才是真的不干了。')) return;
  try {
    await invoke('app_quit');
  } catch (e) {
    fail(e);
  }
});

// 状态页签的绑定
$('st-enabled').addEventListener('change', (e) =>
  setGate({ stateEnabled: e.target.checked }, e.target.checked ? '状态注入已开' : '状态注入已关'),
);
$('st-hud').addEventListener('change', (e) =>
  setGate({ hudEnabled: e.target.checked }, e.target.checked ? '页面 HUD 已显示' : '页面 HUD 已隐藏'),
);
$('st-body').addEventListener('change', (e) =>
  setGate(
    { bodyEnabled: e.target.checked },
    e.target.checked ? '身体层会一起注入（约几十个 token/轮）' : '身体层不再注入',
  ),
);
$('st-user').addEventListener('change', (e) =>
  setGate(
    { userStateEnabled: e.target.checked },
    e.target.checked ? '会把主人的状态一起告诉她' : '不再告诉她对方的状态',
  ),
);
for (const b of $('st-anchor').querySelectorAll('button')) {
  b.addEventListener('click', () =>
    setGate(
      { anchorEveryTurns: Number(b.dataset.v) },
      Number(b.dataset.v) ? `每 ${b.dataset.v} 轮回锚一次` : '人设回锚已关',
    ),
  );
}
for (const b of $('st-sense').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    const o = SENSE_OPTIONS.find((x) => x.v === b.dataset.v);
    setGate({ senseMode: b.dataset.v }, `情绪感知：${o ? o.hint : b.dataset.v}`);
  });
}
for (const b of $('st-proactive').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    const o = PROACTIVE_OPTIONS.find((x) => x.v === b.dataset.v);
    setGate({ proactiveMode: b.dataset.v }, `空闲主动：${o ? o.hint : b.dataset.v}`);
  });
}
// 任务模式三态：自动（本地判）/ 一直工作 / 一直日常
const TASK_OPTIONS = {
  auto: '任务模式：自动（本地关键词判断，不上模型）',
  on: '任务模式：一直当在工作（她会收着点）',
  off: '任务模式：一直当日常（不再自动收敛）',
};
for (const b of $('st-task').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    setGate({ taskMode: b.dataset.v }, TASK_OPTIONS[b.dataset.v] || b.dataset.v);
  });
}
$('sf-idle').addEventListener('change', (e) => {
  const v = Math.max(3, Math.min(600, Number(e.target.value) || 20));
  e.target.value = v;
  setGate({ proactiveIdleMinutes: v });
});
// 安静时段的两个小时：清空就是「不配这一侧」（null），别拿 0 当默认 ——
// 0 点是个合法的整点，把空当成 0 就等于凭空禁言凌晨那一段
function quietHour(el) {
  const raw = String(el.value == null ? '' : el.value).trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(23, Math.round(n)));
}
for (const [id, key] of [
  ['sf-quiet-from', 'proactiveQuietFrom'],
  ['sf-quiet-to', 'proactiveQuietTo'],
]) {
  $(id).addEventListener('change', () => {
    const v = quietHour($(id));
    setGate({ [key]: v });
  });
}
$('sf-procap').addEventListener('change', (e) => {
  // 空 → 回到默认 6；填 0 就是「不限」（跟 Rust 的 proactive_budget_ok 一个意思）
  const raw = String(e.target.value == null ? '' : e.target.value).trim();
  const v = raw === '' ? 6 : Math.max(0, Math.min(99, Math.round(Number(raw) || 0)));
  e.target.value = v;
  setGate({ proactiveDailyCap: v });
});
for (const b of $('st-review').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    const v = b.dataset.v;
    const label =
      v === 'off' ? '自我修订已关：她不会自己反省了'
      : v === 'manual' ? '自我修订：只有你点「让她反思一下」才会花额度'
      : '自我修订：每 30 轮她自己反省一次（会花额度）';
    setGate({ selfReviewMode: v }, label);
  });
}
$('st-review-now').addEventListener('click', reviewNow);
for (const b of $('st-jump').querySelectorAll('button')) {
  b.addEventListener('click', () => scrollToSection(b.dataset.jump));
}
$('ms-add').addEventListener('click', addMilestone);
$('ms-new').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addMilestone();
});
$('st-save').addEventListener('click', saveSt);
$('st-reset').addEventListener('click', resetSt);
$('st-quota').addEventListener('click', clearQuota);
for (const id of ['sf-valence', 'sf-arousal', 'sf-affinity', 'sf-energy']) {
  $(id).addEventListener('input', renderStSliderLabels);
}
for (const id of ['sf-sleep', 'sf-stamina', 'sf-hunger', 'sf-warmth']) {
  $(id).addEventListener('input', renderBodyLabels);
}
// 「喂一顿」：直接降 50% 饥饿。
// hunger 只有这一条下降通路 —— 靠时间只会一直涨，涨到 100% 就再也回不来
// （主人报的"饿的状态怎么也解除不了"）。对话里喂（"给你带了奶茶"）也会自动触发，
// 但那是识别，不一定每次都被判到，所以这里给一个**确定**的出口。
$('sf-feed').addEventListener('click', async () => {
  if (!stCurrent) {
    toast('先选一个角色', true);
    return;
  }
  try {
    const saved = await invoke('state_feed', { characterId: stCurrent.characterId });
    toast(`喂了一顿：饿降到 ${Math.round((saved.body.hunger || 0) * 100)}%`);
    await refreshStates();
    openStEditor(saved.characterId);
    renderStAll();
  } catch (e) {
    fail(e);
  }
});
for (const id of ['uf-energy', 'uf-engagement', 'uf-valence']) {
  $(id).addEventListener('input', renderUserLabels);
}

// 记忆页签的绑定
$('mem-new').addEventListener('click', newMemory);
$('mem-save').addEventListener('click', saveMemory);
$('mem-delete').addEventListener('click', deleteMemory);
$('mem-extract').addEventListener('click', runExtract);
$('mf-content').addEventListener('input', renderMemCount);
$('mf-char').addEventListener('change', renderMemPills);
$('mem-enabled').addEventListener('change', (e) => setMemoryEnabled(e.target.checked));
$('mem-budget').addEventListener('input', (e) => setMemoryBudget(e.target.value));
for (const b of $('mem-auto').querySelectorAll('button')) {
  b.addEventListener('click', () => setAutoExtract(b.dataset.v));
}
for (const b of $('mem-chain').querySelectorAll('button')) {
  b.addEventListener('click', () => setChainTurns(b.dataset.v));
}
for (const b of $('mem-filter').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    memFilter = b.dataset.v;
    renderMemList();
    renderMemPills();
  });
}
for (const b of $('mf-importance').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    memImportance = Number(b.dataset.v);
    renderMemPills();
  });
}
for (const b of document.querySelectorAll('.tb-tab')) {
  b.addEventListener('click', () => setTab(b.dataset.tab));
}
$('today-refresh').addEventListener('click', () => refreshToday());
$('scene-save').addEventListener('click', () => saveScene('', $('sf-scene').value));
$('scene-clear').addEventListener('click', () => saveScene('', ''));
// 边界是**配置**（跟场景不一样：场景是角色的状态），所以走 setGate 那条读-改-写队列
$('sf-avoid').addEventListener('change', (e) => {
  setGate({ boundariesAvoid: String(e.target.value || '').trim() });
});
$('sf-ooc').addEventListener('change', (e) => {
  setGate({ oocToken: String(e.target.value || '').trim() });
});
$('diary-refresh').addEventListener('click', () => {
  // 强制重来：她刚在她那边写完一篇的话，这里得看得见
  diaryLoaded = false;
  syncDiary();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('import-mask').classList.add('hidden');
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (!$('tab-persona').classList.contains('hidden') && !$('btn-save').disabled) saveCurrent();
    if (!$('tab-state').classList.contains('hidden') && !$('st-save').disabled) saveSt();
    if (!$('tab-memory').classList.contains('hidden') && !$('mem-save').disabled) saveMemory();
  }
});

// 窗口宽度变化时重新摆滑块（分段控件的宽度会变）
window.addEventListener('resize', () => {
  renderCadence();
  renderStPills();
  renderMemPills();
});

bindWindowButtons();
bindIngestEvents();
bindProposalEvents();
// 托盘点「看日志」时是新建窗口，事件会赶在监听装好之前发出 —— 所以用"来取一次"兜底
invoke('settings_take_tab')
  .then((t) => {
    if (t) setTab(t);
  })
  .catch(() => {});
if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) {
  window.__TAURI__.event.listen('dsc:open-tab', (ev) => {
    if (ev && ev.payload) setTab(ev.payload);
  });
}
refreshAutostart();
reload()
  .then(() => {
    renderCadence();
    renderMemPills();
    // 日报要跟着"当前角色/最近一天"显出来 —— 页面一开就该看得到，
    // 不能等主人先点一次「状态」页（那等于默认不显示）
    refreshToday();
  })
  .catch(fail);
