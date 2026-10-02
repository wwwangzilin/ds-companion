/**
 * SSE 解析单测：样本是**从真机抓下来的**响应（2026-09-27），
 * 上游改帧格式时这里会立刻变红。
 * 用法：node tools/test-sse.cjs
 */
const { parseSseText } = require('../src-tauri/inject/deepseek-client.js');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ① 真机原样：正文整段随"完整快照"到（踩过的坑，必须覆盖）
const REAL_SNAPSHOT = [
  'event: ready',
  'data: {"request_message_id":3,"response_message_id":4,"model_type":"default"}',
  '',
  'event: update_session',
  'data: {"updated_at":1790771234.324529}',
  '',
  'data: {"v":{"response":{"message_id":4,"parent_id":3,"role":"ASSISTANT","status":"WIP","fragments":[{"id":2,"type":"RESPONSE","content":"OK","references":[],"stage_id":1}],"conversation_mode":"DEFAULT"}}}',
  '',
  'data: {"p":"response/status","v":"FINISHED"}',
  '',
].join('\n');

check('整段在快照里也能解析出来', parseSseText(REAL_SNAPSHOT) === 'OK', JSON.stringify(parseSseText(REAL_SNAPSHOT)));

// ② 增量式：裸 {"v":"text"} 与 fragments/-1/content
const DELTA = [
  'data: {"p":"response/fragments","o":"APPEND","v":[{"id":1,"type":"RESPONSE","content":""}]}',
  'data: {"v":"你"}',
  'data: {"v":"好"}',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"呀"}',
  '',
].join('\n');
check('增量式拼接', parseSseText(DELTA) === '你好呀', JSON.stringify(parseSseText(DELTA)));

// ③ 思考片段不算正文
const THINK = [
  'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"THINK","content":"让我想想"}]}',
  'data: {"v":"，再想"}',
  'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"答案"}]}',
  'data: {"v":"是 42"}',
  '',
].join('\n');
check('THINK 不算正文', parseSseText(THINK) === '答案是 42', JSON.stringify(parseSseText(THINK)));

// ④ BATCH 包
const BATCH = [
  'data: {"p":"response","o":"BATCH","v":[{"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"甲"}]},{"v":"乙"}]}',
  '',
].join('\n');
check('BATCH 展开', parseSseText(BATCH) === '甲乙', JSON.stringify(parseSseText(BATCH)));

// ⑤ 快照后跟增量：不能把快照内容丢掉也不该重复
const SNAP_THEN_DELTA = [
  'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"前半"}]}}}',
  'data: {"v":"后半"}',
  '',
].join('\n');
check('快照 + 追加', parseSseText(SNAP_THEN_DELTA) === '前半后半', JSON.stringify(parseSseText(SNAP_THEN_DELTA)));

// ⑥ 坏数据不许炸
check('空串', parseSseText('') === '');
check('非 JSON 行被跳过', parseSseText('data: {不是json}\ndata: {"v":"ok"}') === 'ok');
check('没有 data 行', parseSseText('event: ping\n\n') === '');

// ⑦ 快照会重新声明 content，必须是替换而不是累加（否则尾部内容翻倍）
const SNAP_TWICE = [
  'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"A"}]}}}',
  'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"AB"}]}}}',
  '',
].join('\n');
check('同名快照替换而非累加', parseSseText(SNAP_TWICE) === 'AB', JSON.stringify(parseSseText(SNAP_TWICE)));

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
