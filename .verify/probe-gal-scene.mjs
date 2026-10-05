// 只读探查 gal-view 的默认预设场景结构（不写任何东西）
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const p = join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'gal-view', 'gal-scene.json');
const raw = readFileSync(p, 'utf8');
console.log('bytes:', raw.length);
const j = JSON.parse(raw);
console.log('root type:', Array.isArray(j) ? 'array' : typeof j);
console.log('root keys:', Object.keys(j).join(', '));

const s = j.scene ?? j;
if (s && typeof s === 'object') {
  console.log('scene keys:', Object.keys(s).join(', '));
  for (const k of ['width', 'height', 'version', 'name']) {
    if (k in s) console.log(`  ${k} =`, JSON.stringify(s[k]).slice(0, 120));
  }
  const els = s.elements ?? s.items ?? s.nodes ?? [];
  console.log('elements:', Array.isArray(els) ? els.length : typeof els);
  if (Array.isArray(els)) {
    const tally = {};
    for (const e of els) {
      const key = `${e.type ?? e.kind ?? '?'}|img:${e.image ? 'yes' : 'no'}`;
      tally[key] = (tally[key] || 0) + 1;
    }
    console.log('types:', JSON.stringify(tally));
    for (const e of els.slice(0, 4)) {
      const c = { ...e };
      if (c.image && typeof c.image === 'string' && c.image.length > 40) c.image = `<${c.image.length} chars>`;
      console.log('  el:', JSON.stringify(c).slice(0, 420));
    }
  }
}

// 素材库：内嵌资源（base64 data URI / 字体等）
for (const key of ['assets', 'assetLibrary', 'images', 'fonts']) {
  const v = j[key] ?? s?.[key];
  if (!v) continue;
  if (Array.isArray(v)) {
    console.log(`${key}: array len=${v.length}`);
    for (const a of v.slice(0, 12)) {
      const meta = { id: a.id, name: a.name, kind: a.kind, mime: a.mime, fontFamily: a.fontFamily };
      const data = a.data ?? a.src ?? a.dataUrl ?? '';
      meta.bytes = typeof data === 'string' ? data.length : 0;
      meta.head = typeof data === 'string' ? data.slice(0, 40) : '';
      console.log('   ', JSON.stringify(meta).slice(0, 300));
    }
  } else if (typeof v === 'object') {
    const ks = Object.keys(v);
    console.log(`${key}: object keys=${ks.length} → ${ks.slice(0, 12).join(', ')}`);
    for (const k of ks.slice(0, 12)) {
      const a = v[k];
      if (!a || typeof a !== 'object') continue;
      const data = a.data ?? a.src ?? a.dataUrl ?? '';
      console.log('   ', JSON.stringify({ id: k, name: a.name, kind: a.kind, mime: a.mime, bytes: typeof data === 'string' ? data.length : 0, head: typeof data === 'string' ? data.slice(0, 40) : '' }).slice(0, 300));
    }
  }
}

// 兜底：全量扫任何看起来像 data URI 的长字符串
const hits = [];
const walk = (node, path) => {
  if (typeof node === 'string') {
    if (node.startsWith('data:') || node.length > 20000) hits.push([path, node.slice(0, 40), node.length]);
    return;
  }
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
  if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
};
walk(j, '$');
console.log('long/data-uri strings:', hits.length);
for (const h of hits.slice(0, 20)) console.log('  ', h[0], '|', h[1], '|', h[2]);
