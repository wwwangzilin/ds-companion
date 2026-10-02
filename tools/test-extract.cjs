/* extract.js 纯函数单测（不需要浏览器、不联网）
 * 用法：node tools/test-extract.cjs
 *
 * 盯的是三处最容易悄悄坏掉的地方：
 *   ① 输入封顶（成本闸）—— 对话很长时不能把整个 transcript 塞进 prompt
 *   ② JSON 抠取 —— 模型爱套 markdown 围栏 / 前后加废话
 *   ③ 条目过滤 —— 空壳条目要丢掉，不许写进记忆库
 */
const path = require('path');
const EX = require(path.join(__dirname, '..', 'src-tauri', 'inject', 'extract.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)));
  }
}
function eq(name, actual, expected) {
  ok(name + ' = ' + JSON.stringify(expected), JSON.stringify(actual) === JSON.stringify(expected), actual);
}

console.log('\n[1] buildDump —— 只取最近几轮且封顶');
{
  const turns = [];
  for (let i = 0; i < 40; i++) {
    turns.push({ user: '问题' + i + 'x'.repeat(300), assistant: '回答' + i + 'y'.repeat(300) });
  }
  const dump = EX.buildDump(turns);
  ok('总长不超过 6000 字', dump.length <= 6000, dump.length);
  ok('最新一轮在里面', dump.includes('问题39'), dump.slice(0, 60));
  ok('最老那轮被丢掉', !dump.includes('问题0x'), '');
  ok('用户与助手都在', dump.includes('用户：') && dump.includes('助手：'));
}
{
  ok('空数组 → 空串', EX.buildDump([]) === '');
  ok('缺字段不炸', typeof EX.buildDump([{}]) === 'string');
}

console.log('\n[2] parseItems —— 抠 JSON / 宽容围栏');
{
  const good = '```json\n{"items":[{"op":"add","name":"主人只喝美式","content":"不加糖不加奶","keys":["咖啡","美式"],"importance":4}]}\n```';
  const items = EX.parseItems(good, 'dsh-luna');
  eq('正常条目解析出 1 条', items.length, 1);
  eq('op', items[0].op, 'add');
  eq('标题', items[0].name, '主人只喝美式');
  eq('触发词', items[0].keys, ['咖啡', '美式']);
  eq('重要度', items[0].importance, 4);
  eq('归属来自参数（不听模型的）', items[0].characterId, 'dsh-luna');
}
{
  const withNoise = '好的，我整理如下：\n{"items":[]}\n希望有帮助！';
  eq('前后有废话也能抠出来', EX.parseItems(withNoise, '').length, 0);
}
{
  const fences = '```json\n{"items":[{"op":"add","name":"n","content":"c"}]}\n```';
  eq('围栏 + 无 keys 时 keys 补空数组', EX.parseItems(fences, '')[0].keys, []);
}
{
  let threw = '';
  try {
    EX.parseItems('我觉得没什么好记的', '');
  } catch (e) {
    threw = e.message;
  }
  ok('纯散文 → 明确报错（不是静默空）', threw.includes('没按 JSON'), threw);
}
{
  let threw = '';
  try {
    EX.parseItems('{"items": "oops"}', '');
  } catch (e) {
    threw = e.message;
  }
  ok('items 不是数组 → 报错', threw.includes('items'), threw);
}

console.log('\n[3] parseItems —— 条目清洗与上限');
{
  const messy =
    '{"items":[' +
    '{"op":"add","name":"","content":""},' +
    '{"op":"add","name":"只有标题"},' +
    '{"op":"add","name":"有效","content":"事实","importance":99,"keys":["a","a","b","c","d","e","f","g"]},' +
    '{"op":"noop","id":"x"},' +
    '{"op":"noop"},' +
    '{"op":"delete","id":"y","name":"想删我","content":"没门"}' +
    ']}';
  const items = EX.parseItems(messy, '');
  eq('空壳被丢掉（noop 不算空壳）', items.filter((i) => i.op !== 'noop' && !i.name && !i.content).length, 0);
  eq('连 id 都没有的 noop 也丢掉', items.filter((i) => i.op === 'noop').length, 1);
  eq('只有标题的 add 被丢掉', items.filter((i) => i.name === '只有标题').length, 0);
  eq('非法 op 归到 add', items.find((i) => i.name === '想删我').op, 'add');
  const valid = items.find((i) => i.name === '有效');
  eq('重要度被夹到 5', valid.importance, 5);
  ok('触发词去重且不超过 6 个', valid.keys.length <= 6 && new Set(valid.keys).size === valid.keys.length, valid.keys);
  const noop = items.find((i) => i.op === 'noop');
  ok('noop 保留（Rust 侧据此计数跳过）', !!noop);
}
{
  const many = { items: [] };
  for (let i = 0; i < 20; i++) many.items.push({ op: 'add', name: 'n' + i, content: 'c' + i });
  eq('最多 5 条', EX.parseItems(JSON.stringify(many), '').length, 5);
}
{
  const strKeys = '{"items":[{"op":"add","name":"n","content":"c","keys":"猫, 咪咪、露娜"}]}';
  eq('keys 给字符串也认（逗号/顿号拆）', EX.parseItems(strKeys, '')[0].keys, ['猫', '咪咪', '露娜']);
}
{
  const badImp = '{"items":[{"op":"add","name":"n","content":"c","importance":"高"}]}';
  eq('重要度给非数字 → 不传（Rust 用旧值/新建 3）', EX.parseItems(badImp, '')[0].importance, undefined);
}
{
  const noImp = '{"items":[{"op":"update","id":"a","content":"c"}]}';
  const it = EX.parseItems(noImp, '')[0];
  ok('没提重要度时 JSON 里不该有这个键', !JSON.stringify(it).includes('importance'), JSON.stringify(it));
}
{
  const zero = '{"items":[{"op":"add","name":"n","content":"c","importance":0}]}';
  eq('important=0 当没给', EX.parseItems(zero, '')[0].importance, undefined);
}

console.log('\n[4] prompt 组装');
{
  const p = EX.buildPrompt('用户：你好\n助手：喵~', '- id=a | 标题：内容', '露娜');
  ok('带整理标记头（会话标题可辨识）', p.startsWith(EX.HEAD), p.slice(0, 20));
  ok('已有记忆进去了', p.includes('- id=a | 标题：内容'));
  ok('角色名进去了', p.includes('露娜'));
  ok('写着只输出 JSON', p.includes('只输出 JSON'));
  ok('说了最多 5 条', p.includes('最多 5 条'));
  ok('没有 delete 这条出路', !/op="delete"/.test(p));
}
{
  ok('没有已有记忆时给占位', EX.buildPrompt('d', '', '').includes('（暂无）'));
}
{
  const long = EX.existingText([{ id: 'a', name: 'n', content: 'x'.repeat(500) }]);
  ok('已有记忆单条会被截断', long.length < 300, long.length);
  const many = [];
  for (let i = 0; i < 100; i++) many.push({ id: 'i' + i, name: 'n', content: 'c' });
  ok('已有记忆条数封顶 30', EX.existingText(many).split('\n').length === 30);
}

console.log('\n[5] sessionFromUrl');
{
  const real = global.location;
  global.location = { pathname: '/a/chat/s/d0d1bef3-8548-456e-a208-1f0d541a6c50', hash: '' };
  eq('从真实 URL 里取会话 id', EX.sessionFromUrl(), 'd0d1bef3-8548-456e-a208-1f0d541a6c50');
  global.location = { pathname: '/', hash: '#/a/chat/s/abcdefgh-1234' };
  eq('hash 路由也认', EX.sessionFromUrl(), 'abcdefgh-1234');
  global.location = { pathname: '/', hash: '' };
  eq('首页没有会话 id', EX.sessionFromUrl(), '');
  if (real === undefined) delete global.location;
  else global.location = real;
}

console.log('\n' + (fail ? `✗ ${fail} 项失败` : `✓ 全部通过（${pass} 项）`));
process.exit(fail ? 1 : 0);
