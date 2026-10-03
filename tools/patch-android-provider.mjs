// 打补丁：消掉 Android 上的「初始化脚本双注入」。
//
// 【问题】wry 生成的两个文件会让同一份初始化脚本在 Android 上跑两遍：
//   RustWebView.kt        init 里用 WebViewCompat.addDocumentStartJavaScript 注入
//                         （对所有 origin，setOf("*")）
//   RustWebViewClient.kt  onPageStarted 里又**无条件** evaluateJavascript 一遍，
//                         它的判断只看「这个 URL 没被 custom protocol 拦下」，
//                         而远程 URL 必然满足 —— 压根没检查 isDocumentStartScriptEnabled
//
// 【为什么不是"多跑一遍无所谓"】Tauri 自己的 IPC 引导脚本也在 initScripts 里，它把
// window.__TAURI_INTERNALS__ 那几个属性定义成不可重定义；第二次定义直接抛
//   Cannot redefine property: postMessage / metadata / __TAURI_PATTERN__ / path /
//   __TAURI_EVENT_PLUGIN_INTERNALS__
// 把引导脚本的后续部分打断 —— 页面里所有走 IPC 的调用（ds-companion 的 dsc_* 那一批）
// 随之全废。真机表现："界面有些地方点不了"。
//
// 【修法】把那段判断改成「document-start 那条路没走通时才降级注入」——
// 既消掉双注入，又保留老设备的降级路径（不支持 DOCUMENT_START_SCRIPT 的机器仍靠它）。
//
// 用法：node tools/patch-android-provider.mjs
// 什么时候跑：每次 `cargo tauri android init`（或任何重新生成 gen/ 的操作）之后、
// 打 APK 之前。脚本幂等，重复跑没事；找不到目标片段会**明确报错**而不是静默跳过。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const JAVA_DIR = join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'java');

/** wry 原版的那段（用它当靶子；不含我们加的注释，所以对重新生成的文件也成立） */
const OLD = `        if (interceptedState[url] == false) {
            val webView = view as RustWebView
            for (script in webView.initScripts) {
                view.evaluateJavascript(script, null)
            }
        }
        return Rust.onPageLoading((view as RustWebView).id, url)`;

const NEW = `        val webView = view as RustWebView
        if (interceptedState[url] == false && !webView.isDocumentStartScriptEnabled) {
            for (script in webView.initScripts) {
                view.evaluateJavascript(script, null)
            }
        }
        return Rust.onPageLoading(webView.id, url)`;

/** 已经打过补丁的判据 */
const MARK = '!webView.isDocumentStartScriptEnabled';

function findClientFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findClientFiles(p, out);
    else if (e.name === 'RustWebViewClient.kt') out.push(p);
  }
  return out;
}

let files;
try {
  files = findClientFiles(JAVA_DIR);
} catch (e) {
  console.error(`✗ 找不到 ${JAVA_DIR}`);
  console.error('  gen/android 还没生成？先跑一次：cargo tauri android init');
  process.exit(1);
}
if (files.length === 0) {
  console.error('✗ 在 gen/android 里找不到 RustWebViewClient.kt');
  console.error('  先跑一次 cargo tauri android init');
  process.exit(1);
}

let patched = 0;
let already = 0;
let failed = 0;

for (const f of files) {
  const src = readFileSync(f, 'utf8');

  if (src.includes(MARK)) {
    console.log(`✓ 已打过补丁：${f.replace(root + '\\', '')}`);
    already++;
    continue;
  }
  if (!src.includes(OLD)) {
    // 不静默跳过 —— 要么 wry 改了实现，要么文件结构变了，得人工看一眼
    console.error(`✗ 找不到目标片段：${f.replace(root + '\\', '')}`);
    console.error('  wry 可能改了实现，请人工核对 onPageStarted 里的注入逻辑');
    failed++;
    continue;
  }

  writeFileSync(f, src.replace(OLD, NEW), 'utf8');
  console.log(`✓ 已打补丁：${f.replace(root + '\\', '')}`);
  patched++;
}

console.log('');
console.log(`结果：新打 ${patched} 个，已是补丁态 ${already} 个，失败 ${failed} 个`);
if (failed > 0) {
  console.error('有文件没打成 —— 别急着打包，先看看上面那几条。');
  process.exit(2);
}
console.log('现在可以打 APK 了。');
