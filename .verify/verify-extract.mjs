/**
 * B2 记忆整理链路验收（不花网页额度）。
 *
 * 手法：把 deepseek-client 的 completion / ensureSession 换成假的（返回固定 JSON），
 * 于是整条链路都能真跑一遍 —— 挑会话 → 拼 prompt → 解析 → memory_ingest →
 * 落盘 → 事件回设置窗口 → UI 刷新。真实网络那一段（token/PoW/SSE）由
 * verify-ds-client.mjs 覆盖，两者拼起来才是完整证据链。
 *
 * 用法：node .verify/verify-extract.mjs
 */
import { readFileSync } from 'node:fs';
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
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
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
  await sleep(400);
  return p;
}

const MARK = '验收整理';
const SESSION = 'probe-session-aaaabbbb';

const FAKE_ADD = JSON.stringify({
  items: [
    {
      op: 'add',
      name: `${MARK}-猫叫咪咪`,
      content: '主人养了一只叫咪咪的猫',
      keys: ['猫', '咪咪'],
      importance: 4,
      reason: '稳定事实',
    },
    {
      op: 'add',
      name: `${MARK}-作息`,
      content: '主人习惯凌晨两点才睡',
      keys: ['作息', '熬夜'],
      importance: 3,
    },
  ],
});

const FAKE_UPDATE = JSON.stringify({
  items: [
    {
      op: 'update',
      id: 'by-title',
      name: `${MARK}-猫叫咪咪`,
      content: '主人养了一只叫咪咪的白猫，怕生',
      keys: ['猫', '咪咪', '白猫'],
      reason: '信息更完整了',
    },
    { op: 'noop', id: 'whatever', reason: '没变化' },
  ],
});

const FAKE_PROSE = '我觉得这段对话没什么值得记的。';

/** 把三个"会碰网络"的动作换成假的（建会话 / 回读分支 / 发请求）；还原函数见 RESTORE_JS */
const FAKE_JS = (reply) => `(function(){
  // __DSC_DS_REAL__ 只存**第一次**看到的真货：这个函数会被调用多次，
  // 每次覆盖的话第二次存下来的就是假货，还原后页面就永远坏了
  // （表现为真机提取时报 "Cannot read properties of null (reading 'calls')"）
  if (!window.__DSC_DS_REAL__) window.__DSC_DS_REAL__ = window.__DSC_DS_UTIL__;
  window.__DSC_FAKE__ = {
    calls: 0, prompt: null, parent: 'unset', sessionId: null,
    ensureCalls: 0, forced: 0, kind: '', tailCalls: 0, tailLastId: 0,
    responseMessageId: 8, failFirst: 0
  };
  var fake = Object.assign({}, window.__DSC_DS_REAL__, {
    // ask() 通过 util 上的这三件套碰网络（deepseek-client 里的 seam），全换成假的：
    // 不花网页额度，也不往侧边栏里建会话
    ensureSession: function(force, kind){
      window.__DSC_FAKE__.ensureCalls++;
      window.__DSC_FAKE__.forced = force ? 1 : 0;
      window.__DSC_FAKE__.kind = String(kind || '');
      return Promise.resolve('memory-session-probe');
    },
    historyTail: function(){
      window.__DSC_FAKE__.tailCalls++;
      var n = window.__DSC_FAKE__.tailLastId;
      return Promise.resolve({
        count: n ? 2 : 0, ids: n ? [n - 1, n] : [], lastId: n,
        lastAssistantId: n, currentMessageId: n
      });
    },
    completion: function(opts){
      window.__DSC_FAKE__.calls++;
      window.__DSC_FAKE__.prompt = opts.prompt;
      window.__DSC_FAKE__.parent = opts.parentMessageId === null ? 'null' : String(opts.parentMessageId);
      window.__DSC_FAKE__.sessionId = opts.sessionId;
      if (window.__DSC_FAKE__.failFirst > 0) {
        window.__DSC_FAKE__.failFirst--;
        return Promise.reject(new Error('假装第一次失败'));
      }
      return Promise.resolve({
        text: ${JSON.stringify(reply)}, raw: '', latencyMs: 7,
        responseMessageId: window.__DSC_FAKE__.responseMessageId, requestMessageId: 7
      });
    }
  });
  window.__DSC_DS_UTIL__ = fake;
  return true;
})()`;

const RESTORE_JS = `(function(){
  if (window.__DSC_DS_REAL__) window.__DSC_DS_UTIL__ = window.__DSC_DS_REAL__;
  window.__DSC_DS_REAL__ = null;
  window.__DSC_FAKE__ = null;
  return true;
})()`;

const readLogTail = (from) => {
  try {
    return readFileSync(LOG, 'utf8').slice(from);
  } catch {
    return '';
  }
};
const logLen = () => {
  try {
    return readFileSync(LOG, 'utf8').length;
  } catch {
    return 0;
  }
};

const main = async () => {
  const settings = await settingsPage();
  const page = await mainPage();

  // 隐藏会话 id 与"会话链"状态都会被这一版 ask() 改动 —— 先快照，收尾原样还原。
  // 不还原的话会把主人真实的整理链指向测试用的假会话（下次真整理会打到一个不存在的会话）。
  const CHAIN_KEYS = [
    'dsc-chain-memory', 'dsc-chain-judge', 'dsc-chain-ping',
    'dsc-memory-session', 'dsc-judge-session', 'dsc-ping-session',
  ];
  const chainSaved = {};
  for (const k of CHAIN_KEYS) {
    chainSaved[k] = await page.eval(`localStorage.getItem(${JSON.stringify(k)})`);
  }

  const inv = (js) => settings.eval(js);
  const listMine = `window.__TAURI__.core.invoke('memory_list').then(l => l.filter(m => m.name.indexOf(${JSON.stringify(MARK)}) >= 0))`;

  // 0) 清掉上一轮残留（幂等）
  for (const m of (await inv(listMine)) || []) {
    await inv(`window.__TAURI__.core.invoke('memory_delete', { id: ${JSON.stringify(m.id)} })`);
  }

  const cfg = JSON.parse(
    await inv(`window.__TAURI__.core.invoke('config_get').then(c => JSON.stringify(c))`),
  );

  // ── 1) 脚本真的注进页面了 ────────────────────────────────────────────
  const wired = JSON.parse(
    await page.eval(`JSON.stringify({
      extract: typeof window.__DSC_EXTRACT__,
      util: typeof window.__DSC_EXTRACT_UTIL__,
      seed: typeof window.__DSC_REMEMBER_TURN__,
      keys: (typeof window.__DSC_TRANSCRIPT_KEYS__ === 'function') ? window.__DSC_TRANSCRIPT_KEYS__() : null,
      head: (window.__DSC_EXTRACT_UTIL__ || {}).HEAD,
      max: (window.__DSC_EXTRACT_UTIL__ || {}).MAX_ITEMS
    })`),
  );
  check('__DSC_EXTRACT__ 已注入主页面', wired.extract === 'function', wired.extract);
  check('extract 工具集可用', wired.util === 'object', wired.util);
  check('留痕种子钩子可用', wired.seed === 'function', wired.seed);
  check('整理标记头正确', wired.head === '【DS Companion 记忆整理】', wired.head);
  check('条目上限 5', wired.max === 5, String(wired.max));

  // 页面里跑一遍纯函数（确保注入的是真代码，不是空壳）
  const pure = JSON.parse(
    await page.eval(`(function(){
      var U = window.__DSC_EXTRACT_UTIL__;
      return JSON.stringify({
        parsed: U.parseItems('x{"items":[{"op":"add","name":"n","content":"c"}]}y', 'char-1'),
        dumpLen: U.buildDump([{user:'u1',assistant:'a1'},{user:'u2',assistant:'a2'}]).length,
        err: (function(){ try { U.parseItems('没有 json', ''); return ''; } catch(e){ return e.message; } })()
      });
    })()`),
  );
  check('页面内 parseItems 能解析', pure.parsed.length === 1 && pure.parsed[0].characterId === 'char-1');
  check('页面内 buildDump 有内容', pure.dumpLen > 10, String(pure.dumpLen));
  check('页面内解析失败会报错', pure.err.includes('没按 JSON'), pure.err);

  // ── 2) 内存没留痕时：能用磁盘留档兜底（刷新后仍可整理），否则给人话错误 ──
  // 这一步以前断言"必然报错"，但留档加进来之后前提变了：刷新页面不再等于没料可整理。
  await page.eval(FAKE_JS(FAKE_ADD));
  await page.eval(`window.__DSC_FORGET_TRANSCRIPT__()`);
  const archivedCount = await page.eval(
    `window.__TAURI_INTERNALS__.invoke('chat_recent', { limit: 5 }).then(r => r.length)`,
  );
  const logMark = logLen();
  const denied = JSON.parse(await page.eval(`window.__DSC_EXTRACT__().then(r => JSON.stringify(r))`));
  if (archivedCount > 0) {
    check('内存没留痕 → 用磁盘留档兜底（刷新后仍能整理）', denied.ok === true, JSON.stringify(denied).slice(0, 120));
    check('日志说明了走的是留档', /改用磁盘留档 \d+ 轮/.test(readLogTail(logMark)), '');
  } else {
    check('既没留痕也没留档 → 明确报错', denied.ok === false && denied.error.includes('没有可整理的对话'), denied.error);
  }
  await page.eval(RESTORE_JS);

  // ── 3) 塞一轮对话 + 假 completion，跑完整提取 ───────────────────────
  // 顺手把页面里的 CFG 故意改脏：归属必须以 Rust 的 config 为准，
  // 不能信页面里那份推过来的副本（过期会把记忆挂到换掉的角色名下）
  await page.eval(`(function(){
    var c = window.__DSC_CFG__();
    window.__DSC_STALE_BACKUP__ = c;
    var stale = JSON.parse(JSON.stringify(c));
    stale.personaId = 'stale-persona-should-be-ignored';
    stale.personaName = '过期角色';
    window.__DSC_SET_CONFIG__(stale);
    return true;
  })()`);
  const staleSeen = await page.eval(`window.__DSC_CFG__().personaId`);
  check('页面 CFG 已被故意改脏（用于验归属不看过期副本）', staleSeen === 'stale-persona-should-be-ignored', staleSeen);

  const seeded = await page.eval(
    `window.__DSC_REMEMBER_TURN__(${JSON.stringify(SESSION)}, '我家的猫叫咪咪，特别怕生', '喵~ 咪咪听起来好可爱。主人平时几点睡呀？')`,
  );
  check('留痕塞进去了', seeded === 1, String(seeded));

  const before = logLen();
  // 会话链状态：这一版 ask() 会读它、也会写它。给一份确定的假状态，
  // 免得断言依赖"主人那条真实会话现在长什么样"；收尾会原样还原。
  await page.eval(
    `localStorage.setItem('dsc-chain-memory', JSON.stringify({ sessionId: 'memory-session-probe', lastMessageId: 7, turns: 3 }))`,
  );
  await page.eval(FAKE_JS(FAKE_ADD));
  const first = JSON.parse(await page.eval(`window.__DSC_EXTRACT__().then(r => JSON.stringify(r))`));
  const fake = JSON.parse(await page.eval(`JSON.stringify(window.__DSC_FAKE__)`));

  check('整理成功', first.ok === true, JSON.stringify(first));
  check('挑中的是会话（不是 URL 里的）', first.sessionId === SESSION, first.sessionId);
  check('复用隐藏会话', fake.sessionId === 'memory-session-probe', fake.sessionId);
  check(
    '接着上一条往下写（parent = 链上那条消息，不再从根发）',
    fake.parent === '7',
    fake.parent,
  );
  check('发了 1 次请求', fake.calls === 1, String(fake.calls));
  const chainAfter = JSON.parse(
    await page.eval(`localStorage.getItem('dsc-chain-memory') || 'null'`),
  );
  check(
    '链状态推进（新 id = 模型回复的消息 id，轮数 +1）',
    !!chainAfter && Number(chainAfter.lastMessageId) === 8 && Number(chainAfter.turns) === 4,
    JSON.stringify(chainAfter),
  );
  check('整理结果里带回消息 id（可追溯）', Number(first.messageId) === 8, String(first.messageId));

  const prompt = fake.prompt || '';
  check('prompt 带整理标记头', prompt.startsWith('【DS Companion 记忆整理】'), prompt.slice(0, 24));
  check('prompt 里有用户原话', prompt.includes('我家的猫叫咪咪'), '');
  check('prompt 里有助手回复', prompt.includes('咪咪听起来好可爱'), '');
  check('prompt 里有纪律（只输出 JSON）', prompt.includes('只输出 JSON'), '');
  check(
    'prompt 明说"忽略上面的历史"（会话是往下接着长的，不写会把老对话重抽一遍）',
    prompt.includes('完全忽略') && prompt.includes('【本次要整理的对话】'),
    prompt.slice(0, 120),
  );
  check('prompt 里有对话双方', prompt.includes('【对话双方】'), '');
  check('prompt 长度可控（<8000 字）', prompt.length < 8000, `${prompt.length} 字`);

  const log1 = readLogTail(before);
  check('日志记下了请求', log1.includes('EXTRACT start session=' + SESSION), '');

  // ── 4) 真的落盘了，且归属/字段正确 ───────────────────────────────────
  const mine = (await inv(listMine)) || [];
  check('两条都落盘', mine.length === 2, JSON.stringify(mine.map((m) => m.name)));
  const cat = mine.find((m) => m.name.includes('猫叫咪咪'));
  const sleepRec = mine.find((m) => m.name.includes('作息'));
  check('内容写进去了', !!cat && cat.content === '主人养了一只叫咪咪的猫', cat && cat.content);
  check('触发词写进去了', !!cat && cat.keys.join('/') === '猫/咪咪', cat && cat.keys.join('/'));
  check('重要度写进去了', !!cat && cat.importance === 4, String(cat && cat.importance));
  check('缺重要度的那条用默认 3', !!sleepRec && sleepRec.importance === 3, String(sleepRec && sleepRec.importance));
  check('来路标成 extract（界面靠它回答"这条哪来的"）', !!cat && cat.source === 'extract', cat && cat.source);
  // 手写一条对照：界面不传 source → 落盘算 manual
  const manual = await inv(
    `window.__TAURI__.core.invoke('memory_save', { item: { id: '', characterId: '', name: ${JSON.stringify(
      MARK + '-手写',
    )}, content: '主人手写的', keys: [], importance: 3, pinned: false, source: '', createdAt: 0, lastAccessedAt: 0, accessCount: 0 } })`,
  );
  check('手写记忆来路标 manual', !!manual && manual.source === 'manual', manual && manual.source);
  const wantChar = JSON.parse(
    await inv(`window.__TAURI__.core.invoke('config_get').then(c => JSON.stringify(c.activePersona || ''))`),
  );
  check(
    `归属 = Rust 里的当前角色（${wantChar || '无 → 全局'}），不是页面里的过期副本`,
    !!cat && cat.characterId === wantChar,
    cat && JSON.stringify(cat.characterId),
  );
  // 用完把页面 CFG 还回去（不然真机上会留个假角色）
  await page.eval(`(function(){
    if (window.__DSC_STALE_BACKUP__) window.__DSC_SET_CONFIG__(window.__DSC_STALE_BACKUP__);
    window.__DSC_STALE_BACKUP__ = null;
    return true;
  })()`);

  // ── 5) 再跑一次：同名 → update，绝不造重复 ──────────────────────────
  await page.eval(`window.__DSC_FAKE__ = null`);
  await page.eval(FAKE_JS(FAKE_UPDATE));
  const second = JSON.parse(await page.eval(`window.__DSC_EXTRACT__().then(r => JSON.stringify(r))`));
  check('第二轮成功', second.ok === true, JSON.stringify(second));
  const mine2 = (await inv(listMine)) || [];
  // 只数"整理产物"的条数：库里还有一条手写对照，用总数断言会假红（踩过一次）
  const countOf = (list, needle) => list.filter((m) => m.name.includes(needle)).length;
  check('没有造出重复条目', countOf(mine2, '猫叫咪咪') === 1 && countOf(mine2, '作息') === 1, JSON.stringify(mine2.map((m) => m.name)));
  const cat2 = mine2.find((m) => m.name.includes('猫叫咪咪'));
  check('内容是更新后的', !!cat2 && cat2.content.includes('白猫'), cat2 && cat2.content);
  check('触发词被更新', !!cat2 && cat2.keys.join('/') === '猫/咪咪/白猫', cat2 && cat2.keys.join('/'));
  check('重要度没被静默降级（缺字段保留旧值 4）', !!cat2 && cat2.importance === 4, String(cat2 && cat2.importance));
  check('createdAt 保留（不是新建）', !!cat2 && !!cat && cat2.createdAt === cat.createdAt, `${cat2 && cat2.createdAt} vs ${cat && cat.createdAt}`);
  check('Rust 侧记成 update 不是 add', second.added === 0 && second.updated >= 1, JSON.stringify(second));

  // ── 6) 模型不按 JSON 回：要报错，不能静默当成功 ──────────────────────
  await page.eval(FAKE_JS(FAKE_PROSE));
  const third = JSON.parse(await page.eval(`window.__DSC_EXTRACT__().then(r => JSON.stringify(r))`));
  check('散文回复 → 失败', third.ok === false, JSON.stringify(third));
  check('失败原因能看懂', String(third.error).includes('没按 JSON'), third.error);
  const mine3 = (await inv(listMine)) || [];
  check('失败时没有脏写', countOf(mine3, '猫叫咪咪') === 1 && countOf(mine3, '作息') === 1, JSON.stringify(mine3.map((m) => m.name)));

  // ── 7) 还原真通道（连真的那个都没被换成假货才算真的还原了） ─────────
  await page.eval(RESTORE_JS);
  const restored = JSON.parse(
    await page.eval(`JSON.stringify({
      hasReal: !!window.__DSC_DS_REAL__,
      fake: window.__DSC_FAKE__,
      // 用"能不能读到登录 token"当真的判据：假货的 readToken 也是真的（Object.assign 抄的），
      // 所以再加一条 —— 真 completion 的源码里必然有 powHeader 的痕迹
      realSource: String(window.__DSC_DS_UTIL__.completion).includes('powHeader')
    })`),
  );
  check('假通道已还原（还原后是真 completion）', restored.realSource === true, JSON.stringify(restored));
  check('临时标记已清空', restored.hasReal === false && !restored.fake, JSON.stringify(restored));

  // ── 8) 设置窗口的按钮与事件（真点一次，走 memory_extract → eval → 页面 → 事件） ──
  await settings.eval(`(function(){
    window.__DSC_PROBE__ = [];
    if (!window.__DSC_PROBE_BOUND__) {
      window.__DSC_PROBE_BOUND__ = true;
      window.__TAURI__.event.listen('dsc:memory-ingest', function(e){ window.__DSC_PROBE__.push(e.payload); });
    }
    return true;
  })()`);
  // 【前提变了】现在内存里没留痕时会用磁盘留档兜底（刷新后仍能整理），
  // 所以"点一下必然失败"不再成立。这里的失败路径改成：让模型回一段散文，
  // 走"没按 JSON 回"那条错误（同样不花额度）—— 假通道换掉即可。
  await page.eval(FAKE_JS(FAKE_PROSE));
  await page.eval(`window.__DSC_FORGET_TRANSCRIPT__()`);
  // 在同一次 eval 里点完立刻读状态：失败路径回来得非常快（<400ms），
  // 隔一会儿再读就已经复位了 —— 那样读到的是"没进入过 busy"，是假红
  const rightAfterClick = JSON.parse(
    await settings.eval(`(function(){
      var b = document.getElementById('mem-extract');
      b.click();
      return JSON.stringify({ label: b.textContent, disabled: b.disabled });
    })()`),
  );
  check(
    '点下去立刻进入「整理中…」',
    rightAfterClick.label.includes('整理中') && rightAfterClick.disabled === true,
    JSON.stringify(rightAfterClick),
  );

  let probe = [];
  for (let i = 0; i < 40 && probe.length === 0; i++) {
    await sleep(250);
    probe = JSON.parse(await settings.eval(`JSON.stringify(window.__DSC_PROBE__)`));
  }
  check('设置窗口收到了结果事件', probe.length >= 1, `收到 ${probe.length} 条`);
  check('事件里带失败原因', probe.length > 0 && !!probe[0].error, probe.length ? String(probe[0].error) : '');
  check('事件里 ok=false', probe.length > 0 && probe[0].ok === false, JSON.stringify(probe[0] || null));

  const after = JSON.parse(
    await settings.eval(`JSON.stringify({
      label: document.getElementById('mem-extract').textContent,
      disabled: document.getElementById('mem-extract').disabled,
      hint: document.getElementById('mem-extract-hint').textContent,
      busyDot: document.getElementById('mem-dot').classList.contains('busy')
    })`),
  );
  check('按钮恢复可用', after.disabled === false && after.label.includes('立即整理'), JSON.stringify(after));
  check('呼吸灯停了', after.busyDot === false, String(after.busyDot));
  check('界面显示了失败原因', after.hint.includes('整理失败'), after.hint);

  // ── 9) 失败事件也要推回列表（列表刷新不报错） ────────────────────────
  check('整理失败的提示里提到原因', /没有可整理的对话|没按 JSON/.test(after.hint), after.hint);

  // ── 10) 自动整理：开着才花额度，关着一分不花 ─────────────────────────
  // 这是唯一一个"不点也会花钱"的开关，两种状态都要验到。
  // 【铁律】验收不许改主人的磁盘配置：页面侧的 CFG 用 __DSC_SET_CONFIG__ 推，
  // 只有 UI 往返那一次碰真配置，而且点回原值。
  const cfgNow = JSON.parse(await inv(`window.__TAURI__.core.invoke('config_get').then(c => JSON.stringify(c))`));
  const origAuto = Number(cfgNow.extractEveryTurns || 0);

  // 10a) 界面上的「自动整理」分段控件：真的写进 config.json
  await settings.eval(`document.querySelector('#mem-auto button[data-v="10"]').click()`);
  await sleep(400);
  const autoSaved = await inv(`window.__TAURI__.core.invoke('config_get').then(c => c.extractEveryTurns)`);
  check('界面上开自动整理会写进配置', autoSaved === 10, String(autoSaved));
  const autoLabel = await settings.eval(`document.getElementById('mem-status').textContent`);
  check('状态行里写明了自动整理的节奏', /每 10 轮自动整理/.test(autoLabel), autoLabel);
  const autoHint = await settings.eval(`document.getElementById('mem-hint').textContent`);
  check('提示写清了关着就不花额度', /自动整理关闭|自动整理已开/.test(autoHint), autoHint);
  // 点回原值（主人的配置不留痕）
  await settings.eval(`document.querySelector('#mem-auto button[data-v="${origAuto}"]').click()`);
  await sleep(400);
  const autoBack = await inv(`window.__TAURI__.core.invoke('config_get').then(c => c.extractEveryTurns)`);
  check('点回原值，主人的配置没被改', Number(autoBack || 0) === origAuto, `${autoSaved} → ${autoBack}`);

  // 10b) 页面侧的自动触发：只改页面 CFG，不碰磁盘
  const pageSetAuto = async (n) => {
    await page.eval(
      `window.__DSC_SET_CONFIG__(Object.assign({}, window.__DSC_CFG__(), { extractEveryTurns: ${n} }))`,
    );
    const seen = await page.eval(`(window.__DSC_CFG__() || {}).extractEveryTurns`);
    return Number(seen) === n;
  };
  check('能把自动整理推到页面上（1 轮，验收用）', (await pageSetAuto(1)) === true);

  await page.eval(`window.__DSC_FORGET_TRANSCRIPT__()`);
  await page.eval(`window.__DSC_MARK_EXTRACTED__()`);
  const runsBefore = await page.eval(`(window.__DSC_EXTRACT_STATE__ || {}).runs || 0`);
  await page.eval(FAKE_JS(FAKE_ADD));
  const seededAuto = await page.eval(
    `window.__DSC_REMEMBER_TURN__('auto-extract-session', '顺便说一句，我家猫叫咪咪', '喵~ 记下了，咪咪。')`,
  );
  check('自动整理：塞进去一轮对话', seededAuto === 1, String(seededAuto));

  let autoState = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    autoState = await page.eval(`JSON.stringify(window.__DSC_EXTRACT_STATE__ || {})`);
    if (JSON.parse(autoState).runs > runsBefore) break;
  }
  const st = JSON.parse(autoState || '{}');
  check('攒够轮数就自己整理了（不用点按钮）', st.runs > runsBefore, `runs ${runsBefore} → ${st.runs}`);
  check('自动整理也成功', !!(st.last && st.last.ok), JSON.stringify(st.last || null));
  check('自动整理挑的是刚聊完的那个会话', (st.last || {}).sessionId === 'auto-extract-session', (st.last || {}).sessionId);
  const pendingAfter = await page.eval(`window.__DSC_PENDING_TURNS__()`);
  check('整理完把攒的轮数清零', pendingAfter === 0, String(pendingAfter));

  // 关回去：再给一轮对话也不该花额度
  check('能把自动整理关回页面上', (await pageSetAuto(0)) === true);
  await page.eval(`window.__DSC_FAKE__ = null`);
  const runsOff = await page.eval(`(window.__DSC_EXTRACT_STATE__ || {}).runs || 0`);
  await page.eval(`window.__DSC_REMEMBER_TURN__('auto-extract-session', '再聊一句', '好的~')`);
  await sleep(1200);
  const runsAfterOff = await page.eval(`(window.__DSC_EXTRACT_STATE__ || {}).runs || 0`);
  check('关掉后不再自动花钱（runs 不动）', runsAfterOff === runsOff, `${runsOff} → ${runsAfterOff}`);
  const pendingOff = await page.eval(`window.__DSC_PENDING_TURNS__()`);
  check('关掉后只是在攒轮数', pendingOff >= 1, String(pendingOff));

  // 攒够了要在角标上提醒（提醒本身不花钱）
  for (let i = 0; i < 10; i++) {
    await page.eval(`window.__DSC_REMEMBER_TURN__('auto-extract-session', 'q${i}', 'a${i}')`);
  }
  const badge = await page.eval(`window.__DSC_BADGE_TEXT__()`);
  check('攒够 10 轮后角标提示待整理', /待整理/.test(badge) && /1[0-9] 轮/.test(badge), badge);

  // 还原：假通道、攒的轮数、页面 CFG（只回滚我们改过的那一个字段 ——
  // 别拿 dsc_get_config 去重建整份载荷，那个命令是页面专用的，设置窗口调会被 ACL 拒）
  await page.eval(RESTORE_JS);
  await page.eval(`window.__DSC_MARK_EXTRACTED__()`);
  await page.eval(`window.__DSC_FORGET_TRANSCRIPT__()`);
  await page.eval(
    `window.__DSC_SET_CONFIG__(Object.assign({}, window.__DSC_CFG__(), { extractEveryTurns: ${origAuto} }))`,
  );
  const badgeClean = await page.eval(`window.__DSC_BADGE_TEXT__()`);
  check('还原后角标不再提示待整理', !/待整理/.test(badgeClean), badgeClean);

  // 10c) 读-改-写：别处改了配置，界面上的单字段开关不许把它回滚
  // （实测踩过：设置窗口那份过期快照被整份提交，把主人刚选的「露娜/每轮」打回去了）
  const cfg10c = JSON.parse(await inv(`window.__TAURI__.core.invoke('config_get').then(c => JSON.stringify(c))`));
  const sentinel = 'cfg-sentinel-should-survive';
  await inv(
    `window.__TAURI__.core.invoke('config_set', { cfg: Object.assign({}, ${JSON.stringify(
      cfg10c,
    )}, { activePersona: ${JSON.stringify(sentinel)} }) })`,
  );
  await sleep(300);
  // 设置窗口这会儿还拿着旧快照渲染；点一下记忆总开关（它以前会整份提交）
  await settings.eval(`document.querySelector('.tb-tab[data-tab="memory"]').click()`);
  await sleep(200);
  await settings.eval(`document.getElementById('mem-enabled').click()`);
  await sleep(600);
  const afterToggle = JSON.parse(
    await inv(`window.__TAURI__.core.invoke('config_get').then(c => JSON.stringify(c))`),
  );
  check(
    '界面单字段开关不会把别处改的配置回滚（读-改-写）',
    afterToggle.activePersona === sentinel,
    `activePersona=${afterToggle.activePersona}`,
  );
  check(
    '开关本身也确实生效了',
    afterToggle.memoryEnabled === (cfg10c.memoryEnabled === false ? true : false),
    JSON.stringify({ was: cfg10c.memoryEnabled, now: afterToggle.memoryEnabled }),
  );
  // 点回去 + 把配置还原（sentinel → 原值），然后刷新设置窗口让它拿新快照
  await settings.eval(`document.getElementById('mem-enabled').click()`);
  await sleep(400);
  await inv(`window.__TAURI__.core.invoke('config_set', { cfg: ${JSON.stringify(cfg10c)} })`);
  await settings.eval(`location.reload()`);
  await sleep(1500);
  const cfgRestored = JSON.parse(
    await inv(`window.__TAURI__.core.invoke('config_get').then(c => JSON.stringify(c))`),
  );
  check(
    '配置完全还原（人设/节奏/预算/自动整理/会话接续都对得上）',
    cfgRestored.activePersona === cfg10c.activePersona &&
      cfgRestored.cadence === cfg10c.cadence &&
      cfgRestored.memoryBudget === cfg10c.memoryBudget &&
      Number(cfgRestored.extractEveryTurns || 0) === Number(cfg10c.extractEveryTurns || 0) &&
      Number(cfgRestored.hiddenChainTurns ?? 20) === Number(cfg10c.hiddenChainTurns ?? 20),
    JSON.stringify(cfgRestored),
  );

  // 收尾：清掉验收数据，恢复主人的记忆库
  for (const m of (await inv(listMine)) || []) {
    await inv(`window.__TAURI__.core.invoke('memory_delete', { id: ${JSON.stringify(m.id)} })`);
  }
  const left = (await inv(listMine)) || [];
  check('验收数据已清理', left.length === 0, JSON.stringify(left.map((m) => m.name)));
  await page.eval(`window.__DSC_FORGET_TRANSCRIPT__()`);
  // 会话链 / 隐藏会话 id 还原（含"本来就没有"的情况）——
  // 不还原的话下次真整理会打到一个只在测试里存在的假会话
  let chainOk = true;
  for (const k of CHAIN_KEYS) {
    if (chainSaved[k] === null || chainSaved[k] === undefined) {
      await page.eval(`localStorage.removeItem(${JSON.stringify(k)})`);
    } else {
      await page.eval(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(chainSaved[k])})`);
    }
    const back = await page.eval(`localStorage.getItem(${JSON.stringify(k)})`);
    const want = chainSaved[k] === undefined ? null : chainSaved[k];
    if ((back === null ? null : String(back)) !== want) {
      chainOk = false;
      console.log(`   ⚠ ${k} 没还原：${String(back)} ≠ ${String(want)}`);
    }
  }
  check('会话链 / 隐藏会话状态已还原', chainOk, '');
  // 界面复位到人设页：给别的脚本一个干净起点（隐藏页里的元素量出来是 0px）
  await settings.eval(`document.querySelector('.tb-tab[data-tab="persona"]').click()`);

  page.close();
  settings.close();
  console.log(`\n${failed ? `✗ ${failed} 项失败` : '✓ 全部通过'}`);
  process.exit(failed ? 1 : 0);
};

main().catch((e) => {
  console.error('验收脚本自己炸了：', e);
  process.exit(2);
});
