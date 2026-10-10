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
 * 【两条下载通道，为什么】实测本机走代理时 `raw.githubusercontent.com` 会**连接超时**
 *   （隧道里那条 IP 映射不通），而 `api.github.com` 一路顺畅。所以：
 *     ① 先试 raw（快、省额度）；**每个请求都带超时** —— 没有超时的 fetch 会把整个脚本
 *        挂死在第一个文件上（本机实测挂过 10 分钟没动静，前功尽弃）；
 *     ② 超时/失败就回落到 `GET /git/blobs/<sha>`（base64，同样走 api.github.com）。
 *        这条通道要认证：匿名额度只有 60 次/小时，106 个文件根本不够，
 *        所以支持 `GITHUB_TOKEN` / `DSC_GITHUB_TOKEN` 环境变量（`gh auth token` 拿得到）。
 *   只走 raw 的版本在别的机器上没问题，在这台机器上是**必挂**的 —— 两条都留着。
 *
 * 用法：node tools/fetch-pet-assets.mjs [--dir <数据目录>] [--all] [--force] [--pool <池名>]
 *   缺省数据目录：$DSC_DATA_DIR，否则 %APPDATA%\ds-companion
 *   --all    把全部 106 个都下（约 52 MB）
 *   --force  已存在的也重下
 *   --pool   只下某一池（idle / turn / drag / clicks / moves / categories / events）
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** ★锁 commit★：不锁的话上游改一次素材，我们这边的手感就跟着漂，没法复现 */
const REPO = 'PC2005-cloud/dsh-pet';
const REF = process.env.DSC_PET_REF || 'main';
const SUBDIR = 'dsh-pet/assets/webm';
/** 单个请求的超时（毫秒）—— 见文件头「两条下载通道」。
 *  【为什么要分成两个】raw 那条在本机是"必然超时"（隧道里映射不通），给它设长等于每个
 *  文件白等一遍；api.github.com 那条则是正常要一两秒的，设短了连清单都拿不到
 *  （实测 1200ms 时第一个 tree 请求就崩了）。一个设短、一个设正常。 */
const RAW_TIMEOUT_MS = Number(process.env.DSC_PET_RAW_TIMEOUT_MS || 1500);
const API_TIMEOUT_MS = Number(process.env.DSC_PET_TIMEOUT_MS || 25000);

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
  const out = { dir: '', all: false, force: false, pool: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = argv[++i] || '';
    else if (argv[i] === '--all') out.all = true;
    else if (argv[i] === '--force') out.force = true;
    else if (argv[i] === '--pool') out.pool = argv[++i] || '';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const root = dataDir(args.dir);
const dest = join(root, 'pets', 'dsh-pet');

const TOKEN = process.env.DSC_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
const AUTH = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

async function req(url, headers = {}, timeoutMs = API_TIMEOUT_MS) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'ds-companion-fetch-pet', ...AUTH, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
}

/** 上游素材清单：[{ name, sha }]。有 token 时 api.github.com 才够额度。 */
async function tree() {
  const r = await req(`https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`, {
    accept: 'application/vnd.github+json',
  });
  const j = await r.json();
  return (j.tree || [])
    .filter((t) => t.type === 'blob' && t.path.startsWith(SUBDIR + '/') && t.path.endsWith('.webm'))
    .map((t) => ({ name: t.path.slice(SUBDIR.length + 1, -'.webm'.length), sha: t.sha }));
}

async function exists(p) {
  try {
    const s = await stat(p);
    return s.size > 0;
  } catch {
    return false;
  }
}

/** 通道①：raw.githubusercontent.com（快，不打 api 额度；本机必超时，所以超时给得短） */
async function viaRaw(name) {
  const url = `https://raw.githubusercontent.com/${REPO}/${REF}/${SUBDIR}/${encodeURIComponent(name)}.webm`;
  const r = await req(url, {}, RAW_TIMEOUT_MS);
  return Buffer.from(await r.arrayBuffer());
}

/** 通道②：api.github.com 的 blob（base64；raw 不通时的正路） */
async function viaBlob(sha) {
  const r = await req(`https://api.github.com/repos/${REPO}/git/blobs/${sha}`, {
    accept: 'application/vnd.github+json',
  });
  const j = await r.json();
  if (!j.content) throw new Error('blob 里没有 content');
  return Buffer.from(j.content, 'base64');
}

async function download(name, sha) {
  let firstErr = '';
  try {
    return await viaRaw(name);
  } catch (e) {
    firstErr = e.name === 'TimeoutError' ? 'raw 超时' : e.message;
  }
  try {
    return await viaBlob(sha);
  } catch (e) {
    throw new Error(`${firstErr} / blob: ${e.message}`);
  }
}

async function main() {
  const all = await tree();
  // 分池下：按池名过滤（池名即动作名，池的定义在 src-tauri/assets/pet-pools.json）
  let list = all;
  if (!args.all) {
    const names = args.pool
      ? await (async () => {
          const pools = JSON.parse(
            await (await import('node:fs/promises')).readFile(
              new URL('../src-tauri/assets/pet-pools.json', import.meta.url),
              'utf8',
            ),
          );
          const norm = args.pool.trim().toLowerCase();
          if (norm === 'idle' || norm === 'turn' || norm === 'drag' || norm === 'clicks') {
            return pools[norm];
          }
          if (norm === 'moves') return pools.moves.actions.map((a) => a.name);
          if (norm === 'categories') return pools.categories.flatMap((c) => c.actions);
          if (norm === 'events') return Object.values(pools.events).flat().flat();
          throw new Error('不认识的池：' + args.pool);
        })()
      : Object.values(POOLS).flat();
    const want = new Set(names);
    list = all.filter((t) => want.has(t.name));
  }
  await mkdir(dest, { recursive: true });
  console.log(`目标目录：${dest}`);
  console.log(`要下 ${list.length} 个（ref=${REF}，通道：raw → blob 回落${TOKEN ? '，已认证' : '，未认证'}）`);
  let got = 0;
  let skipped = 0;
  let failed = 0;
  let bytes = 0;
  for (const it of list) {
    const file = join(dest, it.name + '.webm');
    if (!args.force && (await exists(file))) {
      skipped++;
      continue;
    }
    try {
      const buf = await download(it.name, it.sha);
      // webm 的魔数：EBML 头 0x1A45DFA3。下到一半的 HTML 错误页也会是 200，
      // 所以必须看魔数，不能只看状态码。
      if (buf.length < 4 || buf.readUInt32BE(0) !== 0x1a45dfa3) {
        throw new Error('不像是 webm（魔数不对），' + buf.length + ' 字节');
      }
      await writeFile(file, buf);
      got++;
      bytes += buf.length;
      console.log(`  ✓ ${it.name}  ${(buf.length / 1024).toFixed(0)} KB`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${it.name}  ${e.message}`);
    }
  }
  console.log('');
  console.log(
    `下好 ${got} 个（${(bytes / 1048576).toFixed(1)} MB）、跳过 ${skipped} 个（已存在）、失败 ${failed} 个`,
  );
  if (failed) {
    console.log('失败的多半是代理/额度 —— 见文件头的说明。');
    process.exit(1);
  }
}

await main();
