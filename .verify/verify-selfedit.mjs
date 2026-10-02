/**
 * 对话留档 + 关系里程碑 + 角色自我修订 的端到端验收。
 *
 * 手法：自我修订那一段把 deepseek-client 的 completion 换成假的（不花额度），
 * 真实网络路径由 verify-ds-client.mjs 覆盖。跑完把状态与提案恢复原样 ——
 * 这套验收会真的写提案和里程碑，不能把主人的痕迹留下。
 *
 * 用法：node .verify/verify-selfedit.mjs
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 数据隔离门禁：脚本会真存真删，跑在主人的真实数据上就是拿记忆当沙包（见 _env.mjs）
import { requireIsolation } from './_env.mjs';
await requireIsolation();

const CDP = 'http://127.0.0.1:9222';
const LOG = join(tmpdir(), 'ds-companion.log');
const APPDIR = join(process.env.APPDATA || '', 'ds-companion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
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
    if (out.exceptionDetails) {
      const e = out.exceptionDetails;
      throw new Error(e.exception ? e.exception.description || e.exception.value : e.text);
    }
    return out.result ? out.result.value : undefined;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const targets = async () => await (await fetch(CDP + '/json/list')).json();

async function mainPage() {
  const t = (await targets()).find((x) => x.url && x.url.includes('deepseek.com'));
  if (!t) throw new Error('主页面不在（exe 没跑或没登录）');
  const p = new Page(t.webSocketDebuggerUrl);
  await p.open();
  return p;
}

async function settingsPage() {
  let t = (await targets()).find((x) => x.url && x.url.includes('settings.html'));
  if (!t) {
    const main = await mainPage();
    await main.eval(`window.__TAURI_INTERNALS__.invoke('open_settings')`);
    main.close();
    for (let i = 0; i < 40 && !t; i++) {
      await sleep(250);
      t = (await targets()).find((x) => x.url && x.url.includes('settings.html'));
    }
  }
  if (!t) throw new Error('设置窗口开不出来');
  const p = new Page(t.webSocketDebuggerUrl);
  await p.open();
  await sleep(500);
  return p;
}

const main = async () => {
  const settings = await settingsPage();
  const page = await mainPage();
  const inv = (js) => settings.eval(js);

  // ── 快照 ────────────────────────────────────────────────────────────
  const cfgStart = JSON.parse(await inv(`window.__TAURI__.core.invoke('config_get').then(c => JSON.stringify(c))`));
  const character = cfgStart.activePersona || '';
  if (!character) {
    console.log('没有激活角色，先在人设页激活一个再跑');
    process.exit(2);
  }
  const stateSnap = await inv(
    `window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(character)} }).then(s => JSON.stringify(s))`,
  );
  const userSnap = await inv(`window.__TAURI__.core.invoke('user_state_get').then(s => JSON.stringify(s))`);
  const propSnap = await inv(
    `window.__TAURI__.core.invoke('proposal_list', { characterId: ${JSON.stringify(character)} }).then(p => JSON.stringify(p))`,
  );
  // 留档：记下验收这一天的文件原本存不存在，跑完按情况还原/删掉
  const dayNow = new Date();
  const today = `${dayNow.getFullYear()}-${String(dayNow.getMonth() + 1).padStart(2, '0')}-${String(dayNow.getDate()).padStart(2, '0')}`;
  const chatFile = join(APPDIR, 'chats', `${today}.md`);
  const chatBefore = existsSync(chatFile) ? readFileSync(chatFile, 'utf8') : null;

  const hardRestore = () => {
    try {
      writeFileSync(join(APPDIR, 'config.json'), JSON.stringify(cfgStart, null, 2), 'utf8');
      writeFileSync(join(APPDIR, 'state', `${character}.json`), stateSnap, 'utf8');
      writeFileSync(join(APPDIR, 'state', '_user.json'), userSnap, 'utf8');
      writeFileSync(join(APPDIR, 'proposals', `${character}.json`), propSnap, 'utf8');
      if (chatBefore === null) {
        if (existsSync(chatFile)) rmSync(chatFile);
      } else {
        writeFileSync(chatFile, chatBefore, 'utf8');
      }
      console.log('[crash-net] 状态/提案/留档已按快照写回');
    } catch (e) {
      console.log('[crash-net] 写回失败: ' + e.message);
    }
  };
  process.on('uncaughtException', (e) => {
    console.error('验收脚本自己炸了：', e);
    hardRestore();
    process.exit(2);
  });
  process.on('unhandledRejection', (e) => {
    console.error('验收脚本炸了（promise）：', e);
    hardRestore();
    process.exit(2);
  });

  const restore = async () => {
    try {
      await inv(`window.__TAURI__.core.invoke('state_save', { state: ${stateSnap} }).then(() => true)`);
      await inv(`window.__TAURI__.core.invoke('user_state_save', { state: ${userSnap} }).then(() => true)`);
      await inv(`window.__TAURI__.core.invoke('config_set', { cfg: ${JSON.stringify(cfgStart)} }).then(() => true)`);
      // 提案文件按快照写回（只可能多出我们造的几条）
      writeFileSync(join(APPDIR, 'proposals', `${character}.json`), propSnap, 'utf8');
      if (chatBefore === null) {
        if (existsSync(chatFile)) rmSync(chatFile);
      } else {
        writeFileSync(chatFile, chatBefore, 'utf8');
      }
      console.log('\n已把状态 / 提案 / 留档 / 配置还原');
    } catch (e) {
      console.log('\n⚠ 还原失败：' + e.message);
    }
  };

  const diskCfg = async (patch) => {
    const cur = await inv(`window.__TAURI__.core.invoke('config_get').then(c => JSON.stringify(c))`);
    await inv(
      `window.__TAURI__.core.invoke('config_set', { cfg: Object.assign({}, ${cur}, ${JSON.stringify(patch)}) })`,
    );
    await sleep(300);
  };
  const diskState = async () =>
    JSON.parse(
      await inv(`window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(character)} }).then(s => JSON.stringify(s))`),
    );

  // ── 1) 对话留档：一轮落地就落盘 ─────────────────────────────────────
  // 成本闸：这套验收会反复报轮次，先把 model 两档按掉（否则会真花额度）
  await diskCfg({ senseMode: 'off', proactiveMode: 'off', selfReviewMode: 'manual' });

  const before = await page.eval(`typeof window.__DSC_STATE__.turnsArchived === 'number' ? window.__DSC_STATE__.turnsArchived : 0`);
  const probeSession = 'selfedit-' + Date.now();
  await page.eval(
    `window.__DSC_REMEMBER_TURN__(${JSON.stringify(probeSession)}, '我最近在给 ds-companion 加自我修订', '好呀，那我该反省一下自己了')`,
  );
  // rememberTurn 之后要真走一遍 archiveTurn —— 用内部钩子触发一次完整的"一轮"
  const archived = await page.eval(`(function(){
    // 直接调内部留档（等价于真实一轮落地时走的那条路）
    try {
      var d = new Date();
      var pad = function(n){ return (n<10?'0':'')+n; };
      window.__TAURI_INTERNALS__.invoke('dsc_chat_append', { turn: {
        at: Date.now(),
        day: d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()),
        clock: pad(d.getHours())+':'+pad(d.getMinutes()),
        character: (window.__DSC_CFG__().personaName||''),
        characterId: (window.__DSC_CFG__().personaId||''),
        session: ${JSON.stringify(probeSession)},
        user: '验收：留档测试这句',
        assistant: '验收：留档测试那句'
      }});
      return 'ok';
    } catch(e) { return 'THREW ' + e.message; }
  })()`);
  check('留档调用没报错', archived === 'ok', archived);
  await sleep(700);
  check('留档文件真的写出来了', existsSync(chatFile), chatFile);
  const chatText = existsSync(chatFile) ? readFileSync(chatFile, 'utf8') : '';
  check('留档里有这一轮', chatText.includes('验收：留档测试这句'), '');
  check('留档带说话人和时间', /\*\*主人\*\*：/.test(chatText) && /## \d\d:\d\d · /.test(chatText), '');
  const recent = JSON.parse(
    await page.eval(`window.__TAURI_INTERNALS__.invoke('chat_recent', { limit: 5 }).then(r => JSON.stringify(r))`),
  );
  check('页面能读回留档（刷新后整理的兜底）', Array.isArray(recent) && recent.length > 0, `${recent.length} 轮`);
  check('读回的留档内容对得上', recent.some((t) => (t.user || '').includes('留档测试这句')), '');

  // ── 2) 关系里程碑：自动认 + 手写 + 进注入 ─────────────────────────────
  const st0 = await diskState();
  const turn = async (text, hour) =>
    JSON.parse(
      await page.eval(
        `window.__TAURI_INTERNALS__.invoke('dsc_turn_report', { userText: ${JSON.stringify(text)}, hour: ${hour} }).then(r => JSON.stringify({ ms: r.newMilestones, all: r.state.milestones, text: r.stateText, days: r.state.firstSeenAt }))`,
      ),
    );
  // 里程碑要从干净状态测起：这套验收上一轮可能已经解锁过"第一次说话"
  // （崩过一次没还原），不清的话断言会假红
  const clean = await diskState();
  clean.milestones = [];
  clean.firstSeenAt = 0;
  clean.turns = 0;
  clean.affinity = 30;
  await inv(`window.__TAURI__.core.invoke('state_save', { state: ${JSON.stringify(clean)} }).then(() => true)`);
  await sleep(400);

  const first = await turn('你好呀，第一次说话', 15);
  check('第一次说话会被记成里程碑', (first.ms || []).some((t) => t.includes('第一次说话')), JSON.stringify(first.ms));
  check('记下了"第一次见面"的时间', (first.days || 0) > 0, String(first.days));
  check('【状态】块里有"你俩"这一行', /你俩：第 \d+ 天/.test(first.text || ''), (first.text || '').split('\n').find((l) => l.startsWith('你俩')) || '');

  const intimate = await turn('主人，抱抱', 15);
  check('第一次叫「主人」也会记一笔', (intimate.ms || []).some((t) => t.includes('主人')), JSON.stringify(intimate.ms));

  // 好感拉高 → 里程碑解锁（直接改状态再报一轮）
  const raise = JSON.parse(await inv(`window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(character)} }).then(s => JSON.stringify(s))`));
  raise.affinity = 75;
  raise.turns = 100;
  await inv(`window.__TAURI__.core.invoke('state_save', { state: ${JSON.stringify(raise)} }).then(() => true)`);
  await sleep(400);
  const unlocked = await turn('继续聊', 15);
  const titles = unlocked.ms || [];
  check('好感跨阈值 → 解锁里程碑', titles.some((t) => t.includes('好感度到 70')), JSON.stringify(titles));
  check('轮数跨阈值 → 解锁里程碑', titles.some((t) => t.includes('聊满 100 轮')), JSON.stringify(titles));
  check('里程碑不会重复解锁（看的是这一轮新解锁的）', titles.filter((t) => t.includes('第一次说话')).length === 0, JSON.stringify(titles));
  check('全部里程碑累计在状态里', ((unlocked.all || []).length) >= titles.length, String((unlocked.all || []).length));

  // ── 3) 自我修订：提案 → 审阅 → 采纳（原始人设不动） ─────────────────
  const personaBefore = JSON.parse(await inv(`window.__TAURI__.core.invoke('persona_get', { id: ${JSON.stringify(character)} }).then(p => JSON.stringify(p ? { body: p.body } : null))`));
  const FAKE = JSON.stringify({
    personaAddendum: '验收ZZMARK：说话别太端着',
    anchors: ['主人不喜欢被叫「先生」'],
    arc: '主人在给 ds-companion 加自我修订',
    reason: '发现自己回得太正式',
  });
  await page.eval(`(function(){
    window.__DSC_REVIEW_REAL__ = window.__DSC_DS_UTIL__;
    window.__DSC_REVIEW_CALLS__ = 0;
    window.__DSC_DS_UTIL__ = Object.assign({}, window.__DSC_DS_UTIL__, {
      ensureSession: function(){ return Promise.resolve('selfedit-probe'); },
      completion: function(){ window.__DSC_REVIEW_CALLS__++; return Promise.resolve({ text: ${JSON.stringify(FAKE)}, raw: '', latencyMs: 8 }); }
    });
    return true;
  })()`);
  const proposalsBefore = JSON.parse(await inv(`window.__TAURI__.core.invoke('proposal_list', { characterId: ${JSON.stringify(character)} }).then(p => JSON.stringify(p.length))`));
  const reviewRes = JSON.parse(await page.eval(`window.__DSC_SELF_REVIEW__().then(r => JSON.stringify(r))`));
  const calls = await page.eval(`window.__DSC_REVIEW_CALLS__`);
  check('自我修订跑通了', reviewRes.ok === true, reviewRes.error || '');
  check('确实发了 1 次反思请求', calls === 1, String(calls));
  check('提案落盘了', (await inv(`window.__TAURI__.core.invoke('proposal_list', { characterId: ${JSON.stringify(character)} }).then(p => p.length)`)) === proposalsBefore + 1, '');
  const saved = JSON.parse(
    await inv(`window.__TAURI__.core.invoke('proposal_list', { characterId: ${JSON.stringify(character)} }).then(p => JSON.stringify(p.filter(x => x.status === 'pending').slice(-1)[0] || null))`),
  );
  check('提案内容完整', !!saved && saved.personaAddendum.includes('ZZMARK') && saved.anchors.length === 1 && !!saved.reason, JSON.stringify(saved && saved.personaAddendum));
  check('提案状态是待审（没有自动生效）', !!saved && saved.status === 'pending', saved && saved.status);
  check('她反思时没碰原始人设', !JSON.parse(await inv(`window.__TAURI__.core.invoke('persona_get', { id: ${JSON.stringify(character)} }).then(p => JSON.stringify(p ? { body: p.body } : null))`)).body.includes('ZZMARK'), '');

  // 去重：同样内容在她还挂着 pending 的时候不该再攒一条
  const dupRes = JSON.parse(await page.eval(`window.__DSC_SELF_REVIEW__().then(r => JSON.stringify(r))`));
  check('同样的提案不会重复攒', dupRes.ok === false && String(dupRes.error).includes('重复'), String(dupRes.error || ''));

  // 采纳
  const day = today;
  await inv(
    `window.__TAURI__.core.invoke('proposal_accept', { characterId: ${JSON.stringify(character)}, id: ${JSON.stringify(saved.id)}, day: ${JSON.stringify(day)} }).then(() => true)`,
  );
  await sleep(600);
  const stAfter = await diskState();
  check('采纳后写进了"自订设定"', (stAfter.addendum || '').includes('ZZMARK'), stAfter.addendum);
  check('自订设定带日期标记（主人能看清哪句哪次加的）', (stAfter.addendum || '').includes(`[${day}]`), stAfter.addendum);
  check('采纳后新锚点合并了', (stAfter.anchors || []).some((a) => a.includes('先生')), JSON.stringify(stAfter.anchors));
  check('采纳后处境更新了', (stAfter.arc || '').includes('自我修订'), stAfter.arc);
  const propAfter = JSON.parse(
    await inv(`window.__TAURI__.core.invoke('proposal_list', { characterId: ${JSON.stringify(character)} }).then(p => JSON.stringify(p.find(x => x.id === ${JSON.stringify(saved.id)})))`),
  );
  check('提案状态变成已采纳', propAfter.status === 'accepted', propAfter.status);
  const personaAfter = JSON.parse(await inv(`window.__TAURI__.core.invoke('persona_get', { id: ${JSON.stringify(character)} }).then(p => JSON.stringify(p ? { body: p.body } : null))`));
  check('【铁律】原始人设一个字都没改', personaAfter.body === personaBefore.body, '');

  // 自订设定与里程碑要进注入
  const injected = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_CFG__().anchorText || '')`));
  await page.eval(
    `window.__DSC_SET_CONFIG__(Object.assign({}, window.__DSC_CFG__(), { anchorEveryTurns: 1, cadence: 'first', stateEnabled: true }))`,
  );
  // 回锚按"这个会话第几轮"补，第一条(index 0)一定不回锚 —— 所以要连发两条
  const probeSid = 'selfedit-anchor-' + Date.now();
  await page.eval(
    `window.__DSC_AUGMENT__(JSON.stringify({chat_session_id:${JSON.stringify(probeSid)},parent_message_id:null,prompt:'第一条'}), 'probe')`,
  );
  const probe = await page.eval(
    `window.__DSC_AUGMENT__(JSON.stringify({chat_session_id:${JSON.stringify(probeSid)},parent_message_id:null,prompt:'第二条'}), 'probe')`,
  );
  check('【回锚】里带上她自己的补充', !!probe && probe.includes('她自己补充的设定') && probe.includes('ZZMARK'), (probe || '').match(/她自己补充的设定[^\n]{0,20}/) || '');
  check('【回锚】里带上里程碑', !!probe && /你俩的里程碑：/.test(probe), (probe || '').match(/你俩的里程碑：[^\n]{0,40}/) || '');

  // 驳回路径
  const second = JSON.parse(await page.eval(`(function(){
    window.__DSC_DS_UTIL__.completion = function(){ return Promise.resolve({ text: ${JSON.stringify(
      JSON.stringify({ personaAddendum: '换个说法试试', anchors: [], arc: '', reason: '试试' }),
    )}, raw: '', latencyMs: 5 }); };
    return window.__DSC_SELF_REVIEW__().then(r => JSON.stringify(r));
  })()`));
  check('换一条内容就能再提', second.ok === true, second.error || '');
  const p2 = JSON.parse(
    await inv(`window.__TAURI__.core.invoke('proposal_list', { characterId: ${JSON.stringify(character)} }).then(p => JSON.stringify(p.filter(x => x.status === 'pending').slice(-1)[0]))`),
  );
  await inv(`window.__TAURI__.core.invoke('proposal_reject', { characterId: ${JSON.stringify(character)}, id: ${JSON.stringify(p2.id)} }).then(() => true)`);
  await sleep(300);
  const stRej = await diskState();
  check('驳回不会写进状态', !(stRej.addendum || '').includes('换个说法'), stRej.addendum);
  const rejProp = JSON.parse(
    await inv(`window.__TAURI__.core.invoke('proposal_list', { characterId: ${JSON.stringify(character)} }).then(p => JSON.stringify(p.find(x => x.id === ${JSON.stringify(p2.id)})))`),
  );
  check('驳回也留档（能回看她想改什么）', rejProp.status === 'rejected', rejProp.status);

  await page.eval(`(function(){ if (window.__DSC_REVIEW_REAL__) window.__DSC_DS_UTIL__ = window.__DSC_REVIEW_REAL__; window.__DSC_REVIEW_REAL__ = null; return true; })()`);

  // ── 4) 额度闸 ───────────────────────────────────────────────────────
  const fakeDay = '2077-01-02';
  const r1 = JSON.parse(await page.eval(`window.__TAURI_INTERNALS__.invoke('dsc_review_reserve', { day: ${JSON.stringify(fakeDay)}, cap: 1 }).then(r => JSON.stringify(r))`));
  const r2 = JSON.parse(await page.eval(`window.__TAURI_INTERNALS__.invoke('dsc_review_reserve', { day: ${JSON.stringify(fakeDay)}, cap: 1 }).then(r => JSON.stringify(r))`));
  check('反思的当日额度：第一次放行', r1 === true, String(r1));
  check('反思的当日额度：第二次拦住', r2 === false, String(r2));
  check('反思额度与情绪感知分开记账', (await diskState()).reviewDay === fakeDay, '');

  // ── 5) 界面：提案箱能点、里程碑能加 ─────────────────────────────────
  // 先留一条**待审**的提案：前面的都采纳/驳回了，界面上的「采纳」按钮得有个对象
  // （不装假 completion 会真花额度，这里必须再装一次）
  await page.eval(`(function(){
    window.__DSC_UI_PROBE_REAL__ = window.__DSC_DS_UTIL__;
    window.__DSC_DS_UTIL__ = Object.assign({}, window.__DSC_DS_UTIL__, {
      ensureSession: function(){ return Promise.resolve('selfedit-ui'); },
      completion: function(){ return Promise.resolve({ text: '{"personaAddendum":"验收界面待审提案","anchors":[],"arc":"","reason":"为了验证按钮"}', raw: '', latencyMs: 5 }); }
    });
    return true;
  })()`);
  const uiProbe = JSON.parse(await page.eval(`window.__DSC_SELF_REVIEW__().then(r => JSON.stringify(r))`));
  check('留了一条待审提案给界面用', uiProbe.ok === true, uiProbe.error || '');
  await page.eval(`(function(){ if (window.__DSC_UI_PROBE_REAL__) window.__DSC_DS_UTIL__ = window.__DSC_UI_PROBE_REAL__; window.__DSC_UI_PROBE_REAL__ = null; return true; })()`);
  await settings.eval(`document.querySelector('.tb-tab[data-tab="state"]').click()`);
  await sleep(1200);
  // 明确选中验收用的这个角色 —— 前面的套件会改激活人设，
  // 靠"自动选中激活角色"会选中别人（那正是这个断言假红的原因）
  await settings.eval(`(function(){
    var cards = Array.from(document.querySelectorAll('#st-list .card'));
    var c = cards.find(function(x){ return x.dataset.id === ${JSON.stringify(character)}; });
    if (c) c.click();
    return true;
  })()`);
  await sleep(700);
  const ui = JSON.parse(
    await settings.eval(`(function(){
      return JSON.stringify({
        props: document.querySelectorAll('#prop-list .prop').length,
        hasAccept: !!document.querySelector('#prop-list .prop.pending .btn.primary'),
        reviewSeg: document.querySelectorAll('#st-review button').length,
        reviewPill: Math.round(parseFloat((document.getElementById('st-review-pill').style.width)||0)),
        ms: document.querySelectorAll('#ms-list .ms-item').length,
        msText: (document.getElementById('ms-list').textContent||'').slice(0, 60),
        addendum: document.getElementById('sf-addendum').value,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        scrollable: (function(){
          var f = document.querySelector('#tab-state .fields');
          if (!f) return null;
          var before = f.scrollTop; f.scrollTop = 99999;
          var moved = f.scrollTop > before; f.scrollTop = before;
          return { overflow: f.scrollHeight > f.clientHeight + 1, moved: moved };
        })()
      });
    })()`),
  );
  check('提案箱列出了提案', ui.props >= 1, `${ui.props} 条`);
  check('待审提案有「采纳」按钮', ui.hasAccept === true, '');
  check('反思时机是三档分段控件', ui.reviewSeg === 3 && ui.reviewPill > 20, `seg=${ui.reviewSeg} pill=${ui.reviewPill}`);
  check('里程碑列出来了', ui.ms >= 1, `${ui.ms} 条：${ui.msText}`);
  check('自订设定显示在界面上', ui.addendum.includes('ZZMARK'), ui.addendum.slice(0, 40));
  check('状态页仍然没横向溢出', ui.overflowX <= 0, String(ui.overflowX));
  check(
    '状态页：溢出时能滚',
    !!ui.scrollable && (!ui.scrollable.overflow || ui.scrollable.moved),
    JSON.stringify(ui.scrollable),
  );

  // 5.5) 真点「让她反思一下」—— 补的：以前没人点过这个按钮，guard 用错字段
  // （cfg.personaId 在设置窗口的配置里恒 undefined）导致它永远只弹"先激活一个角色"、从没真跑过
  await page.eval(`(function(){
    window.__DSC_CLICK_REAL__ = window.__DSC_DS_UTIL__;
    window.__DSC_DS_UTIL__ = Object.assign({}, window.__DSC_DS_UTIL__, {
      ensureSession: function(){ return Promise.resolve('selfedit-click'); },
      historyTail: function(){ return Promise.resolve({ count: 0, ids: [], lastId: 0, lastAssistantId: 0, currentMessageId: 0 }); },
      // 故意慢 1.2 秒：假回复若是立刻返回，"她在反省 / 按钮禁用"这个中间态根本来不及看，
      // 断言就会跟它赛跑（第一版 5ms，实测确实被赛过去了）
      completion: function(){ return new Promise(function(res){ setTimeout(function(){ res({
        text: '{"personaAddendum":"验收真点按钮","anchors":[],"arc":"","reason":"验证按钮真的能跑"}',
        raw: '', latencyMs: 1200, responseMessageId: 9
      }); }, 1200); }); }
    });
    return true;
  })()`);
  const propPending = async () =>
    JSON.parse(
      await inv(`window.__TAURI__.core.invoke('proposal_list', { characterId: ${JSON.stringify(character)} }).then(p => JSON.stringify(p.filter(x => x.status === 'pending').length))`),
    );
  const propBefore = await propPending();
  await settings.eval(`(function(){
    document.getElementById('toast').textContent = '';
    document.getElementById('st-review-now').click();
    return true;
  })()`);
  await sleep(400);
  const mid = JSON.parse(
    await settings.eval(`JSON.stringify({
      note: document.getElementById('st-review-note').textContent,
      disabled: document.getElementById('st-review-now').disabled,
      toast: document.getElementById('toast').textContent
    })`),
  );
  check(
    '点按钮不再弹「先激活一个角色」（那是用错字段的老 bug）',
    !/先激活一个角色/.test(mid.toast),
    `toast="${mid.toast}"`,
  );
  check('按钮真的跑起来了（转入"她在反省"且禁用）', /反省/.test(mid.note) && mid.disabled === true, JSON.stringify(mid));
  let propAfterClick = propBefore;
  for (let i = 0; i < 30 && propAfterClick === propBefore; i++) {
    await sleep(250);
    propAfterClick = await propPending();
  }
  check('她真的提出来了一条（按钮链路端到端通）', propAfterClick > propBefore, `${propBefore} → ${propAfterClick}`);
  const afterClick = JSON.parse(
    await settings.eval(`JSON.stringify({
      disabled: document.getElementById('st-review-now').disabled,
      note: document.getElementById('st-review-note').textContent
    })`),
  );
  check(
    '提案回来后按钮恢复可用并提示看下面',
    afterClick.disabled === false && /看下面/.test(afterClick.note),
    JSON.stringify(afterClick),
  );
  await page.eval(`(function(){ if (window.__DSC_CLICK_REAL__) window.__DSC_DS_UTIL__ = window.__DSC_CLICK_REAL__; window.__DSC_CLICK_REAL__ = null; return true; })()`);

  // 手写一条里程碑
  await settings.eval(`(function(){
    document.getElementById('ms-new').value = '验收手写里程碑';
    document.getElementById('ms-add').click();
    return true;
  })()`);
  await sleep(700);
  const stMs = await diskState();
  check('手写的里程碑落盘了', (stMs.milestones || []).some((m) => m.title === '验收手写里程碑' && m.auto === false), JSON.stringify((stMs.milestones || []).map((m) => m.title)));

  // 取消一条（走界面上的 × ）
  const removed = JSON.parse(
    await settings.eval(`(function(){
      var items = Array.from(document.querySelectorAll('#ms-list .ms-item'));
      var target = items.find(function(el){ return el.textContent.indexOf('验收手写里程碑') >= 0; });
      if (!target) return JSON.stringify({ found: false });
      target.querySelector('button').click();
      return JSON.stringify({ found: true });
    })()`),
  );
  await sleep(700);
  const stMs2 = await diskState();
  check('里程碑能在界面上删掉', removed.found === true && !(stMs2.milestones || []).some((m) => m.title === '验收手写里程碑'), JSON.stringify((stMs2.milestones || []).map((m) => m.title)));

  await restore();
  await settings.eval(`document.querySelector('.tb-tab[data-tab="persona"]').click()`);
  await sleep(400);

  page.close();
  settings.close();
  console.log(`\n${failed ? `✗ ${failed} 项失败` : '✓ 留档 / 里程碑 / 自我修订 全通'}`);
  process.exit(failed ? 1 : 0);
};

main().catch((e) => {
  console.error('验收脚本自己炸了：', e);
  process.exit(2);
});
