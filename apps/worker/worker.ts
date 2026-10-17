import type { Coordinator } from '../../packages/coordinator/coordinator.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../packages/core/domain.js';
import { JobStore, type WorkClaim } from '../../packages/core/store.js';
import { decisionSchema, type Executor } from '../../packages/capabilities/executor.js';
import { paotuiQuerySchema, type PaotuiReader } from '../../packages/capabilities/paotui-contracts.js';
import type { PaotuiOrderRunner } from '../../packages/capabilities/paotui-orders.js';

export interface WorkerOptions {
  coordinator?: Pick<Coordinator, 'run'>;
  executor?: Executor;
  paotui?: PaotuiReader;
  paotuiOrders?: PaotuiOrderRunner;
  maintenance?: () => void;
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
  constructor(private store: JobStore, private options: WorkerOptions = {}) {
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
    // Registered local background transitions are serialized with Gateway mutations.
    if (this.options.maintenance) this.store.transaction(this.options.maintenance);
    const services = [
      ...(this.options.coordinator ? ['eigos.delegate'] : []),
      ...(this.options.executor ? ['agent.execute'] : []),
      ...(this.options.paotui ? ['meituan.paotui.read'] : []),
      ...(this.options.paotuiOrders ? ['meituan.paotui.order'] : []),
    ];
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
      if (job.service === 'eigos.delegate') {
        await this.options.coordinator!.run(claim, controller.signal);
      } else if (job.service === 'agent.execute') {
        if ((job.runs?.length ?? 0) >= 6) throw new Error('Maximum model turns reached');
        const response = await this.options.executor!.run(structuredClone(job), controller.signal);
        const output = decisionSchema.parse(response.output);
        if (controller.signal.aborted) throw new Error('Execution interrupted');
        this.store.finish(claim, current => {
          current.updatedAt = new Date().toISOString();
          current.runs = [...(current.runs ?? []), response.evidence];
          current.messages.push({ id: randomUUID(), role: 'agent', text: output.message, at: current.updatedAt });
          if (output.decision === 'ask_user') { current.state = 'input-required'; current.question = output.message; }
          else {
            current.state = 'completed'; delete current.question;
            current.artifact = { id: randomUUID(), name: 'deliverable.md', data: {
              goal: current.goal, deliverable: output.message, execution: 'completed', markdown: output.artifact,
            } };
          }
        });
      } else {
        const data = job.service === 'meituan.paotui.order'
          ? await this.options.paotuiOrders!.run(owner, JSON.parse(job.goal), controller.signal)
          : await this.options.paotui!.query(paotuiQuerySchema.parse(JSON.parse(job.goal)), controller.signal);
        if (controller.signal.aborted) throw new Error('Execution interrupted');
        this.store.finish(claim, current => {
          current.state = 'completed'; current.updatedAt = new Date().toISOString();
          current.artifact = { id: randomUUID(), name: 'meituan-operation-result.json', data: {
            goal: current.goal, deliverable: job.service === 'meituan.paotui.order'
              ? 'Paotui operation result. Inspect workflow state; this does not prove payment or delivery.'
              : 'Read-only Meituan query result; no order or payment was performed.', execution: 'completed', result: data,
          } };
          current.messages.push({ id: randomUUID(), role: 'agent', text: current.artifact.data.deliverable, at: current.updatedAt });
        });
      }
    }).catch(error => {
      this.store.finish(claim, current => {
        const intentId = current.delegation?.intentId;
        const dispatched = intentId ? this.store.intent(owner, intentId).state !== 'ready' : false;
        current.state = 'failed'; if (current.delegation) current.delegation.phase = 'failed'; current.updatedAt = new Date().toISOString();
        current.error = controller.signal.aborted ? 'Worker execution interrupted; inspect external outcome before retrying.'
          : job.service === 'eigos.delegate' ? dispatched ? 'Action did not return an accepted result. Inspect recorded observations before any new attempt; no automatic replay.' : 'Ontology backend could not validate a supported plan. No business action was dispatched.'
          : job.service !== 'agent.execute' ? (error instanceof DomainError ? error.message : 'Meituan operation failed. Check local authorization and connectivity.')
          : error instanceof z.ZodError ? 'Executor output did not match the required schema' : 'Model execution failed; check Worker provider availability.';
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
