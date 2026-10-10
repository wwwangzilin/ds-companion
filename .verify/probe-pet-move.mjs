/* 只读探针：桌宠的「手脚」现在是什么状态（壳那边的命中框 / 穿透 / 在不在动 / 位置）。
 *
 * 【为什么单独一个】验收脚本挂在半路时，第一件事就是问"壳还活着吗、它现在穿不穿透" ——
 * 而 PowerShell 里拼 `=>` 会被当成重定向符（踩过好几次），所以一律走 .mjs。
 *
 * 用法：node .verify/probe-pet-move.mjs
 */
import { BASE, findTarget, evalIn } from './_pet-box.mjs';

const settings = await findTarget('settings.html', 8000).catch(() => null);
if (!settings) {
  console.log('设置窗口没开（先开它：node .verify/probe-open-settings.mjs 9223）');
  process.exit(1);
}
const st = JSON.parse(
  String(
    await evalIn(
      settings,
      `window.__TAURI_INTERNALS__.invoke('dsc_pet_window').then((v) => JSON.stringify(v))`,
    ),
  ),
);
console.log(JSON.stringify(st, null, 2));
process.exit(0);
