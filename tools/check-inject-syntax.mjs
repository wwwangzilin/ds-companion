// 校验注入脚本拼接后的语法。
//
// Rust 侧（src-tauri/src/main.rs）用 concat! 把 inject/ 下的 9 个文件拼成一个大 script，
// 外面包一层幂等守卫（window.__DSC_INJECTED__）。这个脚本用同样的方式在 node 里拼一遍，
// 保证：①每个文件单独合法；②拼起来 + 守卫包裹后依然合法。
//
// 为什么需要它：Rust 的 concat! 只保证字符串能拼上，不保证拼出来的是合法 JS。
// 而注入脚本一旦语法错，页面里是**静默失败**（WebView 只往 logcat 打一行），
// 桌面端更难发现。这个脚本 1 秒就能跑完，放进每次改注入脚本后的自检里。
//
// 用法：node tools/check-inject-syntax.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const injectDir = join(here, '..', 'src-tauri', 'inject');

// 顺序必须与 main.rs 里的 INJECT_BODY 完全一致
const files = [
  'selector.js',
  'inject.js',
  'deepseek-client.js',
  'extract.js',
  'sense.js',
  'tools.js',
  'tool-loop.js',
  'confirm.js',
  'empty-reply.js',
];

let failed = 0;

for (const f of files) {
  const src = readFileSync(join(injectDir, f), 'utf8');
  try {
    new Function(src);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${f}: ${e.message}`);
  }
}
console.log(failed === 0 ? `✓ ${files.length} 个文件单独语法 OK` : `✗ ${failed} 个文件有语法错误`);

const body = files.map((f) => readFileSync(join(injectDir, f), 'utf8')).join('\n');
const guarded =
  "if (window.__DSC_INJECTED__) {\n" +
  "  window.__DSC_INJECTED_AGAIN__ = (window.__DSC_INJECTED_AGAIN__ || 0) + 1;\n" +
  "  console.log('[dsc] 重复注入已跳过 #' + window.__DSC_INJECTED_AGAIN__);\n" +
  "} else {\n" +
  "  window.__DSC_INJECTED__ = true;\n" +
  "  console.log('[dsc] 首次注入 readyState=' + document.readyState + ' htmlLen=' + (document.documentElement ? document.documentElement.innerHTML.length : -1) + ' xhrNative=' + (/\\[native code\\]/.test(Function.prototype.toString.call(XMLHttpRequest.prototype.open))));\n" +
  '  window.__DSC_BOOT_CONFIG__ = {};\n' +
  '  window.__DSC_POW_WASM_B64__ = "AAAA";\n' +
  body +
  "\n}\n";

try {
  new Function(guarded);
  console.log(`✓ 拼接 + 幂等守卫包裹后语法 OK（${guarded.length} 字符）`);
} catch (e) {
  failed++;
  console.log(`✗ 拼接后语法错误: ${e.message}`);
}

process.exit(failed ? 1 : 0);
