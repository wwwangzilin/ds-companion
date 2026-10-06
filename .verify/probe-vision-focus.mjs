/* 她到底"看不看得懂屏幕"，还是"只读得出大字"？
 *
 * 【背景】第一版探针（probe-vision.mjs）画的是 360×140、只有两行大字的图，
 * 她照原样念出来 —— 主人看了一眼就说「只说个头，不去关注重点」。
 * 但那张图里本来就只有个头，而且提问是「用一句话原样说出来」，等于不许她说重点。
 * 所以这个脚本换一张**信息量够**的仿屏幕图（40px 标题 / 17px 警告框 / 15px 正文 /
 * 13px 页脚），分两件事量：
 *
 *   A) 分辨率阈值：同一张图缩到 5 档宽度上传，读 token_usage（**不提问 = 不花额度**），
 *      再挑关键档位用**同一个新提示词**问一次，看正文/警告框的小字还读不读得出。
 *   B) 提示词的作用：同一张图、同一尺寸，用"旧提示词"和"新提示词"各问一次，
 *      看"重点在哪"到底是图糊了还是没被要求。
 *
 * ⚠ 每上传一张，账号里就多一张图（上游**没有删除接口**，删对话也删不掉文件）。
 *   所以默认只跑 A 的 upload 档（零对话额度）＋ 两次提问（复用同一张图）。
 *   要看完整矩阵：$env:DSC_VISION_FULL='1'
 *
 * 用法：$env:DSC_VISION_TRY='1'; node .verify/probe-vision-focus.mjs
 */
import { requireIsolation } from './_env.mjs';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 180000) {
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
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
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

async function findTarget(match, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(`${BASE}/json/list`)).json();
      const t = list.find((x) => x.url && x.url.includes(match));
      if (t) return t;
    } catch {}
    if (Date.now() > deadline) throw new Error('等不到 ' + match);
    await sleep(300);
  }
}

/** 在页面里跑一次 __DSC_BOARD__，只把结果搬出来 */
async function board(main, opts) {
  const raw = await evalIn(
    main,
    `window.__DSC_BOARD__(${JSON.stringify(opts)})`,
    180000,
  );
  return raw || { ok: false, err: '探针没返回' };
}

if (String(process.env.DSC_VISION_TRY || '') !== '1') {
  console.log('没发请求 —— 每上传一张图，账号里就多一张（且删不掉）。');
  console.log('确实要试：$env:DSC_VISION_TRY="1"; node .verify/probe-vision-focus.mjs');
  process.exit(0);
}
await requireIsolation();

const OLD_PROMPT =
  '这张图上写着什么？用一句话原样说出来（不要解释、不要客套）。如果没看到图，就回"没看到图"。';

// 要测的就是它：明确要"内容"和"重点"两件事，并且要求她**把重点那块的字念出来**
// （不念出来就没法验证她到底看清了没有）
const NEW_PROMPT = [
  '这是主人电脑屏幕的一张截图。回答两件事，各占一行，不要客套、不要复述我的话：',
  '第一行「在做什么」：他正在看什么、干什么，一句话。',
  '第二行「重点」：整屏最该注意的那一处，把那上面写的字照抄出来。',
  '看不清就直说看不清，别猜。',
].join('\n');

console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com');
console.log('[probe] 画一张仿屏幕图（1600×1000：40px 标题 / 17px 警告框 / 15px 正文 / 13px 页脚）');

// ── A) 成本曲线：5 档宽度 ────────────────────────────────────────────
// 【先查缓存】上游没有删除接口 —— 重跑一次就多 5 张垃圾图。所以传过的板子按宽度
// 记在 vision-boards.json 里，下次直接复用（只重读 token，不重传）。
let cache = { boards: [] };
try {
  cache = JSON.parse(await (await import('node:fs/promises')).readFile(
    new URL('./vision-boards.json', import.meta.url),
    'utf8',
  ));
} catch {}
const known = new Map((cache.boards || []).map((b) => [b.width, b.fileId]));

const WIDTHS = [1600, 1280, 1024, 768, 512];
// 板子全在缓存里 = 这次一次上传都没有，那就别再顺手提问花额度了
const allCached = WIDTHS.every((w) => known.has(w));
const askAllowed = !allCached || String(process.env.DSC_VISION_ASK || '') === '1';

const curve = [];
for (const w of WIDTHS) {
  const reuse = known.get(w);
  if (reuse) console.log(`  ${String(w).padStart(4)}px → 复用已传的板子 ${reuse}`);
  const r = await board(main, reuse ? { fileId: reuse, width: w, mode: 'upload' } : { width: w, mode: 'upload' });
  if (!r.ok) {
    console.log(`  ${w}px  FAIL ${r.err}`);
    continue;
  }
  curve.push({ ...r, width: r.width || w });
  console.log(
    `  ${String(w).padStart(4)}px → ${r.width}×${r.height}  ${Math.round((r.bytes || 0) / 1024)}KB  ` +
      `token=${r.tokenUsage}  ${r.ms}ms  ${r.fileId}`,
  );
}

// 把这次新传的回写进缓存（固定宽度才缓存，缩放过的尺寸可能被上游归一化）
try {
  const fs = await import('node:fs/promises');
  const merged = new Map((cache.boards || []).map((b) => [b.width, b]));
  for (const r of curve) {
    if (!known.has(r.width) && r.fileId) {
      merged.set(r.width, { width: r.width, height: r.height, token: r.tokenUsage, fileId: r.fileId });
    }
  }
  await fs.writeFile(
    new URL('./vision-boards.json', import.meta.url),
    JSON.stringify({ note: cache.note || '多模态验收台已传的板子', boards: [...merged.values()] }, null, 2) + '\n',
    'utf8',
  );
} catch (e) {
  console.log('  （板子缓存写不进去：' + e.message + '）');
}

// 挑一档来提问：优先 1024（常见窗口宽度），没有就用上传成功里最大的那张
const pick = curve.find((r) => r.width === 1024) || curve[0];
if (!pick) {
  console.log('\nFAIL  一张都没传上去');
  process.exit(1);
}

if (!askAllowed) {
  console.log('\n板子全在缓存里 —— 本次零上传、零提问。');
  console.log('要再看一遍提示词对比／字号阈值：$env:DSC_VISION_ASK="1"（会花额度）');
  process.exit(0);
}

console.log(`\n[A] 分辨率：拿 ${pick.width}×${pick.height}（token=${pick.tokenUsage}）用**新提示词**问一次`);
console.log('    提示词：' + NEW_PROMPT.split('\n').join(' / '));
const askNew = await board(main, { fileId: pick.fileId, prompt: NEW_PROMPT, mode: 'ask' });
console.log('──────── 她的回答 ────────');
console.log(String(askNew.text || '').trim() || `（空）${askNew.err || ''}`);
console.log('──────────────────────────');

const readWarning = /依赖包|缓存|编译失败|target/.test(String(askNew.text || ''));
const readBody = /Rust 1\.77|MSVC|APPDATA|5MB/.test(String(askNew.text || ''));
const sawFocus = /重点/.test(String(askNew.text || '')) || readWarning;

console.log('');
console.log(readWarning ? 'PASS  警告框里的小字（17px）她读到了' : 'FAIL  警告框那行没读出来');
console.log(readBody ? 'PASS  正文小字（15px）她也读到了' : '一点提示：正文 15px 那几行没出现在回答里');
console.log(sawFocus ? 'PASS  她给出了"重点"' : 'FAIL  她仍然没说重点在哪');

// ── B) 提示词的作用：同一张图、旧提示词 ──────────────────────────────
console.log(`\n[B] 提示词对照：同一张图（${pick.fileId}）用**旧提示词**再问一次`);
const askOld = await board(main, { fileId: pick.fileId, prompt: OLD_PROMPT, mode: 'ask' });
console.log('──────── 旧提示词的回答 ────────');
console.log(String(askOld.text || '').trim() || `（空）${askOld.err || ''}`);
console.log('────────────────────────────────');
const oldLen = String(askOld.text || '').length;
const newLen = String(askNew.text || '').length;
console.log(`\n字数对比：旧 ${oldLen} 字  vs  新 ${newLen} 字`);

// ── C) 字号阈值：她到底读得到哪几档字 ────────────────────────────────
// 那张板子故意把字号拉开四档，问同一句话就能量出"缩到多小开始糊"：
//   40px 主标题 / 17px 侧栏+警告框 / 15px 正文 / 13px 页脚
const TIERS = [
  { name: '40px 主标题', re: /安装与配置/ },
  { name: '17px 侧栏', re: /快速开始|目录结构|构建与打包/ },
  { name: '17px 警告框', re: /依赖包|编译失败/ },
  { name: '15px 正文', re: /1\.77|MSVC|APPDATA|5MB/ },
  { name: '13px 页脚', re: /2026-10-06|最后更新/ },
];
const BODY_PROMPT =
  '把这屏上的字**全部**念出来，按字号从大到小分成四组。某一组看不清就写"看不清"，不要猜、不要跳过。';

if (String(process.env.DSC_VISION_FULL || '') === '1') {
  console.log('\n[C] 字号阈值：每档各问一次「把所有字念出来」（图都已经在账号里，不新增上传）');
  console.log('    ' + '宽度'.padEnd(8) + TIERS.map((t) => t.name.padEnd(12)).join(''));
  const rows = [];
  for (const r of curve) {
    const a = await board(main, { fileId: r.fileId, prompt: BODY_PROMPT, mode: 'ask' });
    const txt = String(a.text || '');
    const cells = TIERS.map((t) => (t.re.test(txt) ? '✓ 读到' : '✗ 糊了'));
    rows.push({ w: r.width, tok: r.tokenUsage, cells, txt });
    console.log('    ' + (r.width + 'px').padEnd(8) + cells.map((c) => c.padEnd(12)).join(''));
  }
  console.log('\n    各档原话（前 160 字）：');
  for (const row of rows) {
    console.log(`    ── ${row.w}px (token=${row.tok})`);
    console.log('       ' + row.txt.trim().split('\n').join(' | ').slice(0, 160));
  }
  // 结论行：找"最后一档还读得到 15px 正文"的宽度
  const ok = rows.filter((r) => TIERS[3].re.test(r.txt));
  console.log(
    '\n    → 15px 正文还能读出来的最小宽度：' +
      (ok.length ? Math.min(...ok.map((r) => r.w)) + 'px' : '一档都不行（连 1600px 也读不出）'),
  );
}

console.log('\n[留痕] 本次上传的图（删对话也删不掉这些文件）：');
for (const r of curve) console.log(`  ${r.width}×${r.height}  ${r.fileId}  token=${r.tokenUsage}`);
