/* 只读截图：真右键一次，把**她自己的动作菜单**拍下来（拍完收起菜单）。
 *
 * 【为什么要动真鼠标】菜单只有真右键才会出来（页面的 contextmenu 事件），
 * 用 CDP 合成事件也行、但那不是主人看到的那条路；这里索性走真的那一条
 * （`.verify/cursor.ps1`，坐标按 DPI 换算，见它的文件头）。
 *
 * 用法：node .verify/shoot-menu.mjs [输出png]
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findTarget, evalIn, sleep } from './_pet-box.mjs';

const OUT = process.argv[2] || 'preview/pet-menu.png';
const PS = join(dirname(fileURLToPath(import.meta.url)), 'cursor.ps1');
const DPI = 1.75;

const cursor = (action, x, y) => {
  const a = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS, '-Action', action, '-Scale', String(DPI)];
  if (x !== undefined) a.push('-X', String(x), '-Y', String(y));
  return execFileSync('powershell', a, { encoding: 'utf8' }).trim();
};

const settings = await findTarget('settings.html', 8000);
const pet = await findTarget('pet.html');
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
const s = await st();
const hb = s.move.hitbox;
cursor('move', Math.round(s.x + (hb.x + hb.w / 2) * DPI), Math.round(s.y + (hb.y + hb.h / 2) * DPI));
await sleep(700);
cursor('rclick');
await sleep(800);

const on = await evalIn(pet, `document.getElementById('menu').classList.contains('on')`);
console.log('菜单开着 = ' + on);
execFileSync(
  'node',
  [join(dirname(fileURLToPath(import.meta.url)), 'shoot-pet.mjs'), OUT, '26,26,34'],
  { stdio: 'inherit' },
);
// 收尾：把菜单收掉，别留一层盖着她
await evalIn(pet, `(() => { window.__DSC_PET_MENU_HIDE__ && window.__DSC_PET_MENU_HIDE__(); return true; })()`);
const [sx, sy] = saved.split(/\s+/).map(Number);
cursor('move', sx, sy);
await sleep(300);
process.exit(0);
