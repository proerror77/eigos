import { digest } from '../core/identity.js';
import type { ObjectRef } from '../ontology/schema.js';
import type { Database, Sql } from './database.js';
import type { FunctionContext } from './functions.js';
import { Objects } from './objects.js';
import { ScheduledActions } from './scheduled-actions.js';
import type { Task } from './tasks.js';

const minute = 60_000;
const observationWindow = 4 * 60 * minute;

/** An original-order read is admitted with the dispatch claim, under the original caller's grants. */
export class OrderObservation {
  private readonly schedules: ScheduledActions;

  constructor(
    private readonly db: Database,
    private readonly refreshAction: string,
    private readonly targetParameter: string,
    private readonly namespace = 'original-order-observation',
  ) {
    this.schedules = new ScheduledActions(db);
  }

  private scheduleId(original: ObjectRef) {
    return digest([this.namespace, this.refreshAction, original]);
  }

  async enqueue(ctx: FunctionContext, original: ObjectRef, client: Sql,
    args: Record<string, unknown> = { [this.targetParameter]: original }) {
    const graph = new Objects(this.db, ctx.objects.model, ctx.objects.access, client);
    const now = Date.now();
    await this.schedules.enqueue(graph, {
      id: this.scheduleId(original), action: this.refreshAction, arguments: args,
      runAt: new Date(now + minute).toISOString(),
      deadline: new Date(now + observationWindow).toISOString(),
      sourceTaskId: ctx.taskId,
    });
  }

  cancel(graph: Objects, original: ObjectRef) {
    return this.schedules.cancel(graph, this.scheduleId(original));
  }

  task(ctx: FunctionContext, original: ObjectRef) {
    const task = ctx.execution?.task;
    const call = task?.input.scheduledAction;
    return call?.action === this.refreshAction && call.scheduleId === this.scheduleId(original) ? task : undefined;
  }

  async advance(graph: Objects, task: Task, outcome: 'pending' | 'unavailable' | 'terminal') {
    if (outcome === 'terminal') return 'finished' as const;
    const step = task.execution_step ?? 0;
    const delay = outcome === 'unavailable' ? minute * 2 ** Math.min(3, step + 1) : 5 * minute;
    const next = Date.now() + delay;
    if (next >= Date.parse(task.input.scheduledAction!.deadline))
      return outcome === 'unavailable' ? 'source_unavailable' as const : 'timed_out' as const;
    await this.schedules.continueAt(graph, task, new Date(next).toISOString());
    return 'watching' as const;
  }
}
