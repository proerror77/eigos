import { digest } from '../../core/identity.js';
import type { ObjectRef } from '../../ontology/schema.js';
import type { Database, Sql } from '../../runtime/database.js';
import type { FunctionContext } from '../../runtime/functions.js';
import { Objects } from '../../runtime/objects.js';
import { ScheduledActions } from '../../runtime/scheduled-actions.js';
import type { Task } from '../../runtime/tasks.js';

const minute = 60_000;
const observationWindow = 4 * 60 * minute;

/** An original-order read is admitted with the dispatch claim, under the original caller's grants. */
export class OrderObservation {
  private readonly schedules: ScheduledActions;

  constructor(private readonly db: Database, private readonly refreshAction: string) {
    this.schedules = new ScheduledActions(db);
  }

  private scheduleId(booking: ObjectRef) {
    return digest(['fliggy-original-order-observation', this.refreshAction, booking]);
  }

  async enqueue(ctx: FunctionContext, booking: ObjectRef, client: Sql) {
    const graph = new Objects(this.db, ctx.objects.model, ctx.objects.access, client);
    const now = Date.now();
    await this.schedules.enqueue(graph, {
      id: this.scheduleId(booking), action: this.refreshAction, arguments: { booking },
      runAt: new Date(now + minute).toISOString(),
      deadline: new Date(now + observationWindow).toISOString(),
      sourceTaskId: ctx.taskId,
    });
  }

  task(ctx: FunctionContext, booking: ObjectRef) {
    const task = ctx.execution?.task;
    const call = task?.input.scheduledAction;
    return call?.action === this.refreshAction && call.scheduleId === this.scheduleId(booking) ? task : undefined;
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
