import { randomUUID } from 'node:crypto';
import { DomainError } from './domain.js';
import { digest } from './delegation.js';
import type { JobStore } from './store.js';
import type { AgentActionPlan } from '../ontology/agent-actions.js';
import type { ActionDefinition } from '../ontology/model.js';
import type { AgentProgram, AgentProgramContext } from './agent-program.js';
import type { EffectClass, PlanGrant } from '../ontology/actions.js';
import { boundAgentAction } from './agent-action-binding.js';

export function agentOperation(definition: ActionDefinition) {
  const operation = definition.read ?? definition.operation;
  if (!operation) throw new DomainError('FORBIDDEN', 'This action has no bound read or business operation schema');
  return operation;
}
export function isLiveFreeOperation(program: AgentProgram, ctx: AgentProgramContext, op: ReturnType<typeof agentOperation>) {
  return program.liveFreeReservation === true && program.capability().environment === 'live' && ctx.request.executionEnvironment !== 'sandbox'
    && 'environment' in op && op.environment === 'live_free' && op.effect === 'reserve' && !op.additionalEffects?.length;
}
export function agentPlanAuthorization(plan: AgentActionPlan) {
  const writes = plan.steps.filter(s => !['read', 'local'].includes(s.effect));
  if (writes.length !== 1 || !writes[0]!.cost) throw new DomainError('FORBIDDEN', 'A business frontier must contain exactly one fully priced operation');
  const step = writes[0]!, environment = plan.environment ?? 'sandbox';
  if (environment === 'live_free' && (step.effect !== 'reserve' || step.additionalEffects?.length || step.cost!.minor !== '0')) throw new DomainError('FORBIDDEN', 'Live permits are limited to one zero-charge reservation');
  return { planDigest: plan.digest, effects: [...new Set([step.effect, ...(step.additionalEffects ?? [])])], maxAmount: { minor: step.cost!.minor, currency: step.cost!.currency }, payeeIds: [step.cost!.payeeId], environment, realOperationsAllowed: environment === 'live_free' };
}
export function validateAgentAuthority(program: AgentProgram, ctx: AgentProgramContext, plan: AgentActionPlan, step: AgentActionPlan['steps'][number]) {
  const { digest: expected, ...body } = plan;
  if (digest(body) !== expected || plan.requestId !== ctx.request.id || plan.requestRevision !== ctx.request.revision || plan.programDigest !== program.configurationDigest || digest(plan.programRef) !== digest(program.ref)) throw new DomainError('CONFLICT', 'Pinned agent plan or request changed');
  const op = agentOperation(boundAgentAction(ctx.graph, program, step.action));
  if (op.effect !== step.effect || digest('additionalEffects' in op ? op.additionalEffects ?? [] : []) !== digest(step.additionalEffects ?? [])) throw new DomainError('CONFLICT', 'Declared business effects changed');
  if (step.effect === 'read' || step.effect === 'local') return;
  const liveFree = isLiveFreeOperation(program, ctx, op);
  if (!program.authority || (!liveFree && (ctx.request.executionEnvironment !== 'sandbox' || program.capability().environment !== 'sandbox' || !('environment' in op) || op.environment !== 'sandbox')) || (plan.environment ?? 'sandbox') !== (liveFree ? 'live_free' : 'sandbox')) throw new DomainError('FORBIDDEN', 'This business operation has no permitted environment');
  program.validate(ctx, step.action, step.input);
  const current = program.authority(ctx, step.action, step.input);
  if (liveFree && current.cost.minor !== '0') throw new DomainError('FORBIDDEN', 'A live free reservation cannot create a financial obligation');
  if (digest(current.cost) !== digest(step.cost) || current.operationScope !== step.operationScope) throw new DomainError('CONFLICT', 'Payee, amount or business operation scope changed');
}
export function createAgentSandboxGrant(owner: string, jobId: string, plan: AgentActionPlan, permit: { allowedEffects: EffectClass[]; maxAmount: { minor: string; currency: string }; payeeIds: string[]; expiresAt: string; planDigest: string; environment?: 'sandbox' | 'live_free' }) : PlanGrant {
  const required = agentPlanAuthorization(plan);
  if ((permit.environment ?? 'sandbox') !== required.environment || permit.planDigest !== plan.digest || !Number.isFinite(Date.parse(permit.expiresAt)) || Date.parse(permit.expiresAt) <= Date.now()
    || permit.allowedEffects.some(e => !required.effects.includes(e)) || permit.payeeIds.some(p => !required.payeeIds.includes(p))
    || permit.maxAmount.currency !== required.maxAmount.currency || BigInt(permit.maxAmount.minor) > BigInt(required.maxAmount.minor)) throw new DomainError('FORBIDDEN', 'Permit exceeds this exact plan');
  return { id: randomUUID(), owner, jobId, planDigest: plan.digest, bindingRefs: [plan.programRef], allowedEffects: permit.allowedEffects, maxAmount: permit.maxAmount, payeeIds: permit.payeeIds, expiresAt: permit.expiresAt, revoked: false, environment: required.environment, approvedAt: new Date().toISOString() };
}
export function agentDispatchGrant(store: JobStore, owner: string, jobId: string, plan: AgentActionPlan, step: AgentActionPlan['steps'][number], now = Date.now()) {
  const required = [step.effect, ...(step.additionalEffects ?? [])];
  return store.grants(owner, jobId).find(g => !g.revoked && g.planDigest === plan.digest && g.environment === (plan.environment ?? 'sandbox') && Date.parse(g.expiresAt) > now && g.bindingRefs.some(r => digest(r) === digest(plan.programRef)) && required.every(e => g.allowedEffects.includes(e)) && !!step.cost && g.payeeIds.includes(step.cost.payeeId) && g.maxAmount.currency === step.cost.currency && BigInt(g.maxAmount.minor) >= BigInt(step.cost.minor));
}
