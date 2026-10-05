/**
 * 伏笔（待回访）单测：**日期换算是这里唯一会悄悄错的地方**。
 *
 * 模型只给粗档（today / tomorrow / this_week / later），绝对日期由页面算 ——
 * 而"算日期"在本项目里踩过的坑足够多（`new Date('2026-10-05')` 会按 UTC 解析，
 * 本机 UTC+8 的晚上就会差一天）。所以这一份专门盯它。
 *
 * 用法：node tools/test-followup.cjs
 */
const { addDays, parseSense } = require('../src-tauri/inject/sense.js');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── addDays：本地日历的加减 ────────────────────────────────────────
check('加一天', addDays('2026-10-05', 1) === '2026-10-06', addDays('2026-10-05', 1));
check('加 0 天等于自己', addDays('2026-10-05', 0) === '2026-10-05', addDays('2026-10-05', 0));
check('跨月', addDays('2026-10-31', 1) === '2026-11-01', addDays('2026-10-31', 1));
check('跨年', addDays('2026-12-31', 1) === '2027-01-01', addDays('2026-12-31', 1));
check('闰年 2 月', addDays('2028-02-28', 1) === '2028-02-29', addDays('2028-02-28', 1));
check('平年 2 月', addDays('2027-02-28', 1) === '2027-03-01', addDays('2027-02-28', 1));
check('加 10 天', addDays('2026-10-05', 10) === '2026-10-15', addDays('2026-10-05', 10));
check('补零不能省', addDays('2026-01-01', 1) === '2026-01-02', addDays('2026-01-01', 1));
check(
  '脏输入给空串（不炸、也不编一个日期）',
  addDays('', 1) === '' && addDays('明天', 1) === '' && addDays(null, 1) === '',
  JSON.stringify([addDays('', 1), addDays('明天', 1), addDays(null, 1)]),
);

// ── parseSense 把颗粒度翻译成绝对日期 ──────────────────────────────
/** 期望值用**本地日历**自己算一份（跟实现同源，但至少能抓住"用了 UTC"这类错） */
function localPlus(n) {
  const d = new Date();
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const p = (v) => (v < 10 ? '0' : '') + v;
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}

for (const [when, n] of [
  ['today', 0],
  ['tomorrow', 1],
  ['this_week', 3],
  ['later', 10],
]) {
  const got = parseSense(
    JSON.stringify({ valence: 0.2, followup: { what: '面试', when: when } }),
  );
  check(
    `${when} → 本地 +${n} 天`,
    got.followup && got.followup.due === localPlus(n),
    JSON.stringify(got.followup),
  );
}

check(
  'when 大小写不敏感',
  (parseSense('{"valence":0.1,"followup":{"what":"体检","when":"Tomorrow"}}').followup || {}).due ===
    localPlus(1),
);
// clip 超长会补一个「…」，所以是 61 而不是 60（壳里还会再夹一次 60）
const longWhat = (
  parseSense(JSON.stringify({ valence: 0.1, followup: { what: '啊'.repeat(200), when: 'today' } }))
    .followup.what || ''
).length;
check('what 会截断（别把一整段话当伏笔）', longWhat > 0 && longWhat <= 61, String(longWhat));
check(
  '没补零的日期也认（本地日历可能给 2026-10-3）',
  addDays('2026-10-3', 1) === '2026-10-04',
  addDays('2026-10-3', 1),
);

// 认不出来的粗档、缺东西、null —— 一律当"这次没伏笔"，绝不瞎猜一个日期
for (const bad of [
  { valence: 0.1, followup: { what: '面试', when: '下周三' } },
  { valence: 0.1, followup: { what: '', when: 'tomorrow' } },
  { valence: 0.1, followup: { what: '面试' } },
  { valence: 0.1, followup: null },
]) {
  const got = parseSense(JSON.stringify(bad));
  check(`不认识的就不要：${JSON.stringify(bad.followup)}`, got.followup === undefined, JSON.stringify(got.followup));
}

// 只有伏笔、别的都没给 —— 也该算"有可用字段"（不然这次判断整个被丢掉）
let onlyFollowup = null;
try {
  onlyFollowup = parseSense('{"followup":{"what":"面试","when":"tomorrow"}}');
} catch (e) {
  onlyFollowup = 'THREW ' + e.message;
}
check(
  '只有 followup 时不算空回复',
  onlyFollowup && typeof onlyFollowup === 'object' && !!onlyFollowup.followup,
  JSON.stringify(onlyFollowup),
);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
