/* 验收：桌宠那个「动作素材 / 立绘」开关，**双向**都真的接通了。
 *
 * 【为什么要单独验它】pet.js 那边"clips 空就回落立绘"已经单独验过了（verify-pet-anim 跑两遍）。
 * 剩下没验的是**接线**：设置页那个开关 → 配置 → 壳算出来的 `clips` → 桌宠换画法。
 * 这条链断在哪一段，表现都是"点了没反应"，光看代码看不出来。
 *
 * 【为什么要还原】**这条会真写主人的配置**（就一个布尔字段）。所以：
 *   记下原值 → 翻过去 → 验 → 翻回来 → 断言和原值一致。
 * 没还原成功会 FAIL 在最后一条上，不会静默留着。
 * 项目以前吃过"验收脚本污染真实数据"的亏（见 README 的坑表），所以这条必须自带兜底。
 *
 * 用法：$env:DSC_CDP='http://127.0.0.1:9223'; $env:DSC_ALLOW_REAL_DATA='1'; node .verify/verify-pet-toggle.mjs
 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function listTargets() {
  try {
    return await (await fetch(`${BASE}/json/list`)).json();
  } catch {
    return [];
  }
}
async function findTarget(match, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = (await listTargets()).find((x) => x.url && x.url.includes(match));
    if (t) return t;
    if (Date.now() > deadline) throw new Error('等不到 ' + match);
    await sleep(300);
  }
}

console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com');
let settings = (await listTargets()).find((x) => x.url && x.url.includes('settings.html'));
if (!settings) {
  await evalIn(
    main,
    `(async () => { const inv = window.__TAURI_INTERNALS__.invoke; await inv('open_settings'); return true; })()`,
  ).catch(() => {});
  settings = await findTarget('settings.html', 25000);
}

/** 在设置窗口里**真点一下那个开关** —— 走页面自己的 change 处理器（= 主人点的那条路）
 *
 * 【为什么不直接 config_set】那样绕过了开关自己的事件处理器，等于"用配置去验配置"：
 * 开关→配置 这个方向压根没测到，而它断了的表现**正好**也是"点了没反应"。
 * 本小姐第一版就是这么写的，被自己骗了一轮（读到的复选框还是上一轮刷新留下的旧值）。
 */
const clickSwitch = `(async () => {
  const el = document.getElementById('pet-anim');
  el.click();
  await new Promise((r) => setTimeout(r, 900));
  const cfg = await window.__TAURI_INTERNALS__.invoke('config_get');
  return JSON.stringify({ checked: el.checked, cfg: !!cfg.petAnim });
})()`;

/** 通用版：点某个开关 → 读它自己和配置里对应的那个字段 */
const clickSwitchOf = (id, field) => `(async () => {
  const el = document.getElementById('${id}');
  el.click();
  await new Promise((r) => setTimeout(r, 700));
  const cfg = await window.__TAURI_INTERNALS__.invoke('config_get');
  return JSON.stringify({ checked: el.checked, cfg: cfg.${field} !== false });
})()`;

const readSwitch = (id, field) => `(async () => {
  const cfg = await window.__TAURI_INTERNALS__.invoke('config_get');
  return JSON.stringify({ checked: document.getElementById('${id}').checked, cfg: cfg.${field} !== false });
})()`;

const readPet = async (pet) =>
  JSON.parse(String(await evalIn(pet, `JSON.stringify(window.__DSC_PET_VIEW__ || null)`)));

const checks = [];
const pet = await findTarget('pet.html');

const cfgNow = async () =>
  JSON.parse(
    String(
      await evalIn(
        settings,
        `(async () => JSON.stringify({ v: !!(await window.__TAURI_INTERNALS__.invoke('config_get')).petAnim, checked: document.getElementById('pet-anim').checked }))()`,
      ),
    ),
  );

const before = await cfgNow();
console.log('[原值] petAnim = ' + before.v + '  开关画的是 = ' + before.checked);

// 让开关与配置对齐（正常情况下本来就该一致 —— 这条本身也是个断言）
if (before.checked !== before.v) {
  console.log('[注意] 开关画的和配置不一致，先对齐');
  await evalIn(settings, clickSwitch);
}
checks.push(['打开时开关画的就是配置里的值', (await cfgNow()).checked === before.v, '看 checked']);

try {
  // ── 点一下：关掉 → 桌宠该走立绘 ──
  const off = JSON.parse(String(await evalIn(settings, clickSwitch)));
  checks.push(['点一下 → 配置真的写进去了', off.cfg === false, `petAnim=${off.cfg}`]);
  checks.push(['点一下 → 开关自己也画成关的', off.checked === false, String(off.checked)]);
  // 开关一变壳会 ping 桌宠（push_config 那条路）；ping 丢了还有 tick 兜底，所以催一下
  await evalIn(pet, `(window.__DSC_PET_TICK__ ? window.__DSC_PET_TICK__() : null); true`);
  await sleep(1200);
  const petOff = await readPet(pet);
  console.log('[关掉后] ' + JSON.stringify({ mode: petOff.mode, clips: petOff.clips }));
  checks.push(['关掉 → 桌宠报的素材是空的', petOff.clips === 0, `${petOff.clips} 段`]);
  checks.push(['关掉 → 回落立绘', petOff.mode === 'png', petOff.mode]);

  // ── 再点一下：开回来 → 该走动作素材 ──
  const on = JSON.parse(String(await evalIn(settings, clickSwitch)));
  checks.push(['再点一下 → 配置写回来了', on.cfg === true, `petAnim=${on.cfg}`]);
  checks.push(['再点一下 → 开关画成开的', on.checked === true, String(on.checked)]);
  await evalIn(pet, `(window.__DSC_PET_TICK__ ? window.__DSC_PET_TICK__() : null); true`);
  await sleep(1500);
  const petOn = await readPet(pet);
  console.log('[开回来] ' + JSON.stringify({ mode: petOn.mode, clips: petOn.clips }));
  checks.push(['开回来 → 素材回来了', petOn.clips >= 6, `${petOn.clips} 段`]);
  checks.push(['开回来 → 走回视频那条路', petOn.mode === 'video', petOn.mode]);
  // ── 另外两个开关：接不接鼠标 / 会不会自己动 ──
  // 【为什么要分开验】它们是**行为**开关：写进配置只是第一步，桌宠那边得真的读到、
  // 真的改行为。所以两边都断言：配置里的值 + 桌宠报出来的值（pet_interact 那条会
  // 直接决定壳吃不吃鼠标，错了的表现是"她挡路"或者"点不到她"）。
  const beforeSwitch = async (id, field) =>
    JSON.parse(String(await evalIn(settings, readSwitch(id, field))));
  const petFlags = async () => {
    await evalIn(pet, `(window.__DSC_PET_TICK__ ? window.__DSC_PET_TICK__() : null); true`);
    await sleep(900);
    return await readPet(pet);
  };

  const i0 = await beforeSwitch('pet-interact', 'petInteract');
  const off1 = JSON.parse(String(await evalIn(settings, clickSwitchOf('pet-interact', 'petInteract'))));
  checks.push(['「接得住鼠标」开关 → 配置写进去了', off1.cfg === !i0.cfg, `petInteract=${off1.cfg}`]);
  const pv1 = await petFlags();
  checks.push([
    '「接得住鼠标」开关 → 桌宠那边真的读到了',
    pv1.interact === off1.cfg,
    `桌宠报 interact=${pv1.interact}，配置=${off1.cfg}`,
  ]);
  const on1 = JSON.parse(String(await evalIn(settings, clickSwitchOf('pet-interact', 'petInteract'))));
  checks.push(['「接得住鼠标」开关 → 再点一下切回来', on1.cfg === i0.cfg, `petInteract=${on1.cfg}`]);

  const w0 = await beforeSwitch('pet-wander', 'petWander');
  const off2 = JSON.parse(String(await evalIn(settings, clickSwitchOf('pet-wander', 'petWander'))));
  checks.push(['「自己动」开关 → 配置写进去了', off2.cfg === !w0.cfg, `petWander=${off2.cfg}`]);
  const pv2 = await petFlags();
  checks.push([
    '「自己动」开关 → 桌宠那边真的读到了',
    pv2.wander === off2.cfg,
    `桌宠报 wander=${pv2.wander}，配置=${off2.cfg}`,
  ]);
  const on2 = JSON.parse(String(await evalIn(settings, clickSwitchOf('pet-wander', 'petWander'))));
  checks.push(['「自己动」开关 → 再点一下切回来', on2.cfg === w0.cfg, `petWander=${on2.cfg}`]);
  const i1 = await petFlags();
  checks.push(['两个开关都回到原位', i1.interact === i0.cfg && i1.wander === w0.cfg, `interact=${i1.interact} wander=${i1.wander}`]);

  // ── 工作状态那一档（events.workStatus）：她干活时的样子 ──
  // 【为什么要真调一次】档位是**注入层**在对话那几个瞬间报给壳的（dsc_pet_stage）。
  // 不真报一次，这条链就只能靠"读代码觉得对"。这里从主窗口报一个 success，
  // 断言她换成"工作状态-*"里的某一段。
  const workPool = await evalIn(
    pet,
    `(async () => {
       const inv = window.__TAURI_INTERNALS__.invoke;
       const s = await inv('dsc_pet_state', { have: null });
       return JSON.stringify((s.pools && s.pools.events && s.pools.events.workStatus) || []);
     })()`,
  );
  const pool = JSON.parse(String(workPool));
  if (!pool.length) {
    console.log('[跳过] 没装工作状态素材（fetch-pet-assets 还没下到那几段）');
  } else {
    await evalIn(
      main,
      `(async () => { await window.__TAURI_INTERNALS__.invoke('dsc_pet_stage', { stage: 'success' }); return true; })()`,
    );
    let got = '';
    for (let i = 0; i < 16; i++) {
      const anim = JSON.parse(String(await evalIn(pet, `JSON.stringify(window.__DSC_PET_ANIM__())`)));
      got = anim.playing;
      if (got && got.indexOf('工作状态') === 0) break;
      await sleep(400);
    }
    checks.push(['报一档工作状态 → 她播对应的那一段', got.indexOf('工作状态') === 0, String(got)]);
  }
} finally {
  // ★还原★：不管上面炸在哪，都把配置写回原值（照样走开关那条路）
  const cur = await cfgNow().catch(() => null);
  if (cur && cur.v !== before.v) {
    await evalIn(settings, clickSwitch).catch(() => {});
    await sleep(500);
  }
}

const after = await cfgNow();
checks.push([
  '★配置还原成原值了（不污染主人的设置）★',
  after.v === before.v && after.checked === before.v,
  `${before.v} → ${after.v}（开关画的是 ${after.checked}）`,
]);

let bad = 0;
console.log('');
for (const [name, ok, ev] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${ev}`);
}
console.log('');
console.log(bad === 0 ? `★ 全过：${checks.length}/${checks.length} ★` : `${checks.length - bad}/${checks.length} 过`);
process.exit(bad === 0 ? 0 : 1);
