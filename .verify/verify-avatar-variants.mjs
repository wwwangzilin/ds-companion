/* 表情差分验收：设置界面里那排格子（上传/清除一格）+ 壳侧的四级回落链。
 *
 * 【为什么单开一个脚本】verify-avatar.mjs 验的是"一张图能不能显示出来"（浮层几何、
 * CSP、naturalWidth）。这里验的是**一套图怎么挑**，两件事的失败方式完全不同：
 *   ① **回落链**：用户的该变体 → 用户的单图 → 内置同变体 → 内置 neutral。错一格就会
 *      "传了开心但显示的是默认"，而画面上只是"图不太对"，肉眼极难当场抓住。
 *   ② **`hasUser` 到底是"这一格"还是"这个角色"**：只传了一张单图时，7 个格子显示的
 *      都是同一张，但一个都不该能单独清掉 —— 判据混淆会让「清掉这张」把单图删了。
 *   ③ 这两条都只在**有用户图 + 有内置素材同时存在**时才暴露，所以脚本必须真造图、
 *      真落盘、真读回来，不能只测空状态。
 *
 * 用法（PowerShell，先停真实例 —— 单实例锁）：
 *   $env:DSC_DATA_DIR="$env:TEMP\dsc-verify-avatar-variants"
 *   Remove-Item -Recurse -Force $env:DSC_DATA_DIR -ErrorAction SilentlyContinue
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   .\src-tauri\target\debug\ds-companion.exe
 *   node .verify/verify-avatar-variants.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
process.env.DSC_CDP = BASE;
const { requireIsolation } = await import('./_env.mjs');

const dataDir = process.env.DSC_DATA_DIR || '';
/** 自建角色的探针 id（ASCII，过 sanitize 不变形） */
const RID = 'avatar-variants-probe';
/** 内置角色的 id */
const BID = 'dsh-deepseek';

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CDP 小工具（跟其它验收脚本同一套） ──────────────────────────────
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
      // 不要在 onmessage 里立刻 close：会让 node 的 ws 在 uv 收尾阶段断言崩掉
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

// ── 造一张真 PNG（8×8 红块） ────────────────────────────────────────
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 4;
      raw[o] = 0xff;
      raw[o + 3] = 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 开跑 ────────────────────────────────────────────────────────────
console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com', 45000);
await evalIn(main, `window.__TAURI_INTERNALS__.invoke('open_settings').then(()=>1).catch(e=>String(e))`);
const settings = await findTarget('settings.html', 25000);
console.log(`[target] settings = ${settings.url.slice(0, 60)}`);
await requireIsolation();

/** 在设置窗口里调一条壳命令，失败直接把错误抛出来（别让断言拿到 undefined 去静默 PASS） */
async function call(expr) {
  const raw = await evalIn(
    settings,
    `(async () => { try { const v = await window.__TAURI_INTERNALS__.invoke(${expr});
        return JSON.stringify({ ok: true, v }); }
      catch (e) { return JSON.stringify({ ok: false, err: String(e) }); } })()`,
  );
  const o = JSON.parse(raw);
  if (!o.ok) throw new Error(`${expr.slice(0, 70)} → ${o.err}`);
  return o.v;
}
const matrix = (id) => call(`'dsc_avatar_matrix', { id: ${id === null ? 'null' : `'${id}'`} }`);
const setVar = (id, variant, b64) =>
  call(`'dsc_avatar_set', { id: '${id}', data: '${b64}', variant: '${variant}' }`);
const setSingle = (id, b64) => call(`'dsc_avatar_set', { id: '${id}', data: '${b64}' }`);
const clearVar = (id, variant) =>
  call(`'dsc_avatar_clear', { id: '${id}', variant: '${variant}' }`);
const clearAll = (id) => call(`'dsc_avatar_clear', { id: '${id}' }`);

// 先收拾上一次跑剩下的（脚本要能反复跑，不能靠"目录是新的"）
await clearAll(RID).catch(() => 0);
await clearAll(BID).catch(() => 0);

const pngB64 = makePng(8, 8).toString('base64');
const NAMES = 'neutral,happy,smug,angry,sad,sleepy,shy';

// ── A. 命令层：矩阵与回落链 ────────────────────────────────────────
const m0 = await matrix(null);
check('内置角色：矩阵有 7 格', m0.length === 7, `n=${m0.length}`);
check('内置角色：变体名与顺序稳定（neutral 必须第一）', m0.map((s) => s.variant).join(',') === NAMES, m0.map((s) => s.variant).join(','));
check('内置角色：7 格全来自内置素材', m0.every((s) => s.source === 'builtin'), JSON.stringify(m0.map((s) => s.source)));
check('★ 7 格尺寸一致（差分铁律：不一致切表情会跳）', new Set(m0.map((s) => `${s.width}x${s.height}`)).size === 1, `${m0[0].width}×${m0[0].height}`);
check('内置角色：用户一格都没传过（hasUser 全 false）', m0.every((s) => s.hasUser === false));

const m1 = await matrix(RID);
check('自建角色没图时：7 格全空', m1.every((s) => s.source === 'none'), JSON.stringify(m1.map((s) => s.source)));
check('空角色的 actual 是空串（不假装有图）', m1.every((s) => s.actual === ''));

// 只给 happy 传一张
await setVar(RID, 'happy', pngB64);
const m2 = await matrix(RID);
const happy2 = m2.find((s) => s.variant === 'happy');
check('传了 happy：那一格变成 user 且 hasUser=true', happy2.source === 'user' && happy2.hasUser === true, JSON.stringify(happy2));
check('只有 happy 那一格变，其余 6 格仍空', m2.filter((s) => s.hasUser).length === 1 && m2.filter((s) => s.source === 'none').length === 6);
check('★ 其余格没跟着"借"到 happy 的图（有差分就不该拿别的表情顶）', m2.filter((s) => s.variant !== 'happy').every((s) => s.source === 'none' && s.actual === ''));

const vpath = dataDir ? join(dataDir, 'avatars', `${RID}-happy.png`) : '';
check('差分落成 <id>-<变体>.png（文件名是判定逻辑的一部分）', !!vpath && existsSync(vpath), vpath);
if (vpath && existsSync(vpath)) {
  const b = readFileSync(vpath);
  check('落盘的是真 PNG（魔数 + 8×8）', b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG' && b.readUInt32BE(16) === 8 && b.readUInt32BE(20) === 8, `${b.length} 字节`);
}

// 再传一张单图（不带 variant）—— 这一张是"整个角色的兜底"
await setSingle(RID, pngB64);
const m3 = await matrix(RID);
check('★ 传了单图：没单独传的格子靠它兜底（source=user, actual=single）', m3.filter((s) => s.variant !== 'happy').every((s) => s.source === 'user' && s.actual === 'single'), JSON.stringify(m3.find((s) => s.variant === 'sad')));
check('★ 但它们的 hasUser 仍是 false —— 单图不属于任何一格', m3.filter((s) => s.variant !== 'happy').every((s) => s.hasUser === false));
check('已经有自己那张的格子不受单图影响（actual 还是 happy）', m3.find((s) => s.variant === 'happy').actual === 'happy', JSON.stringify(m3.find((s) => s.variant === 'happy')));

// 清掉 happy → 回落成借用单图
await clearVar(RID, 'happy');
const m4 = await matrix(RID);
check('清掉 happy：它回落到借用单图（而不是变成"没有"）', m4.find((s) => s.variant === 'happy').actual === 'single', JSON.stringify(m4.find((s) => s.variant === 'happy')));

await clearAll(RID);
const m5 = await matrix(RID);
check('全部清掉：回到一格都没有（单图也一起清了）', m5.every((s) => s.source === 'none' && s.hasUser === false));
check('数据目录里的差分文件也真删了', !vpath || !existsSync(vpath), vpath);

// 自传的图要能盖过内置素材
await setVar(BID, 'smug', pngB64);
const m6 = await matrix(BID);
check('★ 自己传的图能盖过内置素材（那一格 source=user）', m6.find((s) => s.variant === 'smug').source === 'user', JSON.stringify(m6.find((s) => s.variant === 'smug')));
check('只有被盖的那一格变，其余 6 格仍是内置', m6.filter((s) => s.variant !== 'smug').every((s) => s.source === 'builtin'));

// ── B. 界面层：那排格子 ────────────────────────────────────────────
// 立绘卡片在「状态」页签里，而窗口默认停在「人设」—— 必须先切过去，否则
// `#av-slots` 只是个空 div，底下 7 条断言会全红、看着像"功能没做"。
// 这里走**真实点击**（与 verify-avatar.mjs 一致），不直接调内部函数：直接调
// renderStAll() 的话，连"点页签会不会初始化"这层都验不到了。
await evalIn(
  settings,
  `(() => { const b = document.querySelector('.tb-tab[data-tab="state"]'); if (b) b.click(); return !!b; })()`,
);
// 等设置界面把格子画出来（renderStAll 是异步的）
let uiReady = false;
for (let i = 0; i < 40; i++) {
  const n = await evalIn(settings, `document.querySelectorAll('#av-slots .avatar-slot').length`);
  if (n === 7) {
    uiReady = true;
    break;
  }
  await sleep(300);
}
check('#av-slots 里画出了 7 个格子', uiReady);

// 【复位界面状态】`avVariant` 是**页面状态**：上一次跑最后点了哪一格，它就停在那一格
// （exe 不重启就一直在）。不复位的话第二次跑必然假红 —— 这个坑本项目已经踩过两次
// （Quill 的设置页、记忆列表的筛选档），这次先显式点回「默认」再开验。
await evalIn(
  settings,
  `(() => { const b = document.querySelector('#av-slots .avatar-slot[data-variant="neutral"]'); if (b) b.click(); return !!b; })()`,
);
await sleep(800);

const ui = JSON.parse(
  await evalIn(
    settings,
    `(() => {
       const bs = [...document.querySelectorAll('#av-slots .avatar-slot')];
       return JSON.stringify({
         names: bs.map((b) => b.textContent.trim()),
         cls: bs.map((b) => b.className),
         on: bs.filter((b) => b.classList.contains('on')).map((b) => b.dataset.variant),
         dots: bs.filter((b) => b.querySelector('.avatar-slot-dot')).length,
       });
     })()`,
  ),
);
check('格子文案是中文表情名', ui.names.join(',') === '默认,开心,得意,生气,难过,困倦,害羞', ui.names.join(','));
check('每个格子都有状态圆点', ui.dots === 7, `dots=${ui.dots}`);
check('默认选中「默认」那格', ui.on.join(',') === 'neutral', ui.on.join(','));
check('被盖过的 smug 标成 src-user、其余标成 src-builtin', ui.cls.filter((c) => c.includes('src-user')).length === 1 && ui.cls.filter((c) => c.includes('src-builtin')).length === 6, ui.cls.join(' | '));

// 几何：7 格要排成一行、不越界、每格都点得着 —— 这三样恰恰是主人一眼能看出来的，
// 而 DOM 里"有 7 个按钮"完全可能与"它们挤成两行/伸出面板/小到点不中"同时成立。
const geo = JSON.parse(
  await evalIn(
    settings,
    `(() => {
       const box = document.getElementById('av-slots');
       const bs = [...box.querySelectorAll('.avatar-slot')];
       const br = box.getBoundingClientRect();
       const rows = bs.map((b) => Math.round(b.getBoundingClientRect().top));
       const rects = bs.map((b) => {
         const r = b.getBoundingClientRect();
         return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) };
       });
       return JSON.stringify({
         oneRow: new Set(rows).size === 1,
         rows, bw: Math.round(br.width),
         oob: rects.filter((r) => r.right > Math.round(br.right) + 1).length,
         minW: Math.min(...rects.map((r) => r.w)),
         minH: Math.min(...rects.map((r) => r.h)),
       });
     })()`,
  ),
);
check('7 个格子排成一行（没被挤换行）', geo.oneRow, `top=${geo.rows.join(',')} 条宽=${geo.bw}`);
check('格子条没溢出容器右边', geo.oob === 0, `溢出 ${geo.oob} 格`);
check('每格都点得着（宽≥40、高≥28）', geo.minW >= 40 && geo.minH >= 28, `${geo.minW}×${geo.minH}`);

// 点「开心」→ 选中转移 + 预览真换图
const before = await evalIn(settings, `document.getElementById('av-img').src.length`);
await evalIn(
  settings,
  `(() => { const b = [...document.querySelectorAll('#av-slots .avatar-slot')].find((x) => x.dataset.variant === 'happy'); b.click(); return 1; })()`,
);
await sleep(900);
const after = JSON.parse(
  await evalIn(
    settings,
    `(() => {
       const img = document.getElementById('av-img');
       return JSON.stringify({
         on: [...document.querySelectorAll('#av-slots .avatar-slot.on')].map((b) => b.dataset.variant),
         natW: img.naturalWidth, natH: img.naturalHeight, srcLen: img.src.length,
         meta: document.getElementById('av-meta').textContent,
         clear: document.getElementById('av-clear').disabled,
         clearAll: document.getElementById('av-clear-all').disabled,
       });
     })()`,
  ),
);
check('点「开心」后选中态转移过去', after.on.join(',') === 'happy', after.on.join(','));
check('★ 预览真的换成了那张图（naturalWidth>0）', after.natW > 0 && after.natH > 0, `${after.natW}×${after.natH}`);
check('预览内容确实变了（dataURL 长度不同）', after.srcLen !== before, `${before} → ${after.srcLen}`);
check('meta 里写出「开心」和来源', after.meta.includes('开心') && after.meta.includes('内置'), after.meta);
check('内置素材那一格：「清掉这张」是禁用的（没传过就没什么可清）', after.clear === true);
check('被盖过的角色：「全部清掉」是可用的', after.clearAll === false);

// 给「开心」也传一张 → 界面状态要跟着变
await setVar(BID, 'happy', pngB64);
await evalIn(
  settings,
  `(() => { const b = [...document.querySelectorAll('#av-slots .avatar-slot')].find((x) => x.dataset.variant === 'happy'); b.click(); return 1; })()`,
);
await sleep(900);
const after2 = JSON.parse(
  await evalIn(
    settings,
    `(() => {
       const bs = [...document.querySelectorAll('#av-slots .avatar-slot')];
       const h = bs.find((b) => b.dataset.variant === 'happy');
       return JSON.stringify({
         cls: h.className,
         clear: document.getElementById('av-clear').disabled,
         meta: document.getElementById('av-meta').textContent,
         hint: document.getElementById('av-hint').textContent,
       });
     })()`,
  ),
);
check('传过之后那一格变成 src-user', after2.cls.includes('src-user'), after2.cls);
check('传过之后「清掉这张」变成可用', after2.clear === false);
check('meta 说这是「你传的这张」（跟"内置素材"区分开）', after2.meta.includes('你传的这张'), after2.meta);
check('hint 提示清掉会回落', after2.hint.includes('回落'), after2.hint);

// ── 收尾：把探针数据清干净（隔离目录之外一概不碰） ────────────────
await clearAll(RID).catch(() => 0);
await clearAll(BID).catch(() => 0);
const mEnd = await matrix(BID);
check('收尾：内置角色回到全内置（没留下探针覆盖）', mEnd.every((s) => s.source === 'builtin' && !s.hasUser));
check('收尾：数据目录里没剩下探针文件', !dataDir || !existsSync(join(dataDir, 'avatars', `${RID}.png`)));

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
process.exit(failed ? 1 : 0);
