import { AsyncLocalStorage } from 'node:async_hooks';
import type { RunEvidence } from '../capabilities/executor.js';

export type ModelUsageEvidence = Pick<RunEvidence, 'id' | 'runtime' | 'startedAt' | 'completedAt' | 'model' | 'usage' | 'nativeTiming'>;

/** Persistence may be asynchronous; model transports await both boundaries. */
export interface ModelUsageRecorder {
  begin(id: string, runtime: string, startedAt: string): unknown;
  finish(id: string, evidence: ModelUsageEvidence | undefined, outcome: 'completed' | 'failed' | 'interrupted'): unknown;
}
const context = new AsyncLocalStorage<ModelUsageRecorder>();
export function withModelUsage<T>(recorder: ModelUsageRecorder, run: () => T): T { return context.run(recorder, run); }
export function modelUsageRecorder(): ModelUsageRecorder | undefined { return context.getStore(); }
