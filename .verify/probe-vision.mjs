/* 手动验证：多模态那条路到底通不通。
 *
 * 【为什么必须真跑一次】"能传图"没法靠读代码确认：PoW 上传、返回里 id 叫什么、
 * ref_file_ids 到底认不认 —— 只有让模型把**图上的字念出来**才算数。
 *
 * ⚠ 每跑一次，主人的 DeepSeek 账号里就多一张图（上游没有删除接口）。
 * 所以这个脚本**默认不跑**，要显式给 DSC_VISION_TRY=1 才发。
 *
 * 用法：
 *   $env:DSC_VISION_TRY='1'; node .verify/probe-vision.mjs
 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('CDP 超时 ' + method));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
      }, 50);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP 连接失败'));
    };
  });
}

async function evalIn(target, expression, timeoutMs) {
  const r = await send(
    target,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r && r.result ? r.result.value : undefined;
}

async function findTarget(match, timeoutMs = 45000) {
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

if (String(process.env.DSC_VISION_TRY || '') !== '1') {
  console.log('没发请求 —— 每试一次账号里就多一张图。');
  console.log('确实要试：$env:DSC_VISION_TRY="1"; node .verify/probe-vision.mjs');
  process.exit(0);
}

console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com');
console.log('[probe] 现画一张带字的图，交给她看…');

const raw = await evalIn(
  main,
  `(async () => {
     try {
       const r = await window.__DSC_VISION_TRY__();
       return JSON.stringify({ ok: true, text: r && r.text, fileId: r && r.fileId });
     } catch (e) {
       return JSON.stringify({ ok: false, err: String((e && e.message) || e) });
     }
   })()`,
  120000,
);
const o = JSON.parse(raw || '{}');
console.log('[raw] ' + JSON.stringify(o).slice(0, 600));
console.log('');
if (!o.ok) {
  console.log('FAIL  ' + o.err);
  process.exit(1);
}
console.log('fileId = ' + o.fileId);
console.log('她看到的是：');
console.log('  ' + String(o.text || '').slice(0, 400));
const sawIt = /Tauri/.test(String(o.text || '')) || /主人/.test(String(o.text || ''));
console.log('');
console.log(sawIt ? 'PASS  图上的字她真的读出来了（多模态通了）' : 'FAIL  她没读出图上的字');

// 空回复时把"为什么"挖出来：文件到底解析好了没 + 上游原始响应长什么样
if (!sawIt) {
  console.log('');
  console.log('=== 诊断 ===');
  const diag = await evalIn(
    main,
    `(async () => {
       const util = window.__DSC_DS_UTIL__;
       let files = null;
       try { files = await util.fetchFiles([${JSON.stringify(o.fileId)}]); }
       catch (e) { files = 'fetchFiles 失败: ' + String(e && e.message); }
       return JSON.stringify({
         files: files,
         lastRaw: String(window.__DSC_LAST_RAW__ || '').slice(0, 1200)
       });
     })()`,
    60000,
  );
  console.log('[files] ' + JSON.stringify(JSON.parse(diag || '{}').files).slice(0, 900));
  console.log('[lastRaw] ' + JSON.parse(diag || '{}').lastRaw);
}
