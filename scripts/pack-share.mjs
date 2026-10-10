import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'docs/share');
const output = path.join(root, 'exports/zaowu-studio-share.html');
const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
let html = await readFile(path.join(source, 'index.html'), 'utf8');
const references = [...new Set([...html.matchAll(/\bsrc="(assets\/[^"?#]+)"/g)].map(match => match[1]))];
for (const reference of references) {
  const file = path.resolve(source, reference);
  const mime = mimeTypes[path.extname(file).toLowerCase()];
  if (!file.startsWith(path.join(source, 'assets') + path.sep) || !mime) throw new Error(`Unsupported image: ${reference}`);
  const data = await readFile(file);
  html = html.replaceAll(`src="${reference}"`, `src="data:${mime};base64,${data.toString('base64')}"`);
}
if (/\bsrc="(?!data:)/.test(html) || /@import\b|\burl\s*\(/i.test(html)) throw new Error('The share page must not rely on external resources.');
if (Buffer.byteLength(html, 'utf8') >= 10 * 1024 * 1024) throw new Error('Community HTML must be smaller than 10 MiB.');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, html, 'utf8');
console.log(`Embedded ${references.length} images; ${Buffer.byteLength(html, 'utf8')} bytes → ${output}`);
