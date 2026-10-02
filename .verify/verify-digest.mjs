/* 「她今天怎么样」验收：数字要和真实状态对得上，页面上的卡片要真的**看得见**
 *
 * 【这一组的两个重点】
 *   ① 日报里的数字**不能是编的**：好感/饿/精力都要和 state_get 一模一样 ——
 *      这种"看着像那么回事"的摘要最容易和真实数据悄悄脱节。
 *   ② 卡片要真的渲染出来（`#today-card` 存在、在可见的页签里、卡片/行数够）——
 *      这个项目吃过一次亏：「面板没打开时元素根本不在 DOM 里」，用数量当基线会拿到假的 0。
 *
 * 前置：壳以隔离数据 + CDP 启动（.\verify-run.ps1 -Keep），设置窗口开着
 *   node .verify\probe-open-settings.mjs
 *   node .verify\seed-persona.mjs
 *   node .verify\verify-digest.mjs
 *
 * 用法：node .verify\verify-digest.mjs [port]
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

const list = await (await fetch(`${CDP}/json/list`)).json();
const t = list.find((x) => x.url && x.url.includes('settings.html'));
if (!t) {
  console.error('设置窗口没开 —— 先跑 .verify\\probe-open-settings.mjs');
  process.exit(1);
}
const st = new Page(t.webSocketDebuggerUrl);
await st.open();

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

try {
  const cfg = await call('config_get');
  const cid = cfg.activePersona || '';
  check('有激活角色（日报才有对象）', !!cid, String(cid));

  // 全新隔离实例里**一次对话都没有**，而日报要讲的正是"今天" ——
  // 所以先造一条今天的留档（走的是页面真正用的那条命令）。
  // 不这么做的话，测的只是"什么都没有时它显示空白"，核心那半段（今天聊了几轮）根本没跑过。
  const pad = (n) => String(n).padStart(2, '0');
  const nowD = new Date();
  const today = `${nowD.getFullYear()}-${pad(nowD.getMonth() + 1)}-${pad(nowD.getDate())}`;
  await call('dsc_chat_append', {
    turn: {
      at: Date.now(),
      day: today,
      clock: `${pad(nowD.getHours())}:${pad(nowD.getMinutes())}`,
      character: '露娜',
      characterId: cid,
      session: 'verify-digest',
      user: '在吗',
      assistant: '在的，主人。',
    },
  });

  // ── ① 数据面：日报的数字必须和真实状态一致 ────────────────────────
  const d = await call('daily_digest', { characterId: cid, day: '' });
  check('日报带日期', /^\d{4}-\d{2}-\d{2}$/.test(d.day || ''), String(d.day));
  check('自动挑的是今天（有留档的那天）', d.day === today, `${d.day} vs ${today}`);
  const turnsStat = (d.stats || []).find((s) => s.key === 'turns');
  check('今天聊的轮数从留档里数出来', turnsStat && turnsStat.value === '1 轮', JSON.stringify(turnsStat));
  check('头条里有角色名', !!d.name && d.headline.includes(d.name), d.headline);
  check('要点不止一行', Array.isArray(d.lines) && d.lines.length >= 3, JSON.stringify(d.lines).slice(0, 160));

  const real = await call('state_get', { characterId: cid });
  check(
    '好感与真实状态一致',
    String(d.headline).includes(`好感 ${real.affinity}/100`),
    `${d.headline} vs ${real.affinity}`,
  );
  const hungerStat = (d.stats || []).find((s) => s.key === 'hunger');
  const energyStat = (d.stats || []).find((s) => s.key === 'energy');
  check(
    '饿的数字与真实状态一致',
    hungerStat && hungerStat.value === `${Math.round(real.body.hunger * 100)}%`,
    `${hungerStat && hungerStat.value} vs ${Math.round(real.body.hunger * 100)}%`,
  );
  check(
    '精力的数字与真实状态一致',
    energyStat && energyStat.value === `${Math.round(real.energy * 100)}%`,
    `${energyStat && energyStat.value} vs ${Math.round(real.energy * 100)}%`,
  );
  check('有 7 张数字卡', (d.stats || []).length === 7, JSON.stringify((d.stats || []).map((s) => s.key)));
  for (const k of ['turns', 'mood', 'hunger', 'energy', 'tools', 'memory', 'days']) {
    check(`卡片里有 ${k}`, (d.stats || []).some((s) => s.key === k));
  }
  check('每张卡都有标签与值', (d.stats || []).every((s) => s.label && s.value), JSON.stringify(d.stats).slice(0, 200));

  // 饿着的时候要主动提醒（这正是主人当天想做的事）
  const stuffed = JSON.parse(JSON.stringify(real));
  stuffed.body.hunger = 0.93;
  await call('state_save', { state: stuffed });
  const hungry = await call('daily_digest', { characterId: cid, day: '' });
  check('饿到 93% 时日报会说"可以喂她一顿"', hungry.lines.join('\n').includes('可以喂她一顿'), hungry.lines.join(' / '));
  const hs = (hungry.stats || []).find((s) => s.key === 'hunger');
  check('饿的卡片标了"该喂了"', hs && hs.hint === '该喂了', JSON.stringify(hs));
  await call('state_save', { state: real });

  // ── ② 指定某天：day 参数要原样回显 ────────────────────────────────
  const fixed = await call('daily_digest', { characterId: cid, day: '2026-10-01' });
  check('传了 day 就用传进来的那天', fixed.day === '2026-10-01', fixed.day);
  check('那天的头条照给出', String(fixed.headline).length > 0, fixed.headline);

  // ── ③ 没选角色时也要说人话（不能报错、不能空白）────────────────────
  const none = await call('daily_digest', { characterId: 'dsc-verify-not-exist', day: '2026-10-01' });
  check('角色不存在时也不崩、标题非空', !!none.headline && none.lines.length >= 3, none.headline);

  // ── ④ 页面侧：卡片要真的看得见 ────────────────────────────────────
  await st.eval("document.querySelector('.tb-tab[data-tab=\"state\"]').click()");
  await sleep(1200);
  const dom = JSON.parse(
    await st.eval(`(function(){
      var card = document.getElementById('today-card');
      if (!card) return 'null';
      var body = card.closest('.body');
      return JSON.stringify({
        visible: body ? !body.classList.contains('hidden') : false,
        sub: (document.getElementById('today-sub')||{}).textContent || '',
        headline: (document.getElementById('today-headline')||{}).textContent || '',
        stats: card.querySelectorAll('#today-stats .ts').length,
        lines: card.querySelectorAll('#today-lines li').length,
        firstLine: ((card.querySelector('#today-lines li')||{}).textContent || '')
      });
    })()`),
  );
  check('状态页里有「今天」卡片', !!dom, 'null = 元素不在 DOM 里');
  check('卡片在可见的页签里（不是藏在别的 tab）', dom && dom.visible, JSON.stringify(dom));
  check('卡片渲染出数字卡（≥7 张）', dom && dom.stats >= 7, dom && String(dom.stats));
  check('卡片渲染出人话要点（≥3 条）', dom && dom.lines >= 3, dom && String(dom.lines));
  check('副标题写了日期', dom && /^\d{4}-\d{2}-\d{2}/.test(dom.sub), dom && dom.sub);
  check('头条不是占位符', dom && dom.headline !== '—' && dom.headline.length > 4, dom && dom.headline);
  check('第一条要点是"今天聊了多少"那类话', dom && /聊|没聊过/.test(dom.firstLine), dom && dom.firstLine);

  // 刷新按钮真的能工作（点一下不报错、内容还在）
  await st.eval("document.getElementById('today-refresh').click()");
  await sleep(700);
  const after = await st.eval("(document.getElementById('today-headline')||{}).textContent || ''");
  check('点「刷新」之后头条还在（没被清空）', String(after).length > 4, String(after));
} finally {
  try {
    st.close();
  } catch {}
}

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
