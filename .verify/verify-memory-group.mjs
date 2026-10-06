/* 记忆列表的「按角色聚块」验收。
 *
 * 【为什么专门写一个】主人反馈「记忆好像串了」—— 查下来数据和注入都是干净的
 * （每条记忆的 characterId 都对、注入时按 `characterId.is_empty() || == 当前角色`
 * 过滤），但**记忆列表原来纯按权重降序**：权重是跨角色的同一个量纲，于是三个角色的
 * 条目按分数交错排列，一眼扫过去就像"记串了"。
 *
 * 这个脚本验的就是那次修正：默认视图要**先按角色聚块**（当前角色 → 全局 → 其余
 * 各聚一块），块内再按权重；另外验新加的「当前角色」筛选档。
 *
 * 用法（PowerShell，先停真实例 —— 单实例锁）：
 *   $env:DSC_DATA_DIR="$env:TEMP\dsc-verify-memgroup"
 *   Remove-Item -Recurse -Force $env:DSC_DATA_DIR -ErrorAction SilentlyContinue
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   .\src-tauri\target\debug\ds-companion.exe
 *   node .verify/verify-memory-group.mjs
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

function send(target, method, params = {}, timeoutMs = 25000) {
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
async function evalIn(t, expr, timeoutMs) {
  const r = await send(t, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs);
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
    } catch {}
    if (Date.now() > deadline) throw new Error(`等不到窗口：${match}`);
    await sleep(300);
  }
}

const main = await findTarget('deepseek.com', 45000);
await evalIn(main, `window.__TAURI_INTERNALS__.invoke('open_settings').then(()=>1).catch(e=>String(e))`);
const st = await findTarget('settings.html', 25000);
await requireIsolation();

// 造几条分属不同角色的记忆（隔离目录本来是空的，正好完全可控）
const mk = (id, cid, name, imp) =>
  evalIn(
    st,
    `window.__TAURI_INTERNALS__.invoke('memory_save', { item: {
       id: ${JSON.stringify(id)}, characterId: ${JSON.stringify(cid)},
       name: ${JSON.stringify(name)}, content: '验收用',
       keys: [], importance: ${imp}, pinned: false, source: 'manual'
     } }).then(() => 'ok').catch(e => 'err:' + e)`,
  );
const seeded = [];
for (const [id, cid, name, imp] of [
  ['mg-ds-1', 'dsh-deepseek', '娘的记忆甲', 3],
  ['mg-ds-2', 'dsh-deepseek', '娘的记忆乙', 5],
  ['mg-global', '', '全局记忆', 4],
  ['mg-luna-1', 'dsh-luna', '露娜的记忆甲', 5],
  ['mg-luna-2', 'dsh-luna', '露娜的记忆乙', 3],
  ['mg-luna-3', 'dsh-luna', '露娜的记忆丙', 1],
]) {
  seeded.push(await mk(id, cid, name, imp));
}
check('造了 6 条记忆（2 当前角色 + 1 全局 + 3 别的角色）', seeded.every((x) => x === 'ok'), seeded.join(','));

// 切到「记忆」页签（列表在那一页里才渲染）
await evalIn(st, `(() => { const b = document.querySelector('.tb-tab[data-tab="memory"]'); if (b) b.click(); return !!b; })()`);
await sleep(1500);
// 【必须先复位筛选档】筛选是**页面状态**，上一轮脚本点了「当前角色」的话会留到这一轮
// （app 没重启就一直在）—— 表现是"列表里只剩当前角色的卡"，看着像排序坏了。
// 同一个坑在 Quill 那边也踩过：**验收脚本要对初始界面状态免疫**。
await evalIn(
  st,
  `(() => { const b = document.querySelector('#mem-filter button[data-v="all"]'); if (b) b.click(); return !!b; })()`,
);
await sleep(700);

const order = JSON.parse(
  await evalIn(
    st,
    `(() => {
       const cards = [...document.querySelectorAll('#mem-list .card')];
       return JSON.stringify(cards.map(c => {
         const sub = c.querySelector('.sub');
         const nm = c.querySelector('.nm');
         return { name: nm ? nm.textContent : '', sub: sub ? sub.textContent : '' };
       }));
     })()`,
  ),
);
console.log('[顺序] ' + order.map((o) => o.name + '（' + String(o.sub).split(' · ')[0] + '）').join(' → '));
check('列表渲染出来了', order.length >= 6, `${order.length} 张卡`);

// 关键断言：同一角色的卡必须**聚在一起**（不能交错）
const ownerOf = (c) => String(c.sub).split(' · ')[0];
const owners = order.map(ownerOf);
const blocks = owners.filter((o, i) => i === 0 || o !== owners[i - 1]);
check('★ 同角色的记忆聚成一块（不再按权重交错）', blocks.length === new Set(owners).size, `块序列：${blocks.join(' | ')}`);

// 排序优先级：当前角色 → 全局 → 其余
check(
  '★ 当前角色的排最前',
  owners.slice(0, 2).every((o) => o === 'DeepSeek 娘'),
  `前两条归属：${owners.slice(0, 2).join(',')}`,
);
check('全局记忆排在当前角色之后、其他角色之前', owners[2] === '全局', `第三条归属：${owners[2]}`);
// 【为什么不断言显示名】隔离环境里没有建 luna 人设，`charName` 会回落成 id
// （`dsh-luna`）—— 断言"显示成露娜"是我第一版写错了。这里只验**归属分组**本身。
check(
  '其他角色的排在最后（且聚成一块）',
  owners.slice(3).length === 3 &&
    new Set(owners.slice(3)).size === 1 &&
    !owners.slice(3).includes('DeepSeek 娘') &&
    !owners.slice(3).includes('全局'),
  owners.slice(3).join(','),
);

// 新筛选档：只看当前角色（含全局）
await evalIn(st, `(() => { const b = document.querySelector('#mem-filter button[data-v="active"]'); if (b) b.click(); return !!b; })()`);
await sleep(800);
const filtered = JSON.parse(
  await evalIn(
    st,
    `(() => JSON.stringify([...document.querySelectorAll('#mem-list .card .sub')].map(s => String(s.textContent).split(' · ')[0])))()`,
  ),
);
check(
  '★「当前角色」筛选档：只剩当前角色 + 全局',
  filtered.length === 3 && filtered.filter((x) => x === '露娜').length === 0,
  JSON.stringify(filtered),
);

// 收尾：清掉造出来的记忆，别把隔离目录留脏（下次还会用同一个目录）
for (const [id] of [['mg-ds-1'], ['mg-ds-2'], ['mg-global'], ['mg-luna-1'], ['mg-luna-2'], ['mg-luna-3']]) {
  await evalIn(st, `window.__TAURI_INTERNALS__.invoke('memory_delete', { id: ${JSON.stringify(id)} }).catch(()=>0)`);
}
console.log('\n(已清掉验收用的 6 条记忆)');
console.log(`${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
