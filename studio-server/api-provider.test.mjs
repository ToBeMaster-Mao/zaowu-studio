import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { ApiModelRunner, listProviderModels, testProviderConnection } from './api-provider.mjs';

const KEY = 'test-secret-not-a-real-api-key';
const INITIAL = 'export function createModel() { return { root: null }; }\n';
const UPDATED = 'export function createModel() { const label = "updated"; return { root: null, label }; }\n';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const result = (id, source = UPDATED, summary = '已修改部件，尚未进行预览校验。') => {
  const content = JSON.stringify({ summary, source });
  if (id === 'openai') return { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content }] }] };
  if (id === 'gemini') return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: content }] } }] };
  return { choices: [{ finish_reason: 'stop', message: { content } }] };
};

async function fixture(t, { images = false } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'zaowu-api-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const skill = path.join(cwd, '.agents/skills/model-studio');
  await mkdir(path.join(skill, 'references'), { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), 'PROJECT_SKILL: keep names stable.');
  await writeFile(path.join(skill, 'references/model-contract.md'), 'MODEL_CONTRACT: export createModel.');
  await writeFile(path.join(cwd, 'AGENTS.md'), 'WORKSPACE_RULES: only edit model.js.');
  await writeFile(path.join(cwd, 'model.js'), INITIAL);
  const imagePaths = images ? [path.join(cwd, 'reference.png'), path.join(cwd, 'current.png')] : [];
  for (const file of imagePaths) await writeFile(file, PNG);
  const context = { intent: 'chat', images: imagePaths, currentScreenshot: imagePaths[1] || null,
    references: imagePaths.slice(0, 1), selectedPart: { id: '/Handle' }, camera: { view: 'side' },
    recentConversation: [{ role: 'user', text: 'Keep the body blue' }],
    imageGroups: images ? [{ label: '把手外形', references: [{ path: imagePaths[0], imageIndex: 1 }] }] : [] };
  await writeFile(path.join(cwd, 'task-context.json'), JSON.stringify(context));
  return { cwd, prompt: '只修改把手', images: imagePaths, context, model: 'user-entered-model' };
}

async function mockServer(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const request = { method: req.method, url: req.url, headers: req.headers, raw, body: raw ? JSON.parse(raw) : undefined };
    requests.push(request);
    try { await handler(request, res); }
    catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}
function send(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
function provider(id, baseUrl, extra = {}) { return { id, baseUrl, apiKey: KEY, supportsImages: true, ...extra }; }
async function run(t, runner, args) {
  t.after(() => runner.close());
  const events = [];
  let resolve;
  const completed = new Promise(done => { resolve = done; });
  runner.on('event', event => { events.push(event); if (event.type === 'complete') resolve(event); });
  const acknowledgment = await runner.run(args);
  assert.equal(acknowledgment.threadId, null);
  assert.equal(events.length, 0, 'acknowledgment arrives before events');
  return { acknowledgment, completed, events };
}

for (const id of ['openai', 'deepseek', 'gemini', 'grok']) {
  test(`${id}: sends full project input/images and atomically writes returned source`, async t => {
    const args = await fixture(t, { images: true });
    const server = await mockServer(t, (request, res) => send(res, result(id)));
    const runner = new ApiModelRunner({ provider: provider(id, server.baseUrl) });
    const task = await run(t, runner, args);
    assert.equal((await task.completed).status, 'completed');
    assert.equal(await readFile(path.join(args.cwd, 'model.js'), 'utf8'), UPDATED);
    assert.equal((await readdir(args.cwd)).filter(file => file.startsWith('.model-')).length, 0);
    const request = server.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.headers[id === 'gemini' ? 'x-goog-api-key' : 'authorization'], id === 'gemini' ? KEY : `Bearer ${KEY}`);
    assert.ok(!request.raw.includes(KEY));
    let text, parts;
    if (id === 'openai') {
      assert.equal(request.url, '/v1/responses');
      assert.equal(request.body.store, false);
      assert.equal(request.body.model, args.model);
      assert.equal(request.body.text.format.strict, true);
      parts = request.body.input[0].content;
      text = parts[0].text;
      assert.deepEqual(parts.slice(1).map(part => part.type), ['input_image', 'input_image']);
    } else if (id === 'gemini') {
      assert.equal(request.url, '/v1/models/user-entered-model:generateContent');
      assert.ok(!request.url.includes(KEY));
      parts = request.body.contents[0].parts;
      text = parts[0].text;
      assert.equal(parts[1].inlineData.mimeType, 'image/png');
      assert.equal(parts[2].inlineData.data, PNG.toString('base64'));
    } else {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.body.model, args.model);
      assert.equal(request.body.response_format.type, id === 'deepseek' ? 'json_object' : 'json_schema');
      parts = request.body.messages[1].content;
      text = parts[0].text;
      assert.equal(parts[2].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`);
    }
    const payload = JSON.parse(text);
    assert.equal(payload.currentRequest, args.prompt);
    assert.deepEqual(payload.taskContext, args.context);
    assert.equal(payload.files.find(file => file.path === 'model.js').content, INITIAL);
    assert.ok(payload.files.some(file => file.content.includes('PROJECT_SKILL')));
    assert.ok(payload.files.some(file => file.content.includes('MODEL_CONTRACT')));
    assert.ok(payload.files.some(file => file.content.includes('WORKSPACE_RULES')));
    assert.deepEqual(payload.imageOrder.map(image => image.currentScreenshot), [false, true]);
    assert.equal(task.events.filter(event => event.type === 'complete').length, 1);
    assert.equal(task.events.find(event => event.type === 'text').delta, false);
    assert.ok(task.events.some(event => event.type === 'tool' && event.status === 'completed'));
    assert.ok(task.events.every(event => event.turnId === task.acknowledgment.turnId));
  });
}

test('model discovery is dynamic, paginated, and connection test only sends GET', async t => {
  const server = await mockServer(t, (request, res) => {
    if (request.url.includes('after=')) send(res, { data: [{ id: 'custom-next', name: 'Second' }], has_more: false });
    else send(res, { data: [{ id: 'custom-first' }, { id: '' }], has_more: true, last_id: 'custom-first' });
  });
  const response = await testProviderConnection(provider('openai', server.baseUrl));
  assert.equal(response.ok, true);
  assert.equal(response.connected, true);
  assert.deepEqual(response.models.map(model => model.id), ['custom-first', 'custom-next']);
  assert.equal(response.models[1].name, 'Second');
  assert.ok(server.requests.every(request => request.method === 'GET' && !request.body));
  assert.equal(server.requests[1].url, '/v1/models?after=custom-first');
});

test('Gemini model list uses header auth, strips models/ and filters non-generation methods', async t => {
  const server = await mockServer(t, (request, res) => send(res, request.url.includes('pageToken=')
    ? { models: [{ name: 'models/future-model', displayName: 'Future Model', supportedGenerationMethods: ['generateContent'] }] }
    : { models: [{ name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next/page' }));
  const models = await listProviderModels(provider('gemini', server.baseUrl));
  assert.deepEqual(models.map(model => model.id), ['future-model']);
  assert.equal(models[0].name, 'Future Model');
  assert.equal(server.requests[0].headers['x-goog-api-key'], KEY);
  assert.equal(server.requests[1].url, '/v1/models?pageToken=next%2Fpage');
});

test('connection errors redact exact keys and use status without leaking malformed bodies', async t => {
  const server = await mockServer(t, (_request, res) => send(res, { error: { message: `Bad api key ${KEY}, Authorization: Bearer hidden-value` } }, 401));
  await assert.rejects(testProviderConnection(provider('deepseek', server.baseUrl)), error => {
    assert.match(error.message, /HTTP 401/);
    assert.ok(!error.message.includes(KEY));
    assert.ok(!error.message.includes('hidden-value'));
    return true;
  });
  assert.equal(server.requests.length, 1);
});

test('redirects never receive the API key', async t => {
  const target = await mockServer(t, (_request, res) => send(res, { data: [] }));
  const origin = await mockServer(t, (_request, res) => { res.writeHead(307, { Location: `${target.baseUrl}/models` }); res.end(); });
  await assert.rejects(listProviderModels(provider('grok', origin.baseUrl)));
  assert.equal(target.requests.length, 0);
});

test('invalid provider and URLs fail before sending credentials', async () => {
  for (const config of [provider('unknown', 'https://example.com'), provider('openai', 'http://example.com'), provider('openai', 'https://user:password@example.com'), provider('openai', 'https://example.com?key=foo')]) {
    await assert.rejects(listProviderModels(config, { fetchImpl: () => { throw new Error('must not fetch'); } }));
  }
});

test('null source answers without changing or parsing model code', async t => {
  const args = await fixture(t);
  const server = await mockServer(t, (_request, res) => send(res, result('openai', null, `回答中意外回显 ${KEY}`)));
  const runner = new ApiModelRunner({ provider: provider('openai', server.baseUrl) });
  const task = await run(t, runner, args);
  assert.equal((await task.completed).status, 'completed');
  assert.equal(await readFile(path.join(args.cwd, 'model.js'), 'utf8'), INITIAL);
  assert.ok(!JSON.stringify(task.events).includes(KEY));
  assert.equal(task.events.filter(event => event.type === 'tool').length, 0);
});

const invalidCases = [
  ['openai', 'incomplete response', { ...result('openai'), status: 'incomplete' }],
  ['openai', 'refusal', { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }],
  ['deepseek', 'truncated valid JSON', { choices: [{ finish_reason: 'length', message: { content: JSON.stringify({ summary: 'truncated', source: UPDATED }) } }] }],
  ['grok', 'tool call response', { choices: [{ finish_reason: 'tool_calls', message: { content: '{}' } }] }],
  ['gemini', 'truncated result', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] }],
  ['gemini', 'blocked result', { promptFeedback: { blockReason: 'SAFETY' } }],
  ['deepseek', 'empty result', { choices: [{ finish_reason: 'stop', message: { content: '' } }] }],
  ['deepseek', 'missing source', { choices: [{ finish_reason: 'stop', message: { content: '{"summary":"missing"}' } }] }],
  ['deepseek', 'empty source', result('deepseek', '')],
  ['deepseek', 'invalid JavaScript', result('deepseek', 'export function createModel( {')],
  ['deepseek', 'secret in source', result('deepseek', `export const secret = ${JSON.stringify(KEY)};`)],
];
for (const [id, name, response] of invalidCases) {
  test(`rejects ${name} without replacing source`, async t => {
    const args = await fixture(t);
    const server = await mockServer(t, (_request, res) => send(res, response));
    const runner = new ApiModelRunner({ provider: provider(id, server.baseUrl) });
    const task = await run(t, runner, args);
    assert.equal((await task.completed).status, 'failed');
    assert.equal(await readFile(path.join(args.cwd, 'model.js'), 'utf8'), INITIAL);
    assert.equal((await readdir(args.cwd)).filter(file => file.startsWith('.model-')).length, 0);
  });
}

test('syntax validation never executes generated JavaScript', async t => {
  const args = await fixture(t);
  const source = 'throw new Error("This code must never run on the server");\nexport function createModel() { return {}; }';
  const server = await mockServer(t, (_request, res) => send(res, result('deepseek', source)));
  const task = await run(t, new ApiModelRunner({ provider: provider('deepseek', server.baseUrl) }), args);
  assert.equal((await task.completed).status, 'completed');
  assert.equal(await readFile(path.join(args.cwd, 'model.js'), 'utf8'), source);
});

test('text-only configuration rejects images including a current screenshot before any API request', async t => {
  const args = await fixture(t, { images: true });
  const server = await mockServer(t, (_request, res) => send(res, result('deepseek')));
  const task = await run(t, new ApiModelRunner({ provider: provider('deepseek', server.baseUrl, { supportsImages: false }) }), args);
  assert.equal((await task.completed).status, 'failed');
  assert.match((await task.completed).message, /图片/);
  assert.equal(server.requests.length, 0);
});

test('missing current screenshot and mismatched task context are rejected', async t => {
  const args = await fixture(t, { images: true });
  const server = await mockServer(t, (_request, res) => send(res, result('openai')));
  for (const changed of [{ ...args, images: args.images.slice(0, 1) }, { ...args, context: { ...args.context, intent: 'generate' } }]) {
    const task = await run(t, new ApiModelRunner({ provider: provider('openai', server.baseUrl) }), changed);
    assert.equal((await task.completed).status, 'failed');
  }
  assert.equal(server.requests.length, 0);
});

test('outside images, invalid image bytes and too many images are rejected', async t => {
  const args = await fixture(t, { images: true });
  const server = await mockServer(t, (_request, res) => send(res, result('openai')));
  await writeFile(args.images[0], 'not an image');
  const task = await run(t, new ApiModelRunner({ provider: provider('openai', server.baseUrl) }), args);
  assert.equal((await task.completed).status, 'failed');
  const runner = new ApiModelRunner({ provider: provider('openai', server.baseUrl) });
  await assert.rejects(runner.run({ ...args, images: Array(18).fill(args.images[0]) }), /最多/);
  const outside = path.join(os.tmpdir(), 'outside.png');
  args.images = [outside]; args.context.images = args.images; args.context.references = []; args.context.imageGroups = []; args.context.currentScreenshot = null;
  await writeFile(path.join(args.cwd, 'task-context.json'), JSON.stringify(args.context));
  const outsideTask = await run(t, runner, args);
  assert.equal((await outsideTask.completed).status, 'failed');
  assert.equal(server.requests.length, 0);
});

test('symlinked source is not read or replaced', async t => {
  const args = await fixture(t);
  const target = path.join(args.cwd, 'target.js');
  await writeFile(target, INITIAL);
  await rm(path.join(args.cwd, 'model.js'));
  try { await symlink(target, path.join(args.cwd, 'model.js')); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Symbolic links require Windows privilege'); return; } throw error; }
  const task = await run(t, new ApiModelRunner({ provider: provider('openai', 'http://127.0.0.1:1') }), args);
  assert.equal((await task.completed).status, 'failed');
  assert.equal(await readFile(target, 'utf8'), INITIAL);
});

test('concurrent model edits are preserved instead of silently overwritten', async t => {
  const args = await fixture(t);
  const server = await mockServer(t, async (_request, res) => {
    await writeFile(path.join(args.cwd, 'model.js'), 'export const userEdit = true;');
    send(res, result('openai'));
  });
  const task = await run(t, new ApiModelRunner({ provider: provider('openai', server.baseUrl) }), args);
  assert.equal((await task.completed).status, 'failed');
  assert.match((await task.completed).message, /其他操作修改/);
  assert.equal(await readFile(path.join(args.cwd, 'model.js'), 'utf8'), 'export const userEdit = true;');
});

test('interrupt aborts the HTTP request and leaves the model unchanged', async t => {
  const args = await fixture(t);
  let reached;
  const started = new Promise(resolve => { reached = resolve; });
  const server = await mockServer(t, (_request, _res) => reached());
  const runner = new ApiModelRunner({ provider: provider('openai', server.baseUrl) });
  const task = await run(t, runner, args);
  await started;
  assert.equal(runner.busy, true);
  await assert.rejects(runner.run(args), /尚未结束/);
  assert.deepEqual(await runner.interrupt(), { interrupted: true });
  assert.equal((await task.completed).status, 'interrupted');
  assert.equal(await readFile(path.join(args.cwd, 'model.js'), 'utf8'), INITIAL);
  assert.equal(runner.busy, false);
});

test('close awaits an in-flight transport that ignores abort and never writes its late response', async t => {
  const args = await fixture(t);
  let resolveResponse, reached;
  const started = new Promise(resolve => { reached = resolve; });
  const fetchImpl = () => { reached(); return new Promise(resolve => { resolveResponse = resolve; }); };
  const runner = new ApiModelRunner({ provider: provider('grok', 'https://example.com'), fetchImpl });
  const task = await run(t, runner, args);
  await started;
  let closed = false;
  const closing = runner.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  resolveResponse(new Response(JSON.stringify(result('grok'))));
  await closing;
  assert.equal((await task.completed).status, 'interrupted');
  assert.equal(await readFile(path.join(args.cwd, 'model.js'), 'utf8'), INITIAL);
  await assert.rejects(runner.run(args), /已关闭/);
});

test('timeout covers response bodies, fails visibly and retains previous model', async t => {
  const args = await fixture(t);
  const server = await mockServer(t, (_request, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); });
  const task = await run(t, new ApiModelRunner({ provider: provider('openai', server.baseUrl), timeoutMs: 150 }), args);
  assert.equal((await task.completed).status, 'failed');
  assert.match((await task.completed).message, /超时/);
  assert.equal(await readFile(path.join(args.cwd, 'model.js'), 'utf8'), INITIAL);
});

test('cancel before background preparation completes does not send a request', async t => {
  const args = await fixture(t);
  let called = false;
  const runner = new ApiModelRunner({ provider: provider('openai', 'https://example.com'), fetchImpl: () => { called = true; throw new Error('must not send'); } });
  const task = await run(t, runner, args);
  await runner.close();
  assert.equal((await task.completed).status, 'interrupted');
  assert.equal(called, false);
});

test('cancel immediately before syntax checking prevents writes and temporary files', async t => {
  const args = await fixture(t);
  const server = await mockServer(t, (_request, res) => send(res, result('grok')));
  const runner = new ApiModelRunner({ provider: provider('grok', server.baseUrl) });
  runner.on('event', event => { if (event.type === 'tool' && event.status === 'inProgress') void runner.interrupt(); });
  const task = await run(t, runner, args);
  assert.equal((await task.completed).status, 'interrupted');
  assert.equal(await readFile(path.join(args.cwd, 'model.js'), 'utf8'), INITIAL);
  assert.equal((await readdir(args.cwd)).filter(file => file.startsWith('.model-')).length, 0);
});

test('oversized images fail before issuing a billable request', async t => {
  const args = await fixture(t, { images: true });
  await writeFile(args.images[0], Buffer.alloc(10 * 1024 * 1024 + 1));
  const server = await mockServer(t, (_request, res) => send(res, result('openai')));
  const task = await run(t, new ApiModelRunner({ provider: provider('openai', server.baseUrl) }), args);
  assert.equal((await task.completed).status, 'failed');
  assert.match((await task.completed).message, /过大/);
  assert.equal(server.requests.length, 0);
});

test('model-list metadata never exposes a reflected API key', async t => {
  const server = await mockServer(t, (_request, res) => send(res, { data: [{ id: KEY }, { id: 'safe-id', name: `Echo ${KEY}` }] }));
  const models = await listProviderModels(provider('grok', server.baseUrl));
  assert.deepEqual(models.map(model => model.id), ['safe-id']);
  assert.ok(!JSON.stringify(models).includes(KEY));
});
