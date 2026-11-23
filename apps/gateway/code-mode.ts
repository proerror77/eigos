import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { InvalidInput, ServiceUnavailable } from '../../packages/core/identity.js';
import { actionCallSchema } from '../../packages/ontology/invocation.js';
import { querySchema, type Query } from '../../packages/runtime/objects.js';

export const codeModeInput = z.strictObject({
  code: z.string().trim().min(1).max(12_000),
});

export const codeModeActionCall = actionCallSchema.safeExtend({ scenarioId: z.never().optional() });

const maxRuns = 4, maxQueries = 12, deadlineMs = 8_000;
const maxPageBytes = 128 * 1024, maxReadBytes = 512 * 1024, maxResultBytes = 64 * 1024;
const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './code-mode-worker.ts' : './code-mode-worker.js', import.meta.url);

type WorkerMessage =
  | { kind: 'request'; operation: string; id: number; input: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'result'; value: string };

function parseInput<T>(input: string, schema: z.ZodType<T>, label: string): T {
  if (Buffer.byteLength(input) > 16_384) throw new InvalidInput(label + ' input is too large');
  let args: unknown;
  try { args = JSON.parse(input); }
  catch { throw new InvalidInput(label + ' requires an object'); }
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const path = issue.path.length ? ' (' + issue.path.join('.') + ')' : '';
    throw new InvalidInput(`${label}${path}: ${issue.message.slice(0, 180)}`);
  }
  return parsed.data;
}

export class CodeMode {
  private running = 0;

  async execute(code: string, query: (input: Query) => Promise<unknown>, signal: AbortSignal,
    stageAction?: (action: z.infer<typeof codeModeActionCall>) => void): Promise<unknown> {
    signal.throwIfAborted();
    if (this.running >= maxRuns) throw new ServiceUnavailable('Code Mode is busy. Retry or use query_ontology.');
    const worker = new Worker(workerUrl, {
      workerData: { code, writable: stageAction !== undefined }, env: {},
      execArgv: workerUrl.pathname.endsWith('.ts') ? ['--experimental-strip-types'] : [],
      resourceLimits: { maxOldGenerationSizeMb: 48, stackSizeMb: 2 },
    });
    this.running++;
    let open = true, queries = 0, actionRequested = false, completed = 0, bytes = 0;
    let reads = Promise.resolve();
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const end = (error?: unknown, value?: unknown) => {
          if (!open) return;
          open = false;
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
          if (error !== undefined) reject(error);
          else resolve(value);
        };
        const abort = () => end(signal.reason);
        const timeout = setTimeout(() => end(new InvalidInput('Code Mode timed out. Reduce the query or use query_ontology.')), deadlineMs);
        signal.addEventListener('abort', abort, { once: true });
        const unavailable = () => end(new ServiceUnavailable('Code Mode runner stopped. Retry or use query_ontology.'));
        worker.on('error', unavailable);
        worker.once('exit', unavailable);
        worker.on('message', (message: WorkerMessage) => {
          if (!open) return;
          if (message.kind === 'invalid') return end(new InvalidInput('Code Mode program: ' + message.message));
          if (message.kind === 'result') {
            const issued = queries + Number(actionRequested);
            if (!issued || completed !== issued) return end(new InvalidInput('Await all queries and staged Actions before returning the result'));
            if (Buffer.byteLength(message.value) > maxResultBytes) return end(new InvalidInput('Code Mode result is too large. Return fewer fields or rows.'));
            try { end(undefined, JSON.parse(message.value)); }
            catch { end(new InvalidInput('Return a JSON value')); }
            return;
          }
          const writing = message.operation === 'action';
          if (writing) {
            if (!stageAction || actionRequested) return end(new InvalidInput('Only one Action can be staged in a write execution'));
            actionRequested = true;
          } else if (message.operation !== 'query' || ++queries > maxQueries) {
            return end(new InvalidInput('Code Mode allows up to 12 queries per execution'));
          }
          const index = queries;
          // Sequential requests share one authorization context, even when using Promise.all.
          reads = reads.then(async () => {
            if (!open) return;
            let result: unknown;
            if (writing) {
              stageAction!(parseInput(message.input, codeModeActionCall, 'Code Mode Action'));
              result = { staged: true };
            } else {
              result = await query(parseInput(message.input, querySchema, 'Code Mode query ' + index));
            }
            if (!open) return;
            const value = JSON.stringify(result);
            const size = Buffer.byteLength(value);
            bytes += size;
            if (size > maxPageBytes || bytes > maxReadBytes) throw new InvalidInput('Code Mode read budget exceeded. Use select or a smaller limit.');
            completed++;
            worker.postMessage({ id: message.id, value });
          }).catch(error => end(error));
        });
      });
    } finally {
      // Keep capacity occupied until any already-started database read settles.
      void Promise.allSettled([worker.terminate(), reads]).then(() => { this.running--; });
    }
  }
}
