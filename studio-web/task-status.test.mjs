import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTask, elapsedLabel } from './task-status.js';

test('image modeling progresses from ready through submission, generation and preview to completion', () => {
  const task = { status: 'running', intent: 'generate' };
  assert.equal(describeTask({ referenceCount: 1 }).phase, 'idle');
  assert.match(describeTask({ referenceCount: 1 }).description, /描述可以留空/);
  assert.equal(describeTask({ task, submitting: true }).phase, 'submitting');
  const starting = describeTask({ task: { ...task, status: 'starting' } });
  assert.equal(starting.phase, 'submitting');
  assert.equal(starting.canStop, false);
  assert.equal(starting.busy, true);
  assert.equal(starting.overlay, true);
  assert.equal(describeTask({ task }).overlay, true);
  assert.equal(describeTask({ task }).canStop, true);
  assert.equal(describeTask({ task: { ...task, status: 'validating' } }).canStop, false);
  assert.equal(describeTask({ task: { ...task, status: 'completed' }, pendingRevision: true }).phase, 'validating');
  const complete = describeTask({ task: { ...task, status: 'completed', modelValidation: 'valid' } });
  assert.equal(complete.phase, 'completed');
  assert.equal(complete.busy, false);
  assert.equal(complete.overlay, false);
  assert.match(complete.description, /通过检查/);
});

test('conversation edits cover the previous model until processing or preview validation finishes', () => {
  const task = { status: 'running', intent: 'chat' };
  assert.equal(describeTask({ task }).phase, 'working');
  assert.equal(describeTask({ task }).overlay, true);
  for (const status of ['starting', 'running', 'validating']) {
    assert.equal(describeTask({ task: { ...task, status } }).overlay, true, status);
  }
  assert.equal(describeTask({ task, submitting: true }).overlay, true);
  assert.equal(describeTask({ task, awaitingApproval: true }).overlay, true);
  assert.equal(describeTask({ task, stopping: true }).overlay, true);
  assert.equal(describeTask({ task, connected: false }).overlay, true);
  assert.equal(describeTask({ task: { ...task, status: 'completed' }, pendingRevision: true }).overlay, true);
  for (const status of ['completed', 'failed', 'interrupted', 'cancelled']) {
    assert.equal(describeTask({ task: { ...task, status } }).overlay, false, status);
  }
  assert.equal(describeTask({ uploading: true }).overlay, false);
  assert.equal(describeTask({ connected: false }).overlay, false);
  assert.equal(describeTask({ task, awaitingApproval: true }).phase, 'approval');
  assert.equal(describeTask({ task, stopping: true }).phase, 'stopping');
  assert.equal(describeTask({ task, stopping: true }).canStop, false);
  for (const status of ['interrupted', 'cancelled', 'canceled']) {
    const stopped = describeTask({ task: { ...task, status }, stopping: true, awaitingApproval: true });
    assert.equal(stopped.phase, 'stopped');
    assert.equal(stopped.busy, false);
  }
  assert.equal(describeTask({ task, activity: '正在检查模型结构' }).description, '正在检查模型结构');
});

test('disconnection cannot claim an active task has stopped and does not hide known terminal outcomes', () => {
  const unknown = describeTask({ task: { status: 'running', intent: 'generate' }, connected: false, stopping: true });
  assert.equal(unknown.phase, 'disconnected');
  assert.equal(unknown.busy, true);
  assert.equal(unknown.canStop, false);
  assert.match(unknown.description, /尚未确认/);
  assert.doesNotMatch(unknown.title, /停止/);
  assert.equal(describeTask({ connected: false }).busy, false);
  assert.equal(describeTask({ task: { status: 'completed' }, connected: false }).phase, 'completed');
  assert.equal(describeTask({ task: { status: 'validating' }, connected: false }).phase, 'validating');
  assert.equal(describeTask({ task: { status: 'failed' }, connected: false }).phase, 'failed');
});

test('uploading, failed validation and resubmission each explain the next action', () => {
  assert.equal(describeTask({ uploading: true, task: { status: 'completed' } }).phase, 'uploading');
  assert.equal(describeTask({ task: { status: 'completed' }, submitting: true }).phase, 'submitting');
  assert.match(describeTask({ task: { status: 'failed', modelValidation: 'invalid' } }).description, /恢复上一/);
  assert.equal(describeTask({ task: { status: 'running' }, activity: '   ' }).description.length > 0, true);
});

test('elapsed time ticks while running and freezes on completion without negative or invalid values', () => {
  const start = '2026-10-09T10:00:00.000Z';
  assert.equal(elapsedLabel(start, null, Date.parse(start) + 59900), '59 秒');
  assert.equal(elapsedLabel(start, null, Date.parse(start) + 65900), '1 分 05 秒');
  assert.equal(elapsedLabel(start, '2026-10-09T11:02:59.000Z'), '1 小时 02 分');
  assert.equal(elapsedLabel(start, '2026-10-09T10:00:04.000Z', Date.parse(start) + 600000), '4 秒');
  assert.equal(elapsedLabel(start, null, Date.parse(start) - 1000), '0 秒');
  assert.equal(elapsedLabel(null, null), '');
  assert.equal(elapsedLabel('not-a-date', null), '');
  assert.equal(elapsedLabel(start, 'not-a-date'), '');
});
