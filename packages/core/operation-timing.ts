import { AsyncLocalStorage } from 'node:async_hooks';
import { profileDatabase, profileSummary } from './database-profile.js';

type Correlation = { mcpRequestId: string } | { taskId: string; workerRunId: string } | { workflowRunId: string; attemptId: string };
type Stage = 'model_session' | 'agent_tool' | 'action_apply' | 'result_read' | 'function' | 'didi_read' | 'didi_rpc';
const timing = new AsyncLocalStorage<Correlation>();

export function withOperationTiming<T>(correlation: Correlation, run: () => Promise<T>) {
  return timing.run(correlation, run);
}

/** Keep the owning run when a harness invokes its tools from another connection. */
export function bindOperationTiming<Input, Result>(run: (input: Input) => Promise<Result>) {
  const correlation = timing.getStore();
  return correlation ? (input: Input) => timing.run(correlation, () => run(input)) : run;
}

export async function timeOperation<T>(stage: Stage, run: () => Promise<T>, operation?: string) {
  const correlation = timing.getStore();
  if (!correlation) return run();
  const startedAt = new Date().toISOString(), started = performance.now();
  return profileDatabase(async profile => {
    let outcome = 'threw';
    try {
      const result = await run();
      outcome = 'returned';
      return result;
    } finally {
      console.info(JSON.stringify({
        event: 'stage_timing', ...correlation, stage, operation, outcome,
        startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
        db: profileSummary(profile),
      }));
    }
  });
}
