/* 验收：桌宠的「手脚」—— 命中判定、拖拽跟手、甩抛落地、右键菜单。
 *
 * 【为什么要动真鼠标】这一整套的判定全在壳里：壳每拍问 Win32「光标在哪、左键按着没」，
 * 再和她身体的矩形比。用 CDP 合成事件只能验到页面那一半 —— 合成事件不会移动系统光标，
 * 壳那边的 `GetCursorPos` 一动不动，"命中"永远不成立。所以这里用 user32 的
 * SetCursorPos / mouse_event 真的把光标挪过去、真的按下去（.verify/cursor.ps1）。
 *
 * 【为什么要存/恢复光标位置】测试会把主人的鼠标挪到别处 —— 跑完必须放回去，
 * 不然他下一次动鼠标会发现指针"跳"过。
 *
 * 用法：$env:DSC_CDP_BASE='http://127.0.0.1:9223'; node .verify/verify-pet-hands.mjs
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BASE, findTarget, evalIn, sleep } from './_pet-box.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PS = join(HERE, 'cursor.ps1');
/** 屏幕缩放：光标 API 在 DPI 不感知的进程里是虚拟坐标，脚本按它换算（见 cursor.ps1 头） */
let DPI = 1.75;

function cursor(action, x, y) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    PS,
    '-Action',
    action,
    '-Scale',
    String(DPI),
  ];
  if (x !== undefined) args.push('-X', String(x), '-Y', String(y));
  return execFileSync('powershell', args, { encoding: 'utf8' }).trim();
}

const checks = [];

// ── 找设置窗口（`dsc_pet_window` 只给设置窗口权限）──
const settings = await findTarget('settings.html').catch(() => null);
if (!settings) throw new Error('设置窗口没开（要先 open_settings）');
const winState = async () =>
  JSON.parse(
    String(
      await evalIn(
        settings,
        `window.__TAURI_INTERNALS__.invoke('dsc_pet_window').then(v => JSON.stringify(v))`,
      ),
    ),
  );

const pet = await findTarget('pet.html');
// 起手先确保没有上一轮留下的菜单：菜单开着的时候命中框按整个窗口算，
// 后面每一条"点她 / 拖她"都会被它吃掉（本小姐被这个坑掉过一整轮）。
await evalIn(pet, `(() => { window.__DSC_PET_MENU_HIDE__ && window.__DSC_PET_MENU_HIDE__(); return true; })()`);
await sleep(400);
const live = async () =>
  JSON.parse(String(await evalIn(pet, `JSON.stringify(window.__DSC_PET_ANIM__())`)));

let st = await winState();
console.log('[窗口] ' + JSON.stringify(st.move));
if (!st.open) throw new Error('桌宠窗口没开');

// 等她量好自己（fit 完成 = 命中框报上来了）
for (let i = 0; i < 40; i++) {
  st = await winState();
  if (st.move && st.move.hitbox) break;
  await sleep(500);
}
if (!st.move || !st.move.hitbox) throw new Error('命中框一直没报上来：' + JSON.stringify(st.move));
const hb = st.move.hitbox;
console.log(`[命中框] ${JSON.stringify(hb)}  dpr=${st.width / 201}`);

const dpr = Math.round((st.width / 201) * 100) / 100 || 1.75;
// 她身体中心在屏幕上的物理坐标
const herX = Math.round(st.x + (hb.x + hb.w / 2) * dpr);
const herY = Math.round(st.y + (hb.y + hb.h / 2) * dpr);
const farX = Math.round(st.x - 400);
const farY = Math.round(st.y - 300);

const saved = cursor('pos');
console.log(`[光标] 原位置 ${saved} → 目标 ${herX},${herY}（她身上）`);

try {
  // ── ① 光标离开她 → 壳该把穿透打开 ──
  cursor('move', farX, farY);
  await sleep(600);
  st = await winState();
  checks.push(['光标不在她身上时：窗口是穿透的', st.move.ignoringCursor === true, `${st.move.ignoringCursor}`]);

  // ── ② 光标移到她身上 → 壳该把穿透关掉（她才接得住鼠标）──
  cursor('move', herX, herY);
  await sleep(800);
  st = await winState();
  checks.push(['光标落在她身上时：窗口接手鼠标', st.move.ignoringCursor === false, `${st.move.ignoringCursor}`]);

  // ── ③ 点一下（不拖动）→ 应该播一段"点击回应"，而且窗口不该挪窝 ──
  const before = (await winState()).move.pos;
  const idleAt = (await live()).playing;
  cursor('click');
  await sleep(1200);
  const afterClick = await live();
  st = await winState();
  checks.push([
    '点一下她：有回应（换了一段动作）',
    afterClick.playing && afterClick.playing !== idleAt,
    `${idleAt} → ${afterClick.playing}`,
  ]);
  checks.push([
    '点一下她：她没被挪走（算点击不算拖）',
    Math.abs(st.move.pos.x - before.x) < 6 && Math.abs(st.move.pos.y - before.y) < 6,
    `${JSON.stringify(before)} → ${JSON.stringify(st.move.pos)}`,
  ]);

  // ── ④ 拖着走 → 窗口应该跟手移动 ──
  const p0 = (await winState()).move.pos;
  cursor('move', herX, herY);
  await sleep(200);
  cursor('down');
  await sleep(200);
  for (let i = 1; i <= 8; i++) {
    cursor('move', herX - i * 22, herY - i * 6);
    await sleep(60);
  }
  const dragging = await live();
  const pMid = (await winState()).move.pos;
  checks.push([
    '拖她的过程中：窗口跟着光标走',
    pMid.x < p0.x - 60,
    `${JSON.stringify(p0)} → ${JSON.stringify(pMid)}`,
  ]);
  checks.push(['拖她的过程中：她摆的是"被拎起来"那段', !!dragging.playing, String(dragging.playing)]);

  // ── ⑤ 甩出去 → 松手之后窗口还在动（物理接管），最后停下来 ──
  //
  // 【为什么必须是"一个进程里连着挪"】每次调 cursor.ps1 都要起一个 PowerShell（300-500ms），
  // 用连续的 'move' 拼速度的话光标是"爬"过去的（实测 ~100px/s），松手速度低于甩抛阈值
  // （220px/s），物理根本不会启动 —— 那是测试的毛病，不是产品的。'throw' 在一个进程里
  // 12 步快移 + 松手，才是真的甩。
  cursor('throw', herX - 700, herY - 260);
  await sleep(120);
  const flying = await winState();
  const seen = [];
  // 【为什么给 6 秒】碰壁恢复系数 0.78：一次抛掷要弹五六下才停，实测 3-4 秒。
  // 只等 2.9 秒的话会报"她一直在飞"——那是等得不够，不是她停不下来。
  for (let i = 0; i < 60; i++) {
    const s = await winState();
    seen.push(s.move.busy);
    if (!s.move.busy) break;
    await sleep(120);
  }
  const settled = await winState();
  checks.push([
    '甩出去之后：物理接管了（松手时还在动）',
    flying.move.busy === true || seen.some(Boolean),
    `busy=${flying.move.busy} 观测=${seen.filter(Boolean).length} 拍`,
  ]);
  checks.push([
    '最后她自己停下来了（不会一直飞）',
    settled.move.busy === false,
    `busy=${settled.move.busy}`,
  ]);
  checks.push([
    '她被甩到了别的地方（位置真的变了）',
    Math.abs(settled.move.pos.x - p0.x) > 40,
    `${JSON.stringify(p0)} → ${JSON.stringify(settled.move.pos)}`,
  ]);

  // ── ⑥ 右键 → 菜单该出来，而且这期间窗口仍然接手鼠标（不然菜单点不动）──
  // 【为什么坐标要重算】上一步刚把她甩到别的地方，`herX/herY` 是**开跑时**算的，
  // 早就落不到她身上了 —— 右键点空处，菜单当然不出来（这一条坑过一整轮）。
  const now = await winState();
  const hb2 = now.move.hitbox;
  cursor('move', Math.round(now.x + (hb2.x + hb2.w / 2) * DPI), Math.round(now.y + (hb2.y + hb2.h / 2) * DPI));
  await sleep(500);
  const menuPoint = await winState();
  if (menuPoint.move.ignoringCursor === false) {
    cursor('rclick');
    await sleep(600);
    const menuOn = await evalIn(pet, `document.getElementById('menu').classList.contains('on')`);
    const rows = await evalIn(pet, `document.querySelectorAll('#menu .row').length`);
    checks.push(['右键弹出了动作菜单', menuOn === true, `on=${menuOn}`]);
    checks.push(['菜单里有东西可点（分组 / 动作）', rows > 3, `${rows} 行`]);
    const stillMine = await winState();
    checks.push([
      '菜单开着的时候窗口仍然接手鼠标（不然点不动）',
      stillMine.move.ignoringCursor === false,
      `${stillMine.move.ignoringCursor}`,
    ]);
    // 收尾：把菜单关掉（点一下菜单外面 = 页面里 dispatch 一次就行）
    await evalIn(pet, `(() => { const e = new MouseEvent('contextmenu'); document.dispatchEvent(e); return true; })()`);
    await evalIn(pet, `(() => { window.__DSC_PET_MENU_HIDE__ && window.__DSC_PET_MENU_HIDE__(); return true; })()`);
    await sleep(400);
    const closed = await evalIn(pet, `document.getElementById('menu').classList.contains('on')`);
    checks.push(['能收起来（不留一个盖住她的菜单）', closed === false, `on=${closed}`]);
    await sleep(500);
    const after = await winState();
    checks.push([
      '菜单收起来之后：命中框回到"她本人"那么大',
      after.move.hitbox && after.move.hitbox.w < 260,
      `w=${after.move.hitbox && after.move.hitbox.w}`,
    ]);
  } else {
    checks.push(['右键前：窗口接手鼠标（前置条件）', false, `${menuPoint.move.ignoringCursor}`]);
  }

  // ── ⑦ 回到角落 ──
  await evalIn(pet, `window.__TAURI_INTERNALS__.invoke('dsc_pet_home').then(() => true)`);
  await sleep(700);
  const home = await winState();
  checks.push([
    '「回角落」把她送回右下角',
    home.move.pos.x > home.move.screen.maxX - 300,
    `${JSON.stringify(home.move.pos)} / 右边界 ${home.move.screen.maxX}`,
  ]);
} finally {
  // 不管成没成，先把鼠标放回主人原来在的地方
  const [sx, sy] = saved.split(/\s+/).map(Number);
  if (Number.isFinite(sx) && Number.isFinite(sy)) cursor('move', sx, sy);
}

let bad = 0;
console.log('');
for (const [name, ok, ev] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${ev}`);
}
console.log('');
console.log(bad === 0 ? `★ 全过：${checks.length}/${checks.length} ★` : `${checks.length - bad}/${checks.length} 过`);
await sleep(200);
process.exit(bad === 0 ? 0 : 1);
