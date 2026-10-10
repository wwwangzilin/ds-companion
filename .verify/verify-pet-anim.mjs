/* 验收：桌宠的动作素材那条路（从 dsh-pet 摘的透明 webm）。
 *
 * 【两条路都要验，而且要在**真的没有素材**的环境里验第二条】
 *   装了素材 → 走视频；没装 → 回落立绘。回落那条不能只在代码里"看着对"：
 *   它恰恰是"新机器/忘了下素材"时的唯一出路，而那种时候没人会去仔细看。
 *   所以脚本带 --expect=video|png，由外面的 PowerShell 分别跑两次（一次真实数据目录、
 *   一次空的 DSC_DATA_DIR 隔离目录）。单实例锁决定了不能在同一个进程里切两遍。
 *
 * 【为什么断言 readyState / videoWidth，而不是"DOM 里有 video"】
 *   `<video>` 标签永远在那儿（写在 pet.html 里）；"有标签"证明不了它在放东西。
 *   只有 readyState >= 2（有当前帧）且 videoWidth > 0（尺寸也解出来了）才算**真的出画**。
 *   这和项目里"图片类验收必须断言 naturalWidth > 0"是同一条规矩。
 *
 * 用法：$env:DSC_CDP='http://127.0.0.1:9223'; node .verify/verify-pet-anim.mjs --expect=video
 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPECT = (() => {
  const a = process.argv.find((x) => x.startsWith('--expect='));
  return a ? a.split('=')[1] : 'video';
})();

function send(target, method, params = {}, timeoutMs = 90000) {
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

async function evalIn(target, expression, timeoutMs = 90000) {
  const r = await send(
    target,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r && r.result ? r.result.value : undefined;
}

async function findTarget(match, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await (await fetch(`${BASE}/json/list`)).json().catch(() => []);
    const t = (list || []).find((x) => x.url && x.url.includes(match));
    if (t) return t;
    if (Date.now() > deadline) throw new Error('等不到 ' + match);
    await sleep(300);
  }
}

const view = async (pet) =>
  JSON.parse(String(await evalIn(pet, `JSON.stringify(window.__DSC_PET_VIEW__ || null)`)));

console.log(`[cdp] ${BASE}  期望模式 = ${EXPECT}`);
const pet = await findTarget('pet.html');
// 等第一拍跑完（tick 是异步的：先问壳再画）
let v = null;
for (let i = 0; i < 30; i++) {
  v = await view(pet).catch(() => null);
  if (v && (EXPECT === 'png' ? v.mode === 'png' : v.mode === 'video' && v.clip)) break;
  await sleep(500);
}
console.log('[视图] ' + JSON.stringify(v));
if (!v) throw new Error('桌宠页面没给出 __DSC_PET_VIEW__');

const checks = [];

if (EXPECT === 'video') {
  checks.push(['壳报了已装的素材', v.clips >= 6, `${v.clips} 段`]);
  checks.push(['走的是视频那条路', v.mode === 'video', v.mode]);
  checks.push(['在播待机那段', v.clip === '待机呼吸休闲', String(v.clip)]);
  // ★这两条才是"真的出画"★
  checks.push(['待机视频真的解出了帧（readyState>=2）', v.readyState >= 2, `readyState=${v.readyState}`]);
  checks.push([
    '待机视频真的有尺寸（videoWidth>0）',
    v.videoW > 0 && v.videoH > 0,
    `${v.videoW}x${v.videoH}`,
  ]);
  checks.push([
    '视频那层是可见的（opacity 生效）',
    await evalIn(
      pet,
      `(() => { const a = document.getElementById('anim-a'), b = document.getElementById('anim-b');
         const on = a.classList.contains('on') ? a : b;
         return getComputedStyle(on).opacity === '1'; })()`,
    ),
    '看 computedStyle',
  ]);
  checks.push([
    'CSS 那个"呼吸"关掉了（别和素材自己的动打架）',
    await evalIn(pet, `getComputedStyle(document.getElementById('stage')).animationName === 'none'`),
    '看 animation-name',
  ]);

  // ── 点播一段"回应"，验反应那条路 ──
  // 【为什么先打一份诊断】"点了没反应"可能是壳取不到素材、也可能是页面没换层 ——
  // 这两件事的修法完全不同，凭猜会查错方向。先把两边的事实摆出来。
  const diag = await evalIn(
    pet,
    `(async () => {
       const inv = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
         || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
       let r;
       try { r = await inv('dsc_pet_clip', { name: '点击回应-傲娇生气' }); }
       catch (e) { r = { ipcError: String(e) }; }
       const snap = (id) => {
         const el = document.getElementById(id);
         return { on: el.classList.contains('on'), rs: el.readyState,
                  src: String(el.src || '').slice(0, 22), w: el.videoWidth };
       };
       return JSON.stringify({
         ok: r && r.ok, why: r && r.why, ipcError: r && r.ipcError,
         bytes: r && r.bytes, urlLen: r && r.dataUrl ? r.dataUrl.length : 0,
         a: snap('anim-a'), b: snap('anim-b'),
       });
     })()`,
  );
  console.log('[诊断] ' + diag);

  await evalIn(pet, `(() => { window.__DSC_PET_PLAY__('点击回应-傲娇生气', false); return true; })()`);
  await sleep(1500);
  // ★读**实时**探针，不读 tick 时拍的那个快照★ —— 点播不触发 tick，快照会是上一段
  const anim = JSON.parse(String(await evalIn(pet, `JSON.stringify(window.__DSC_PET_ANIM__())`)));
  console.log('[点播后·实时] ' + JSON.stringify(anim));
  checks.push(['点播的那段在播', anim.playing === '点击回应-傲娇生气', String(anim.playing)]);
  checks.push([
    '点播的那段真的出画了（当前层 rs>=2 且 w>0）',
    anim.onReadyState >= 2 && anim.onWidth > 0,
    `rs=${anim.onReadyState} ${anim.onWidth}px`,
  ]);
  checks.push([
    '换到了另一层（交叉淡入，不是原地换 src）',
    anim.layerA.on !== anim.layerB.on,
    `a=${anim.layerA.on} b=${anim.layerB.on}`,
  ]);
  // 播完自己回待机（反应段是非循环的）
  let back = null;
  for (let i = 0; i < 40; i++) {
    back = JSON.parse(String(await evalIn(pet, `JSON.stringify(window.__DSC_PET_ANIM__())`)));
    if (back.playing === '待机呼吸休闲') break;
    await sleep(500);
  }
  checks.push(['反应播完自己回待机', back && back.playing === '待机呼吸休闲', String(back && back.playing)]);
} else {
  // ── 没装素材那条路 ──
  checks.push(['壳报的素材是空的', v.clips === 0, `${v.clips} 段`]);
  checks.push(['回落到了立绘那条路', v.mode === 'png', v.mode]);
  checks.push([
    '立绘真的画出来了（img naturalWidth>0）',
    await evalIn(
      pet,
      `(() => { const a = document.getElementById('layer-a'), b = document.getElementById('layer-b');
         const on = a.classList.contains('on') ? a : b;
         return on.naturalWidth > 0; })()`,
    ),
    '看 naturalWidth',
  ]);
  checks.push([
    '视频那对图层是隐藏的（不能挡住立绘）',
    await evalIn(
      pet,
      `getComputedStyle(document.getElementById('anim-a')).opacity === '0' &&
       getComputedStyle(document.getElementById('anim-b')).opacity === '0'`,
    ),
    '看 opacity',
  ]);
  checks.push([
    '"呼吸"回来了（立绘不动就像贴纸）',
    await evalIn(pet, `getComputedStyle(document.getElementById('stage')).animationName !== 'none'`),
    '看 animation-name',
  ]);
}

let bad = 0;
console.log('');
for (const [name, ok, ev] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${ev}`);
}
console.log('');
console.log(bad === 0 ? `★ 全过：${checks.length}/${checks.length}（${EXPECT}）★` : `${checks.length - bad}/${checks.length} 过`);
process.exit(bad === 0 ? 0 : 1);
