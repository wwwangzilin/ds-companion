/* 排查：把光标挪到她身上，然后问壳"你看到的光标在哪、算不算在她身上"。
 * 用法：node .verify/probe-pet-hover.mjs
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findTarget, evalIn, sleep } from './_pet-box.mjs';

const PS = join(dirname(fileURLToPath(import.meta.url)), 'cursor.ps1');
let DPI = 1.75; // 屏幕缩放（光标 API 在 DPI 不感知的进程里是虚拟坐标，见 cursor.ps1 头）
const cursor = (action, x, y) => {
  const a = [
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
  if (x !== undefined) a.push('-X', String(x), '-Y', String(y));
  return execFileSync('powershell', a, { encoding: 'utf8' }).trim();
};

const settings = await findTarget('settings.html', 8000);
const st = async () =>
  JSON.parse(
    String(
      await evalIn(
        settings,
        `window.__TAURI_INTERNALS__.invoke('dsc_pet_window').then((v) => JSON.stringify(v))`,
      ),
    ),
  );

const saved = cursor('pos');
console.log('原光标 ' + saved);

const before = await st();
console.log('[壳] ' + JSON.stringify({ move: before.move, x: before.x, y: before.y }));

const hb = before.move.hitbox;
const dpr = 1.75;
const physX = Math.round(before.x + (hb.x + hb.w / 2) * dpr);
const physY = Math.round(before.y + (hb.y + hb.h / 2) * dpr);
console.log(`目标物理坐标 ${physX},${physY}`);
cursor('move', physX, physY);
await sleep(900);

const after = await st();
console.log('[壳] ' + JSON.stringify({ move: after.move, scale: after.move.scale, cursor: after.move.cursor, rel: after.move.rel }));

// 真的在那里吗？让页面自己报一下（页面的 clientX 是 CSS px）
const pet = await findTarget('pet.html');
const probe = await evalIn(pet, `JSON.stringify({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})`);
console.log('[页面] ' + probe);

const [sx, sy] = saved.split(/\s+/).map(Number);
cursor('move', sx, sy);
await sleep(300);
console.log('光标已还原');
process.exit(0);
