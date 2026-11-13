import { setTimeout as delay } from 'node:timers/promises';
import { Clarification } from '../../packages/runtime/agent.js';
import { Tasks, type Task } from '../../packages/runtime/tasks.js';

export class Worker {
  private readonly controller = new AbortController();
  private wake?: () => void;
  constructor(private readonly tasks: Tasks, private readonly agent: { run(task: Task, signal: AbortSignal): Promise<unknown> }) {}
  async runOne(): Promise<boolean> {
    const task = await this.tasks.claim();
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
      const result = await this.agent.run(task, signal);
      signal.throwIfAborted();
      await this.tasks.finish(task, 'completed', result);
    } catch (error) {
      const clarification = error instanceof Clarification;
      if (!clarification) console.error('Inquiry execution failed', error instanceof Error ? error.message : 'Unknown error');
      await this.tasks.finish(task, clarification ? 'input-required' : 'failed', clarification ? error.choices ?? null : null, clarification ? error.message : 'Inquiry failed. Check the configured source or retry with a new request ID.').catch(() => {});
    } finally { clearInterval(timer); await renewing; }
  }
  async run() {
    const listener = await this.tasks.db.pool.connect();
    listener.on('notification', () => this.wake?.());
    listener.on('error', () => this.controller.abort());
    await listener.query('LISTEN eigos_tasks');
    try {
      while (!this.controller.signal.aborted) {
        if (await this.runOne()) continue;
        await Promise.race([new Promise<void>(resolve => { this.wake = resolve; }), delay(5000, undefined, { signal: this.controller.signal }).catch(() => {})]);
      }
    } finally { await listener.query('UNLISTEN eigos_tasks').catch(() => {}); listener.release(); }
  }
  stop() { this.controller.abort(); this.wake?.(); }
}
