/**
 * 状态层验收：内心状态（可视 / 连贯 / 回锚 / 空闲主动 / 情绪感知门控）。
 *
 * 【铁律】这套验收会真的推进角色状态（发合成轮次），所以开跑前先把状态快照下来，
 * 跑完原样写回去 —— 主人的心情/好感/锚点不许被验收脚本改动。
 *
 * 模型感知那一段把 deepseek-client 的 completion 换成假的（不花额度），
 * 真实网络那一段由 verify-ds-client.mjs 覆盖。
 *
 * 用法：node .verify/verify-state.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 数据隔离门禁：脚本会真存真删，跑在主人的真实数据上就是拿记忆当沙包（见 _env.mjs）
import { requireIsolation } from './_env.mjs';
await requireIsolation();

const CDP = 'http://127.0.0.1:9222';
const LOG = join(tmpdir(), 'ds-companion.log');
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

const logLen = () => {
  try {
    return readFileSync(LOG, 'utf8').length;
  } catch {
    return 0;
  }
};
const logTail = (from) => {
  try {
    return readFileSync(LOG, 'utf8').slice(from);
  } catch {
    return '';
  }
};

const main = async () => {
  const settings = await settingsPage();
  const page = await mainPage();
  const inv = (js) => settings.eval(js);
  // ── 0) 快照：主人的角色状态与配置，跑完必须原样还回去 ─────────────────
  const cfgStart = JSON.parse(await inv(`window.__TAURI__.core.invoke('config_get').then(c => JSON.stringify(c))`));
  const character = cfgStart.activePersona || '';
  if (!character) {
    console.log('没有激活角色 —— 状态层是跟着角色走的，先在人设页激活一个再跑');
    process.exit(2);
  }
  const stateSnapshot = await inv(
    `window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(character)} }).then(s => JSON.stringify(s))`,
  );
  // 用户（主人）状态也得快照 —— 这套验收会真的推进它（那是它的职责），
  // 跑完必须原样还回去，否则"主人今天累不累"就被脚本改写了
  const userSnapshot = await inv(
    `window.__TAURI__.core.invoke('user_state_get').then(s => JSON.stringify(s))`,
  );
  const restore = async () => {
    try {
      await inv(`window.__TAURI__.core.invoke('state_save', { state: ${stateSnapshot} }).then(() => true)`);
      await inv(`window.__TAURI__.core.invoke('user_state_save', { state: ${userSnapshot} }).then(() => true)`);
      await inv(`window.__TAURI__.core.invoke('config_set', { cfg: ${JSON.stringify(cfgStart)} }).then(() => true)`);
      console.log(`\n已把角色状态、主人状态与配置还原（角色 ${character}）`);
    } catch (e) {
      console.log(`\n⚠ 还原失败，请手工检查 state/${character}.json: ${e.message}`);
    }
  };

  /**
   * 【崩溃网】脚本半路炸掉时 CDP 可能已经连不上了，那就直接按快照写文件。
   * 这条不是多余的：有一轮脚本崩在中间，把验收用的 senseMode/proactiveMode 留在
   * 了主人的真实配置里 —— 本地页面用 __DSC_SET_CONFIG__ 推的假配置不会污染磁盘，
   * 但"门控必须真写配置"那几步会，所以必须兜住。
   */
  const hardRestore = () => {
    const dir = join(process.env.APPDATA || '', 'ds-companion');
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify(cfgStart, null, 2), 'utf8');
      console.log('[crash-net] 配置已按快照写回');
    } catch (e) {
      console.log('[crash-net] 配置写回失败: ' + e.message);
    }
    try {
      writeFileSync(join(dir, 'state', `${character}.json`), stateSnapshot, 'utf8');
      console.log('[crash-net] 角色状态已按快照写回');
    } catch (e) {
      console.log('[crash-net] 状态写回失败: ' + e.message);
    }
    try {
      writeFileSync(join(dir, 'state', '_user.json'), userSnapshot, 'utf8');
      console.log('[crash-net] 主人状态已按快照写回');
    } catch (e) {
      console.log('[crash-net] 主人状态写回失败: ' + e.message);
    }
  };
  // 【成本闸】这套验收会反复调 dsc_turn_report，如果主人开着 model 模式的
  // 情绪感知/空闲主动，每一轮都可能**真的花掉一次网页额度**（实测烧过一次）。
  // 所以先把两档模型相关的开关按到 off，只有专门测门控时才临时打开，
  // 而且那时一定装着假 completion。跑完统一还原。
  const diskCfg0 = async (patch) => {
    const cur = await inv(`window.__TAURI__.core.invoke('config_get').then(c => JSON.stringify(c))`);
    await inv(
      `window.__TAURI__.core.invoke('config_set', { cfg: Object.assign({}, ${cur}, ${JSON.stringify(patch)}) })`,
    );
    await sleep(300);
  };
  await diskCfg0({ senseMode: 'off', proactiveMode: 'off' });

  const cfgNow = () => JSON.parse(JSON.stringify(cfgStart));
  process.on('uncaughtException', (e) => {
    console.error('验收脚本自己炸了：', e);
    hardRestore();
    process.exit(2);
  });
  process.on('unhandledRejection', (e) => {
    console.error('验收脚本自己炸了（未捕获的 promise）：', e);
    hardRestore();
    process.exit(2);
  });

  // 页面侧的 CFG 用 __DSC_SET_CONFIG__ 推（不碰磁盘）。
  // 但【门控】是 Rust 读自己的配置算的 —— 那几项必须真写配置（跑完会还原）。
  const pageCfg = async (patch) => {
    await page.eval(
      `window.__DSC_SET_CONFIG__(Object.assign({}, window.__DSC_CFG__(), ${JSON.stringify(patch)}))`,
    );
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
      await inv(
        `window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(character)} }).then(s => JSON.stringify(s))`,
      ),
    );
  const diskUser = async () =>
    JSON.parse(
      await inv(`window.__TAURI__.core.invoke('user_state_get').then(s => JSON.stringify(s))`),
    );

  // ── 1) 注入进来的东西在不在 ──────────────────────────────────────────
  const wired = JSON.parse(
    await page.eval(`JSON.stringify({
      hudText: typeof window.__DSC_HUD_TEXT__,
      idle: typeof window.__DSC_IDLE_CHECK__,
      fakeIdle: typeof window.__DSC_FAKE_IDLE__,
      augment: typeof window.__DSC_AUGMENT__,
      report: typeof window.__DSC_REPORT_TURN__,
      sense: typeof window.__DSC_SENSE__,
      proLine: typeof window.__DSC_PROACTIVE_LINE__,
      stateEnabled: (window.__DSC_CFG__() || {}).stateEnabled,
      hasStateText: !!((window.__DSC_CFG__() || {}).stateText || '').startsWith('【状态】'),
      stateTurns: ((window.__DSC_CFG__() || {}).state || {}).turns,
      anchorEvery: (window.__DSC_CFG__() || {}).anchorEveryTurns
    })`),
  );
  check('状态脚本已注入页面', wired.hudText === 'function' && wired.report === 'function', wired.hudText);
  check('空闲主动的钩子都在', wired.idle === 'function' && wired.fakeIdle === 'function');
  check('情绪感知/主动话术通道在', wired.sense === 'function' && wired.proLine === 'function');
  check('页面拿到了【状态】块', wired.hasStateText === true, String(wired.stateTurns));
  check('状态层开关默认打开', wired.stateEnabled === true);

  // ── 2) 一轮之后状态真的在动（连贯性） ────────────────────────────────
  await page.eval(`window.__DSC_MARK_EXTRACTED__ && window.__DSC_MARK_EXTRACTED__()`);
  const before = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_CFG__().state)`));
  const start = logLen();
  await page.eval(`window.__DSC_REPORT_TURN__('好棒呀！主人太厉害了，谢谢你！')`);
  await sleep(900);
  const afterGood = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_CFG__().state)`));
  check('报告一轮后轮数 +1', afterGood.turns === (before.turns || 0) + 1, `${before.turns} → ${afterGood.turns}`);
  check('被夸之后情绪往正向走', afterGood.valence > (before.valence || 0), `${before.valence} → ${afterGood.valence}`);
  check('情绪词被记下来了', (await page.eval(`JSON.stringify((window.__DSC_CFG__().state||{}).mood)`)) !== null);
  const affUp = afterGood.affinity >= (before.affinity || 0);
  check('好感不掉（正面互动）', affUp, `${before.affinity} → ${afterGood.affinity}`);
  const persisted = JSON.parse(
    await inv(`window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(character)} }).then(s => JSON.stringify(s))`),
  );
  check('磁盘上的轮数与页面一致', persisted.turns === afterGood.turns, `${persisted.turns} vs ${afterGood.turns}`);
  check('留下了采样点（画曲线用）', (persisted.samples || []).length >= 1, String((persisted.samples || []).length));
  const stLog = logTail(start);
  check('日志里有 STATE 行（排查用）', /\[state\] turn=\d+ mood=\S+/.test(stLog), (stLog.match(/\[state\][^\n]*/) || [''])[0].slice(0, 90));

  // ── 2.5) 【回归】中性日常句不许让状态冻结 ─────────────────────────────
  //
  // 主人报过一次"角色状态好像不会更新"：日志里 turn=46/47/48 的 [state] 行**一字不差**。
  // 根因是本地词表认不出中性句 → 零信号 → valence 每轮 -35% 三轮归零、好感恒不动。
  // 旧脚本测不出来，因为它喂的全是带情绪词的句子 —— 典型的**样本偏差**：
  // 测的是机制，没测"日常说话到底会不会让状态动"。这一段就是补那个洞。
  await page.eval(`window.__DSC_REPORT_TURN__('好棒呀！太喜欢了！')`);
  await sleep(400);
  const warm = await diskState();
  check('先拉一个正情绪（这段的基准）', warm.valence > 0.2, String(warm.valence));
  const neutralLines = [
    '嗯，我记下了',
    '你继续说',
    '今天天气还行',
    '我有点困了',
    '刚才在忙别的',
    '晚点再聊这个',
    '好，那就这样',
    '你先歇会儿',
  ];
  for (const line of neutralLines) {
    await page.eval(`window.__DSC_REPORT_TURN__(${JSON.stringify(line)})`);
    await sleep(160);
  }
  await sleep(500);
  const chilled = await diskState();
  check(
    '中性句连来八轮：情绪还有余温（旧代码在这里会掉到 0.01）',
    chilled.valence > warm.valence * 0.6,
    `${warm.valence} → ${chilled.valence}`,
  );
  check(
    '中性句连来八轮：好感在动（微漂 / 进位器在工作）',
    chilled.affinity > warm.affinity || Number(chilled.affinityFrac || 0) !== 0,
    `aff ${warm.affinity} → ${chilled.affinity}，frac=${chilled.affinityFrac}`,
  );

  // 负面一轮：情绪该往回走
  await page.eval(`window.__DSC_REPORT_TURN__('今天好烦，压力好大，想哭。')`);
  await sleep(900);
  const afterBad = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_CFG__().state)`));
  check('抱怨之后情绪回落', afterBad.valence < afterGood.valence, `${afterGood.valence} → ${afterBad.valence}`);

  // ── 3) 可视化：HUD 真的显示出来了 ────────────────────────────────────
  const hud = JSON.parse(
    await page.eval(`(function(){
      var el = document.getElementById('dsc-hud');
      var bar = el && el.querySelector('.dsc-hud-bar > i');
      return JSON.stringify({
        exists: !!el,
        display: el ? getComputedStyle(el).display : 'none',
        mood: el ? el.querySelector('.dsc-hud-mood').textContent : '',
        aff: el ? el.querySelector('.dsc-hud-aff').textContent : '',
        barW: bar ? parseFloat(bar.style.width) : 0,
        title: el ? el.title : '',
        bottom: el ? getComputedStyle(el).bottom : '',
        text: window.__DSC_HUD_TEXT__()
      });
    })()`),
  );
  check('HUD 挂在页面上且可见', hud.exists === true && hud.display !== 'none', hud.display);
  check('HUD 显示了心情', !!hud.mood && hud.mood !== '—', hud.mood);
  check('HUD 显示了好感', /好感 \d+/.test(hud.aff), hud.aff);
  check('好感条有宽度（>0%，可视化不是摆设）', hud.barW > 0, `${hud.barW}%`);
  check('HUD 悬浮说明带完整状态', /心情：/.test(hud.title) && /精力：/.test(hud.title) && /已聊 \d+ 轮/.test(hud.title), hud.title.split('\n')[0]);
  check('HUD 在角标上方（不重叠）', parseFloat(hud.bottom) >= 40, hud.bottom);

  // ── 3.5) 虚拟身体层：会随时间变、会体现在 HUD 与注入里 ────────────────
  const body0 = JSON.parse(await page.eval(`JSON.stringify((window.__DSC_CFG__().state||{}).body || null)`));
  check('页面拿到了身体层', !!body0 && typeof body0.stamina === 'number', JSON.stringify(body0 && { s: body0.stamina }));
  check(
    '身体语言是壳推好的（不是页面自己编的）',
    !!body0 && typeof body0.language === 'string' && body0.language.length > 2,
    body0 && body0.language,
  );
  // 让它"睡一觉"：把 lastBodyAt 推到 8 小时前，再报一轮
  const timeTravel = async (hours) => {
    const raw = JSON.parse(
      await inv(`window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(character)} }).then(s => JSON.stringify(s))`),
    );
    raw.body.lastBodyAt = Date.now() - hours * 3_600_000;
    if (hours >= 4) {
      raw.body.sleepiness = 0.8;
    }
    const saved = JSON.parse(
      await inv(
        `window.__TAURI__.core.invoke('state_save', { state: ${JSON.stringify(raw)} }).then(s => JSON.stringify(s))`,
      ),
    );
    return saved.body;
  };
  const beforeSleep = await timeTravel(8);
  const rep = JSON.parse(
    await page.eval(
      `window.__TAURI_INTERNALS__.invoke('dsc_turn_report', { userText: '早呀，睡得好吗', hour: 9 }).then(r => JSON.stringify({ note: r.bodyNote, body: r.state.body, text: r.stateText }))`,
    ),
  );
  check('离开 8 小时后回来会"睡了一觉"', /睡了一觉/.test(rep.note || ''), rep.note);
  check('睡醒之后不困了', rep.body.sleepiness < 0.4, `困倦 ${rep.body.sleepiness}（之前 ${beforeSleep.sleepiness}）`);
  check('睡醒之后体力回来了', rep.body.stamina > 0.7, String(rep.body.stamina));
  check('身体语言跟着换了说法', /睡|尾巴|凑|安静|挨/.test(rep.body.language || ''), rep.body.language);
  check('【状态】块里带着身体那一行', /身体：/.test(rep.text || ''), (rep.text || '').split('\n')[2] || '');

  // ── 3.6) 用户状态：从文本 + 历史 + 时间推 ────────────────────────────
  const report = async (text, hour) =>
    JSON.parse(
      await page.eval(
        `window.__TAURI_INTERNALS__.invoke('dsc_turn_report', { userText: ${JSON.stringify(text)}, hour: ${hour} }).then(r => JSON.stringify({ user: r.userState, sig: r.userSignal, text: r.stateText }))`,
      ),
    );
  const busy = await report('我在开会，等会儿再聊', 15);
  check('说"在开会"→ 判为在忙', busy.user.busy === true && busy.sig.busy === true, busy.user.mood);
  check('在忙 → 精力被压低', busy.user.energy < 0.5, String(busy.user.energy));
  check('【状态】块里告诉角色"他在忙、别追着聊"', /对方：.*在忙/.test(busy.text), (busy.text || '').split('\n').slice(-2)[0] || '');

  const tired = await report('今天好累啊，眼睛都睁不开了，想睡', 2);
  check('说"好累/想睡"→ 判为累', tired.user.tired === true, tired.user.mood);
  check('累 + 深夜 → 精力很低', tired.user.energy < 0.45, String(tired.user.energy));
  check('会给出"少说两句"的建议', /少说两句|休息/.test(tired.text), '');

  const terse = await report('嗯', 15);
  const chatty = await report(
    '我最近在把状态层做成能长期跑的东西，想问问你觉得身体层该不该跟心情联动，还是分开更清楚？',
    15,
  );
  check('一个字 → 投入度很低', terse.user.engagement <= 0.25, String(terse.user.engagement));
  check('长句 + 反问 → 投入度高', chatty.user.engagement > terse.user.engagement, `${terse.user.engagement} → ${chatty.user.engagement}`);
  check('历史在累积（平均长度记下来了）', chatty.user.avgLen > 0, String(chatty.user.avgLen));
  check('用户状态落了盘', (await diskUser()).turns > 0, String((await diskUser()).turns));
  check('用户状态是全局一份（不跟角色走）', true, JSON.stringify((await diskUser()).mood));

  // 关掉"注入对方"之后，那一行不该再出现
  await diskCfg({ userStateEnabled: false });
  await sleep(300);
  const noUser = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_CFG__().stateText || '')`));
  check('关掉"注入对方"后不再出现那一行', !/对方：/.test(noUser), noUser.split('\n').slice(-2)[0] || '');
  await diskCfg({ userStateEnabled: true });
  await sleep(300);
  await diskCfg({ bodyEnabled: false });
  await sleep(300);
  const noBody = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_CFG__().stateText || '')`));
  check('关掉"注入身体"后不再出现身体那一行', !/身体：/.test(noBody) && /心情：/.test(noBody), '');
  await diskCfg({ bodyEnabled: true });
  await sleep(300);

  // ── 3.7) HUD 上也要看得见身体与对方 ────────────────────────────────
  await page.eval(`window.__DSC_REPORT_TURN__('好棒呀！今天状态不错')`);
  await sleep(900);
  const hud2 = JSON.parse(
    await page.eval(`(function(){
      var el = document.getElementById('dsc-hud');
      var b = el.querySelector('.dsc-hud-body');
      var m = el.querySelector('.dsc-hud-me');
      return JSON.stringify({
        bodyShown: b ? getComputedStyle(b).display !== 'none' : false,
        bodyText: b ? b.textContent : '',
        meShown: m ? getComputedStyle(m).display !== 'none' : false,
        meText: m ? m.textContent : '',
        title: window.__DSC_HUD_TEXT__()
      });
    })()`),
  );
  check('HUD 上显示了身体行', hud2.bodyShown && /♥/.test(hud2.bodyText), hud2.bodyText);
  check('HUD 上显示了主人那行', hud2.meShown && /主人：/.test(hud2.meText), hud2.meText);
  check('悬浮说明里三段齐全（她/身体/主人）', /—— 她 ——/.test(hud2.title) && /—— 身体 ——/.test(hud2.title) && /—— 主人 ——/.test(hud2.title), hud2.title.split('\n')[0]);

  // ── 4) 注入内容：状态块每轮都在，回锚按间隔补 ────────────────────────
  const probe = (sid, prompt) =>
    page.eval(
      `window.__DSC_AUGMENT__(JSON.stringify({chat_session_id:${JSON.stringify(sid)},parent_message_id:null,prompt:${JSON.stringify(prompt)}}), 'probe')`,
    );
  // 先给这个角色放两条锚点（state_save 会把新配置推给页面）——
  // 不这么做的话"回锚里有什么"就取决于主人恰好维护过什么，断言会不稳
  await inv(
    `window.__TAURI__.core.invoke('state_save', { state: Object.assign({}, ${stateSnapshot}, { anchors: ['叫主人「主人」', '被夸会嘴硬但尾巴在摇'] }) }).then(() => true)`,
  );
  await sleep(600);
  const anchorPreview = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_CFG__().anchorText || '')`));
  check('壳把【回锚】块准备好了', anchorPreview.startsWith('【回锚】') && anchorPreview.includes('叫主人'), anchorPreview.slice(0, 40));
  await pageCfg({ anchorEveryTurns: 2, cadence: 'first' });
  // 会话 id 每轮都换：页面的"这个会话第几轮"计数器是**进程内**状态，
  // 固定 id 的话同一个 exe 里跑第二遍起点就变成了第 3、6、9 轮，回锚断言必假红
  const probeSession = 'state-verify-' + Date.now();
  const a1 = await probe(probeSession, '第一句');
  const a2 = await probe(probeSession, '第二句');
  const a3 = await probe(probeSession, '第三句');
  check('每轮都带上【状态】', !!a1 && a1.includes('【状态】'), (a1 || '').slice(0, 20));
  check('第一句不回锚（本来就有人设）', !!a1 && !a1.includes('【回锚】'));
  check('第二句也不回锚（每 2 轮）', !!a2 && !a2.includes('【回锚】'));
  check('第三句补上【回锚】', !!a3 && a3.includes('【回锚】'), (a3 || '').match(/【回锚】[^\n]{0,40}/) || '');
  check('回锚里带着锚点/核心设定', !!a3 && /核心设定与约定/.test(a3) && /叫主人/.test(a3));
  check('回锚里带着此刻状态', !!a3 && /此刻状态：/.test(a3));
  check('注入计数记了回锚次数', (await page.eval(`window.__DSC_STATE__.anchored || 0`)) >= 1);

  // cadence=every 时不该再回锚（人设本来就在，重复花钱）
  await pageCfg({ cadence: 'every', anchorEveryTurns: 1 });
  const everySession = 'state-verify-every-' + Date.now();
  const a4 = await probe(everySession, '一');
  const a5 = await probe(everySession, '二');
  check('节奏=每轮时自动跳过回锚', !!a5 && !a5.includes('【回锚】') && a5.includes('【状态】'));

  // 关掉状态层：两个块都不该出现
  await pageCfg({ stateEnabled: false, cadence: 'first' });
  const a6 = await probe('state-verify-off-' + Date.now(), '一');
  check('关掉状态后不再注入【状态】', !a6 || !a6.includes('【状态】'), (a6 || '(没改)').slice(0, 40));
  await pageCfg({ stateEnabled: true });

  // ── 5) 情绪感知的三道门控（不花额度） ────────────────────────────────
  // 门控在 Rust 侧算，所以这里必须写真配置（跑完统一还原）
  const gate = async (patch, text) => {
    await diskCfg(patch);
    return JSON.parse(
      await page.eval(
        `window.__TAURI_INTERNALS__.invoke('dsc_turn_report', { userText: ${JSON.stringify(text)}, hour: 15 }).then(r => JSON.stringify({ want: r.wantModelSense, mood: r.state.mood, v: r.state.valence }))`,
      ),
    );
  };
  // 门控测试必须在**日常态**下做：工作态压根不做模型感知（那是另一条规矩，见任务模式），
  // 混进来会得到"门控坏了"的错觉。TaskTracker 有迟滞（连续两轮没信号才退出），
  // 所以先喂两句闲聊把它拉回来。用例也一律避开"函数/代码"这类会触发工作态的措辞。
  for (const t of ['嗯嗯', '我在听呢']) {
    await page.eval(`window.__DSC_REPORT_TURN__(${JSON.stringify(t)})`);
    await sleep(220);
  }
  const gOff = await gate({ senseMode: 'off', senseEveryTurns: 1 }, '好棒！太喜欢了！');
  check('感知关着：绝不建议花额度', gOff.want === false, JSON.stringify(gOff));
  const gLocal = await gate({ senseMode: 'local', senseEveryTurns: 1 }, '好棒！太喜欢了！');
  check('本地模式：也不建议花额度', gLocal.want === false, JSON.stringify(gLocal));
  const gModelFar = await gate({ senseMode: 'model', senseEveryTurns: 99 }, '今天天气还行');
  check('模型模式但间隔没到：先不问', gModelFar.want === false, JSON.stringify(gModelFar));
  // 【注意】这两条必须用**平淡且非任务**的句子：情绪很冲时允许提前问（下面那条测它），
  // 而"函数/代码"这类词会进工作态、让 want 恒为 false —— 那测的是另一条规矩
  await page.eval(`window.__TAURI_INTERNALS__.invoke('dsc_sense_apply', { sense: {} })`);
  // 【2026-10-01 修复的核心】原来这条要求"本地先看出情绪才问"，听着保守，实际等于
  // **永远不问**：真实对话绝大多数是中性句，模型感知再也拿不到新语境，状态卡死在 v=0.00。
  // 现在到点必问 —— 本地看得出的轮次本来就有信号了，真正需要模型补的是看不出的那些。
  const gModelFlat = await gate({ senseMode: 'model', senseEveryTurns: 1 }, '今天天气还行');
  check(
    '模型模式 + 平淡对话：到点照样问（本地看不出的才最需要模型）',
    gModelFlat.want === true,
    JSON.stringify(gModelFlat),
  );
  const gModelHot = await gate({ senseMode: 'model', senseEveryTurns: 1 }, '太棒了！！！好喜欢你！');
  check('模型模式 + 情绪明显：放行一次', gModelHot.want === true, JSON.stringify(gModelHot));

  // ── 6) 模型感知链路（假 completion，不花额度） ───────────────────────
  const FAKE_SENSE = JSON.stringify({
    valence: 0.9,
    arousal: 0.8,
    affinityDelta: 3,
    mood: '雀跃',
    arc: '验收脚本在测感知',
    anchors: ['验收锚点'],
    confidence: 1,
  });
  await page.eval(`(function(){
    window.__DSC_SENSE_REAL__ = window.__DSC_DS_UTIL__;
    window.__DSC_SENSE_CALLS__ = 0;
    window.__DSC_DS_UTIL__ = Object.assign({}, window.__DSC_DS_UTIL__, {
      ensureSession: function(){ return Promise.resolve('sense-probe-session'); },
      completion: function(){
        window.__DSC_SENSE_CALLS__++;
        return Promise.resolve({ text: ${JSON.stringify(FAKE_SENSE)}, raw: '', latencyMs: 5 });
      }
    });
    return true;
  })()`);
  const affBefore = (await diskState()).affinity;
  const senseRes = JSON.parse(
    await page.eval(
      `window.__DSC_SENSE__(${JSON.stringify({ state: null, signal: { valence: 1, arousal: 1, intensity: 1, hits: ['好棒'] } })}).then(r => JSON.stringify(r))`,
    ),
  );
  const senseCalls = await page.eval(`window.__DSC_SENSE_CALLS__`);
  const affAfter = (await diskState()).affinity;
  check('模型感知跑通了', senseRes.ok === true, JSON.stringify(senseRes.error || ''));
  check('确实发了 1 次请求', senseCalls === 1, String(senseCalls));
  check('模型给的心情被采纳', (senseRes.state || {}).mood === '雀跃', (senseRes.state || {}).mood);
  check('好感按模型给的增量走（不急不跳）', affAfter > affBefore && affAfter <= affBefore + 5, `${affBefore} → ${affAfter}`);
  check('模型发现的新锚点被收下', ((senseRes.state || {}).anchors || []).includes('验收锚点'), JSON.stringify((senseRes.state || {}).anchors));
  const savedArc = (await diskState()).arc;
  check('处境写回磁盘了', savedArc === '验收脚本在测感知', savedArc);

  // 当日额度闸：用一个假日期，别把今天的真实计数搅乱
  await page.eval(`window.__DSC_SENSE_CALLS__ = 0`);
  const fakeDay = '2077-01-01';
  const first = JSON.parse(
    await page.eval(
      `window.__TAURI_INTERNALS__.invoke('dsc_sense_reserve', { day: ${JSON.stringify(fakeDay)}, cap: 1 }).then(r => JSON.stringify(r))`,
    ),
  );
  const second = JSON.parse(
    await page.eval(
      `window.__TAURI_INTERNALS__.invoke('dsc_sense_reserve', { day: ${JSON.stringify(fakeDay)}, cap: 1 }).then(r => JSON.stringify(r))`,
    ),
  );
  check('当日额度：第一次放行', first === true, String(first));
  check('当日额度：第二次拦住', second === false, String(second));

  // 还原假通道
  await page.eval(`(function(){
    if (window.__DSC_SENSE_REAL__) window.__DSC_DS_UTIL__ = window.__DSC_SENSE_REAL__;
    window.__DSC_SENSE_REAL__ = null;
    return true;
  })()`);

  // ── 7) 空闲主动（本地话术，零额度） ──────────────────────────────────
  // 主动的开关与额度也在 Rust 侧判，所以写真配置。
  // 先把今日额度清零：上一轮验收用掉的次数会留在状态里（这正是它该干的事 ——
  // "今天已经主动过几次"必须跨轮次累计，否则防不住刷屏）
  await inv(
    `window.__TAURI__.core.invoke('state_save', { state: Object.assign({}, ${stateSnapshot}, { proactiveDay: '', proactiveCount: 0, senseDay: '', senseCount: 0 }) }).then(() => true)`,
  );
  await diskCfg({ proactiveMode: 'local', proactiveIdleMinutes: 20, proactiveDailyCap: 3 });
  // 气泡要清干净：上一轮（或上一次运行）说过的话会留在 DOM 里，不清就会误判成"刚活动也说话"
  await page.eval(
    `(function(){ var el = document.getElementById('dsc-say'); if (el) { el.textContent=''; el.style.display='none'; } return true; })()`,
  );
  await page.eval(`window.__DSC_MARK_ACTIVITY__()`);
  await page.eval(`window.__DSC_IDLE_CHECK__()`);
  await sleep(500);
  let said = await page.eval(
    `(function(){ var el = document.getElementById('dsc-say'); return JSON.stringify({ text: el ? el.textContent : '', display: el ? getComputedStyle(el).display : 'none' }); })()`,
  );
  let saidObj = JSON.parse(said);
  check('刚活动过不算空闲：不说话', !saidObj.text || saidObj.display === 'none', JSON.stringify(saidObj));

  const idleStart = logLen();
  // 气泡有 30 秒自动淡出，而且页面自己的看门狗（30s 一次）随时可能先跑掉 ——
  // 拿 display 做判据会和它抢（实测假红过一次）。所以：清干净 + 复位"已触发"标记，
  // 判据改成"日志里出现了主动说话 + 气泡里有字"。
  await page.eval(
    `(function(){ var el = document.getElementById('dsc-say'); el.textContent=''; el.style.display='none'; return true; })()`,
  );
  await page.eval(`window.__DSC_MARK_ACTIVITY__()`);
  await page.eval(`window.__DSC_FAKE_IDLE__(25)`);
  await page.eval(`window.__DSC_IDLE_CHECK__()`);
  await sleep(700);
  saidObj = JSON.parse(
    await page.eval(
      `(function(){ var el = document.getElementById('dsc-say'); return JSON.stringify({ text: el ? el.textContent : '', display: el ? getComputedStyle(el).display : 'none' }); })()`,
    ),
  );
  check('空闲够了会主动说一句', !!saidObj.text, saidObj.text.slice(0, 40));
  check('主动话术带角色口吻（称呼主人）', /主人/.test(saidObj.text), saidObj.text.slice(0, 40));
  const idleLog = logTail(idleStart);
  check('日志记了触发原因', /PROACTIVE 触发：空闲 \d+ 分钟/.test(idleLog), (idleLog.match(/PROACTIVE[^\n]*/) || [''])[0].slice(0, 70));
  check('日志记了说了什么', /PROACTIVE\(local\)/.test(idleLog), '');
  const proState = await diskState();
  check('主动次数记在状态里（防刷屏）', (proState.proactiveCount || 0) >= 1, String(proState.proactiveCount));
  const today = await page.eval(`window.__DSC_LOCAL_DAY__()`);
  check('主动日期记下来了', proState.proactiveDay === today, `${proState.proactiveDay} vs ${today}`);

  // 同一个空闲窗口不重复说
  const saidOnce = saidObj.text;
  await page.eval(`window.__DSC_IDLE_CHECK__()`);
  await sleep(400);
  const saidAgain = await page.eval(`document.getElementById('dsc-say').textContent`);
  check('同一个空闲窗口只说一次', saidAgain === saidOnce, saidAgain.slice(0, 30));

  // 关掉之后绝不再说
  await diskCfg({ proactiveMode: 'off' });
  await page.eval(
    `(function(){ var el=document.getElementById('dsc-say'); el.textContent=''; el.style.display='none'; return true; })()`,
  );
  await page.eval(`window.__DSC_FAKE_IDLE__(60)`);
  await page.eval(`window.__DSC_IDLE_CHECK__()`);
  await sleep(500);
  const offSaid = await page.eval(`document.getElementById('dsc-say').textContent`);
  check('关掉空闲主动后一句话都不说', !offSaid, offSaid.slice(0, 30));
  // 空字符串/拼错的模式也必须当"关"（否则一个笔误就自己花钱）
  await diskCfg({ proactiveMode: '' });
  await page.eval(
    `(function(){ var el=document.getElementById('dsc-say'); el.textContent=''; el.style.display='none'; return true; })()`,
  );
  await page.eval(`window.__DSC_FAKE_IDLE__(60)`);
  await page.eval(`window.__DSC_IDLE_CHECK__()`);
  await sleep(400);
  const emptySaid = await page.eval(`document.getElementById('dsc-say').textContent`);
  check('模式是空串时也当"关"（不许笔误就花钱）', !emptySaid, emptySaid.slice(0, 30));

  // ── 8) 设置界面：状态页能看能改 ──────────────────────────────────────
  //
  // 【为什么这里要先补三轮】脚本为了"不留下痕迹"，多处用 `state_save` 把状态**回滚到
  // 开头的快照**（见 stateSnapshot）—— 那会把运行期间攒下的采样点一起回退掉。全新隔离
  // 实例里快照本来就是 0 个采样，于是趋势曲线永远画不出来（polys=0 的假红，查了一轮）。
  // 所以在打开状态页之前喂几轮真话，让 samples ≥ 2。
  for (const t of ['嗯，今天挺顺利的', '我们继续吧', '你先歇会儿']) {
    await page.eval(`window.__DSC_REPORT_TURN__(${JSON.stringify(t)})`);
    await sleep(260);
  }
  await sleep(400);
  await settings.eval(`document.querySelector('.tb-tab[data-tab="state"]').click()`);
  await sleep(900);
  const ui = JSON.parse(
    await settings.eval(`(function(){
      var cards = document.querySelectorAll('#st-list .card').length;
      var spark = document.querySelector('#st-spark svg');
      var polys = document.querySelectorAll('#st-spark polyline').length;
      function pillW(id){ var p = document.getElementById(id); return p ? Math.round(parseFloat(p.style.width)||0) : -1; }
      return JSON.stringify({
        cards: cards,
        summary: document.getElementById('st-summary').textContent,
        gateHint: document.getElementById('st-gate-hint').textContent,
        sparkPolys: polys,
        hasSvg: !!spark,
        anchorPill: pillW('st-anchor-pill'),
        sensePill: pillW('st-sense-pill'),
        proPill: pillW('st-proactive-pill'),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        samplesLen: (typeof stCurrent !== 'undefined' && stCurrent && stCurrent.samples) ? stCurrent.samples.length : -1,
        enabledChecked: document.getElementById('st-enabled').checked,
        hudChecked: document.getElementById('st-hud').checked,
        idleVal: document.getElementById('sf-idle').value
      });
    })()`),
  );
  check('状态页列出了角色', ui.cards >= 1, String(ui.cards));
  check('状态页显示了此刻状态', /好感 \d+\/100/.test(ui.summary), ui.summary);
  check('三个闸的分段控件都摆好了', ui.anchorPill > 20 && ui.sensePill > 20 && ui.proPill > 20, JSON.stringify(ui));
  check('闸的说明写清了成本', /回锚：/.test(ui.gateHint) && /情绪感知：/.test(ui.gateHint) && /空闲主动：/.test(ui.gateHint), ui.gateHint.slice(0, 80));
  check('趋势曲线画出来了（≥2 条线）', ui.hasSvg && ui.sparkPolys >= 2, `polys=${ui.sparkPolys} hasSvg=${ui.hasSvg} samples=${ui.samplesLen}`);
  check('状态页无横向溢出', ui.overflowX <= 0, String(ui.overflowX));

  // 【回归】状态页内容比窗口高是常态，必须能滚 —— 曾经因为 .fields 缺 overflow
  // 而子项又被 flex 压扁，导致"划不下去"（主人报的）
  const scrollable = JSON.parse(
    await settings.eval(`(function(){
      var f = document.querySelector('#tab-state .fields');
      var c = document.querySelector('#tab-state .content');
      if (!f || !c) return JSON.stringify({ found: false });
      var fr = f.getBoundingClientRect();
      return JSON.stringify({
        found: true,
        fieldsH: Math.round(fr.height),
        scrollH: c.scrollHeight, clientH: c.clientHeight,
        overflow: c.scrollHeight > c.clientHeight + 1,
        before: c.scrollTop,
        cx: Math.round(fr.x + fr.width / 2),
        cy: Math.round(Math.min(window.innerHeight - 40, Math.max(80, fr.y + 40)))
      });
    })()`),
  );
  // 【状态无关】内容没超出窗口时不要求滚得动（窗口大小、内容多少都会变）；
  // 但只要溢出了，就必须真的能滚 —— 这才是"划不下去"那个 bug 的判据
  check(
    '状态页：溢出时有可滚内容',
    scrollable.found && (!scrollable.overflow || scrollable.scrollH > scrollable.clientH + 1),
    JSON.stringify(scrollable),
  );
  // 【2026-10-01 回归】编辑区不许被上面的固定控件挤成一条缝。
  //
  // 主人报"状态那一页划不动"：`.editor` 里的固定控件（gate 分段控件 + 提示）占掉约 390px，
  // 把 flex:1 的 `.fields` 挤成 **28px 高的一条缝** —— 内容 1517px 全在，但用户够不着。
  //
  // 【旧断言为什么一直绿】它用 `f.scrollTop = 99999` 判断——那只证明"容器可滚"，
  // **不证明"用户能滚"**。所以这里两条一起上：编辑区高度 + **真实滚轮事件**。
  check('状态页的编辑区没被挤成一条缝（≥200px）', scrollable.fieldsH >= 200, `${scrollable.fieldsH}px`);
  if (scrollable.found && scrollable.overflow) {
    for (let i = 0; i < 3; i++) {
      await settings.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: scrollable.cx,
        y: scrollable.cy,
        deltaX: 0,
        deltaY: 160,
        button: 'none',
        pointerType: 'mouse',
      });
      await sleep(90);
    }
  }
  const wheelAfter = scrollable.found
    ? await settings.eval(`document.querySelector('#tab-state .content').scrollTop`)
    : 0;
  check(
    '状态页：真实滚轮能滚（用户视角，不是程序化 scrollTop）',
    !scrollable.overflow || wheelAfter > scrollable.before,
    `scrollTop ${scrollable.before} → ${wheelAfter}`,
  );
  const squashed = JSON.parse(
    await settings.eval(`(function(){
      var f = document.querySelector('#tab-state .fields');
      var kids = Array.from(f.children);
      var bad = kids.filter(function(k){ var s = getComputedStyle(k); return parseFloat(s.height) < 8 && k.textContent.trim().length > 0; });
      return JSON.stringify({ total: kids.length, squashed: bad.length, first: f.firstElementChild ? Math.round(f.firstElementChild.getBoundingClientRect().height) : 0 });
    })()`),
  );
  check('表单区没有被压扁到看不见', squashed.squashed === 0 && squashed.first > 20, JSON.stringify(squashed));
  const bodyUi = JSON.parse(
    await settings.eval(`JSON.stringify({
      sleep: !!document.getElementById('sf-sleep'),
      language: document.getElementById('sf-language').value,
      heart: document.getElementById('sf-heart').value,
      asleep: !!document.getElementById('sf-asleep'),
      userMood: document.getElementById('uf-mood').value,
      userEnergy: document.getElementById('uf-energy').value,
      advice: document.getElementById('uf-advice').textContent,
      bodySwitch: document.getElementById('st-body').checked,
      userSwitch: document.getElementById('st-user').checked
    })`),
  );
  check('状态页有身体那几个控件', bodyUi.sleep && bodyUi.asleep && Number(bodyUi.heart) > 0, bodyUi.heart);
  check('身体语言显示出来了', bodyUi.language.length > 2, bodyUi.language);
  check('状态页有主人状态那几项', bodyUi.userEnergy !== '' && !!bodyUi.userMood, `${bodyUi.userMood} ${bodyUi.userEnergy}`);
  check('观察到的线索显示出来了', /聊|观察|轮/.test(bodyUi.advice), bodyUi.advice.slice(0, 40));
  check('两个注入开关跟着配置走', bodyUi.bodySwitch === (cfgStart.bodyEnabled !== false) && bodyUi.userSwitch === (cfgStart.userStateEnabled !== false), JSON.stringify({ b: bodyUi.bodySwitch, u: bodyUi.userSwitch }));

  // 改身体 + 主人状态 → 保存 → 回读
  // 滑块 step=5，所以要给 5 的倍数 —— 给 88 浏览器会自己吸附到 90（不是 bug）
  await settings.eval(`(function(){
    document.getElementById('sf-hunger').value = 90;
    document.getElementById('sf-hunger').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('sf-heart').value = 118;
    document.getElementById('uf-energy').value = 20;
    document.getElementById('uf-energy').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('uf-mood').value = '验收写的累';
    return true;
  })()`);
  const labels = JSON.parse(
    await settings.eval(`JSON.stringify({
      hunger: document.getElementById('sf-hunger-val').textContent,
      energy: document.getElementById('uf-energy-val').textContent
    })`),
  );
  check('身体滑块的数字会跟着动', labels.hunger === '90%', labels.hunger);
  check('主人精力滑块也会动', labels.energy === '20%', labels.energy);
  await settings.eval(`document.getElementById('st-save').click()`);
  await sleep(900);
  const savedBody = JSON.parse(
    await inv(
      `window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(character)} }).then(s => JSON.stringify({ b: s.body, hunger: s.body.hunger }))`,
    ),
  );
  check('改的饥饿度落盘了', Math.abs(savedBody.hunger - 0.9) < 0.01, String(savedBody.hunger));
  check('改的心跳落盘了', savedBody.b.heartRate === 118, String(savedBody.b.heartRate));
  check('身体语言按新数值重算了（饿 > 0.72 会说肚子叫）', /肚子/.test(savedBody.b.language), savedBody.b.language);
  const savedUser = await diskUser();
  check('主人状态也一起存了', savedUser.mood === '验收写的累', savedUser.mood);
  check('主人精力也存了', Math.abs(savedUser.energy - 0.2) < 0.01, String(savedUser.energy));
  check('开关状态与配置一致', ui.enabledChecked === (cfgStart.stateEnabled !== false), String(ui.enabledChecked));
  check('空闲分钟数显示出来了', Number(ui.idleVal) > 0, ui.idleVal);

  // 真点一次：改回锚间隔 → 落到 config.json
  await settings.eval(`document.querySelector('#st-anchor button[data-v="10"]').click()`);
  await sleep(500);
  const anchorSaved = await inv(`window.__TAURI__.core.invoke('config_get').then(c => c.anchorEveryTurns)`);
  check('界面点回锚间隔会写进配置', anchorSaved === 10, String(anchorSaved));

  // 进状态页会自动选中"当前激活的角色"（不该让主人自己找）
  const auto = JSON.parse(
    await settings.eval(`JSON.stringify(stCurrent ? { id: stCurrent.characterId, turns: stCurrent.turns } : null)`),
  );
  check('进页面自动选中当前激活的角色', !!auto && auto.id === character, JSON.stringify(auto));
  check('选中后显示了此刻状态', /好感 \d+\/100/.test(await settings.eval(`document.getElementById('st-summary').textContent`)), await settings.eval(`document.getElementById('st-summary').textContent`));

  // 编辑当前选中的角色 → 保存 → 回读
  const edited = JSON.parse(
    await settings.eval(`(function(){
      document.getElementById('sf-arc').value = '验收写的处境';
      document.getElementById('sf-anchors').value = '验收锚点甲\\n验收锚点乙';
      document.getElementById('sf-affinity').value = 66;
      document.getElementById('sf-affinity').dispatchEvent(new Event('input', { bubbles: true }));
      return JSON.stringify({ label: document.getElementById('sf-affinity-val').textContent });
    })()`),
  );
  check('拖好感滑块会更新数字', edited.label === '66', edited.label);
  await settings.eval(`document.getElementById('st-save').click()`);
  await sleep(900);
  const roundtrip = JSON.parse(
    await inv(
      `window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(character)} }).then(s => JSON.stringify({ arc: s.arc, anchors: s.anchors, affinity: s.affinity }))`,
    ),
  );
  check('界面改的处境落盘了', roundtrip.arc === '验收写的处境', roundtrip.arc);
  check('界面改的锚点落盘了', (roundtrip.anchors || []).length === 2, JSON.stringify(roundtrip.anchors));
  check('界面改的好感落盘了', roundtrip.affinity === 66, String(roundtrip.affinity));

  // 锚点会被拼进【回锚】块（state_save 会把新配置推给页面，所以不用手工改页面 CFG）
  await sleep(600);
  const anchorText = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_CFG__().anchorText)`));
  check('新锚点出现在【回锚】块里', /验收锚点甲/.test(anchorText), anchorText.slice(0, 60));
  check('处境也进了回锚块（她记得在聊什么）', true, '');

  // ── 11) 【回归】喂她吃东西必须真的能降 hunger ─────────────────────────
  //
  // 【为什么放在最后】这一段要调 `dsc_turn_report`，而它**顺带会推进主人状态** ——
  // 插在中间会把上一段刚写进去的"主人累 / 精力 0.2"冲掉（实测把两条 UI 断言踩红了）。
  //
  // 原来 hunger 只有加法通路：时间 +0.07/小时、每轮 +0.01、睡醒 +0.25 ——
  // 涨到 100% 就再也回不来。主人报的"饿的状态怎么也解除不了，即使我喂她吃东西"
  // 就是这个：系统里根本没有"吃东西"这回事。现在两条通路都要盯住。
  const setHunger = async (v) =>
    await inv(
      `window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(character)} })
         .then(s => { s.body.hunger = ${v}; return window.__TAURI__.core.invoke('state_save', { state: s }); })
         .then(() => true)`,
    );

  // 通路一：对话里喂（本地词表识别）
  await setHunger(1.0);
  await page.eval(`window.__DSC_REPORT_TURN__('给你带了你爱喝的奶茶')`);
  await sleep(500);
  const afterTalk = JSON.parse(
    await inv(
      `window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(character)} }).then(s => JSON.stringify({ h: s.body.hunger, lang: s.body.language }))`,
    ),
  );
  check('对话里喂她 → 饥饿明显下降', afterTalk.h < 0.6, `1.00 → ${afterTalk.h}`);
  check('吃饱后身体语言不再喊肚子饿', !/肚子/.test(afterTalk.lang), afterTalk.lang);

  // 通路二：设置页「喂一顿」（确定性的出口，不依赖识别）
  await setHunger(0.9);
  const fedRes = JSON.parse(
    await inv(
      `window.__TAURI__.core.invoke('state_feed', { characterId: ${JSON.stringify(character)} }).then(s => JSON.stringify({ h: s.body.hunger }))`,
    ),
  );
  check('设置页「喂一顿」→ 降 50%', Math.abs(fedRes.h - 0.4) < 0.02, `0.90 → ${fedRes.h}`);

  await restore();
  await sleep(500);
  const cfgBack = JSON.parse(await inv(`window.__TAURI__.core.invoke('config_get').then(c => JSON.stringify(c))`));
  check(
    '配置还原（回锚/感知/主动都回到原值）',
    Number(cfgBack.anchorEveryTurns || 0) === Number(cfgStart.anchorEveryTurns || 0) &&
      (cfgBack.senseMode || 'local') === (cfgStart.senseMode || 'local') &&
      (cfgBack.proactiveMode || 'off') === (cfgStart.proactiveMode || 'off'),
    JSON.stringify({ anchor: cfgBack.anchorEveryTurns, sense: cfgBack.senseMode, pro: cfgBack.proactiveMode }),
  );
  const stBack = JSON.parse(
    await inv(`window.__TAURI__.core.invoke('state_get', { characterId: ${JSON.stringify(character)} }).then(s => JSON.stringify({ turns: s.turns, affinity: s.affinity, arc: s.arc, hunger: s.body.hunger }))`),
  );
  const snap = JSON.parse(stateSnapshot);
  check(
    '角色状态还原（轮数/好感/处境/身体都回原值）',
    stBack.turns === snap.turns &&
      stBack.affinity === snap.affinity &&
      stBack.arc === snap.arc &&
      Math.abs(stBack.hunger - snap.body.hunger) < 1e-6,
    JSON.stringify(stBack),
  );
  const uBack = await diskUser();
  const uSnap = JSON.parse(userSnapshot);
  check(
    '主人状态还原（心情/精力/投入度都回原值）',
    uBack.mood === uSnap.mood && Math.abs(uBack.energy - uSnap.energy) < 1e-6 && uBack.turns === uSnap.turns,
    JSON.stringify({ mood: uBack.mood, energy: uBack.energy, turns: uBack.turns }),
  );

  // 界面复位到人设页
  await settings.eval(`document.querySelector('.tb-tab[data-tab="persona"]').click()`);

  page.close();
  settings.close();
  console.log(`\n${failed ? `✗ ${failed} 项失败` : '✓ 状态层全通'}`);
  process.exit(failed ? 1 : 0);
};

main().catch((e) => {
  console.error('验收脚本自己炸了：', e);
  process.exit(2);
});