/* DS Companion 验收脚本的隔离门禁（所有 .verify/*.mjs 都该 import 这一份）
 *
 * 【为什么必须有】
 * 这些脚本做的是"真存真删"：写记忆、改状态、存人设、跑自我修订。而 app 默认把
 * 数据写在 %APPDATA%\ds-companion —— 也就是主人**正在用**的那一份。实测后果：
 * memory-trash 里堆了 100+ 条测试残留（"验收整理-手写"之类），出现过
 * `state\dsh-luna.json.testpollution-backup` 这种"先备份真实文件再动手"的痕迹，
 * 还有几轮验收把主人的好感度/锚点改得七零八落。
 *
 * 两个后果都不是"小心一点"能解决的：① 测试结果不可重复（每次都在变动的真实状态上跑）
 * ② 出了事分不清哪条是主人的、哪条是脚本的。
 *
 * 【怎么用】
 *   import { requireIsolation } from './_env.mjs';
 *   await requireIsolation();          // 未隔离 → 直接退出（exit 2），不碰任何数据
 *
 * 要故意在真实数据上跑（几乎不该发生），显式说一声：
 *   $env:DSC_ALLOW_REAL_DATA='1'; node verify-xxx.mjs
 *
 * 【隔离怎么做】app 侧支持 `DSC_DATA_DIR`（见 src-tauri/src/personas.rs 的 app_root）：
 *   $env:DSC_DATA_DIR = "$env:TEMP\dsc-verify-<stamp>"
 *   .\target\debug\ds-companion.exe
 * 启动后设置界面「日志」页的数据目录行会标「已隔离（DSC_DATA_DIR）」。
 */

const CDP = process.env.DSC_CDP || 'http://127.0.0.1:9222';

/**
 * 问壳要"当前数据目录 + 隔没隔离"。
 *
 * 走的是 `data_dir` 这条命令，而**不是**读界面上的全局变量 —— 后者只在打开
 * 「日志」页时才刷新（refreshDataDir），被门禁依赖就会变成"没点到那一页就拒绝执行"
 * 的假拒绝。命令是随时可调的，跟界面停在哪个页签无关。
 */
async function readDataDirInfo(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json();
      const t = list.find((x) => x.url && x.url.includes('settings.html'));
      if (t) {
        const info = await new Promise((resolve, reject) => {
          const ws = new WebSocket(t.webSocketDebuggerUrl);
          const timer = setTimeout(() => {
            reject(new Error('CDP 超时'));
          }, 5000);
          ws.onopen = () =>
            ws.send(
              JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: {
                  expression:
                    "window.__TAURI_INTERNALS__.invoke('data_dir').then(v => JSON.stringify(v)).catch(e => JSON.stringify({ error: String(e) }))",
                  returnByValue: true,
                  awaitPromise: true,
                },
              }),
            );
          ws.onmessage = (ev) => {
            clearTimeout(timer);
            try {
              const msg = JSON.parse(ev.data);
              if (msg.id !== 1) return;
              const v = msg.result && msg.result.result && msg.result.result.value;
              const parsed = v ? JSON.parse(v) : null;
              // 不要在 onmessage 里立刻 close：会让 node 的 ws 在 uv 收尾阶段断言崩掉
              setTimeout(() => {
                try {
                  ws.close();
                } catch {}
              }, 50);
              resolve(parsed);
            } catch (e) {
              reject(e);
            }
          };
          ws.onerror = () => {
            clearTimeout(timer);
            reject(new Error('CDP 连接失败'));
          };
        });
        if (info && !info.error && info.path) return info;
        if (info && info.error) return { error: info.error };
      }
    } catch {
      /* 设置窗口还没开 / CDP 还没起：继续等 */
    }
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * 断言"脚本跑在隔离数据上"。不隔离就**拒绝执行**。
 *
 * 注意顺序：先问壳，再决定要不要继续 —— 绝不能在"可能碰真数据"的前提下先做任何写入。
 */
export async function requireIsolation() {
  if (String(process.env.DSC_ALLOW_REAL_DATA || '') === '1') {
    console.warn('[guard] 已显式允许在真实数据上跑（DSC_ALLOW_REAL_DATA=1）—— 出事自负');
    return { isolated: false, path: '(real)', memories: null, forced: true };
  }
  const info = await readDataDirInfo();
  if (!info) {
    console.error(
      [
        '',
        '[guard] 拿不到数据目录信息 —— 拒绝继续。',
        '  可能原因：① 设置窗口没开 ② 壳是旧的（没有 data_dir 命令）。',
        `  正确开法：$env:DSC_DATA_DIR="$env:TEMP\\dsc-verify"; .\\target\\debug\\ds-companion.exe`,
        '  要故意在真实数据上跑：$env:DSC_ALLOW_REAL_DATA="1"',
        '',
      ].join('\n'),
    );
    process.exit(2);
  }
  if (!info.isolated) {
    console.error(
      [
        '',
        '[guard] 当前跑在**真实数据**上，已拒绝执行：',
        `  数据目录：${info.path}`,
        `  里面已有 ${info.memories} 条记忆（那是主人的）`,
        '',
        '  正确开法：$env:DSC_DATA_DIR="$env:TEMP\\dsc-verify"; .\\target\\debug\\ds-companion.exe',
        '  确实要在真数据上跑：$env:DSC_ALLOW_REAL_DATA="1"',
        '',
      ].join('\n'),
    );
    process.exit(2);
  }
  console.log(`[guard] 数据目录已隔离：${info.path}`);
  return info;
}

export { readDataDirInfo, CDP };
