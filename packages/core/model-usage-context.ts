import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { RunEvidence } from '../capabilities/executor.js';

/** Private attempt diagnostics contain only host-selected categories and exit
 * metadata. Never accept subprocess text, arguments, paths or error messages. */
export const modelFailureSchema = z.object({
  phase: z.enum(['prepare', 'dispatch', 'initialize', 'protocol', 'output', 'abort', 'exit']),
  code: z.enum(['setup_failed', 'dispatch_rejected', 'process_start_failed', 'timeout', 'canceled', 'output_limit',
    'invalid_protocol', 'operation_rejected', 'invalid_runtime', 'invalid_acknowledgement', 'wrong_session',
    'forbidden_tool', 'interrupted_output', 'incomplete_turn', 'invalid_output', 'process_exited', 'runtime_closed']),
  exitCode: z.number().int().min(0).max(255).optional(),
  signal: z.enum(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGKILL',
    'SIGSEGV', 'SIGPIPE', 'SIGTERM', 'other']).optional(),
}).strict();
export type ModelFailureDiagnostic = z.infer<typeof modelFailureSchema>;
export type ModelUsageEvidence = Pick<RunEvidence, 'id' | 'runtime' | 'startedAt' | 'completedAt' | 'model' | 'usage' | 'nativeTiming'> & { failure?: ModelFailureDiagnostic };

/** Persistence may be asynchronous; model transports await both boundaries. */
export interface ModelUsageRecorder {
  begin(id: string, runtime: string, startedAt: string): unknown;
  finish(id: string, evidence: ModelUsageEvidence | undefined, outcome: 'completed' | 'failed' | 'interrupted'): unknown;
}
const context = new AsyncLocalStorage<ModelUsageRecorder>();
export function withModelUsage<T>(recorder: ModelUsageRecorder, run: () => T): T { return context.run(recorder, run); }
export function modelUsageRecorder(): ModelUsageRecorder | undefined { return context.getStore(); }
