import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalInbox, acknowledgeTaskStart, updateBridgeStatus, recoverTaskAfterRestart } from './task-runtime.mjs';

test('approval snapshots survive reconnects and changes replace only their owning project', () => {
  const events = [];
  const inbox = new ApprovalInbox(event => events.push(event));
  const permissionA = { type: 'approval', requestId: 'a', reason: '执行校验', decisions: ['accept', 'decline', 'cancel'] };
  const permissionB = { type: 'approval', requestId: 'b', reason: '修改模型' };
  inbox.set('project-a', permissionA);
  inbox.set('project-b', permissionB);
  assert.equal(inbox.has('a'), true);
  assert.deepEqual(inbox.snapshot(), [{ ...permissionA, projectId: 'project-a' }, { ...permissionB, projectId: 'project-b' }]);
  assert.deepEqual(events[0], { type: 'approvals', projectId: 'project-a', approvals: [{ ...permissionA, projectId: 'project-a' }] });
  assert.deepEqual(inbox.snapshot('project-a'), [{ ...permissionA, projectId: 'project-a' }]);
  inbox.delete('a');
  assert.equal(inbox.has('a'), false);
  assert.deepEqual(events.at(-1), { type: 'approvals', projectId: 'project-a', approvals: [] });
  assert.equal(inbox.snapshot()[0].projectId, 'project-b');
  inbox.clear('project-b');
  assert.deepEqual(events.at(-1), { type: 'approvals', projectId: 'project-b', approvals: [] });
  assert.deepEqual(inbox.snapshot(), []);
});

test('ending a task clears every permission for that project without removing another project snapshot', () => {
  const events = [];
  const inbox = new ApprovalInbox(event => events.push(event));
  inbox.set('project-a', { requestId: 'first' });
  inbox.set('project-a', { requestId: 'second' });
  inbox.set('project-b', { requestId: 'other' });
  inbox.clear('project-a');
  assert.deepEqual(inbox.snapshot(), [{ requestId: 'other', projectId: 'project-b' }]);
  const count = events.length;
  inbox.delete('first');
  assert.equal(events.length, count, 'A delayed approval HTTP response must not recreate an expired permission');
  assert.deepEqual(events.at(-1), { type: 'approvals', projectId: 'project-a', approvals: [] });
});

test('task becomes stoppable only after turn/start acknowledgment and cannot revive a completed task', () => {
  const starting = { id: 'task-a', status: 'starting' };
  assert.equal(acknowledgeTaskStart(starting, { threadId: 'thread-a' }), starting);
  assert.deepEqual(acknowledgeTaskStart(starting, { threadId: 'thread-a', turnId: 'turn-a' }), {
    id: 'task-a', status: 'running', threadId: 'thread-a', turnId: 'turn-a',
  });
  const completed = { id: 'task-a', status: 'completed' };
  assert.equal(acknowledgeTaskStart(completed, { threadId: 'thread-a', turnId: 'turn-a' }), completed);
  const stopping = { id: 'task-a', status: 'stopping' };
  assert.equal(acknowledgeTaskStart(stopping, { threadId: 'thread-a', turnId: 'turn-a' }), stopping);
});

test('connection status is retained in snapshots while connecting and recovered on success or disconnect', () => {
  let info = { connected: false, models: ['model'], error: 'Previous disconnect' };
  info = updateBridgeStatus(info, { status: 'connecting', message: '连接中' });
  assert.deepEqual(info, { connected: false, status: 'connecting', message: '连接中', models: ['model'], error: null });
  info = updateBridgeStatus(info, { status: 'connected', message: '已连接' });
  assert.equal(info.connected, true);
  assert.equal(info.status, 'connected');
  info = updateBridgeStatus(info, { status: 'running', message: '启动任务' });
  assert.equal(info.connected, true);
  info = updateBridgeStatus(info, { status: 'disconnected', message: '连接断开' });
  assert.equal(info.connected, false);
  assert.equal(info.status, 'disconnected');
});

test('restart between snapshot and task update resumes validation with an interrupted Agent result', () => {
  const task = recoverTaskAfterRestart({ task: { id: 'task', status: 'running', intent: 'generate' }, pendingRevisionId: 'pending-model' }, 'restart');
  assert.equal(task.status, 'validating');
  assert.equal(task.agentStatus, 'interrupted');
  assert.equal(task.modelRevisionId, 'pending-model');
  assert.equal(task.completedAt, null);
});

test('restart after preview promotion recovers completion rather than leaving a validating task forever', () => {
  for (const agentStatus of ['completed', 'failed', 'interrupted']) {
    const project = { task: { status: 'validating', agentStatus, modelRevisionId: 'revision' }, versions: [{ id: 'revision', status: 'valid' }] };
    assert.equal(recoverTaskAfterRestart(project).status, agentStatus);
  }
  const rejected = recoverTaskAfterRestart({ task: { status: 'validating', modelRevisionId: 'revision' }, versions: [{ id: 'revision', status: 'invalid', error: 'Bad geometry' }] });
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.error, 'Bad geometry');
});

test('restart preserves pending validations, ends missing runs, and leaves completed projects untouched', () => {
  const validating = { status: 'validating', agentStatus: 'completed' };
  assert.equal(recoverTaskAfterRestart({ task: validating, pendingRevisionId: 'revision' }), validating);
  const finished = { status: 'completed' };
  assert.equal(recoverTaskAfterRestart({ task: finished }), finished);
  assert.equal(recoverTaskAfterRestart({ task: { status: 'starting' } }).status, 'interrupted');
  assert.equal(recoverTaskAfterRestart({ task: { status: 'stopping' } }).status, 'interrupted');
  assert.equal(recoverTaskAfterRestart({ task: { status: 'queued' } }).status, 'interrupted');
  assert.equal(recoverTaskAfterRestart({ task: null }), null);
});
