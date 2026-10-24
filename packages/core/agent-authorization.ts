import { randomUUID } from 'node:crypto';
import { DomainError, type Job } from './domain.js';
import { digest } from './delegation.js';
import type { JobStore } from './store.js';
import type { AgentActionPlan } from '../ontology/agent-actions.js';
import type { ActionDefinition } from '../ontology/model.js';
import type { AgentProgram, AgentProgramContext } from './agent-program.js';
import { stepBindingRef, stepInputDigest } from './composed-actions.js';
import { authorizationPresentationSchema, actionBudgetImpactSchema, objectWriteScopeSchema, type EffectClass, type FinancialPlanGrant, type ObjectWritePlanGrant, type ExternalDraftPlanGrant, type ObjectWriteScope, type ObjectWriteAuthorizationRequest, type PlanAuthorizationRequest } from '../ontology/actions.js';
import { assertGoalEffects } from './goal-contract.js';
import { externalDraftScopeSchema, type ExternalDraftScope } from '../ontology/external-draft.js';

export function agentOperation(definition: ActionDefinition) {
  if (definition.implementation?.kind === 'declarative') return { version: '1' as const, effect: 'object_write' as const, environment: 'managed' as const, inputSchema: definition.inputSchema, resultType: definition.resultTypes?.[0] ?? 'ServiceRequest' };
  const operation = definition.read ?? definition.operation;
  if (!operation) throw new DomainError('FORBIDDEN', 'This action has no bound read or business operation schema');
  return operation;
}
export function isLiveFreeOperation(program: AgentProgram, ctx: AgentProgramContext, op: ReturnType<typeof agentOperation>) {
  return program.liveFreeReservation === true && program.capability().environment === 'live' && ctx.request.executionEnvironment !== 'sandbox'
    && 'environment' in op && op.environment === 'live_free' && op.effect === 'reserve' && !op.additionalEffects?.length;
}
export function assertAgentDecisionOrigin(program: AgentProgram, job: Job, owner: string, plan: AgentActionPlan) {
  if (plan.callerDecision) {
    const envelope = job.delegation?.callerAction, selected = plan.callerDecision;
    if (!program.callerManagedActions || !envelope || plan.modelRunId !== undefined || plan.modelDecision !== undefined || plan.ontologyPlanning.mode !== 'trusted_template'
      || selected.envelopeDigest !== digest(envelope) || selected.requestId !== envelope.requestId || envelope.ownerDigest !== digest(owner)
      || !job.delegation?.ontologyRelease || digest(envelope.ontologyRelease) !== digest(job.delegation.ontologyRelease) || digest(envelope.programRef) !== digest(plan.programRef)
      || envelope.inputDigest !== digest(envelope.input) || !job.delegation?.request.messages.some(message => message.id === envelope.requestId)
      || plan.steps.length !== 1 || plan.steps[0]!.effect !== 'object_write' || plan.steps[0]!.action !== envelope.action || digest(plan.steps[0]!.input) !== envelope.inputDigest) throw new DomainError('CONFLICT', 'Caller action plan differs from the authenticated immutable request');
    return selected.decision;
  }
  if (!plan.modelRunId || !plan.modelDecision || job.delegation?.callerAction || !['model_queries', 'worker_context', 'worker_context_with_queries'].includes(plan.ontologyPlanning.mode)
    || !job.runs?.some(run => run.id === plan.modelRunId && run.decisionDigest === digest(plan.modelDecision))) throw new DomainError('CONFLICT', 'Executable plan lacks its original model decision receipt');
  return plan.modelDecision;
}
export function agentPlanAuthorization(plan: AgentActionPlan): PlanAuthorizationRequest {
  const writes = plan.steps.filter(s => !['read', 'local'].includes(s.effect));
  if (writes.length !== 1) throw new DomainError('FORBIDDEN', 'An execution frontier must contain exactly one accurately bounded write');
  const step = writes[0]!;
  if (step.effect === 'external_draft') {
    if (!step.externalDraft || step.cost || step.budgetImpact || step.objectWrite || step.additionalEffects?.length || !step.operationScope) throw new DomainError('FORBIDDEN', 'External drafts require one exact nonfinancial source scope');
    return { kind: 'external_draft', planDigest: plan.digest, effects: ['external_draft'], draft: externalDraftScopeSchema.parse(step.externalDraft), environment: 'live', realOperationsAllowed: true, orderAllowed: false, paymentAllowed: false };
  }
  if (step.effect === 'object_write') {
    if (!step.objectWrite || step.cost || step.budgetImpact || step.externalDraft || step.additionalEffects?.length) throw new DomainError('FORBIDDEN', 'Managed writes require an exact nonfinancial scope');
    return { kind: 'object_write', planDigest: plan.digest, effects: ['object_write'], objectWrite: objectWriteScopeSchema.parse(step.objectWrite), environment: 'managed', realOperationsAllowed: false } satisfies ObjectWriteAuthorizationRequest;
  }
  if (!step.cost || step.objectWrite || step.externalDraft) throw new DomainError('FORBIDDEN', 'A sandbox frontier must contain exactly one fully priced business operation');
  const environment = plan.environment ?? 'sandbox';
  if (environment === 'live_free' && (step.effect !== 'reserve' || step.additionalEffects?.length || step.cost.minor !== '0')) throw new DomainError('FORBIDDEN', 'Live permits are limited to one zero-charge reservation');
  return { planDigest: plan.digest, effects: [...new Set([step.effect, ...(step.additionalEffects ?? [])])], maxAmount: { minor: step.cost!.minor, currency: step.cost!.currency }, payeeIds: [step.cost!.payeeId], environment, realOperationsAllowed: environment === 'live_free',
    ...(step.binding ? { actionBinding: { actionId: step.action, ref: step.binding.ref, programRef: step.binding.programRef, configurationDigest: step.binding.configurationDigest } } : {}),
    ...(step.confirmation ? { confirmation: authorizationPresentationSchema.parse(step.confirmation) } : {}),
    ...(step.budgetImpact ? { budgetImpact: actionBudgetImpactSchema.parse(step.budgetImpact) } : {}) };
}
export function validateAgentAuthority(program: AgentProgram, ctx: AgentProgramContext, plan: AgentActionPlan, step: AgentActionPlan['steps'][number]) {
  const { digest: expected, ...body } = plan;
  if (digest(body) !== expected || plan.requestId !== ctx.request.id || plan.requestRevision !== ctx.request.revision
    || (step.binding ? step.binding.configurationDigest !== program.configurationDigest || digest(step.binding.programRef) !== digest(program.ref)
      || step.binding.actionId !== step.action || step.binding.definitionDigest !== step.definitionDigest || step.bindingDigest !== step.binding.digest
      : plan.programDigest !== program.configurationDigest || digest(plan.programRef) !== digest(program.ref))) throw new DomainError('CONFLICT', 'Pinned agent plan or request changed');
  if (plan.callerDecision && (!program.callerManagedActions || step.effect !== 'object_write')) throw new DomainError('FORBIDDEN', 'Caller plans cannot invoke trusted source or provider programs');
  const op = agentOperation(program.definition(ctx.graph, step.action));
  if (ctx.state.composition) assertGoalEffects(ctx.state.composition.goal, [step.effect, ...(step.additionalEffects ?? [])]);
  if (op.effect !== step.effect || digest('additionalEffects' in op ? op.additionalEffects ?? [] : []) !== digest(step.additionalEffects ?? [])) throw new DomainError('CONFLICT', 'Declared business effects changed');
  if (step.effect === 'read' || step.effect === 'local') {
    if (step.externalDraft) throw new DomainError('FORBIDDEN', 'Read and local actions cannot carry external draft authority');
    const expected = program.simulatedApproval?.(ctx, step.action, step.input);
    if (digest(expected ?? null) !== digest(step.simulatedApproval ?? null)) throw new DomainError('CONFLICT', 'Local simulation terms changed');
    if (expected) {
      const quote = plan.quote;
      if (!quote || step.effect !== 'local' || plan.steps.length !== 1 || Date.parse(expected.expiresAt) <= Date.now()
        || digest(quote.amount) !== digest(expected.amount) || quote.expiresAt !== expected.expiresAt || quote.requestDigest !== digest(ctx.request) || quote.inputDigest !== stepInputDigest(step)
        || digest(quote.bindingRef) !== digest(stepBindingRef(plan, step)) || quote.bindingDigest !== (step.binding?.digest ?? program.configurationDigest)
        || quote.detailsDigest !== digest({ privateDigest: step.privateDigest, terms: expected })) throw new DomainError('CONFLICT', 'Exact local simulation quote changed or expired');
      const { digest: expectedDigest, ...body } = quote;
      if (digest(body) !== expectedDigest) throw new DomainError('CONFLICT', 'Local simulation quote digest changed');
    }
    return;
  }
  if (step.effect === 'external_draft') {
    if (!program.authority || !step.externalDraft || step.cost || step.budgetImpact || step.objectWrite || step.additionalEffects?.length
      || step.inputRefs.length || step.acceptedInputs?.length || !step.operationScope || ctx.request.executionEnvironment === 'sandbox'
      || program.capability().environment !== 'live' || !('environment' in op) || op.environment !== 'live') throw new DomainError('FORBIDDEN', 'External draft authority is restricted to one bound live nonfinancial operation');
    program.validate(ctx, step.action, step.input);
    const current = program.authority(ctx, step.action, step.input);
    if (!current.externalDraft || current.cost || current.objectWrite || current.budgetImpact || current.operationScope !== step.operationScope
      || digest(externalDraftScopeSchema.parse(current.externalDraft)) !== digest(step.externalDraft)) throw new DomainError('CONFLICT', 'External draft merchant, items, source or exact operation changed');
    return;
  }
  if (step.effect === 'object_write') {
    if (!program.authority || !step.objectWrite || step.cost || step.externalDraft || step.additionalEffects?.length || step.inputRefs.length) throw new DomainError('FORBIDDEN', 'Managed write scope must be materialized before approval');
    program.validate(ctx, step.action, step.input);
    const authority = program.authority(ctx, step.action, step.input), scope = authority.objectWrite && objectWriteScopeSchema.parse(authority.objectWrite);
    if (!scope || digest(scope) !== digest(step.objectWrite) || authority.operationScope !== step.operationScope
      || !ctx.graph.releaseRef || digest(scope.ontologyRelease) !== digest(ctx.graph.releaseRef) || scope.actionId !== step.action
      || scope.actionDigest !== step.definitionDigest || scope.inputDigest !== digest(step.input)) throw new DomainError('CONFLICT', 'Managed write targets, revisions, fields or definition changed');
    return;
  }
  const liveFree = isLiveFreeOperation(program, ctx, op);
  if (!program.authority || (!liveFree && (ctx.request.executionEnvironment !== 'sandbox' || program.capability().environment !== 'sandbox' || !('environment' in op) || op.environment !== 'sandbox')) || (plan.environment ?? 'sandbox') !== (liveFree ? 'live_free' : 'sandbox')) throw new DomainError('FORBIDDEN', 'This business operation has no permitted environment');
  program.validate(ctx, step.action, step.input);
  const current = program.authority(ctx, step.action, step.input);
  if (liveFree && current.cost?.minor !== '0') throw new DomainError('FORBIDDEN', 'A live free reservation cannot create a financial obligation');
  if (digest(('confirmation' in current ? current.confirmation : undefined) ?? null) !== digest(step.confirmation ?? null) || !current.cost || current.objectWrite || current.externalDraft || step.objectWrite || step.externalDraft || digest(current.cost) !== digest(step.cost) || current.operationScope !== step.operationScope
    || digest(current.budgetImpact ?? null) !== digest(step.budgetImpact ?? null)) throw new DomainError('CONFLICT', 'Payee, amount, budget commitment or business operation scope changed');
}
export function hasSimulationApproval(job: Job, plan: AgentActionPlan) {
  const approval = job.delegation?.approval;
  return !!plan.quote && Date.parse(plan.quote.expiresAt) > Date.now() && approval?.simulationOnly === true && approval.planDigest === plan.digest && approval.quoteDigest === plan.quote.digest;
}
export function createAgentSandboxGrant(owner: string, jobId: string, plan: AgentActionPlan, permit: { allowedEffects: EffectClass[]; maxAmount: { minor: string; currency: string }; payeeIds: string[]; expiresAt: string; planDigest: string; environment?: 'sandbox' | 'live_free' }) : FinancialPlanGrant {
  const required = agentPlanAuthorization(plan);
  if (required.kind === 'object_write' || required.kind === 'external_draft' || (permit.environment ?? 'sandbox') !== required.environment || permit.planDigest !== plan.digest || !Number.isFinite(Date.parse(permit.expiresAt)) || Date.parse(permit.expiresAt) <= Date.now()
    || permit.allowedEffects.some(e => !required.effects.includes(e)) || permit.payeeIds.some(p => !required.payeeIds.includes(p))
    || permit.maxAmount.currency !== required.maxAmount.currency || BigInt(permit.maxAmount.minor) > BigInt(required.maxAmount.minor)) throw new DomainError('FORBIDDEN', 'Permit exceeds this exact sandbox plan');
  return { id: randomUUID(), owner, jobId, planDigest: plan.digest, bindingRefs: plan.steps.filter(step => !['read', 'local'].includes(step.effect)).map(step => stepBindingRef(plan, step)), allowedEffects: permit.allowedEffects, maxAmount: permit.maxAmount, payeeIds: permit.payeeIds, expiresAt: permit.expiresAt, revoked: false, environment: required.environment, approvedAt: new Date().toISOString(), ...(required.budgetImpact ? { budgetImpact: required.budgetImpact } : {}) };
}
export function createAgentObjectWriteGrant(owner: string, jobId: string, plan: AgentActionPlan, permit: { planDigest: string; objectWrite: ObjectWriteScope; expiresAt: string }): ObjectWritePlanGrant {
  const required = agentPlanAuthorization(plan);
  if (required.environment !== 'managed' || permit.planDigest !== plan.digest || !Number.isFinite(Date.parse(permit.expiresAt)) || Date.parse(permit.expiresAt) <= Date.now()
    || digest(objectWriteScopeSchema.parse(permit.objectWrite)) !== digest(required.objectWrite)) throw new DomainError('FORBIDDEN', 'Permit differs from the exact managed write preview');
  return { kind: 'object_write', id: randomUUID(), owner, jobId, planDigest: plan.digest, bindingRefs: plan.steps.filter(step => step.effect === 'object_write').map(step => stepBindingRef(plan, step)), allowedEffects: ['object_write'], objectWrite: structuredClone(required.objectWrite), expiresAt: permit.expiresAt, revoked: false, environment: 'managed', approvedAt: new Date().toISOString() };
}
export function createAgentExternalDraftGrant(owner: string, jobId: string, plan: AgentActionPlan, permit: { planDigest: string; draft: ExternalDraftScope; expiresAt: string }): ExternalDraftPlanGrant {
  const required = agentPlanAuthorization(plan);
  if (required.kind !== 'external_draft' || permit.planDigest !== plan.digest || !Number.isFinite(Date.parse(permit.expiresAt)) || Date.parse(permit.expiresAt) <= Date.now()
    || Date.parse(permit.expiresAt) > Date.parse(required.draft.sourceExpiresAt)
    || digest(externalDraftScopeSchema.parse(permit.draft)) !== digest(required.draft)) throw new DomainError('FORBIDDEN', 'Permit differs from the exact unpaid checkout preview');
  return { kind: 'external_draft', id: randomUUID(), owner, jobId, planDigest: plan.digest, bindingRefs: plan.steps.filter(step => step.effect === 'external_draft').map(step => stepBindingRef(plan, step)),
    allowedEffects: ['external_draft'], draft: structuredClone(required.draft), expiresAt: permit.expiresAt, revoked: false, environment: 'live', approvedAt: new Date().toISOString() };
}
export function agentDispatchGrant(store: JobStore, owner: string, jobId: string, plan: AgentActionPlan, step: AgentActionPlan['steps'][number], now = Date.now()) {
  const required = [step.effect, ...(step.additionalEffects ?? [])];
  return store.grants(owner, jobId).find(g => {
    if (g.revoked || g.owner !== owner || g.jobId !== jobId || g.planDigest !== plan.digest || Date.parse(g.expiresAt) <= now || !g.bindingRefs.some(r => digest(r) === digest(stepBindingRef(plan, step))) || !required.every(e => g.allowedEffects.includes(e))) return false;
    if (step.effect === 'object_write') return g.kind === 'object_write' && g.environment === 'managed' && g.allowedEffects.length === 1 && g.allowedEffects[0] === 'object_write' && !!step.objectWrite && !step.cost && !step.additionalEffects?.length && digest(g.objectWrite) === digest(step.objectWrite);
    if (step.effect === 'external_draft') return g.kind === 'external_draft' && g.environment === 'live' && g.allowedEffects.length === 1 && g.allowedEffects[0] === 'external_draft' && !!step.externalDraft && !step.cost && !step.additionalEffects?.length && digest(g.draft) === digest(step.externalDraft);
    return (g.kind === undefined || g.kind === 'financial') && g.environment === (plan.environment ?? 'sandbox') && !!step.cost && g.payeeIds.includes(step.cost.payeeId) && g.maxAmount.currency === step.cost.currency && BigInt(g.maxAmount.minor) >= BigInt(step.cost.minor) && digest(g.budgetImpact ?? null) === digest(step.budgetImpact ?? null);
  });
}
