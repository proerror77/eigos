import { randomUUID } from 'node:crypto';
import { DomainError } from './domain.js';
import { digest } from './delegation.js';
import type { JobStore } from './store.js';
import type { AgentActionPlan } from '../ontology/agent-actions.js';
import type { ActionDefinition } from '../ontology/model.js';
import type { AgentProgram, AgentProgramContext } from './agent-program.js';
import type { EffectClass, PlanGrant } from '../ontology/actions.js';

export function agentOperation(definition: ActionDefinition) {
  const operation = definition.read ?? definition.operation;
  if (!operation) throw new DomainError('FORBIDDEN', 'This action has no bound read or sandbox operation schema');
  return operation;
}
export function agentPlanAuthorization(plan: AgentActionPlan) {
  const writes = plan.steps.filter(s => !['read', 'local'].includes(s.effect));
  if (writes.length !== 1 || !writes[0]!.cost) throw new DomainError('FORBIDDEN', 'A sandbox frontier must contain exactly one fully priced business operation');
  const step = writes[0]!;
  return { planDigest: plan.digest, effects: [...new Set([step.effect, ...(step.additionalEffects ?? [])])], maxAmount: { minor: step.cost!.minor, currency: step.cost!.currency }, payeeIds: [step.cost!.payeeId], environment: 'sandbox' as const, realOperationsAllowed: false as const };
}
export function validateAgentAuthority(program: AgentProgram, ctx: AgentProgramContext, plan: AgentActionPlan, step: AgentActionPlan['steps'][number]) {
  const { digest: expected, ...body } = plan;
  if (digest(body) !== expected || plan.requestId !== ctx.request.id || plan.requestRevision !== ctx.request.revision || plan.programDigest !== program.configurationDigest || digest(plan.programRef) !== digest(program.ref)) throw new DomainError('CONFLICT', 'Pinned agent plan or request changed');
  const op = agentOperation(program.definition(ctx.graph, step.action));
  if (op.effect !== step.effect || digest('additionalEffects' in op ? op.additionalEffects ?? [] : []) !== digest(step.additionalEffects ?? [])) throw new DomainError('CONFLICT', 'Declared business effects changed');
  if (step.effect === 'read') return;
  if (!program.authority || ctx.request.executionEnvironment !== 'sandbox' || program.capability().environment !== 'sandbox' || !('environment' in op) || op.environment !== 'sandbox') throw new DomainError('FORBIDDEN', 'Real business operations are unavailable');
  program.validate(ctx, step.action, step.input);
  const current = program.authority(ctx, step.action, step.input);
  if (digest(current.cost) !== digest(step.cost) || current.operationScope !== step.operationScope) throw new DomainError('CONFLICT', 'Payee, amount or business operation scope changed');
}
export function createAgentSandboxGrant(owner: string, jobId: string, plan: AgentActionPlan, permit: { allowedEffects: EffectClass[]; maxAmount: { minor: string; currency: string }; payeeIds: string[]; expiresAt: string; planDigest: string }) : PlanGrant {
  const required = agentPlanAuthorization(plan);
  if (permit.planDigest !== plan.digest || !Number.isFinite(Date.parse(permit.expiresAt)) || Date.parse(permit.expiresAt) <= Date.now()
    || permit.allowedEffects.some(e => !required.effects.includes(e)) || permit.payeeIds.some(p => !required.payeeIds.includes(p))
    || permit.maxAmount.currency !== required.maxAmount.currency || BigInt(permit.maxAmount.minor) > BigInt(required.maxAmount.minor)) throw new DomainError('FORBIDDEN', 'Permit exceeds this exact sandbox plan');
  return { id: randomUUID(), owner, jobId, planDigest: plan.digest, bindingRefs: [plan.programRef], allowedEffects: permit.allowedEffects, maxAmount: permit.maxAmount, payeeIds: permit.payeeIds, expiresAt: permit.expiresAt, revoked: false, environment: 'sandbox', approvedAt: new Date().toISOString() };
}
export function agentDispatchGrant(store: JobStore, owner: string, jobId: string, plan: AgentActionPlan, step: AgentActionPlan['steps'][number], now = Date.now()) {
  const required = [step.effect, ...(step.additionalEffects ?? [])];
  return store.grants(owner, jobId).find(g => !g.revoked && g.planDigest === plan.digest && g.environment === 'sandbox' && Date.parse(g.expiresAt) > now && g.bindingRefs.some(r => digest(r) === digest(plan.programRef)) && required.every(e => g.allowedEffects.includes(e)) && !!step.cost && g.payeeIds.includes(step.cost.payeeId) && g.maxAmount.currency === step.cost.currency && BigInt(g.maxAmount.minor) >= BigInt(step.cost.minor));
}
