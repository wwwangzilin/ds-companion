/* 只读探针：把截图交给模型，那条路到底怎么走。
 *
 * 【要回答的问题】completion 的 body 里有 `ref_file_ids`（见 deepseek-client.js:714），
 * 也就是说"引用文件"是上游自己的字段 —— 但文件得先**上传**拿到 id。上传打哪个接口、
 * 字段叫什么、返回什么形状，我们没有第一手资料。
 *
 * 【为什么不直接试一次上传】那会往主人的 DeepSeek 账号里塞一张测试图（他自己的文件列表
 * 会多出一个莫名其妙的东西，而且不一定删得掉）。所以这里走**只读**的路：
 * 把页面自己加载的 JS 拿下来搜关键字 —— 前端怎么传，我们就怎么传。
 *
 * 【别用 PowerShell 去改这个文件】踩过一次：`Get-Content -Raw` 按 GBK 解码、
 * `Set-Content -Encoding UTF8` 又写 BOM，中文全成乱码、文件结构也散了。
 * 改脚本一律用编辑器/写入工具。
 *
 * 用法：起隔离实例（带 9223）后
 *   node .verify/probe-upload-api.mjs
 *   $env:DSC_PROBE_KEYS="a,b,c"; node .verify/probe-upload-api.mjs     # 换关键字
 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEYS = (process.env.DSC_PROBE_KEYS || 'ref_file_ids,upload_file,file/upload').split(',');

let nextId = 1;
const events = [];

function connect(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        send(method, params = {}, timeoutMs = 30000) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error('CDP 超时 ' + method));
              }
            }, timeoutMs);
          });
        },
        close() {
          try {
            ws.close();
          } catch {}
        },
      });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error)));
        else res(m.result);
        return;
      }
      if (m.method) events.push(m);
    };
    ws.onerror = () => reject(new Error('CDP 连接失败'));
  });
}

async function findTarget(match, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(`${BASE}/json/list`)).json();
      const t = list.find((x) => x.url && x.url.includes(match));
      if (t) return t;
    } catch {}
    if (Date.now() > deadline) throw new Error('等不到 ' + match);
    await sleep(300);
  }
}

console.log(`[cdp] ${BASE}`);
console.log(`[keys] ${KEYS.join(' / ')}`);
const main = await findTarget('deepseek.com');
const cdp = await connect(main);
await cdp.send('Debugger.enable');
await sleep(1500);

/** 页面已经加载过的脚本（Debugger.enable 会把已知的都报一遍） */
const scripts = events
  .filter((e) => e.method === 'Debugger.scriptParsed')
  .map((e) => e.params)
  .filter((p) => p.url && p.url.startsWith('http'));
console.log(`[scripts] ${scripts.length} 个外部脚本`);

const hits = [];
let scanned = 0;
/** 每份源码最多扫这么多字符 —— 再大的部分是 vendor，跟上传无关 */
const SCAN_CAP = 1_600_000;
for (const s of scripts) {
  if (!/\.js(\?|$)/.test(s.url) && !s.url.includes('/assets/')) continue;
  scanned++;
  let src = '';
  try {
    const r = await cdp.send('Debugger.getScriptSource', { scriptId: s.scriptId }, 20000);
    src = (r.scriptSource || '').slice(0, SCAN_CAP);
  } catch {
    continue;
  }
  const found = KEYS.filter((k) => src.indexOf(k) >= 0);
  if (!found.length) continue;
  const excerpts = [];
  for (const k of found) {
    let i = -1;
    let n = 0;
    while ((i = src.indexOf(k, i + 1)) >= 0 && n < 4) {
      excerpts.push({
        key: k,
        text: src.slice(Math.max(0, i - 200), i + 200).replace(/\s+/g, ' '),
      });
      n++;
    }
  }
  hits.push({ url: s.url, size: src.length, found, excerpts });
}
cdp.close();

console.log(`[scanned] ${scanned} 个 js`);
console.log(`[hits] ${hits.length} 个文件命中\n`);
for (const h of hits) {
  console.log('='.repeat(100));
  console.log(h.url.slice(0, 130) + `   (${Math.round(h.size / 1024)}KB)  <- ${h.found.join(', ')}`);
  for (const e of h.excerpts) {
    console.log(`  [${e.key}] ...${e.text}...`);
  }
}
