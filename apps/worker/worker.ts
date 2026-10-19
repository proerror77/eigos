import type { Coordinator } from '../../packages/coordinator/coordinator.js';
import { randomUUID } from 'node:crypto';
import { JobStore, type WorkClaim } from '../../packages/core/store.js';

export interface WorkerOptions {
  coordinator: Pick<Coordinator, 'run'>;
  pollMs?: number;
  leaseMs?: number;
  timeoutMs?: number;
}

// No HTTP listener or user Bearer token. Claims and fenced writes are in the shared core.
export class Worker {
  private running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  constructor(private store: JobStore, private options: WorkerOptions) {
    this.leaseMs = options.leaseMs ?? 15000;
    this.pollMs = options.pollMs ?? 100;
    if (this.leaseMs < 100 || this.pollMs < 10) throw new Error('Invalid Worker timing');
  }

  start(): void {
    if (this.timer || this.stopping) return;
    this.tick();
    this.timer = setInterval(() => {
      try { this.tick(); } catch { console.error('Worker polling failed; durable work retained'); }
    }, this.pollMs);
  }

  tick(): void {
    if (this.stopping) return;
    const services = ['eigos.delegate'];
    while (this.running.size < 2) {
      const claim = this.store.claim(services, this.leaseMs);
      if (!claim) break;
      this.execute(claim);
    }
  }

  private execute(claim: WorkClaim): void {
    const { job, owner } = claim;
    const controller = new AbortController();
    const run = { controller, done: Promise.resolve() };
    this.running.set(job.id, run);
    const heartbeat = setInterval(() => {
      try { if (!this.store.renew(claim, this.leaseMs)) controller.abort(); }
      catch { controller.abort(); }
    }, Math.min(this.pollMs, Math.floor(this.leaseMs / 3)));
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 300000);
    run.done = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw new Error('Execution interrupted');
      await this.options.coordinator.run(claim, controller.signal);
    }).catch(error => {
      this.store.finish(claim, current => {
        const intentId = current.delegation?.intentId;
        const dispatched = current.delegation?.agent ? this.store.intents(owner, current.id).some(i => this.store.attempts(owner, i.id).length > 0) : intentId ? this.store.intent(owner, intentId).state !== 'ready' : false;
        current.state = 'failed'; if (current.delegation) current.delegation.phase = 'failed'; current.updatedAt = new Date().toISOString();
        current.error = controller.signal.aborted ? 'Worker execution interrupted; inspect recorded observations before retrying.'
          : dispatched ? 'Action did not return an accepted result. Inspect recorded observations; no automatic replay.'
          : 'Ontology backend could not validate a supported plan. No business action was dispatched.';
        current.messages.push({ id: randomUUID(), role: 'agent', text: current.error, at: current.updatedAt });
      });
    }).finally(() => {
      clearInterval(heartbeat); clearTimeout(timeout);
      // Keep an unresolved working claim until expiry if writeback failed.
      try { if (this.store.get(owner, job.id).state !== 'working') this.store.release(claim); }
      finally { this.running.delete(job.id); }
    });
    // A storage failure must not cause an unhandled rejection or silently replay this attempt.
    void run.done.catch(() => console.error('Worker writeback failed; lease recovery required'));
  }

  async close(): Promise<void> {
    this.stopping = true; clearInterval(this.timer);
    for (const run of this.running.values()) run.controller.abort();
    await Promise.allSettled([...this.running.values()].map(run => run.done));
  }
}
