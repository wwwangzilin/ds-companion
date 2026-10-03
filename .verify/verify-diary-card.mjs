/* 设置页「她的日记」验收：种两天日记 → 进状态页 → 卡片该列出来、该点得开、该量得对。
 *
 * 【为什么要专门验这条新链路】日记写盘那条链上一轮已经端到端验过了，这里验的是**读者那一侧**：
 *   ① 两个新命令的 capability 挂对了没有（挂错 → 页面会拿到 "not allowed"，而界面上
 *      只会安静地显示"她还没写过日记" —— 那种失败最像没 bug）；
 *   ② 列表与正文是不是真的**分两次取**（一次列表、点开才取正文）；
 *   ③ 版面的基本量：卡片在曲线下面、按钮不出框、不把页面顶出横向滚动条。
 *
 * 【为什么只能靠几何断言】本机没有视觉能力（describe_image 缺 provider、modflow 无 engine），
 * 所以"好不好看"留给主人看，"有没有塌、有没有溢出、点不点得中"由这里守。
 *
 * 用法（PowerShell，先停掉真实例 —— 单实例锁）：
 *   $env:DSC_DATA_DIR="$env:TEMP\dsc-verify-diary-card"
 *   Remove-Item -Recurse -Force $env:DSC_DATA_DIR -ErrorAction SilentlyContinue
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   .\src-tauri\target\debug\ds-companion.exe
 *   node .verify/verify-diary-card.mjs
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
process.env.DSC_CDP = BASE;
const { requireIsolation } = await import('./_env.mjs');

const OLD = '2026-09-30';
const NEW = '2026-10-01';
const OLD_TEXT = '（验收）这是早一天的日记，只有这里能看到。';
const NEW_TEXT = '（验收）这是最近一天的日记，默认该摊开这一篇。';

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
      // 不要在 onmessage 里立刻 close：node 的 ws 会在收尾阶段断言崩掉
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

/** 等页面里某个选择器出现（异步取数，不能立刻断言） */
async function waitFor(win, selector, want = 1, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await evalIn(win, `document.querySelectorAll(${JSON.stringify(selector)}).length`);
    if (n >= want) return n;
    if (Date.now() > deadline) return n;
    await sleep(250);
  }
}

// ── 开跑 ────────────────────────────────────────────────────────────
const page = await findTarget('deepseek.com');
console.log(`[page] ${page.url}`);

// ① 先种两天日记（走真命令，落到隔离数据目录）
await call(page, 'dsc_diary_save', { day: OLD, text: OLD_TEXT });
await call(page, 'dsc_diary_save', { day: NEW, text: NEW_TEXT });
const saved = await call(page, 'dsc_diary_save', { day: NEW, text: NEW_TEXT });
console.log(`[seed] ${saved}`);
check('日记落在隔离数据目录里', String(saved).includes('dsc-verify-diary-card'), saved);
check('同一天再写是追加，不换文件', String(saved).endsWith(`${NEW}.md`), saved);

// ② 打开设置窗口（门禁也要靠它读数据目录）
await call(page, 'open_settings').catch((e) => console.warn('[warn] open_settings：' + e.message));
const info = await requireIsolation();
const win = await findTarget('settings.html');
// 刷新一次，别让上一轮留下的界面状态干扰（上一轮验收踩过：设置页停在别的页签）
await evalIn(win, 'location.reload(); "reloading"');
await sleep(1500);

// ③ 进「状态」页（用户路径：点页签按钮）
await evalIn(
  win,
  `(() => { const b = document.querySelector('.tb-tab[data-tab="state"]'); if (b) b.click(); return !!b; })()`,
);
await sleep(600);
const cardVisible = await evalIn(
  win,
  `(() => { const c = document.getElementById('diary-card'); if (!c) return 'missing';
     const st = getComputedStyle(c); return st.display + '/' + (c.getBoundingClientRect().height > 40); })()`,
);
check('状态页里有「她的日记」卡片', cardVisible !== 'missing', String(cardVisible));
// 卡片本身就是 flex 容器（.editor 的排版方式），所以只要求"不是 none、且有高度"
check(
  '卡片是显出来的（不是隐藏页签里的）',
  !cardVisible.startsWith('none') && cardVisible.endsWith('/true'),
  String(cardVisible),
);

// ④ 列表：两天都要在（这一步同时证明 dsc_diary_days 的 capability 是通的）
const n = await waitFor(win, '#diary-days .diary-day', 2);
check('列出了两天', n === 2, `拿到 ${n} 个`);
const days = await evalIn(
  win,
  `Array.from(document.querySelectorAll('#diary-days .diary-day')).map(b => b.dataset.day)`,
);
check('新的排在前面', Array.isArray(days) && days[0] === NEW && days[1] === OLD, JSON.stringify(days));
const sub = await evalIn(win, `(document.getElementById('diary-sub') || {}).textContent`);
check('小标题给出篇数与总字数', /2 篇 · 共 \d+ 字/.test(String(sub)), String(sub));

// ⑤ 默认摊开最新那篇，且读的是**它**的正文
await waitFor(win, '#diary-body', 1);
let body = '';
for (let i = 0; i < 40; i++) {
  body = String(await evalIn(win, `(document.getElementById('diary-body') || {}).textContent`));
  if (body.includes('验收')) break;
  await sleep(250);
}
check('默认摊开的是最新一篇', body.includes(NEW_TEXT.slice(0, 12)), JSON.stringify(body.slice(0, 60)));
check('正文里没有标题行（标题是文件名重复一遍）', !body.includes(`# ${NEW}`), JSON.stringify(body.slice(0, 40)));
const onCount = await evalIn(win, `document.querySelectorAll('#diary-days .diary-day.on').length`);
check('选中的那天有一个「亮着」的标记', onCount === 1, String(onCount));

// ⑥ 点早一天 → 换成正那一天
await evalIn(
  win,
  `(() => { const b = Array.from(document.querySelectorAll('#diary-days .diary-day'))
      .find(x => x.dataset.day === ${JSON.stringify(OLD)}); if (b) b.click(); return !!b; })()`,
);
let body2 = '';
for (let i = 0; i < 40; i++) {
  body2 = String(await evalIn(win, `(document.getElementById('diary-body') || {}).textContent`));
  if (body2.includes('早一天')) break;
  await sleep(250);
}
check('点一天换出那天的正文', body2.includes(OLD_TEXT.slice(0, 12)), JSON.stringify(body2.slice(0, 60)));
const onDay = await evalIn(
  win,
  `(document.querySelector('#diary-days .diary-day.on') || {}).dataset?.day`,
);
check('亮着的是刚点的那天', onDay === OLD, String(onDay));

// ⑦ 版面：位置、出框、溢出、可点面积
const geo = await evalIn(
  win,
  `(() => {
     const card = document.getElementById('diary-card');
     const curve = document.getElementById('curve-card');
     const chips = Array.from(document.querySelectorAll('#diary-days .diary-day'));
     const body = document.getElementById('diary-body');
     const cr = card.getBoundingClientRect();
     const chipRects = chips.map(c => c.getBoundingClientRect());
     return {
       cardW: Math.round(cr.width),
       belowCurve: curve ? cr.top > curve.getBoundingClientRect().top : null,
       chipH: chipRects.map(r => Math.round(r.height)),
       chipOut: chipRects.filter(r => r.left < cr.left - 1 || r.right > cr.right + 1).length,
       chipOverlap: chipRects.some((r, i) => i && r.left < chipRects[i-1].right + 1 && Math.abs(r.top - chipRects[i-1].top) < 2),
       bodyW: Math.round(body.getBoundingClientRect().width),
       hscroll: document.documentElement.scrollWidth - window.innerWidth,
       refresh: !!document.getElementById('diary-refresh'),
     };
   })()`,
);
check('卡片在曲线卡片下面', geo.belowCurve === true, String(geo.belowCurve));
check('日期按钮没有伸出卡片', geo.chipOut === 0, `出框 ${geo.chipOut} 个`);
check('日期按钮没互相压着', geo.chipOverlap === false, String(geo.chipOverlap));
check('日期按钮点得中（高度 ≥ 24px）', geo.chipH.every((h) => h >= 24), JSON.stringify(geo.chipH));
check('正文块有宽度', geo.bodyW > 200, String(geo.bodyW));
check('没把页面顶出横向滚动条', geo.hscroll <= 2, `溢出 ${geo.hscroll}px`);
check('有刷新按钮', geo.refresh === true);

// ⑧ 磁盘上的事实：两天的文件都在，且那一刻没有临时文件残留
const dir = join(info.path, 'diary');
let files = [];
for (const sub2 of existsSync(dir) ? readdirSync(dir) : []) {
  files = files.concat(readdirSync(join(dir, sub2)));
}
check('盘上有两篇日记', files.filter((f) => f.endsWith('.md')).length === 2, JSON.stringify(files));
check('没有临时文件残留', !files.some((f) => f.includes('tmp')), JSON.stringify(files));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
