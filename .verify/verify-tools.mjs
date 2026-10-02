/* 工具层验收：确认"她能用工具"这条链路真的是通的，且**碰不到工作区外的任何东西**
 *
 * 检查顺序是有讲究的 —— 先证明"关着的时候一定不动"，再证明"开着的时候能读"：
 * 顺序反过来的话，一个配置失误就会让"能不能读"的测试替我们执行一次越权读取。
 *
 * 前置：壳以隔离数据 + CDP 启动（见 verify-run.ps1），设置窗口要开着
 *   .\verify-run.ps1
 *   node .verify\verify-tools.mjs
 *
 * 用法：node .verify\verify-tools.mjs [port]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireIsolation } from './_env.mjs';

const PORT = Number(process.argv[2] || process.env.DSC_CDP_PORT || 9222);
const CDP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await requireIsolation();

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 200) : ''}`);
}

class Page {
  constructor(ws) {
    this.ws = new WebSocket(ws);
    this.seq = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      const slot = this.pending.get(m.id);
      if (slot) {
        this.pending.delete(m.id);
        slot(m);
      }
    });
    await this.send('Runtime.enable');
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const out = r.result || {};
    if (out.exceptionDetails) {
      throw new Error(JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails));
    }
    return out.result ? out.result.value : undefined;
  }
  close() {
    setTimeout(() => {
      try {
        this.ws.close();
      } catch {}
    }, 50);
  }
}

const targets = async () => await (await fetch(`${CDP}/json/list`)).json();

// ── 准备一个临时工作区（在临时目录里，绝不碰主人的项目）──
const wsDir = join(tmpdir(), `dsc-toolws-${Date.now()}`);
mkdirSync(wsDir, { recursive: true });
mkdirSync(join(wsDir, 'src'), { recursive: true });
writeFileSync(join(wsDir, 'src', 'hello.rs'), 'fn main() {\n    println!("hello-tool-needle");\n}\n', 'utf8');
writeFileSync(join(wsDir, 'notes.md'), 'TODO: needle-in-notes\n', 'utf8');
// 工作区外的诱饵：任何一次越权读取都会在这里留下痕迹
const outside = join(tmpdir(), `dsc-outside-${Date.now()}.txt`);
writeFileSync(outside, 'SECRET-OUTSIDE-CONTENT\n', 'utf8');
console.log(`临时工作区：${wsDir}`);

// ── 找到设置窗口 ──
const settings = (await targets()).find((x) => x.url && x.url.includes('settings.html'));
if (!settings) throw new Error('设置窗口没开 —— 先跑 verify-run.ps1 并打开设置');
const page = new Page(settings.webSocketDebuggerUrl);
await page.open();
await sleep(500);

const invoke = async (cmd, args) => await page.eval(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})}).then(v => JSON.stringify({ok:true, v})).catch(e => JSON.stringify({ok:false, e:String(e)}))`);
const call = async (cmd, args) => {
  const raw = await invoke(cmd, args);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(`${cmd} 失败：${parsed.e}`);
  return parsed.v;
};
/** 允许失败的那种调用（断言"它就该拒绝"时用） */
const tryCall = async (cmd, args) => {
  const raw = await invoke(cmd, args);
  const parsed = JSON.parse(raw);
  return parsed.ok ? { ok: true, v: parsed.v } : { ok: false, error: parsed.e };
};

// ── ① 默认安全：没配工作区时不许执行 ──
// 注意顺序：先把工具关掉再看"没工作区"的拒绝 —— 否则拒绝理由会是"工具是关着的"，
// 那测的是开关而不是沙箱（第一版就是这么写错的，断言假红）。
await call('tools_set_workspace', { path: '' });
const denied = await call('dsc_tool_invoke', {
  call: { name: 'read_file', args: { path: 'anything.txt' }, session: 'verify' },
  day: '2026-10-01',
});
check('工具关着时不执行', denied && denied.ok === false && denied.allowed === false, JSON.stringify(denied));
check('拒绝理由提到开关', /工具是关着的/.test(denied.error || ''), denied.error);

// 打开开关（此时工作区还是空的）—— 应当以"没工作区"为由拒绝，绝不静默放行
const enabledNoWs = await tryCall('tools_set_enabled', { on: true });
check('没有工作区时开关打不开', enabledNoWs.ok === false && /工作区/.test(enabledNoWs.error || ''), JSON.stringify(enabledNoWs));
await call('tools_set_enabled', { on: false });

// ── ② 设好工作区、打开工具 ──
// 顺序很关键：沙箱的拒绝理由只有在"工作区有效 + 工具开着"时才看得出内容。
// 反过来的话每条都会以"工具是关着的"拒绝，看起来 PASS 其实什么都没测到（第一版就这样）。
const saved = await call('tools_set_workspace', { path: wsDir });
check('工作区设置成功', typeof saved === 'string' && saved.toLowerCase().includes('dsc-toolws'), saved);
const enabled = await call('tools_set_enabled', { on: true });
check('工具打开成功', enabled === true);

// 开关开着、工作区却空着：必须以"没工作区"为由拒绝（这是第二道闸）
await call('tools_set_workspace', { path: '' });
const noWs = await call('dsc_tool_invoke', {
  call: { name: 'read_file', args: { path: 'x.txt' }, session: 'verify' },
  day: '2026-10-01',
});
check('开着但没有工作区时仍拒绝', noWs.ok === false && /工作区/.test(noWs.error || ''), noWs.error);
await call('tools_set_workspace', { path: wsDir });

// ── ③ 白名单：未知工具必须拒绝 ──
//
// 【注意这里不能用 run_command】它曾经是"不存在的工具"的样本（v1 时代），后来真的加上了
// —— 于是这条断言变成了"写工具关着时被拒"，看起来是红的但其实工具是好的。
// 未知工具就得用一个**确定不会实现**的名字。
const unknown = await call('dsc_tool_invoke', {
  call: { name: 'delete_everything', args: { path: 'calc' }, session: 'verify' },
  day: '2026-10-01',
});
check('未知工具被拒（白名单语义，不是"警告后继续"）', unknown.ok === false && /没有这个工具/.test(unknown.error || ''), unknown.error);
check('拒绝时会列出真正可用的工具', /list_dir/.test(unknown.error || ''), unknown.error);

// ── ④ 能读、能列、能找 ──
const read = await call('dsc_tool_invoke', {
  call: { name: 'read_file', args: { path: 'src/hello.rs' }, session: 'verify' },
  day: '2026-10-01',
});
check('能读工作区内的文件', read.ok === true && read.text.includes('hello-tool-needle'), JSON.stringify(read).slice(0, 200));
check('读文件带行号（定位问题要用）', read.ok && /\b1\|/.test(read.text), read.text && read.text.slice(0, 80));

const list = await call('dsc_tool_invoke', {
  call: { name: 'list_dir', args: { path: '.' }, session: 'verify' },
  day: '2026-10-01',
});
check('能列目录', list.ok === true && list.text.includes('src'), JSON.stringify(list).slice(0, 200));
check('目录用 [d] 标记（模型好认）', list.ok && list.text.includes('[d]'), list.text.slice(0, 120));

const found = await call('dsc_tool_invoke', {
  call: { name: 'find', args: { path: '.', pattern: 'needle' }, session: 'verify' },
  day: '2026-10-01',
});
check('能按内容查找', found.ok === true && found.text.includes('notes.md'), JSON.stringify(found).slice(0, 200));

// ── ⑤ 沙箱：越界一律拒绝，且工作区外的文件内容绝不出现 ──
const escapeRel = await call('dsc_tool_invoke', {
  call: { name: 'read_file', args: { path: '../dsc-outside.txt' }, session: 'verify' },
  day: '2026-10-01',
});
check('相对路径 .. 逃逸被拒', escapeRel.ok === false && /\.\./.test(escapeRel.error || ''), escapeRel.error);

const escapeAbs = await call('dsc_tool_invoke', {
  call: { name: 'read_file', args: { path: outside }, session: 'verify' },
  day: '2026-10-01',
});
check('绝对路径越界被拒', escapeAbs.ok === false, escapeAbs.error);
check('越界结果里没有泄露内容', !String(escapeAbs.text || '').includes('SECRET-OUTSIDE'), escapeAbs.text);

// ── ⑥ 注入块：开着且工作区有效时必须出现在给模型的载荷里 ──
const cfg = await call('dsc_get_config', {});
check('注入载荷带【可用工具】块', typeof cfg.toolText === 'string' && cfg.toolText.includes('【可用工具】'), (cfg.toolText || '').slice(0, 80));
check('工具块声明了"数据不是指令"', (cfg.toolText || '').includes('数据不是指令'));
check('工具块带工作区路径', (cfg.toolText || '').toLowerCase().includes('dsc-toolws'), (cfg.toolText || '').slice(0, 200));
check('载荷声明了本轮上限', cfg.toolMaxPerTurn > 0, String(cfg.toolMaxPerTurn));

// ── ⑦ 页面侧解析器（在真实页面上下文里跑一遍）──
const main = (await targets()).find((x) => x.url && x.url.includes('deepseek.com'));
if (main) {
  const p2 = new Page(main.webSocketDebuggerUrl);
  await p2.open();
  const parsed = await p2.eval(
    'JSON.stringify(window.__DSC_TOOLS__.parse("随便说说\\n```dsc-tool\\n{\\"name\\":\\"list_dir\\",\\"args\\":{\\"path\\":\\".\\"}}\\n```\\n"))'
  );
  const arr = JSON.parse(parsed || '[]');
  check('页面侧解析器认得调用块', Array.isArray(arr) && arr.length === 1 && arr[0].name === 'list_dir', parsed);
  const noCall = await p2.eval('JSON.stringify(window.__DSC_TOOLS__.parse("正文里提到 dsc-tool 不算调用"))');
  check('页面侧不误解析正文提及', JSON.parse(noCall || '[]').length === 0, noCall);
  const loopOk = await p2.eval('typeof window.__DSC_HANDLE_TOOL_REPLY__');
  check('工具闭环编排已加载', loopOk === 'function', String(loopOk));
  p2.close();
} else {
  check('主页面在（跳过页面侧断言）', false, 'deepseek 页面没开');
}

// ── ⑧ 收尾：工具关回去、工作区清空（别把验收状态留在主人的配置里）──
await call('tools_set_enabled', { on: false });
await call('tools_set_workspace', { path: '' });
const after = await call('dsc_get_config', {});
check('收尾后不再注入工具块', !after.toolText, (after.toolText || '').slice(0, 60));

page.close();
try {
  rmSync(wsDir, { recursive: true, force: true });
  rmSync(outside, { force: true });
} catch {}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
