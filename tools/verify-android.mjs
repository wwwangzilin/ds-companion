// 一键验证 ds-companion 的 Android 注入：装 APK -> 启动 -> 抓 logcat -> 按判据出结论。
//
// 用法：node tools/verify-android.mjs
// 前置：① 手机连着（USB 调试已授权）② gen/android 已经构建出 APK
//
// 判据（两条都要有）：
//   ① `[dsc] 首次注入 readyState=... htmlLen=... xhrNative=...`
//      —— 注入脚本在页面里跑起来了。同一行还顺带告诉我们"时机好不好"：
//         readyState=loading + htmlLen 很小 + xhrNative=true 就是 document-start 级别
//         （与桌面端等价；PoC 实测见 docs/android/README.md 第 6 节）
//   ② `[dsc] 重复注入已跳过 #N`
//      —— 幂等守卫生效。Android 上初始化脚本会执行两次（wry 的两个机制都会触发），
//         没有这道守卫的话 XHR/fetch 钩子会叠两层、body.prompt 被改写两次
//
// 为什么要脚本而不是手敲 adb：手敲容易"看到一屏日志就以为成功了"。判据写成断言，
// 跑完直接给结论；失败时也直接告诉你缺哪一条、下一步查什么。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const PKG = 'com.dscompanion.probe';
const APK = join(
  root,
  'src-tauri',
  'gen',
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'arm64',
  'debug',
  'app-arm64-debug.apk',
);
const WAIT_SECONDS = 18;

function adb(args) {
  return execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}
function ok(msg) {
  console.log('✓ ' + msg);
}
/** logcat 那行前面的 tag/时间戳都去掉，只留正文，读起来干净 */
function body(line) {
  return line.replace(/^.*?Msg: /, '').trim();
}

if (!existsSync(APK)) {
  fail(`APK 不存在：\n    ${APK}\n  先在 src-tauri/gen/android 里跑一次 assembleArm64Debug`);
}

let devices;
try {
  devices = adb(['devices'])
    .split('\n')
    .slice(1)
    .filter((l) => l.trim() && /\tdevice\b/.test(l));
} catch (e) {
  fail(`执行 adb 失败：${e.message}\n  adb 在 PATH 里吗？或者先 . D:\\android-tools\\env.ps1`);
}
if (devices.length === 0) {
  fail('没有已授权的设备。插上手机、打开 USB 调试，并在手机上点"允许调试"。');
}
ok(`设备：${devices[0].trim()}`);

console.log('… 安装 APK');
const installOut = adb(['install', '-r', APK]);
if (!/Success/i.test(installOut)) fail(`安装失败：${installOut.trim()}`);
ok('安装成功');

adb(['logcat', '-c']);
adb(['shell', 'am', 'start', '-n', `${PKG}/.MainActivity`]);
console.log(`… 等 ${WAIT_SECONDS} 秒（页面加载 + 注入 + 首次请求）`);
await new Promise((r) => setTimeout(r, WAIT_SECONDS * 1000));

const log = adb(['logcat', '-d']);
const lines = log.split('\n');
const dscLines = lines.filter((l) => l.includes('[dsc]'));

console.log('\n--- 抓到的注入日志 ---');
if (dscLines.length === 0) console.log('  （一条都没有）');
for (const l of dscLines) console.log('  ' + body(l));

const first = dscLines.find((l) => l.includes('首次注入'));
const skipped = dscLines.find((l) => l.includes('重复注入已跳过'));

console.log('\n--- 判据 ---');
let allPass = true;

if (first) {
  const rs = /readyState=(\w+)/.exec(first)?.[1];
  const hl = /htmlLen=(-?\d+)/.exec(first)?.[1];
  const xn = /xhrNative=(\w+)/.exec(first)?.[1];
  ok('① 注入脚本跑起来了');
  console.log(`   时机：readyState=${rs}  htmlLen=${hl}  xhrNative=${xn}`);
  if (rs === 'loading' && xn === 'true') {
    ok('   document-start 级别：文档还在加载、XHR 还是原生实现（与桌面端等价）');
  } else {
    console.log('   ⚠ 不是最理想的时机 —— 但如果首个请求晚于注入（几百 ms 以上）仍然可用');
  }
} else {
  allPass = false;
  console.log('✗ ① 没找到「首次注入」—— 注入没生效，或者页面根本没加载');
}

if (skipped) {
  ok(`② 幂等守卫生效（${body(skipped)}）`);
} else {
  allPass = false;
  console.log('✗ ② 没找到「重复注入已跳过」');
  console.log('   注：只在 Android 上该出现（桌面端只注入一次）；没有它意味着钩子可能叠了两层');
}

console.log('\n--- 页面加载（用来判断"到底加载成功没有"）---');
const pageLines = lines.filter((l) => /page_load|pageLoad|dsc-companion/.test(l));
if (pageLines.length === 0) console.log('  （没有相关日志）');
for (const l of pageLines.slice(-6)) console.log('  ' + l.trim().slice(0, 160));

console.log('\n--- 结论 ---');
if (allPass) {
  console.log('通过：注入生效 + 幂等守卫生效。');
  process.exit(0);
}
console.log('未通过。上面标 ✗ 的那条就是缺口；若是 ①，先确认页面本身加载了：');
console.log(`  adb logcat -d | Select-String ${PKG}`);
process.exit(2);
