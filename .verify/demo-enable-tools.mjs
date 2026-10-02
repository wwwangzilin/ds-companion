/* 把某个目录设成工作区 + 打开工具（演示/试用前的一次性配置）
 *
 * 为什么不在设置界面里手点：这一步是"想试试工具"的前置动作，手点要开设置窗口、
 * 切页签、填路径、开开关四步；而它本身很安全（工作区明确 + 只读工具），
 * 用脚本一次做完，用户可以直接去聊天里试。
 *
 * 用法：node .verify/demo-enable-tools.mjs <工作区目录> [port]
 *       node .verify/demo-enable-tools.mjs --off        # 关掉并清空工作区
 */
const args = process.argv.slice(2);
const OFF = args.includes('--off');
const wsPath = OFF ? '' : args.find((a) => !a.startsWith('-')) || '';
const PORT = Number(args.find((a) => /^\d+$/.test(a)) || 9222);
if (!OFF && !wsPath) {
  console.error('用法: node .verify/demo-enable-tools.mjs <工作区目录> [port]  |  --off');
  process.exit(2);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find((x) => x.url && x.url.includes('settings.html'));
if (!t) {
  console.error('设置窗口没开 —— 先在主窗口点右下角角标打开设置，或跑 probe-open-settings.mjs');
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
        expression: `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(payload)}).then(v => JSON.stringify({ok:true, v})).catch(e => JSON.stringify({ok:false, e:String(e)}))`,
        returnByValue: true,
        awaitPromise: true,
      },
    }),
  );
  return new Promise((res) => pending.set(id, (m) => res(JSON.parse(m.result.result.value))));
};

const shown = async (label, r) => {
  console.log(`${r.ok ? 'OK  ' : 'ERR '} ${label}: ${JSON.stringify(r.ok ? r.v : r.e)}`);
  return r;
};

await shown('清空/设置工作区', await call('tools_set_workspace', { path: wsPath }));
if (!OFF) {
  await shown('打开工具', await call('tools_set_enabled', { on: true }));
} else {
  await shown('关闭工具', await call('tools_set_enabled', { on: false }));
}
const st = await shown('当前状态', await call('tools_status', { day: new Date().toISOString().slice(0, 10) }));
if (st.ok) {
  console.log(
    `\n工具=${st.v.enabled ? '开' : '关'} · 工作区=${st.v.workspace || '(空)'} · 可用=${(st.v.names || []).join('/')} · 今日剩余=${st.v.leftToday}/${st.v.dailyCap}`,
  );
}
setTimeout(() => {
  try {
    ws.close();
  } catch {}
}, 100);
process.exit(0);
