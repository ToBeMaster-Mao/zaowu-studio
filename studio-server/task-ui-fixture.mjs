/**
 * Browser-only interaction fixture. Run: node studio-server/task-ui-fixture.mjs
 * All project state and uploaded images live in memory. This file never imports
 * CodexBridge/ProjectStore, launches a process, or reads/writes .studio.
 */
import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_LIMITS, prepareTaskRequest } from './task-contract.mjs';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4176;
const origin = `http://127.0.0.1:${port}`;
const token = 'fixture-test';
const modelDelayMs = Math.max(0, Math.min(30000, Number(process.env.STUDIO_FIXTURE_MODEL_DELAY_MS) || 0));
const now = () => new Date().toISOString();
const clients = new Set();
const projects = new Map();
const images = new Map();
const requests = [];
const approvals = new Map();
const bridge = { connected: true, status: 'connected', account: { type: 'fixture' }, models: [{ id: 'fixture-only', model: 'fixture-only', displayName: '交互测试模型（不调用 Codex）' }] };
let active = null;

function createProject(name = '交互测试 · 临时场景') {
  const id = `fixture-${projects.size + 1}`;
  const headId = `${id}-v1`;
  const project = {
    id, name, updatedAt: now(), workspacePath: '交互测试 / 仅内存 / 不保存到本地项目',
    headId, pendingRevisionId: null, overrides: {}, references: [], messages: [],
    versions: [{ id: headId, label: '浅色陶瓷杯 · 初始版本', createdAt: now(), status: 'valid', isHead: true, overrides: {} }],
    task: null, threadId: null,
  };
  projects.set(id, project);
  return project;
}

const initial = createProject();
initial.versions[0].createdAt = new Date(Date.now() - 60000).toISOString();
initial.versions[0].isHead = false;
initial.headId = `${initial.id}-v2`;
initial.overrides = { '/Cup_Body': { color: '#517fc2' }, '/Cup_Handle': { color: '#517fc2' } };
initial.versions.push({ id: initial.headId, label: '蓝色釉面杯 · 调整材质', createdAt: now(), status: 'valid', isHead: true, overrides: structuredClone(initial.overrides) });
const initialReference = { id: 'fixture-reference', name: '交互测试参考图.png', type: 'image/png' };
initial.references.push(initialReference);
// Synthetic one-pixel test image; the fixture never reads a contributor's photo.
images.set(initialReference.id, { buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'), type: 'image/png' });

function decorate(project) {
  const preview = project.versions.find(version => version.id === project.pendingRevisionId);
  return {
    ...project,
    overrides: structuredClone(preview?.overrides || project.overrides),
    versions: project.versions.map(({ overrides, ...metadata }) => metadata),
    modelUrl: `/artifacts/${project.id}/model.js?version=${project.pendingRevisionId || project.headId}&access=fixture-test`,
    references: project.references.map(ref => ({ id: ref.id, name: ref.name, url: `/artifacts/${project.id}/references/${ref.id}?access=fixture-test` })),
    messages: project.messages.map(message => ({
      ...message,
      ...(message.attachments ? { attachments: message.attachments.map((attachment, index) => ({
        id: attachment.referenceId, referenceId: attachment.referenceId,
        name: attachment.name, type: attachment.type, imageIndex: attachment.imageIndex || index + 1,
        url: `/artifacts/${project.id}/messages/${message.id}/attachments/${attachment.referenceId}?access=fixture-test`,
      })) } : {}),
    })),
  };
}

function emit(data) {
  const frame = `event: studio\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    if (client.destroyed) clients.delete(client);
    else client.write(frame);
  }
}

function publish(project, type = 'project') {
  project.updatedAt = now();
  emit({ type, projectId: project.id, project: decorate(project) });
}

function taskEvent(run) {
  run.project.task = run.task;
  emit({ type: 'task', projectId: run.project.id, task: run.task });
}

function agentEvent(run, event) {
  emit({ type: 'agent', projectId: run.project.id, event });
}

function approvalSnapshot(projectId) {
  return [...approvals.values()]
    .filter(item => !projectId || item.run.project.id === projectId)
    .map(item => ({ ...item.approval, projectId: item.run.project.id }));
}

function publishApprovals(projectId) {
  emit({ type: 'approvals', projectId, approvals: approvalSnapshot(projectId) });
}

function clearApprovals(projectId) {
  for (const [id, item] of approvals) if (item.run.project.id === projectId) approvals.delete(id);
  publishApprovals(projectId);
}

function later(run, milliseconds, callback) {
  const timer = setTimeout(() => {
    run.timers.delete(timer);
    if (active === run) callback();
  }, milliseconds);
  run.timers.add(timer);
}

function clearTimers(run) {
  for (const timer of run.timers) clearTimeout(timer);
  run.timers.clear();
}

function finish(run, status, error = null) {
  clearTimers(run);
  clearApprovals(run.project.id);
  run.task = { ...run.task, status, completedAt: now(), error };
  taskEvent(run);
  agentEvent(run, { type: 'complete', status, ...(error ? { message: error } : {}) });
  if (run.output) run.project.messages.push({ id: randomUUID(), role: 'assistant', text: run.output, createdAt: now() });
  publish(run.project);
  active = null;
}

function validateModel(run) {
  clearTimers(run);
  const project = run.project;
  const revisionId = `${project.id}-v${project.versions.length + 1}`;
  project.pendingRevisionId = revisionId;
  const overrides = { ...structuredClone(project.overrides), '/Cup_Body': { color: '#d5ae89' }, '/Cup_Handle': { color: '#d5ae89' } };
  project.versions.push({ id: revisionId, label: '暖陶色杯子 · 新建版本', status: 'pending', isHead: false, createdAt: now(), overrides });
  run.output = '杯子的主体、杯口和把手已完成，正在等待平台加载并校验新版本。';
  run.task = { ...run.task, status: 'validating', agentStatus: 'completed', modelRevisionId: revisionId, modelChanged: true, output: run.output, agentCompletedAt: now() };
  taskEvent(run);
  publish(project, 'model');
}

function startTask(project, data) {
  if (active) throw Object.assign(new Error('临时场景已有任务，请先停止或等待结束。'), { status: 409 });
  const request = prepareTaskRequest(project, data);
  const task = { id: randomUUID(), intent: request.intent, prompt: request.prompt, userPrompt: request.userPrompt, referenceIds: request.referenceIds, imageGroups: request.imageGroups, attachmentReferenceIds: request.allReferenceIds, status: 'starting', startedAt: now(), output: '', error: null };
  const run = { project, task, output: '', timers: new Set() };
  active = run;
  project.messages.push({
    id: randomUUID(), role: 'user', text: request.prompt, createdAt: task.startedAt,
    referenceIds: [...request.referenceIds], imageGroups: structuredClone(request.imageGroups),
    attachments: request.references.map((reference, index) => ({ ...reference, referenceId: reference.id, imageIndex: index + 1 })),
  });
  taskEvent(run);
  publish(project);
  later(run, 2000, () => {
    run.task = { ...run.task, status: 'running', threadId: `fixture-thread-${project.id}`, turnId: `fixture-turn-${task.id}` };
    taskEvent(run);
    agentEvent(run, { type: 'status', status: 'running', message: '正在观察参考图，规划模型结构。' });
  });
  later(run, 4000, () => {
    if (request.userPrompt.includes('失败测试')) {
      finish(run, 'failed', '这是交互测试：模拟建模失败，可以调整要求后重试。');
      return;
    }
    run.output = '已分析参考图。正在构建杯子的主体和把手，随后会检查材质与结构。';
    agentEvent(run, { type: 'text', itemId: `message-${task.id}`, text: run.output, delta: false });
    agentEvent(run, { type: 'tool', name: 'fileChange', status: 'inProgress', summary: '正在构建杯子的主体与把手', itemId: `tool-${task.id}`, paths: ['model.js'] });
    if (request.userPrompt.includes('确认测试')) {
      const approval = { type: 'approval', requestId: `approval-${task.id}`, kind: 'file', reason: '这是交互测试：确认后继续模拟建模，不会修改任何真实项目。', paths: ['临时内存场景/model.js'] };
      approvals.set(approval.requestId, { run, approval });
      agentEvent(run, approval);
      publishApprovals(project.id);
      return;
    }
    later(run, 16000, () => validateModel(run));
  });
  return { task };
}

function modelSource() {
  const color = 0xe2d9c8;
  return `import * as THREE from 'three';
export function createModel() {
  const root = new THREE.Group(); root.name = '临时杯子';
  const clay = new THREE.MeshStandardMaterial({color:${color},roughness:0.43,metalness:0.02,side:THREE.DoubleSide});
  const profile = [new THREE.Vector2(0,0),new THREE.Vector2(.69,0),new THREE.Vector2(.74,.06),new THREE.Vector2(.84,1.62),new THREE.Vector2(.82,1.69),new THREE.Vector2(.74,1.69),new THREE.Vector2(.67,.14),new THREE.Vector2(0,.14)];
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile,64),clay); body.name='Cup_Body'; root.add(body);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(.47,.11,16,48),clay); handle.name='Cup_Handle'; handle.position.set(.94,.9,0); root.add(handle);
  root.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
  return {root,animations:[]};
}`;
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 20 * 1024 * 1024) throw new Error('测试请求超过 20 MB。');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function staticFile(res, file, extra = {}) {
  const content = await readFile(file);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.zip': 'application/zip' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...extra });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return json(res, { error: 'Fixture is localhost only.' }, 403);
    const url = new URL(req.url, origin);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/__test/requests') return json(res, requests);
    if (pathname === '/__test/state') return json(res, { fixture: true, activeTaskId: active?.task.id || null, projects: [...projects.values()].map(decorate), approvals: approvalSnapshot(), taskCreating: false, requestCount: requests.length });
    if (pathname === '/api/health') return json(res, { ok: true, fixture: true, product: 'model-studio-ui-fixture' });
    if (pathname === '/' || pathname === '/index.html') {
      const html = (await readFile(path.join(base, 'studio-web/index.html'), 'utf8')).replaceAll('__SESSION_TOKEN__', token);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (pathname.startsWith('/studio-web/') || pathname.startsWith('/studio-viewer/') || pathname.startsWith('/node_modules/three/')) {
      const file = await realpath(path.resolve(base, `.${pathname}`));
      if (!file.startsWith(base + path.sep) || pathname.split('/').includes('..')) throw new Error('Invalid static path.');
      return await staticFile(res, file, { 'Access-Control-Allow-Origin': '*' });
    }
    if (pathname === '/downloads/model-studio-skill.zip') return await staticFile(res, path.join(base, 'public-downloads/model-studio-skill.zip'));
    const artifact = /^\/artifacts\/([A-Za-z0-9_-]+)\/(model\.js|references\/([A-Za-z0-9_-]+)|messages\/([A-Za-z0-9_-]+)\/attachments\/([A-Za-z0-9_-]+))$/.exec(pathname);
    if (artifact) {
      if (req.method !== 'GET') return json(res, { error: '临时附件链接仅支持读取。' }, 405);
      if (url.searchParams.get('access') !== token) return json(res, { error: '临时附件链接无效。' }, 403);
      const project = projects.get(artifact[1]);
      if (!project) throw new Error('临时项目不存在。');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (artifact[2] === 'model.js') {
        // Optional delay exercises the real loading UI without a live Agent or project.
        if (modelDelayMs) await new Promise(resolve => setTimeout(resolve, modelDelayMs));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(modelSource(url.searchParams.get('version') || project.headId));
      } else {
        const referenceId = artifact[3] || artifact[5];
        const reference = artifact[3]
          ? project.references.find(ref => ref.id === referenceId)
          : project.messages.find(message => message.id === artifact[4])?.attachments?.find(attachment => attachment.referenceId === referenceId);
        const image = images.get(referenceId);
        if (!image || !reference) throw new Error('测试图片不存在。');
        res.writeHead(200, { 'Content-Type': image.type, 'Cache-Control': 'no-store' });
        res.end(image.buffer);
      }
      return;
    }
    if (!pathname.startsWith('/api/')) return json(res, { error: 'Fixture route not found.' }, 404);
    if (req.headers['x-studio-token'] !== token) return json(res, { error: 'Fixture token required.' }, 401);
    if (pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: studio\ndata: ${JSON.stringify({ type: 'hello', bridge, approvals: approvalSnapshot(), taskCreating: false })}\n\n`);
      clients.add(res);
      const timer = setInterval(() => { if (!res.destroyed) res.write(': fixture heartbeat\n\n'); }, 10000);
      req.on('close', () => { clients.delete(res); clearInterval(timer); });
      return;
    }
    if (pathname === '/api/bootstrap') return json(res, { projects: [...projects.values()].map(decorate), activeProjectId: initial.id, bridge, approvals: approvalSnapshot(), taskCreating: false, skill: { url: '/downloads/model-studio-skill.zip' }, workspaceRoot: '临时内存场景', capabilities: { revisionPreview: true, imageGroups: true, imageLimits: IMAGE_LIMITS } });
    if (pathname === '/api/connect') return json(res, bridge);
    if (pathname === '/api/tasks/stop' && req.method === 'POST') {
      const body = await readJson(req);
      requests.push({ method: req.method, path: pathname, body, receivedAt: now() });
      if (!active) return json(res, { ok: true, interrupted: false });
      const run = active;
      if (body.projectId !== run.project.id || (body.taskId && body.taskId !== run.task.id)) return json(res, { error: '停止目标与测试任务不匹配。' }, 409);
      if (run.task.status === 'starting' || !run.task.turnId) return json(res, { error: '任务仍在启动，启动完成后即可停止。' }, 409);
      clearTimers(run);
      clearApprovals(run.project.id);
      run.task = { ...run.task, status: 'stopping', stopRequestedAt: now() };
      taskEvent(run);
      later(run, 1000, () => finish(run, 'interrupted'));
      return json(res, { ok: true, interrupted: true });
    }
    const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(pathname);
    if (approvalMatch && req.method === 'POST') {
      const body = await readJson(req);
      const item = approvals.get(approvalMatch[1]);
      if (!item) throw new Error('测试确认已结束。');
      approvals.delete(approvalMatch[1]);
      publishApprovals(item.run.project.id);
      if (body.decision === 'accept') {
        agentEvent(item.run, { type: 'text', itemId: `approved-${item.run.task.id}`, text: '已收到确认，继续构建临时杯子。', delta: false });
        later(item.run, 5000, () => validateModel(item.run));
      } else finish(item.run, 'interrupted');
      return json(res, { ok: true });
    }
    if (pathname === '/api/projects' && req.method === 'POST') {
      const body = await readJson(req);
      return json(res, decorate(createProject(`交互测试 · ${body.name || '临时场景'}`)), 201);
    }
    const route = /^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(pathname);
    if (!route) return json(res, { error: 'Fixture API not found.' }, 404);
    const project = projects.get(route[1]);
    if (!project) throw new Error('临时项目不存在。');
    const action = route[2] || '';
    if (!action && req.method === 'GET') return json(res, decorate(project));
    if (!action && req.method === 'PATCH') { const body = await readJson(req); project.name = `交互测试 · ${body.name}`; return json(res, decorate(project)); }
    if (action === 'references' && req.method === 'POST') {
      if (project.references.length >= IMAGE_LIMITS.projectLibrary) throw new Error('项目最多保存 128 张参考图片，请先移除不需要的图片。');
      const body = await readJson(req);
      const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(body.dataUrl || '');
      if (!match) throw new Error('测试上传需要图片。');
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length > 12 * 1024 * 1024) throw Object.assign(new Error('单张参考图最多 12 MiB。'), { status: 413 });
      const ref = { id: randomUUID(), name: body.name || '测试图片', type: match[1] };
      images.set(ref.id, { buffer, type: ref.type });
      project.references.push(ref);
      return json(res, decorate(project));
    }
    if (action.startsWith('references/') && req.method === 'DELETE') {
      const id = action.slice('references/'.length);
      project.references = project.references.filter(ref => ref.id !== id);
      // Conversation images are immutable snapshots, just like the real store.
      if (!project.messages.some(message => message.attachments?.some(attachment => attachment.referenceId === id))) images.delete(id);
      return json(res, decorate(project));
    }
    if (action === 'tasks' && req.method === 'POST') {
      const body = await readJson(req);
      requests.push({ method: req.method, path: pathname, body, receivedAt: now() });
      return json(res, startTask(project, body), 202);
    }
    if (action === 'validate' && req.method === 'POST') {
      const body = await readJson(req);
      requests.push({ method: req.method, path: pathname, body, receivedAt: now() });
      if (project.pendingRevisionId === body.revisionId) {
        for (const version of project.versions) {
          if (version.id === body.revisionId) version.status = body.valid ? 'valid' : 'invalid';
          version.isHead = body.valid ? version.id === body.revisionId : version.id === project.headId;
        }
        if (body.valid) {
          project.headId = body.revisionId;
          project.overrides = structuredClone(project.versions.find(version => version.id === body.revisionId).overrides);
        }
        project.pendingRevisionId = null;
        if (active?.project === project) finish(active, body.valid ? 'completed' : 'failed', body.valid ? null : body.error || '临时模型未通过预览校验。');
        else publish(project);
      }
      return json(res, decorate(project));
    }
    if (action === 'overrides' && req.method === 'POST') {
      const body = await readJson(req);
      requests.push({ method: req.method, path: pathname, body, receivedAt: now() });
      project.overrides[body.partId] = { ...(project.overrides[body.partId] || {}), ...body.patch };
      return json(res, decorate(project));
    }
    const preview = /^versions\/([A-Za-z0-9_-]+)$/.exec(action);
    if (preview && req.method === 'GET') {
      const version = project.versions.find(item => item.id === preview[1]);
      if (!version) return json(res, { error: '临时版本不存在。' }, 404);
      requests.push({ method: req.method, path: pathname, receivedAt: now() });
      return json(res, {
        id: version.id, label: version.label, createdAt: version.createdAt,
        status: version.status, overrides: structuredClone(version.overrides || {}),
        modelUrl: `/artifacts/${project.id}/model.js?version=${version.id}&access=fixture-test`,
      });
    }
    const restore = /^versions\/([A-Za-z0-9_-]+)\/restore$/.exec(action);
    if (restore && req.method === 'POST') {
      const body = await readJson(req);
      requests.push({ method: req.method, path: pathname, body, receivedAt: now() });
      if (active?.project === project || project.pendingRevisionId) return json(res, { error: '任务处理中，暂时不能恢复版本。' }, 409);
      const version = project.versions.find(item => item.id === restore[1] && item.status === 'valid');
      if (!version) return json(res, { error: '临时版本不存在或尚未通过校验。' }, 404);
      project.headId = version.id; project.pendingRevisionId = null;
      project.overrides = structuredClone(version.overrides || {});
      project.versions.forEach(version => { version.isHead = version.id === project.headId; });
      publish(project, 'model');
      return json(res, decorate(project));
    }
    return json(res, { error: 'This action is not part of the interaction fixture.' }, 404);
  } catch (error) {
    if (!res.headersSent) json(res, { error: error.message }, error.status || (error.code === 'ENOENT' ? 404 : 400));
    else res.end();
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Interaction fixture only: ${origin} | token: fixture-test | all state in memory`));
function shutdown() {
  if (active) clearTimers(active);
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
