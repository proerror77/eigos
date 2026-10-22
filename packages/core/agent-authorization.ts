import { randomUUID } from 'node:crypto';
import { DomainError, type Job } from './domain.js';
import { digest } from './delegation.js';
import type { JobStore } from './store.js';
import type { AgentActionPlan } from '../ontology/agent-actions.js';
import type { ActionDefinition } from '../ontology/model.js';
import type { AgentProgram, AgentProgramContext } from './agent-program.js';
import { stepBindingRef, stepInputDigest } from './composed-actions.js';
import { actionBudgetImpactSchema, objectWriteScopeSchema, type EffectClass, type FinancialPlanGrant, type ObjectWritePlanGrant, type ObjectWriteScope, type ObjectWriteAuthorizationRequest, type PlanAuthorizationRequest } from '../ontology/actions.js';
import { assertGoalEffects } from './goal-contract.js';

export function agentOperation(definition: ActionDefinition) {
  if (definition.implementation?.kind === 'declarative') return { version: '1' as const, effect: 'object_write' as const, environment: 'managed' as const, inputSchema: definition.inputSchema, resultType: definition.resultTypes?.[0] ?? 'ServiceRequest' };
  const operation = definition.read ?? definition.operation;
  if (!operation) throw new DomainError('FORBIDDEN', 'This action has no bound read or sandbox operation schema');
  return operation;
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
  if (!plan.modelRunId || !plan.modelDecision || job.delegation?.callerAction || plan.ontologyPlanning.mode !== 'model_queries'
    || !job.runs?.some(run => run.id === plan.modelRunId && run.decisionDigest === digest(plan.modelDecision))) throw new DomainError('CONFLICT', 'Executable plan lacks its original model decision receipt');
  return plan.modelDecision;
}
export function agentPlanAuthorization(plan: AgentActionPlan): PlanAuthorizationRequest {
  const writes = plan.steps.filter(s => !['read', 'local'].includes(s.effect));
  if (writes.length !== 1) throw new DomainError('FORBIDDEN', 'An execution frontier must contain exactly one accurately bounded write');
  const step = writes[0]!;
  if (step.effect === 'object_write') {
    if (!step.objectWrite || step.cost || step.budgetImpact || step.additionalEffects?.length) throw new DomainError('FORBIDDEN', 'Managed writes require an exact nonfinancial scope');
    return { kind: 'object_write', planDigest: plan.digest, effects: ['object_write'], objectWrite: objectWriteScopeSchema.parse(step.objectWrite), environment: 'managed', realOperationsAllowed: false } satisfies ObjectWriteAuthorizationRequest;
  }
  if (!step.cost || step.objectWrite) throw new DomainError('FORBIDDEN', 'A sandbox frontier must contain exactly one fully priced business operation');
  return { planDigest: plan.digest, effects: [...new Set([step.effect, ...(step.additionalEffects ?? [])])], maxAmount: { minor: step.cost!.minor, currency: step.cost!.currency }, payeeIds: [step.cost!.payeeId], environment: 'sandbox' as const, realOperationsAllowed: false as const,
    ...(step.binding ? { actionBinding: { actionId: step.action, ref: step.binding.ref, programRef: step.binding.programRef, configurationDigest: step.binding.configurationDigest } } : {}),
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
  if (step.effect === 'object_write') {
    if (!program.authority || !step.objectWrite || step.cost || step.additionalEffects?.length || step.inputRefs.length) throw new DomainError('FORBIDDEN', 'Managed write scope must be materialized before approval');
    program.validate(ctx, step.action, step.input);
    const authority = program.authority(ctx, step.action, step.input), scope = authority.objectWrite && objectWriteScopeSchema.parse(authority.objectWrite);
    if (!scope || digest(scope) !== digest(step.objectWrite) || authority.operationScope !== step.operationScope
      || !ctx.graph.releaseRef || digest(scope.ontologyRelease) !== digest(ctx.graph.releaseRef) || scope.actionId !== step.action
      || scope.actionDigest !== step.definitionDigest || scope.inputDigest !== digest(step.input)) throw new DomainError('CONFLICT', 'Managed write targets, revisions, fields or definition changed');
    return;
  }
  if (!program.authority || ctx.request.executionEnvironment !== 'sandbox' || program.capability().environment !== 'sandbox' || !('environment' in op) || op.environment !== 'sandbox') throw new DomainError('FORBIDDEN', 'Real business operations are unavailable');
  program.validate(ctx, step.action, step.input);
  const current = program.authority(ctx, step.action, step.input);
  if (!current.cost || current.objectWrite || step.objectWrite || digest(current.cost) !== digest(step.cost) || current.operationScope !== step.operationScope
    || digest(current.budgetImpact ?? null) !== digest(step.budgetImpact ?? null)) throw new DomainError('CONFLICT', 'Payee, amount, budget commitment or business operation scope changed');
}
export function hasSimulationApproval(job: Job, plan: AgentActionPlan) {
  const approval = job.delegation?.approval;
  return !!plan.quote && Date.parse(plan.quote.expiresAt) > Date.now() && approval?.simulationOnly === true && approval.planDigest === plan.digest && approval.quoteDigest === plan.quote.digest;
}
export function createAgentSandboxGrant(owner: string, jobId: string, plan: AgentActionPlan, permit: { allowedEffects: EffectClass[]; maxAmount: { minor: string; currency: string }; payeeIds: string[]; expiresAt: string; planDigest: string }) : FinancialPlanGrant {
  const required = agentPlanAuthorization(plan);
  if (required.environment !== 'sandbox' || permit.planDigest !== plan.digest || !Number.isFinite(Date.parse(permit.expiresAt)) || Date.parse(permit.expiresAt) <= Date.now()
    || permit.allowedEffects.some(e => !required.effects.includes(e)) || permit.payeeIds.some(p => !required.payeeIds.includes(p))
    || permit.maxAmount.currency !== required.maxAmount.currency || BigInt(permit.maxAmount.minor) > BigInt(required.maxAmount.minor)) throw new DomainError('FORBIDDEN', 'Permit exceeds this exact sandbox plan');
  return { id: randomUUID(), owner, jobId, planDigest: plan.digest, bindingRefs: plan.steps.filter(step => !['read', 'local'].includes(step.effect)).map(step => stepBindingRef(plan, step)), allowedEffects: permit.allowedEffects, maxAmount: permit.maxAmount, payeeIds: permit.payeeIds, expiresAt: permit.expiresAt, revoked: false, environment: 'sandbox', approvedAt: new Date().toISOString(), ...(required.budgetImpact ? { budgetImpact: required.budgetImpact } : {}) };
}
export function createAgentObjectWriteGrant(owner: string, jobId: string, plan: AgentActionPlan, permit: { planDigest: string; objectWrite: ObjectWriteScope; expiresAt: string }): ObjectWritePlanGrant {
  const required = agentPlanAuthorization(plan);
  if (required.environment !== 'managed' || permit.planDigest !== plan.digest || !Number.isFinite(Date.parse(permit.expiresAt)) || Date.parse(permit.expiresAt) <= Date.now()
    || digest(objectWriteScopeSchema.parse(permit.objectWrite)) !== digest(required.objectWrite)) throw new DomainError('FORBIDDEN', 'Permit differs from the exact managed write preview');
  return { kind: 'object_write', id: randomUUID(), owner, jobId, planDigest: plan.digest, bindingRefs: plan.steps.filter(step => step.effect === 'object_write').map(step => stepBindingRef(plan, step)), allowedEffects: ['object_write'], objectWrite: structuredClone(required.objectWrite), expiresAt: permit.expiresAt, revoked: false, environment: 'managed', approvedAt: new Date().toISOString() };
}
export function agentDispatchGrant(store: JobStore, owner: string, jobId: string, plan: AgentActionPlan, step: AgentActionPlan['steps'][number], now = Date.now()) {
  const required = [step.effect, ...(step.additionalEffects ?? [])];
  return store.grants(owner, jobId).find(g => {
    if (g.revoked || g.owner !== owner || g.jobId !== jobId || g.planDigest !== plan.digest || Date.parse(g.expiresAt) <= now || !g.bindingRefs.some(r => digest(r) === digest(stepBindingRef(plan, step))) || !required.every(e => g.allowedEffects.includes(e))) return false;
    if (step.effect === 'object_write') return g.kind === 'object_write' && g.environment === 'managed' && g.allowedEffects.length === 1 && g.allowedEffects[0] === 'object_write' && !!step.objectWrite && !step.cost && !step.additionalEffects?.length && digest(g.objectWrite) === digest(step.objectWrite);
    return g.kind !== 'object_write' && g.environment === 'sandbox' && !!step.cost && g.payeeIds.includes(step.cost.payeeId) && g.maxAmount.currency === step.cost.currency && BigInt(g.maxAmount.minor) >= BigInt(step.cost.minor) && digest(g.budgetImpact ?? null) === digest(step.budgetImpact ?? null);
  });
}
