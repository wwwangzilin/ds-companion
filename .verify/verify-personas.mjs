/**
 * 人设系统验收：通过 CDP 真点设置界面，断言数据真的落盘。
 *
 * 前置：ds-companion.exe 以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动，
 *       且设置窗口已打开。
 * 用法：node .verify/verify-personas.mjs
 */

// 数据隔离门禁：这个脚本会真写人设、真删人设，跑在主人的真实数据上就是拿他的东西当沙包。
// 用动态 import 是为了不破坏本来"零 import"的写法（见 _env.mjs）。
await (await import('./_env.mjs')).requireIsolation();

const CDP = 'http://127.0.0.1:9222';
const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

class Page {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const slot = this.pending.get(msg.id);
      if (slot) {
        this.pending.delete(msg.id);
        slot(msg);
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
      throw new Error('eval 抛错: ' + JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails));
    }
    return out.result ? out.result.value : undefined;
  }
  async waitFor(expression, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await this.eval(expression);
      if (v) return v;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function findTarget(match) {
  const list = await (await fetch(CDP + '/json/list')).json();
  return list.find((t) => t.url && t.url.includes(match));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 设置窗口没开就借主页面把它叫出来（远程页面有 open_settings 权限）。 */
async function ensureSettingsTarget() {
  let t = await findTarget('settings.html');
  if (t) return t;
  const mainPage = await findTarget('chat.deepseek.com');
  if (!mainPage) throw new Error('既没有设置窗口也没有主页面，exe 没在跑？');
  const p = new Page(mainPage.webSocketDebuggerUrl);
  await p.open();
  await p.eval(`window.__TAURI_INTERNALS__.invoke('open_settings')`);
  p.close();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    t = await findTarget('settings.html');
    if (t) return t;
  }
  throw new Error('open_settings 之后设置窗口仍未出现');
}

const main = async () => {
  const target = await ensureSettingsTarget();
  const page = new Page(target.webSocketDebuggerUrl);
  await page.open();
  // 等脚本就绪（DOM 已有 #list 且初始化完成）
  await page.waitFor(`!!document.getElementById('list') && !!document.querySelector('.rail') && !!document.querySelector('.hero')`, 8000);
  await sleep(400);

  // 先备份主人的配置 —— 这套验收会改激活人设与节奏，跑完必须原样还回去
  // （曾经把主人自己选的「露娜」覆盖成验收用的另一个，还清成 null）
  const cfgBackup = await page.eval(`window.__TAURI__.core.invoke('config_get').then(c => JSON.stringify(c))`);
  const restoreCfg = async () => {
    try {
      await page.eval(
        `window.__TAURI__.core.invoke('config_set', { cfg: ${cfgBackup} }).then(() => true)`,
      );
      console.log(`\n已把配置还原为: ${cfgBackup}`);
    } catch (e) {
      console.log(`\n⚠ 配置还原失败: ${e.message}`);
    }
  };

  // 0) 页面自身没报错、主要区块都在
  const boot = await page.eval(`(() => ({
    title: document.title,
    hasList: !!document.getElementById('list'),
    rail: !!document.querySelector('.rail'),
    content: !!document.querySelector('.content'),
    hero: !!document.querySelector('.hero'),
    editor: !!document.querySelector('.editor'),
    titlebar: !!document.querySelector('.titlebar'),
    status: (document.getElementById('status') || {}).textContent || '',
  }))()`);
  check(
    '设置界面加载',
    boot.hasList && boot.rail && boot.content && boot.hero && boot.editor && boot.titlebar,
    JSON.stringify(boot),
  );

  // 1) 布局不溢出（按主人偏好：界面必须量过）
  // 量几何之前必须先切回「人设」页签：上一支脚本可能把记忆页留在前台，
  // 隐藏的 textarea 量出来是 0px —— 那是脚本没复位，不是界面坏了（踩过一次）。
  await page.eval(`document.querySelector('.tb-tab[data-tab="persona"]').click()`);
  await sleep(300);

  const layout = await page.eval(`(() => {
    const d = document.documentElement;
    const rail = document.querySelector('.rail').getBoundingClientRect();
    const content = document.querySelector('.content').getBoundingClientRect();
    const pill = document.getElementById('seg-pill');
    const pillR = pill.getBoundingClientRect();
    const segR = document.getElementById('cadence').getBoundingClientRect();
    return {
      overflowX: d.scrollWidth - d.clientWidth,
      overflowY: d.scrollHeight - d.clientHeight,
      railW: Math.round(rail.width),
      contentRight: Math.round(content.right),
      winW: d.clientWidth,
      railBeforeContent: rail.right <= content.left + 1,
      textareaH: Math.round(document.getElementById('f-body').getBoundingClientRect().height),
      pillW: Math.round(pillR.width),
      pillInside: pillR.left >= segR.left - 1 && pillR.right <= segR.right + 1,
    };
  })()`);
  check('无横向溢出', layout.overflowX <= 0, `overflowX=${layout.overflowX}`);
  check('无纵向溢出', layout.overflowY <= 0, `overflowY=${layout.overflowY}`);
  check('右侧内容没伸出窗口', layout.contentRight <= layout.winW, `${layout.contentRight} <= ${layout.winW}`);
  check('左栏在内容左侧', layout.railBeforeContent, `railW=${layout.railW}`);
  check('正文编辑区有高度', layout.textareaH >= 140, `textarea=${layout.textareaH}px`);
  check('分段滑块有宽度且在控件内', layout.pillW > 20 && layout.pillInside, JSON.stringify({ w: layout.pillW, inside: layout.pillInside }));

  // 2) 从 DSH 导入：先开弹窗、断言扫到了 preset
  await page.eval(`document.getElementById('btn-import').click()`);
  const scanned = await page.waitFor(`(() => {
    const rows = document.querySelectorAll('#import-list .card');
    if (!rows.length) return 0;
    return rows.length;
  })()`);
  check('扫到 DSH preset', scanned >= 1, `共 ${scanned} 个`);

  const firstName = await page.eval(`(document.querySelector('#import-list .card .nm')||{}).textContent || ''`);
  check('preset 名字非空', !!firstName, firstName);
  // 卡片上写的是「名字 · N 字」，取名字部分
  const presetName = firstName.split('·')[0].trim();

  // 3) 导入第一个 preset。
  //    按**身份**断言而不是按数量：同一个 preset 重复导入是覆盖同 id，
  //    列表数量不会涨 —— 用数量判会随「之前有没有导过」假红（本脚本踩过一次）。
  await page.eval(`document.querySelector('#import-list .card .btn').click()`);
  const imported = await page.waitFor(
    `window.__TAURI__.core.invoke('persona_list').then(l => {
       const p = l.find(x => x.name === ${JSON.stringify(presetName)} && String(x.source||'').startsWith('dsh:'));
       return p ? { id: p.id, name: p.name, chars: (p.body||'').length } : 0;
     })`,
    8000,
  );
  check('导入后库里确实有这个 preset', !!imported, imported ? `${imported.id} / ${imported.chars} 字` : `未找到 ${presetName}`);

  const inList = await page.waitFor(
    `(() => {
       const cards = [...document.querySelectorAll('#list .card .nm')].map(n => n.textContent.trim());
       return cards.includes(${JSON.stringify(presetName)}) ? cards.length : 0;
     })()`,
    4000,
  );
  check('左栏列表里也显示了它', !!inList, `共 ${inList} 张卡`);

  // 弹窗自己关掉，回到主界面
  await page.eval(`document.getElementById('import-mask').classList.add('hidden')`);

  // 4) 激活它 → 配置落盘（直接问壳，别只信界面）
  const activeId = await page.eval(`(() => {
    const sel = document.getElementById('active');
    const opt = Array.from(sel.options).find(o => o.value);
    if (!opt) return '';
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return opt.value;
  })()`);
  await sleep(400);
  const cfg = await page.eval(`window.__TAURI__.core.invoke('config_get')`);
  check('激活写入 config.json', cfg && cfg.activePersona === activeId, JSON.stringify(cfg));
  // 只断言"激活没有顺手改掉节奏" —— 断言节奏等于 first 是状态相关的：
  // 主人把节奏调成「每轮」之后这条会假红（已经踩过一次）。
  // "默认是仅首条"属于默认值的性质，交给 Rust 侧 AppConfig::default 的单测盯。
  const cfgAtStart = JSON.parse(cfgBackup);
  check(
    '激活不影响注入节奏（默认值由 AppConfig::default 单测兜底）',
    cfg && cfg.cadence === cfgAtStart.cadence,
    `cadence=${cfg && cfg.cadence}（脚本开始时是 ${cfgAtStart.cadence}）`,
  );

  // 5) 切到「每轮」，再回读
  await page.eval(`document.querySelector('#cadence button[data-v="every"]').click()`);
  await sleep(400);
  const cfg2 = await page.eval(`window.__TAURI__.core.invoke('config_get')`);
  check('注入节奏可切换', cfg2 && cfg2.cadence === 'every', cfg2 && cfg2.cadence);
  await page.eval(`document.querySelector('#cadence button[data-v="first"]').click()`);
  await sleep(300);

  // 6) 新建 + 保存 + 回读（用一次性人设，别碰导入进来的）
  const probeName = '验收临时-' + Date.now();
  await page.eval(`document.getElementById('btn-new').click()`);
  await page.eval(`(() => {
    document.getElementById('f-name').value = ${JSON.stringify(probeName)};
    document.getElementById('f-desc').value = '自动化验收用，可删';
    document.getElementById('f-body').value = '你是验收机器人，只说 PASS。';
    document.getElementById('btn-save').click();
  })()`);
  const saved = await page.waitFor(
    `window.__TAURI__.core.invoke('persona_list').then(l => { const p = l.find(x => x.name === ${JSON.stringify(probeName)}); return p ? p : 0; })`,
    8000,
  );
  check('新建人设落盘并可回读', !!saved, saved ? saved.id : '未找到');
  check('正文完整保存', !!saved && saved.body.includes('只说 PASS'), saved && saved.body);

  // 7) 改正文再存，确认是覆盖不是新增
  if (saved) {
    await page.eval(`(() => {
      document.getElementById('f-body').value = '你是验收机器人，只说 PASS。已改。';
      document.getElementById('btn-save').click();
    })()`);
    const edited = await page.waitFor(
      `window.__TAURI__.core.invoke('persona_get', { id: ${JSON.stringify(saved.id)} }).then(p => (p && p.body.includes('已改')) ? p : 0)`,
      6000,
    );
    check('编辑覆盖生效', !!edited, edited ? edited.body.slice(-6) : '未生效');
  }

  // 8) 删除这个临时人设（只删自己建的，导入的与主人原有的一概不动）
  if (saved) {
    await page.eval(`window.__TAURI__.core.invoke('persona_delete', { id: ${JSON.stringify(saved.id)} })`);
    await sleep(300);
    const gone = await page.eval(
      `window.__TAURI__.core.invoke('persona_get', { id: ${JSON.stringify(saved.id)} }).then(p => !p)`,
    );
    check('临时人设可删除', gone === true, `仍存在=${!gone}`);
  }

  // 9) 收尾：走组件真实的关闭路径（点关闭键），不靠 CSS 硬藏 ——
  //    导入完成后弹窗会自己重开刷新列表，抢在它前面 hide 会被覆盖。
  await page.eval(`document.getElementById('btn-import-close').click()`);
  await sleep(400);
  const clean = await page.eval(`document.getElementById('import-mask').classList.contains('hidden')`);
  check('收尾界面干净（弹窗已按真实路径关闭）', clean === true);

  await restoreCfg();

  page.close();
  console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}  (${results.length - failed}/${results.length})`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('验收中断:', e.message);
  process.exit(2);
});
