import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareTaskRequest, buildTaskImageContext, buildAgentPrompt, completeTask, IMAGE_LIMITS } from './task-contract.mjs';
import { ProjectStore } from './project-store.mjs';

const references = Array.from({ length: 20 }, (_, index) => ({ id: `ref-${index}`, name: `image-${index}.png` }));
const project = { id: 'current-project', references };
const group = (id, referenceIds, label = '侧面与细节') => ({ id, label, referenceIds });
const screenshot = 'data:image/png;base64,aGVsbG8=';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=';

test('multiple image groups preserve group order and exact image indices while deduplicating CLI inputs', () => {
  const request = prepareTaskRequest(project, {
    prompt: '按这些侧面和细节完善杯子', referenceIds: ['ref-2', 'ref-0'], screenshotDataUrl: screenshot,
    imageGroups: [group('sides', ['ref-4', 'ref-2']), group('details', ['ref-3', 'ref-4'], '杯把细节')],
  });
  assert.deepEqual(request.referenceIds, ['ref-2', 'ref-0']);
  assert.deepEqual(request.allReferenceIds, ['ref-2', 'ref-0', 'ref-4', 'ref-3']);
  const paths = new Map(request.references.map(ref => [ref.id, `/project/references/${ref.id}.png`]));
  const context = buildTaskImageContext(request, paths, '/project/references/current-view.png');
  assert.deepEqual(context.images, ['/project/references/ref-2.png', '/project/references/ref-0.png', '/project/references/ref-4.png', '/project/references/ref-3.png', '/project/references/current-view.png']);
  assert.deepEqual(context.imageGroups[0].references.map(ref => ref.imageIndex), [3, 1]);
  assert.deepEqual(context.imageGroups[1].references.map(ref => ref.imageIndex), [4, 3]);
  for (const entry of context.imageGroups.flatMap(item => item.references)) assert.equal(context.images[entry.imageIndex - 1], entry.path);
  assert.equal(context.currentScreenshotImageIndex, 5);
  assert.equal(context.references.length, 4, 'The current model screenshot is separate from target references');
  assert.match(buildAgentPrompt(request), /imageGroups/);
  assert.deepEqual(completeTask({ imageGroups: request.imageGroups }, { status: 'completed' }, { changed: false, output: '' }).imageGroups, request.imageGroups);
});

test('empty chat text with attached groups has an explicit useful default, ordinary legacy chat stays unchanged', () => {
  const request = prepareTaskRequest(project, { prompt: '  ', referenceIds: [], imageGroups: [group('details', ['ref-1'])] });
  assert.equal(request.userPrompt, '');
  assert.equal(request.prompt, '请结合本次补充图片检查并完善当前模型。');
  assert.match(buildAgentPrompt(request), /用户要求：\n请结合本次补充图片检查并完善当前模型/);
  assert.throws(() => prepareTaskRequest(project, { prompt: '', referenceIds: ['ref-1'] }), /请输入/);
  const legacy = prepareTaskRequest({ references: references.slice(0, 8) }, { prompt: '回答问题' });
  assert.equal(legacy.prompt, '回答问题');
  assert.equal(legacy.references.length, 8);
  assert.deepEqual(legacy.imageGroups, []);
  assert.throws(() => prepareTaskRequest(project, { prompt: '回答问题' }), /16 张/, 'Legacy requests with larger libraries must fail rather than silently send or drop historical images');
});

test('ownership, malformed groups, duplicate group membership and named group limits are validated', () => {
  const input = imageGroups => ({ referenceIds: [], prompt: '修改', imageGroups });
  assert.throws(() => prepareTaskRequest(project, input([group('foreign', ['other-project-ref'])])), error => error.status === 409);
  assert.throws(() => prepareTaskRequest(project, input([group('same', ['ref-0', 'ref-0'])])), /同一图片组/);
  assert.throws(() => prepareTaskRequest(project, input([group('a', ['ref-0']), group('a', ['ref-1'])])), /标识/);
  assert.throws(() => prepareTaskRequest(project, input([group('../bad', ['ref-0'])])), /标识/);
  assert.throws(() => prepareTaskRequest(project, input([group('a', ['ref-0'], 'a'.repeat(61))])), /60/);
  assert.throws(() => prepareTaskRequest(project, input([group('a', [])])), /至少一张/);
  assert.throws(() => prepareTaskRequest(project, input([null])), /标识/);
  assert.throws(() => prepareTaskRequest(project, input('bad')), /8 组/);
  assert.throws(() => prepareTaskRequest(project, input(Array.from({ length: 9 }, (_, index) => group(`g-${index}`, ['ref-0'])))), /8 组/);
});

test('exactly sixteen unique user images plus one screenshot are retained, larger requests are rejected', () => {
  const request = prepareTaskRequest(project, {
    prompt: '修改', referenceIds: references.slice(0, 12).map(ref => ref.id), screenshotDataUrl: screenshot,
    imageGroups: [group('more', references.slice(12, 16).map(ref => ref.id))],
  });
  const paths = new Map(request.references.map(ref => [ref.id, `/project/${ref.id}.png`]));
  const context = buildTaskImageContext(request, paths, '/project/current.png');
  assert.equal(context.images.length, IMAGE_LIMITS.withScreenshot);
  assert.equal(context.currentScreenshotImageIndex, 17);
  assert.throws(() => prepareTaskRequest(project, { prompt: '修改', referenceIds: references.slice(0, 16).map(ref => ref.id), imageGroups: [group('extra', ['ref-16'])] }), /16 张/);
  assert.throws(() => buildTaskImageContext(request, new Map()), /尚未准备完成/);
});

async function fixture() {
  const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-output', 'image-groups');
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(path.join(directory, 'case-'));
  const store = new ProjectStore({ root });
  await store.init();
  const original = (await store.list())[0];
  const withImage = await store.addReference(original.id, { name: 'side.png', dataUrl: png });
  return { root, store, project: withImage, reference: withImage.references[0] };
}

test('conversation attachments retain trusted snapshots after library deletion and cannot escape project ownership', async () => {
  const { root, store, project: saved, reference } = await fixture();
  await store.appendMessage(saved.id, { id: 'message-one', role: 'user', text: '补充侧面', referenceIds: [], imageGroups: [group('sides', [reference.id])], attachments: [{ referenceId: reference.id, file: '../secret.png', name: 'untrusted name' }] });
  await store.removeReference(saved.id, reference.id);
  await assert.rejects(store.readReference(saved.id, reference.id), error => error.statusCode === 404);
  const reloaded = new ProjectStore({ root });
  const history = await reloaded.get(saved.id);
  assert.equal(history.references.length, 0);
  assert.equal(history.messages[0].attachments[0].name, 'side.png');
  assert.equal(history.messages[0].attachments[0].file, undefined, 'Private stored paths must not be returned in history');
  assert.equal(history.messages[0].attachments[0].url, `/artifacts/${saved.id}/messages/message-one/attachments/${reference.id}`);
  assert.deepEqual(history.messages[0].imageGroups, [group('sides', [reference.id])]);
  const image = await reloaded.readMessageAttachment(saved.id, 'message-one', reference.id);
  assert.equal(image.buffer.toString('base64'), png.split(',')[1]);
  const other = await reloaded.create({ name: 'Another project' });
  await assert.rejects(reloaded.readMessageAttachment(other.id, 'message-one', reference.id), error => error.statusCode === 404);
  await assert.rejects(reloaded.appendMessage(other.id, { role: 'user', text: 'bad', attachments: [{ referenceId: reference.id }] }), error => error.statusCode === 409);
  await assert.rejects(reloaded.readMessageAttachment(saved.id, '../message-one', reference.id), error => error.statusCode === 400);
});

test('project libraries accept more than eight images but reject the 129th without changing stored files', async () => {
  const { root, store, project: saved } = await fixture();
  for (let i = 1; i < 9; i++) await store.addReference(saved.id, { name: `${i}.png`, dataUrl: png });
  assert.equal((await store.get(saved.id)).references.length, 9);
  // Seed only the metadata to exercise the boundary without creating another 119 image files.
  const metadataPath = path.join(root, saved.id, 'project.json');
  const raw = JSON.parse(await readFile(metadataPath, 'utf8'));
  raw.references = Array.from({ length: 128 }, (_, index) => ({ ...raw.references[0], id: `fixture-${index}` }));
  await writeFile(metadataPath, JSON.stringify(raw));
  const before = await readFile(metadataPath);
  await assert.rejects(store.addReference(saved.id, { name: 'overflow.png', dataUrl: png }), /128/);
  assert.deepEqual(await readFile(metadataPath), before);
});
