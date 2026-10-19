import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectStore } from './project-store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zaowu-atomic-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('zaowu-atomic-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = await new ProjectStore({ root }).init();
  const file = path.join(root, 'first-project', 'project.json');
  return { store, file, directory: path.dirname(file) };
}

test('Windows transient replacement conflicts retry without losing a project update', { skip: process.platform !== 'win32' }, async t => {
  const { store, file, directory } = await fixture(t);
  const rename = fs.rename;
  let attempts = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === file && ++attempts <= 2) throw Object.assign(new Error('temporary read lock'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
    return rename(from, to);
  });
  const project = await store.rename('first-project', '保存成功');
  assert.equal(attempts, 3);
  assert.equal(project.name, '保存成功');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).name, '保存成功');
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), []);
});

test('Windows persistent replacement errors retain old data and remove temporary files', { skip: process.platform !== 'win32' }, async t => {
  const { store, file, directory } = await fixture(t);
  const original = await fs.readFile(file, 'utf8'), rename = fs.rename;
  let attempts = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === file) { attempts++; throw Object.assign(new Error('persistent lock'), { code: 'EACCES' }); }
    return rename(from, to);
  });
  await assert.rejects(store.rename('first-project', '不能覆盖'), { code: 'EACCES' });
  assert.equal(attempts, 6);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), []);
});

test('unrelated replacement failures fail immediately and leave the previous project readable', async t => {
  const { store, file, directory } = await fixture(t);
  const original = await fs.readFile(file, 'utf8'), rename = fs.rename;
  let attempts = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === file) { attempts++; throw Object.assign(new Error('storage unavailable'), { code: 'ENOSPC' }); }
    return rename(from, to);
  });
  await assert.rejects(store.rename('first-project', '不能保存'), { code: 'ENOSPC' });
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), []);
});
