import { randomUUID } from 'node:crypto';
import { DomainError, ReplanRequired, type Job } from '../core/domain.js';
import type { JobStore, WorkClaim } from '../core/store.js';
import { isActionAdapter, type ExecutionCatalog, type Delivery } from '../core/catalog.js';
import { digest } from '../core/delegation.js';
import { authorizeDispatch } from '../core/policy.js';
import { BACKEND_VERSION, type ExecutionPlan, type PlanStep } from '../ontology/execution.js';
import type { ActionContext, ActionIntent, ActionResult, ExecutionAttempt, OutcomeAssessment } from '../ontology/actions.js';
import { validatePlan } from './plan.js';
import { checkRequirements, hardRequirementsPass } from './resolver.js';

export function createActionIntents(store: JobStore, owner: string, job: Job, privateData: unknown): void {
  const plan = job.delegation!.plan!; const ids: string[] = [];
  for (const step of plan.steps) {
    const id = randomUUID();
    ids.push(store.createIntent(owner, { id, owner, jobId: job.id, stepId: step.id, businessOperationKey: digest({ owner, requestId: job.delegation!.request.businessScopeId ?? plan.requestId, operationId: step.operationId }),
      planDigest: plan.digest, bindingRef: step.bindingRef, inputDigest: digest({ input: step.input, inputRefs: step.inputRefs }), privateDigest: digest(privateData ?? null), privateData: privateData ?? null,
      effect: step.effect, state: 'ready', nextAt: Date.now(), createdAt: new Date().toISOString() }));
  }
  job.delegation!.intentIds = ids; job.delegation!.intentId = ids[0];
}
function materializeInput(step: PlanStep, intents: ActionIntent[]): Record<string, unknown> {
  const input = structuredClone(step.input);
  for (const ref of step.inputRefs) {
    const source = intents.find(i => i.stepId === ref.stepId);
    if (source?.state !== 'effect_confirmed' || !source.acceptedOutput) throw new DomainError('CONFLICT', 'Referenced step has no accepted output');
    let value: unknown = source.acceptedOutput;
    for (const part of ref.path.split('.')) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) throw new DomainError('CONFLICT', 'Accepted output reference does not resolve');
      value = (value as Record<string, unknown>)[part];
    }
    input[ref.targetKey] = structuredClone(value);
  }
  return input;
}
export class ActionRuntime {
  constructor(private store: JobStore, private catalog: ExecutionCatalog, private options: { allowSandbox?: boolean; maxTaskMs?: number } = {}) {}
  async run(claim: WorkClaim, signal: AbortSignal): Promise<void> {
    const job = this.store.get(claim.owner, claim.job.id); const d = job.delegation;
    if (d?.backendVersion !== BACKEND_VERSION || !d.plan || !d.intentIds?.length) throw new DomainError('CONFLICT', 'Current execution plan and action intents required');
    const plan = d.plan; validatePlan(this.catalog, claim.owner, d.request, plan, Date.now(), 'observe');
    const expired = Date.now() - Date.parse(job.createdAt) >= (this.options.maxTaskMs ?? 86400000);
    const queriesOnly = expired && !!d.manualReconciliation;
    if (expired && !queriesOnly) {
      if (claim.recovery) this.finishRecovery(claim, this.store.intents(claim.owner, job.id), true);
      else this.pause(claim, 'input-required', '自动等待已到任务时限，已停止新派发。未知支出仍保留，可用原任务对账；不会重下单。');
      return;
    }
    for (let turn = 0; turn < 8; turn++) {
      signal.throwIfAborted(); const intents = this.store.intents(claim.owner, job.id);
      const ordered = plan.steps.map(step => ({ step, intent: intents.find(i => i.stepId === step.id)! }));
      if (ordered.some(x => !x.intent || x.intent.planDigest !== plan.digest)) throw new DomainError('CONFLICT', 'Plan/action binding is incomplete');
      if (claim.recovery) {
        const active = ordered.find(x => ['dispatching', 'awaiting_remote', 'effect_unknown'].includes(x.intent.state)) ?? ordered.find(x => x.intent.needsObservation);
        if (!active) { this.finishRecovery(claim, intents); return; }
        if (active.intent.nextAt > Date.now()) { this.wait(claim, active.intent.nextAt, true); return; }
        await this.attempt(claim, plan, active.step, active.intent, intents, signal, queriesOnly); this.finishRecovery(claim, this.store.intents(claim.owner, job.id), queriesOnly); return;
      }
      const current = ordered.find(x => x.intent.state !== 'effect_confirmed');
      if (!current) { this.assess(claim, plan, intents); return; }
      if (current.intent.state === 'needs_review' || current.intent.state === 'canceled_before_dispatch') { this.pause(claim, 'input-required', '动作结果需要查证。请使用原任务的对账入口；不会自动重下单或更换提供者。'); return; }
      if (current.intent.state === 'rejected') { this.fail(claim, 'Provider rejected the fixed business action', 'unsatisfied'); return; }
      if (queriesOnly && current.intent.state === 'ready' && current.step.effect !== 'read') { this.pause(claim, 'input-required', '已过自动执行时限；原操作可查询，新的业务或模型调用需要另行处理。'); return; }
      if (!current.step.dependsOn.every(id => intents.some(i => i.stepId === id && i.state === 'effect_confirmed'))) throw new DomainError('CONFLICT', 'Action dependencies are not accepted');
      if (current.intent.nextAt > Date.now()) { this.wait(claim, current.intent.nextAt); return; }
      const attempted = await this.attempt(claim, plan, current.step, current.intent, intents, signal, queriesOnly);
      if (!attempted) return;
      const updated = this.store.intent(claim.owner, current.intent.id);
      if (updated.state === 'effect_confirmed') continue;
      if (updated.lastResult?.kind === 'requires_input') { this.pause(claim, 'input-required', updated.lastResult.message ?? '提供方需要补充信息。', updated.id); return; }
      if (updated.lastResult?.kind === 'requires_authorization') { this.pause(claim, 'auth-required', updated.lastResult.message ?? '当前动作需要准确计划授权。'); return; }
      if (updated.state === 'needs_review') { this.pause(claim, 'input-required', '原操作连续查证失败或回执冲突，需要人工检查；保留未知费用占用。'); return; }
      if (updated.state === 'rejected') { this.fail(claim, 'Provider rejected the fixed business action', 'unsatisfied'); return; }
      if (queriesOnly) { this.pause(claim, 'input-required', '本次已查询原操作，仍未取得完整终态证据；自动等待已停止，未知支出未释放。'); return; }
      this.wait(claim, Math.max(Date.now() + 100, updated.nextAt)); return;
    }
    this.wait(claim, Date.now() + 100);
  }
  private async attempt(claim: WorkClaim, plan: ExecutionPlan, step: PlanStep, intent: ActionIntent, intents: ActionIntent[], signal: AbortSignal, queriesOnly = false): Promise<boolean> {
    const current = this.store.get(claim.owner, claim.job.id); const ctx = { owner: claim.owner, request: current.delegation!.request };
    const { adapter } = this.catalog.binding(step.bindingRef, claim.owner, ctx.request.id);
    if (digest(intent.privateData) !== intent.privateDigest || digest({ input: step.input, inputRefs: step.inputRefs }) !== intent.inputDigest) throw new DomainError('CONFLICT', 'Prepared input snapshot changed');
    const input = materializeInput(step, intents); if (isActionAdapter(adapter)) adapter.validateInput(step, input);
    const reply = !claim.recovery && !queriesOnly && current.delegation!.actionReply?.intentId === intent.id ? current.delegation!.actionReply : undefined;
    const resumeKey = reply ? digest({ operation: intent.businessOperationKey, messageId: reply.messageId }) : undefined;
    const alreadyResumed = resumeKey && this.store.attempts(claim.owner, intent.id).some(a => a.kind === 'resume' && a.requestKey === resumeKey);
    const kind: ExecutionAttempt['kind'] = intent.state === 'ready' ? 'dispatch' : reply && !alreadyResumed ? 'resume' : (intent.needsObservation || intent.state === 'awaiting_remote') && !alreadyResumed ? 'observe' : 'reconcile';
    if (kind === 'resume' && isActionAdapter(adapter) && !adapter.resume) { this.pause(claim, 'input-required', '提供方不支持自动续接，请人工处理当前远端任务。', intent.id); return false; }
    if (claim.recovery && kind === 'dispatch') return false;
    const freshPermit = kind === 'dispatch' || kind === 'resume' && !['local', 'read'].includes(intent.effect);
    if (freshPermit) {
      validatePlan(this.catalog, claim.owner, ctx.request, plan, Date.now(), queriesOnly && step.effect === 'read' ? 'observe' : 'dispatch');
      const approval = current.delegation!.approval;
      if (plan.quote && (!approval?.simulationOnly || approval.planDigest !== plan.digest || approval.quoteDigest !== plan.quote.digest)) { this.pause(claim, 'auth-required', '请批准当前准确的本地模拟报价。'); return false; }
    }
    let attempt: ExecutionAttempt | undefined;
    try {
      if (!this.store.checkpoint(claim, job => {
        if (freshPermit) authorizeDispatch(this.store, claim.owner, plan, step, intent, adapter, this.options.allowSandbox === true);
        attempt = this.store.startAttempt(claim, intent.id, kind, digest(input), kind === 'resume' ? resumeKey : undefined);
        job.updatedAt = new Date().toISOString(); job.delegation!.phase = 'executing';
        job.delegation!.events.push({ at: job.updatedAt, event: `action_${kind}_started`, evidence: attempt.id });
      })) return false;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'FORBIDDEN') { this.pause(claim, 'auth-required', error.message); return false; } throw error;
    }
    const action: ActionContext = { owner: claim.owner, requestId: plan.requestId, requestRevision: plan.requestRevision, goal: ctx.request.originalGoal, messages: current.messages, modelReceipts: current.runs, plan, step, intent, attempt: attempt!, input, ...(reply ? { reply: { messageId: reply.messageId, answer: reply.answer } } : {}) };
    let result: ActionResult; let verified = false;
    try {
      if (isActionAdapter(adapter)) {
        result = kind === 'dispatch' ? await adapter.dispatch(action, intent.privateData, signal) : kind === 'observe' ? await adapter.observe(action, intent.privateData, signal)
          : kind === 'resume' ? adapter.resume ? await adapter.resume(action, intent.privateData, signal) : { kind: 'requires_input', eventId: attempt!.id, sourceVersion: intent.latestVersion ?? 0, evidenceRefs: [], message: '提供方不支持自动续接，需要人工处理。' }
          : await adapter.reconcile(action, intent.privateData, signal);
        verified = result.kind === 'unknown' || adapter.verifyAction(action, result).accepted;
      } else {
        const delivery = await adapter.execute(ctx, { ...plan, steps: [{ ...step, input }] }, intent.privateData, signal);
        result = { kind: 'confirmed', eventId: attempt!.id, sourceVersion: this.store.attempts(claim.owner, intent.id).length, delivery, evidenceRefs: delivery.evidenceRefs, output: { artifactId: delivery.artifact.id } }; verified = true;
      }
    } catch (error) {
      if (error instanceof ReplanRequired && intents.every(i => ['read', 'local'].includes(i.effect))) {
        this.store.recordObservation(claim.owner, intent.id, attempt!.id, { kind: 'rejected', eventId: `${attempt!.id}:stale`, sourceVersion: this.store.attempts(claim.owner, intent.id).length, evidenceRefs: [], message: error.message }, true);
        this.store.finish(claim, job => {
          const d = job.delegation!; d.replans = (d.replans ?? 0) + 1;
          if (d.replans > 3) { job.state = 'input-required'; job.question = '报价持续变化，已停止自动刷新；请稍后重新核实。'; d.phase = 'clarifying'; return; }
          d.planHistory = [...(d.planHistory ?? []), plan]; delete d.plan; delete d.intentId; delete d.intentIds; delete d.actions; d.phase = 'grounding'; d.nextAt = 0;
          job.state = 'submitted'; job.revision = (job.revision ?? 0) + 1; job.updatedAt = new Date().toISOString();
          d.events.push({ at: job.updatedAt, event: 'read_plan_invalidated', evidence: plan.digest });
        });
        return false;
      }
      result = { kind: 'unknown', eventId: `${attempt!.id}:unknown`, sourceVersion: intent.latestVersion ?? 0, evidenceRefs: [], message: 'Operation result unknown; query the original business operation before any further effect.' }; verified = true;
    }
    this.store.recordObservation(claim.owner, intent.id, attempt!.id, result, verified);
    if (result.runEvidence) this.store.checkpoint(claim, job => { if (!(job.runs ?? []).some(r => r.id === result.runEvidence!.id)) job.runs = [...(job.runs ?? []), result.runEvidence!]; });
    if (reply && result.kind !== 'unknown') this.store.checkpoint(claim, job => { if (job.delegation!.actionReply?.messageId === reply.messageId) { delete job.delegation!.actionReply; delete job.delegation!.pendingActionInput; } });
    if (!isActionAdapter(adapter) && result.kind === 'unknown') { this.fail(claim, 'Read/local action did not return an accepted result. Inspect recorded observations before any new attempt.', 'unknown'); return false; }
    return true;
  }
  private assess(claim: WorkClaim, plan: ExecutionPlan, intents: ActionIntent[]): void {
    const job = this.store.get(claim.owner, claim.job.id); const final = plan.steps.at(-1)!; const intent = intents.find(i => i.stepId === final.id)!;
    if (!intent.delivery) { this.pause(claim, 'input-required', '操作已确认，但没有用户目标的交付和独立验收证据；订单号不等于送达。'); return; }
    const { adapter, binding } = this.catalog.binding(plan.bindingRef, claim.owner, plan.requestId);
    const ctx = { owner: claim.owner, request: job.delegation!.request }; const delivery = intent.delivery;
    const verdict = adapter.verify(ctx, plan, intent.privateData, delivery);
    const outcomeRequest = { ...ctx.request, requirements: [...ctx.request.requirements, ...(ctx.request.successCriteria ?? [])] };
    const definition = this.catalog.capability(plan.capabilityRef);
    const checks = checkRequirements(outcomeRequest, delivery.facts, delivery.evidenceRefs, definition.predicates.map(p => p.id), definition.locationSemantics);
    const target = ctx.request.outcome ?? plan.completionTarget;
    const business = intent.businessSnapshot?.value;
    const goalSatisfied = target === 'artifact' || target === 'delivery' && business?.fulfillment === 'delivered' || target === 'order' && business?.order === 'confirmed' || target === 'refund' && business?.refund === 'refunded' || target === 'cancel' && business?.order === 'canceled';
    const accepted = goalSatisfied && verdict.accepted && delivery.evidenceRefs.length > 0 && hardRequirementsPass(outcomeRequest, checks);
    const outcome: OutcomeAssessment = { requestId: plan.requestId, requestRevision: plan.requestRevision, status: accepted ? 'satisfied' : 'unsatisfied',
      criterionResults: [...checks.map(c => ({ requirementId: c.requirementId, status: c.result === 'pass' ? 'satisfied' as const : c.result === 'fail' ? 'unsatisfied' as const : 'unknown' as const, evidenceRefs: c.evidenceRefs })),
        { requirementId: 'independent_verifier', status: verdict.accepted ? 'satisfied' : 'unsatisfied', evidenceRefs: delivery.evidenceRefs }, { requirementId: `goal.${target}`, status: goalSatisfied ? 'satisfied' : 'unknown', evidenceRefs: delivery.evidenceRefs }], reason: verdict.reason, evidenceRefs: delivery.evidenceRefs, assessedAt: new Date().toISOString() };
    this.store.finish(claim, current => {
      current.updatedAt = outcome.assessedAt; current.state = accepted ? 'completed' : 'failed'; current.delegation!.phase = accepted ? 'accepted' : 'failed';
      current.delegation!.outcome = outcome; current.delegation!.acceptance = { accepted, reason: verdict.reason, checks, evidenceRefs: delivery.evidenceRefs, at: outcome.assessedAt };
      delete current.delegation!.manualReconciliation;
      current.delegation!.recoveryPending = false; delete current.delegation!.actionReply; delete current.delegation!.pendingActionInput; delete current.question;
      if (accepted) current.artifact = delivery.artifact; else current.error = 'Independent goal verification failed or hard criteria were unmet';
      const level = isActionAdapter(adapter) ? adapter.environment === 'sandbox' ? 'sandbox' : final.effect === 'local' ? 'model_generated' : target === 'delivery' && accepted ? 'live_fulfillment' : 'live_operation' : binding.verification.level === 'live_fulfillment' && target === 'artifact' ? 'read_only_probe' : binding.verification.level;
      this.project(current, intents); this.store.recordFeedback(claim.owner, current, level);
      if (current.delegation!.afterSalesCaseId) this.store.updateAfterSales(claim.owner, current.delegation!.afterSalesCaseId, accepted ? 'resolved' : 'rejected');
      current.messages.push({ id: randomUUID(), role: 'agent', text: accepted ? delivery.artifact.data.deliverable : current.error!, at: current.updatedAt });
    });
  }
  private project(job: Job, intents: ActionIntent[]): void {
    const current = intents.filter(i => i.planDigest === job.delegation!.plan?.digest);
    job.delegation!.actions = current.map(i => ({ id: i.id, stepId: i.stepId, state: i.state, remoteRef: i.remoteRef, latestObservationId: i.latestObservationId }));
    job.delegation!.businessFacts = current.flatMap(i => i.businessSnapshot ? [{ intentId: i.id, snapshot: i.businessSnapshot.value, sourceVersion: i.businessSnapshot.sourceVersion, evidenceRefs: i.businessSnapshot.evidenceRefs }] : []);
  }
  private wait(claim: WorkClaim, at: number, recovery = false): void {
    this.store.finish(claim, job => { job.delegation!.nextAt = at; job.delegation!.recoveryPending = recovery; this.project(job, this.store.intents(claim.owner, job.id)); job.updatedAt = new Date().toISOString(); this.store.recordFeedback(claim.owner, job, job.delegation!.request.executionEnvironment === 'sandbox' ? 'sandbox' : 'unverified', false); });
  }
  private finishRecovery(claim: WorkClaim, intents: ActionIntent[], stop = false): void {
    this.store.finish(claim, job => {
      const pending = intents.filter(i => i.needsObservation || !['read', 'local'].includes(i.effect) && ['effect_unknown', 'awaiting_remote', 'dispatching'].includes(i.state));
      job.delegation!.recoveryPending = !stop && pending.length > 0; job.delegation!.nextAt = !stop && pending.length ? Math.max(Date.now() + 100, Math.min(...pending.map(i => i.nextAt))) : 0;
      delete job.delegation!.manualReconciliation;
      this.project(job, intents); job.updatedAt = new Date().toISOString();
      if (job.state !== 'completed') this.store.recordFeedback(claim.owner, job, job.delegation!.request.executionEnvironment === 'sandbox' ? 'sandbox' : 'unverified', false);
    });
  }
  private pause(claim: WorkClaim, state: 'input-required' | 'auth-required', question: string, intentId?: string): void {
    this.store.finish(claim, job => {
      job.state = state; job.question = question; job.updatedAt = new Date().toISOString(); job.delegation!.phase = state === 'auth-required' ? 'awaiting_authorization' : 'clarifying'; job.delegation!.recoveryPending = false;
      delete job.delegation!.manualReconciliation;
      if (intentId) job.delegation!.pendingActionInput = { intentId, question };
      this.project(job, this.store.intents(claim.owner, job.id));
      job.delegation!.outcome = { requestId: job.id, requestRevision: job.delegation!.request.revision, status: 'needs_human', criterionResults: [], reason: question, evidenceRefs: [], assessedAt: job.updatedAt };
      this.store.recordFeedback(claim.owner, job, 'unverified', false);
      job.messages.push({ id: randomUUID(), role: 'agent', text: question, at: job.updatedAt });
    });
  }
  private fail(claim: WorkClaim, reason: string, status: 'unknown' | 'unsatisfied'): void {
    this.store.finish(claim, job => {
      job.state = 'failed'; job.error = reason; job.updatedAt = new Date().toISOString(); job.delegation!.phase = 'failed'; job.delegation!.recoveryPending = false;
      job.delegation!.outcome = { requestId: job.id, requestRevision: job.delegation!.request.revision, status, criterionResults: [], reason, evidenceRefs: [], assessedAt: job.updatedAt };
      this.project(job, this.store.intents(claim.owner, job.id)); this.store.recordFeedback(claim.owner, job, 'unverified');
    });
  }
}
