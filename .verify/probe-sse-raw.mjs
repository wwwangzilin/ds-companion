/**
 * 看 DeepSeek 的原始 SSE 帧里到底有没有消息 id（决定「往下接着用」怎么实现）。
 *
 * 默认**不发请求**：只把窗口里 `__DSC_DS__.lastRaw`（上一次请求的原始响应）倒出来。
 * 如果内存里没有残留，加 `--send` 才会真发一条极短请求（花极小额度）。
 *
 * 用法：
 *   node .verify/probe-sse-raw.mjs            # 读残留，0 额度
 *   node .verify/probe-sse-raw.mjs --send     # 真发一条「请只回复两个字符：OK」
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CDP = 'http://127.0.0.1:9222';
// 落在脚本自己旁边（而不是写死某台机器的绝对路径）—— 这样别人 clone 下来也能直接用
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out-sse-raw.txt');
const SEND = process.argv.includes('--send');

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
      throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    }
    return out.result ? out.result.value : undefined;
  }
}

const target = (await (await fetch(CDP + '/json/list')).json()).find(
  (t) => t.url && t.url.includes('deepseek.com'),
);
if (!target) throw new Error('主页面不在（exe 没跑？）');
const page = new Page(target.webSocketDebuggerUrl);
await page.open();

const pre = JSON.parse(
  await page.eval(`JSON.stringify({
    hasUtil: typeof window.__DSC_DS_UTIL__ === 'object',
    len: ((window.__DSC_DS__ || {}).lastRaw || '').length,
    reply: ((window.__DSC_DS__ || {}).lastReply || '').slice(0, 80),
    sid: localStorage.getItem('dsc-memory-session') || ''
  })`),
);
console.log('残留状态:', JSON.stringify(pre));

let raw = '';
if (pre.len > 0 && !SEND) {
  raw = await page.eval(`(window.__DSC_DS__ || {}).lastRaw || ''`);
  console.log('用内存里的残留响应，未发请求');
} else {
  console.log('>>> 真发一条极短请求…');
  const r = JSON.parse(
    await page.eval(
      `window.__DSC_PING__({ prompt: '请只回复两个字符：OK' }).then(r => JSON.stringify(r))`,
    ),
  );
  console.log('结果:', JSON.stringify(r).slice(0, 200));
  raw = await page.eval(`(window.__DSC_DS__ || {}).lastRaw || ''`);
}

writeFileSync(OUT, String(raw), 'utf8');
console.log(`原始 SSE 已写到 ${OUT}（${String(raw).length} 字符）`);

// 关键：把帧里所有像 id 的字段挖出来
const keys = new Set();
for (const line of String(raw).split('\n')) {
  const t = line.trim();
  if (!t.startsWith('data:')) continue;
  const payload = t.slice(5).trim();
  if (!payload || payload === '[DONE]') continue;
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch {
    continue;
  }
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const p = path ? path + '.' + k : k;
      if (/id$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) keys.add(p + ' = ' + String(v).slice(0, 48));
      if (v && typeof v === 'object') walk(v, p);
    }
  };
  walk(obj && obj.v ? obj.v : obj, obj && obj.v ? 'v' : '');
}
console.log('\n--- 帧里所有 *id 字段 ---');
for (const k of keys) console.log('  ' + k);

// 顺便看一眼帧的顶层形状（每种路径来一条样本）
const shapes = new Map();
for (const line of String(raw).split('\n')) {
  const t = line.trim();
  if (!t.startsWith('data:')) continue;
  const payload = t.slice(5).trim();
  if (!payload || payload === '[DONE]') continue;
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch {
    continue;
  }
  const k = String(obj.p || obj.o || Object.keys(obj).join(',')).slice(0, 60);
  if (!shapes.has(k)) shapes.set(k, JSON.stringify(obj).slice(0, 220));
}
console.log('\n--- 帧形状样本 ---');
for (const [k, v] of shapes) console.log(`  [${k}]\n    ${v}`);

page.ws.close();
