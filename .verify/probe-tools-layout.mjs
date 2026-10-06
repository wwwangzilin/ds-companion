/* 只读探针：把「工具」页每个 section 的排版量出来（谁有内边距、谁贴边、谁挤在一起）。
 *
 * 【为什么需要它】"挤成一坨"是眼睛的判断，而本小姐看不见图 —— 只能把几何量出来：
 * section 的左右内边距、内容区第一个元素离边框多远、元素之间的垂直间距。
 * 量出来才知道该改哪儿，而不是照着猜。
 *
 * 用法：起隔离实例（带 9223）后 node .verify/probe-tools-layout.mjs [页签名…]
 * 顺带把每页截图存到 preview/（本小姐看不见图，界面好不好看只能主人亲眼过一遍）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = dirname(fileURLToPath(import.meta.url));

function send(target, method, params = {}, timeoutMs = 20000) {
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
      if (m.error) return reject(new Error(JSON.stringify(m.error)));
      resolve(m.result);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP 连接失败'));
    };
  });
}

async function evalIn(target, expression) {
  const r = await send(target, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r && r.result ? r.result.value : undefined;
}

async function findTarget(match, timeoutMs = 30000) {
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

const main = await findTarget('deepseek.com', 45000);
await evalIn(main, `window.__TAURI_INTERNALS__.invoke('open_settings').then(()=>1).catch(e=>String(e))`);
const st = await findTarget('settings.html', 20000);
await sleep(800);

// 真实点一下页签，然后量这一页
const TABS = process.argv.slice(2).length ? process.argv.slice(2) : ['tools', 'log'];
for (const tab of TABS) {
  await evalIn(st, `(() => { const b = document.querySelector('.tb-tab[data-tab="${tab}"]'); if (b) b.click(); return !!b; })()`);
  await sleep(1200);
  const out = await evalIn(
    st,
    `(function(){
       const rows = [];
       const el = document.getElementById('tab-${tab}');
       const content = el.querySelector('.content');
       const cs = getComputedStyle(content);
       const cr = content.getBoundingClientRect();
       rows.push('######## TAB ${tab}  content pad=' + cs.padding + ' gap=' + cs.gap + ' scrollH=' + content.scrollHeight + ' clientH=' + content.clientHeight + ' overflowY=' + cs.overflowY);
       for (const sec of el.querySelectorAll('section')) {
         const scs = getComputedStyle(sec);
         const r = sec.getBoundingClientRect();
         const head = sec.querySelector('.editor-head, .hero-top, .health-head');
         const kids = [...sec.children].filter((k) => k !== head);
         const info = kids.map((k) => {
           const kr = k.getBoundingClientRect();
           const kcs = getComputedStyle(k);
           return {
             tag: k.tagName.toLowerCase(),
             cls: k.className || '',
             id: k.id || '',
             left: Math.round(kr.left),
             top: Math.round(kr.top),
             h: Math.round(kr.height),
             mt: kcs.marginTop,
             pad: kcs.padding,
             disp: kcs.display,
             text: (k.textContent || '').trim().slice(0, 22)
           };
         });
         const gaps = [];
         for (let i = 1; i < info.length; i++) gaps.push(Math.round(info[i].top - (info[i-1].top + info[i-1].h)));
         rows.push('--- <' + sec.tagName.toLowerCase() + ' class="' + sec.className + '"> pad=' + scs.padding + ' rect=' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' overflow=' + scs.overflowY);
         if (head) {
           const hr = head.getBoundingClientRect();
           rows.push('    HEAD h=' + Math.round(hr.height) + ' pad=' + getComputedStyle(head).padding);
         }
         info.forEach((k, i) => {
           rows.push('    [' + i + '] <' + k.tag + ' class="' + k.cls + '"' + (k.id ? ' id=' + k.id : '') + '> left=' + k.left + ' h=' + k.h + ' mt=' + k.mt + ' disp=' + k.disp + '  «' + k.text + '»');
         });
         rows.push('    GAPS=' + JSON.stringify(gaps));
         if (info.length) rows.push('    LEFT INDENT=' + (info[0].left - Math.round(r.left)) + '  BOTTOM GAP=' + (Math.round(r.bottom) - (info[info.length-1].top + info[info.length-1].h)));
       }
       return rows.join('\\n');
     })()`,
  );
  console.log(out);
  // 截图留给人看 —— 几何数字能证明"没贴边、有间距"，证明不了"好不好看"
  try {
    const shot = await send(st, 'Page.captureScreenshot', { format: 'png' });
    const file = join(HERE, '..', 'preview', `settings-${tab}.png`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`[shot] preview/settings-${tab}.png`);
  } catch (e) {
    console.log('[shot] 失败 ' + e);
  }
  console.log('');
}
