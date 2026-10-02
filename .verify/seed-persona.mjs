/* 给隔离实例配一个「已激活的人设」—— 验收前置，别再手点
 *
 * 【为什么必须有这一步】dsc_turn_report 在 `active_persona` 为空时会**直接短路**：
 * 返回 ok:false / taskMode:false / stateText 空。于是 verify-taskmode 会整片假红
 * （实测全新隔离目录 11 项失败：连"技术话进工作态"都判不出来）——
 * 那看起来像回归，其实只是环境没配。这个脚本把这一步固定下来。
 *
 * 用法：node .verify/seed-persona.mjs [preset-id] [port]     # 默认 luna / 9222
 */

import { requireIsolation } from './_env.mjs';

const args = process.argv.slice(2);
const portArg = args.find((a) => /^\d+$/.test(a));
const presetId = args.find((a) => !/^\d+$/.test(a)) || 'luna';
const PORT = Number(portArg || process.env.DSC_CDP_PORT || 9222);

await requireIsolation();

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find((x) => x.url && x.url.includes('settings.html'));
if (!t) {
  console.error('设置窗口没开 —— 先跑 .verify\\probe-open-settings.mjs');
  process.exit(1);
}

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const slot = pending.get(m.id);
  if (slot) {
    pending.delete(m.id);
    slot(m);
  }
});
const call = (cmd, payload) => {
  const id = ++seq;
  ws.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: {
        expression: `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(payload || {})}).then(v => JSON.stringify({ok:true, v})).catch(e => JSON.stringify({ok:false, e:String(e)}))`,
        returnByValue: true,
        awaitPromise: true,
      },
    }),
  );
  return new Promise((res) => pending.set(id, (m) => res(JSON.parse(m.result.result.value))));
};

/** 在设置窗口里跑一段任意 JS（用来让它把自己内存里的列表刷新掉） */
const evalJs = (expr) => {
  const id = ++seq;
  ws.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }),
  );
  return new Promise((res) =>
    pending.set(id, (m) => res(m.result && m.result.result ? m.result.result.value : undefined)),
  );
};

const scan = await call('dsh_preset_scan');
if (!scan.ok) {
  console.error('扫描 DSH 预设失败：' + scan.e);
  process.exit(1);
}
console.log('可用预设：' + scan.v.map((p) => p.id).join(', '));
if (!scan.v.some((p) => p.id === presetId)) {
  console.error(`没有名为 ${presetId} 的预设（可用：${scan.v.map((p) => p.id).join(', ')}）`);
  process.exit(1);
}

const imported = await call('dsh_preset_import', { id: presetId });
if (!imported.ok) {
  console.error('导入失败：' + imported.e);
  process.exit(1);
}
const pid = imported.v.id;
console.log('导入 OK：' + pid + '（' + imported.v.name + '）');

const got = await call('config_get');
const cfg = got.v;
// 【坑】AppConfig 带 #[serde(rename_all = "camelCase")]，键名是 activePersona。
// 写 active_persona 会被 serde **静默忽略**（不报错、只是不生效），
// 于是这里"写了、也没报错、但什么都没发生" —— 必须按 camelCase 来。
const KEY = 'activePersona';
if (cfg[KEY] === pid) {
  console.log('已经是激活人设，无需改动');
} else {
  cfg[KEY] = pid;
  const saved = await call('config_set', { cfg });
  if (!saved.ok) {
    console.error('写配置失败：' + saved.e);
    process.exit(1);
  }
}

const back = (await call('config_get')).v;
if (back[KEY] !== pid) {
  console.error('激活没生效：配置里是 ' + JSON.stringify(back[KEY]) + '（键名 ' + KEY + '）');
  process.exit(1);
}
console.log('OK  当前激活人设 = ' + pid);

// 【必须刷新设置窗口的内存列表】标准流程是 probe-open-settings → seed-persona，
// 而设置窗口在**打开的那一刻**就把 personas 读进内存了 —— 那时隔离目录还是空的。
// 不刷新的话，状态页会一直说"还没有人设"，验收里那些 UI 断言就整片假红
// （实测 18 项：状态页列出角色=0、趋势曲线 polys=0、身体控件缺失……）。
// 看起来像产品坏了，其实只是脚本的顺序问题 —— 所以修在这一步，而不是改断言。
const reloaded = await evalJs(
  '(async function(){ if (typeof reload === "function") { await reload(); return "reloaded:" + personas.length; } return "no-reload-fn"; })()',
);
console.log('设置窗口列表：' + reloaded);

setTimeout(() => {
  try {
    ws.close();
  } catch {}
}, 100);
process.exit(0);
