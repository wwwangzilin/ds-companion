/**
 * 日记单测：`buildDiaryPrompt` / `parseDiary` 都是纯函数，而它们错起来很安静 ——
 * 提示词漏了素材，她只能靠编；解析没清干净，日记本里就混进 ``` 和「日记正文：」抬头。
 *
 * 用法：node tools/test-diary.cjs
 */
const { buildDiaryPrompt, parseDiary } = require('../src-tauri/inject/sense.js');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── 提示词：素材必须真的进得去 ──────────────────────────────────────
const p = buildDiaryPrompt({
  day: '2026-10-02',
  turns: 12,
  affinity: 81,
  valence: 0.4,
  excerpt: '用户：今天好累\n角色：那就别撑着了',
});
check('带上要写的那一天', p.includes('2026-10-02'));
check('带上轮数与好感', p.includes('12') && p.includes('81'), '轮数/好感得有');
check('带上那天的对话节选', p.includes('那就别撑着了'), '没有节选她就只能编');
check('情绪均值翻译成人话', p.includes('偏愉快'));
check('明确禁编造', p.includes('不要编造'));
check('明确不要标题/日期/代码块', p.includes('不要标题') && p.includes('代码块'));

const down = buildDiaryPrompt({ day: '2026-10-02', valence: -0.5 });
check('低落情绪换个说法', down.includes('有点低落'));
const flat = buildDiaryPrompt({ day: '2026-10-02', valence: 0.02 });
check('平淡情绪换个说法', flat.includes('平平的'));

// ── 提示词：空素材不能炸，也不能鼓励她瞎编 ──────────────────────────
const empty = buildDiaryPrompt({});
check('空素材不炸', typeof empty === 'string' && empty.length > 60, String(empty.length));
check('空素材明说那天没留下话', empty.includes('没留下什么话'));
const nan = buildDiaryPrompt({ day: '2026-10-02', valence: '啊', turns: null, affinity: undefined });
check('脏素材不炸且不带 NaN', !nan.includes('NaN'), nan.split('\n').find((l) => l.includes('那天的样子')) || '');

// 节选超长要截断（一次隐藏请求别塞一整天的对话）
const huge = buildDiaryPrompt({ day: '2026-10-02', excerpt: '字'.repeat(5000) });
check('节选超长被截断', huge.length < 3000, String(huge.length));

// ── 解析：围栏 / 抬头 / 空白 / 超长 ────────────────────────────────
check('去掉代码围栏', parseDiary('```\n今天他给了我一杯饮料。\n```') === '今天他给了我一杯饮料。');
check('去掉带语言标记的围栏', parseDiary('```markdown\n他今天很烦。\n```') === '他今天很烦。');
check('去掉「日记正文：」抬头', parseDiary('日记正文：他今天很烦。') === '他今天很烦。');
check('去掉「正文：」抬头', parseDiary('正文：他今天很烦。') === '他今天很烦。');
check('不去动正文里的冒号', parseDiary('他说：你好烦。') === '他说：你好烦。');
check('首尾空白清掉', parseDiary('  \n 他笑了。 \n ') === '他笑了。');
check(
  '空回复得到空串',
  parseDiary('') === '' && parseDiary(null) === '' && parseDiary('   ') === '',
  JSON.stringify([parseDiary(''), parseDiary(null), parseDiary('   ')]),
);
const long = parseDiary('啊'.repeat(3000));
check('超长截到 1200 字以内', long.length <= 1200, String(long.length));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
