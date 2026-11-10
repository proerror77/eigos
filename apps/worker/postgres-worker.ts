import type { WorkClaim } from '../../packages/core/store.js';
import { DomainError } from '../../packages/core/domain.js';
import { withModelUsage } from '../../packages/core/model-usage-context.js';
import { withWorkerClaimRelease } from '../../packages/core/worker-claim-lifecycle.js';
import type { PostgresWorkerStore } from '../../packages/postgres/worker-store.js';
import {postgresWorkerLanes,postgresWorkerReservation,type PostgresWorkerLane,type PostgresWorkerSlots} from '../../packages/postgres/worker-capacity.js';

type WorkerStore = Pick<PostgresWorkerStore, 'claim' | 'renew' | 'active' | 'finish' | 'releaseCheckpoint' | 'beginModelUsage' | 'finishModelUsage'>;
interface Options {
  run(claim: WorkClaim, signal: AbortSignal): Promise<void>;
  leaseMs?: number; pollMs?: number; timeoutMs?: number;
  maxConcurrent?: number;
  slots?:PostgresWorkerSlots;
  onError?(claim: WorkClaim, error: unknown, signal: AbortSignal): Promise<void>;
}
interface Running { controller: AbortController; done: Promise<void>;lane:PostgresWorkerLane }

/** Execution loop for the shared SQL queue. The handler owns each durable
 * business transition; this loop never starts a model inside a transaction. */
export class PostgresTaskWorker {
  private readonly running = new Map<string, Running>();
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private paused = false;
  private stopping = false;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly slots:PostgresWorkerSlots;
  constructor(private readonly store: WorkerStore, private readonly options: Options) {
    this.leaseMs = options.leaseMs ?? 15000; this.pollMs = options.pollMs ?? 100; this.timeoutMs = options.timeoutMs ?? 300000;
    this.slots=Object.freeze({...options.slots??{model:options.maxConcurrent??2,execution:0}});
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 100 || this.leaseMs > 300000
      || !Number.isSafeInteger(this.pollMs) || this.pollMs < 10 || this.pollMs > 60000
      || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error('Invalid PostgreSQL Worker timing');
    if(options.slots&&options.maxConcurrent!==undefined||options.maxConcurrent!==undefined&&(!Number.isInteger(options.maxConcurrent)||options.maxConcurrent<1||options.maxConcurrent>2)
      ||postgresWorkerLanes.some(lane=>!Number.isSafeInteger(this.slots[lane])||this.slots[lane]<0||this.slots[lane]>8)
      ||this.slots.model+this.slots.execution<1)throw new Error('Invalid PostgreSQL Worker concurrency');
  }
  start() {
    if (this.timer || this.paused || this.stopping) return;
    const poll = () => { void this.tick().catch(() => { console.error('PostgreSQL Worker polling failed; durable work retained'); }); };
    this.timer = setInterval(poll, this.pollMs); poll();
  }
  tick(): Promise<void> {
    if (this.stopping || this.paused) return Promise.resolve();
    if (this.polling) return this.polling;
    const poll = async () => {
      while (!this.stopping && !this.paused) {
        const available=postgresWorkerLanes.filter(lane=>[...this.running.values()].filter(run=>run.lane===lane).length<this.slots[lane]);
        if(!available.length)break;
        // The durable queue selects only work that has an available local slot.
        // No lease is acquired merely to wait behind another model invocation.
        const claim = await this.store.claim(['eigos.delegate'], this.leaseMs,available);
        if (!claim) break;
        if (this.stopping || this.paused) { await this.store.finish(claim, () => {}); break; }
        const lane=postgresWorkerReservation(claim.token).lane;
        if(!available.includes(lane)){await this.store.releaseCheckpoint(claim);throw new Error('Worker claim differs from its available capacity');}
        this.execute(claim,lane);
      }
    };
    this.polling = poll().finally(() => { this.polling = undefined; }); return this.polling;
  }
  private execute(claim: WorkClaim,lane:PostgresWorkerLane) {
    const controller = new AbortController(); let renewal: Promise<void> | undefined;
    const lost = () => controller.abort(new DomainError('CONFLICT', 'The original Worker lease or authority ended'));
    const heartbeat = setInterval(() => {
      if (controller.signal.aborted || renewal) return;
      renewal = this.store.renew(claim, this.leaseMs).then(ok => { if (!ok) lost(); }).catch(lost).finally(() => { renewal = undefined; });
    }, Math.max(25, Math.min(5000, Math.floor(this.leaseMs / 3))));
    const stopHeartbeat = () => { clearInterval(heartbeat); };
    const stopAndDrainHeartbeat = async () => { stopHeartbeat(); if (renewal) await renewal; };
    controller.signal.addEventListener('abort', stopHeartbeat, { once: true });
    const timeout = setTimeout(() => controller.abort(new DomainError('CONFLICT', 'Worker execution time budget ended')), this.timeoutMs);
    const run: Running = { controller, done: Promise.resolve(),lane };
    this.running.set(claim.token, run);
    run.done = Promise.resolve().then(async () => {
      if (!await this.store.active(claim)) { lost(); return; }
      controller.signal.throwIfAborted();
      await withWorkerClaimRelease(claim,async()=>{
        await stopAndDrainHeartbeat();controller.signal.throwIfAborted();
      },()=>withModelUsage({ begin: (id, runtime, at) => this.store.beginModelUsage(claim, id, runtime, at),
        finish: (id, evidence, outcome) => this.store.finishModelUsage(claim, id, evidence, outcome) },
      () => this.options.run(claim, controller.signal)));
      // A handler may checkpoint a next phase instead of ending the task. Its
      // original claim is still released before any subsequent polling cycle.
      // The handler has returned. Finish any already-started renewal before
      // releasing its token; a later false heartbeat is then no longer a loss.
      await stopAndDrainHeartbeat();
      await this.store.releaseCheckpoint(claim,controller.signal);
    }).catch(async error => {
      if (this.options.onError) { await this.options.onError(claim, error, controller.signal); return; }
      // Keep uncertain effects and original instructions intact. A generic
      // polling loop cannot infer that a failed business operation may repeat.
      if (!controller.signal.aborted) await this.store.finish(claim, job => {
        if (!['submitted', 'working'].includes(job.state) || !job.delegation) return;
        job.state = 'paused'; job.delegation.phase = 'paused'; job.delegation.nextAt = 0;
        job.updatedAt = new Date().toISOString();
        job.delegation.events.push({ at: job.updatedAt, event: 'worker_interrupted', evidence: 'Execution ended before a committed next phase' });
      });
    }).catch(() => { console.error('PostgreSQL Worker writeback failed; original durable task retained'); }).finally(async () => {
      clearTimeout(timeout); clearInterval(heartbeat); controller.signal.removeEventListener('abort', stopHeartbeat);
      if (renewal) await renewal;
      this.running.delete(claim.token);
    });
  }
  async pauseClaims() {
    this.paused = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    if (this.polling) await this.polling;
    await Promise.all([...this.running.values()].map(run => run.done));
  }
  resumeClaims() { if (this.stopping) throw new Error('PostgreSQL Worker is stopping'); this.paused = false; this.start(); }
  async close() {
    this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    for (const run of this.running.values()) run.controller.abort(new DomainError('CONFLICT', 'Worker is stopping'));
    if (this.polling) await this.polling;
    await Promise.all([...this.running.values()].map(run => run.done));
  }
}
