/* 一次性：把回收站里堆下的历史垃圾搬到外部归档目录（不删，随时能捞回来）
 *
 * 背景：memory-trash 里堆了 100+ 份、personas-trash 26 份，全是"每次删各留一份"
 * 加上验收脚本反复建/删攒出来的。新的上限（TRASH_KEEP=50）只在"又删了一个东西"
 * 时才生效，所以历史垃圾不会自己消失 —— 而堆积本身有代价：设置界面/备份工具都要扫它。
 *
 * 用法：node .verify/fix-trash-once.mjs [--apply]
 *   （不带 --apply 只报告，不动任何文件）
 */
import { readdirSync, statSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const appRoot = join(process.env.APPDATA || '', 'ds-companion');
const archive = join(process.env.USERPROFILE || '', '.ds-companion-trash-archive');
const DIRS = ['memory-trash', 'personas-trash', 'state-trash', 'proposals-trash'];

let total = 0;
for (const name of DIRS) {
  const dir = join(appRoot, name);
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).map((f) => {
    const st = statSync(join(dir, f));
    return { f, mtime: st.mtimeMs, size: st.size };
  });
  total += files.length;
  console.log(`${name.padEnd(18)} ${String(files.length).padStart(4)} 份`);
  if (!APPLY || files.length === 0) continue;
  const dest = join(archive, name);
  mkdirSync(dest, { recursive: true });
  let moved = 0;
  for (const { f } of files) {
    try {
      renameSync(join(dir, f), join(dest, f));
      moved++;
    } catch (e) {
      console.log(`  移动失败 ${f}: ${e.message}`);
    }
  }
  console.log(`  → 已搬到 ${dest}（${moved} 份）`);
}

console.log(`\n合计 ${total} 份`);
if (!APPLY) {
  console.log('这是预览。要真的搬走：node .verify/fix-trash-once.mjs --apply');
} else {
  console.log(`归档目录：${archive}\n（没有删除任何文件，回收站现在是空的；外部归档可以随时翻回去）`);
}
