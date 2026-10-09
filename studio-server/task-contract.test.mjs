import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTaskRequest, buildAgentPrompt, completeTask, validateTask, assertStopTarget, recentConversationContext } from './task-contract.mjs';

const references = Array.from({ length: 8 }, (_, index) => ({ id: `reference-${index}`, name: `图 ${index + 1}` }));
const project = { id: 'old-aircraft-project', name: '参考客机', references, overrides: { Old_Wing: { visible: false } } };
const screenshot = 'data:image/png;base64,aGVsbG8=';

test('fresh chat threads retain only bounded recent user and assistant history; generation and resumes exclude it', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `message-${index}` }));
  const relocated = { messages: [...messages, { role: 'system', text: 'Not a user conversation' }, { role: 'assistant', text: '' }], threadId: null };
  const history = recentConversationContext(relocated, 'chat');
  assert.equal(history.length, 12);
  assert.equal(history[0].text, 'message-8');
  assert.equal(history.at(-1).text, 'message-19');
  const large = recentConversationContext({ messages: messages.map(message => ({ ...message, text: message.text + 'x'.repeat(6000) })) }, 'chat');
  assert.ok(large.every(message => message.text.length <= 4000));
  assert.ok(large.reduce((total, message) => total + message.text.length, 0) <= 32000);
  assert.ok(large.at(-1).text.startsWith('message-19'));
  assert.deepEqual(recentConversationContext(relocated, 'generate'), []);
  assert.deepEqual(recentConversationContext({ ...relocated, threadId: 'existing-thread' }, 'chat'), []);
  assert.equal(messages[0].text, 'message-0', 'The stored transcript must not be mutated');
  assert.match(buildAgentPrompt(prepareTaskRequest({ references: [] }, { prompt: '继续' })), /recentConversation.*有限对话历史/);
});

test('image-only generation includes all eight project references and excludes old model context', () => {
  const request = prepareTaskRequest(project, {
    intent: 'generate', prompt: '  ', selectedPart: { name: 'Old_Wing' },
    viewContext: { position: [1, 2, 3] }, screenshotDataUrl: screenshot,
  });
  assert.equal(request.intent, 'generate');
  assert.equal(request.userPrompt, '');
  assert.equal(request.references.length, 8, 'There must not be a hidden six-image truncation');
  assert.deepEqual(request.referenceIds, references.map(ref => ref.id));
  assert.equal(request.selectedPart, null);
  assert.equal(request.camera, null);
  assert.equal(request.screenshotDataUrl, null);
  assert.deepEqual(request.overrides, {});
  assert.equal(request.prompt, '根据 8 张参考图片开始建模。');
  const prompt = buildAgentPrompt(request);
  assert.match(prompt, /重建当前项目的主体模型/);
  assert.match(prompt, /旧模型和旧对话仅是项目历史/);
  assert.match(prompt, /不要自行使用 references 目录中的其他历史图片/);
  assert.match(prompt, /不要要求用户先进行对话/);
});

test('generation validates ownership, explicit selection and optional requirements', () => {
  const request = prepareTaskRequest(project, {
    intent: 'generate', prompt: '做成陶瓷杯', referenceIds: ['reference-5', 'reference-0', 'reference-5'],
  });
  assert.deepEqual(request.referenceIds, ['reference-5', 'reference-0']);
  assert.equal(request.references[0], references[5]);
  assert.equal(request.prompt, '根据 2 张参考图片开始建模。\n补充要求：做成陶瓷杯');
  assert.match(buildAgentPrompt(request), /用户的补充要求：\n做成陶瓷杯/);
  assert.throws(() => prepareTaskRequest(project, { intent: 'generate', referenceIds: [] }), /至少一张/);
  assert.throws(() => prepareTaskRequest({ references: [] }, { intent: 'generate' }), /至少一张/);
  assert.throws(() => prepareTaskRequest(project, { intent: 'generate', referenceIds: ['from-another-project'] }), /不属于当前项目/);
  assert.throws(() => prepareTaskRequest(project, { intent: 'generate', referenceIds: 'reference-0' }), /有效的参考/);
  assert.throws(() => prepareTaskRequest(project, { intent: 'generate', referenceIds: [null] }), /有效的参考/);
  assert.throws(() => prepareTaskRequest(project, { intent: 'generate', prompt: 1 }), /须为文字/);
  assert.throws(() => prepareTaskRequest(project, { intent: 'generate', prompt: 'a'.repeat(12001) }), /12000/);
});

test('chat preserves local edit context and never silently loses image inputs', () => {
  const selectedPart = { name: 'Cup_Handle' }, camera = { position: [1, 2, 3] };
  const request = prepareTaskRequest(project, {
    prompt: '  只加粗杯把  ', referenceIds: ['reference-2'], selectedPart,
    viewContext: camera, screenshotDataUrl: screenshot,
  });
  assert.equal(request.intent, 'chat');
  assert.equal(request.prompt, '只加粗杯把');
  assert.equal(request.selectedPart, selectedPart);
  assert.equal(request.camera, camera);
  assert.equal(request.overrides, project.overrides);
  assert.equal(request.screenshotDataUrl, screenshot);
  assert.match(buildAgentPrompt(request), /用户只要求局部修改时保留其他部件/);
  assert.doesNotMatch(buildAgentPrompt(request), /重建当前项目的主体模型/);
  assert.throws(() => prepareTaskRequest(project, { prompt: '' }), /请输入建模要求/);
  assert.equal(prepareTaskRequest(project, { prompt: '修改', screenshotDataUrl: screenshot }).references.length, 8);
  assert.equal(prepareTaskRequest(project, { prompt: '修改' }).references.length, 8);
  const seventeen = { references: Array.from({ length: 17 }, (_, index) => ({ id: `reference-${index}` })) };
  assert.throws(() => prepareTaskRequest(seventeen, { intent: 'generate' }), /最多选择 16 张/);
  assert.throws(() => prepareTaskRequest(project, { intent: 'unknown' }), /不支持/);
});

test('scoped stop rejects other projects, stale tasks and legacy unscoped active requests', () => {
  const active = { projectId: 'project-a', task: { id: 'task-a' } };
  assert.doesNotThrow(() => assertStopTarget({}, null), 'Old callers are harmless when there is no task');
  assert.doesNotThrow(() => assertStopTarget({ projectId: 'project-a' }, active));
  assert.doesNotThrow(() => assertStopTarget({ projectId: 'project-a', taskId: 'task-a' }, active));
  assert.throws(() => assertStopTarget({}, active), /指定.*项目/);
  assert.throws(() => assertStopTarget({ projectId: 'project-b' }, active), error => error.status === 409);
  assert.throws(() => assertStopTarget({ projectId: 'project-a', taskId: 'old-task' }, active), error => error.status === 409);
});

for (const status of ['completed', 'failed', 'interrupted']) {
  test(`${status} task with a changed model retains the Agent outcome after preview`, () => {
    const result = completeTask({ id: 'task-a', status: 'running', intent: 'generate' }, { status, message: status === 'failed' ? 'Disconnected' : null }, {
      changed: true, output: 'Saved partial or complete model.', at: '2026-10-09T01:00:00.000Z',
    });
    assert.equal(result.status, 'validating');
    assert.equal(result.agentStatus, status);
    assert.equal(result.completedAt, null, 'Waiting for the actual preview must not be reported as complete');
    const validated = validateTask(result, { valid: true, at: '2026-10-09T01:00:05.000Z' });
    assert.equal(validated.status, status);
    assert.equal(validated.completedAt, '2026-10-09T01:00:05.000Z');
    assert.equal(validated.error, status === 'failed' ? 'Disconnected' : null);
    const rejected = validateTask(result, { valid: false, error: 'Geometry is invalid' });
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.error, 'Geometry is invalid');
    assert.equal(rejected.modelValidation, 'invalid');
  });
}

test('a completed answer without edits ends immediately; unknown Agent status is never success', () => {
  const task = completeTask({ id: 'task-a' }, { status: 'completed' }, { changed: false, output: '回答', at: 'finished' });
  assert.equal(task.status, 'completed');
  assert.equal(task.completedAt, 'finished');
  assert.equal(task.modelChanged, false);
  assert.equal(completeTask({}, { status: 'unexpected' }, { changed: false, output: '' }).status, 'failed');
});
