import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexBridge } from './codex-bridge.mjs';

function fakeServer(overrides = {}) {
  const calls = [];
  let child;
  const spawnProcess = (bin, args, options) => {
    child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null); };
    child.stdin.on('finish', () => child.kill());
    child.send = data => child.stdout.write(`${JSON.stringify(data)}\n`);
    child.spawnInfo = { bin, args, options };
    let buffer = '';
    let turn = 0;
    const defaults = {
      initialize: () => ({ userAgent: 'codex-cli/test' }),
      'account/read': () => ({ requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'test@example.com', planType: 'plus', access_token: 'SHOULD_NEVER_LEAK' } }),
      'model/list': () => ({ data: [{ id: 'test-model', displayName: 'Test', isDefault: true }, { id: 'hidden', hidden: true }], nextCursor: null }),
      'thread/start': params => ({ thread: { id: 'thread-1', cwd: params.cwd } }),
      'thread/resume': params => ({ thread: { id: params.threadId, cwd: params.cwd } }),
      'turn/start': () => ({ turn: { id: `turn-${++turn}`, status: 'inProgress' } }),
      'turn/interrupt': params => { queueMicrotask(() => child.send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } } })); return {}; },
    };
    child.stdin.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        calls.push(request);
        if (!request.method || !Object.hasOwn(request, 'id')) continue;
        const handler = overrides[request.method] || defaults[request.method];
        if (!handler) { child.send({ id: request.id, error: { message: 'Unknown method' } }); continue; }
        const result = handler(request.params, child, request);
        if (result !== undefined) queueMicrotask(() => child.send({ id: request.id, result }));
      }
    });
    return child;
  };
  return { spawnProcess, calls, get child() { return child; } };
}

async function fixture(t, overrides = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'form-bridge-test-'));
  const root = await realpath(folder);
  const project = path.join(root, 'project');
  await mkdir(project);
  const server = fakeServer(overrides);
  const bridge = new CodexBridge({ workspaceRoot: root, spawnProcess: server.spawnProcess, requestTimeoutMs: 2000 });
  const events = [];
  bridge.on('event', event => events.push(event));
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  return { root, project, server, bridge, events };
}

test('stdio handshake, safe metadata and sandboxed multimodal turns support resume', async t => {
  const { project, server, bridge, events } = await fixture(t);
  const image = path.join(project, 'reference.png');
  await writeFile(image, 'fixture');
  const connection = await bridge.connect();
  assert.equal(connection.connected, true);
  assert.equal(connection.account.access_token, undefined);
  assert.deepEqual(connection.models.map(model => model.id), ['test-model']);
  assert.equal(server.calls[0].method, 'initialize');
  assert.equal(server.calls[1].method, 'initialized');
  assert.equal(server.child.spawnInfo.options.shell, false);
  assert.ok(server.child.spawnInfo.args.includes('sandbox_mode="workspace-write"'));
  const run = await bridge.run({ cwd: project, prompt: '修改窗户', images: [image] });
  assert.deepEqual(run, { threadId: 'thread-1', turnId: 'turn-1' });
  const input = server.calls.find(call => call.method === 'turn/start').params;
  assert.deepEqual(input.input, [{ type: 'text', text: '修改窗户' }, { type: 'localImage', path: image }]);
  assert.deepEqual(input.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [project], networkAccess: false });
  assert.equal(input.approvalPolicy, 'on-request');
  await assert.rejects(bridge.run({ cwd: project, prompt: '并发任务' }), /尚未结束/);
  server.child.send({ method: 'item/agentMessage/delta', params: { ...run, itemId: 'message-1', delta: '正在修改' } });
  server.child.send({ method: 'item/completed', params: { ...run, item: { id: 'message-1', type: 'agentMessage', text: '已完成', phase: 'final_answer' } } });
  server.child.send({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed' } } });
  assert.deepEqual(events.filter(event => event.type === 'text').map(event => [event.text, event.delta]), [['正在修改', true], ['已完成', false]]);
  assert.equal(bridge.busy, false);
  await bridge.run({ cwd: project, prompt: '继续修改', threadId: run.threadId });
  assert.ok(server.calls.some(call => call.method === 'thread/resume'));
  await bridge.interrupt();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bridge.busy, false);
  assert.equal(events.filter(event => event.type === 'complete').at(-1).status, 'interrupted');
});

test('approvals are explicit, whitelisted, expire, and carry inspectable action context', async t => {
  const { project, server, bridge, events } = await fixture(t);
  const run = await bridge.run({ cwd: project, prompt: 'test' });
  server.child.send({ id: 801, method: 'item/commandExecution/requestApproval', params: { ...run, itemId: 'command-1', command: 'npm install', reason: '联网安装依赖' } });
  const approval = events.find(event => event.type === 'approval');
  assert.equal(approval.command, 'npm install');
  assert.deepEqual(approval.decisions, ['accept', 'decline', 'cancel']);
  await assert.rejects(bridge.respondApproval('801', 'acceptForSession'), /无效/);
  assert.equal(server.calls.some(call => call.id === 801), false);
  await bridge.respondApproval('801', 'decline');
  assert.deepEqual(server.calls.at(-1), { id: 801, result: { decision: 'decline' } });
  await assert.rejects(bridge.respondApproval('801', 'accept'), /失效/);
  server.child.send({ id: 802, method: 'item/fileChange/requestApproval', params: { ...run, itemId: 'file-1', reason: '修改外部文件' } });
  await bridge.interrupt();
  assert.ok(server.calls.some(call => call.id === 802 && call.result?.decision === 'cancel'));
});

test('paths and resumed threads cannot escape the designated project', async t => {
  const { root, project, server, bridge } = await fixture(t, {
    'thread/read': () => ({ thread: { cwd: tmpdir() } }),
  });
  await assert.rejects(bridge.run({ cwd: path.dirname(root), prompt: 'test' }), /当前工作台项目/);
  await assert.rejects(bridge.run({ cwd: project, prompt: 'test', images: ['relative.png'] }), /绝对路径/);
  const otherProject = path.join(root, 'another-project');
  await mkdir(otherProject);
  const otherImage = path.join(otherProject, 'private.png');
  await writeFile(otherImage, 'private project image');
  await assert.rejects(bridge.run({ cwd: project, prompt: 'test', images: [otherImage] }), /其他项目/);
  await assert.rejects(bridge.run({ cwd: project, prompt: 'test', threadId: 'unrelated' }), /当前工作台项目/);
  assert.equal(server.calls.some(call => call.method === 'turn/start'), false);
});

test('all sixteen references and the current screenshot reach the CLI without truncation', async t => {
  const { project, server, bridge } = await fixture(t);
  const images = Array.from({ length: 17 }, (_, index) => path.join(project, `image-${index}.png`));
  await Promise.all(images.map(image => writeFile(image, 'fixture')));
  await assert.rejects(bridge.run({ cwd: project, prompt: '修改', images: [...images, images[0]] }), /16 张用户图片/);
  await bridge.run({ cwd: project, prompt: '修改', images });
  const input = server.calls.find(call => call.method === 'turn/start').params.input;
  assert.deepEqual(input.filter(item => item.type === 'localImage').map(item => item.path), images);
});

test('process failure rejects pending requests and a subsequent connection recovers', async t => {
  const { project, server, bridge, events } = await fixture(t);
  await bridge.run({ cwd: project, prompt: 'test' });
  server.child.kill();
  assert.equal(bridge.connected, false);
  assert.equal(bridge.busy, false);
  assert.equal(events.filter(event => event.type === 'complete').at(-1).status, 'failed');
  assert.equal((await bridge.connect()).connected, true);
});

test('a completion arriving before turn/start response does not leave a stuck task', async t => {
  const { project, bridge } = await fixture(t, {
    'turn/start': (params, child) => {
      child.send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'early-turn', status: 'completed' } } });
      return { turn: { id: 'early-turn' } };
    },
  });
  assert.equal((await bridge.run({ cwd: project, prompt: 'test' })).turnId, 'early-turn');
  assert.equal(bridge.busy, false);
});

test('missing CLI gives a usable error and does not expose stderr', async t => {
  const { root } = await fixture(t);
  const bridge = new CodexBridge({ workspaceRoot: root, codexBin: path.join(root, 'does-not-exist.exe') });
  t.after(() => bridge.close());
  const connection = await bridge.connect();
  assert.equal(connection.connected, false);
  assert.match(connection.error, /未找到 Codex CLI/);
});
