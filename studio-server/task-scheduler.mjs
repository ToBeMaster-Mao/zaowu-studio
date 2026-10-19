/** Project-exclusive FIFO queues with separate CLI/API capacity. Jobs never expose credentials. */
export class TaskScheduler {
  constructor({ limits = { codex: 1, api: 1 }, execute, onChange = () => {}, onError = () => {} }) {
    this.limits = { ...limits };
    this.execute = execute;
    this.onChange = onChange;
    this.onError = onError;
    this.active = new Map();
    this.queued = [];
    this.paused = false;
  }
  group(job) { return job.task.provider === 'codex' ? 'codex' : 'api'; }
  get busy() { return this.active.size > 0 || this.queued.length > 0; }
  find(projectId) { return this.active.get(projectId) || this.queued.find(job => job.projectId === projectId); }
  snapshot() {
    return {
      limits: { ...this.limits },
      active: [...this.active.values()].map(job => ({ projectId: job.projectId, task: { ...job.task } })),
      queued: this.queued.map((job, index) => ({ projectId: job.projectId, task: { ...job.task, queuePosition: index + 1 }, position: index + 1 })),
    };
  }
  changed() { this.onChange(this.snapshot()); }
  enqueue(job) {
    if (this.paused) throw Object.assign(new Error('服务正在关闭，请稍后重试。'), { status: 503 });
    if (this.find(job.projectId)) throw Object.assign(new Error('此项目已有运行或排队中的任务。'), { status: 409 });
    this.queued.push(job);
    this.changed();
    queueMicrotask(() => this.drain());
  }
  setLimits(limits) {
    for (const key of ['codex', 'api']) if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > 8) throw new Error('并发数须为 1–8。');
    this.limits = { ...limits };
    this.changed();
    this.drain();
  }
  cancelQueued(projectId, taskId) {
    const index = this.queued.findIndex(job => job.projectId === projectId && (!taskId || job.task.id === taskId));
    if (index < 0) return null;
    const [job] = this.queued.splice(index, 1);
    this.changed();
    return job;
  }
  drain() {
    if (this.paused) return;
    const count = group => [...this.active.values()].filter(job => this.group(job) === group).length;
    let index;
    while ((index = this.queued.findIndex(job => count(this.group(job)) < this.limits[this.group(job)])) >= 0) {
      const [job] = this.queued.splice(index, 1);
      this.active.set(job.projectId, job);
      this.changed();
      job.execution = Promise.resolve().then(() => this.execute(job)).catch(error => this.onError(error, job)).finally(() => {
        if (this.active.get(job.projectId) === job) this.active.delete(job.projectId);
        this.changed();
        this.drain();
      });
    }
  }
}
