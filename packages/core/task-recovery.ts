import { digest } from './delegation.js';
import type { Job } from './domain.js';
import type { ActionIntent } from '../ontology/actions.js';

export function canRecoverReadOnly(job: Job, intents: Pick<ActionIntent, 'effect'>[]): boolean {
  const readOnly = (effect: string) => effect === 'read' || effect === 'local';
  return intents.every(intent => readOnly(intent.effect))
    && (job.delegation?.plan?.steps ?? []).every(step => [step.effect, ...(step.additionalEffects ?? [])].every(readOnly));
}
/** Source renewal may preserve already confirmed effects. Unknown writes must
 * first be reconciled under their original authority and operation identity. */
export function canResumeSource(job: Job, intents: Pick<ActionIntent, 'effect' | 'state'>[]): boolean {
  return canRecoverReadOnly(job, intents) || !!job.delegation?.agent?.composition
    && intents.every(intent => ['read', 'local'].includes(intent.effect) || ['effect_confirmed', 'rejected', 'canceled_before_dispatch'].includes(intent.state));
}

export type RecoveryCode = 'worker_interrupted' | 'worker_timeout' | 'model_unavailable' | 'provider_read_unavailable' | 'reasoning_incomplete' | 'validation_stalled';
export interface TaskRecovery {
  version: '1'; code: RecoveryCode; state: 'scheduled' | 'running' | 'blocked' | 'resolved';
  attempts: number; maxAttempts: number; fingerprint: string; lastFailureAt: string;
  retryAt?: string; resolvedAt?: string; previousPhase: string; message: string;
  operation?: string;
  ownerInputRequired: false; nextAction: 'wait_for_retry' | 'restore_runtime_then_resume' | 'none';
}

/** A technical retry continues the same goal. It never fabricates an owner
 * reply, creates a task, grants authorization, or replays an old effect. */
export function scheduleTaskRecovery(job: Job, code: RecoveryCode, message: string, options: { now?: number; automatic?: boolean; operation?: string } = {}) {
  const d = job.delegation!, now = options.now ?? Date.now(), at = new Date(now).toISOString();
  const fingerprint = digest({ code, operation: options.operation, requestId: d.request.id, requestRevision: d.request.revision, program: d.agent?.programDigest ?? d.suspendedAgent?.programDigest });
  const old = d.recovery, attempts = old?.fingerprint === fingerprint && old.state !== 'resolved' ? old.attempts + 1 : 1;
  if (old && (old.fingerprint !== fingerprint || old.state === 'resolved')) d.recoveryHistory = [...(d.recoveryHistory ?? []), old];
  const blocked = options.automatic === false || attempts >= 3;
  const retryAt = blocked ? undefined : new Date(now + (attempts === 1 ? 1000 : 5000)).toISOString();
  const previousPhase = d.phase === 'recovering' || d.phase === 'paused' ? old?.previousPhase ?? (d.agent ? 'planning' : 'grounding') : d.phase;
  d.recovery = { version: '1', code, state: blocked ? 'blocked' : 'scheduled', attempts, maxAttempts: 3, fingerprint, lastFailureAt: at, retryAt,
    previousPhase, message, operation: options.operation, ownerInputRequired: false, nextAction: blocked ? 'restore_runtime_then_resume' : 'wait_for_retry' };
  job.state = blocked ? 'paused' : 'working'; d.phase = blocked ? 'paused' : 'recovering'; d.nextAt = retryAt ? Date.parse(retryAt) : 0;
  job.updatedAt = at; delete job.question; delete job.error;
  d.events.push({ at, event: blocked ? 'technical_recovery_paused' : 'technical_recovery_scheduled', evidence: `${code}:${attempts}` });
}

export function resumeScheduledRecovery(job: Job) {
  const d = job.delegation!, r = d.recovery;
  if (r?.state !== 'scheduled') return;
  r.state = 'running'; r.nextAction = 'none'; d.nextAt = 0;
  d.phase = d.agent ? (d.agent.pendingPlanId ? 'executing' : 'planning') : d.plan ? 'executing' : 'grounding';
  d.events.push({ at: new Date().toISOString(), event: 'technical_recovery_started', evidence: r.code });
}

export function resolveTaskRecovery(job: Job, progress: 'model' | 'decision' | 'source', operation?: string) {
  const r = job.delegation?.recovery;
  if (!r || r.state === 'resolved' || r.state === 'blocked' || r.code === 'provider_read_unavailable' && (progress !== 'source' || r.operation !== operation)) return;
  if (r.code === 'reasoning_incomplete' && progress === 'model') return;
  r.state = 'resolved'; r.resolvedAt = new Date().toISOString(); r.nextAction = 'none'; delete r.retryAt;
  job.delegation!.events.push({ at: r.resolvedAt, event: 'technical_recovery_resolved', evidence: r.code });
}
