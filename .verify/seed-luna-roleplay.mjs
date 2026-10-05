/* 一次性：按露娜的设定，把主人那几个空着的旋钮填上（读-改-写，不碰别的字段）。
 *
 * 【为什么不直接写文件】config 是 JSON、状态是 JSON、人设是 frontmatter ——
 * 都用 UTF-8 **无 BOM** 写回（PowerShell 5.1 的 Set-Content -Encoding UTF8 会塞 BOM，
 * 配置文件会因此解析失败，这是本机踩过的老坑）。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.env.APPDATA || '', 'ds-companion');
const w = (p, s) => writeFileSync(p, s, { encoding: 'utf8' }); // 无 BOM
const r = (p) => readFileSync(p, 'utf8');

// ① 配置：雷点 + 出戏暗号（都是"她的设定"里长出来的，不是凭空编的）
const cfgPath = join(ROOT, 'config.json');
const cfg = JSON.parse(r(cfgPath));
cfg.boundariesAvoid = [
  '角上那道裂纹（她嘴硬说是「强者的勋章」，其实是被罚下来的痕迹）',
  '魔界学校那位被她气到当场辞职的老师',
  '「破防三次才能转正」的进度（一提就像在催她 KPI）',
].join('\n');
cfg.oocToken = '出戏'; // 不用 `//`：主人是写代码的，正文里出现它是家常便饭
w(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
console.log('[config] boundariesAvoid =', JSON.stringify(cfg.boundariesAvoid));
console.log('[config] oocToken =', cfg.oocToken);

// ② 状态：先把当前场景设成最日常的那个（不然重启后还是一片空白）
const stateDir = join(ROOT, 'state');
const files = existsSync(stateDir) ? readdirSync(stateDir).filter((f) => f.endsWith('.json')) : [];
console.log('[state] 目录里有：', files.join(', ') || '(空)');
const statePath = join(stateDir, 'dsh-luna.json');
if (existsSync(statePath)) {
  const st = JSON.parse(r(statePath));
  st.scene = {
    name: '人间书桌',
    text: '你在电脑前干活，她趴在桌角，尾巴有一下没一下地敲你的手背',
    since: Date.now(),
  };
  w(statePath, JSON.stringify(st, null, 2) + '\n');
  console.log('[state] scene =', JSON.stringify(st.scene));
} else {
  console.log('[state] 没有 dsh-luna.json —— 场景没设（她在界面上挑一个就行）');
}

// ③ 人设：填上「她叫你」（她正文里本来就一口一个「主人」）
const pPath = join(ROOT, 'personas', 'dsh-luna.md');
const md = r(pPath);
if (/^address:/m.test(md)) {
  console.log('[persona] 已经有 address 了，跳过');
} else {
  w(pPath, md.replace(/^source: dsh:luna$/m, 'source: dsh:luna\naddress: 主人'));
  console.log('[persona] address = 主人');
}
console.log('--- 读回校验 ---');
const back = JSON.parse(r(cfgPath));
console.log('config 读回：', JSON.stringify({ avoid: back.boundariesAvoid.slice(0, 12) + '…', ooc: back.oocToken }));
console.log('persona 头四行：', r(pPath).split('\n').slice(0, 7).join(' | '));
