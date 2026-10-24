// Deterministic model substitute for process/queue tests; never calls Codex or a provider.
import { randomUUID } from 'node:crypto';
import { JobStore } from '../../packages/core/store.js';
import { Worker } from '../../apps/worker/worker.js';
import { Coordinator } from '../../packages/coordinator/coordinator.js';
import { readWorkerConfig } from '../../packages/core/config.js';
import { documentReasoner, legacyDocumentCatalog } from '../local-tasks.js';
import type { Executor } from '../../packages/capabilities/executor.js';

const store = new JobStore(process.env.DATABASE_PATH!);
const pending = new Map<string, () => void>();
process.on('message', message => { const value = message as { event: string; taskId: string }; if (value.event === 'release') pending.get(value.taskId)?.(); });
const executor: Executor = { run: async (job, signal) => {
  process.send?.({ event: 'started', taskId: job.id });
  if (job.goal === 'slow') {
    signal.addEventListener('abort', () => process.send?.({ event: 'aborted', taskId: job.id }), { once: true });
    await new Promise<void>(resolve => pending.set(job.id, resolve)); // Parent releases only after observing cancellation.
    pending.delete(job.id); process.send?.({ event: 'returned', taskId: job.id });
  }
  const ask = job.messages.filter(m => m.role === 'user').length === 1 && job.goal !== 'slow';
  return { output: { decision: ask ? 'ask_user' : 'complete', message: ask ? 'Fixture question?' : 'Fixture delivery', artifact: ask ? '' : '# Fixture document' },
    evidence: { id: randomUUID(), runtime: 'process-test-fixture', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), outputSha256: 'fixture-only' } };
} };
readWorkerConfig({ ...process.env, EIGOS_EXECUTOR: 'codex' });
const worker = new Worker(store, { coordinator: new Coordinator(store, documentReasoner(), legacyDocumentCatalog(executor)), pollMs: 20, leaseMs: 2000 });
worker.start();
process.send?.({ event: 'ready' });
const stop = () => { for (const release of pending.values()) release(); void worker.close().then(() => { store.close(); process.disconnect?.(); }); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
