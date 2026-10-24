import { randomUUID } from 'node:crypto';
import { DomainError } from './domain.js';
import { sameRef, isActionAdapter, type RegisteredAdapter } from './catalog.js';
import type { JobStore } from './store.js';
import type { ExecutionPlan, PlanStep } from '../ontology/execution.js';
import type { ActionIntent, EffectClass, FinancialPlanGrant } from '../ontology/actions.js';

export const requiredEffects = (step: Pick<PlanStep, 'effect' | 'additionalEffects'>): EffectClass[] => [...new Set([step.effect, ...(step.additionalEffects ?? [])])];

export function effectFor(catalog: import('./catalog.js').ExecutionCatalog, step: PlanStep): EffectClass {
  const action = catalog.capability(step.capabilityRef).actions.find(a => sameRef(a.ref, step.actionTypeRef));
  if (!action) throw new DomainError('FORBIDDEN', 'Unknown business action'); return action.effect;
}
export function authorizationRequest(plan: ExecutionPlan, effects: EffectClass[]) {
  const costs = plan.steps.flatMap(s => s.cost ? [s.cost] : []); const currency = costs[0]?.currency ?? 'CNY';
  if (costs.some(c => c.currency !== currency)) throw new DomainError('INVALID_INPUT', 'A plan cannot combine incompatible budget currencies');
  return { planDigest: plan.digest, effects: [...new Set(effects)], maxAmount: { minor: costs.reduce((n, c) => n + BigInt(c.minor), 0n).toString(), currency }, payeeIds: [...new Set(costs.map(c => c.payeeId))], environment: 'sandbox' as const, realOperationsAllowed: false as const };
}
export function checkDispatchPermit(store: JobStore, owner: string, plan: ExecutionPlan, step: PlanStep, intent: ActionIntent, adapter: RegisteredAdapter, allowSandbox: boolean, now = Date.now()): FinancialPlanGrant | undefined {
  if (intent.effect === 'local' || intent.effect === 'read') return;
  if (intent.effect === 'object_write') throw new DomainError('FORBIDDEN', 'Managed data writes require the exact object-write runtime and scope');
  if (!allowSandbox || !isActionAdapter(adapter) || adapter.environment !== 'sandbox' || store.get(owner, intent.jobId).delegation?.request.executionEnvironment !== 'sandbox') throw new DomainError('FORBIDDEN', 'Real business side effects are disabled; only explicitly requested and configured sandbox actions may dispatch');
  const grant = store.grants(owner, intent.jobId).find((g): g is FinancialPlanGrant => g.kind !== 'object_write' && !g.revoked && g.planDigest === plan.digest && g.environment === 'sandbox' && Date.parse(g.expiresAt) > now && g.bindingRefs.some(r => sameRef(r, step.bindingRef)) && requiredEffects(step).every(e => g.allowedEffects.includes(e)));
  if (!grant || (step.cost && (!grant.payeeIds.includes(step.cost.payeeId) || grant.maxAmount.currency !== step.cost.currency))) throw new DomainError('FORBIDDEN', 'No current owner-bound permit for this exact action and payee');
  if (step.cost && BigInt(step.cost.minor) > BigInt(grant.maxAmount.minor)) throw new DomainError('FORBIDDEN', 'Action amount exceeds the exact permit');
  return grant;
}
export function authorizeDispatch(store: JobStore, owner: string, plan: ExecutionPlan, step: PlanStep, intent: ActionIntent, adapter: RegisteredAdapter, allowSandbox: boolean, now = Date.now()): FinancialPlanGrant | undefined {
  const grant = checkDispatchPermit(store, owner, plan, step, intent, adapter, allowSandbox, now);
  if (grant && step.cost && intent.effect !== 'refund') store.reserveBudget(owner, intent.id, grant, step.cost);
  return grant;
}
export function createSandboxGrant(owner: string, jobId: string, plan: ExecutionPlan, args: { allowedEffects: EffectClass[]; maxAmount: { minor: string; currency: string }; payeeIds: string[]; expiresAt: string }): FinancialPlanGrant {
  if (!Number.isFinite(Date.parse(args.expiresAt)) || Date.parse(args.expiresAt) <= Date.now()) throw new DomainError('INVALID_INPUT', 'Grant must have a future explicit expiry');
  return { id: randomUUID(), owner, jobId, planDigest: plan.digest, bindingRefs: [...new Map(plan.steps.map(s => [JSON.stringify(s.bindingRef), s.bindingRef])).values()], allowedEffects: args.allowedEffects,
    maxAmount: args.maxAmount, payeeIds: args.payeeIds, expiresAt: args.expiresAt, revoked: false, environment: 'sandbox', approvedAt: new Date().toISOString() };
}
