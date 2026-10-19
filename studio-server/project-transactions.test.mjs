import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { ProjectTransactions } from './project-transactions.mjs';

test('an early preview waits for both the candidate and validating task to be saved', async () => {
  const gate = new ProjectTransactions();
  const state = { pending: null, status: 'running' };
  let continueCompletion;
  const completed = gate.run(async () => {
    state.pending = 'candidate';
    await new Promise(resolve => { continueCompletion = resolve; });
    state.status = 'validating';
  });
  await setImmediate();
  const validated = gate.run(() => {
    assert.equal(state.status, 'validating');
    state.pending = null;
    state.status = 'completed';
  });
  assert.equal(gate.busy, true);
  await setImmediate();
  assert.equal(state.status, 'running');
  continueCompletion();
  await Promise.all([completed, validated]);
  assert.deepEqual(state, { pending: null, status: 'completed' });
  assert.equal(gate.busy, false);
});

test('failed transitions release the gate and cannot discard a later queued operation', async () => {
  const gate = new ProjectTransactions();
  const failed = gate.run(() => { throw new Error('disk full'); });
  const next = gate.run(() => 'recovered');
  await assert.rejects(failed, /disk full/);
  assert.equal(await next, 'recovered');
  assert.equal(gate.busy, false);
});
