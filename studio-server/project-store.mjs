import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { IMAGE_LIMITS } from './task-contract.mjs';

const SAFE_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const MAX_IMAGE = 12 * 1024 * 1024;
const EMPTY_SOURCE = `import * as THREE from 'three';\n\nexport function createModel() {\n  const root = new THREE.Group();\n  root.name = 'My_Model';\n  return { root, animations: [] };\n}\n`;
const now = () => new Date().toISOString();
const fail = (message, statusCode = 400) => { const error = new Error(message); error.statusCode = statusCode; throw error; };
const checkId = value => { if (typeof value !== 'string' || !SAFE_ID.test(value)) fail('无效的项目、版本或参考图标识。'); return value; };
const cleanName = (name, fallback = '未命名项目') => String(name || fallback).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) || fallback;

function imageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function decodeImage(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(MAX_IMAGE * 4 / 3) + 100) fail('参考图不能超过 12 MiB。', 413);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 === 1) fail('仅接受 PNG、JPEG 或 WebP 的 base64 图片。');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE) fail('参考图为空或超过 12 MiB。', 413);
  if (imageType(buffer) !== match[1]) fail('参考图的文件内容与声明格式不一致。');
  return { buffer, type: match[1] };
}

export class ProjectStore {
  constructor({ root, sampleSourcePath, sampleImagePath }) {
    if (!root) throw new Error('ProjectStore requires a root directory.');
    this.root = path.resolve(root);
    this.sampleSourcePath = sampleSourcePath && path.resolve(sampleSourcePath);
    this.sampleImagePath = sampleImagePath && path.resolve(sampleImagePath);
    this.queues = new Map();
    this.initializing = null;
  }

  async init() {
    if (!this.initializing) this.initializing = (async () => {
      await fs.mkdir(this.root, { recursive: true });
      this.root = await fs.realpath(this.root);
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      let hasProject = false;
      for (const entry of entries) {
        if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
        try { await this._read(entry.name); hasProject = true; break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!hasProject) await this._createProject('first-project', '我的第一个模型', 'empty');
      return this;
    })();
    return this.initializing;
  }

  async _safe(...segments) {
    const candidate = path.resolve(this.root, ...segments);
    const relative = path.relative(this.root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('路径不在项目存储目录中。', 403);
    let current = this.root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const info = await fs.lstat(current);
        if (info.isSymbolicLink()) fail('项目路径不允许使用符号链接。', 403);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return candidate;
  }

  async _atomic(file, value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, value, { flag: 'wx' });
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, file); break; }
        catch (error) {
          // A concurrent reader or scanner can briefly prevent replacement on
          // Windows. Retry only the atomic rename, never the project operation.
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
          await delay(25 * 2 ** attempt);
        }
      }
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async _read(id) {
    checkId(id);
    let raw;
    try { raw = await fs.readFile(await this._safe(id, 'project.json'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') error.statusCode = 404; throw error; }
    const data = JSON.parse(raw);
    data.id = id;
    data.overrides ||= {};
    data.references ||= [];
    data.messages ||= [];
    data.versions ||= [];
    return data;
  }

  _summary(project) {
    const previewRevision = project.versions.find(revision => revision.id === project.pendingRevisionId);
    return {
      id: project.id, name: project.name, updatedAt: project.updatedAt,
      workspacePath: path.join(this.root, project.id, 'work'),
      modelUrl: `/artifacts/${project.id}/model.js?version=${project.pendingRevisionId || project.headId || ''}`,
      headId: project.headId || null, pendingRevisionId: project.pendingRevisionId || null,
      overrides: previewRevision?.overrides || project.overrides,
      references: project.references.map(reference => ({ id: reference.id, name: reference.name, url: `/artifacts/${project.id}/references/${reference.id}` })),
      messages: project.messages.map(message => ({
        ...message,
        ...(message.attachments ? { attachments: message.attachments.map((attachment, index) => ({
          id: attachment.referenceId || attachment.id, referenceId: attachment.referenceId || attachment.id,
          name: attachment.name, type: attachment.type, imageIndex: attachment.imageIndex || index + 1,
          url: `/artifacts/${project.id}/messages/${message.id}/attachments/${attachment.referenceId || attachment.id}`,
        })) } : {}),
      })),
      versions: project.versions.map(revision => ({ id: revision.id, label: revision.label, createdAt: revision.createdAt, status: revision.status, isHead: revision.id === project.headId, ...(revision.error ? { error: revision.error } : {}) })),
      task: project.task || null, threadId: project.threadId || null,
    };
  }

  async _save(project) {
    project.updatedAt = now();
    await this._atomic(await this._safe(project.id, 'project.json'), JSON.stringify(project, null, 2));
    return this._summary(project);
  }

  async _mutate(id, operation) {
    await this.init();
    checkId(id);
    const previous = this.queues.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => operation(await this._read(id)));
    this.queues.set(id, current);
    try { return await current; } finally { if (this.queues.get(id) === current) this.queues.delete(id); }
  }

  _assertEditable(project) {
    if (project.pendingRevisionId || ['running', 'starting', 'stopping', 'validating', 'queued'].includes(project.task?.status)) fail('当前任务尚未结束，请等待模型校验完成后再修改。', 409);
  }

  async _seedSource(template) {
    if (template === 'empty') return EMPTY_SOURCE;
    if (template !== 'airliner') fail('不支持的项目模板。');
    if (!this.sampleSourcePath) fail('没有可用的客机示例模板。');
    const source = await fs.readFile(this.sampleSourcePath, 'utf8');
    if (!source.includes('export function createAirliner()')) throw new Error('Sample source must export createAirliner().');
    return `${source.replace('export function createAirliner()', 'function createAirliner()')}\n\nexport function createModel() {\n  const model = createAirliner();\n  return { root: model.aircraft, animations: model.clips };\n}\n`;
  }

  async _createProject(id, name, template) {
    checkId(id);
    const source = await this._seedSource(template);
    const projectDir = await this._safe(id);
    await fs.mkdir(projectDir, { recursive: false });
    await fs.mkdir(await this._safe(id, 'work', 'references'), { recursive: true });
    await fs.mkdir(await this._safe(id, 'versions'), { recursive: true });
    await fs.writeFile(await this._safe(id, 'work', 'model.js'), source);
    await fs.writeFile(await this._safe(id, 'work', 'task-context.json'), '{}\n', { flag: 'wx' });
    const project = { id, name: cleanName(name), createdAt: now(), updatedAt: now(), headId: null, pendingRevisionId: null, overrides: {}, references: [], versions: [], messages: [], task: null, threadId: null };
    if (template === 'airliner' && this.sampleImagePath) {
      try {
        const buffer = await fs.readFile(this.sampleImagePath);
        const type = imageType(buffer);
        if (type && buffer.length <= MAX_IMAGE) await this._storeReference(project, { name: '客机参考图', buffer, type });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await this._capture(project, { label: template === 'airliner' ? '客机示例 · 初始版本' : '空白项目', status: 'valid' });
    return this._save(project);
  }

  async list() {
    await this.init();
    const projects = [];
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      try { projects.push(this._summary(await this._read(entry.name))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id) { await this.init(); if (this.queues.has(id)) await this.queues.get(id).catch(() => {}); return this._summary(await this._read(id)); }
  async getRevision(id, revisionId) {
    await this.init();
    checkId(id);
    checkId(revisionId);
    if (this.queues.has(id)) await this.queues.get(id).catch(() => {});
    const project = await this._read(id);
    const revision = project.versions.find(item => item.id === revisionId);
    if (!revision) fail('找不到此版本。', 404);
    // Return the snapshot's own properties without changing the editable project.
    return {
      id: revision.id, label: revision.label, createdAt: revision.createdAt,
      status: revision.status, overrides: structuredClone(revision.overrides || {}),
    };
  }
  async create({ name, template = 'empty' } = {}) {
    await this.init();
    if (!['empty', 'airliner'].includes(template)) fail('不支持的项目模板。');
    return this._createProject(randomUUID(), name || (template === 'airliner' ? '客机项目' : '未命名项目'), template);
  }
  async rename(id, name) { return this._mutate(id, async project => { this._assertEditable(project); project.name = cleanName(name); return this._save(project); }); }

  async _storeReference(project, { name, buffer, type }) {
    const id = randomUUID(), extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[type];
    const reference = { id, name: cleanName(name, `参考图.${extension}`), type, file: `${id}.${extension}`, createdAt: now() };
    await fs.writeFile(await this._safe(project.id, 'work', 'references', reference.file), buffer, { flag: 'wx' });
    project.references.push(reference);
  }
  async addReference(id, { name, dataUrl }) {
    const decoded = decodeImage(dataUrl);
    return this._mutate(id, async project => {
      this._assertEditable(project);
      if (project.references.length >= IMAGE_LIMITS.projectLibrary) fail('项目最多保存 128 张参考图片，请先移除不需要的图片。', 409);
      await this._storeReference(project, { name, ...decoded }); return this._save(project);
    });
  }
  async removeReference(id, refId) {
    checkId(refId);
    return this._mutate(id, async project => { this._assertEditable(project); project.references = project.references.filter(reference => reference.id !== refId); return this._save(project); });
  }

  async _capture(project, { label, status = 'pending', resetOverrides = false }) {
    if (!['pending', 'valid', 'invalid'].includes(status)) fail('无效的版本状态。');
    const modelPath = await this._safe(project.id, 'work', 'model.js');
    if ((await fs.stat(modelPath)).size > 8 * 1024 * 1024) fail('模型源码超过 8 MiB。', 413);
    const source = await fs.readFile(modelPath);
    const revision = { id: randomUUID(), label: cleanName(label, '模型修改'), createdAt: now(), status, overrides: resetOverrides ? {} : structuredClone(project.overrides) };
    const directory = await this._safe(project.id, 'versions', revision.id);
    await fs.mkdir(directory);
    await fs.writeFile(await this._safe(project.id, 'versions', revision.id, 'model.js'), source, { flag: 'wx' });
    await fs.writeFile(await this._safe(project.id, 'versions', revision.id, 'metadata.json'), JSON.stringify(revision, null, 2), { flag: 'wx' });
    project.versions.push(revision);
    if (status === 'pending') project.pendingRevisionId = revision.id;
    if (status === 'valid') { project.headId = revision.id; project.pendingRevisionId = null; }
    return revision;
  }
  async snapshot(id, options = {}) { return this._mutate(id, async project => { await this._capture(project, options); return this._save(project); }); }

  async setOverrides(id, { partId, patch }) {
    if (typeof partId !== 'string' || !partId || partId.length > 2000 || ['__proto__', 'prototype', 'constructor'].includes(partId)) fail('无效的部件标识。');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('无效的部件属性。');
    const accepted = {};
    if ('visible' in patch) { if (typeof patch.visible !== 'boolean') fail('visible 必须为布尔值。'); accepted.visible = patch.visible; }
    if ('color' in patch) { if (typeof patch.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(patch.color)) fail('颜色必须为 #RRGGBB。'); accepted.color = patch.color; }
    if ('position' in patch) { if (!Array.isArray(patch.position) || patch.position.length !== 3 || !patch.position.every(value => Number.isFinite(value) && Math.abs(value) <= 100000)) fail('无效的部件坐标。'); accepted.position = patch.position; }
    return this._mutate(id, async project => {
      this._assertEditable(project);
      project.overrides[partId] = { ...(project.overrides[partId] || {}), ...accepted };
      await this._capture(project, { label: '调整部件属性', status: 'valid' });
      return this._save(project);
    });
  }

  async validate(id, revisionId, { valid, error } = {}) {
    checkId(revisionId);
    if (typeof valid !== 'boolean') fail('校验结果必须包含 valid 布尔值。');
    return this._mutate(id, async project => {
      const revision = project.versions.find(item => item.id === revisionId);
      if (!revision) fail('找不到此版本。', 404);
      if (revision.status !== 'pending') return this._summary(project);
      revision.status = valid ? 'valid' : 'invalid';
      if (!valid) revision.error = String(error || '模型预览校验未通过。').slice(0, 2000);
      await this._atomic(await this._safe(id, 'versions', revisionId, 'metadata.json'), JSON.stringify(revision, null, 2));
      // A late iframe result must never replace a newer pending edit.
      if (project.pendingRevisionId === revisionId) {
        // A local agent may have saved again while the browser validated this snapshot.
        // Never replace that later source with an older rollback.
        const currentSource = await fs.readFile(await this._safe(id, 'work', 'model.js'));
        const candidateSource = await fs.readFile(await this._safe(id, 'versions', revisionId, 'model.js'));
        const stillCurrent = currentSource.equals(candidateSource);
        project.pendingRevisionId = null;
        if (valid) { project.headId = revisionId; project.overrides = structuredClone(revision.overrides); }
        else if (project.headId) {
          const previous = project.versions.find(item => item.id === project.headId);
          if (stillCurrent) await this._atomic(await this._safe(id, 'work', 'model.js'), await fs.readFile(await this._safe(id, 'versions', project.headId, 'model.js')));
          project.overrides = structuredClone(previous?.overrides || {});
        }
      }
      return this._save(project);
    });
  }

  async restore(id, revisionId) {
    checkId(revisionId);
    return this._mutate(id, async project => {
      this._assertEditable(project);
      const revision = project.versions.find(item => item.id === revisionId);
      if (!revision || revision.status !== 'valid') fail('只能恢复校验通过的版本。', 409);
      await this._atomic(await this._safe(id, 'work', 'model.js'), await fs.readFile(await this._safe(id, 'versions', revisionId, 'model.js')));
      project.overrides = structuredClone(revision.overrides || {});
      project.headId = revisionId;
      project.pendingRevisionId = null;
      return this._save(project);
    });
  }

  async appendMessage(id, message) {
    if (!message || !['user', 'assistant', 'system', 'tool'].includes(message.role) || typeof message.text !== 'string') fail('无效的对话消息。');
    return this._mutate(id, async project => {
      const entry = { ...message, id: message.id || randomUUID(), createdAt: message.createdAt || now() };
      checkId(entry.id);
      if (message.attachments !== undefined) {
        if (!Array.isArray(message.attachments) || message.attachments.length > IMAGE_LIMITS.perTask) fail('对话附件格式无效。');
        const seen = new Set();
        entry.attachments = message.attachments.map((attachment, index) => {
          const referenceId = checkId(attachment?.referenceId || attachment?.id);
          if (seen.has(referenceId)) fail('对话附件不能重复。');
          seen.add(referenceId);
          const reference = project.references.find(item => item.id === referenceId);
          if (!reference) fail('对话附件不属于当前项目或已经移除。', 409);
          // Keep trusted file metadata as a snapshot; deleting a library entry must not erase conversation evidence.
          return { ...reference, referenceId, imageIndex: index + 1 };
        });
      }
      const existing = project.messages.findIndex(item => item.id === entry.id);
      if (existing >= 0) project.messages[existing] = { ...project.messages[existing], ...entry };
      else project.messages.push(entry);
      return this._save(project);
    });
  }
  async updateTask(id, task) { return this._mutate(id, async project => { project.task = task; return this._save(project); }); }
  async setThread(id, threadId) { return this._mutate(id, async project => { project.threadId = threadId || null; return this._save(project); }); }

  async contextPaths(id) {
    await this.init();
    await this._read(id);
    return { projectDir: await this._safe(id), workDir: await this._safe(id, 'work'), modelPath: await this._safe(id, 'work', 'model.js'), referencesDir: await this._safe(id, 'work', 'references'), contextPath: await this._safe(id, 'work', 'task-context.json') };
  }
  async workPath(id, ...segments) {
    await this.init(); await this._read(id);
    return this._safe(id, 'work', ...segments);
  }
  async writeExport(id, binary) {
    await this.init(); await this._read(id);
    if (!Buffer.isBuffer(binary) || binary.length < 20 || binary.length > 64 * 1024 * 1024
      || binary.toString('ascii', 0, 4) !== 'glTF' || binary.readUInt32LE(4) !== 2 || binary.readUInt32LE(8) !== binary.length) fail('导出的 GLB 文件无效。');
    const file = `${randomUUID()}.glb`;
    await fs.mkdir(await this._safe(id, 'exports'), { recursive: true });
    const savedPath = await this._safe(id, 'exports', file);
    await fs.writeFile(savedPath, binary, { flag: 'wx' });
    return { file, savedPath, bytes: binary.length };
  }
  async readExport(id, file) {
    await this.init(); await this._read(id);
    if (typeof file !== 'string' || !/^[a-f0-9-]{36}\.glb$/.test(file)) fail('导出文件标识无效。');
    return fs.readFile(await this._safe(id, 'exports', file));
  }
  async readRevisionSource(id, revisionId) {
    await this.init();
    const project = await this._read(id);
    revisionId ||= project.pendingRevisionId || project.headId;
    checkId(revisionId);
    if (!project.versions.some(revision => revision.id === revisionId)) fail('找不到此版本。', 404);
    return fs.readFile(await this._safe(id, 'versions', revisionId, 'model.js'));
  }
  async readReference(id, refId) {
    await this.init();
    checkId(refId);
    const project = await this._read(id), reference = project.references.find(item => item.id === refId);
    if (!reference) fail('找不到此参考图。', 404);
    return this._readStoredReference(id, reference);
  }
  async readMessageAttachment(id, messageId, refId) {
    await this.init();
    checkId(messageId); checkId(refId);
    const project = await this._read(id);
    const attachment = project.messages.find(message => message.id === messageId)?.attachments?.find(item => (item.referenceId || item.id) === refId);
    if (!attachment) fail('找不到此对话附件。', 404);
    return this._readStoredReference(id, attachment);
  }
  async _readStoredReference(id, reference) {
    if (!/^[a-zA-Z0-9_-]+\.(?:png|jpg|webp)$/.test(reference.file)) fail('参考图路径无效。', 403);
    const referencePath = await this._safe(id, 'work', 'references', reference.file);
    if ((await fs.stat(referencePath)).size > MAX_IMAGE) fail('参考图超过 12 MiB。', 413);
    const buffer = await fs.readFile(referencePath);
    if (imageType(buffer) !== reference.type) fail('参考图的内容格式已经改变。', 409);
    return { buffer, type: reference.type, name: reference.name };
  }
}
