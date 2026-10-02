/**
 * tools.js 的工具调用解析单测（node 直接跑，不需要构建）。
 * 用法：node tools/test-tools.cjs
 *
 * 【为什么单测解析】这一段是全链路上最容易出错、也最难在真机上查的地方：
 * 解析多了 -> 误执行（真读文件、白烧一轮额度）；解析少了 -> 她"想用工具"却静悄悄地
 * 什么都没发生（主人只会觉得她答得不对，完全想不到是解析挂了）。
 */
const { parseToolCalls, stripToolCalls, localDay } = require('../src-tauri/inject/tools.js');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── 正例 ──────────────────────────────────────────────────────────────
{
  const reply = '让我看看这个文件。\n\n```dsc-tool\n{"name":"read_file","args":{"path":"src/main.rs"}}\n```\n';
  const calls = parseToolCalls(reply);
  check('标准围栏能解析', calls.length === 1 && calls[0].name === 'read_file', JSON.stringify(calls.map((c) => c.name)));
  check('参数解析正确', calls[0] && calls[0].args.path === 'src/main.rs', JSON.stringify(calls[0] && calls[0].args));
  const stripped = stripToolCalls(reply, calls);
  check('摘掉调用块后不留 JSON', !stripped.includes('dsc-tool') && !stripped.includes('{'), JSON.stringify(stripped));
  check('摘掉后正文还在', stripped.includes('让我看看这个文件'), JSON.stringify(stripped));
}

// ── 反例（这些**必须**不解析，否则就是误执行）────────────────────────────
{
  // 正文里提了一嘴格式（很常见：它在解释协议）
  const prose = '格式是这样的：`dsc-tool` 后面跟 JSON。';
  check('正文提到 dsc-tool 不算调用', parseToolCalls(prose).length === 0, prose);

  // 普通代码块
  const code = '```js\nconst x = {"name":"read_file"};\n```\n';
  check('普通语言的代码块不算调用', parseToolCalls(code).length === 0, code);

  // 围栏但内容不是 JSON
  const badJson = '```dsc-tool\nread_file src/main.rs\n```\n';
  check('围栏内容不是 JSON 不算调用', parseToolCalls(badJson).length === 0, badJson);

  // 缺 name
  const noName = '```dsc-tool\n{"args":{"path":"a.txt"}}\n```\n';
  check('缺 name 不算调用', parseToolCalls(noName).length === 0, noName);

  // 空围栏
  check('空围栏不算调用', parseToolCalls('```dsc-tool\n```\n').length === 0);
  check('没有围栏返回空数组', parseToolCalls('就是一段普通回复').length === 0);
  check('null/undefined 不炸', parseToolCalls(null).length === 0 && parseToolCalls(undefined).length === 0);
}

// ── 宽容度 ────────────────────────────────────────────────────────────
{
  // 加了 xml 包装 / 前后有噪声：只试一次"第一个 { 到最后一个 }"
  const noisy = '```dsc-tool\n<tool>{"name":"list_dir","args":{"path":"."}}</tool>\n```\n';
  const calls = parseToolCalls(noisy);
  check('噪声包装里也能抠出调用', calls.length === 1 && calls[0].name === 'list_dir', JSON.stringify(calls));

  // 围栏标记后带空格（模型有时会写 ``` dsc-tool）
  const spaced = '```  dsc-tool\n{"name":"find","args":{"pattern":"TODO"}}\n```\n';
  check('围栏标记容忍空格', parseToolCalls(spaced).length === 1, JSON.stringify(parseToolCalls(spaced)));

  // 多个调用：解析出全部，但上层只跑第一个（这个策略在 tool-loop.js）
  const two =
    '```dsc-tool\n{"name":"read_file","args":{"path":"a"}}\n```\n\n```dsc-tool\n{"name":"list_dir","args":{"path":"."}}\n```\n';
  const multi = parseToolCalls(two);
  check('多个调用都解析出来（由编排层决定只跑第一个）', multi.length === 2, JSON.stringify(multi.map((c) => c.name)));
  check('每个调用都带原始文本（用于从正文里摘掉）', multi.every((c) => typeof c.raw === 'string' && c.raw.length > 10));
}

// ── 当日 key：格式必须是 YYYY-MM-DD（Rust 侧按它分桶，格式错了额度就乱）────────
{
  const d = localDay();
  check('localDay 是 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(d), d);
  const parts = d.split('-').map(Number);
  check('localDay 与系统日期一致', parts[0] === new Date().getFullYear(), d);
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
