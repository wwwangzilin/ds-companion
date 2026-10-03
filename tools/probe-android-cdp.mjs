#!/usr/bin/env node
// 真机 WebView 的交互探针：证明「按钮真的能点」，而不只是「没报错」。
//
// 为什么需要它：logcat 只能给出**负面证据**（没有 Cannot redefine property）。
// 要证明 IPC 通、按钮能点，得直接问页面：
//   · __TAURI_INTERNALS__.invoke(...) 能不能拿到 Rust 的返回值
//   · 真发一次鼠标事件（Input.dispatchMouseEvent）后界面状态变没变
//
// 用法（先 `. D:\android-tools\env.ps1` 把 adb 放进 PATH）：
//   node tools/probe-android-cdp.mjs                  # 只探主页面 + IPC 往返
//   node tools/probe-android-cdp.mjs --open-settings  # 再开设置页，真点一次页签
//   node tools/probe-android-cdp.mjs --port 9223 --wait 3000

import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const PORT = Number(arg('port', 9222));
const WAIT_MS = Number(arg('wait', 2500));
const OPEN_SETTINGS = flag('open-settings');

const sh = (args) => execFileSync('adb', args, { encoding: 'utf8' });
const ok = (b) => (b ? '✓' : '✗');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log('  ✗ ' + msg);
};

// ── adb / CDP 底座 ───────────────────────────────────────────────────────

function findSocket() {
  const out = sh(['shell', 'cat', '/proc/net/unix']);
  const m = out.match(/@(webview_devtools_remote_\d+)/);
  if (!m) throw new Error('没找到 WebView 的 devtools socket —— 应用在跑吗？（debug 构建才会开调试端口）');
  return m[1];
}

const listTargets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const events = [];
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败：' + url)));
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  return { ready, send, events, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error('页面内抛错：' + JSON.stringify(res.exceptionDetails).slice(0, 400));
  return res.result.value;
}

function consoleErrors(events) {
  const out = [];
  for (const ev of events) {
    if (ev.method === 'Runtime.exceptionThrown') {
      const d = ev.params.exceptionDetails;
      out.push((d.exception && d.exception.description) || d.text || 'exception');
    } else if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') {
      out.push(ev.params.entry.text);
    } else if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      out.push(ev.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  }
  return out;
}

const PAGE_SELF = `(async () => {
  const out = {};
  const I = window.__TAURI_INTERNALS__;
  out.hasInternals = typeof I === 'object' && I !== null;
  out.injected = !!window.__DSC_INJECTED__;
  out.reinjectCount = window.__DSC_INJECTED_AGAIN__ || 0;
  out.readyState = document.readyState;
  out.href = location.href;
  out.viewport = { w: innerWidth, h: innerHeight, dpr: devicePixelRatio };
  const check = (o, k) => {
    try {
      const d = o && Object.getOwnPropertyDescriptor(o, k);
      return d ? (d.configurable ? 'configurable' : 'frozen') : 'missing';
    } catch (e) { return 'err'; }
  };
  out.internals = {};
  for (const k of ['postMessage','metadata','__TAURI_PATTERN__','path']) out.internals[k] = check(I, k);
  out.buttons = document.querySelectorAll('button, [role=button], .tab, a[href]').length;
  out.textLen = (document.body && document.body.innerText || '').length;
  try {
    const st = await I.invoke('dsc_state_get');
    out.invokeOk = true;
    out.stateKeys = st && typeof st === 'object' ? Object.keys(st).slice(0, 10) : String(st).slice(0, 80);
    out.mood = st && (st.mood ?? null);
  } catch (e) {
    out.invokeOk = false;
    out.invokeError = String((e && e.message) || e).slice(0, 300);
  }
  try {
    await I.invoke('dsc_get_config');
    out.configOk = true;
  } catch (e) {
    out.configOk = false;
    out.configError = String((e && e.message) || e).slice(0, 300);
  }
  return out;
})()`;

// ── 探一页 ───────────────────────────────────────────────────────────────

async function probePage(target, label, { waitMs = WAIT_MS } = {}) {
  console.log(`\n=== ${label} ===`);
  console.log(`  ${target.title}  ${target.url}`);
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await sleep(waitMs);

  const r = await evaluate(cdp, PAGE_SELF);
  console.log(`  视口 ${r.viewport.w}×${r.viewport.h} @${r.viewport.dpr}  文本 ${r.textLen} 字  可点元素 ${r.buttons} 个`);
  if (!r.hasInternals) fail('__TAURI_INTERNALS__ 不存在（Tauri 引导脚本没跑起来）');
  else console.log('  ✓ __TAURI_INTERNALS__ 存在：' + Object.entries(r.internals).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(`  ${ok(r.injected)} 我们的注入脚本跑过（__DSC_INJECTED__，重复计数 ${r.reinjectCount}）`);
  if (r.reinjectCount !== 0) fail(`注入跑了 ${r.reinjectCount + 1} 次（双注入没关干净）`);
  if (!r.invokeOk) fail(`invoke('dsc_state_get') 失败：${r.invokeError}`);
  else console.log(`  ✓ invoke('dsc_state_get') → ${JSON.stringify(r.stateKeys)} mood=${r.mood}`);
  if (!r.configOk) fail(`invoke('dsc_get_config') 失败：${r.configError}`);
  else console.log("  ✓ invoke('dsc_get_config') → 拿到配置");

  const errs = consoleErrors(cdp.events);
  const bad = errs.filter((e) => /Cannot redefine property|runCallback/.test(e));
  if (bad.length) fail(`有 ${bad.length} 条 IPC 引导类错误：${bad[0].split('\n')[0].slice(0, 160)}`);
  else console.log('  ✓ 没有 Cannot redefine property / runCallback 类错误');
  for (const e of [...new Set(errs)].slice(0, 5)) {
    if (!bad.includes(e)) console.log('    · ' + String(e).split('\n')[0].slice(0, 160));
  }

  return { cdp, r };
}

// ── 真点一次页签 ─────────────────────────────────────────────────────────

async function clickTest(cdp) {
  console.log('\n--- 真发一次鼠标点击（设置页页签）---');
  const tabs = await evaluate(
    cdp,
    `(() => {
      const pick = [...document.querySelectorAll('.tab, .tabs button, nav button, [data-tab]')];
      return pick.map((el, i) => {
        const b = el.getBoundingClientRect();
        return { i, label: (el.innerText || el.textContent || '').trim().slice(0, 20),
                 x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),
                 w: Math.round(b.width), h: Math.round(b.height),
                 active: el.classList.contains('on') || el.classList.contains('active') || el.classList.contains('is-active') || el.getAttribute('aria-selected') === 'true' };
      });
    })()`
  );
  if (!tabs.length) {
    fail('设置页里没找到页签元素（选择器 .tab/.tabs button/nav button/[data-tab] 都不中）');
    return;
  }
  console.log('  页签：' + tabs.map((t) => `${t.label}${t.active ? '(当前)' : ''}`).join(' | '));
  const inView = tabs.filter((t) => t.w > 0 && t.h > 0 && t.x > 0 && t.y > 0);
  if (!inView.length) {
    fail('所有页签都不在可视区（宽高或坐标为 0）—— 布局把它们挤没了');
    return;
  }
  const target = inView.find((t) => !t.active) || inView[0];
  const before = await evaluate(cdp, `document.body.innerText.length`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: target.x, y: target.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
    });
  }
  await sleep(700);
  const after = await evaluate(
    cdp,
    `(() => {
      const pick = [...document.querySelectorAll('.tab, .tabs button, nav button, [data-tab]')];
      const act = pick.findIndex((el) => el.classList.contains('on') || el.classList.contains('active') || el.classList.contains('is-active') || el.getAttribute('aria-selected') === 'true');
      return { activeIdx: act, label: act >= 0 ? (pick[act].innerText || '').trim().slice(0, 20) : null, len: document.body.innerText.length };
    })()`
  );
  console.log(`  点了「${target.label}」→ 当前页签「${after.label}」，正文 ${before} → ${after.len} 字`);
  if (after.label === target.label || after.len !== before) console.log('  ✓ 界面真的响应了');
  else fail('点了没反应（页签没变、正文长度也没变）');
}

// ── 主流程 ───────────────────────────────────────────────────────────────

console.log('… 找 WebView 调试通道');
const socket = findSocket();
console.log(`✓ socket: @${socket}`);
sh(['forward', `tcp:${PORT}`, `localabstract:${socket}`]);
console.log(`✓ adb forward tcp:${PORT} → ${socket}`);

let targets = await listTargets();
const main = targets.find((t) => t.type === 'page' && /deepseek\.com/.test(t.url)) || targets.find((t) => t.type === 'page');
if (!main) throw new Error('没有可用的 page target（应用启动了吗？）');
const { cdp: mainCdp } = await probePage(main, '主页面（chat.deepseek.com）');

if (OPEN_SETTINGS) {
  console.log('\n… 从主页面 invoke open_settings_at（等于点了「设置」按钮）');
  await evaluate(mainCdp, `window.__TAURI_INTERNALS__.invoke('open_settings_at', { tab: null })`);
  await sleep(2500);
  targets = await listTargets();
  const settings = targets.find((t) => t.type === 'page' && /settings\.html/.test(t.url));
  if (!settings) {
    fail('设置窗口没有出现在 CDP target 里 —— 说明它根本没建起来（Android 上多窗口可能不被支持）');
    console.log('  当前 targets：' + targets.map((t) => `${t.type}:${t.url}`).join('  '));
  } else {
    const { cdp } = await probePage(settings, '设置页（settings.html）');
    await clickTest(cdp);
    cdp.close();
  }
}

mainCdp.close();
console.log(`\n--- 结论 ---\n${failures === 0 ? '通过：IPC 通、注入只跑一次、界面有响应。' : `不通过：${failures} 处断点，见上面 ✗。`}`);
if (failures) process.exitCode = 1;
