import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from './project-store.mjs';

const output = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-output', 'generation-overrides');
const previousOverrides = { '/Body': { visible: false, color: '#ff0000', position: [10, 0, 0] } };

async function fixture() {
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, 'project-'));
  const store = new ProjectStore({ root });
  await store.init();
  const initial = (await store.list())[0];
  const previous = await store.setOverrides(initial.id, { partId: '/Body', patch: previousOverrides['/Body'] });
  const paths = await store.contextPaths(initial.id);
  const originalSource = await readFile(paths.modelPath, 'utf8');
  await writeFile(paths.modelPath, `${originalSource}\n// New subject with the same /Body name\n`);
  return { store, previous, root, paths, originalSource };
}

test('generation preview ignores old same-name overrides; only valid promotion commits the reset', async () => {
  const { store, previous, paths } = await fixture();
  const pending = await store.snapshot(previous.id, { label: 'Generate', resetOverrides: true });
  assert.deepEqual(pending.overrides, {}, 'Preview must not hide/recolor the new /Body with old model overrides');
  let stored = JSON.parse(await readFile(path.join(paths.projectDir, 'project.json'), 'utf8'));
  assert.deepEqual(stored.overrides, previousOverrides, 'Committed project properties remain intact until validation');
  assert.deepEqual(stored.versions.find(item => item.id === previous.headId).overrides, previousOverrides);
  const validated = await store.validate(previous.id, pending.pendingRevisionId, { valid: true });
  assert.deepEqual(validated.overrides, {});
  stored = JSON.parse(await readFile(path.join(paths.projectDir, 'project.json'), 'utf8'));
  assert.deepEqual(stored.overrides, {});
  const metadata = JSON.parse(await readFile(path.join(paths.projectDir, 'versions', validated.headId, 'metadata.json'), 'utf8'));
  assert.deepEqual(metadata.overrides, {});
  assert.deepEqual((await store.restore(previous.id, previous.headId)).overrides, previousOverrides);
  assert.deepEqual((await store.restore(previous.id, validated.headId)).overrides, {}, 'Restoring the generated version must not reintroduce overrides');
});

test('failed generation validation restores the previous source and every old property override', async () => {
  const { store, previous, paths, originalSource } = await fixture();
  const pending = await store.snapshot(previous.id, { resetOverrides: true });
  const rejected = await store.validate(previous.id, pending.pendingRevisionId, { valid: false, error: 'Bad model' });
  assert.equal(rejected.headId, previous.headId);
  assert.deepEqual(rejected.overrides, previousOverrides);
  assert.equal(await readFile(paths.modelPath, 'utf8'), originalSource);
});

test('chat snapshots preserve overrides in preview and after successful validation', async () => {
  const { store, previous } = await fixture();
  const pending = await store.snapshot(previous.id, { label: 'Local chat edit' });
  assert.deepEqual(pending.overrides, previousOverrides);
  assert.deepEqual((await store.validate(previous.id, pending.pendingRevisionId, { valid: true })).overrides, previousOverrides);
});

test('stale generated revision cannot clear overrides of a newer pending edit, including after restart', async () => {
  const { store, previous, root, paths } = await fixture();
  const generated = await store.snapshot(previous.id, { resetOverrides: true });
  await writeFile(paths.modelPath, 'export function createModel() { /* newer edit */ }');
  const newer = await store.snapshot(previous.id, { label: 'Newer edit' });
  const reopened = new ProjectStore({ root });
  const stale = await reopened.validate(previous.id, generated.pendingRevisionId, { valid: true });
  assert.equal(stale.pendingRevisionId, newer.pendingRevisionId);
  assert.deepEqual(stale.overrides, previousOverrides);
  assert.deepEqual((await reopened.validate(previous.id, newer.pendingRevisionId, { valid: true })).overrides, previousOverrides);
});
