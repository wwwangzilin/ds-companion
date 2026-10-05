/* 用对话同步设置 —— 端到端验收。
 *
 * 【这个脚本会真的发一条消息】它建一个 DeepSeek 对话、把设置包发进去，再从服务器
 * 读回来。所以必须跑在**隔离数据目录**上（包里只有默认配置 + 空人设/状态/记忆，
 * 两三 KB，成本可忽略）—— 门禁在下面，跑在真数据上会直接拒绝执行。
 *
 * 【两条命门必须验到】
 *   ① 读回来的正文能不能解析出包 —— history_messages 的形状是别人家接口的私有结构，
 *      contentText 认错一步就变成"什么都没读到"，而界面只会说一句"没找到包"。
 *   ② 不是包的东西必须**拒收** —— 导错一次就是把配置清了，这条比成功路径更重要。
 *
 * 用法（PowerShell，先停真实例 —— 单实例锁）：
 *   $env:DSC_DATA_DIR="$env:TEMP\dsc-verify-sync"
 *   Remove-Item -Recurse -Force $env:DSC_DATA_DIR -ErrorAction SilentlyContinue
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   .\src-tauri\target\debug\ds-companion.exe
 *   node .verify/verify-sync.mjs
 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
process.env.DSC_CDP = BASE;
const { requireIsolation } = await import('./_env.mjs');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('CDP 超时 ' + method));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
      }, 50);
      if (m.error) {
        reject(new Error(JSON.stringify(m.error)));
        return;
      }
      resolve(m.result);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP 连接失败'));
    };
  });
}

async function evalIn(target, expression, timeoutMs) {
  const r = await send(
    target,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r && r.result ? r.result.value : undefined;
}

async function findTarget(match, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(`${BASE}/json/list`)).json();
      const t = list.find((x) => x.url && x.url.includes(match));
      if (t) return t;
    } catch {
      /* 还没起 */
    }
    if (Date.now() > deadline) throw new Error(`等不到窗口：${match}`);
    await sleep(300);
  }
}

/** 等页面上的注入脚本就绪（导航之后要重新等一次） */
async function waitInject(target, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await evalIn(target, `typeof window.__DSC_SYNC__ === 'function'`)) === true) return true;
    } catch {
      /* 页面还在换 */
    }
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
}

// ── 起页面 ──────────────────────────────────────────────────────────
console.log(`[cdp] ${BASE}`);
let main = await findTarget('deepseek.com', 45000);
console.log(`[target] main = ${main.url.slice(0, 60)}`);
await evalIn(main, `window.__TAURI_INTERNALS__.invoke('open_settings').then(()=>1).catch(e=>String(e))`);
await findTarget('settings.html', 25000);
await requireIsolation();
check('注入脚本就绪', await waitInject(main));

// ── 面板本身 ────────────────────────────────────────────────────────
let st = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_SYNC__())`));
check('同步按钮挂上了', st.mounted === true, JSON.stringify(st).slice(0, 160));
check('页面拿到了发消息通道（completion）', st.hasCompletion === true);
check('页面拿到了读对话通道（historyMessages）', st.hasHistory === true);
check('★ 默认不跳过确认（导出必须问一句才发）', st.autoConfirm === false);

const shown = await evalIn(
  main,
  `(() => { window.__DSC_SYNC_PANEL__(true); const p = document.getElementById('dsc-sync-panel');
     return JSON.stringify({ display: p.style.display, w: Math.round(p.getBoundingClientRect().width),
       buttons: p.querySelectorAll('button').length, hasNote: !!document.getElementById('dsc-sync-note') }); })()`,
);
const sp = JSON.parse(shown);
check('面板能打开且有导出/导入两个按钮', sp.display === 'block' && sp.buttons === 2 && sp.hasNote, shown);

// ── 打包（纯本地，零成本） ──────────────────────────────────────────
const pack = JSON.parse(
  await evalIn(
    main,
    `window.__TAURI_INTERNALS__.invoke('dsc_sync_pack', { at: '2026-10-05 22:00' })
       .then(v => JSON.stringify({ bytes: v.bytes, personas: v.personas, states: v.states, memories: v.memories,
         avatars: v.avatars, opens: v.text.indexOf('【DS-COMPANION-SYNC 1】'), closes: v.text.indexOf('【/DS-COMPANION-SYNC】') }))
       .catch(e => JSON.stringify({ err: String(e) }))`,
  ),
);
check('打包成功', !pack.err && pack.bytes > 20, JSON.stringify(pack).slice(0, 180));
check('包带信封（导入端靠它抠包）', pack.opens === 0 && pack.closes > 0, `opens=${pack.opens} closes=${pack.closes}`);

// ── 真发一次（隔离目录里包只有几 KB） ───────────────────────────────
await evalIn(main, `window.__DSC_SYNC_AUTOCONFIRM__(true)`);
const t0 = Date.now();
await evalIn(main, `window.__DSC_SYNC_EXPORT__()`, 120000);
const sentMs = Date.now() - t0;
st = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_SYNC__())`));
check('★ 导出跑通（真发了一条消息）', /导出好了/.test(st.note || ''), `${st.note}（${sentMs}ms）`);

const sid = await evalIn(main, `localStorage.getItem('dsc-sync-session') || ''`);
check('新建了一个对话（id 落进 localStorage）', !!sid && String(sid).length > 10, String(sid));

// ── ★ 命门①：把包从服务器读回来（零额度，不走页面） ─────────────────
const read = JSON.parse(
  await evalIn(
    main,
    `window.__DSC_DS_UTIL__.historyMessages('${sid}')
       .then(ms => {
         const hits = ms.filter(m => String(m.text || '').indexOf('【DS-COMPANION-SYNC 1】') >= 0);
         return JSON.stringify({ total: ms.length, hits: hits.length,
           roles: ms.map(m => String(m.role).slice(0, 4)).join(','),
           pickLen: hits.length ? hits[0].text.length : 0,
           hasClose: hits.length ? hits[0].text.indexOf('【/DS-COMPANION-SYNC】') > 0 : false });
       })
       .catch(e => JSON.stringify({ err: String(e) }))`,
    60000,
  ),
);
check(
  '★ 能从服务器把包读回来（正文解析没认错形状）',
  !read.err && read.hits >= 1 && read.hasClose === true,
  JSON.stringify(read).slice(0, 220),
);

// ── ★ 命门②：不是包的东西必须拒收 ───────────────────────────────────
const bad = await evalIn(
  main,
  `window.__TAURI_INTERNALS__.invoke('dsc_sync_apply', { text: '这段话里没有包，随便写的' })
     .then(() => 'accepted').catch(e => 'rejected:' + String(e))`,
);
check('★ 不是包就拒收（导错一次等于清配置）', String(bad).startsWith('rejected'), String(bad).slice(0, 140));

const older = await evalIn(
  main,
  `window.__TAURI_INTERNALS__.invoke('dsc_sync_apply', { text: '【DS-COMPANION-SYNC 1】\\n{"v":99,"at":"x","config":null,"personas":[],"states":[],"memories":[],"avatars":[]}\\n【/DS-COMPANION-SYNC】' })
     .then(() => 'accepted').catch(e => 'rejected:' + String(e))`,
);
check('更新版本的包被挡住（提示先升级）', String(older).includes('更新版本'), String(older).slice(0, 140));

// ── 走真实路径导入：跳到那个对话，再点导入 ──────────────────────────
await send(main, 'Page.navigate', { url: `https://chat.deepseek.com/a/chat/s/${sid}` });
await sleep(1500);
main = await findTarget('deepseek.com', 45000);
check('回到注入就绪（导航后脚本重挂）', await waitInject(main));

const cur = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_SYNC__())`));
check('页面认出当前对话就是那个备份对话', cur.sessionId === String(sid), `${cur.sessionId} vs ${sid}`);

await evalIn(main, `window.__DSC_SYNC_AUTOCONFIRM__(true)`);
await evalIn(main, `window.__DSC_SYNC_IMPORT__()`, 120000);
const after = JSON.parse(await evalIn(main, `JSON.stringify(window.__DSC_SYNC__())`));
check('★ 导入跑通（读对话 → 落盘）', /导入完成/.test(after.note || ''), after.note);
check('导入报告里给出记忆的并入/跳过数', /记忆 \+\d+/.test(after.note || ''), after.note);

// ── 落盘真的发生了（隔离目录里看得到备份目录） ──────────────────────
const dataDir = process.env.DSC_DATA_DIR || '';
if (dataDir) {
  const { existsSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const cfg = join(dataDir, 'config.json');
  check('导入后 config.json 真的被写了', existsSync(cfg), cfg);
  // 首次导入时磁盘上还没有可覆盖的东西（backed=0 就不建备份目录）—— 正常。
  // 真正要验的是"有东西可覆盖时会留备份"，所以再导入一次。
  await evalIn(main, `window.__DSC_SYNC_IMPORT__()`, 120000);
  const bk = join(dataDir, 'sync-backup');
  check('再导入一次时留了备份（这回有东西可覆盖了）', existsSync(bk), existsSync(bk) ? readdirSync(bk).join(',') : '(没有)');
} else {
  check('能定位隔离数据目录', false, 'DSC_DATA_DIR 没传进来');
}

// ── 收尾：把「跳过确认」关回去，别让它留着 ──────────────────────────
await evalIn(main, `window.__DSC_SYNC_PANEL__(false)`);
const off = await evalIn(main, `window.__DSC_SYNC_AUTOCONFIRM__(false)`);
check('收尾把自动确认关掉了', off === false);

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
