import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from './project-store.mjs';
import { snapshotPreviewManifests } from './snapshot-preview-manifests.mjs';

const output = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-output', 'revision-previews');

async function fixture() {
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(path.join(output, 'case-'));
  const root = path.join(directory, 'projects');
  const store = new ProjectStore({ root });
  await store.init();
  const original = (await store.list())[0];
  const changed = await store.setOverrides(original.id, { partId: '/Body', patch: { color: '#ff0000', visible: false } });
  const paths = await store.contextPaths(original.id);
  return { directory, root, store, original, changed, paths };
}

test('history reads its own overrides without changing a running task or pending model', async () => {
  const { store, original, changed, paths } = await fixture();
  await writeFile(paths.modelPath, 'export function createModel() { /* unsaved agent work */ }');
  const pending = await store.snapshot(original.id, { label: 'New model', resetOverrides: true });
  await store.updateTask(original.id, { id: 'active-task', status: 'running', prompt: 'Keep working' });
  const before = await readFile(path.join(paths.projectDir, 'project.json'));
  const sourceBefore = await readFile(paths.modelPath);
  const initialRevision = await store.getRevision(original.id, original.headId);
  const changedRevision = await store.getRevision(original.id, changed.headId);
  const pendingRevision = await store.getRevision(original.id, pending.pendingRevisionId);
  assert.deepEqual(initialRevision.overrides, {});
  assert.deepEqual(changedRevision.overrides, { '/Body': { color: '#ff0000', visible: false } });
  assert.equal(pendingRevision.status, 'pending');
  assert.deepEqual(pendingRevision.overrides, {});
  assert.deepEqual(Object.keys(changedRevision).sort(), ['createdAt', 'id', 'label', 'overrides', 'status']);
  changedRevision.overrides['/Body'].visible = true;
  assert.equal((await store.getRevision(original.id, changed.headId)).overrides['/Body'].visible, false);
  assert.deepEqual(await readFile(path.join(paths.projectDir, 'project.json')), before);
  assert.deepEqual(await readFile(paths.modelPath), sourceBefore);
});

test('revision lookup checks project ownership and rejects traversal identifiers', async () => {
  const { store, original } = await fixture();
  const other = await store.create({ name: 'Other project' });
  await assert.rejects(store.getRevision(other.id, original.headId), error => error.statusCode === 404);
  await assert.rejects(store.getRevision(original.id, 'missing'), error => error.statusCode === 404);
  await assert.rejects(store.getRevision('../airliner', original.headId), error => error.statusCode === 400);
  await assert.rejects(store.getRevision(original.id, '../project.json'), error => error.statusCode === 400);
});

test('compatibility manifests contain only valid snapshot overrides and never write project storage', async () => {
  const { directory, root, store, original, changed, paths } = await fixture();
  const pending = await store.snapshot(original.id, { label: 'Unvalidated' });
  const outputRoot = path.join(directory, 'manifests');
  const before = await readFile(path.join(paths.projectDir, 'project.json'));
  const sourceBefore = await readFile(paths.modelPath);
  const first = await snapshotPreviewManifests({ projectsRoot: root, outputRoot });
  assert.deepEqual(first, { written: 2, unchanged: 0, projects: 1 });
  const manifestPath = path.join(outputRoot, original.id, `${changed.headId}.json`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(manifest, { id: changed.headId, overrides: { '/Body': { color: '#ff0000', visible: false } } });
  assert.ok(!(await readdir(path.dirname(manifestPath))).includes(`${pending.pendingRevisionId}.json`));
  const mtime = (await stat(manifestPath)).mtimeMs;
  assert.deepEqual(await snapshotPreviewManifests({ projectsRoot: root, outputRoot }), { written: 0, unchanged: 2, projects: 1 });
  assert.equal((await stat(manifestPath)).mtimeMs, mtime);
  assert.deepEqual(await readFile(path.join(paths.projectDir, 'project.json')), before);
  assert.deepEqual(await readFile(paths.modelPath), sourceBefore);
  await assert.rejects(snapshotPreviewManifests({ projectsRoot: root, outputRoot: path.join(root, 'manifest') }), /outside/);
});
