/**
 * 真机提取一次（会真的花一次网页额度，约 700 字输入）。
 *
 * 为什么值得花：假回复只能证明管路通，证明不了「模型真的按 JSON 回」。
 * 这个脚本塞一段**虚构**对话 → 真跑 __DSC_EXTRACT__ → 打印结果与日志 →
 * 把这次提取出来的记忆全删掉（它们是虚构对话的产物，不该留在库里）。
 *
 * 用法：node .verify/live-extract.mjs
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 数据隔离门禁：脚本会真存真删，跑在主人的真实数据上就是拿记忆当沙包（见 _env.mjs）
import { requireIsolation } from './_env.mjs';
await requireIsolation();

const CDP = 'http://127.0.0.1:9222';
const LOG = join(tmpdir(), 'ds-companion.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

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
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    return out.result ? out.result.value : undefined;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const pick = async (needle) => {
  for (let i = 0; i < 40; i++) {
    const t = (await (await fetch(CDP + '/json/list')).json()).find((x) => x.url && x.url.includes(needle));
    if (t) {
      const p = new Page(t.webSocketDebuggerUrl);
      await p.open();
      return p;
    }
    await sleep(250);
  }
  throw new Error('找不到页面：' + needle);
};

const MARK = 'LIVE提取';
const SESSION = 'live-extract-probe';

const settings = await pick('settings.html');
const main = await pick('deepseek.com');

// 0) 清残留 + 确认登录态
for (const id of (await settings.eval(
  `window.__TAURI__.core.invoke('memory_list').then(l => l.filter(m => m.name.indexOf(${JSON.stringify(MARK)}) >= 0).map(m => m.id))`,
)) || []) {
  await settings.eval(`window.__TAURI__.core.invoke('memory_delete', { id: ${JSON.stringify(id)} })`);
}

const hasToken = await main.eval(`!!window.__DSC_DS_UTIL__.readToken()`);
check('页面里读得到登录 token', hasToken === true);
if (!hasToken) {
  console.log('\n没登录，先在那个窗口里登录再跑这个脚本');
  process.exit(2);
}

const memBefore = await settings.eval(`window.__TAURI__.core.invoke('memory_list').then(l => l.length)`);

// 1) 塞一段虚构对话（内容刻意是可长期记住的稳定事实，看模型抓不抓得住）
await main.eval(`window.__DSC_FORGET_TRANSCRIPT__()`);
await main.eval(
  `window.__DSC_REMEMBER_TURN__(${JSON.stringify(SESSION)},
    '我叫阿哲，做前端的，最近在写一个叫 Quill 的写作软件，平时喜欢喝冰美式，千万别加糖。',
    '收到~ 阿哲是做前端的，在写 Quill 写作软件，喝冰美式不加糖。那 Quill 是用什么技术栈写的呀？')`,
);
await main.eval(
  `window.__DSC_REMEMBER_TURN__(${JSON.stringify(SESSION)},
    'Tauri + ProseMirror，文档存 Markdown 并且用 git 管版本。',
    '明白了：Tauri + ProseMirror，文档落 Markdown、用 git 做版本管理。这样换机器和写 diff 都很方便呢。')`,
);
check('虚构对话已就位', (await main.eval(`window.__DSC_TRANSCRIPT__(${JSON.stringify(SESSION)}).length`)) === 2);

const logFrom = (() => {
  try {
    return readFileSync(LOG, 'utf8').length;
  } catch {
    return 0;
  }
})();

// 2) 真跑一次
console.log('\n>>> 真的发一条请求（约 700 字）…\n');
const t0 = Date.now();
const r = JSON.parse(
  await main.eval(`window.__DSC_EXTRACT__().then(r => JSON.stringify(r))`),
);
const elapsed = Math.round((Date.now() - t0) / 1000);
console.log('结果:', JSON.stringify(r), `(${elapsed}s)`);

const tail = (() => {
  try {
    return readFileSync(LOG, 'utf8').slice(logFrom);
  } catch {
    return '';
  }
})();
const extractLines = tail.split('\n').filter((l) => l.includes('EXTRACT') || l.includes('memory ingest'));
if (!r.ok) {
  console.log('\n--- 相关日志 ---');
  for (const l of extractLines) console.log(l);
}

check('真机提取成功（模型确实按 JSON 回了）', r.ok === true, r.error || '');
check('至少抽出 1 条', (r.added || 0) + (r.updated || 0) >= 1, JSON.stringify(r));
check('延迟合理（<120 秒）', (r.latencyMs || 0) < 120000, `${r.latencyMs}ms`);

// 3) 看看真抽出来的是什么（这是最有信息量的部分）
const after = (await settings.eval(
  `window.__TAURI__.core.invoke('memory_list').then(l => JSON.stringify(l.filter(m => m.name.indexOf(${JSON.stringify(MARK)}) >= 0 || m.createdAt > ${Date.now() - 600000})))`,
)) || '[]';
let fresh = [];
try {
  fresh = JSON.parse(after);
} catch {}
console.log('\n--- 这次真抽出来的记忆 ---');
for (const m of fresh) {
  console.log(
    `  · ${m.name}  [${m.characterId || '全局'} · 重要度 ${m.importance} · 触发词 ${(m.keys || []).join('/')}]`,
  );
  console.log(`    ${m.content}`);
}
const memAfter = await settings.eval(`window.__TAURI__.core.invoke('memory_list').then(l => l.length)`);
check('库里条目数增加了', memAfter > memBefore, `${memBefore} → ${memAfter}`);

// 4) 收尾：把这次抽出来的都删掉（虚构对话的产物不留）
let removed = 0;
for (const m of fresh) {
  await settings.eval(`window.__TAURI__.core.invoke('memory_delete', { id: ${JSON.stringify(m.id)} })`);
  removed++;
}
const left = await settings.eval(`window.__TAURI__.core.invoke('memory_list').then(l => l.length)`);
check('虚构对话的记忆已清干净', left === memBefore, `${memAfter} → ${left}（删了 ${removed} 条）`);
await main.eval(`window.__DSC_FORGET_TRANSCRIPT__()`);

main.close();
settings.close();
console.log(`\n${failed ? `✗ ${failed} 项失败` : '✓ 真机链路全通'}`);
process.exit(failed ? 1 : 0);
