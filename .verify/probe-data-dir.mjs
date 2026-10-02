/* 用 CDP 打开设置窗口，读回它自己报告的「数据目录」行
 *
 * 目的一：确认 data_dir 这条新命令在真机上通了（ACL / capability / 前端渲染全链路）。
 * 目的二：确认设置界面显示的路径就是隔离目录，而不是主人的真实数据目录。
 *
 * 用法：node .verify/probe-data-dir.mjs [port]
 * 前置：壳以 DSC_DATA_DIR 隔离 + --remote-debugging-port 启动（见 verify-run.ps1）
 */

import { readFileSync } from 'node:fs';
import { requireIsolation } from './_env.mjs';

const PORT = Number(process.argv[2] || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await requireIsolation();

class Page {
  constructor(ws) {
    this.ws = new WebSocket(ws);
    this.seq = 0;
    this.pending = new Map();
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(new Error('ws error'));
    });
  }
  send(method, params) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => this.pending.set(id, res));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.text || r.exceptionDetails));
    return r && r.result ? r.result.value : undefined;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const targets = async () => await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

let t = (await targets()).find((x) => x.url && x.url.includes('deepseek.com'));
if (!t) throw new Error('主页面不在（壳没跑？）');
const main = new Page(t.webSocketDebuggerUrl);
await main.open();
main.ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && main.pending.has(m.id)) {
    main.pending.get(m.id)(m.result);
    main.pending.delete(m.id);
  }
};

// 打开设置窗口（页面侧的角标/HUD 点一下也是走这条命令）
const opened = await main.eval(
  "window.__TAURI_INTERNALS__.invoke('open_settings').then(() => 'ok').catch(e => 'ERR ' + e)",
);
console.log('open_settings →', opened);
main.close();

// 等设置窗口起来并跑完 refreshDataDir
let settings = null;
for (let i = 0; i < 30; i++) {
  await sleep(400);
  const list = await targets();
  settings = list.find((x) => x.url && x.url.includes('settings.html'));
  if (settings) break;
}
if (!settings) throw new Error('设置窗口没起来');
// 页面还要加载 dist/settings.js 才装得上监听，别太快问
await sleep(3000);

const page = new Page(settings.webSocketDebuggerUrl);
await page.open();
page.ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && page.pending.has(m.id)) {
    page.pending.get(m.id)(m.result);
    page.pending.delete(m.id);
  }
};

const info = await page.eval('JSON.stringify(window.__DSC_DATA_DIR_INFO__ || null)');
const rowText = await page.eval(
  "(() => { const r = document.getElementById('data-row'); return r ? r.innerText.replace(/\\n/g, ' | ') : '(没有 data-row 元素)'; })()",
);
const flagClass = await page.eval(
  "(() => { const f = document.getElementById('data-flag'); return f ? f.className : '(无)'; })()",
);
page.close();

console.log('data_dir →', info);
console.log('设置页那一行 →', rowText);
console.log('flag class →', flagClass);

const parsed = info ? JSON.parse(info) : null;
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
};
check('data_dir 命令通了（不是 ERR）', !!parsed, info || 'null');
check('报告 isolated=true', !!parsed && parsed.isolated === true, parsed ? String(parsed.isolated) : '');
check(
  '路径不是真实 APPDATA 目录',
  !!parsed && !String(parsed.path).toLowerCase().includes('roaming\\ds-companion'),
  parsed ? parsed.path : '',
);
check('界面上真的渲染出来了', /dsc-verify|dsc-iso|Temp/i.test(String(rowText)), String(rowText).slice(0, 80));

process.exit(failed ? 1 : 0);
