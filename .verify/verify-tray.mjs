/* 托盘验收：菜单上那两行摘要、勾选状态、tooltip 是不是跟着她的真实状态在走
 *
 * 【为什么需要 `tray_snapshot`】托盘是**看不见的界面** —— 菜单文本、勾选项、tooltip
 * 都没法用 CDP 断言（那是 Windows 的原生菜单，不在页面里）。所以壳里加了一条只读命令
 * 把"托盘现在长什么样"读出来，脚本打的就是它。
 *
 * 【这一组真正盯的是"她饿的时候托盘会不会写饿"】托盘最容易的死法不是崩，而是
 * **显示一次就再也不更新** —— 主人右键看到的永远是启动那一刻的状态。所以关键断言是
 * "喂一顿之后，摘要里的饿立刻降下来"：它同时证明刷新链路是通的。
 *
 * 前置：壳以隔离数据 + CDP 启动（.\verify-run.ps1 -Keep），设置窗口开着
 *   node .verify\probe-open-settings.mjs
 *   node .verify\seed-persona.mjs
 *   node .verify\verify-tray.mjs
 *
 * 用法：node .verify\verify-tray.mjs [port]
 */

import { requireIsolation } from './_env.mjs';

const PORT = Number(process.argv[2] || process.env.DSC_CDP_PORT || 9222);
const CDP = `http://127.0.0.1:${PORT}`;

const iso = await requireIsolation();
void iso;

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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const out = r.result || {};
    if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails));
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

let st = null;
{
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const t = list.find((x) => x.url && x.url.includes('settings.html'));
  if (!t) {
    console.error('设置窗口没开 —— 先跑 .verify\\probe-open-settings.mjs');
    process.exit(1);
  }
  st = new Page(t.webSocketDebuggerUrl);
  await st.open();
}

const invoke = async (cmd, args) =>
  JSON.parse(
    await st.eval(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})})
         .then(v => JSON.stringify({ok:true, v})).catch(e => JSON.stringify({ok:false, e:String(e)}))`,
    ),
  );
const call = async (cmd, args) => {
  const r = await invoke(cmd, args);
  if (!r.ok) throw new Error(`${cmd} 失败：${r.e}`);
  return r.v;
};

const cfg0 = await call('config_get');
const snap = () => call('tray_snapshot');

try {
  // 先保证有生效的角色 —— 脚本不该依赖"上一个脚本把配置留成了什么样"。
  // 踩过：另一个脚本把配置留在「原版」态，这里从第一行开始整片假红，看着像托盘坏了。
  if (!cfg0.activePersona || cfg0.activePersona === 'off') {
    const list = await call('persona_list');
    const pick = list.find((p) => p.source !== 'builtin') || list[0];
    if (pick) await call('config_set', { cfg: { ...cfg0, activePersona: pick.id } });
  }

  // ── ① 有人设：摘要要写她的名字、心情、好感 ──────────────────────────
  const s1 = await snap();
  check('当前有激活角色', !!s1.active, s1.active);
  check('摘要第一行有"好感 n/100"', /好感 \d+\/100/.test(s1.line1), s1.line1);
  check('摘要第二行有饿 / 精力 / 工具', /饿 \d+% · 精力 \d+% · 工具 \d+\/\d+/.test(s1.line2), s1.line2);
  check('tooltip 是两行拼的', s1.tooltip.includes(s1.line1) && s1.tooltip.includes(s1.line2), s1.tooltip);
  check('勾选：没暂停时 paused=false 且 cadence 不是 off', s1.paused === false && s1.cadence !== 'off', `${s1.paused}/${s1.cadence}`);
  check('角色列表非空（子菜单有东西可点）', Array.isArray(s1.personas) && s1.personas.length >= 1, JSON.stringify(s1.personas));

  // 摘要里要用人设的**显示名**，不是 id（"dsh-luna" 摆在托盘上没人看得懂）
  const p = await call('persona_get', { id: s1.active });
  check('摘要里用的是人设显示名而不是 id', !!p && s1.line1.includes(p.name), `name=${p && p.name} line1=${s1.line1}`);

  // ── ② 数字要和真实状态一致（不能是"启动那一刻的快照"）──────────────
  const before = await call('state_get', { characterId: s1.active });
  const wantHunger = Math.round(before.body.hunger * 100);
  const wantEnergy = Math.round(before.energy * 100);
  check('摘要里的饿 = 状态里的饿', s1.line2.includes(`饿 ${wantHunger}%`), `${s1.line2} vs 真实 ${wantHunger}%`);
  check('摘要里的精力 = 状态里的精力', s1.line2.includes(`精力 ${wantEnergy}%`), `${s1.line2} vs 真实 ${wantEnergy}%`);
  check('摘要里的好感 = 状态里的好感', s1.line1.includes(`好感 ${before.affinity}/100`), `${s1.line1} vs 真实 ${before.affinity}`);

  // ── ③ 喂一顿：摘要必须**立刻**跟着变（刷新的端到端证据）────────────
  // 先把饿顶上去，否则本来就 0% 的话"降下来"看不出来
  const stuffed = JSON.parse(JSON.stringify(before));
  stuffed.body.hunger = 0.95;
  await call('state_save', { state: stuffed });
  const sFull = await snap();
  check('饿到 95% 时摘要写 95%', sFull.line2.includes('饿 95%'), sFull.line2);

  const fed = await call('state_feed', { characterId: s1.active });
  const sFed = await snap();
  check('喂一顿之后摘要里的饿降下来了', sFed.line2.includes(`饿 ${Math.round(fed.body.hunger * 100)}%`), sFed.line2);
  check('喂完之后确实比喂之前小', fed.body.hunger < 0.95, String(fed.body.hunger));

  // ── ④ 暂停勾选：跟着配置走 ────────────────────────────────────────
  await call('config_set', { cfg: { ...cfg0, cadence: 'off', cadenceBeforePause: 'every' } });
  const sPaused = await snap();
  check('暂停后 paused=true（托盘勾上）', sPaused.paused === true && sPaused.cadence === 'off', `${sPaused.paused}/${sPaused.cadence}`);

  await call('config_set', { cfg: { ...cfg0, cadence: 'every' } });
  const sBack = await snap();
  check('恢复后 paused=false 且节奏回到 every', sBack.paused === false && sBack.cadence === 'every', `${sBack.paused}/${sBack.cadence}`);

  // ── ⑤ 三态：没选 = 出厂默认角色；选「原版」= 真的什么都不注 ─────────
  // 这两件事以前是一回事（没选角色 = 原版），现在分开了 —— 语义搞错的话，
  // 主人要么会看到一个陌生人在跟他说话，要么发现"默认角色不见了"。
  await call('config_set', { cfg: { ...cfg0, activePersona: null } });
  const sDefault = await snap();
  check('没选角色时生效的是出厂默认角色', sDefault.line1.includes('DeepSeek'), sDefault.line1);
  check('默认角色也有第二行（她有自己的一份状态）', sDefault.line2.length > 0, sDefault.line2);
  check('snapshot 的 active 是默认角色的 id', sDefault.active === 'dsh-deepseek', sDefault.active);

  await call('config_set', { cfg: { ...cfg0, activePersona: 'off' } });
  const sOff = await snap();
  check('选「原版」时第一行说清楚是原版', sOff.line1.includes('原版'), sOff.line1);
  check(
    '原版没有角色状态（第二行为空、tooltip 只有一行）',
    sOff.line2 === '' && !sOff.tooltip.includes('\n'),
    `line2=${sOff.line2} tooltip=${sOff.tooltip}`,
  );
  check('原版时 active 是空串（没有角色身份）', sOff.active === '', `active=${JSON.stringify(sOff.active)}`);
  check('默认角色在角色列表里（子菜单能选到她）', (sDefault.personas || []).includes('DeepSeek 娘'), JSON.stringify(sDefault.personas));

  // ── ⑥ 换角色：摘要第一行要换成新角色 ──────────────────────────────
  // 人设库里只有一个角色时**先造一个临时的** —— 换角色是托盘的核心功能之一，
  // 不该因为隔离实例干净就永远跳过（那等于这段从没被验过）。
  let tmpPersona = '';
  if ((s1.personas || []).length < 2) {
    tmpPersona = 'dsc-verify-tray-tmp';
    await call('persona_save', {
      persona: {
        id: tmpPersona,
        name: '验收入口',
        description: '',
        source: 'manual',
        body: 'tray verify',
      },
    });
  }
  const other = (await call('persona_list')).find((x) => x.id !== s1.active);
  if (other) {
    await call('config_set', { cfg: { ...cfg0, activePersona: other.id } });
    const sOther = await snap();
    check('换角色后摘要用新角色名', sOther.line1.includes(other.name), `预期 ${other.name}：${sOther.line1}`);
    check('换角色后 active 跟着变', sOther.active === other.id, `${sOther.active} vs ${other.id}`);
  } else {
    check('换角色：找到另一个角色', false, '人设库里只有一个');
  }
  if (tmpPersona) {
    try {
      await call('persona_delete', { id: tmpPersona });
    } catch {}
  }
} finally {
  // 配置原样还原（这个脚本改过 cadence 与 activePersona）
  try {
    await call('config_set', { cfg: cfg0 });
  } catch {}
  try {
    st.close();
  } catch {}
}

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
