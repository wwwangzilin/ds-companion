/* 安静时段 / 每天最多几 —— 端到端验收（隔离数据目录里跑真命令）。
 *
 * 【为什么这几条必须真跑】它们是**闸**：闸错了不是不好用，是"该静的时候不静"或者
 * "额度白白少了几次"。单测能证明 `quiet_now` 的算术（跨零点两个方向、缺一半、越界），
 * 但证明不了三件只有真机才能验的事：
 *   ① 判定接在 `dsc_proactive` 的**哪一步** —— 排在额度后面就会"被拒也扣额度"，
 *      这个错单测抓不到（它是两段代码的先后顺序）；
 *   ② config 那两个新字段过不过得了 IPC 与落盘（camelCase / Option 序列化）；
 *   ③ 界面那两个小输入框存不存得进去、会不会把那一排挤乱。
 *
 * 用法（PowerShell，先停掉真实例 —— 单实例锁）：
 *   $env:DSC_DATA_DIR="$env:TEMP\dsc-verify-quiet"
 *   Remove-Item -Recurse -Force $env:DSC_DATA_DIR -ErrorAction SilentlyContinue
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   .\src-tauri\target\debug\ds-companion.exe
 *   node .verify/verify-proactive-quiet.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
process.env.DSC_CDP = BASE;
const { requireIsolation } = await import('./_env.mjs');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget(match, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(`${BASE}/json/list`)).json();
      const t = list.find((x) => x.url && x.url.includes(match));
      if (t) return t;
    } catch {
      /* 还没起 */
    }
    if (Date.now() > deadline) throw new Error(`等不到窗口：${match}（${BASE}）`);
    await sleep(300);
  }
}

function evalIn(target, expression, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('CDP 超时'));
    }, timeoutMs);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      // 别在 onmessage 里立刻 close：node 的 ws 会在收尾阶段断言崩掉
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
      }, 50);
      if (m.result && m.result.exceptionDetails) {
        reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300)));
        return;
      }
      resolve(m.result && m.result.result ? m.result.result.value : undefined);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP 连接失败'));
    };
  });
}

async function call(page, cmd, args) {
  const expr =
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}` +
    (args ? `, ${JSON.stringify(args)}` : '') +
    `).then(v => JSON.stringify({ ok: 1, v })).catch(e => JSON.stringify({ ok: 0, e: String(e) }))`;
  const out = JSON.parse(await evalIn(page, expr));
  if (!out.ok) throw new Error(`${cmd} 失败：${out.e}`);
  return out.v;
}

/** 当前角色的主动额度账本（直接看盘 —— 比再调一个命令少一层自证） */
function readQuota(root) {
  const dir = join(root, 'state');
  if (!existsSync(dir)) return { day: '', count: 0 };
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (j && (j.proactiveDay !== undefined || j.proactiveCount !== undefined)) {
        return { day: j.proactiveDay || '', count: j.proactiveCount || 0 };
      }
    } catch {
      /* 坏文件跳过，本次验收不关心它 */
    }
  }
  return { day: '', count: 0 };
}

// ── 开跑 ────────────────────────────────────────────────────────────
const page = await findTarget('deepseek.com');
console.log(`[page] ${page.url}`);
await call(page, 'open_settings').catch((e) => console.warn('[warn] open_settings：' + e.message));
const info = await requireIsolation();
const win = await findTarget('settings.html');
const TODAY = await evalIn(page, 'window.__DSC_LOCAL_DAY__()');
console.log(`[day] ${TODAY}`);

async function patchCfg(patch) {
  const cfg = await call(win, 'config_get');
  Object.assign(cfg, patch);
  await call(win, 'config_set', { cfg });
  return cfg;
}

/** 问一次"现在能不能开口"，并把这次前后的额度记下来 */
async function probe(hour, cap = 50) {
  const before = readQuota(info.path);
  const r = await call(page, 'dsc_proactive', { day: TODAY, cap, hour });
  const after = readQuota(info.path);
  return { r, before, after };
}

// ① 默认（没配安静时段）：任何小时都该放行 —— 新旋钮不许偷偷改掉既有行为
await patchCfg({ proactiveMode: 'local', proactiveDailyCap: 50, proactiveQuietFrom: null, proactiveQuietTo: null });
let p = await probe(3);
check('没配安静时段时凌晨也照常开口', p.r && p.r.ok === true, JSON.stringify(p.r && p.r.reason));
check('放行时额度 +1', p.after.count === p.before.count + 1, `${p.before.count} → ${p.after.count}`);

// ② 配 23 → 8（跨零点）
await patchCfg({ proactiveQuietFrom: 23, proactiveQuietTo: 8 });
p = await probe(23);
check('23 点在安静时段内 → 拒绝', p.r && p.r.ok === false, JSON.stringify(p.r));
check('拒绝的理由说得清', p.r && p.r.reason === '安静时段', JSON.stringify(p.r && p.r.reason));
check('★被拒时不扣额度★（闸排在额度前面）', p.after.count === p.before.count, `${p.before.count} → ${p.after.count}`);

p = await probe(0);
check('0 点也在安静时段内（跨零点的那一半）', p.r && p.r.reason === '安静时段', JSON.stringify(p.r));
check('这一半同样不扣额度', p.after.count === p.before.count, `${p.before.count} → ${p.after.count}`);

p = await probe(7);
check('7:59 那一侧仍安静', p.r && p.r.reason === '安静时段', JSON.stringify(p.r));

p = await probe(8);
check('8 点整放行（左闭右开）', p.r && p.r.ok === true, JSON.stringify(p.r && p.r.reason));
check('放行才扣额度', p.after.count === p.before.count + 1, `${p.before.count} → ${p.after.count}`);

p = await probe(14);
check('白天当然能说', p.r && p.r.ok === true, JSON.stringify(p.r && p.r.reason));
p = await probe(22);
check('安静时段开始前一小时能说', p.r && p.r.ok === true, JSON.stringify(p.r && p.r.reason));

// ③ 只配一半 / 两边相同 → 一律不生效（不许因为半个笔误就静音）
await patchCfg({ proactiveQuietFrom: 23, proactiveQuietTo: null });
p = await probe(3);
check('只配一半（缺 to）不生效', p.r && p.r.ok === true, JSON.stringify(p.r && p.r.reason));
await patchCfg({ proactiveQuietFrom: null, proactiveQuietTo: 8 });
p = await probe(3);
check('只配一半（缺 from）不生效', p.r && p.r.ok === true, JSON.stringify(p.r && p.r.reason));
await patchCfg({ proactiveQuietFrom: 23, proactiveQuietTo: 23 });
p = await probe(23);
check('两边相同有歧义 → 当没配（不静音）', p.r && p.r.ok === true, JSON.stringify(p.r && p.r.reason));

// ④ 日志里要留下证据：她不说的时候，一眼能看出是安静时段而不是坏了
const logPath = join(process.env.TEMP || '', 'ds-companion.log');
const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-40000) : '';
check('日志里能看到「安静时段」', tail.includes('安静时段'), logPath);

// ⑤ 界面：两个旋钮存得进去，且不把成本闸那一排挤乱
await patchCfg({ proactiveQuietFrom: null, proactiveQuietTo: null, proactiveDailyCap: 6 });
await evalIn(win, `(() => { const b = document.querySelector('.tb-tab[data-tab="state"]'); if (b) b.click(); return true })()`);
await sleep(900);
const geo = await evalIn(
  win,
  `(() => {
     const f = document.getElementById('sf-quiet-from');
     const t = document.getElementById('sf-quiet-to');
     const c = document.getElementById('sf-procap');
     const gates = document.querySelector('.gates');
     if (!f || !t || !c || !gates) return { missing: true };
     const gr = gates.getBoundingClientRect();
     const rects = [f, t, c].map(e => e.getBoundingClientRect());
     return {
       missing: false,
       shown: [f, t, c].every(e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height >= 20),
       inGates: rects.every(r => r.left >= gr.left - 1 && r.right <= gr.right + 1),
       w: rects.map(r => Math.round(r.width)),
       h: rects.map(r => Math.round(r.height)),
       hint: (document.getElementById('st-gate-hint') || {}).textContent || '',
       value: [f.value, t.value, c.value],
       hscroll: document.documentElement.scrollWidth - window.innerWidth,
     };
   })()`,
);
check('界面里有两个旋钮（安静时段 从/到、每天最多）', geo.missing !== true && geo.shown === true, JSON.stringify(geo));
check('它们待在成本闸那一排里（没被挤出去）', geo.inGates === true, JSON.stringify(geo.w));
check('点得中（高度 ≥ 20px）', geo.h.every((h) => h >= 20), JSON.stringify(geo.h));
check('没把页面顶出横向滚动条', geo.hscroll <= 2, String(geo.hscroll));
check('初始值是空（= 全天）+ 每天最多 6', JSON.stringify(geo.value) === JSON.stringify(['', '', '6']), JSON.stringify(geo.value));

// 真的改一次：走 change 事件（= 用户敲完数字离开输入框）
await evalIn(
  win,
  `(() => {
     const f = document.getElementById('sf-quiet-from');
     const t = document.getElementById('sf-quiet-to');
     f.value = '23'; f.dispatchEvent(new Event('change'));
     t.value = '8'; t.dispatchEvent(new Event('change'));
     return true;
   })()`,
);
let saved = null;
for (let i = 0; i < 20; i++) {
  const cfg = await call(win, 'config_get');
  if (cfg.proactiveQuietFrom === 23 && cfg.proactiveQuietTo === 8) {
    saved = cfg;
    break;
  }
  await sleep(250);
}
check('界面改的安静时段真的存进配置了', !!saved, JSON.stringify(saved && [saved.proactiveQuietFrom, saved.proactiveQuietTo]));
const hint = String(
  await evalIn(win, `(document.getElementById('st-gate-hint') || {}).textContent || ''`),
);
check('提示行说清了「23 点到 8 点不打扰」', hint.includes('23') && hint.includes('8') && hint.includes('不打扰'), hint.slice(0, 90));

// 界面存下去之后，闸立刻生效（同一条配置，不该有两份真相）
p = await probe(23);
check('界面配完立刻生效（23 点被拒）', p.r && p.r.reason === '安静时段', JSON.stringify(p.r));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
