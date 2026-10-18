import { TaskService } from '../packages/core/tasks.js';
import { JobStore } from '../packages/core/store.js';
import type { Executor } from '../packages/capabilities/executor.js';
import { Worker } from '../apps/worker/worker.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { interpretation, reasoner } from './backend-fixture.js';

export const briefReasoner = () => reasoner(r => {
  const deliverable = r.requestedDeliverable ?? (r.messages.length > 1 ? r.messages.at(-1)!.text : undefined);
  return deliverable ? interpretation(r, 'brief.prepare', { goal: r.originalGoal, deliverable }) : { ...interpretation(r), kind: 'clarify', message: 'What deliverable and acceptance criteria should the brief record?' };
});
export const documentReasoner = () => reasoner(r => ({ ...interpretation(r, 'document.compose', { format: 'markdown' }), capabilityRef: { id: 'document.compose', version: '1' } }));
// Fixtures use the production ontology coordinator and persistent action runtime.
export class LocalTasks extends TaskService {
  readonly worker: Worker;
  constructor(store: JobStore, executor?: Executor) {
    const catalog = createExecutionCatalog({ documentEnabled: !!executor, documentExecutor: executor });
    super(store, { catalog });
    this.worker = new Worker(store, { coordinator: new Coordinator(store, executor ? documentReasoner() : briefReasoner(), catalog), pollMs: 10 });
  }
  override submit(...args: Parameters<TaskService['submit']>) { const job = super.submit(...args); this.worker.start(); return job; }
  override reply(...args: Parameters<TaskService['reply']>) { const job = super.reply(...args); this.worker.tick(); return job; }
  override cancel(...args: Parameters<TaskService['cancel']>) { const job = super.cancel(...args); this.worker.tick(); return job; }
  override async close() { await super.close(); await this.worker.close(); }
}
