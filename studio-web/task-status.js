const terminalStatuses = new Set(['completed', 'failed', 'invalid', 'interrupted', 'cancelled', 'canceled', 'idle']);
const stoppedStatuses = new Set(['interrupted', 'cancelled', 'canceled']);

/** Presentation only: a lost connection never implies that the agent has stopped. */
export function describeTask({
  task = null,
  submitting = false,
  stopping = false,
  awaitingApproval = false,
  connected = true,
  pendingRevision = false,
  referenceCount = 0,
  uploading = false,
  activity = null,
} = {}) {
  const status = String(task?.status || 'idle');
  const generating = (task?.intent || task?.kind || task?.mode) === 'generate';
  const active = Boolean(task) && !terminalStatuses.has(status);
  const result = (phase, title, description, options = {}) => ({
    phase, title, description, busy: false, overlay: false, canStop: false, tone: 'neutral', ...options,
  });

  if (submitting) {
    return result('submitting', generating ? '正在准备建模' : '正在提交', '正在发送参考图和本次要求，请稍候。', {
      busy: true, overlay: true, tone: 'active',
    });
  }

  // Preview checks run locally, so they remain useful even if the agent disconnects.
  if (status === 'validating' || pendingRevision) {
    return result('validating', '正在校验预览', '正在加载新版本，检查通过后会更新展示区。', {
      busy: true, overlay: true, tone: 'active',
    });
  }

  if (active && !connected) {
    return result('disconnected', '连接已中断', '暂时无法获取任务状态；任务是否结束尚未确认，请重新连接。', {
      busy: true, overlay: true, tone: 'warning',
    });
  }

  if (status === 'starting') {
    return result('submitting', generating ? '正在准备建模' : '正在准备处理', '本地 Agent 正在启动本次任务，请稍候。', {
      busy: true, overlay: true, tone: 'active',
    });
  }

  if (active && (stopping || status === 'interrupting' || status === 'stopping')) {
    return result('stopping', '正在停止', '停止请求已发送，正在等待本地 Agent 确认。', {
      busy: true, overlay: true, tone: 'warning',
    });
  }

  if (active && (awaitingApproval || status === 'awaiting_approval')) {
    return result('approval', '等待你的确认', '请处理下方的操作许可，确认后任务会继续。', {
      busy: true, overlay: true, canStop: true, tone: 'warning',
    });
  }

  if (active) {
    return result(generating ? 'generating' : 'working', generating ? '正在建模' : '正在处理',
      typeof activity === 'string' && activity.trim() ? activity.trim() : generating
        ? '正在根据参考图创建模型，完成后会自动加载预览。'
        : 'Agent 正在处理你的要求，回复和进展会显示在对话中。',
      { busy: true, overlay: true, canStop: true, tone: 'active' });
  }

  if (uploading) {
    return result('uploading', '正在上传参考图', '图片会保存在当前项目中，上传完成后即可开始建模。', { busy: true, tone: 'active' });
  }

  if (stoppedStatuses.has(status)) {
    return result('stopped', '任务已停止', '本次任务已结束，可以调整要求后重新开始。');
  }

  if (status === 'failed' || status === 'invalid') {
    return result('failed', '任务未完成', task?.modelValidation === 'invalid'
      ? '新版本未通过预览检查，已恢复上一可用版本。'
      : '本次处理遇到问题。可以查看对话中的说明，调整后重试。', { tone: 'error' });
  }

  if (status === 'completed') {
    return result('completed', generating ? '建模已完成' : '处理已完成', task?.modelValidation === 'valid'
      ? '新版本已通过检查，可以旋转查看或继续修改。'
      : '本次任务已结束。可以继续对话，或开始下一次建模。', { tone: 'success' });
  }

  if (!connected) {
    return result('disconnected', '等待连接本地 Agent', '连接 Codex 后，就可以开始建模或继续对话。', { tone: 'warning' });
  }

  return result('idle', referenceCount > 0 ? '参考图已就绪' : '准备开始', referenceCount > 0
    ? '点击「开始建模」即可生成，描述可以留空。'
    : '上传参考图后开始建模，或在下方直接描述你的想法。');
}

/** Frozen for ended tasks; invalid or missing timestamps do not invent elapsed time. */
export function elapsedLabel(startedAt, endedAt, now = Date.now()) {
  if (startedAt === null || startedAt === undefined || startedAt === '') return '';
  const start = new Date(startedAt).getTime();
  const end = endedAt === null || endedAt === undefined || endedAt === '' ? Number(now) : new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')} 分`;
}
