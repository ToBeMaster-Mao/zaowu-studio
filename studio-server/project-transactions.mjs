/** Serialize lifecycle transitions and preview validation, including internal task completion. */
export class ProjectTransactions {
  pending = 0;
  tail = Promise.resolve();
  get busy() { return this.pending > 0; }
  run(operation) {
    this.pending++;
    const result = this.tail.catch(() => {}).then(operation);
    this.tail = result;
    return result.finally(() => { this.pending--; });
  }
}
