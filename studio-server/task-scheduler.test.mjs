import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { TaskScheduler } from './task-scheduler.mjs';

const job = (id, provider = 'codex') => ({ projectId: id, task: { id: `task-${id}`, provider, status: 'queued' } });

test('CLI and API limits are independent; queue is FIFO within a group and project-exclusive', async () => {
  const started = [], releases = new Map();
  const scheduler = new TaskScheduler({ limits: { codex: 2, api: 1 }, execute: entry => {
    started.push(entry.projectId);
    return new Promise(resolve => releases.set(entry.projectId, resolve));
  } });
  for (const entry of [job('a'), job('b'), job('c'), job('d', 'openai'), job('e', 'gemini')]) scheduler.enqueue(entry);
  await setImmediate();
  assert.deepEqual(started, ['a', 'b', 'd']);
  assert.deepEqual(scheduler.snapshot().queued.map(item => item.projectId), ['c', 'e']);
  assert.throws(() => scheduler.enqueue(job('a')), /此项目/);
  assert.throws(() => scheduler.enqueue(job('c')), /此项目/);
  releases.get('a')();
  await setImmediate();
  assert.deepEqual(started, ['a', 'b', 'd', 'c']);
  for (const release of releases.values()) release();
  await setImmediate();
  assert.equal(started.at(-1), 'e');
  releases.get('e')();
  await setImmediate();
  assert.equal(scheduler.busy, false);
});

test('cancellation does not start a queued job; limits can increase or decrease without killing running jobs', async () => {
  const releases = new Map(), started = [];
  const scheduler = new TaskScheduler({ execute: entry => { started.push(entry.projectId); return new Promise(resolve => releases.set(entry.projectId, resolve)); } });
  for (const id of ['a', 'b', 'c', 'd']) scheduler.enqueue(job(id));
  await setImmediate();
  assert.equal(scheduler.cancelQueued('b', 'wrong'), null);
  assert.equal(scheduler.cancelQueued('b', 'task-b').projectId, 'b');
  scheduler.setLimits({ codex: 2, api: 1 });
  await setImmediate();
  assert.deepEqual(started, ['a', 'c']);
  scheduler.setLimits({ codex: 1, api: 1 });
  releases.get('a')();
  await setImmediate();
  assert.deepEqual(started, ['a', 'c']);
  releases.get('c')();
  await setImmediate();
  assert.equal(started.at(-1), 'd');
  releases.get('d')();
  await setImmediate();
});

test('a failed worker releases capacity and snapshots never include private execution context', async () => {
  const errors = [], started = [];
  const scheduler = new TaskScheduler({ execute: async entry => { started.push(entry.projectId); if (entry.projectId === 'a') throw new Error('failed'); }, onError: e => errors.push(e.message) });
  scheduler.enqueue({ ...job('a'), providerConfig: { apiKey: 'private' }, request: { screenshot: 'private-image' } });
  scheduler.enqueue(job('b'));
  assert.doesNotMatch(JSON.stringify(scheduler.snapshot()), /private/);
  await setImmediate();
  assert.deepEqual(started, ['a', 'b']);
  assert.deepEqual(errors, ['failed']);
  assert.equal(scheduler.busy, false);
});
