// 批量精确替换：按一份 JSON 清单改源码，每一处都必须**恰好命中一次**。
//
// 【为什么要它】同样的改动分散在几个文件、十来个位置时，一个个来回改既慢又容易漏；
// 而用 `sed`/正则批量替换太危险（可能命中注释、字符串、或者别处的相似代码）。
// 这里只做「字面量精确替换」，并且：
//   · 某处命中 0 次 → 报错退出（说明上游代码变了，不能装作改过）
//   · 某处命中 >1 次 → 报错退出（说明这串不够独特，替换会误伤）
// 改完打印每处的文件与行号，方便对着 `git diff` 复核。
//
// 用法：node apply-edits.mjs edits.json
// edits.json 形如：[{"file":"src/foo.rs","old":"...","new":"..."}, ...]

import { readFileSync, writeFileSync } from 'node:fs';

const [, , listPath] = process.argv;
if (!listPath) {
  console.error('用法：node apply-edits.mjs edits.json');
  process.exit(2);
}

const edits = JSON.parse(readFileSync(listPath, 'utf8'));
let ok = 0;

for (const [i, e] of edits.entries()) {
  const label = `#${i + 1} ${e.file}`;
  let text;
  try {
    text = readFileSync(e.file, 'utf8');
  } catch (err) {
    console.error(`✗ ${label}: 读不到文件（${err.message}）`);
    process.exit(1);
  }

  // 计数：用 split 的段数判断出现次数（比正则安全，不用转义）
  const parts = text.split(e.old);
  const hits = parts.length - 1;
  if (hits === 0) {
    console.error(`✗ ${label}: 找不到目标片段（上游代码变了？）`);
    console.error(`   片段开头：${JSON.stringify(e.old.slice(0, 80))}`);
    process.exit(1);
  }
  if (hits > 1) {
    console.error(`✗ ${label}: 命中 ${hits} 次 —— 这串不够独特，替换会误伤`);
    console.error(`   片段开头：${JSON.stringify(e.old.slice(0, 80))}`);
    process.exit(1);
  }

  const at = parts[0].split('\n').length;
  writeFileSync(e.file, parts.join(e.new), 'utf8');
  const grew = e.new.split('\n').length - e.old.split('\n').length;
  console.log(`✓ ${label}:${at}  ${grew >= 0 ? '+' : ''}${grew} 行`);
  ok++;
}

console.log(`\n全部命中：${ok}/${edits.length} 处`);
