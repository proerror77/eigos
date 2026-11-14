import { TaskResult,PermissionDenied } from '../../packages/runtime/access.js';
import { Conflict } from '../../packages/core/identity.js';
import { setTimeout as delay } from 'node:timers/promises';
import { Clarification } from '../../packages/runtime/agent.js';
import { Tasks, type Task } from '../../packages/runtime/tasks.js';
import { DeferredExecution } from '../../packages/runtime/scheduled-actions.js';

export class Worker {
  private readonly controller = new AbortController();
  private readonly waiting = new Set<() => void>();
  constructor(private readonly tasks: Tasks, private readonly agent: { run(task: Task, signal: AbortSignal): Promise<unknown> }, private readonly schedules?: {promoteOne():Promise<boolean>}, private readonly scheduledRunner?: {run(task:Task,signal:AbortSignal):Promise<unknown>}) {}
  async runOne(lane?: 'scheduled' | 'interactive'): Promise<boolean> {
    if (lane !== 'interactive') await this.schedules?.promoteOne();
    const task = await this.tasks.claim(lane);
    if (!task) return false;
    await this.execute(task);
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
    } catch (error) {
      if(error instanceof DeferredExecution){await this.tasks.defer(task,error.until).catch(()=>{});return;}
      const clarification = error instanceof Clarification;
      if (!clarification) console.error('Inquiry execution failed', error instanceof Error ? error.message : 'Unknown error');
      const safeError=error instanceof Conflict||error instanceof PermissionDenied?error.message:'Execution failed. Check the original operation and configured source before retrying.';
      await this.tasks.finish(task, clarification ? 'input-required' : 'failed', clarification ? error.choices ?? null : null, clarification ? error.message : safeError, clarification ? error.permissions : []).catch(() => {});
    } finally { clearInterval(timer); await renewing; }
  }
  async run() {
    const listener = await this.tasks.db.pool.connect();
    listener.on('notification', () => this.wake());
    listener.on('error', () => this.controller.abort());
    await listener.query('LISTEN eigos_tasks');
    try {
      if (this.schedules && this.scheduledRunner) {
        // A slow interactive model run cannot hold the one scheduled execution slot.
        const processes = [this.loop('scheduled'), this.loop('interactive')];
        try { await Promise.all(processes); }
        finally { this.stop(); await Promise.allSettled(processes); }
      } else await this.loop();
    } finally { await listener.query('UNLISTEN eigos_tasks').catch(() => {}); listener.release(); }
  }
  private async loop(lane?: 'scheduled' | 'interactive') {
    while (!this.controller.signal.aborted) {
      let resolve!: () => void;
      const signal = new Promise<void>(wake => { resolve = wake; });
      this.waiting.add(resolve);
      const timer = new AbortController();
      try {
        if (await this.runOne(lane)) continue;
        await Promise.race([signal, delay(lane === 'scheduled' ? 1000 : 5000, undefined,
          { signal: AbortSignal.any([this.controller.signal, timer.signal]) }).catch(() => {})]);
      } finally { this.waiting.delete(resolve); timer.abort(); }
    }
  }
  private wake() { for (const resolve of this.waiting) resolve(); }
  stop() { this.controller.abort(); this.wake(); }
}
