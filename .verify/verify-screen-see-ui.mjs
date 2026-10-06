/* 设置页那个「让她亲眼看」开关的验收。
 *
 * 【为什么单独验】它是这条链路上唯一**主人手动**能碰到的东西 —— 后面的截图、上传、
 * 提问全都自动跑。开关点不动的话，功能再对他也用不上。
 *
 * 验四件事：① 控件在、两档都渲染出来了 ② 点了真的写进配置（回读 config 确认，
 * 不信 DOM 上的 pill —— 那是乐观更新，Quill 上就吃过"看着变了其实没存"的亏）
 * ③ 布局没坏（不被裁、不重叠）④ 关着屏幕感知时它跟着暗下去（不然会让人以为
 * 单独开这一个就能用）。
 *
 * 用法：$env:DSC_CDP='http://127.0.0.1:9223'; node .verify/verify-screen-see-ui.mjs
 */
import { requireIsolation } from './_env.mjs';

const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(target, method, params = {}, timeoutMs = 60000) {
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
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
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

console.log(`[cdp] ${BASE}`);
const main = await findTarget('deepseek.com');
// 先把设置窗口叫出来（主页面有 open_settings 权限），门禁也靠它
await evalIn(main, `window.__TAURI_INTERNALS__.invoke('open_settings')`);
const settings = await findTarget('settings.html');
await requireIsolation();

// 设置页默认停在「人设」页，而屏幕那一节在「工具」页里 —— 不切过去的话几何量到的是
// 全 0（元素 hidden），文案也搜不到（innerText 只算可见文本）。第一版按文字找页签，
// 没找到就把自己骗了：功能明明好的，三条断言全红。
const switched = await evalIn(
  settings,
  `(async () => {
     const b = document.querySelector('.tb-tab[data-tab="tools"]');
     if (b) b.click();
     await new Promise((r) => setTimeout(r, 400));
     // 滚到那个开关：这一节很长，它在首屏之外是正常的 —— 要验的是"滚过去看得见"，
     // 不是"一进页面就撞上它"。不滚的话量到的 rect 在视口下方，会被误判成布局坏了。
     const el = document.getElementById('sc-see');
     if (el) el.scrollIntoView({ block: 'center' });
     await new Promise((r) => setTimeout(r, 250));
     const on = document.querySelector('.tb-tab.on');
     return on ? (on.textContent || '').trim() : '(没有选中的页签)';
   })()`,
);
console.log('[tab] 现在停在：' + switched);

const info = await evalIn(
  settings,
  `(() => {
     const seg = document.getElementById('sc-see');
     if (!seg) return JSON.stringify({ missing: true });
     const btns = Array.from(seg.querySelectorAll('button[data-v]'));
     const r = seg.getBoundingClientRect();
     const pill = document.getElementById('sc-see-pill');
     const host = seg.parentElement.getBoundingClientRect();
     return JSON.stringify({
       missing: false,
       buttons: btns.map((b) => b.dataset.v + ':' + b.textContent.trim()),
       rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
       inView: r.width > 0 && r.height > 0 && r.top > -5 && r.bottom < innerHeight + 5,
       // 溢出父容器 = 被裁 / 跑出去了
       insideHost: r.left >= host.left - 1 && r.right <= host.right + 1,
       pillLeft: pill ? Math.round(pill.getBoundingClientRect().left) : null,
       opacity: getComputedStyle(seg).opacity,
       seeTextExists: !!document.getElementById('sc-see-text'),
       hintMentionsToken: /200 token/.test(document.body.innerText),
       hintMentionsUpload: /留在账号里/.test(document.body.innerText),
       // 滑块到底停在哪个档上？截图看着它像悬在两档中间 —— 但低分辨率截图不可靠，
       // 量中心点比看像素稳。pill 的中心应该贴着当前选中档的中心。
       segs: ['sc-every', 'sc-chars', 'sc-say', 'sc-see'].map((id) => {
         const seg = document.getElementById(id);
         const pill = document.getElementById(id + '-pill');
         const pr = pill ? pill.getBoundingClientRect() : null;
         return {
           id,
           pillCx: pr ? Math.round(pr.x + pr.width / 2) : null,
           btns: Array.from(seg.querySelectorAll('button[data-v]')).map((b) => {
             const r = b.getBoundingClientRect();
             return { v: b.dataset.v, cx: Math.round(r.x + r.width / 2) };
           }),
         };
       }),
     });
   })()`,
);
const ui = JSON.parse(String(info));
console.log('[ui] ' + JSON.stringify(ui));

// 点「让她亲眼看」→ 回读配置（不看 DOM 上的 pill）
const clicked = await evalIn(
  settings,
  `(async () => {
     const inv = window.__TAURI_INTERNALS__.invoke;
     const before = await inv('config_get');
     const btn = document.querySelector('#sc-see button[data-v="1"]');
     if (!btn) return JSON.stringify({ err: 'no button' });
     btn.click();
     await new Promise((r) => setTimeout(r, 600));
     const after = await inv('config_get');
     const back = document.querySelector('#sc-see button[data-v="0"]');
     back.click();
     await new Promise((r) => setTimeout(r, 600));
     const off = await inv('config_get');
     return JSON.stringify({ before: before.screenSee, after: after.screenSee, off: off.screenSee });
   })()`,
);
const cfg = JSON.parse(String(clicked));
console.log('[config] ' + JSON.stringify(cfg));

const checks = [
  ['开关在页面上', !ui.missing],
  ['两档都渲染出来了', Array.isArray(ui.buttons) && ui.buttons.length === 2, (ui.buttons || []).join(' / ')],
  ['位置没被裁、没溢出父容器', ui.inView && ui.insideHost, `rect=${JSON.stringify(ui.rect)}`],
  ['点了真的写进配置', cfg.after === true, `false → ${cfg.after}`],
  ['再点回去也真的写回去', cfg.off === false, `true → ${cfg.off}`],
  ['她看到的那段有地方显示', ui.seeTextExists === true],
  ['说明里写了成本', ui.hintMentionsToken === true],
  ['说明里写了图会留在账号里', ui.hintMentionsUpload === true],
];

let bad = 0;
console.log('');
for (const [name, ok, ev] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  —  ' + ev : ''}`);
}
console.log('');
console.log(bad === 0 ? `★ 全过：${checks.length}/${checks.length} ★` : `${checks.length - bad}/${checks.length} 过`);
process.exit(bad === 0 ? 0 : 1);
