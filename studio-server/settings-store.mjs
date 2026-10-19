import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const API_PROVIDER_IDS = Object.freeze(['openai', 'deepseek', 'gemini', 'grok']);
export const PROVIDER_IDS = Object.freeze(['codex', ...API_PROVIDER_IDS]);
const BASE_URLS = Object.freeze({
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  grok: 'https://api.x.ai/v1',
});
const TOP_FIELDS = new Set(['workspaceRoot', 'codexConcurrency', 'apiConcurrency', 'defaultProvider', 'providers']);
const PROVIDER_FIELDS = new Set(['baseUrl', 'model', 'supportsImages', 'apiKey', 'clearApiKey']);
const MAX_FILE_BYTES = 1024 * 1024;
const execute = promisify(execFile);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, statusCode: status }); };
const isObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const historyOf = paths => [...new Map(paths.map(value => [pathKey(value), value])).values()];

async function restrictFile(file) {
  if (process.platform !== 'win32') { await fs.chmod(file, 0o600); return; }
  // chmod only controls the read-only flag on Windows. Replace the DACL instead;
  // pass the user-selected path through an environment variable, never as code.
  const script = `$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($identity)
$acl.SetAccessRuleProtection($true, $false)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($env:ZAOWU_SETTINGS_FILE, $acl)`;
  try {
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000, maxBuffer: 4096, env: { ...process.env, ZAOWU_SETTINGS_FILE: file } });
  } catch { fail('无法限制设置文件权限，未保存新的密钥。', 500); }
}

function fields(value, allowed, message) {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.has(key))) fail(message);
}

function localPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('工作空间与设置文件必须使用有效的本地绝对路径。');
  }
  value = value.trim();
  if (!path.isAbsolute(value) || /^[\\/]{2}/.test(value)
      || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(value))) {
    fail('工作空间与设置文件必须使用本地绝对路径，不支持网络共享目录。');
  }
  return path.resolve(value);
}

function shortText(value, limit, message) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/.test(value.trim())) fail(message);
  return value.trim();
}

function baseUrl(value) {
  value = shortText(value, 2048, 'API 地址格式无效。');
  let url;
  try { url = new URL(value); } catch { fail('API 地址格式无效。'); }
  if (!value || /[\\?#]/.test(value) || url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    fail('API 地址须使用 HTTPS（本机可用 HTTP），且不能包含凭据、查询参数或片段。');
  }
  return url.href.replace(/\/+$/, '');
}

function providerPatch(current, patch, persisted = false) {
  fields(patch, PROVIDER_FIELDS, '模型服务配置包含无效字段。');
  if (persisted && Object.hasOwn(patch, 'clearApiKey')) fail('保存的模型服务配置无效。');
  const next = { ...current };
  if (Object.hasOwn(patch, 'baseUrl')) next.baseUrl = baseUrl(patch.baseUrl);
  if (Object.hasOwn(patch, 'model')) next.model = shortText(patch.model, 200, '模型名称须为不超过 200 字的单行文字。');
  if (Object.hasOwn(patch, 'supportsImages')) {
    if (typeof patch.supportsImages !== 'boolean') fail('图片支持选项必须为布尔值。');
    next.supportsImages = patch.supportsImages;
  }
  if (Object.hasOwn(patch, 'clearApiKey') && typeof patch.clearApiKey !== 'boolean') fail('清除密钥选项必须为布尔值。');
  let suppliedKey = '';
  if (Object.hasOwn(patch, 'apiKey')) suppliedKey = shortText(patch.apiKey, 16384, 'API 密钥格式无效。');
  if (patch.clearApiKey && suppliedKey) fail('不能同时清除并设置 API 密钥。');
  if (patch.clearApiKey) next.apiKey = '';
  else if (suppliedKey || (persisted && Object.hasOwn(patch, 'apiKey'))) next.apiKey = suppliedKey;
  return next;
}

function defaults(workspaceRoot) {
  return {
    workspaceRoot, workspaceHistory: [workspaceRoot], codexConcurrency: 1, apiConcurrency: 1,
    defaultProvider: 'codex',
    providers: Object.fromEntries(API_PROVIDER_IDS.map(id => [id, { baseUrl: BASE_URLS[id], model: '', supportsImages: true, apiKey: '' }])),
  };
}

function mergeSettings(current, patch, persisted = false) {
  fields(patch, persisted ? new Set([...TOP_FIELDS, 'version', 'workspaceHistory']) : TOP_FIELDS, '设置包含无效字段。');
  if (persisted && Object.hasOwn(patch, 'version') && patch.version !== 1) fail('不支持此设置文件版本。');
  const next = structuredClone(current);
  if (Object.hasOwn(patch, 'workspaceRoot')) next.workspaceRoot = localPath(patch.workspaceRoot);
  for (const key of ['codexConcurrency', 'apiConcurrency']) {
    if (Object.hasOwn(patch, key)) {
      if (!Number.isInteger(patch[key]) || patch[key] < 1 || patch[key] > 8) fail('任务并发数必须为 1 到 8 的整数。');
      next[key] = patch[key];
    }
  }
  if (Object.hasOwn(patch, 'defaultProvider')) {
    if (!PROVIDER_IDS.includes(patch.defaultProvider)) fail('不支持的默认模型服务。');
    next.defaultProvider = patch.defaultProvider;
  }
  if (Object.hasOwn(patch, 'providers')) {
    fields(patch.providers, new Set(API_PROVIDER_IDS), '不支持的模型服务配置。');
    for (const id of Object.keys(patch.providers)) next.providers[id] = providerPatch(next.providers[id], patch.providers[id], persisted);
  }
  if (persisted && Object.hasOwn(patch, 'workspaceHistory')) {
    if (!Array.isArray(patch.workspaceHistory)) fail('工作空间历史格式无效。');
    next.workspaceHistory = patch.workspaceHistory.map(localPath);
  }
  next.workspaceHistory = historyOf([next.workspaceRoot, ...next.workspaceHistory]);
  return next;
}

/** Local settings contain secrets. Only publicSettings()/update() results may go to the browser. */
export class SettingsStore {
  #settings = null;
  #initializing = null;
  #queue = Promise.resolve();
  #defaultWorkspaceRoot;

  constructor({ file, defaultWorkspaceRoot } = {}) {
    this.file = localPath(file);
    this.#defaultWorkspaceRoot = localPath(defaultWorkspaceRoot);
  }

  async init() {
    if (!this.#initializing) this.#initializing = this.#initialize();
    return this.#initializing;
  }

  async #initialize() {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.file = path.join(await fs.realpath(path.dirname(this.file)), path.basename(this.file));
    let saved = null;
    try {
      await this.#checkFile();
      const raw = await fs.readFile(this.file, 'utf8');
      try { saved = JSON.parse(raw); }
      catch { fail('设置文件 JSON 损坏；原文件已保留，请修复后重启。', 500); }
      if (!isObject(saved)) fail('设置文件格式无效；原文件已保留，请修复后重启。', 500);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let next;
    try { next = mergeSettings(defaults(this.#defaultWorkspaceRoot), saved || {}, true); }
    catch { fail('设置文件内容无效；原文件已保留，请修复后重启。', 500); }
    next.workspaceRoot = await this.#workspace(next.workspaceRoot);
    next.workspaceHistory = historyOf([next.workspaceRoot, ...next.workspaceHistory]);
    if (saved === null) await this.#persist(next);
    else await restrictFile(this.file);
    this.#settings = next;
    return this;
  }

  async #checkFile() {
    const info = await fs.lstat(this.file);
    if (info.isSymbolicLink() || !info.isFile()) fail('设置文件必须为普通文件，不能使用符号链接。', 403);
    if (info.size > MAX_FILE_BYTES) fail('设置文件过大；原文件已保留。', 500);
  }

  async #workspace(value) {
    const root = localPath(value);
    if (inside(root, this.file)) fail('设置文件不能位于工作空间内，请选择独立的项目目录。');
    await fs.mkdir(root, { recursive: true });
    const actual = localPath(await fs.realpath(root));
    if (!(await fs.stat(actual)).isDirectory()) fail('工作空间必须是目录。');
    if (inside(actual, this.file)) fail('设置文件不能位于工作空间内，包括符号链接指向的目录。');
    return actual;
  }

  async #persist(settings) {
    try { await this.#checkFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const serialized = JSON.stringify({ version: 1, ...settings }, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) fail('设置内容超过保存限制。');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await restrictFile(temporary);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, this.file);
    } finally {
      await handle?.close();
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  publicSettings() {
    if (!this.#settings) throw new Error('设置尚未初始化。');
    return this.#publicSnapshot(this.#settings);
  }

  #publicSnapshot(value) {
    const { providers, ...settings } = value;
    return {
      ...structuredClone(settings),
      providers: Object.fromEntries(API_PROVIDER_IDS.map(id => {
        const { apiKey, ...provider } = providers[id];
        return [id, { ...provider, hasApiKey: Boolean(apiKey) }];
      })),
    };
  }

  async preview(patch) {
    await this.init();
    const input = structuredClone(patch);
    const operation = this.#queue.catch(() => {}).then(async () => {
      const next = mergeSettings(this.#settings, input);
      next.workspaceRoot = await this.#workspace(next.workspaceRoot);
      next.workspaceHistory = historyOf([next.workspaceRoot, ...next.workspaceHistory]);
      return this.#publicSnapshot(next);
    });
    this.#queue = operation;
    return operation;
  }

  async update(patch) {
    await this.init();
    // Copy before queueing so callers cannot alter a pending request during awaited I/O.
    const input = structuredClone(patch);
    const operation = this.#queue.catch(() => {}).then(async () => {
      const next = mergeSettings(this.#settings, input);
      next.workspaceRoot = await this.#workspace(next.workspaceRoot);
      next.workspaceHistory = historyOf([next.workspaceRoot, ...next.workspaceHistory]);
      await this.#persist(next);
      this.#settings = next;
      return this.publicSettings();
    });
    this.#queue = operation;
    return operation;
  }

  /** Backend only: contains the real key. Overrides are validated, temporary, and never saved. */
  getProvider(id, overrides = {}) {
    if (!this.#settings) throw new Error('设置尚未初始化。');
    if (!PROVIDER_IDS.includes(id)) fail('不支持的模型服务。');
    if (id === 'codex') {
      fields(overrides, new Set(['model', 'supportsImages']), 'Codex 仅支持模型和图片选项覆盖。');
      return { id, ...providerPatch({ baseUrl: '', model: '', supportsImages: true, apiKey: '' }, overrides) };
    }
    return { id, ...providerPatch(this.#settings.providers[id], overrides) };
  }
}
