/* 写工具验收：确认「她能改文件」这条路**只在主人点头之后**才通
 *
 * 【这一组的重点不是"能不能写"，而是"不点头就一定写不了"】
 * write_file 是唯一能改主人文件的能力，所以每条用例都盯一个"静默发生就完了"的后果：
 * 提案阶段就落盘了、拒绝了还写、越界写成了、覆盖了没备份、工具没开却能调。
 *
 * 【它不花模型额度】全程只走壳里的命令（dsc_tool_invoke / *_decide），
 * 一次对话请求都不发。卡片那一组也不回灌（ctx 里故意不给 userPrompt，
 * sendBack 会在发请求之前就退出）。
 *
 * 前置：壳以隔离数据 + CDP 启动（.\verify-run.ps1 -Keep），设置窗口开着，主页面已注入
 *   node .verify\probe-open-settings.mjs
 *   node .verify\verify-write.mjs
 *
 * 用法：node .verify\verify-write.mjs [port]
 */

import { requireIsolation } from './_env.mjs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || process.env.DSC_CDP_PORT || 9222);
const CDP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const iso = await requireIsolation();

// 这些用例要调十几次工具，而"今天额度用完了"会让后面的断言全变成假红 ——
// 隔离实例的配额就是给验收用的，直接清零（真数据上根本走不到这行：门禁会先 exit）。
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
  await call('dsc_tool_invoke', { call: { name, args, session: 'verify-write' }, day: localDay() });

// 独立工作区：绝不碰别的脚本/主人正在用的目录
const ws = mkdtempSync(join(tmpdir(), 'dsc-write-ws-'));
const outside = join(tmpdir(), `dsc-write-outside-${Date.now()}.txt`);
writeFileSync(outside, 'SECRET');

// tool-trash 的**基线**：同一个隔离实例上重复跑这个脚本是常态，备份只会越攒越多 ——
// 拿"绝对等于 1"去断言，第二次跑就必然假红（这条踩过一次）。只断言"比开跑前多一份"。
const trashDir = join(iso.path, 'tool-trash');
const trashBase = (() => {
  try {
    return readdirSync(trashDir).filter((n) => n.endsWith('hello.txt')).length;
  } catch {
    return 0;
  }
})();

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

  // ── ① 门：写工具没开时，它连"存在"都不该被模型知道 ──────────────────
  await call('tools_set_write_enabled', { on: false });
  const off = await call('dsc_tools_brief', { day: localDay() });
  check('写工具关着时不出现在可用清单里', !(off.names || []).includes('write_file'), (off.names || []).join('/'));
  check('读工具照旧可用', (off.names || []).includes('read_file'), (off.names || []).join('/'));

  const blocked = await tool('write_file', { path: 'blocked.txt', content: 'x' });
  check('关着时调用被拒', blocked.ok === false && blocked.allowed === false, JSON.stringify(blocked).slice(0, 160));
  check('关着时连提案都不产生', (await call('tool_pending_list')).length === 0);
  check('关着时磁盘上什么都没有', !existsSync(join(ws, 'blocked.txt')));

  await call('tools_set_write_enabled', { on: true });
  const on = await call('dsc_tools_brief', { day: localDay() });
  check('打开后出现在可用清单里', (on.names || []).includes('write_file'), (on.names || []).join('/'));
  check('brief 里带 pending 计数', typeof on.pending === 'number', String(on.pending));

  // ── ② 提案阶段：只摆出来，绝不落盘 ──────────────────────────────────
  const body = '第一行\n第二行 with spaces  \n';
  const pend = await tool('write_file', { path: 'hello.txt', content: body });
  check('write_file 返回的是待确认（不是成功）', !!pend.pendingId && pend.ok === false, JSON.stringify(pend).slice(0, 200));
  check('提案阶段磁盘上没有文件', !existsSync(join(ws, 'hello.txt')), '这就是整套设计的地基');
  check('确认卡拿得到预览', String(pend.preview || '').includes('hello.txt'), String(pend.preview || '').slice(0, 120));

  const list1 = await call('tool_pending_list');
  check('待确认列表里有且只有这一条', list1.length === 1 && list1[0].id === pend.pendingId, JSON.stringify(list1.map((p) => p.path)));
  check('提案里带 bytes / overwrite 信息', list1[0] && list1[0].bytes === Buffer.byteLength(body) && list1[0].overwrite === false, JSON.stringify(list1[0]).slice(0, 160));

  // ── ③ 拒绝：什么都不发生 ──────────────────────────────────────────
  const denied = await call('dsc_tool_proposal_decide', { id: pend.pendingId, allow: false });
  check('拒绝后结果是"没执行"', denied.ok === false, JSON.stringify(denied).slice(0, 160));
  check('拒绝后文件依然不存在', !existsSync(join(ws, 'hello.txt')));
  check('拒绝后待确认列表空了', (await call('tool_pending_list')).length === 0);
  const again = await invoke('dsc_tool_proposal_decide', { id: pend.pendingId, allow: true });
  check('同一条提案不能决定两次', again.ok === false, String(again.e).slice(0, 120));

  // ── ④ 允许：内容逐字节一致 ────────────────────────────────────────
  const pend2 = await tool('write_file', { path: 'hello.txt', content: body });
  const allowed = await call('dsc_tool_proposal_decide', { id: pend2.pendingId, allow: true });
  check('允许后执行成功', allowed.ok === true, JSON.stringify(allowed).slice(0, 160));
  check(
    '写出来的内容逐字节一致',
    existsSync(join(ws, 'hello.txt')) && readFileSync(join(ws, 'hello.txt'), 'utf8') === body,
    '不许 trim / 换行归一化',
  );

  // ── ⑤ 覆盖：旧内容必须进 tool-trash ───────────────────────────────
  const pend3 = await tool('write_file', { path: 'hello.txt', content: 'NEW' });
  const list3 = await call('tool_pending_list');
  check('覆盖已有文件会标成 overwrite', list3[0] && list3[0].overwrite === true, JSON.stringify(list3[0] || {}).slice(0, 160));
  await call('dsc_tool_proposal_decide', { id: pend3.pendingId, allow: true });
  check('覆盖后是新内容', readFileSync(join(ws, 'hello.txt'), 'utf8') === 'NEW');
  let backups = [];
  try {
    backups = readdirSync(trashDir).filter((n) => n.endsWith('hello.txt'));
  } catch {
    /* 目录不在 = 没备份，下面的断言会红 */
  }
  check('旧内容备份进了 tool-trash（比开跑前多一份）', backups.length === trashBase + 1, `基线 ${trashBase} → ${backups.join(',')}`);
  if (backups.length > trashBase) {
    // 文件名前缀是毫秒时间戳，取最新的那一份（旧的那些是上一轮跑留下的）
    const newest = backups.slice().sort().pop();
    check('备份里是旧内容（不是新的）', readFileSync(join(trashDir, newest), 'utf8') === body);
  }

  // ── ⑥ 越界与坏参数：在提案阶段就挡住 ─────────────────────────────
  const cases = [
    ['.. 逃逸', { path: '../dsc-write-outside.txt', content: 'x' }],
    ['工作区外的绝对路径', { path: outside, content: 'x' }],
    ['父目录不存在', { path: 'nope/deep/x.txt', content: 'x' }],
    ['空正文', { path: 'x.txt', content: '   ' }],
    ['目标是目录', { path: '.', content: 'x' }],
  ];
  for (const [label, args] of cases) {
    const r = await tool('write_file', args);
    check(`拒绝：${label}`, r.ok === false && !r.pendingId, JSON.stringify(r).slice(0, 140));
  }
  const big = 'a'.repeat(64 * 1024 + 10);
  const rBig = await tool('write_file', { path: 'big.txt', content: big });
  check('拒绝：超过单次写入上限', rBig.ok === false && !rBig.pendingId, JSON.stringify(rBig).slice(0, 140));
  check('越界目标一个字都没被动过', readFileSync(outside, 'utf8') === 'SECRET');
  check('坏参数一个提案都不留', (await call('tool_pending_list')).length === 0);

  // ── ⑥b edit_file：精确替换 ───────────────────────────────────────
  // 和 write_file 共用"不点头就不写"那一套；它自己多两条纪律：
  // **唯一匹配**（猜错就是改错地方，而且从预览看不出）与**底稿指纹**（确认前文件被别的手动过就作废）。
  writeFileSync(join(ws, 'edit-me.rs'), 'fn a() { 1 }\nfn b() { 2 }\nfn c() { 3 }\n');
  const beforeEdit = readFileSync(join(ws, 'edit-me.rs'), 'utf8');

  const ed = await tool('edit_file', { path: 'edit-me.rs', oldString: 'fn b() { 2 }', newString: 'fn b() { 22 }' });
  check('edit_file 返回的是待确认（不是成功）', !!ed.pendingId && ed.ok === false, JSON.stringify(ed).slice(0, 200));
  check(
    'edit 预览里能看到删掉/加上的两行',
    String(ed.preview || '').includes('- fn b() { 2 }') && String(ed.preview || '').includes('+ fn b() { 22 }'),
    String(ed.preview || '').slice(0, 160),
  );
  check('edit 提案阶段磁盘上没动过', readFileSync(join(ws, 'edit-me.rs'), 'utf8') === beforeEdit);
  const edOk = await call('dsc_tool_proposal_decide', { id: ed.pendingId, allow: true });
  check(
    '允许后按 old_string 精确改好（别的行没动）',
    edOk.ok === true && readFileSync(join(ws, 'edit-me.rs'), 'utf8') === 'fn a() { 1 }\nfn b() { 22 }\nfn c() { 3 }\n',
    JSON.stringify(edOk).slice(0, 200),
  );

  const notFound = await tool('edit_file', { path: 'edit-me.rs', oldString: 'fn zzz() {}', newString: 'x' });
  check('拒绝：找不到原文（不猜）', notFound.ok === false && !notFound.pendingId, JSON.stringify(notFound).slice(0, 160));

  writeFileSync(join(ws, 'dup.txt'), 'let x = 1;\nlet x = 2;\n');
  const dup = await tool('edit_file', { path: 'dup.txt', oldString: 'let x', newString: 'let z' });
  check('拒绝：原文出现多处（不唯一）', dup.ok === false && !dup.pendingId, JSON.stringify(dup).slice(0, 160));
  check('两次被拒之后文件原封不动', readFileSync(join(ws, 'dup.txt'), 'utf8') === 'let x = 1;\nlet x = 2;\n');

  const all = await tool('edit_file', { path: 'dup.txt', oldString: 'let x', newString: 'let z', replaceAll: true });
  check('明确 replaceAll 才允许全替换', !!all.pendingId, JSON.stringify(all).slice(0, 160));
  if (all.pendingId) {
    await call('dsc_tool_proposal_decide', { id: all.pendingId, allow: true });
    check('全替换结果对', readFileSync(join(ws, 'dup.txt'), 'utf8') === 'let z = 1;\nlet z = 2;\n');
  }

  // 底稿指纹：确认卡还挂着的时候文件被手动过 —— 必须拒绝，而不是照旧底稿硬写
  writeFileSync(join(ws, 'stale.txt'), '原样\n');
  const stale = await tool('edit_file', { path: 'stale.txt', oldString: '原样', newString: '改过' });
  check('底稿指纹的提案落下了', !!stale.pendingId, JSON.stringify(stale).slice(0, 160));
  writeFileSync(join(ws, 'stale.txt'), '原样\n主人手改\n');
  const staleOut = await call('dsc_tool_proposal_decide', { id: stale.pendingId, allow: true });
  check(
    '确认前文件被改过 → 拒绝执行',
    staleOut.ok === false && String(staleOut.error || '').includes('改动过'),
    JSON.stringify(staleOut).slice(0, 200),
  );
  check('手改的那行一个字都没被盖掉', readFileSync(join(ws, 'stale.txt'), 'utf8') === '原样\n主人手改\n');

  const edEsc = await tool('edit_file', { path: '../dsc-write-outside.txt', oldString: 'SECRET', newString: 'x' });
  check('edit 的 .. 逃逸照样拒', edEsc.ok === false && !edEsc.pendingId, JSON.stringify(edEsc).slice(0, 140));
  const edNew = await tool('edit_file', { path: 'nope-new.txt', oldString: 'a', newString: 'b' });
  check(
    'edit 目标不存在时拒，并提示改用 write_file',
    edNew.ok === false && !edNew.pendingId && String(edNew.error || '').includes('write_file'),
    JSON.stringify(edNew).slice(0, 180),
  );
  check('edit 这一组没留下待确认', (await call('tool_pending_list')).length === 0);

  // ── ⑦ 确认卡（页面侧真点一下） ────────────────────────────────────
  const chat = await attach('chat.deepseek.com', 'typeof window.__DSC_ASK_CONFIRM__ === "function"');
  if (!chat) {
    check('主页面确认卡组件已注入', false, '没找到注入了 confirm.js 的页面');
  } else {
    check('主页面确认卡组件已注入', true);
    const cardPend = await tool('write_file', { path: 'from-card.txt', content: 'card-body' });
    // ctx 里故意不给 userPrompt：点完不会去回灌（sendBack 会在发请求前就退出），
    // 所以这一组"真点一下"也不花额度
    await chat.eval(
      `window.__DSC_ASK_CONFIRM__(${JSON.stringify({
        id: cardPend.pendingId,
        preview: cardPend.preview,
        name: 'write_file',
        ctx: {},
      })})`,
    );
    await sleep(200);
    const shown = await chat.eval(
      "(function(){ var el = document.getElementById('dsc-confirm'); if (!el) return 'null'; return JSON.stringify({ allow: !!el.querySelector('[data-dsc-act=\\'allow\\']'), deny: !!el.querySelector('[data-dsc-act=\\'deny\\']'), text: el.innerText.slice(0,120) }); })()",
    );
    const card = JSON.parse(shown);
    check('确认卡出现在页面上', shown !== 'null');
    check('卡片有允许 / 拒绝两个按钮', card && card.allow && card.deny);
    check('卡片里写着要写的文件', card && card.text.includes('from-card.txt'), card && card.text);
    check('点之前没有写', !existsSync(join(ws, 'from-card.txt')));

    // 真点"允许"（走的是卡片自己的 click 监听）
    await chat.eval("document.querySelector('#dsc-confirm [data-dsc-act=\"allow\"]').click()");
    await sleep(700);
    check('点允许之后真的写了', existsSync(join(ws, 'from-card.txt')) && readFileSync(join(ws, 'from-card.txt'), 'utf8') === 'card-body');
    check('点完卡片自己收起来了', (await chat.eval("!!document.getElementById('dsc-confirm')")) === false);
    check('点完提案已清空', (await call('tool_pending_list')).length === 0);

    // 再来一条：点"拒绝"
    const rej = await tool('write_file', { path: 'rejected.txt', content: 'no' });
    await chat.eval(
      `window.__DSC_ASK_CONFIRM__(${JSON.stringify({ id: rej.pendingId, preview: rej.preview, name: 'write_file', ctx: {} })})`,
    );
    await sleep(150);
    await chat.eval("document.querySelector('#dsc-confirm [data-dsc-act=\"deny\"]').click()");
    await sleep(500);
    check('点拒绝之后没有写', !existsSync(join(ws, 'rejected.txt')));
    check('拒绝之后卡片也收起来了', (await chat.eval("!!document.getElementById('dsc-confirm')")) === false);

    // edit_file 的卡片文案要跟得上：写"允许写入"会让人以为是整篇覆盖
    const editCard = await tool('edit_file', { path: 'edit-me.rs', oldString: 'fn a() { 1 }', newString: 'fn a() { 11 }' });
    if (!editCard.pendingId) {
      check('edit 卡片：提案落下', false, JSON.stringify(editCard).slice(0, 160));
    } else {
      await chat.eval(
        `window.__DSC_ASK_CONFIRM__(${JSON.stringify({
          id: editCard.pendingId,
          preview: editCard.preview,
          name: 'edit_file',
          ctx: {},
        })})`,
      );
      await sleep(200);
      const txt = await chat.eval(
        "(function(){ var el = document.getElementById('dsc-confirm'); return el ? el.innerText : ''; })()",
      );
      check(
        'edit 卡片说的是"改"、按钮是"允许修改"',
        String(txt).includes('她想改一个文件') && String(txt).includes('允许修改'),
        String(txt).slice(0, 120),
      );
      await chat.eval("document.querySelector('#dsc-confirm [data-dsc-act=\"deny\"]').click()");
      await sleep(500);
      check(
        '从卡片上拒绝 edit 之后文件没变',
        readFileSync(join(ws, 'edit-me.rs'), 'utf8') === 'fn a() { 1 }\nfn b() { 22 }\nfn c() { 3 }\n',
      );
      check('edit 卡片拒绝后也收起来了', (await chat.eval("!!document.getElementById('dsc-confirm')")) === false);
    }
    chat.close();
  }
} finally {
  // 收尾：把写工具关回去、工作区清掉（别给后面的脚本留个半开的状态）
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
  // 把配额也还原：这个实例的配额文件本来就是给验收用的，而这个脚本要调十几次 ——
  // 不留的话，紧接着跑 verify-tools 就会撞上"今日额度用完"，看起来像工具坏了
  try {
    unlinkSync(join(iso.path, 'tool-quota.json'));
  } catch {}
  st.close();
}

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
