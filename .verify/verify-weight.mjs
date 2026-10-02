/* 记忆权重衰减验收：老记忆该降权、pinned 不许降、**但一条都不许消失**
 *
 * 【为什么这一组必须有】"衰减"这个词天然带着风险：写歪一点点就变成"旧记忆被静默淘汰"，
 * 而那正是这个项目在记忆上从第一天起就拒绝的事（只增不删）。所以脚本不只验"顺序变了"，
 * 还要验"衰减过的记忆**仍然在列表里**、仍然拿得到、权重也没掉到 0"。
 *
 * 【数字怎么验】脚本用**同一套公式**在 JS 里复算一遍，和 Rust 返回的权重比 —— 这样
 * "前端看到的权重"和"注入排序用的权重"就不可能悄悄变成两套。
 *
 * 前置：壳以隔离数据 + CDP 启动（.\verify-run.ps1 -Keep），设置窗口开着
 *   node .verify\probe-open-settings.mjs
 *   node .verify\verify-weight.mjs
 *
 * 用法：node .verify\verify-weight.mjs [port]
 */

import { requireIsolation } from './_env.mjs';

const PORT = Number(process.argv[2] || process.env.DSC_CDP_PORT || 9222);
const CDP = `http://127.0.0.1:${PORT}`;
const DAY = 86_400_000;

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

const list = await (await fetch(`${CDP}/json/list`)).json();
const t = list.find((x) => x.url && x.url.includes('settings.html'));
if (!t) {
  console.error('设置窗口没开 —— 先跑 .verify\\probe-open-settings.mjs');
  process.exit(1);
}
const st = new Page(t.webSocketDebuggerUrl);
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

/** 与 Rust `memory::weight_of` 同一套公式（改了那边必须同步改这里） */
const MIN_WEIGHT = 0.35;
const HALF_LIFE_DAYS = 30;
function weightOf(m, now) {
  const base = Math.min(5, Math.max(1, m.importance || 3));
  const last = Math.max(m.createdAt || 0, m.lastAccessedAt || 0);
  const idleDays = now > last ? (now - last) / DAY : 0;
  const fresh = m.pinned ? 1 : Math.pow(0.5, idleDays / HALF_LIFE_DAYS);
  const hits = Math.min(m.accessCount || 0, 10) * 0.08;
  return Math.max((base + hits) * fresh, MIN_WEIGHT);
}

const P = 'dsc-verify-weight-';
const mk = async (id, importance, ageDays, pinned) =>
  await call('memory_save', {
    item: {
      id: P + id,
      characterId: '',
      name: '权重验收 ' + id,
      content: '这条是验收造的：' + id,
      keys: ['验权重'],
      importance,
      pinned: !!pinned,
      source: 'manual',
      sourceRef: '',
      createdAt: Date.now() - Math.round(ageDays * DAY),
      lastAccessedAt: 0,
      accessCount: 0,
    },
  });

try {
  await mk('new-high', 5, 0, false);
  await mk('old-high', 5, 400, false);
  await mk('new-low', 1, 0, false);
  await mk('pinned-old', 3, 400, true);

  const all = await call('memory_list');
  const mine = all.filter((m) => String(m.id).startsWith(P));
  check('四条验收记忆都建出来了', mine.length === 4, mine.map((m) => m.id).join(','));

  // ── ① 每条都带权重，且与公式一致 ──────────────────────────────────
  const now = Date.now();
  const by = (suffix) => mine.find((m) => m.id === P + suffix);
  check('列表里带 weight 字段', mine.every((m) => typeof m.weight === 'number'), JSON.stringify(mine.map((m) => m.weight)));
  let worst = 0;
  for (const m of mine) {
    worst = Math.max(worst, Math.abs(m.weight - weightOf(m, now)));
  }
  check('权重与公开公式一致（前端看到的 = 注入用的）', worst < 0.02, `最大偏差 ${worst.toFixed(4)}`);

  // ── ② 衰减真的发生：同分的新 > 老 ────────────────────────────────
  check(
    '同样 5 分，新的比 400 天前的重',
    by('new-high').weight > by('old-high').weight + 1,
    `${by('new-high').weight} vs ${by('old-high').weight}`,
  );
  check('400 天前的高分只剩个零头', by('old-high').weight < 1, String(by('old-high').weight));

  // ── ③ 但**绝不清零**：老记忆还在、权重还有下限 ───────────────────
  check('老记忆仍然在列表里（只降权，不删除）', !!by('old-high') && !!by('pinned-old'));
  check('老记忆的权重不低于下限', by('old-high').weight >= MIN_WEIGHT, String(by('old-high').weight));
  check('老记忆的权重不是 0', by('old-high').weight > 0);

  // ── ④ pinned 不衰减 ─────────────────────────────────────────────
  check('pinned 的老记忆拿满分（3 分不打折）', Math.abs(by('pinned-old').weight - 3) < 0.001, String(by('pinned-old').weight));
  check(
    '所以 pinned 的老记忆排在没钉的老记忆前面',
    by('pinned-old').weight > by('old-high').weight,
    `${by('pinned-old').weight} vs ${by('old-high').weight}`,
  );

  // ── ⑤ 5 分的老记忆仍然压得住 1 分的新记忆吗？── 不，这次是要它压不住 ──
  // 这条是**有意**的语义：衰减到一定程度，琐碎的新事会盖过陈年旧事（这正是"权重衰减"的意义）。
  check(
    '衰减够了之后，新的低分记忆会超过 400 天前的高分记忆',
    by('new-low').weight > by('old-high').weight,
    `${by('new-low').weight} vs ${by('old-high').weight}`,
  );

  // ── ⑥ 整个列表按权重降序（顺序就是注入顺序）──────────────────────
  let ordered = true;
  for (let i = 1; i < all.length; i++) {
    if (all[i].weight > all[i - 1].weight + 1e-6) {
      ordered = false;
      break;
    }
  }
  check('memory_list 整体按权重降序（= 注入顺序）', ordered, all.slice(0, 4).map((m) => `${m.id}:${m.weight.toFixed(2)}`).join(' '));

  // ── ⑦ 新记忆默认排在很前面（刚写的东西立刻能用上）────────────────
  const rankNewHigh = all.findIndex((m) => m.id === P + 'new-high');
  check('刚写的 5 分记忆排在很前面（前 3）', rankNewHigh >= 0 && rankNewHigh < 3, `rank=${rankNewHigh}`);
} finally {
  // 收尾：把这四条验收记忆删掉（隔离实例也要干净，免得影响别的脚本的计数）
  try {
    const all = await call('memory_list');
    for (const m of all.filter((x) => String(x.id).startsWith(P))) {
      try {
        await call('memory_delete', { id: m.id });
      } catch {}
    }
  } catch {}
  try {
    st.close();
  } catch {}
}

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
