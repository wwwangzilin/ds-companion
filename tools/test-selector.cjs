/**
 * selector.js 的单测（node 直接跑，不需要构建）。
 * 用法：node tools/test-selector.cjs
 */
const { selectMemories, estimateTokens, formatBlock } = require('../src-tauri/inject/selector.js');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const NOW = Date.now();
const mem = (over) =>
  Object.assign(
    {
      id: 'm' + Math.random().toString(36).slice(2, 7),
      characterId: '',
      name: '标题',
      content: '内容',
      keys: [],
      importance: 3,
      pinned: false,
      createdAt: NOW,
      lastAccessedAt: NOW,
      accessCount: 0,
    },
    over,
  );

// 1) 触发词命中才捞（世界书式条件注入）
{
  const coffee = mem({ id: 'coffee', name: '主人喝美式', content: '不加糖不加奶', keys: ['咖啡', '美式'], importance: 2 });
  const other = mem({ id: 'other', name: '主人怕打雷', content: '打雷会躲', keys: ['雷'], importance: 2 });
  const hit = selectMemories('今天想喝杯美式提提神', [coffee, other], { budget: 500, now: NOW });
  check('命中触发词的被捞出来', hit.usedIds.includes('coffee'), JSON.stringify(hit.usedIds));
  check('没命中的低重要度不参与', !hit.usedIds.includes('other'), JSON.stringify(hit.usedIds));
}

// 2) 高重要度 / pin 的即便没命中也要常驻（Always-On 核心记忆）
{
  const core = mem({ id: 'core', name: '主人叫我咪咪', content: '跨会话称呼', keys: ['咪咪'], importance: 5 });
  const pinned = mem({ id: 'pin', name: '主人身份', content: '开发者', keys: ['zzz'], importance: 1, pinned: true });
  const r = selectMemories('随便说点什么', [core, pinned], { budget: 500, now: NOW });
  check('高重要度没命中也能常驻', r.usedIds.includes('core'), JSON.stringify(r.usedIds));
  check('pin 的没命中也能常驻', r.usedIds.includes('pin'), JSON.stringify(r.usedIds));
}

// 3) 已注入过的不重复注入（省额度）
{
  const m = mem({ id: 'once', name: '主人喝美式', content: '不加糖', keys: ['美式'], importance: 5 });
  const first = selectMemories('想喝美式', [m], { budget: 500, now: NOW });
  const second = selectMemories('再要一杯美式', [m], { budget: 500, now: NOW, alreadyInjected: first.usedIds });
  check('第一次注入了', first.usedIds.includes('once'));
  check('第二次不再重复注入', second.usedIds.length === 0, JSON.stringify(second.usedIds));
}

// 4) token 预算真的在卡
{
  const many = [];
  for (let i = 0; i < 40; i++) {
    many.push(mem({ id: 'x' + i, name: `很长的记忆标题${i}`, content: '这是一段挺长的内容'.repeat(8), keys: ['美式'], importance: 5 }));
  }
  const r = selectMemories('美式', many, { budget: 200, now: NOW });
  const cost = estimateTokens(formatBlock(r.picked));
  check('预算内（不超一点）', cost <= 200 + 60, `cost=${cost} picked=${r.picked.length}`);
  check('确实做了截断（没全塞）', r.picked.length > 0 && r.picked.length < many.length, `picked=${r.picked.length}/40`);
}

// 5) 空输入不该炸
{
  const r = selectMemories('', [mem({ id: 'a', importance: 5 })], { budget: 500, now: NOW });
  check('空输入不炸且高重要度仍注入', r.usedIds.includes('a'));
  const empty = selectMemories('x', [], { budget: 500, now: NOW });
  check('空库返回空', empty.usedIds.length === 0 && empty.block === '');
}

// 6) 角色记忆排序上不吃亏（同条件下角色记忆优先于全局）
{
  const g = mem({ id: 'g', name: '全局', content: 'x', keys: ['美式'], importance: 3 });
  const c = mem({ id: 'c', name: '角色', content: 'x', keys: ['美式'], importance: 3, characterId: 'dsh-luna' });
  const r = selectMemories('美式', [g, c], { budget: 500, now: NOW });
  check('角色记忆排在前（同分时优先）', r.usedIds[0] === 'c', JSON.stringify(r.usedIds));
}

// 7) token 估算量级
{
  check('中文估算约 0.6/字', Math.abs(estimateTokens('一二三四五六七八九十') - 6) <= 1, String(estimateTokens('一二三四五六七八九十')));
}

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
