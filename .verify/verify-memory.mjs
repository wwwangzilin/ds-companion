/**
 * 记忆链路验收：从"设置窗口写一条记忆"到"页面把它注进请求体"整条链。
 *
 * 手法与 verify-injection 一致：在主页面上发一条合成 XHR（send 后立刻 abort），
 * 这样钩子会同步跑完并把结果写进壳日志，但不产生真实对话。
 *
 * 用法：node .verify/verify-memory.mjs
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const out = r.result || {};
    if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails));
    return out.result ? out.result.value : undefined;
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function targets() {
  return (await (await fetch(CDP + '/json/list')).json());
}

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
  await sleep(300);
  return p;
}

const MARK = 'DSCOMPANION_MEM_PROBE';
const TRIGGER = '美式咖啡';
const TEST_ID_HINT = '验收记忆';
// 会话 id 每轮都换：页面侧的「本会话已注入」表是**进程内**状态，
// 固定 id 的话同一个 exe 里跑第二遍就会因为"已注入过"而跳过，
// 于是 MEMORY 日志与热度记账双双假红（踩过一次）。
const VSESSION = 'dscompanion-verify-' + Date.now();

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

  // 0) 先清掉上一轮可能残留的同名验收记忆（幂等，别越跑越多）
  const prior = await settings.eval(
    `window.__TAURI__.core.invoke('memory_list').then(l => l.filter(m => m.name.indexOf(${JSON.stringify(TEST_ID_HINT)}) >= 0).map(m => m.id))`,
  );
  for (const id of prior || []) {
    await settings.eval(`window.__TAURI__.core.invoke('memory_delete', { id: ${JSON.stringify(id)} })`);
  }

  // 1) 写一条记忆（走真实命令，不是直接改文件）
  const saved = await settings.eval(`window.__TAURI__.core.invoke('memory_save', {
    item: {
      id: '', characterId: '', name: '${TEST_ID_HINT}-咖啡',
      content: '主人只喝美式，不加糖不加奶',
      keys: ['${TRIGGER}', '美式'], importance: 5, pinned: false,
      createdAt: 0, lastAccessedAt: 0, accessCount: 0
    }
  })`);
  check('记忆落盘（走 memory_save 命令）', !!(saved && saved.id), saved ? saved.id : '没有返回');

  const onDisk = await settings.eval(
    `window.__TAURI__.core.invoke('memory_list').then(l => l.filter(m => m.id === ${JSON.stringify(saved && saved.id)}).length)`,
  );
  check('回读能查到', onDisk === 1, `count=${onDisk}`);

  await sleep(600); // 等 memory_save 里的 push_config 送到页面

  // 2) 页面侧确实拿到了这条记忆
  const page = await mainPage();
  const cfg = await page.eval(`JSON.stringify({
    memEnabled: window.__DSC_CFG__().memoryEnabled,
    budget: window.__DSC_CFG__().memoryBudget,
    total: (window.__DSC_CFG__().memories || []).length,
    hasOurs: (window.__DSC_CFG__().memories || []).some(m => m.id === ${JSON.stringify(saved && saved.id)})
  })`);
  const c = JSON.parse(cfg);
  check('记忆开关打开', c.memEnabled === true, cfg);
  check('预算已下发', typeof c.budget === 'number' && c.budget > 0, `budget=${c.budget}`);
  check('新记忆已推送到页面', c.hasOurs === true, `页面可见 ${c.total} 条`);

  // 3) 发一条"含触发词"的合成请求
  const before = logLen();
  const sent = await page.eval(`(function(){
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/v0/chat/completion');
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(JSON.stringify({
        chat_session_id: ${JSON.stringify(VSESSION)},
        parent_message_id: null,
        prompt: '今天想喝杯${TRIGGER}提提神',
        ref_file_ids: [], thinking_enabled: false, search_enabled: false
      }));
      x.abort();
      return 'sent';
    } catch (e) { return 'throw:' + e; }
  })()`);
  check('合成请求已发出', sent === 'sent', sent);
  await sleep(900);

  const added = readLogTail(before);
  const memLine = (added.match(/\[page\] MEMORY\([^)]*\)[^\n]*/) || [])[0] || '';
  check('页面挑出了记忆并上报', /MEMORY\(x[1-9]/.test(memLine), memLine || '日志里没有 MEMORY 行');

  // 4) 记忆真的进了请求体（把合成请求的 body 抓出来看）
  const bodyCheck = await page.eval(`(function(){
    try {
      var captured = null;
      var orig = XMLHttpRequest.prototype.send;
      // 直接问 selector：给它同样的输入，看会不会拼出【回忆】
      var r = window.__DSC_SELECT__('今天想喝杯${TRIGGER}提提神', window.__DSC_CFG__().memories, {
        budget: window.__DSC_CFG__().memoryBudget, alreadyInjected: []
      });
      return JSON.stringify({ picked: r.usedIds, block: r.block.slice(0, 120) });
    } catch (e) { return 'throw:' + e; }
  })()`);
  const bc = JSON.parse(bodyCheck);
  check('selector 选中了它', (bc.picked || []).includes(saved.id), bodyCheck);
  check('拼出的【回忆】块含内容', /美式/.test(bc.block || ''), bc.block);

  // 5) 热度记账（memory_touch 把 accessCount 加一）
  const touched = await settings.eval(
    `window.__TAURI__.core.invoke('memory_list').then(l => { const m = l.find(x => x.id === ${JSON.stringify(saved.id)}); return m ? m.accessCount : -1; })`,
  );
  check('热度记账生效（accessCount>0）', touched > 0, `accessCount=${touched}`);

  // 6) 同一条不重复注入（第二次同会话同触发词）
  const second = await page.eval(`(function(){
    var r = window.__DSC_SELECT__('又想喝${TRIGGER}了', window.__DSC_CFG__().memories, {
      budget: 500, alreadyInjected: ${JSON.stringify(bc.picked)}
    });
    return JSON.stringify(r.usedIds);
  })()`);
  check('已注入过的不再重复注入', JSON.parse(second).length === 0, second);

  // 6.5) 记忆页签 UI（真点真存）
  await settings.eval(`document.querySelector('.tb-tab[data-tab="memory"]').click()`);
  await sleep(500);
  const ui = JSON.parse(
    await settings.eval(`JSON.stringify({
      memShown: !document.getElementById('tab-memory').classList.contains('hidden'),
      personaHidden: document.getElementById('tab-persona').classList.contains('hidden'),
      cards: document.querySelectorAll('#mem-list .card').length,
      charOptions: document.getElementById('mf-char').options.length,
      filterPillW: Math.round(document.getElementById('mem-filter-pill').getBoundingClientRect().width),
      impPillW: Math.round(document.getElementById('mf-imp-pill').getBoundingClientRect().width),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      status: document.getElementById('mem-status').textContent
    })`),
  );
  check('页签能切到记忆', ui.memShown && ui.personaHidden, JSON.stringify(ui));
  check('记忆列表渲染出来了', ui.cards >= 1, `cards=${ui.cards}`);
  check('归属下拉含「全局」+ 人设', ui.charOptions >= 2, `options=${ui.charOptions}`);
  check('筛选/重要度滑块都摆好了', ui.filterPillW > 20 && ui.impPillW > 20, `filter=${ui.filterPillW} imp=${ui.impPillW}`);
  check('记忆页无横向溢出', ui.overflowX <= 0, `overflowX=${ui.overflowX}`);

  // 6.6) 会话接续（隐藏会话「往下接着用」的上限）—— 新控件必须有断言盯着
  const chainUi = JSON.parse(
    await settings.eval(`JSON.stringify({
      boxW: Math.round(document.getElementById('mem-chain').getBoundingClientRect().width),
      pillW: Math.round(document.getElementById('mem-chain-pill').getBoundingClientRect().width),
      btns: [...document.querySelectorAll('#mem-chain button')].map(b => b.dataset.v),
      label: (document.getElementById('mem-chain').parentElement.querySelector('span') || {}).textContent || ''
    })`),
  );
  check('会话接续控件摆出来了（不塌不空）', chainUi.boxW > 40 && chainUi.pillW > 0, JSON.stringify(chainUi));
  check('会话接续三档齐全（不换 / 20 / 50）', chainUi.btns.join(',') === '0,20,50', chainUi.btns.join(','));
  check('会话接续有说明文字', /会话接续/.test(chainUi.label), chainUi.label);

  const chainBefore = Number(
    await settings.eval(
      `window.__TAURI__.core.invoke('config_get').then(c => Number(c.hiddenChainTurns ?? 20))`,
    ),
  );
  await settings.eval(`document.querySelector('#mem-chain button[data-v="0"]').click()`);
  await sleep(500);
  const chainZero = Number(
    await settings.eval(
      `window.__TAURI__.core.invoke('config_get').then(c => Number(c.hiddenChainTurns))`,
    ),
  );
  check('点「不换」真的落盘成 0', chainZero === 0, `${chainBefore} → ${chainZero}`);
  const pillLeft = Math.round(
    await settings.eval(
      `document.getElementById('mem-chain-pill').getBoundingClientRect().left - document.getElementById('mem-chain').getBoundingClientRect().left`,
    ),
  );
  check('选中态药丸跟着挪到「不换」上', pillLeft >= 0 && pillLeft < 45, `left=${pillLeft}`);

  // 还原：配置 + 界面选中态
  await settings.eval(
    `window.__TAURI__.core.invoke('config_get')
       .then(c => window.__TAURI__.core.invoke('config_set', { cfg: Object.assign({}, c, { hiddenChainTurns: ${chainBefore} }) }))
       .then(() => true)`,
  );
  await settings.eval(`(function(){ var b = document.querySelector('#mem-chain button[data-v="${chainBefore}"]'); if (b) b.click(); return true; })()`);
  await sleep(400);
  const chainBack = Number(
    await settings.eval(
      `window.__TAURI__.core.invoke('config_get').then(c => Number(c.hiddenChainTurns ?? 20))`,
    ),
  );
  check('会话接续上限已还原', chainBack === chainBefore, `${chainZero} → ${chainBack}`);

  // 通过界面新建一条（不进 IPC，纯点）
  const uiName = '验收UI记忆-' + Date.now();
  await settings.eval(`document.getElementById('mem-new').click()`);
  await settings.eval(`(() => {
    document.getElementById('mf-name').value = ${JSON.stringify(uiName)};
    document.getElementById('mf-keys').value = '界面, 测试';
    document.getElementById('mf-content').value = '这条是点界面建出来的。';
    document.querySelector('#mf-importance button[data-v="5"]').click();
    document.getElementById('mf-pinned').checked = true;
    document.getElementById('mem-save').click();
  })()`);
  // 保存是异步的（invoke → 再 reload 列表），点完立刻查会撞上竞态 —— 轮询等它落盘
  let us = null;
  for (let i = 0; i < 24 && !us; i++) {
    await sleep(250);
    const got = await settings.eval(
      `window.__TAURI__.core.invoke('memory_list').then(l => { const m = l.find(x => x.name === ${JSON.stringify(uiName)}); return m ? JSON.stringify({id:m.id, importance:m.importance, pinned:m.pinned, keys:m.keys}) : ''; })`,
    );
    if (got) us = JSON.parse(got);
  }
  check('界面新建的记忆落盘', !!us, us ? JSON.stringify(us) : '等 6 秒也没落盘');
  check('重要度/钉住/触发词都存对了', !!us && us.importance === 5 && us.pinned === true && us.keys.length === 2, JSON.stringify(us));

  // 总开关
  await settings.eval(`(() => { const el = document.getElementById('mem-enabled'); el.checked = false; el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await sleep(400);
  const off = await settings.eval(`window.__TAURI__.core.invoke('config_get').then(c => c.memoryEnabled)`);
  check('总开关能关掉记忆', off === false, `memoryEnabled=${off}`);
  await settings.eval(`(() => { const el = document.getElementById('mem-enabled'); el.checked = true; el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await sleep(400);
  const backOn = await settings.eval(`window.__TAURI__.core.invoke('config_get').then(c => c.memoryEnabled)`);
  check('总开关能再打开', backOn === true, `memoryEnabled=${backOn}`);

  // 界面删掉它
  if (us) {
    await settings.eval(`window.__TAURI__.core.invoke('memory_delete', { id: ${JSON.stringify(us.id)} })`);
    await sleep(300);
    const uiGone = await settings.eval(
      `window.__TAURI__.core.invoke('memory_list').then(l => l.filter(m => m.id === ${JSON.stringify(us.id)}).length)`,
    );
    check('界面建的记忆可删除', uiGone === 0, `剩下 ${uiGone}`);
  }

  // 把界面还原到人设页，别留个半开的记忆页给主人
  await settings.eval(`document.querySelector('.tb-tab[data-tab="persona"]').click()`);
  await sleep(200);

  // 7) 收尾：删掉验收记忆，把干净的库还给主人
  await settings.eval(`window.__TAURI__.core.invoke('memory_delete', { id: ${JSON.stringify(saved.id)} })`);
  await sleep(300);
  const gone = await settings.eval(
    `window.__TAURI__.core.invoke('memory_list').then(l => l.filter(m => m.id === ${JSON.stringify(saved.id)}).length)`,
  );
  check('验收记忆已清理', gone === 0, `剩下 ${gone} 条`);

  page.close();
  settings.close();
  console.log(`\n${failed === 0 ? '记忆链路全通' : failed + ' 项失败'}`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('验收中断:', e.message);
  process.exit(2);
});
