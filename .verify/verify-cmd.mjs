/* run_command 验收：确认「她能跑命令」这件事只在主人点头之后、且只在白名单之内发生
 *
 * 【这一组的重点不是"能不能跑"，而是"跑不到不该跑的东西"】
 * 这是整个项目最危险的能力：前面几个工具的能力边界是工作区里的文件，这一块是"这台机器上
 * 跑得起来的程序"。所以每条用例都盯一个"放行就完了"的口子：
 *   · 命令里塞进第二条（`&&` / `|` / 重定向）
 *   · 非白名单程序（rm / powershell / curl / 带路径的 .exe）
 *   · 危险子命令（git push、npm install、cargo install）
 *   · 危险开关（node -e、python -c、--output=、--outDir）
 *   · 参数里读工作区外面的文件
 * 以及两条"不测就会静默发生"的后果：提案阶段就跑了、拒绝了还跑。
 *
 * 【它不花模型额度】全程只走壳里的命令（dsc_tool_invoke / *_decide），一次对话请求都不发。
 * 卡片那一组也不回灌（ctx 里故意不给 userPrompt）。
 *
 * 前置：壳以隔离数据 + CDP 启动（.\verify-run.ps1 -Keep），设置窗口开着，主页面已注入
 *   node .verify\probe-open-settings.mjs
 *   node .verify\verify-cmd.mjs
 *
 * 用法：node .verify\verify-cmd.mjs [port]
 */

import { requireIsolation } from './_env.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || process.env.DSC_CDP_PORT || 9222);
const CDP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const iso = await requireIsolation();

// 这个脚本会调十几次工具，额度用完会让后面的断言全变成假红 ——
// 隔离实例的配额就是给验收用的，直接清零。
try {
  unlinkSync(join(iso.path, 'tool-quota.json'));
} catch {
  /* 没有就没有 */
}

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 220) : ''}`);
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const out = r.result || {};
    if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails));
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
async function attach(match, probe) {
  let list = [];
  try {
    list = await targets();
  } catch {
    return null;
  }
  for (const t of list.filter((x) => x.url && x.url.includes(match))) {
    const p = new Page(t.webSocketDebuggerUrl);
    try {
      await p.open();
      if (!probe) return p;
      if (await p.eval(probe)) return p;
      p.close();
    } catch {
      try {
        p.close();
      } catch {}
    }
  }
  return null;
}

const st = await attach('settings.html', 'typeof window.__TAURI_INTERNALS__ === "object"');
if (!st) {
  console.error('设置窗口没开 —— 先跑 .verify\\probe-open-settings.mjs');
  process.exit(1);
}
const invoke = async (cmd, args) =>
  JSON.parse(
    await st.eval(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})})
         .then(v => JSON.stringify({ok:true, v})).catch(e => JSON.stringify({ok:false, e:String(e)}))`,
    ),
  );
const call = async (cmd, args) => {
  const r = await invoke(cmd, args);
  if (!r.ok) throw new Error(`${cmd} 失败：${r.e}`);
  return r.v;
};

const localDay = () => new Date().toISOString().slice(0, 10);
const tool = async (name, args) =>
  await call('dsc_tool_invoke', { call: { name, args, session: 'verify-cmd' }, day: localDay() });

// 这个脚本要调二十几次工具，而默认的"当日上限"是 20 —— 不抬的话跑到一半会撞上
// "今日额度用完"，后面全是假红（第一次跑就踩了，报的是"确认卡没出现"这种无关的错）。
// 隔离实例的配置本来就是给验收用的，跑完在 finally 里原样还原。
const cfg0 = await call('config_get');
await call('config_set', { cfg: { ...cfg0, toolDailyCap: 200 } });

// 独立工作区：里面放一个最小的 cargo 项目 —— `cargo build` 会产出可见的 target/ 目录，
// 那是"真的跑过了"的证据（用只读命令当探针的话，跑没跑看不出来）。
const ws = mkdtempSync(join(tmpdir(), 'dsc-cmd-ws-'));
writeFileSync(
  join(ws, 'Cargo.toml'),
  '[package]\nname = "probe"\nversion = "0.1.0"\nedition = "2021"\n',
);
mkdirSync(join(ws, 'src'), { recursive: true });
writeFileSync(join(ws, 'src', 'main.rs'), 'fn main() {}\n');
const ranEvidence = () => existsSync(join(ws, 'target'));

// 工作区外面的一个真文件：用来验"参数里指向工作区外的路径必须被拒"（存在才走得到 canonicalize 那一步）
const outside = join(tmpdir(), `dsc-cmd-outside-${Date.now()}.txt`);
writeFileSync(outside, 'SECRET');

const cleanup = () => {
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(outside, { force: true });
  } catch {}
};

try {
  await call('tools_set_workspace', { path: ws });
  await call('tools_set_enabled', { on: true });

  // ── ① 门：写/跑工具关着时，它连"存在"都不该被模型知道 ────────────────
  await call('tools_set_write_enabled', { on: false });
  const off = await call('dsc_tools_brief', { day: localDay() });
  check('关着时 run_command 不在可用清单里', !(off.names || []).includes('run_command'), (off.names || []).join('/'));
  const blocked = await tool('run_command', { command: 'cargo build' });
  check('关着时调用被拒', blocked.ok === false && blocked.allowed === false, JSON.stringify(blocked).slice(0, 160));
  check('关着时连提案都不产生', (await call('tool_pending_list')).length === 0);
  check('关着时什么都没跑', !ranEvidence());

  await call('tools_set_write_enabled', { on: true });
  const on = await call('dsc_tools_brief', { day: localDay() });
  check('打开后出现在可用清单里', (on.names || []).includes('run_command'), (on.names || []).join('/'));

  // ── ② 拒绝清单：这些一条都不许过（每条都要在**提案阶段**就挡回去）────
  const denied = [
    ['管道塞第二条', 'cargo build | more'],
    ['&& 串命令', 'cargo build && git push'],
    ['分号串命令', 'cargo build; rm -rf .'],
    ['输出重定向', 'cargo build > out.txt'],
    ['非白名单：rm', 'rm -rf .'],
    ['非白名单：powershell', 'powershell -Command dir'],
    ['非白名单：curl', 'curl http://example.com'],
    ['带路径的程序', 'C:\\Windows\\System32\\cmd.exe /c dir'],
    ['危险子命令：git push', 'git push origin main'],
    ['危险子命令：git commit', 'git commit -m x'],
    ['危险子命令：npm install', 'npm install'],
    ['危险子命令：cargo install', 'cargo install ripgrep'],
    ['危险开关：node -e', 'node -e "console.log(1)"'],
    ['危险开关：python -c', 'python -c "print(1)"'],
    ['危险开关：--output=', 'git diff --output=leak.txt'],
    ['危险开关：--outDir', 'tsc --outDir dist'],
    ['参数逃逸 ..', 'node ../evil.mjs'],
    ['参数指向工作区外', `node ${outside}`],
  ];
  let allDenied = true;
  for (const [label, command] of denied) {
    const r = await tool('run_command', { command });
    const ok = r.ok === false && !r.pendingId;
    if (!ok) allDenied = false;
    check(`拒绝：${label}`, ok, JSON.stringify(r).slice(0, 150));
  }
  check('被拒的一律没留下提案', (await call('tool_pending_list')).length === 0);
  check('被拒的一律没有跑（工作区里没有 target）', !ranEvidence());

  // 反向：白名单内的常用写法**必须放行**，否则这个工具等于没用
  const allowed = ['git status', 'cargo build --release', 'node scripts/x.mjs', 'tsc -p tsconfig.json'];
  for (const command of allowed) {
    const r = await tool('run_command', { command });
    const ok = !!r.pendingId;
    check(`放行：${command}`, ok, JSON.stringify(r).slice(0, 150));
    if (r.pendingId) await call('dsc_tool_proposal_decide', { id: r.pendingId, allow: false });
  }

  // ── ③ 提案阶段：只摆出来，绝不执行 ────────────────────────────────
  const pend = await tool('run_command', { command: 'cargo build' });
  check('run_command 返回的是待确认（不是成功）', !!pend.pendingId && pend.ok === false, JSON.stringify(pend).slice(0, 200));
  check('确认卡写明它会真的跑', String(pend.preview || '').includes('真的执行'), String(pend.preview || '').slice(0, 160));
  check('确认卡里有完整命令行与工作区', String(pend.preview || '').includes('$ cargo build') && String(pend.preview || '').includes(ws), String(pend.preview || '').slice(0, 200));
  check('提案阶段绝没有跑', !ranEvidence(), '这就是这套设计的地基');
  const list1 = await call('tool_pending_list');
  check('待确认列表里是 run_command', list1.length === 1 && list1[0].tool === 'run_command', JSON.stringify(list1.map((p) => p.tool)));

  // ── ④ 拒绝：什么都不发生 ─────────────────────────────────────────
  const no = await call('dsc_tool_proposal_decide', { id: pend.pendingId, allow: false });
  check('拒绝后没执行', no.ok === false, JSON.stringify(no).slice(0, 140));
  check('拒绝后依然没跑', !ranEvidence());
  check('拒绝后待确认列表空了', (await call('tool_pending_list')).length === 0);

  // ── ⑤ 允许：真的跑，且输出与退出码如实回来 ────────────────────────
  const pend2 = await tool('run_command', { command: 'cargo build', timeoutMs: 120000 });
  if (!pend2.pendingId) {
    check('允许执行这一条：提案落下了', false, JSON.stringify(pend2).slice(0, 200));
  } else {
    const yes = await call('dsc_tool_proposal_decide', { id: pend2.pendingId, allow: true });
    check('允许后执行成功', yes.ok === true, JSON.stringify(yes).slice(0, 200));
    check('允许后真的跑了（产出了 target/）', ranEvidence(), '只读命令当探针看不出来，所以用会产出目录的那种');
    check(
      '输出里有命令与退出码',
      String(yes.text || '').includes('$ cargo build') && String(yes.text || '').includes('退出码：0'),
      String(yes.text || '').slice(0, 200),
    );
  }

  // 非零退出码也要如实报（不能把"失败了"当成"没输出 = 成功"）
  const bad = await tool('run_command', { command: 'cargo metadata --manifest-path nonexistent.toml' });
  if (!bad.pendingId) {
    check('失败命令这一条：提案落下了', false, JSON.stringify(bad).slice(0, 200));
  } else {
    const badOut = await call('dsc_tool_proposal_decide', { id: bad.pendingId, allow: true });
    check(
      '失败的命令如实报非零退出码',
      String(badOut.text || '').includes('退出码：') && !String(badOut.text || '').includes('退出码：0'),
      String(badOut.text || '').slice(0, 200),
    );
  }

  // ── ⑥ 确认卡（页面侧真点一下）────────────────────────────────────
  const chat = await attach('chat.deepseek.com', 'typeof window.__DSC_ASK_CONFIRM__ === "function"');
  if (!chat) {
    check('主页面确认卡组件已注入', false, '没找到注入了 confirm.js 的页面');
  } else {
    check('主页面确认卡组件已注入', true);
    const cardPend = await tool('run_command', { command: 'git status' });
    await chat.eval(
      `window.__DSC_ASK_CONFIRM__(${JSON.stringify({
        id: cardPend.pendingId,
        preview: cardPend.preview,
        name: 'run_command',
        ctx: {},
      })})`,
    );
    await sleep(200);
    const txt = await chat.eval(
      "(function(){ var el = document.getElementById('dsc-confirm'); return el ? el.innerText : ''; })()",
    );
    check(
      '卡片说"她想跑一条命令"、按钮是"允许执行"',
      String(txt).includes('她想跑一条命令') && String(txt).includes('允许执行'),
      String(txt).slice(0, 140),
    );
    check('卡片里写着命令行原文', String(txt).includes('git status'), String(txt).slice(0, 160));
    await chat.eval("document.querySelector('#dsc-confirm [data-dsc-act=\"deny\"]').click()");
    await sleep(500);
    check('从卡片上拒绝后卡片收起来了', (await chat.eval("!!document.getElementById('dsc-confirm')")) === false);
    check('从卡片上拒绝后提案已清空', (await call('tool_pending_list')).length === 0);
    chat.close();
  }
} finally {
  // 收尾：额度还原、关回写工具、清掉工作区（别给后面的脚本留个半开的状态）
  try {
    await call('config_set', { cfg: cfg0 });
  } catch {}
  try {
    await call('tools_set_write_enabled', { on: false });
  } catch {}
  try {
    await call('tools_set_workspace', { path: '' });
  } catch {}
  try {
    await call('tools_set_enabled', { on: false });
  } catch {}
  cleanup();
  // 配额也还原：这个脚本要调二十几次，不留的话紧接着跑 verify-tools 会撞上"今日额度用完"
  try {
    unlinkSync(join(iso.path, 'tool-quota.json'));
  } catch {}
  st.close();
}

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
