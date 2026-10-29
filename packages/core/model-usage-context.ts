import { AsyncLocalStorage } from 'node:async_hooks';
import type { RunEvidence } from '../capabilities/executor.js';

export type ModelUsageEvidence = Pick<RunEvidence, 'id' | 'runtime' | 'startedAt' | 'completedAt' | 'model' | 'usage' | 'nativeTiming'>;

export interface ModelUsageRecorder {
  begin(id: string, runtime: string, startedAt: string): void;
  finish(id: string, evidence: ModelUsageEvidence | undefined, outcome: 'completed' | 'failed' | 'interrupted'): void;
}
const context = new AsyncLocalStorage<ModelUsageRecorder>();
export function withModelUsage<T>(recorder: ModelUsageRecorder, run: () => T): T { return context.run(recorder, run); }
export function modelUsageRecorder(): ModelUsageRecorder | undefined { return context.getStore(); }
