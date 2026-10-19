/** Runs the real HTTP service with disposable storage and a local mock API.
 * Never reads user settings, launches a working Codex, or calls a paid service.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAVED_KEY = 'integration-only-fake-saved-key';
const TEMP_KEY = 'integration-only-fake-temporary-key';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(read, matches, label, timeout = 12000) {
  const until = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (matches(last)) return last;
    await delay(35);
  } while (Date.now() < until);
  assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(last).slice(0, 1200)}`);
}

async function freePort() {
  const reservation = http.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

function modelSource(label) {
  return `import * as THREE from 'three';\nexport function createModel() {\n  const root = new THREE.Group();\n  root.name = ${JSON.stringify(label)};\n  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial({ color: '#356b7c' }));\n  body.name = 'Body';\n  root.add(body);\n  return { root };\n}\n`;
}

async function mockProvider() {
  const requests = [], generations = [], held = new Map();
  let active = 0, peak = 0;
  const finish = (res, label) => {
    if (res.destroyed || res.writableEnded) return false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{
      type: 'output_text', text: JSON.stringify({ summary: `已修改 ${label}，等待平台预览校验。`, source: modelSource(label) }),
    }] }] }));
    return true;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-listed-model' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Unexpected mock endpoint"}}'); return;
      }
      const payload = JSON.parse(body.input[0].content[0].text);
      const label = payload.taskContext.prompt;
      generations.push({ label, payload, model: body.model, authorization: req.headers.authorization, res });
      active++; peak = Math.max(active, peak);
      res.once('close', () => { active--; });
      if (label.startsWith('hold-')) held.set(label, res);
      else finish(res, label);
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"Invalid mock request"}}');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    requests, generations, held,
    get active() { return active; }, get peak() { return peak; },
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    release(label) { const res = held.get(label); assert.ok(res, `Expected held request ${label}`); return finish(res, label); },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function isolatedStudio(t) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'zaowu-settings-api-'));
  const firstWorkspace = path.join(fixtureRoot, '工作空间 A');
  const secondWorkspace = path.join(fixtureRoot, '工作空间 B');
  const settingsPath = path.join(fixtureRoot, 'private', 'settings.json');
  const mock = await mockProvider();
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  let logs = '', token, currentWorkspace, eventRequest, eventResponse;
  const observedEvents = [];
  const slowRequests = new Set();
  const child = spawn(process.execPath, ['studio-server/server.mjs'], {
    cwd: REPO, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '', STUDIO_PORT: String(port), STUDIO_DATA_DIR: firstWorkspace,
      STUDIO_SETTINGS_PATH: settingsPath, CODEX_BIN: path.join(fixtureRoot, 'codex-definitely-not-installed.exe') },
  });
  const collect = chunk => { logs = (logs + chunk.toString()).slice(-10000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const closed = new Promise(resolve => child.once('close', resolve));
  child.once('error', error => { logs += `\nProcess error: ${error.message}`; });
  t.after(async () => {
    eventResponse?.destroy(); eventRequest?.destroy();
    for (const request of slowRequests) request.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let closeTimer;
    await Promise.race([closed, new Promise(resolve => { closeTimer = setTimeout(resolve, 3000); })]);
    clearTimeout(closeTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await mock.close();
    // The only recursive deletion is the uniquely created test fixture in tmp.
    const resolved = path.resolve(fixtureRoot);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('zaowu-settings-api-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await eventually(async () => {
    if (child.exitCode !== null || child.signalCode !== null) assert.fail(`Studio exited during startup: ${logs}`);
    try { return (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) })).status; }
    catch { return 0; }
  }, value => value === 200, 'isolated server startup', 25000);
  const html = await (await fetch(origin)).text();
  token = html.match(/name="studio-token"\s+content="([^"]+)"/)?.[1];
  assert.ok(token, 'server injects a fresh session token');
  async function request(endpoint, { method = 'GET', body, workspace = currentWorkspace, expected = 200 } = {}) {
    const headers = { 'x-studio-token': token, Origin: origin };
    if (workspace) headers['x-studio-workspace'] = encodeURIComponent(workspace);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${origin}${endpoint}`, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${method} ${endpoint}: expected ${expected}, got ${response.status}: ${JSON.stringify(data).slice(0, 1000)}`);
    return data;
  }
  async function slowPatch(endpoint, body) {
    const bytes = Buffer.from(JSON.stringify(body));
    let resolveStarted, rejectStarted, resolveResult, rejectResult;
    const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    result.catch(() => {}); // Cleanup can abort an unfinished request after an earlier assertion fails.
    const req = http.request(`${origin}${endpoint}`, { method: 'PATCH', headers: {
      'x-studio-token': token, Origin: origin, 'x-studio-workspace': encodeURIComponent(currentWorkspace),
      'Content-Type': 'application/json', 'Content-Length': bytes.length, Expect: '100-continue',
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', rejectResult);
      res.on('end', () => {
        try { resolveResult({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { rejectResult(error); }
      });
    });
    slowRequests.add(req);
    req.once('close', () => slowRequests.delete(req));
    req.once('error', error => { rejectStarted(error); rejectResult(error); });
    req.setTimeout(15000, () => req.destroy(new Error('Slow request timed out')));
    // HTTP 100 confirms the real server has parsed these headers. Keep the JSON
    // body unfinished while another connection changes the active workspace.
    req.once('continue', () => req.write(bytes.subarray(0, -1), error => error ? rejectStarted(error) : resolveStarted()));
    req.flushHeaders();
    await started;
    return { async finish() { req.end(bytes.subarray(-1)); return result; } };
  }
  const bootstrap = await request('/api/bootstrap');
  currentWorkspace = bootstrap.workspaceRoot;
  // Scheduler errors are emitted over SSE, not necessarily written to stderr.
  // Retain compact lifecycle evidence so a failure under parallel test load
  // reports the real error rather than only the last persisted task status.
  await new Promise((resolve, reject) => {
    eventRequest = http.get(`${origin}/api/events`, { headers: { 'x-studio-token': token, Origin: origin,
      'x-studio-workspace': encodeURIComponent(currentWorkspace) } }, res => {
      eventResponse = res;
      if (res.statusCode !== 200) { reject(new Error(`SSE diagnostics returned ${res.statusCode}`)); res.resume(); return; }
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (!data) continue;
          try {
            const event = JSON.parse(data.slice(6));
            const task = event.task || event.project?.task;
            observedEvents.push({ at: Date.now(), type: event.type, projectId: event.projectId || event.project?.id,
              ...(task ? { task: { id: task.id, status: task.status, error: task.error, turnId: task.turnId } } : {}),
              ...(event.scheduler ? { scheduler: event.scheduler } : {}),
              ...(event.type === 'notice' ? { message: event.message } : {}) });
            if (observedEvents.length > 80) observedEvents.shift();
          } catch { /* Heartbeats and incomplete non-JSON frames carry no diagnostic state. */ }
        }
      });
      res.on('error', error => { logs += `\nSSE diagnostics: ${error.message}`; });
      resolve();
    });
    eventRequest.once('error', reject);
  });
  async function withDiagnostics(operation, projectId) {
    try { return await operation(); }
    catch (error) {
      let latest;
      try {
        const response = await fetch(`${origin}/api/bootstrap`, { headers: { 'x-studio-token': token, Origin: origin }, signal: AbortSignal.timeout(2000) });
        const data = await response.json();
        latest = { status: response.status, workspaceRoot: data.workspaceRoot, scheduler: data.scheduler };
      } catch (diagnosticError) { latest = { error: diagnosticError.message }; }
      let persistedTask;
      if (projectId) {
        try { persistedTask = JSON.parse(await readFile(path.join(currentWorkspace, projectId, 'project.json'), 'utf8')).task; }
        catch (diagnosticError) { persistedTask = { error: diagnosticError.message }; }
      }
      const details = JSON.stringify({ origin, process: { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode },
        latest, persistedTask, mock: { active: mock.active, peak: mock.peak,
          requests: mock.requests.map(item => ({ method: item.method, url: item.url })),
          generations: mock.generations.map(item => ({ label: item.label, model: item.model })) },
        events: observedEvents, serverLogs: logs }, null, 2)
        .replaceAll(SAVED_KEY, '[redacted]').replaceAll(TEMP_KEY, '[redacted]');
      t.diagnostic(`Isolated server failure context:\n${details}`);
      throw error;
    }
  }
  return {
    fixtureRoot, firstWorkspace, secondWorkspace, settingsPath, mock, origin, request, slowPatch, bootstrap,
    get logs() { return logs; },
    get workspace() { return currentWorkspace; },
    set workspace(value) { currentWorkspace = value; },
    project(id) { return request(`/api/projects/${id}`); },
    create(name) { return request('/api/projects', { method: 'POST', body: { name }, expected: 201 }); },
    start(id, prompt) { return request(`/api/projects/${id}/tasks`, { method: 'POST', body: { prompt, provider: 'openai', referenceIds: [] }, expected: 202 }); },
    waitState(id, state) { return withDiagnostics(() => eventually(() => request(`/api/projects/${id}`), project => project.task?.status === state, `${id} task ${state}`), id); },
    waitGeneration(label) { return withDiagnostics(() => eventually(async () => mock.generations.find(item => item.label === label), Boolean, `mock generation ${label}`)); },
    idle() { return withDiagnostics(() => eventually(() => request('/api/bootstrap'), data => !data.scheduler.active.length && !data.scheduler.queued.length, 'scheduler idle')); },
    async validate(project) {
      assert.ok(project.pendingRevisionId, 'new source must await viewer validation');
      return request(`/api/projects/${project.id}/validate`, { method: 'POST', body: { revisionId: project.pendingRevisionId, valid: true } });
    },
  };
}

test('real HTTP settings, API execution, queues, cancellation and workspace history stay isolated', { timeout: 120000 }, async t => {
  const studio = await isolatedStudio(t);
  const { request, mock, settingsPath } = studio;
  const noSecrets = data => {
    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes(SAVED_KEY), 'public response must omit saved key');
    assert.ok(!serialized.includes(TEMP_KEY), 'public response must omit transient key');
    assert.ok(!serialized.includes('"apiKey"'), 'public response must omit credential fields');
  };
  noSecrets(studio.bootstrap);
  assert.equal(studio.bootstrap.projects.length, 1);
  assert.equal(studio.bootstrap.workspaceRoot, studio.firstWorkspace);
  assert.equal(studio.bootstrap.capabilities.multiProvider, true);
  assert.equal(studio.bootstrap.settings.apiConcurrency, 1);
  const initialSettings = await request('/api/settings');
  assert.equal(initialSettings.providers.openai.hasApiKey, false);
  const savedSettings = await request('/api/settings', { method: 'PUT', body: {
    defaultProvider: 'openai', apiConcurrency: 1,
    providers: { openai: { baseUrl: mock.baseUrl, apiKey: SAVED_KEY, model: 'manual-model-not-listed', supportsImages: true } },
  } });
  noSecrets(savedSettings);
  assert.equal(savedSettings.providers.openai.hasApiKey, true);
  assert.equal(savedSettings.providers.openai.model, 'manual-model-not-listed');
  const persisted = await readFile(settingsPath, 'utf8');
  assert.equal(JSON.parse(persisted).providers.openai.apiKey, SAVED_KEY);
  assert.equal((await request('/api/settings')).defaultProvider, 'openai');
  noSecrets(await request('/api/bootstrap'));

  // Unsaved settings are probes, not writes; both operations only GET /models.
  const probes = { baseUrl: mock.baseUrl, apiKey: TEMP_KEY, model: 'unsaved-model', supportsImages: false };
  const connection = await request('/api/providers/openai/test', { method: 'POST', body: probes });
  assert.equal(connection.ok, true); assert.equal(connection.connected, true);
  const discovered = await request('/api/providers/openai/models', { method: 'POST', body: probes });
  assert.deepEqual(discovered.models.map(model => model.id), ['mock-listed-model']);
  noSecrets(connection); noSecrets(discovered);
  assert.equal(await readFile(settingsPath, 'utf8'), persisted);
  assert.equal((await request('/api/settings')).providers.openai.model, 'manual-model-not-listed');
  assert.equal(mock.requests.length, 2);
  assert.ok(mock.requests.every(req => req.method === 'GET' && req.authorization === `Bearer ${TEMP_KEY}`));
  t.diagnostic('Settings persist privately; unsaved probes neither generate nor change stored configuration.');

  // Codex is intentionally unavailable, yet the real API task pipeline works.
  await eventually(() => request('/api/bootstrap'), data => data.bridge.status === 'disconnected', 'missing Codex to be reported');
  const initial = studio.bootstrap.projects[0];
  await studio.start(initial.id, 'generated-immediate');
  const validating = await studio.waitState(initial.id, 'validating');
  assert.equal(validating.headId, initial.headId, 'candidate cannot become head before viewer validation');
  assert.equal(validating.task.agentStatus, 'completed');
  assert.equal(validating.task.provider, 'openai');
  assert.equal(validating.threadId, null);
  assert.equal(await readFile(path.join(validating.workspacePath, 'model.js'), 'utf8'), modelSource('generated-immediate'));
  const generation = mock.generations.find(item => item.label === 'generated-immediate');
  assert.equal(generation.model, 'manual-model-not-listed', 'manual model IDs do not require list membership');
  assert.equal(generation.authorization, `Bearer ${SAVED_KEY}`);
  assert.ok(generation.payload.files.some(file => file.path.endsWith('SKILL.md')));
  const completed = await studio.validate(validating);
  assert.equal(completed.task.status, 'completed');
  assert.equal(completed.headId, validating.pendingRevisionId);
  assert.equal(completed.pendingRevisionId, null);
  await studio.idle();
  t.diagnostic('API runs with no Codex executable and waits for explicit viewer validation before completion.');

  const first = await studio.create('串行运行');
  const cancelled = await studio.create('取消排队');
  const promoted = await studio.create('下一位');
  const firstSource = await readFile(path.join(first.workspacePath, 'model.js'), 'utf8');
  const cancelledSource = await readFile(path.join(cancelled.workspacePath, 'model.js'), 'utf8');
  const promotedSource = await readFile(path.join(promoted.workspacePath, 'model.js'), 'utf8');
  const a = await studio.start(first.id, 'hold-first');
  await studio.waitGeneration('hold-first');
  await studio.waitState(first.id, 'running');
  const b = await studio.start(cancelled.id, 'hold-cancelled');
  const c = await studio.start(promoted.id, 'hold-promoted');
  assert.equal((await studio.project(cancelled.id)).task.status, 'queued');
  assert.equal((await studio.project(promoted.id)).task.status, 'queued');
  const queued = await request('/api/bootstrap');
  assert.equal(queued.scheduler.active.length, 1);
  assert.deepEqual(queued.scheduler.queued.map(item => item.projectId), [cancelled.id, promoted.id]);
  assert.equal(mock.generations.some(item => item.label === 'hold-cancelled'), false);
  await request(`/api/projects/${first.id}/tasks`, { method: 'POST', body: { prompt: 'duplicate', provider: 'openai' }, expected: 409 });
  await request(`/api/projects/${cancelled.id}/tasks`, { method: 'POST', body: { prompt: 'duplicate-queued', provider: 'openai' }, expected: 409 });
  await request('/api/settings', { method: 'PUT', body: { workspaceRoot: studio.secondWorkspace }, expected: 409 });
  assert.equal((await request('/api/settings')).workspaceRoot, studio.firstWorkspace);

  const cancelQueued = await request('/api/tasks/stop', { method: 'POST', body: { projectId: cancelled.id, taskId: b.task.id } });
  assert.equal(cancelQueued.interrupted, true);
  await studio.waitState(cancelled.id, 'interrupted');
  assert.equal(await readFile(path.join(cancelled.workspacePath, 'model.js'), 'utf8'), cancelledSource);
  const stopActive = await request('/api/tasks/stop', { method: 'POST', body: { projectId: first.id, taskId: a.task.id } });
  assert.equal(stopActive.interrupted, true);
  await studio.waitState(first.id, 'interrupted');
  await studio.waitGeneration('hold-promoted');
  await studio.waitState(promoted.id, 'running');
  await eventually(async () => mock.held.get('hold-first').destroyed, Boolean, 'aborted provider connection');
  assert.equal(mock.release('hold-first'), false, 'a late answer cannot reach the cancelled task');
  assert.equal(await readFile(path.join(first.workspacePath, 'model.js'), 'utf8'), firstSource);
  assert.equal(mock.generations.some(item => item.label === 'hold-cancelled'), false, 'cancelled queue entry never runs');
  await request('/api/tasks/stop', { method: 'POST', body: { projectId: promoted.id, taskId: c.task.id } });
  await studio.waitState(promoted.id, 'interrupted');
  await studio.idle();
  assert.equal(await readFile(path.join(promoted.workspacePath, 'model.js'), 'utf8'), promotedSource);
  t.diagnostic('Concurrency 1 enforces FIFO, duplicate-project rejection and safe cancellation before and during execution.');

  await request('/api/settings', { method: 'PUT', body: { apiConcurrency: 2 } });
  const left = await studio.create('并行左侧'), right = await studio.create('并行右侧');
  await Promise.all([studio.start(left.id, 'hold-left'), studio.start(right.id, 'hold-right')]);
  await Promise.all([studio.waitGeneration('hold-left'), studio.waitGeneration('hold-right')]);
  await Promise.all([studio.waitState(left.id, 'running'), studio.waitState(right.id, 'running')]);
  const parallel = await request('/api/bootstrap');
  assert.equal(parallel.scheduler.active.length, 2);
  assert.ok(parallel.scheduler.active.some(item => item.projectId === left.id));
  assert.ok(parallel.scheduler.active.some(item => item.projectId === right.id));
  assert.equal(mock.active, 2);
  assert.equal(mock.peak, 2);
  mock.release('hold-left'); mock.release('hold-right');
  const [leftCandidate, rightCandidate] = await Promise.all([studio.waitState(left.id, 'validating'), studio.waitState(right.id, 'validating')]);
  await studio.validate(leftCandidate); await studio.validate(rightCandidate);
  await studio.idle();
  assert.equal(await readFile(path.join(left.workspacePath, 'model.js'), 'utf8'), modelSource('hold-left'));
  assert.equal(await readFile(path.join(right.workspacePath, 'model.js'), 'utf8'), modelSource('hold-right'));
  t.diagnostic('Concurrency 2 runs two independent projects at the same time.');

  // Switching selects a different directory. Existing files remain in place.
  const oldProject = await studio.project(left.id);
  const oldSource = await readFile(path.join(oldProject.workspacePath, 'model.js'), 'utf8');
  const oldRoot = studio.workspace;
  const switched = await request('/api/settings', { method: 'PUT', body: { workspaceRoot: studio.secondWorkspace } });
  studio.workspace = switched.workspaceRoot;
  assert.equal(studio.workspace, studio.secondWorkspace);
  assert.ok(switched.workspaceHistory.includes(oldRoot));
  const otherBootstrap = await request('/api/bootstrap');
  assert.equal(otherBootstrap.workspaceRoot, studio.secondWorkspace);
  assert.equal(otherBootstrap.projects.some(project => project.id === left.id), false);
  assert.equal((await readdir(studio.secondWorkspace)).includes(left.id), false, 'switching must not copy old projects');
  assert.equal(await readFile(path.join(oldProject.workspacePath, 'model.js'), 'utf8'), oldSource);
  await request('/api/bootstrap', { workspace: oldRoot, expected: 409 });
  await request(`/api/projects/${left.id}`, { method: 'PATCH', workspace: oldRoot, body: { name: 'must not rename' }, expected: 409 });
  await request(`/api/projects/${left.id}`, { expected: 404 });
  const secondProject = await studio.create('留在第二空间');
  const secondSource = await readFile(path.join(secondProject.workspacePath, 'model.js'), 'utf8');
  const history = (await request('/api/settings')).workspaceHistory;
  const returned = await request('/api/settings', { method: 'PUT', body: { workspaceRoot: history.find(root => root === oldRoot) } });
  studio.workspace = returned.workspaceRoot;
  assert.equal(studio.workspace, oldRoot);
  const restored = await studio.project(left.id);
  assert.equal(restored.name, oldProject.name);
  assert.equal(restored.headId, oldProject.headId);
  assert.equal(restored.task.status, 'completed');
  assert.deepEqual(restored.messages, oldProject.messages);
  assert.equal(await readFile(path.join(restored.workspacePath, 'model.js'), 'utf8'), oldSource);
  assert.equal(await readFile(path.join(secondProject.workspacePath, 'model.js'), 'utf8'), secondSource);
  assert.ok((await stat(secondProject.workspacePath)).isDirectory());
  await request('/api/settings', { workspace: studio.secondWorkspace, expected: 409 });
  const finalBootstrap = await request('/api/bootstrap');
  assert.equal(finalBootstrap.projects.some(project => project.id === secondProject.id), false);
  assert.deepEqual(finalBootstrap.settings.workspaceHistory.slice(0, 2), [oldRoot, studio.secondWorkspace]);
  noSecrets(finalBootstrap);
  assert.ok(!studio.logs.includes(SAVED_KEY));
  assert.ok(!studio.logs.includes(TEMP_KEY));
  t.diagnostic('URI-encoded Unicode workspace headers reject stale clients; history returns to intact projects without copying.');
});

test('a PATCH accepted in the old workspace rejects its late body after a switch', { timeout: 60000 }, async t => {
  const studio = await isolatedStudio(t);
  const original = studio.bootstrap.projects[0];
  assert.equal(original.id, 'first-project');
  const oldProject = await studio.request(`/api/projects/${original.id}`, { method: 'PATCH', body: { name: '旧空间原名' } });
  const slow = await studio.slowPatch(`/api/projects/${original.id}`, { name: '旧请求不能改任何空间' });
  const switched = await studio.request('/api/settings', { method: 'PUT', body: { workspaceRoot: studio.secondWorkspace } });
  studio.workspace = switched.workspaceRoot;
  const fresh = await studio.project(original.id);
  assert.notEqual(fresh.workspacePath, oldProject.workspacePath);
  const rejected = await slow.finish();
  assert.equal(rejected.status, 409, `Late body should reject instead of applying to the new store: ${JSON.stringify(rejected.data)}`);
  assert.equal((await studio.project(original.id)).name, fresh.name, 'new first-project is unchanged');
  const oldMetadata = JSON.parse(await readFile(path.join(studio.firstWorkspace, original.id, 'project.json'), 'utf8'));
  assert.equal(oldMetadata.name, oldProject.name, 'old first-project is unchanged');
  const returned = await studio.request('/api/settings', { method: 'PUT', body: { workspaceRoot: studio.firstWorkspace } });
  studio.workspace = returned.workspaceRoot;
  assert.equal((await studio.project(original.id)).name, oldProject.name);
});

test('a broken target workspace fails before committing settings or replacing the active store', { timeout: 60000 }, async t => {
  const studio = await isolatedStudio(t);
  const original = studio.bootstrap.projects[0];
  const sourceProject = path.join(studio.firstWorkspace, original.id);
  const brokenRoot = path.join(studio.fixtureRoot, '缺少模型的空间');
  const brokenProject = path.join(brokenRoot, original.id);
  await mkdir(path.join(brokenProject, 'work'), { recursive: true });
  await cp(path.join(sourceProject, 'project.json'), path.join(brokenProject, 'project.json'));
  await cp(path.join(sourceProject, 'versions'), path.join(brokenProject, 'versions'), { recursive: true });
  await assert.rejects(stat(path.join(brokenProject, 'work', 'model.js')), { code: 'ENOENT' });
  const savedBefore = await readFile(studio.settingsPath, 'utf8');
  const failed = await studio.request('/api/settings', { method: 'PUT', body: { workspaceRoot: brokenRoot }, expected: [400, 404, 500] });
  assert.ok(failed.error, 'switch failure is reported');
  assert.equal(await readFile(studio.settingsPath, 'utf8'), savedBefore, 'failed preparation does not commit settings');
  assert.equal((await studio.request('/api/settings')).workspaceRoot, studio.firstWorkspace);
  const bootstrap = await studio.request('/api/bootstrap');
  assert.equal(bootstrap.workspaceRoot, studio.firstWorkspace);
  assert.equal(bootstrap.settings.workspaceRoot, studio.firstWorkspace);
  const readable = await studio.project(original.id);
  assert.equal(readable.name, original.name);
  assert.equal(readable.headId, original.headId);
  assert.equal(readable.workspacePath, original.workspacePath);
  assert.match(await readFile(path.join(readable.workspacePath, 'model.js'), 'utf8'), /export function createModel/);
});
