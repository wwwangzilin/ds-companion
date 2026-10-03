/* 日记端到端验收：在**隔离数据目录**里，用真命令走完"该写哪天 → 落盘 → 同一天不再问"。
 *
 * 【为什么要端到端】日记有三段，单测只覆盖得了两头：
 *   ① 挑哪天（`diary::pick_day`，Rust 单测）     ② 提示词/正文清洗（tools/test-diary.cjs）
 *    ③ 落盘（src-tauri/tests/diary_fs.rs）
 * 中间那条**胶水**——turn_report 把哪一天递出去、页面拿到之后 invoke 哪条命令、ACL 通不通、
 * 字段名是不是 camelCase——只有真机的两个进程一起跑才算验过。而这个项目在"机制没坏、
 * 通路断了"上吃过亏（情绪冻结、SSE 丢正文都是这么来的）。
 *
 * 用法（PowerShell，**先停掉主人正在用的实例**：同一个 WebView2 profile 起不了第二个）：
 *   $env:DSC_DATA_DIR="$env:TEMP\dsc-verify-diary"
 *   Remove-Item -Recurse -Force $env:DSC_DATA_DIR -ErrorAction SilentlyContinue
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   .\src-tauri\target\debug\ds-companion.exe
 *   node .verify/verify-diary.mjs
 *
 * 【它不碰什么】不碰真实数据目录（门禁 `requireIsolation()` 挡着），不消耗任何网页额度
 * （真模型那一步用假正文替掉：`__DSC_DIARY__` 被替换成一个固定字符串）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
// 门禁从 DSC_CDP 读地址，而 ESM 的 import 会先于赋值执行 —— 所以这里用动态 import
process.env.DSC_CDP = BASE;
const { requireIsolation } = await import('./_env.mjs');

const PAST = '2026-10-02';
const TODAY = '2026-10-03';
const FAKE = '（验收）他把饮料丢给我，说是喝不完。其实我喝完了。';

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

function evalIn(target, expression, timeoutMs = 30000) {
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
      // 不要在 onmessage 里立刻 close：会让 node 的 ws 在收尾阶段断言崩掉
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

/** 在页面里 invoke 一条命令；失败就抛（错误里带着壳的原话） */
async function call(page, cmd, args) {
  const expr =
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}` +
    (args ? `, ${JSON.stringify(args)}` : '') +
    `).then(v => JSON.stringify({ ok: 1, v })).catch(e => JSON.stringify({ ok: 0, e: String(e) }))`;
  const out = JSON.parse(await evalIn(page, expr));
  if (!out.ok) throw new Error(`${cmd} 失败：${out.e}`);
  return out.v;
}

/** 在日记目录里找某一天的文件（writeDiary 是异步的，得等它落盘） */
async function waitDiaryFile(root, day, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dir = join(root, 'diary');
    if (existsSync(dir)) {
      for (const sub of readdirSync(dir)) {
        const p = join(dir, sub, `${day}.md`);
        if (existsSync(p) && statSync(p).size > 0) return { path: p, character: sub };
      }
    }
    if (Date.now() > deadline) return null;
    await sleep(300);
  }
}

// ── 开跑 ────────────────────────────────────────────────────────────
const page = await findTarget('deepseek.com');
console.log(`[page] ${page.url}`);
// 门禁要问壳"数据目录 + 隔没隔离"，而那条命令只有设置窗口能调 —— 先把它打开
await call(page, 'open_settings').catch((e) => console.warn('[warn] open_settings：' + e.message));
const info = await requireIsolation();

// ① 只有"当天"记录时不该写：今天还没过完
await call(page, 'dsc_chat_append', {
  turn: {
    at: Date.parse(`${PAST}T21:00:00`),
    day: PAST,
    clock: '21:00',
    character: '验收',
    characterId: '',
    session: 'verify-diary',
    user: '今天有点累，陪我坐会儿',
    assistant: '那就别撑着了，坐下。',
  },
});
const r1 = await call(page, 'dsc_turn_report', { userText: '今天也有点累', hour: 21, day: PAST });
check('只有当天记录 → 不写（今天还没过完）', !r1.diary, JSON.stringify(r1.diary));
check('turn_report 带着日期聚合（daily 有一行）', Array.isArray(r1.state?.daily) && r1.state.daily.length >= 1, JSON.stringify(r1.state?.daily));

// ② 换了一天 → 把上一篇交给她
const r2 = await call(page, 'dsc_turn_report', { userText: '在吗', hour: 10, day: TODAY });
check('新的一天会请她写上一篇', !!r2.diary, JSON.stringify(r2.diary));
check('写的是"上一个有记录的日子"', r2.diary && r2.diary.day === PAST, JSON.stringify(r2.diary && r2.diary.day));
check('素材里有那天的轮数', !!r2.diary && r2.diary.turns >= 1, String(r2.diary && r2.diary.turns));
check('素材里有那天真正说过的话', !!r2.diary && String(r2.diary.excerpt).includes('别撑着'), JSON.stringify(r2.diary && r2.diary.excerpt));
check('好感/情绪也带上了', !!r2.diary && typeof r2.diary.affinity === 'number' && typeof r2.diary.valence === 'number', JSON.stringify(r2.diary && { a: r2.diary.affinity, v: r2.diary.valence }));

// ③ 页面侧那一段真跑一遍：拿假正文替掉模型（真正文要登录态 + 一次隐藏请求）
const hooked = await evalIn(page, "typeof window.__DSC_WRITE_DIARY__ + '/' + typeof window.__DSC_DIARY__");
check('页面里两个钩子都在（writeDiary / __DSC_DIARY__）', hooked === 'function/function', hooked);
await evalIn(page, `window.__DSC_DIARY__ = function () { return Promise.resolve(${JSON.stringify(FAKE)}); };`);
await evalIn(page, `window.__DSC_WRITE_DIARY__(${JSON.stringify(r2.diary)}); 'fired'`);
const file = await waitDiaryFile(info.path, PAST);
check('正文真的落盘了', !!file, file ? file.path : `等不到 ${PAST}.md`);
if (file) {
  const body = readFileSync(file.path, 'utf8');
  check('落在隔离数据目录里', file.path.startsWith(info.path), file.path);
  check('文件名就是那一天', file.path.endsWith(`${PAST}.md`), file.path);
  check('内容是模型写的那段', body.includes(FAKE), JSON.stringify(body.slice(0, 80)));
  check('带日期标题', body.includes(`# ${PAST}`), JSON.stringify(body.slice(0, 40)));
  check('按角色分目录', !!file.character, file.character);
}

// ④ 同一天不再问第二次（这条同时证明 dsc_diary_save 回写了 last_diary_day）
const r3 = await call(page, 'dsc_turn_report', { userText: '还在吗', hour: 11, day: TODAY });
check('写过之后同一天不再问', !r3.diary, JSON.stringify(r3.diary));

// ⑤ 日记不许回灌进对话（设计边界：它不注入、不进记忆）
check('日记内容没有被注入回状态块', !JSON.stringify(r3).includes(FAKE), '回灌了就等于她照镜子写字');
check('日记没有进记忆快照', !JSON.stringify(r3).includes('喝不完'), '记忆里不该有日记');

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
