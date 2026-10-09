import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['node_modules', '.git', '.studio', 'test-output', 'revision-previews', '.validation-deps', 'public-downloads']);

export async function sourceFiles(directory = root) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await sourceFiles(file));
    else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) results.push(file);
  }
  return results.sort();
}
