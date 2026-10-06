/* 从日志里**复现**她当时说的那句话。
 *
 * 【为什么能复现】气泡那句完全是本地算出来的、无随机：日志里 `[page] SEE ok …` 记着
 * 那次回给壳的原文，而 `screen::subject_from_see` 挑哪一行、`screen::local_line` 套哪个
 * 模板都是确定性的。所以拿日志就能把她历来说过的每一句逐字还原出来。
 *
 * 【为什么需要它】"她老说同一句"这类抱怨，光看桌宠无法取证：气泡只显示最终那句，
 * 而那句话从不落盘（`Snapshot` 只活在内存里）。日志是唯一的现场。
 *
 * 【和 Rust 那边对齐的三处】改 `subject_from_see` / `local_line` / `SUBJECT_CHARS`
 * 时必须同步改这里，否则复现结果会悄悄骗人：
 *   ① 候选前缀 ["重点：", "重点:", "重点 ", "重点"]（按这个顺序找，第一个命中就返回）
 *   ② 找不到「重点」才退到第一行，并把行首的「在做什么：」剥掉
 *   ③ 截断按**字符**数（SUBJECT_CHARS = 18），不是字节
 * 模板表与 FNV-1a 哈希同理（`local_line` 用 u32 环绕乘法）。
 *
 * 用法：node .verify/replay-say.mjs [日志路径]
 *      默认 %TEMP%\ds-companion.log
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const path = process.argv[2] || join(tmpdir(), 'ds-companion.log');

// ── 与 screen.rs 对齐的四样东西 ───────────────────────────────────────────
const SUBJECT_CHARS = 18;

/** 「一个东西」那套（`local_line`） */
const TPL = [
  '主人居然在看「{}」',
  '「{}」……在看这个啊',
  '又打开了「{}」呢',
  '哦——「{}」',
  '在「{}」里泡着呢',
  '主人看「{}」看得好认真',
  '这个「{}」，我看见了',
];

/** 「一件事」那套（`local_line_kind` 的 TPL_DOING） */
const TPL_DOING = [
  '{}……本小姐看着呢',
  '{}。嗯，看见了',
  '{}——是这样吧',
  '{}。别以为我没看见',
  '{}，哼',
  '{}，要本小姐搭把手吗',
];

/** FNV-1a 32（u32 环绕）—— 与 `hash32` 里的 fold 逐字节等价 */
function fnv1a(s) {
  let h = 2166136261 >>> 0;
  for (const b of Buffer.from(s, 'utf8')) {
    h = (h ^ b) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const clip = (s, n) => Array.from(s).slice(0, n).join('');

/** `second_person`：开头的 他/她 → 你 */
const secondPerson = (s) => (/^[他她]/.test(s) ? '你' + s.slice(1).replace(/^\s+/, '') : s);

/** `subject_candidates` 的移植 → [(kind, subject)]，顺序 Focus → Doing → Change */
function subjectCandidates(see) {
  let focus = null;
  let doing = null;
  let change = null;
  for (const raw of String(see).split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    if (focus === null) {
      for (const pre of ['重点：', '重点:', '重点 ', '重点']) {
        if (l.startsWith(pre)) {
          const r = l
            .slice(pre.length)
            .trim()
            .replace(/^[：:]+/, '')
            .trim();
          if (r) focus = clip(r, SUBJECT_CHARS);
          break;
        }
      }
    }
    if (change === null) {
      for (const pre of ['变化：', '变化:']) {
        if (l.startsWith(pre)) {
          const r = l.slice(pre.length).trim();
          if (r) change = clip(secondPerson(r), SUBJECT_CHARS);
          break;
        }
      }
    }
    if (doing === null && !l.startsWith('重点') && !l.startsWith('变化')) {
      const r = l.replace(/^在做什么[：:]/, '').trim();
      if (r) doing = clip(secondPerson(r), SUBJECT_CHARS);
    }
  }
  return [
    ['Focus', focus],
    ['Doing', doing],
    ['Change', change],
  ].filter(([, s]) => s && Array.from(s).length >= 2);
}

const lineOf = (kind, subject) =>
  (kind === 'Focus' ? TPL[fnv1a(subject) % TPL.length] : TPL_DOING[fnv1a(subject) % TPL_DOING.length])
    .replace('{}', subject);

/** 老逻辑（`subject_from_see` + `local_line`）：只认「重点」，撞了也照说不误 */
function oldSay(see) {
  const c = subjectCandidates(see);
  const f = c.find(([k]) => k === 'Focus') || c[0];
  return f ? lineOf('Focus', f[1]) : null;
}

/** 新逻辑（`pick_line`）：同一段看第二遍就闭嘴；否则找**这一类主语变了**的那一类来说 */
function newSay(see, prevSee, prevSay) {
  if (see === prevSee) return null;
  const now = subjectCandidates(see);
  const before = subjectCandidates(prevSee);
  for (const [kind, subj] of now) {
    if (before.some(([k, s]) => k === kind && s === subj)) continue;
    const line = lineOf(kind, subj);
    if (line !== prevSay) return line;
  }
  return null;
}

// ── 扫日志 ────────────────────────────────────────────────────────────────
const lines = readFileSync(path, 'utf8').split(/\r?\n/);
const sees = [];
for (const line of lines) {
  const i = line.indexOf('SEE ok ');
  if (i < 0) continue;
  // inject.js 打日志时把换行压成了 " / " 并截到 90 字 —— 只够还原「重点」那一行
  sees.push(line.slice(i + 7).replace(/ \/ /g, '\n'));
}

console.log('日志        ' + path);
console.log('总行数      ' + lines.length);
console.log('SEE ok 条数 ' + sees.length);
console.log('');

// 老逻辑：只看"说过几句、重复几次"
const oldAll = sees.map(oldSay).filter(Boolean);
// 新逻辑：要按顺序走（"上一眼""上一句"都是状态）
const newAll = [];
let pSee = '';
let pSay = '';
for (const s of sees) {
  const line = newSay(s, pSee, pSay);
  pSee = s;
  if (line) {
    pSay = line;
    newAll.push(line);
  }
}

const count = (arr) => {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return m;
};
const summarize = (label, arr) => {
  const m = count(arr);
  const dup = [...m.values()].filter((n) => n > 1).reduce((a, b) => a + b, 0);
  console.log(`${label}：说了 ${arr.length} 句，不同 ${m.size} 种`);
  console.log(`   逐字重复的句子占 ${dup} 次 / ${arr.length}`);
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  for (const [k, n] of top) console.log(`   ×${String(n).padStart(3)}  ${k}`);
  console.log('');
};

console.log('── 老逻辑（只认「重点」）──');
summarize('  结果', oldAll);
console.log('── 新逻辑（三行当候选 + 同一段不重说）──');
summarize('  结果', newAll);

