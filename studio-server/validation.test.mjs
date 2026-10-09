import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { ProjectStore } from './project-store.mjs';

const output = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-output', 'validation-regressions');
const source = name => `import * as THREE from 'three';\nexport function createModel() { const root = new THREE.Group(); root.name = '${name}'; return { root }; }\n`;

async function fixture(label) {
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, `${label}-`));
  const store = new ProjectStore({ root });
  await store.init();
  const project = (await store.list())[0];
  const { modelPath } = await store.contextPaths(project.id);
  return { store, project, modelPath, original: await readFile(modelPath, 'utf8') };
}

for (const valid of [false, true]) {
  test(`pending A → work B → ${valid ? 'validate' : 'invalidate'} A preserves work B`, async () => {
    const { store, project, modelPath } = await fixture(valid ? 'accept-newer-work' : 'reject-newer-work');
    await writeFile(modelPath, source('A'));
    const pending = await store.snapshot(project.id, { label: 'A', status: 'pending' });
    const revisionA = pending.pendingRevisionId;
    await writeFile(modelPath, source('B'));
    const result = await store.validate(project.id, revisionA, { valid, error: 'Rejected A for regression test' });
    assert.equal(await readFile(modelPath, 'utf8'), source('B'));
    assert.equal(result.pendingRevisionId, null);
    assert.equal(result.headId, valid ? revisionA : project.headId);
    assert.equal(result.versions.find(revision => revision.id === revisionA).status, valid ? 'valid' : 'invalid');
    assert.equal((await store.readRevisionSource(project.id, revisionA)).toString(), source('A'));
  });

  test(`stale ${valid ? 'valid' : 'invalid'} result for A cannot clobber pending B`, async () => {
    const { store, project, modelPath } = await fixture(valid ? 'stale-valid' : 'stale-invalid');
    await writeFile(modelPath, source('A'));
    const pendingA = await store.snapshot(project.id, { label: 'A', status: 'pending' });
    await writeFile(modelPath, source('B'));
    const pendingB = await store.snapshot(project.id, { label: 'B', status: 'pending' });
    const result = await store.validate(project.id, pendingA.pendingRevisionId, { valid, error: 'Stale A result' });
    assert.equal(await readFile(modelPath, 'utf8'), source('B'));
    assert.equal(result.pendingRevisionId, pendingB.pendingRevisionId);
    assert.equal(result.headId, project.headId);
    assert.equal(result.versions.find(revision => revision.id === pendingB.pendingRevisionId).status, 'pending');
    const completed = await store.validate(project.id, pendingB.pendingRevisionId, { valid: true });
    assert.equal(completed.headId, pendingB.pendingRevisionId);
    const repeated = await store.validate(project.id, pendingA.pendingRevisionId, { valid: !valid });
    assert.equal(repeated.headId, pendingB.pendingRevisionId);
    assert.equal(await readFile(modelPath, 'utf8'), source('B'));
  });
}

test('invalid current A still rolls back to the existing valid head', async () => {
  const { store, project, modelPath, original } = await fixture('normal-rollback');
  await writeFile(modelPath, source('A'));
  const pending = await store.snapshot(project.id, { label: 'A', status: 'pending' });
  const result = await store.validate(project.id, pending.pendingRevisionId, { valid: false, error: 'Invalid A' });
  assert.equal(await readFile(modelPath, 'utf8'), original);
  assert.equal(result.headId, project.headId);
  assert.equal(result.pendingRevisionId, null);
});

const liveOrigin = process.env.STUDIO_TEST_ORIGIN;
test('live localhost redirect and explicit connect refresh without changing projects', { skip: !liveOrigin, timeout: 90000 }, async () => {
  const expected = new URL(liveOrigin);
  assert.equal(expected.hostname, '127.0.0.1', 'Use the canonical loopback origin for this test');
  const redirected = await new Promise((resolve, reject) => {
    const req = request(`${liveOrigin}/?check=canonical`, { headers: { Host: `localhost:${expected.port}` } }, response => {
      response.resume();
      resolve({ status: response.statusCode, location: response.headers.location });
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(redirected.status, 308);
  assert.equal(redirected.location, `${liveOrigin}/?check=canonical`);

  const html = await (await fetch(liveOrigin)).text();
  const token = /<meta name="studio-token" content="([a-f0-9]+)">/.exec(html)?.[1];
  assert.ok(token, 'Session token is present, and is intentionally not printed');
  const headers = { 'x-studio-token': token, Origin: liveOrigin };
  const before = await (await fetch(`${liveOrigin}/api/bootstrap`, { headers })).json();
  assert.ok(before.projects.every(project => !['running', 'starting', 'queued'].includes(project.task?.status)), 'Do not reconnect while an Agent task is active');
  const controller = new AbortController();
  const events = await fetch(`${liveOrigin}/api/events`, { headers, signal: controller.signal });
  assert.equal(events.status, 200);
  const statuses = [];
  const consuming = (async () => {
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (data) {
            const event = JSON.parse(data.slice(6));
            if (event.type === 'bridge' && event.bridge?.status) statuses.push(event.bridge.status);
          }
        }
      }
    } catch (error) { if (error.name !== 'AbortError') throw error; }
  })();
  try {
    const response = await fetch(`${liveOrigin}/api/connect`, { method: 'POST', headers });
    assert.equal(response.status, 200);
    const connection = await response.json();
    assert.equal(connection.connected, true);
    assert.ok(Array.isArray(connection.models));
    // Drain all events already sent before the HTTP connect response.
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(statuses.includes('connecting'), 'Reconnect must initiate a fresh bridge connection');
    assert.ok(statuses.includes('connected'), 'Reconnect must complete a fresh bridge handshake');
    assert.ok(statuses.indexOf('connecting') < statuses.indexOf('connected'));
    const after = await (await fetch(`${liveOrigin}/api/bootstrap`, { headers })).json();
    assert.deepEqual(after.projects, before.projects, 'Reconnect must not modify model projects or tasks');
  } finally {
    controller.abort();
    await consuming;
  }
});
