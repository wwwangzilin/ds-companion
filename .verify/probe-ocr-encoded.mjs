/* 验证 ocr.ps1 的两件新东西，免得写进 Rust 才发现不通：
 *   ① `-EncodedCommand`（脚本不落盘：UTF-16LE → base64 → 直接当命令行参数）
 *   ② 内存流（截图一个字节都不写盘）
 * 顺带把识别结果和耗时打出来，好判断它到底够不够用。
 *
 * 用法：node .verify/probe-ocr-encoded.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src-tauri', 'ocr', 'ocr.ps1'), 'utf8');

// -EncodedCommand 认的是 UTF-16LE 的 base64
const b64 = Buffer.from(src, 'utf16le').toString('base64');
console.log(`[script] ${src.length} chars -> base64 ${b64.length} chars（命令行上限 32767）`);

const t0 = Date.now();
const r = spawnSync(
  'powershell',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000, windowsHide: true },
);
const ms = Date.now() - t0;

if (r.error) {
  console.log('[error] ' + r.error.message);
  process.exit(1);
}
console.log(`[exit] ${r.status}   wall=${ms}ms`);
if (r.stderr) console.log('[stderr]\n' + r.stderr.slice(0, 1500));

const out = String(r.stdout || '').split(/\r?\n/);
console.log('[meta] ' + (out[0] || '(空)'));
const body = out.slice(1).filter((x) => x.trim() !== '');
console.log(`[lines] ${body.length}`);
console.log('--- 前 20 行 ---');
body.slice(0, 20).forEach((l) => console.log('  ' + l));
console.log('--- 原始（含汉字间空格）样例 ---');
body.slice(0, 3).forEach((l) => console.log('  ' + JSON.stringify(l)));
