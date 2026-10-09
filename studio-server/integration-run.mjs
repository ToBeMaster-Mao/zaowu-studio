import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const origin = 'http://127.0.0.1:4174';
const html = await (await fetch(origin)).text();
const token = html.match(/name="studio-token"\s+content="([^"]+)"/)?.[1];
if (!token || token === '__SESSION_TOKEN__') throw new Error('No usable local session token was found.');
const headers = { 'x-studio-token': token, 'content-type': 'application/json' };
const sha = value => createHash('sha256').update(value).digest('hex');
async function api(url, body) {
  const response = await fetch(`${origin}${url}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error || 'API request failed'}`);
  return data;
}
const project = await api('/api/projects', { name: '台灯 · 联调示例', template: 'empty' });
const before = await readFile(path.join(project.workspacePath, 'model.js'), 'utf8');
console.log(JSON.stringify({ type: 'created', projectId: project.id, name: project.name, sourceBytes: Buffer.byteLength(before), modelOverride: false }));
const abort = new AbortController();
let approval = null;
let latestAgentText = '';
const eventPump = (async () => {
  const stream = await fetch(`${origin}/api/events`, { headers, signal: abort.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const raw = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6);
      if (!raw) continue;
      const event = JSON.parse(raw);
      if (event.projectId !== project.id) continue;
      if (event.type === 'agent' && event.event?.type === 'approval') {
        approval = event.event;
        console.log(JSON.stringify({ type: 'approval-required', projectId: project.id, requestId: approval.requestId, kind: approval.kind, reason: approval.reason, command: approval.command, cwd: approval.cwd }));
      }
      if (event.type === 'agent' && event.event?.type === 'text') latestAgentText = event.event.delta ? latestAgentText + event.event.text : event.event.text;
      if (event.type === 'task') console.log(JSON.stringify({ type: 'task-event', projectId: project.id, status: event.task?.status, error: event.task?.error }));
    }
  }
})().catch(error => { if (error.name !== 'AbortError') console.log(JSON.stringify({ type: 'event-stream-error', message: error.message })); });

await api(`/api/projects/${project.id}/tasks`, { prompt: '创建一个简洁的金属台灯：圆形底座、细立柱、弯曲灯臂和半球形灯罩，深青色外壳、米白色内壁。用 Three.js 基础几何和曲线建模，给部件稳定名称，保持模型简洁，不用图片、不用外部资源。直接修改 model.js。', referenceIds: [] });
let current, previousStatus = '', elapsed = 0;
while (elapsed < 180000) {
  current = await api(`/api/projects/${project.id}`);
  const status = current.task?.status || 'none';
  if (status !== previousStatus) console.log(JSON.stringify({ type: 'progress', projectId: project.id, elapsedSeconds: Math.round(elapsed / 1000), status, pendingRevisionId: current.pendingRevisionId }));
  previousStatus = status;
  if (approval || !['running', 'starting', 'queued'].includes(status)) break;
  await new Promise(resolve => setTimeout(resolve, 8000));
  elapsed += 8000;
}
current = await api(`/api/projects/${project.id}`);
const after = await readFile(path.join(project.workspacePath, 'model.js'), 'utf8');
console.log(JSON.stringify({ type: 'result', projectId: project.id, workspacePath: project.workspacePath,
  status: current.task?.status, error: current.task?.error, pendingRevisionId: current.pendingRevisionId,
  sourceChanged: sha(before) !== sha(after), beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after),
  beforeHash: sha(before), afterHash: sha(after), hasCreateModel: /export\s+function\s+createModel/.test(after),
  namedParts: [...after.matchAll(/\.name\s*=\s*['"]([^'"]+)['"]/g)].map(match => match[1]).slice(0, 30),
  taskOutput: (current.task?.output || latestAgentText).slice(0, 8000), approvalRequired: Boolean(approval),
  capped: elapsed >= 180000, note: 'No browser validation or automatic approval submitted.'
}));
abort.abort();
await eventPump;
