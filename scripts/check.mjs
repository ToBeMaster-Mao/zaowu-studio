import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root, sourceFiles } from './source-files.mjs';

const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
for (const key of ['name', 'version']) {
  if (manifest[key] !== lock[key] || manifest[key] !== lock.packages[''][key]) throw new Error(`package-lock.json ${key} is out of sync.`);
}
const files = await sourceFiles();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} JavaScript modules; package metadata is consistent.`);
