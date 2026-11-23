import { AsyncLocalStorage } from 'node:async_hooks';

type Correlation = { mcpRequestId: string } | { taskId: string; workerRunId: string };
type Stage = 'model_session' | 'agent_tool' | 'action_apply' | 'result_read' | 'didi_read' | 'didi_rpc';
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
  let outcome = 'threw';
  try {
    const result = await run();
    outcome = 'returned';
    return result;
  } finally {
    console.info(JSON.stringify({
      event: 'stage_timing', ...correlation, stage, operation, outcome,
      startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
    }));
  }
}
