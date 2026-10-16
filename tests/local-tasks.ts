import { TaskService } from '../packages/core/tasks.js';
import { JobStore } from '../packages/core/store.js';
import type { Executor } from '../packages/capabilities/executor.js';
import type { PaotuiReader } from '../packages/capabilities/paotui-contracts.js';
import { Worker } from '../apps/worker/worker.js';

// Same queue/Worker used in production, on a single in-memory connection for unit tests.
export class LocalTasks extends TaskService {
  readonly worker: Worker;
  constructor(store: JobStore, executor?: Executor, paotui?: PaotuiReader) {
    super(store, { agent: !!executor, paotui: !!paotui });
    this.worker = new Worker(store, { executor, paotui });
  }
  override submit(...args: Parameters<TaskService['submit']>) { const job = super.submit(...args); this.worker.start(); this.worker.tick(); return job; }
  override reply(...args: Parameters<TaskService['reply']>) { const job = super.reply(...args); this.worker.tick(); return job; }
  override cancel(...args: Parameters<TaskService['cancel']>) { const job = super.cancel(...args); this.worker.tick(); return job; }
  override async close() { await super.close(); await this.worker.close(); }
}
