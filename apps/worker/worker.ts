import { ModelSessionError } from '../../packages/capabilities/model-session.js';
import type { Coordinator } from '../../packages/coordinator/coordinator.js';
import { randomUUID } from 'node:crypto';
import { JobStore, type WorkClaim } from '../../packages/core/store.js';
import { ReasoningBudgetExhausted } from '../../packages/core/execution-budget.js';
import { scheduleTaskRecovery, resumeScheduledRecovery, canRecoverReadOnly, canResumeSource } from '../../packages/core/task-recovery.js';
import { withModelUsage } from '../../packages/core/model-usage-context.js';
import { ConnectionAuthorizationRequired, DomainError } from '../../packages/core/domain.js';
import { withAuthorization, type AuthorizationScope } from '../../packages/security/context.js';
import type { RecoveryWork } from '../../packages/security/recovery.js';
import { partialGoalArtifact } from '../../packages/coordinator/goal-program.js';

export interface WorkerOptions {
  coordinator: Pick<Coordinator, 'run'> & Partial<Pick<Coordinator, 'releaseModelContext' | 'closeModelContexts' | 'claimRecovery' | 'recover'>>;
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
      if (!claim) {
        const recovery=this.options.coordinator.recover && this.options.coordinator.claimRecovery?.();
        if(recovery){this.executeRecovery(recovery);continue;}
        break;
      }
      this.execute(claim);
    }
  }
  private executeRecovery(work:RecoveryWork) {
    const key=`recovery:${work.permit.id}`,controller=new AbortController(),run={controller,done:Promise.resolve()};this.running.set(key,run);
    const heartbeat=setInterval(()=>{if(!this.store.security.recoveries.renew(work))controller.abort();},Math.min(this.pollMs,5000));
    const timeout=setTimeout(()=>controller.abort(),this.options.timeoutMs??300000);
    run.done=Promise.resolve().then(()=>this.options.coordinator.recover!(work,controller.signal)).catch(()=>this.store.security.recoveries.finish(work)).finally(()=>{
      clearInterval(heartbeat);clearTimeout(timeout);this.running.delete(key);
    });
    void run.done.catch(()=>console.error('Original-operation audit writeback failed; no business replay'));
  }

  private execute(claim: WorkClaim): void {
    const { job, owner } = claim;
    const controller = new AbortController();
    let scope:AuthorizationScope|undefined;
    const run = { controller, done: Promise.resolve() };
    const inScope = <T>(action: () => T): T => scope ? withAuthorization(scope, action) : action();
    this.running.set(job.id, run);
    const heartbeat = setInterval(() => {
      try { scope?.assertCurrent(); if (!this.store.renew(claim, this.leaseMs)) controller.abort(); }
      catch { controller.abort(); }
    }, Math.min(this.pollMs, Math.floor(this.leaseMs / 3)));
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 300000);
    run.done = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw new Error('Execution interrupted');
      scope=this.store.security.enabled ? this.store.security.workerScope(owner,job.id,claim.securityAuthorityId!,claim.token) : undefined;
      const execute = async () => {
      if (claim.job.delegation?.recovery?.state === 'scheduled') {
        if (!this.store.checkpoint(claim, current => resumeScheduledRecovery(current))) return;
        claim.job = this.store.get(owner, job.id);
      }
      await withModelUsage({ begin: (id, runtime, startedAt) => this.store.beginModelUsage(claim, id, runtime, startedAt),
        finish: (id, evidence, outcome) => this.store.finishModelUsage(claim, id, evidence, outcome) }, () => this.options.coordinator.run(claim, controller.signal));
      };
      if(scope) await withAuthorization(scope,execute); else await execute();
    }).catch(error => inScope(() => {
      this.store.finish(claim, current => {
        if (current.delegation?.agent?.composition && !current.artifact) current.artifact = partialGoalArtifact({ graph: this.store.ontologyForJob(owner, current), owner,
          request: current.delegation.request, state: current.delegation.agent, intents: this.store.intents(owner, current.id), modelRuns: current.runs });
        if (error instanceof ModelSessionError) current.delegation?.events.push({ at: new Date().toISOString(), event: 'worker_model_failed', evidence: `${error.stage}/${error.code}` });
        const readOnly = canRecoverReadOnly(current, this.store.intents(owner, current.id));
        if (error instanceof ReasoningBudgetExhausted && !controller.signal.aborted && current.delegation && readOnly) {
          scheduleTaskRecovery(current, 'reasoning_incomplete', '推理尚未形成有效决策，系统将保留当前信息继续处理，无需重复补充。');
          return;
        }
        if (error instanceof ConnectionAuthorizationRequired && error.connection && !controller.signal.aborted && current.delegation && canResumeSource(current, this.store.intents(owner, current.id))) {
          const d = current.delegation;
          current.state = 'auth-required'; d.phase = 'awaiting_authorization';
          d.sourceAuthorization = structuredClone(error.connection);
          current.updatedAt = new Date().toISOString(); current.question = error.message; delete current.error;
          current.messages.push({ id: randomUUID(), role: 'agent', text: error.message, at: current.updatedAt });
          return;
        }
        const intentId = current.delegation?.intentId;
        const dispatched = current.delegation?.agent ? this.store.intents(owner, current.id).some(i => this.store.attempts(owner, i.id).length > 0) : intentId ? this.store.intent(owner, intentId).state !== 'ready' : false;
        if (current.delegation && readOnly) {
          if (error instanceof DomainError && !controller.signal.aborted) {
            scheduleTaskRecovery(current, 'validation_stalled', '当前执行未通过权限或状态校验。原任务与确认信息保留，需修复运行条件后继续。', { automatic: false });
            return;
          }
          scheduleTaskRecovery(current, controller.signal.aborted ? this.stopping ? 'worker_interrupted' : 'worker_timeout' : 'model_unavailable',
            '运行暂时中断，原任务、已确认信息和执行记录均已保留。系统会自动恢复；持续异常时等待运行环境修复，无需重复确认业务信息。');
          return;
        }
        current.state = 'failed'; if (current.delegation) current.delegation.phase = 'failed'; current.updatedAt = new Date().toISOString();
        current.error = controller.signal.aborted ? 'Worker execution interrupted; inspect recorded observations before retrying.'
          : error instanceof ModelSessionError ? 'Worker model planning failed; existing observations retained, no automatic replay. Inspect the bounded failure event.'
          : dispatched ? 'Action did not return an accepted result. Inspect recorded observations; no automatic replay.'
          : 'Ontology backend could not validate a supported plan. No business action was dispatched.';
        current.messages.push({ id: randomUUID(), role: 'agent', text: current.error, at: current.updatedAt });
      });
    })).finally(() => inScope(async () => {
      clearInterval(heartbeat); clearTimeout(timeout);
      // Keep an unresolved working claim until expiry if writeback failed.
      try { if (this.store.get(owner, job.id).state !== 'working') this.store.release(claim); }
      finally { this.running.delete(job.id); await this.options.coordinator.releaseModelContext?.(claim); }
    }));
    // A storage failure must not cause an unhandled rejection or silently replay this attempt.
    void run.done.catch(() => console.error('Worker writeback failed; lease recovery required'));
  }

  async close(): Promise<void> {
    this.stopping = true; clearInterval(this.timer);
    for (const run of this.running.values()) run.controller.abort();
    await Promise.allSettled([...this.running.values()].map(run => run.done));
    await this.options.coordinator.closeModelContexts?.();
  }
}
