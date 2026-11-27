import { randomUUID } from 'node:crypto';
import { TaskResult,PermissionDenied } from '../../packages/runtime/access.js';
import { Conflict } from '../../packages/core/identity.js';
import { withOperationTiming } from '../../packages/core/operation-timing.js';
import { profileDatabase, profileSummary, type DatabaseProfile } from '../../packages/core/database-profile.js';
import { Clarification } from '../../packages/runtime/agent.js';
import { Tasks, type Task } from '../../packages/runtime/tasks.js';
import { DeferredExecution } from '../../packages/runtime/scheduled-actions.js';
import { ProviderBudgetExceeded } from '../../packages/runtime/provider-budgets.js';

type TaskLane = 'scheduled' | 'interactive';

export class Worker {
  private readonly controller = new AbortController();
  private readonly waiters = new Set<() => void>();
  private notifications = 0;
  constructor(private readonly tasks: Tasks, private readonly agent: { run(task: Task, signal: AbortSignal): Promise<unknown> }, private readonly schedules?: {promoteOne():Promise<boolean>}, private readonly scheduledRunner?: {run(task:Task,signal:AbortSignal):Promise<unknown>}) {}
  async runOne(lane?: TaskLane): Promise<boolean> {
    if (lane !== 'interactive') await this.schedules?.promoteOne();
    const task = await this.tasks.claim(lane);
    if (!task) return false;
    const correlation = { taskId: task.id, workerRunId: randomUUID() };
    const startedAt = new Date().toISOString(), started = performance.now();
    console.info(JSON.stringify({
      event: 'worker_claim', ...correlation, startedAt, taskCreatedAt: task.created_at.toISOString(),
      taskAvailableAt: task.available_at?.toISOString(), taskClaimedAt: task.updated_at.toISOString(),
      queuedMs: task.available_at ? task.updated_at.getTime() - task.available_at.getTime() : undefined,
    }));
    let taskState = 'uncommitted', profile: DatabaseProfile | undefined;
    try {
      taskState = await this.tasks.db.withOwner(task.owner, () => withOperationTiming(correlation,
        () => profileDatabase(measured => { profile = measured; return this.execute(task); })));
    } finally {
      console.info(JSON.stringify({
        event: 'worker_finish', ...correlation, taskState, finishedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started), db: profile && profileSummary(profile),
      }));
    }
    return true;
  }
  private async execute(task: Task) {
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.controller.signal]);
    let renewing: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (!renewing) renewing = this.tasks.renew(task).catch(() => controller.abort()).finally(() => { renewing = undefined; });
    }, 10000);
    timer.unref();
    try {
      if(task.input.scheduledAction&&!this.scheduledRunner)throw new Error('Scheduled Action runner is unavailable');
      const result = await (task.input.scheduledAction?this.scheduledRunner!:this.agent).run(task, signal);
      signal.throwIfAborted();
      await this.tasks.finish(task, 'completed', result instanceof TaskResult ? result.value : result, undefined, result instanceof TaskResult ? result.permissions : []);
      return 'completed';
    } catch (error) {
      if (error instanceof DeferredExecution) return await this.tasks.defer(task, error.until).then(() => 'deferred', () => 'uncommitted');
      // A provider call over its owner's budget waits for the budget instead of failing the task (runtime budget 06.3).
      if (error instanceof ProviderBudgetExceeded) return await this.tasks.postpone(task, error.until).then(() => 'deferred', () => 'uncommitted');
      const clarification = error instanceof Clarification;
      const state = clarification ? 'input-required' : 'failed';
      if (!clarification) console.error('Inquiry execution failed', error instanceof Error ? error.message : 'Unknown error');
      const safeError=error instanceof Conflict||error instanceof PermissionDenied?error.message:'Execution failed. Check the original operation and configured source before retrying.';
      return await this.tasks.finish(task, state, clarification ? error.choices ?? null : null,
        clarification ? error.message : safeError, clarification ? error.permissions : [],
        clarification ? error.continuation : undefined).then(() => state, () => 'uncommitted');
    } finally { clearInterval(timer); await renewing; }
  }
  async run() {
    const listener = await this.tasks.db.pool.connect();
    listener.on('notification', () => this.wake());
    listener.on('error', () => this.stop());
    const consumers: Promise<void>[] = [];
    try {
      await listener.query('LISTEN eigos_tasks');
      // Each Worker runs EIGOS_WORKER_SLOTS tasks at once, 4 by default (runtime budget 06.1).
      const slots = Math.max(1, Number(process.env.EIGOS_WORKER_SLOTS ?? 4) || 4);
      if (this.schedules && this.scheduledRunner) {
        // Provider-backed scheduled Actions have a slot even when every interactive slot is busy.
        consumers.push(this.consume('scheduled'), ...Array.from({ length: slots }, () => this.consume('interactive')));
      } else consumers.push(...Array.from({ length: slots }, () => this.consume()));
      await Promise.all(consumers);
    } finally {
      this.stop();
      await Promise.allSettled(consumers);
      await listener.query('UNLISTEN eigos_tasks').catch(() => {});
      listener.release();
    }
  }
  private async consume(lane?: TaskLane) {
    while (!this.controller.signal.aborted) {
      const seen = this.notifications;
      if (await this.runOne(lane)) continue;
      const delay = lane === 'scheduled' ? 1000 : await this.tasks.nextInboxDelay();
      if (seen !== this.notifications || this.controller.signal.aborted) continue;
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, delay);
        this.waiters.add(wake);
      });
    }
  }
  private wake() {
    this.notifications++;
    for (const waiter of this.waiters) waiter();
  }
  stop() { this.controller.abort(); this.wake(); }
}
