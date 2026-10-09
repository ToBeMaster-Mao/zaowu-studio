import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePublicFile, tokenMatches, MutationGate } from './server-security.mjs';
import { ProjectStore } from './project-store.mjs';

async function fixture() {
  const output = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-output', 'server-security');
  await mkdir(output, { recursive: true });
  return mkdtemp(path.join(output, 'case-'));
}

test('public files stay within their own allowed directory, including encoded Windows traversal', async () => {
  const base = await fixture();
  for (const directory of ['studio-web', 'studio-viewer', 'node_modules/three', '.studio']) await mkdir(path.join(base, directory), { recursive: true });
  await writeFile(path.join(base, 'studio-web', 'app.js'), 'public app');
  await writeFile(path.join(base, '.studio', 'private.json'), 'PRIVATE');
  assert.equal(await resolvePublicFile(base, '/studio-web/app.js'), path.join(base, 'studio-web', 'app.js'));
  for (const requestPath of [
    '/studio-web/../.studio/private.json',
    '/studio-web/%5c..%5c.studio%5cprivate.json',
    '/studio-web/..%2f.studio%2fprivate.json',
    '/studio-web/app.js:secret',
    '/.studio/private.json',
  ]) await assert.rejects(resolvePublicFile(base, decodeURIComponent(requestPath)), error => error.status === 403);
  await symlink(path.join(base, '.studio'), path.join(base, 'studio-web', 'linked-private'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolvePublicFile(base, '/studio-web/linked-private/private.json'), error => error.status === 403);
});

test('token comparison rejects malformed Unicode without throwing or accepting a partial token', () => {
  const token = 'a'.repeat(64);
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches('a'.repeat(63), token), false);
  assert.equal(tokenMatches('é'.repeat(64), token), false);
  assert.equal(tokenMatches(undefined, token), false);
  assert.equal(tokenMatches(['a'], token), false);
});

test('mutation ownership spans async I/O and is released after failures', async () => {
  const gate = new MutationGate();
  let finish;
  const first = gate.run(() => new Promise(resolve => { finish = resolve; }));
  assert.equal(gate.busy, true);
  await assert.rejects(gate.run(() => 'overlapping edit'), error => error.status === 409);
  finish('saved');
  assert.equal(await first, 'saved');
  assert.equal(gate.busy, false);
  await assert.rejects(gate.run(() => { throw new Error('disk full'); }), /disk full/);
  assert.equal(gate.busy, false);
  assert.equal(await gate.run(() => 'next edit'), 'next edit');
});

test('fresh installs always begin empty even when sample source and image paths are configured', async () => {
  const base = await fixture();
  const source = path.join(base, 'sample.js'), image = path.join(base, 'personal.png');
  await writeFile(source, 'export function createAirliner() { throw new Error("sample must not load"); }');
  await writeFile(image, 'private image');
  const store = new ProjectStore({ root: path.join(base, 'projects'), sampleSourcePath: source, sampleImagePath: image });
  const projects = await store.list();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, '我的第一个模型');
  assert.equal(projects[0].references.length, 0);
  assert.equal(projects[0].messages.length, 0);
  assert.equal(projects[0].threadId, null);
  assert.match((await store.readRevisionSource(projects[0].id)).toString(), /new THREE.Group/);
  assert.doesNotMatch((await store.readRevisionSource(projects[0].id)).toString(), /createAirliner/);
});

test('exports and generated work files reject symlinked directories outside project storage', async () => {
  const base = await fixture();
  const store = new ProjectStore({ root: path.join(base, 'projects') });
  const project = (await store.list())[0];
  const paths = await store.contextPaths(project.id);
  const outside = path.join(base, 'outside');
  await mkdir(outside);
  const fakeGlb = Buffer.alloc(20);
  fakeGlb.write('glTF'); fakeGlb.writeUInt32LE(2, 4); fakeGlb.writeUInt32LE(20, 8);
  const saved = await store.writeExport(project.id, fakeGlb);
  assert.deepEqual(await store.readExport(project.id, saved.file), fakeGlb);
  await assert.rejects(store.readExport(project.id, '../private.glb'), error => error.statusCode === 400);
  const another = await store.create({ name: 'Linked exports' });
  const anotherPaths = await store.contextPaths(another.id);
  await symlink(outside, path.join(anotherPaths.projectDir, 'exports'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(outside, saved.file), 'PRIVATE');
  await assert.rejects(store.readExport(another.id, saved.file), error => error.statusCode === 403);
  await assert.rejects(store.writeExport(another.id, fakeGlb), error => error.statusCode === 403);
  await symlink(outside, path.join(paths.workDir, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.workPath(project.id, '.agents', 'skills', 'model-studio'), error => error.statusCode === 403);
  assert.equal(await readFile(path.join(outside, saved.file), 'utf8'), 'PRIVATE');
});

test('metadata and reference edits are rejected while a saved task is stopping or validating', async () => {
  const store = new ProjectStore({ root: path.join(await fixture(), 'projects') });
  const project = (await store.list())[0];
  for (const status of ['starting', 'running', 'stopping', 'validating']) {
    await store.updateTask(project.id, { id: 'current-task', status });
    await assert.rejects(store.rename(project.id, 'unexpected'), error => error.statusCode === 409);
    await assert.rejects(store.removeReference(project.id, 'any-reference'), error => error.statusCode === 409);
    await assert.rejects(store.setOverrides(project.id, { partId: 'part', patch: { visible: false } }), error => error.statusCode === 409);
  }
});
