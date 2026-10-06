/* 只读：把页面本地存着的「模型清单」挖出来 —— 传图要声明一个支持文件的 model_type，
 * 而它的取值是服务端下发的（代码里没有硬编码枚举）。
 *
 * 用法：node .verify/probe-model-type.mjs
 */
const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 40000) {
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

async function evalIn(target, expression, timeoutMs = 40000) {
  const r = await send(
    target,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r && r.result ? r.result.value : undefined;
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

const main = await findTarget('deepseek.com');

const keys = await evalIn(
  main,
  `(function(){
     const hit = [];
     const scan = (name, store) => {
       for (let i = 0; i < store.length; i++) {
         const k = store.key(i);
         let v = '';
         try { v = store.getItem(k) || ''; } catch (e) {}
         if (v.indexOf('model_type') >= 0 || v.indexOf('model_configs') >= 0 || v.indexOf('file_feature') >= 0) {
           hit.push({ store: name, key: k, len: v.length, head: v.slice(0, 160) });
         }
       }
     };
     scan('local', localStorage);
     scan('session', sessionStorage);
     return JSON.stringify(hit);
   })()`,
);
console.log('=== 本地缓存里跟模型有关的键 ===');
console.log(keys);

const found = JSON.parse(keys || '[]');
if (!found.length) {
  console.log('\n没找到缓存 —— 换个思路：抓一次真实请求看它的 model_type。');
  process.exit(0);
}

// 把命中的那个键整份挖出来，找 model_type / file_feature
const dump = await evalIn(
  main,
  `(function(){
     const out = [];
     const scan = (name, store) => {
       for (let i = 0; i < store.length; i++) {
         const k = store.key(i);
         let v = '';
         try { v = store.getItem(k) || ''; } catch (e) {}
         if (v.indexOf('model_type') < 0) continue;
         // 把形如 "model_type":"xxx" 和 "file_feature":{...} 的片段都捞出来
         const types = (v.match(/"model_type"\\s*:\\s*"[^"]+"/g) || []).slice(0, 30);
         const feats = (v.match(/"max_input_file_count"\\s*:\\s*[0-9]+/g) || []).slice(0, 10);
         if (types.length) out.push({ store: name, key: k, types: types, feats: feats });
       }
     };
     scan('local', localStorage);
     scan('session', sessionStorage);
     return JSON.stringify(out);
   })()`,
);
console.log('');
console.log('=== 挖到的 model_type ===');
console.log(dump);
