/** Keep permission requests available to refreshes and broadcast project-scoped replacements. */
export class ApprovalInbox {
  constructor(emit) {
    this.entries = new Map();
    this.emit = emit;
  }

  snapshot(projectId) {
    return [...this.entries.values()].filter(entry => !projectId || entry.projectId === projectId).map(entry => ({ ...entry }));
  }

  publish(projectId) {
    this.emit({ type: 'approvals', projectId, approvals: this.snapshot(projectId) });
  }

  set(projectId, event) {
    this.entries.set(event.requestId, { ...event, projectId });
    this.publish(projectId);
  }

  has(id) { return this.entries.has(id); }

  delete(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.publish(entry.projectId);
  }

  clear(projectId) {
    for (const [id, entry] of this.entries) if (entry.projectId === projectId) this.entries.delete(id);
    this.publish(projectId);
  }
}

/** The app-server emits 'running' before turn/start replies, so it cannot acknowledge a task start. */
export function acknowledgeTaskStart(task, result) {
  if (task.status !== 'starting' || !result.turnId) return task;
  return { ...task, status: 'running', threadId: result.threadId, turnId: result.turnId };
}

export function updateBridgeStatus(info, event) {
  return {
    ...info, status: event.status, message: event.message,
    ...(['connecting', 'disconnected'].includes(event.status) ? { connected: false } : {}),
    ...(event.status === 'connected' ? { connected: true } : {}),
    ...(event.status === 'connecting' ? { error: null } : {}),
  };
}

/** Reconcile an interrupted process with durable model snapshots before accepting new tasks. */
export function recoverTaskAfterRestart(project, at = new Date().toISOString()) {
  const task = project.task;
  if (!['starting', 'running', 'stopping', 'validating'].includes(task?.status)) return task;
  if (project.pendingRevisionId) {
    if (task.status === 'validating') return task;
    return {
      ...task, status: 'validating', agentStatus: 'interrupted', modelRevisionId: project.pendingRevisionId,
      agentCompletedAt: at, completedAt: null, error: '连接程序已重启，正在校验中断前保存的模型。',
    };
  }
  const revision = project.versions?.find(item => item.id === task.modelRevisionId);
  if (task.status === 'validating' && revision && ['valid', 'invalid'].includes(revision.status)) {
    const valid = revision.status === 'valid';
    return {
      ...task, status: valid ? task.agentStatus || 'completed' : 'failed',
      modelValidation: valid ? 'valid' : 'invalid', completedAt: at,
      error: valid ? task.error || null : revision.error || '模型预览失败，已恢复上一版本。',
    };
  }
  return { ...task, status: 'interrupted', completedAt: at, error: '连接程序已重启，可以继续提交修改。' };
}
