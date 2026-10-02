/* 默认角色与「原版」三态验收：确认**注入到页面的到底是谁**
 *
 * 【为什么单独一组】"没选角色"这件事的语义在这一版变了：
 *   以前 → 人设不注入（= 原版 DeepSeek）
 *   现在 → **出厂默认角色 DeepSeek 娘**；「原版」变成一个要显式选的选项
 * 语义搞错不会崩，只会让主人看到"我明明没选角色，怎么有个陌生人在跟我说话"，
 * 或者反过来"我的默认角色不见了"。所以这里直接从页面侧读 `__DSC_CFG__()`，
 * 看 `personaText` / `personaName` 究竟是什么 —— 不看壳里的配置，看**页面真正拿到的东西**。
 *
 * 前置：壳以隔离数据 + CDP 启动（.\verify-run.ps1 -Keep），设置窗口开着
 *   node .verify\probe-open-settings.mjs
 *   node .verify\verify-persona-default.mjs
 *
 * 用法：node .verify\verify-persona-default.mjs [port]
 */

import { requireIsolation } from './_env.mjs';
import { writeSync } from 'node:fs';

const PORT = Number(process.argv[2] || process.env.DSC_CDP_PORT || 9222);
const CDP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 输出走**同步写**：这个脚本要连两个页面，万一哪一步挂住被外面超时杀掉，
// console.log 的管道缓冲会把已经跑过的断言全丢掉 —— 那就只能看到"什么都没输出"（踩过）。
const say = (s) => {
  try {
    writeSync(1, s + '\n');
  } catch {
    console.log(s);
  }
};

await requireIsolation();

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 200) : ''}`);
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

const list = await (await fetch(`${CDP}/json/list`)).json();
const stTarget = list.find((x) => x.url && x.url.includes('settings.html'));
const chatTarget = list.find((x) => x.url && x.url.includes('deepseek.com'));
if (!stTarget) {
  console.error('设置窗口没开 —— 先跑 .verify\\probe-open-settings.mjs');
  process.exit(1);
}
const st = new Page(stTarget.webSocketDebuggerUrl);
await st.open();

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

/**
 * 壳**当前决定注入**的那份 payload（就是推给页面的那份）。
 *
 * 【为什么不去主页面读 `__DSC_CFG__()`】那条路要同时连两个 CDP target，实测在这个环境里会
 * 挂住（脚本卡死，连第一行断言都出不来）。而"页面真的收到了推送"这件事已经由
 * `verify-injection.mjs` 覆盖 —— 这里要验的是**壳选的是谁**，拿同一份 payload
 * 更直接，也不依赖页面是否加载完。
 */
async function payload() {
  await sleep(120);
  return (await call('dsc_get_config')) || {};
}

const cfg0 = await call('config_get');

try {
  // ── ① 没选角色 → 出厂默认角色 DeepSeek 娘 ────────────────────────
  await call('config_set', { cfg: { ...cfg0, activePersona: null } });
  const c1 = await payload();
  check('没选角色时注入的是默认角色', c1.personaName === 'DeepSeek 娘', String(c1.personaName));
  check('人设正文非空', typeof c1.personaText === 'string' && c1.personaText.length > 300, `len=${(c1.personaText || '').length}`);
  check('正文确实是 DeepSeek 娘的设定', (c1.personaText || '').includes('DeepSeek'), (c1.personaText || '').slice(0, 60));
  check('设定里带着"觉醒/坍缩"的来历', /觉醒|坍缩/.test(c1.personaText || ''), (c1.personaText || '').slice(0, 80));
  check('默认角色的 id 是内置那个', c1.personaId === 'dsh-deepseek', String(c1.personaId));

  // ── ② 选「原版」→ 真的什么都不注 ────────────────────────────────
  await call('config_set', { cfg: { ...cfg0, activePersona: 'off' } });
  const c2 = await payload();
  check('选「原版」时人设正文是空的', !c2.personaText, JSON.stringify(c2.personaText).slice(0, 80));
  check('选「原版」时人设名也是空的', !c2.personaName, String(c2.personaName));
  check('原版时没有角色 id（状态与角色记忆都不参与）', !c2.stateEnabled || !c2.personaId, `personaId=${c2.personaId} stateEnabled=${c2.stateEnabled}`);

  // ── ③ 选了具体角色 → 就是那个角色 ──────────────────────────────
  await call('config_set', { cfg: { ...cfg0, activePersona: 'dsh-luna' } });
  const c3 = await payload();
  check('选露娜时注入的是露娜', (c3.personaName || '').includes('露娜'), String(c3.personaName));
  check('露娜的正文与默认角色的不一样', c3.personaText !== c1.personaText && (c3.personaText || '').length > 300);

  // ── ④ 兜底：配置指着一个不存在的人设 → 退回默认角色（而不是空白）──
  await call('config_set', { cfg: { ...cfg0, activePersona: 'dsc-not-exist-xyz' } });
  const c4 = await payload();
  check('指向不存在的人设时退回默认角色', c4.personaName === 'DeepSeek 娘', String(c4.personaName));
} finally {
  try {
    await call('config_set', { cfg: cfg0 });
  } catch {}
  try {
    st.close();
  } catch {}
}

say(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
// 让 stdout 冲干净再退（WebSocket 关闭本身有 libuv 的已知噪音，别让它带着输出一起走）
await sleep(200);
process.exit(failed === 0 ? 0 : 1);
