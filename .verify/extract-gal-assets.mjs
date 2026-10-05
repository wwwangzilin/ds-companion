// 只读提取 gal-view 默认预设里内嵌的素材，落盘到 .verify/gal-assets/ 供人工查看。
// 注意：这些美术素材来自第三方仓库（Ayase34/gal-view，代码 MIT，美术授权未写明），
// 只作本机参考预览，绝不进 ds-companion 仓库。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'gal-assets');
mkdirSync(out, { recursive: true });

const scenePath = join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'gal-view', 'gal-scene.json');
const scene = JSON.parse(readFileSync(scenePath, 'utf8'));

let n = 0;
for (const [id, a] of Object.entries(scene.assets ?? {})) {
  const dataUrl = a?.dataUrl ?? '';
  const comma = dataUrl.indexOf(',');
  if (comma < 0) { console.log('skip (no dataUrl):', id); continue; }
  const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  const name = String(a.name || id).replace(/[\\/:*?"<>|]/g, '_');
  writeFileSync(join(out, name), buf);
  console.log(`${name}  ${buf.length} bytes  ${a.width ?? '?'}x${a.height ?? '?'}  mime=${a.mime}`);
  n += 1;
}
console.log(`\nwrote ${n} file(s) to ${out}`);
console.log('elements referencing assets:');
for (const el of scene.elements ?? []) {
  if (el.image) console.log(`  ${el.id} (${el.type}) x=${el.x} y=${el.y} w=${el.w} h=${el.h} z=${el.z} → ${el.image}`);
}
