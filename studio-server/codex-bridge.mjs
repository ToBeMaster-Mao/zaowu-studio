/**
 * Local Codex app-server client (newline-delimited JSON RPC over stdio).
 * Uses the user's existing CLI login. Never reads/copies authentication files.
 * Protocol checked against codex-cli 0.162.0-alpha.2 generated JSON schemas.
 *
 * new CodexBridge({workspaceRoot, codexBin?, requestTimeoutMs?})
 * connect() -> {connected, version?, account?, models, error?}
 * run({cwd, prompt, images?: absolutePaths[], threadId?, model?}) -> {threadId, turnId}
 * interrupt() -> {interrupted:boolean}; respondApproval(requestId, decision) -> {ok:true}
 * close() -> Promise<void>. A closed bridge may be connected again.
 *
 * All UI messages are emitted on 'event' (never EventEmitter's reserved 'error'):
 * - status:   {type, status:'connecting'|'connected'|'running'|'interrupting'|'disconnected', message}
 * - text:     {type, text, delta:boolean, itemId?, threadId?, turnId?, phase?}
 *             delta:true appends; delta:false replaces the item's final text.
 * - tool:     {type, name, status, summary, itemId?, threadId?, turnId?, paths?, exitCode?}
 * - approval: {type, requestId:string, kind:'command'|'file', reason, command?, cwd?,
 *              paths?, grantRoot?, itemId?, threadId?, turnId?, decisions:['accept','decline','cancel']}
 * - complete: {type, status:'completed'|'failed'|'interrupted', threadId, turnId, message?}
 * - error:    {type, message, threadId?, turnId?}
 * Account/model metadata is whitelisted; stderr is bounded and never sent to the UI.
 * A caller must bind its HTTP server to loopback and authenticate browser requests.
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_FRAME = 16 * 1024 * 1024;
const text = (value, limit = 12000) => typeof value === 'string' ? value.slice(0, limit) : '';
const safeText = (value, limit = 12000) => text(value, limit)
  .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted]')
  .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
  .replace(/((?:access_token|refresh_token|api_key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[redacted]');
const errorMessage = error => safeText(error?.message || String(error), 2000);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const context = params => ({
  ...(params?.threadId ? { threadId: params.threadId } : {}),
  ...(params?.turnId ? { turnId: params.turnId } : {}),
  ...(params?.itemId ? { itemId: params.itemId } : {}),
});

export class CodexBridge extends EventEmitter {
  constructor({ workspaceRoot = process.cwd(), codexBin = process.env.CODEX_BIN || 'codex', requestTimeoutMs = 30000, spawnProcess = spawn } = {}) {
    super();
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.codexBin = codexBin;
    this.requestTimeoutMs = requestTimeoutMs;
    this._spawn = spawnProcess;
    this._child = null;
    this._pending = new Map();
    this._approvals = new Map();
    this._threads = new Map();
    this._completed = new Set();
    this._items = new Map();
    this._nextId = 1;
    this._connection = null;
    this._starting = false;
    this._active = null;
    this._connectPromise = null;
    this._closePromise = null;
    this._stderr = '';
    this._closing = false;
  }

  get connected() { return Boolean(this._connection?.connected && this._child); }
  get busy() { return this._starting || Boolean(this._active); }

  _emit(event) { this.emit('event', { ...event, timestamp: new Date().toISOString() }); }
  _status(status, message) { this._emit({ type: 'status', status, message }); }

  async connect() {
    if (this._closePromise) await this._closePromise;
    if (this.connected) return this._connection;
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._connect();
    try { return await this._connectPromise; }
    finally { this._connectPromise = null; }
  }

  async _connect() {
    this._closing = false;
    this._status('connecting', '正在连接本地 Codex CLI');
    try {
      this.workspaceRoot = await realpath(this.workspaceRoot);
      this._stderr = '';
      const child = this._spawn(this.codexBin, [
        'app-server', '--listen', 'stdio://',
        '-c', 'sandbox_mode="workspace-write"',
        '-c', 'approval_policy="on-request"',
      ], { cwd: this.workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
      this._child = child;
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { this._stderr = (this._stderr + safeText(chunk, 8192)).slice(-8192); });
      child.stdout.on('data', chunk => {
        if (this._child !== child) return;
        buffer += chunk;
        if (buffer.length > MAX_FRAME) {
          this._lost(child, new Error('Codex 返回的数据过大，连接已关闭'));
          child.kill();
          return;
        }
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let message;
          try {
            message = JSON.parse(line);
            if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid frame');
          }
          catch {
            this._lost(child, new Error('Codex 返回了无效的协议消息'));
            child.kill();
            return;
          }
          this._receive(message);
        }
      });
      child.on('error', error => this._lost(child, new Error(error.code === 'ENOENT'
        ? '未找到 Codex CLI。请安装 Codex 并运行 codex login，或通过 CODEX_BIN 指定可执行文件。'
        : `Codex 进程启动失败：${errorMessage(error)}`)));
      child.on('exit', (code, signal) => this._lost(child, new Error(`Codex 连接已关闭（${signal || code || 0}）`)));
      child.stdin.on('error', error => this._lost(child, new Error(`Codex 输入连接已关闭：${errorMessage(error)}`)));
      const initialized = await this._request('initialize', {
        clientInfo: { name: 'form_studio', title: 'FORM Studio', version: '0.1.0' },
      });
      this._write({ method: 'initialized' });
      const [accountResult, modelResult] = await Promise.allSettled([
        this._request('account/read', { refreshToken: false }),
        this._readModels(),
      ]);
      if (this._child !== child) throw new Error('Codex 在初始化期间断开连接');
      const rawAccount = accountResult.status === 'fulfilled' ? accountResult.value.account : null;
      const account = rawAccount ? {
        type: text(rawAccount.type, 50),
        ...(rawAccount.email ? { email: text(rawAccount.email, 254) } : {}),
        ...(rawAccount.planType ? { planType: text(rawAccount.planType, 50) } : {}),
      } : null;
      const version = text(initialized.userAgent, 200);
      const metadataErrors = [accountResult, modelResult].filter(result => result.status === 'rejected').map(result => errorMessage(result.reason));
      this._connection = {
        connected: true, version, account,
        models: modelResult.status === 'fulfilled' ? modelResult.value : [],
        ...(accountResult.status === 'fulfilled' ? { requiresOpenaiAuth: Boolean(accountResult.value.requiresOpenaiAuth) } : {}),
        ...(metadataErrors.length ? { error: metadataErrors.join('；') } : {}),
      };
      this._status('connected', '本地 Codex 已连接');
      return this._connection;
    } catch (error) {
      const message = errorMessage(error);
      await this.close();
      this._connection = { connected: false, models: [], error: message };
      this._emit({ type: 'error', message });
      return this._connection;
    }
  }

  async _readModels() {
    const models = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await this._request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const model of result.data || []) {
        if (model.hidden) continue;
        models.push({
          id: text(model.id, 200), model: text(model.model || model.id, 200),
          displayName: text(model.displayName || model.id, 200),
          description: text(model.description, 1000), isDefault: Boolean(model.isDefault),
          defaultReasoningEffort: text(model.defaultReasoningEffort, 30),
          inputModalities: (model.inputModalities || []).filter(value => typeof value === 'string'),
        });
      }
      if (!result.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    return models;
  }

  async _safePath(value, directory = false) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('工作目录和图片必须使用绝对路径');
    const resolved = await realpath(value);
    const root = await realpath(this.workspaceRoot);
    if (!inside(root, resolved)) throw new Error('只能访问当前工作台项目内的目录和图片');
    const info = await stat(resolved);
    if (directory ? !info.isDirectory() : !info.isFile()) throw new Error(directory ? '工作目录不存在' : '图片文件不存在');
    if (!directory && (!/\.(png|jpe?g|webp|gif)$/i.test(resolved) || info.size > 30 * 1024 * 1024)) {
      throw new Error('参考图片须为 PNG、JPEG、WebP 或 GIF，且不超过 30 MB');
    }
    return resolved;
  }

  async run({ cwd = this.workspaceRoot, prompt, images = [], threadId, model } = {}) {
    if (this.busy) throw new Error('当前任务尚未结束，请等待或先停止任务');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000) throw new Error('请输入有效的建模要求（不超过 200000 字符）');
    if (!Array.isArray(images) || images.length > 17) throw new Error('每次最多附加 16 张用户图片和 1 张当前视图');
    if (threadId !== undefined && (typeof threadId !== 'string' || !threadId || threadId.length > 200)) throw new Error('无效的对话标识');
    if (model !== undefined && (typeof model !== 'string' || !model || model.length > 200)) throw new Error('无效的模型名称');
    this._starting = true;
    try {
      cwd = await this._safePath(cwd, true);
      const imagePaths = await Promise.all(images.map(image => this._safePath(image)));
      if (imagePaths.some(image => !inside(cwd, image))) throw new Error('图片必须属于当前项目工作目录，不能读取其他项目的图片');
      const connection = await this.connect();
      if (!connection.connected) throw new Error(connection.error || 'Codex 尚未连接');
      const params = { cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', ...(model ? { model } : {}) };
      if (threadId && !this._threads.has(threadId)) {
        // A persisted ID is accepted only for a thread already belonging to this workspace.
        const existing = await this._request('thread/read', { threadId, includeTurns: false });
        const previousCwd = await this._safePath(existing.thread?.cwd, true);
        if (path.relative(previousCwd, cwd) !== '') throw new Error('这个对话属于另一个项目，请新建对话');
      }
      if (threadId && this._threads.has(threadId) && path.relative(this._threads.get(threadId), cwd) !== '') {
        throw new Error('不能在同一对话中切换项目目录');
      }
      const session = await this._request(threadId ? 'thread/resume' : 'thread/start', {
        ...params, ...(threadId ? { threadId } : {}),
      });
      threadId = session.thread?.id;
      if (!threadId) throw new Error('Codex 没有返回对话标识');
      this._threads.set(threadId, cwd);
      this._active = { threadId, turnId: null };
      this._items.clear();
      this._status('running', 'Codex 正在处理建模任务');
      const result = await this._request('turn/start', {
        threadId, cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false },
        input: [{ type: 'text', text: prompt }, ...imagePaths.map(image => ({ type: 'localImage', path: image }))],
        ...(model ? { model } : {}),
      });
      const turnId = result.turn?.id;
      if (!turnId) throw new Error('Codex 没有返回任务标识');
      // Notifications may finish a very short turn before the request response.
      if (!this._completed.has(turnId)) this._active = { threadId, turnId };
      return { threadId, turnId };
    } catch (error) {
      this._active = null;
      this._emit({ type: 'error', message: errorMessage(error) });
      throw error;
    } finally { this._starting = false; }
  }

  async interrupt() {
    const active = this._active;
    if (!active?.turnId) {
      if (this._starting) throw new Error('任务仍在启动，请稍后再停止');
      return { interrupted: false };
    }
    this._status('interrupting', '正在停止当前任务');
    for (const [id, approval] of this._approvals) {
      if (approval.turnId === active.turnId) await this.respondApproval(id, 'cancel');
    }
    await this._request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId });
    return { interrupted: true };
  }

  async respondApproval(requestId, decision) {
    if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('无效的审批决定');
    const key = String(requestId);
    const approval = this._approvals.get(key);
    if (!approval) throw new Error('审批请求已失效');
    this._write({ id: approval.id, result: { decision } });
    this._approvals.delete(key);
    return { ok: true };
  }

  _request(method, params) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        // An expired start request could still execute. Close the child before allowing another turn.
        if (method === 'turn/start' || method === 'thread/start' || method === 'thread/resume') void this.close();
        reject(new Error(`Codex 请求超时：${method}`));
      }, this.requestTimeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try { this._write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this._pending.delete(id); reject(error); }
    });
  }

  _write(message) {
    if (!this._child || this._child.stdin.destroyed || !this._child.stdin.writable) throw new Error('Codex 连接不可用');
    this._child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _receive(message) {
    if (Object.hasOwn(message, 'id') && !message.method) {
      const request = this._pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this._pending.delete(message.id);
      if (message.error) request.reject(new Error(safeText(message.error.message || 'Codex 请求失败', 2000)));
      else request.resolve(message.result || {});
      return;
    }
    const { method, params = {} } = message;
    if (Object.hasOwn(message, 'id') && method) return this._serverRequest(message);
    if (params.threadId && params.threadId !== this._active?.threadId) return;
    const incomingTurnId = params.turnId || params.turn?.id;
    if (incomingTurnId && this._active?.turnId && incomingTurnId !== this._active.turnId) return;
    if (method === 'turn/started') {
      if (this._active) this._active.turnId = params.turn?.id;
    } else if (method === 'item/agentMessage/delta') {
      this._emit({ type: 'text', ...context(params), text: safeText(params.delta, 100000), delta: true });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = params.item || {};
      this._items.set(item.id, item);
      if (item.type === 'agentMessage' && method === 'item/completed') {
        this._emit({ type: 'text', ...context(params), itemId: item.id, text: safeText(item.text, 200000), delta: false, phase: item.phase || 'final_answer' });
      } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'dynamicToolCall'].includes(item.type)) {
        const paths = (item.changes || []).map(change => text(change.path, 2000));
        this._emit({
          type: 'tool', ...context(params), itemId: item.id,
          name: item.type === 'mcpToolCall' ? `${text(item.server, 100)}/${text(item.tool, 100)}` : item.type,
          status: item.status || (method === 'item/started' ? 'inProgress' : 'completed'),
          summary: safeText(item.command || item.query || item.tool || paths.join(', ') || item.type, 2000),
          ...(paths.length ? { paths } : {}), ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
        });
      }
    } else if (method === 'turn/completed') {
      const turn = params.turn || {};
      const status = ['completed', 'failed', 'interrupted'].includes(turn.status) ? turn.status : 'failed';
      this._completed.add(turn.id);
      if (this._completed.size > 100) this._completed.delete(this._completed.values().next().value);
      if (this._active?.threadId === params.threadId) this._active = null;
      for (const [id, approval] of this._approvals) if (approval.turnId === turn.id) this._approvals.delete(id);
      this._emit({ type: 'complete', status, threadId: params.threadId, turnId: turn.id, ...(turn.error ? { message: safeText(turn.error.message, 2000) } : {}) });
    } else if (method === 'error') {
      this._emit({ type: 'error', ...context(params), message: safeText(params.error?.message || params.message || 'Codex 运行出错', 2000) });
    }
  }

  _serverRequest({ id, method, params = {} }) {
    const kind = method === 'item/commandExecution/requestApproval' ? 'command' : method === 'item/fileChange/requestApproval' ? 'file' : null;
    if (!kind) {
      this._write({ id, error: { code: -32601, message: 'This client does not support this server request.' } });
      this._emit({ type: 'error', ...context(params), message: `当前工作台不支持这个交互请求：${text(method, 200)}` });
      return;
    }
    if (!this._active || params.threadId !== this._active.threadId || (this._active.turnId && params.turnId !== this._active.turnId)) {
      this._write({ id, result: { decision: 'cancel' } });
      return;
    }
    this._approvals.set(String(id), { id, ...context(params) });
    const item = this._items.get(params.itemId);
    this._emit({
      type: 'approval', requestId: String(id), kind, ...context(params),
      reason: safeText(params.reason || (kind === 'command' ? 'Codex 请求执行需要许可的命令' : 'Codex 请求修改受保护的文件'), 2000),
      ...(params.command ? { command: safeText(params.command) } : {}),
      ...(params.cwd ? { cwd: text(params.cwd, 2000) } : {}),
      ...(params.grantRoot ? { grantRoot: text(params.grantRoot, 2000) } : {}),
      ...(item?.changes ? { paths: item.changes.map(change => text(change.path, 2000)) } : {}),
      decisions: ['accept', 'decline', 'cancel'],
    });
  }

  _lost(child, error) {
    if (this._child !== child) return;
    this._child = null;
    if (this._connection) this._connection.connected = false;
    for (const pending of this._pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this._pending.clear();
    this._approvals.clear();
    if (this._active) this._emit({ type: 'complete', ...this._active, status: this._closing ? 'interrupted' : 'failed', message: errorMessage(error) });
    this._active = null;
    this._status('disconnected', this._closing ? '本地 Codex 已断开' : errorMessage(error));
  }

  async close() {
    if (this._closePromise) return this._closePromise;
    this._closePromise = this._close();
    try { await this._closePromise; }
    finally { this._closePromise = null; }
  }

  async _close() {
    this._closing = true;
    const child = this._child;
    if (!child) return;
    this._lost(child, new Error('Codex 连接已关闭'));
    await new Promise(resolve => {
      let finished = false;
      let timer;
      const done = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(); };
      child.once('exit', done);
      child.once('error', done);
      timer = setTimeout(() => { child.kill(); done(); }, 1000);
      try { child.stdin.end(); }
      catch { child.kill(); done(); }
      if (child.exitCode !== null && child.exitCode !== undefined) done();
    });
  }
}

export default CodexBridge;
