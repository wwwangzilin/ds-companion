/* 一次性补丁：给 personas.rs 里那 5 处 Persona 字面量补上新加的 address 字段。
 *
 * 【为什么用脚本而不是手改】行号是编译器报的（E0063），机械补进最不容易出错；
 * 而且它是**可重跑**的（已经补过的行会被断言拦住，不会补第二遍）。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src-tauri/src/personas.rs';
const targets = [368, 409, 549, 714, 808]; // 1-based，来自 cargo 的 E0063 报告
const lines = readFileSync(path, 'utf8').split('\n');
let done = 0;
for (const n of [...targets].sort((a, b) => b - a)) {
  const i = n - 1;
  const line = lines[i];
  if (!line.includes('Persona {')) {
    throw new Error(`第 ${n} 行不是 Persona 字面量：${line}`);
  }
  if (lines[i + 1] && lines[i + 1].includes('address:')) continue; // 补过了
  const indent = (line.match(/^\s*/) || [''])[0] + '    ';
  lines.splice(i + 1, 0, `${indent}address: String::new(),`);
  done++;
}
writeFileSync(path, lines.join('\n'));
console.log(`补了 ${done} 处`);
