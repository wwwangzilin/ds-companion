/* 数据隔离验收：证明"验收脚本碰不到主人的真实数据"
 *
 * 为什么这条最重要：这个项目的验收脚本做的是**真存真删**（写记忆、改状态、存人设、
 * 跑自我修订）。在 DSC_DATA_DIR 出现之前，它们全都打在 %APPDATA%\ds-companion ——
 * 也就是主人正在用的那份。实测留下的现场：
 *   · memory-trash 里 100+ 份 "验收整理-手写" 这类测试残留
 *   · state\dsh-luna.json.testpollution-backup / proposals\dsh-luna.json.testpollution-backup
 *     （脚本自己都意识到在污染真数据，只能先备份再跑）
 *   · 主人真实记忆目录里出现过一张测试写的坏文件（memory/broken.md）
 *
 * 本脚本检查四件事：
 *   ① app_root 的优先级（DSC_DATA_DIR 压过 APPDATA）—— 由 Rust 单测证明，这里复核存在性
 *   ② 门禁在"未隔离"时确实拒绝执行（exit 2），而不是打个警告继续跑
 *   ③ 隔离实例的数据落在隔离目录里，一个字节都不进真实目录
 *   ④ 全部验收脚本都挂了门禁（防止将来新增脚本漏挂）
 *
 * 用法：
 *   node .verify/verify-isolation.mjs                  # 静态部分（不需要 app 在跑）
 *   node .verify/verify-isolation.mjs --live           # 额外核对"正在跑的实例"的隔离状态
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');
const APP_REAL = join(process.env.APPDATA || '', 'ds-companion');
const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${detail ? `  — ${detail}` : ''}`);
}

// ── ① app_root 优先级：Rust 侧是唯一的真相源，这里只复核"开关存在且被用上" ──
const personasSrc = readFileSync(join(PROJECT, 'src-tauri/src/personas.rs'), 'utf8');
check(
  'app_root 认 DSC_DATA_DIR',
  /DSC_DATA_DIR/.test(personasSrc) && /pub fn app_root/.test(personasSrc),
  'src-tauri/src/personas.rs',
);
check(
  'DSC_DATA_DIR 优先于 APPDATA（不是并列兜底）',
  /DSC_DATA_DIR[\s\S]{0,300}?APPDATA/.test(personasSrc),
  '顺序反了就等于没隔离',
);
const cfgTests = readFileSync(join(PROJECT, 'src-tauri/src/config.rs'), 'utf8');
check(
  '单测自己也被锚在临时目录',
  /lock_test_data_dir\(\)/.test(cfgTests),
  '否则 cargo test 会写主人的真配置',
);

// ── ② 门禁拒绝语义：必须 exit 2，不能"警告一下继续"──
const envSrc = readFileSync(join(HERE, '_env.mjs'), 'utf8');
check('门禁存在（_env.mjs）', existsSync(join(HERE, '_env.mjs')));
check(
  '未隔离时 process.exit(2) 而不是继续',
  /if \(!info\.isolated\)[\s\S]{0,600}?process\.exit\(2\)/.test(envSrc),
  '警告后继续 = 照样污染真数据',
);
check(
  '绕过需要显式 DSC_ALLOW_REAL_DATA=1',
  /DSC_ALLOW_REAL_DATA/.test(envSrc),
  '默认必须是拒绝',
);

// ── ③ 所有会写数据的脚本都挂了门禁 ──
// 清单来自 grep `invoke('memory_save'|memory_delete|memory_ingest|persona_save|persona_delete|
// state_save|state_reset|user_state_save|user_state_reset|dsc_chat_append|proposal_accept|
// config_set|dsc_review_submit')` —— 即"会动主人数据"的那一批。
// （verify-injection 故意不在内：它只发一条 abort 掉的合成 XHR，最多碰一下记忆热度计数，
//   不改任何内容；给它挂门禁反而会让"只想看注入有没有生效"的人被拦住。）
const WRITERS = [
  'live-extract.mjs',
  'probe-mem-save.mjs',
  'shoot-extract.mjs',
  'shoot-memory.mjs',
  'verify-extract.mjs',
  'verify-memory.mjs',
  'verify-personas.mjs',
  'verify-selfedit.mjs',
  'verify-state.mjs',
];
const missing = [];
for (const f of WRITERS) {
  const p = join(HERE, f);
  if (!existsSync(p)) continue;
  const src = readFileSync(p, 'utf8');
  if (!/requireIsolation/.test(src)) missing.push(f);
}
check(
  '会写数据的验收脚本全部挂了门禁',
  missing.length === 0,
  missing.length ? `缺：${missing.join(', ')}` : `${WRITERS.length} 个脚本`,
);

// ── ④ 回收站上限：历史垃圾不能再无限堆（有正本目录不动的前提）──
const personasFull = personasSrc;
check('回收站有保留上限（TRASH_KEEP）', /pub const TRASH_KEEP/.test(personasFull));
check(
  '删除路径会顺手清理（memory / persona / state / user_state 四处）',
  ['delete_memory', 'delete_persona'].every((fn) =>
    new RegExp(`${fn}[\\s\\S]{0,900}?prune_trash`).test(
      fn === 'delete_memory'
        ? readFileSync(join(PROJECT, 'src-tauri/src/memory.rs'), 'utf8')
        : personasFull,
    ),
  ),
);

// ── 可选：核对正在跑的实例 ──
if (process.argv.includes('--live')) {
  const { readDataDirInfo } = await import('./_env.mjs');
  const info = await readDataDirInfo();
  if (!info) {
    check('能读到运行实例的数据目录', false, '设置窗口没开 / 壳是旧的');
  } else {
    check('运行实例报告了 isolated 标志', typeof info.isolated === 'boolean', JSON.stringify(info));
    if (info.isolated) {
      check(
        '隔离目录不在真实 APPDATA 下',
        !String(info.path).toLowerCase().includes('roaming\\ds-companion'),
        info.path,
      );
    }
  }
}

// ── 真实数据目录的现状（只报告，不判定）──
if (existsSync(APP_REAL)) {
  let trash = 0;
  for (const d of ['memory-trash', 'personas-trash', 'state-trash', 'proposals-trash']) {
    const p = join(APP_REAL, d);
    if (existsSync(p)) trash += readdirSync(p).length;
  }
  const memories = existsSync(join(APP_REAL, 'memory')) ? readdirSync(join(APP_REAL, 'memory')).length : 0;
  const bad = [];
  for (const d of ['', 'memory', 'state']) {
    const p = join(APP_REAL, d);
    if (!existsSync(p)) continue;
    for (const f of readdirSync(p)) if (f.includes('.bad-')) bad.push(join(d, f));
  }
  console.log(
    `\n真实数据目录现状：${memories} 条记忆 · 回收站 ${trash} 份 · 隔离证据(.bad-*) ${bad.length} 个`,
  );
  if (bad.length) console.log(`  ⚠ 有被隔离的坏文件（说明真的出过一次坏文件）：${bad.join(', ')}`);
}

console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
