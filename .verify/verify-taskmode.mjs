/* 任务模式验收：证明"干活时她收着点、闲聊时她照旧"
 *
 * 【为什么必须端到端】Rust 单测只能证明 sense_task/TaskTracker 这些纯函数对不对；
 * 真正要证明的是这条链路：主人说一句技术话 → 壳判成工作态 → 注入前缀里出现
 * 【工作模式】 → 状态块被压成一行 → 主动搭话静默。任何一环没接上，单测都会全绿。
 *
 * 前置：壳以 CDP 启动 + 设置窗口开着（见 verify-run.ps1）
 * 用法：node .verify\verify-taskmode.mjs [port]
 *
 * 【它不花额度】全程不触发真实对话：直接调 dsc_turn_report（那是每轮的入口），
 * 再读载荷/前缀做断言。真正要花钱的"她会不会真的收着点"是模型行为，不属于本脚本。
 */

import { requireIsolation } from './_env.mjs';

const PORT = Number(process.argv[2] || process.env.DSC_CDP_PORT || 9222);
const CDP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await requireIsolation();

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 220) : ''}`);
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

const targets = async () => await (await fetch(`${CDP}/json/list`)).json();
const settings = (await targets()).find((x) => x.url && x.url.includes('settings.html'));
if (!settings) throw new Error('设置窗口没开 —— 先跑 verify-run.ps1 并打开设置');
const page = new Page(settings.webSocketDebuggerUrl);
await page.open();
await sleep(400);

const invoke = async (cmd, args) =>
  await page.eval(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})})
       .then(v => JSON.stringify({ok:true, v})).catch(e => JSON.stringify({ok:false, e:String(e)}))`,
  );
const call = async (cmd, args) => {
  const r = JSON.parse(await invoke(cmd, args));
  if (!r.ok) throw new Error(`${cmd} 失败：${r.e}`);
  return r.v;
};

/** 报一轮，返回 TurnReport（这就是每轮真正走的那条入口） */
const turn = async (text) => await call('dsc_turn_report', { userText: text, hour: 15 });

// ── ⓪ 先自证：脚本必须**可重复跑**。
// 任务模式的跟踪器活在壳的内存里，上一次跑完可能停在"工作态"（脚本尾部正好会把它
// 留成工作态）—— 直接开始断言就会得到一串假红（实测：第二次跑就红了 4 条）。
// 所以先显式把它拉回已知基线：两种情景测一下，确认跟踪器是干净的。
const base1 = await turn('src/App.tsx 报错了');
const base2 = await turn('嘿嘿');
const base3 = await turn('陪我聊会儿天嘛');
check('基线：跟踪器已在日常态（脚本可重复跑）', base3.taskMode === false, JSON.stringify({ taskMode: base3.taskMode }));

// ── ① 日常闲聊：不该进工作态，状态块给全量 ──
const daily = await turn('本小姐今天好想你呀');
check('闲聊不进工作态', daily.taskMode === false, JSON.stringify({ taskMode: daily.taskMode, task: daily.taskText }));
check('闲聊不给【工作模式】块', !daily.taskText, String(daily.taskText).slice(0, 80));
check('闲聊的状态块是全量（含好感）', /好感/.test(daily.stateText || ''), String(daily.stateText).slice(0, 120));

// ── ② 技术话：必须进工作态，且状态块被压缩 ──
const work1 = await turn('这个 error[E0603] 怎么修，src/App.tsx 里 import 报错');
check('技术话进工作态', work1.taskMode === true, JSON.stringify({ taskMode: work1.taskMode }));
check('模式切换被标记（页面据此闪角标）', work1.taskChanged === true, String(work1.taskChanged));
check('给了【工作模式】块', /【工作模式】/.test(work1.taskText || ''), String(work1.taskText).slice(0, 100));
check('工作块要求收敛语气', /先办事/.test(work1.taskText || '') && /准确 > 好玩/.test(work1.taskText || ''));
check(
  '工作态的状态块被压缩（不含好感/身体）',
  !/好感/.test(work1.stateText || '') && !/身体：/.test(work1.stateText || ''),
  String(work1.stateText).slice(0, 160),
);

// ── ③ 工作态下不扣好感（这是"干活不该磨掉关系"的核心断言）──
const before = await call('state_get', { characterId: daily.state.characterId });
await turn('烦死了，又崩了，这个 bug 真恶心，编译器太烂了');
const after = await call('state_get', { characterId: daily.state.characterId });
check(
  '工作态下的负面话不扣好感',
  after.affinity >= before.affinity,
  `affinity ${before.affinity} -> ${after.affinity}`,
);

// ── ④  hysteresis：一轮闲聊不该立刻退出，两轮才退 ──
const backOne = await turn('嘿嘿');
check('一轮闲聊不退出工作态（防忽开忽关）', backOne.taskMode === true, JSON.stringify({ taskMode: backOne.taskMode }));
const backTwo = await turn('陪我聊会儿天嘛');
check('连续两轮闲聊才退出', backTwo.taskMode === false, JSON.stringify({ taskMode: backTwo.taskMode }));
check('退出也算一次切换（角标要闪）', backTwo.taskChanged === true, String(backTwo.taskChanged));

// ── ⑤ 页面侧确实把它拼进了注入前缀 ──
const main = (await targets()).find((x) => x.url && x.url.includes('deepseek.com'));
if (main) {
  const p2 = new Page(main.webSocketDebuggerUrl);
  await p2.open();
  // 让页面进入工作态（走 reportTurn 那条真实路径）
  await p2.eval("window.__DSC_REPORT_TURN__('git push 报 non-fast-forward，帮我看看')");
  await sleep(1200);
  const seen = await p2.eval(
    "JSON.stringify({taskMode: !!window.__DSC_CFG__().taskMode, hasBlock: /【工作模式】/.test(window.__DSC_CFG__().taskText || '')})",
  );
  const s = JSON.parse(seen || '{}');
  check('页面进入了工作态', s.taskMode === true, seen);
  check('页面拿到了【工作模式】块', s.hasBlock === true, seen);
  // 真正拼进 prompt 的前缀（augment 里用的那份）。
  //
  // 【别用 __DSC_AUGMENT__ 的返回值做断言】它返回的是 JSON 字符串，而 CDP 的
  // Runtime.evaluate 再把它包一层 —— 解析出 null 时会静默变成空 prompt，
  // 于是"前缀里有没有工作模式"这条断言假红（实测踩过）。
  // 规矩：**在页面里完成判断，只把布尔结果送回来**。
  const orderOk = await p2.eval(
    `(function(){
       const body = window.__DSC_AUGMENT__(JSON.stringify({prompt:'x', chat_session_id:'probe-tm'}), 'probe');
       if (!body) return JSON.stringify({err:'augment 返回空'});
       const p = JSON.parse(body).prompt || '';
       return JSON.stringify({
         len: p.length,
         hasTask: p.indexOf('【工作模式】') >= 0,
         taskBeforePersona: p.indexOf('【工作模式】') >= 0 && p.indexOf('【工作模式】') < p.indexOf('【人设】'),
         head: p.slice(0, 40)
       });
     })()`,
  );
  const o = JSON.parse(orderOk || '{}');
  check('注入前缀里真的带上了【工作模式】', o.hasTask === true, JSON.stringify(o));
  check('工作模式排在【人设】之前（越靠前越硬）', o.taskBeforePersona === true, JSON.stringify(o));
  p2.close();
} else {
  check('主页面在（跳过页面侧断言）', false, 'deepseek 页面没开');
}

page.close();
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
