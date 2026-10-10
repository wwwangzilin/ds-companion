#!/usr/bin/env node
/* 把 dsh-pet 的桌宠动作素材下到本地（**不进仓库**）。
 *
 * 【为什么是下载而不是直接塞进仓库】
 *   ① 那 106 个 webm 加起来 51.8 MB，全下会把仓库撑成一座山；
 *   ② 素材是别人画的（PC2005-cloud，MIT）—— 它该待在自己的仓库里，我们只在本地用；
 *   ③ 分池按需下：先只取 idle + clicks 两支，手感和体积都看得见，值再扩。
 *
 * 【许可证】dsh-pet 是 MIT，Copyright (c) 2026 PC2005-cloud。
 *   改、用、再分发都可以，**条件是把版权声明带上** —— 见仓库根的 NOTICE。
 *
 * 【名字即文件名】动作池里的名字（`待机呼吸休闲`）就是 `assets/webm/<名字>.webm`。
 *   这条口径来自 dsh-pet 自己的 src/host/anim.ts（"名字即文件名，404 → 加载失败"）。
 *
 * 【本机要挂代理】github 系域名在这台机器上被 S302 劫持，raw.githubusercontent.com 会被
 *   解析到 127.0.0.1。用 .verify/gh-proxy.mjs 起的本地隧道：
 *     $env:HTTPS_PROXY='http://127.0.0.1:18086'; $env:NODE_USE_ENV_PROXY='1'
 *   （Node ≥ 20.11 才认 NODE_USE_ENV_PROXY；本机 node 24 没问题。）
 *
 * 用法：node tools/fetch-pet-assets.mjs [--dir <数据目录>] [--all] [--force]
 *   缺省数据目录：$DSC_DATA_DIR，否则 %APPDATA%\ds-companion
 *   --all   把全部 106 个都下（约 52 MB）
 *   --force 已存在的也重下
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** ★锁 commit★：不锁的话上游改一次素材，我们这边的手感就跟着漂，没法复现 */
const REPO = 'PC2005-cloud/dsh-pet';
const REF = process.env.DSC_PET_REF || 'main';
const SUBDIR = 'dsh-pet/assets/webm';

/** 第一批只取这两池：待机 + 点击回应。够看出"手感"，体积才 2.9 MB。 */
const POOLS = {
  idle: ['待机呼吸休闲'],
  clicks: [
    '点击回应-开心跃动',
    '点击回应-害羞惊讶',
    '点击回应-傲娇生气',
    '点击回应-挠痒咯咯笑',
    '点击回应-元气挥手',
  ],
};

function dataDir(argDir) {
  if (argDir) return argDir;
  if (process.env.DSC_DATA_DIR) return process.env.DSC_DATA_DIR;
  const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(appdata, 'ds-companion');
}

function parseArgs(argv) {
  const out = { dir: '', all: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = argv[++i] || '';
    else if (argv[i] === '--all') out.all = true;
    else if (argv[i] === '--force') out.force = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const root = dataDir(args.dir);
const dest = join(root, 'pets', 'dsh-pet');

/** 要下哪些。--all 时列出整个目录（靠 GitHub 的 trees API 拿清单）。 */
async function names() {
  if (!args.all) return Object.values(POOLS).flat();
  const url = `https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`;
  const r = await fetch(url, { headers: { accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('拿目录失败：HTTP ' + r.status);
  const j = await r.json();
  return (j.tree || [])
    .filter((t) => t.type === 'blob' && t.path.startsWith(SUBDIR + '/') && t.path.endsWith('.webm'))
    .map((t) => t.path.slice(SUBDIR.length + 1, -'.webm'.length));
}

async function exists(p) {
  try {
    const s = await stat(p);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function main() {
  const list = await names();
  await mkdir(dest, { recursive: true });
  console.log(`目标目录：${dest}`);
  console.log(`要下 ${list.length} 个（ref=${REF}）`);
  let got = 0;
  let skipped = 0;
  let failed = 0;
  for (const name of list) {
    const file = join(dest, name + '.webm');
    if (!args.force && (await exists(file))) {
      skipped++;
      continue;
    }
    const url = `https://raw.githubusercontent.com/${REPO}/${REF}/${SUBDIR}/${encodeURIComponent(name)}.webm`;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      // webm 的魔数：EBML 头 0x1A45DFA3。下到一半的 HTML 错误页也会是 200，
      // 所以必须看魔数，不能只看状态码。
      if (buf.length < 4 || buf.readUInt32BE(0) !== 0x1a45dfa3) {
        throw new Error('不像是 webm（魔数不对），' + buf.length + ' 字节');
      }
      await writeFile(file, buf);
      got++;
      console.log(`  ✓ ${name}  ${(buf.length / 1024).toFixed(0)} KB`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}  ${e.message}`);
    }
  }
  console.log('');
  console.log(`下好 ${got} 个、跳过 ${skipped} 个（已存在）、失败 ${failed} 个`);
  if (failed) {
    console.log('失败的多半是代理没挂 —— 见文件头的说明。');
    process.exit(1);
  }
}

await main();
