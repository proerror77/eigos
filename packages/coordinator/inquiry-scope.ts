import { ExecutionCatalog, sameRef, type AdapterContext, type ExecutionAdapter } from '../core/catalog.js';
import { DomainError } from '../core/domain.js';
import type { JobStore } from '../core/store.js';
import type { ExecutionPlan } from '../ontology/execution.js';
import { INQUIRY_CONTEXT_KEY, sourceSchema } from '../network/inquiry-contracts.js';
import { validateInquirySource } from '../network/inquiry-source.js';

/** Restrict the existing resolver/runtime, without introducing a second execution path. */
export function inquiryCatalog(jobs: JobStore, owner: string, jobId: string, catalog: ExecutionCatalog): ExecutionCatalog | undefined {
  const raw = jobs.preparationContext(owner, jobId, INQUIRY_CONTEXT_KEY); if (!raw) return;
  const source = sourceSchema.parse(raw), network = jobs.createNetworkStore();
  const guard = (ctx?: AdapterContext) => {
    if (ctx && (ctx.owner !== owner || ctx.request.id !== jobId || ctx.request.executionEnvironment === 'sandbox')) throw new DomainError('FORBIDDEN', 'Inquiry context cannot change identity or environment');
    return validateInquirySource(network, catalog, owner, source);
  };
  const selected = guard(), original = selected.adapter;
  const planGuard = (ctx: AdapterContext, plan: ExecutionPlan) => {
    guard(ctx);
    if (!sameRef(plan.capabilityRef, source.capabilityRef) || !sameRef(plan.bindingRef, source.bindingRef) || plan.quote
      || plan.steps.some(s => s.effect !== 'read' || !sameRef(s.capabilityRef, source.capabilityRef) || !sameRef(s.bindingRef, source.bindingRef)
        || !sameRef(s.actionTypeRef, selected.capability.actions[0]!.ref))) throw new DomainError('FORBIDDEN', 'Inquiry is restricted to the chosen quote-only source');
  };
  const adapter: ExecutionAdapter = {
    id: original.id,
    permitted(candidateOwner) { if (candidateOwner !== owner) return false; guard(); return original.permitted(owner); },
    async prepare(ctx, input, signal) {
      guard(ctx); const value = await original.prepare(ctx, input, signal); signal.throwIfAborted(); guard(ctx);
      if (value.kind === 'ready' && (value.authorization || value.recipe?.some(s => (s.bindingRef && !sameRef(s.bindingRef, source.bindingRef))
        || (s.capabilityRef && !sameRef(s.capabilityRef, source.capabilityRef)) || !sameRef(s.actionTypeRef, selected.capability.actions[0]!.ref))))
        throw new DomainError('FORBIDDEN', 'Inquiry preparation tried to escape the chosen read source');
      return value;
    },
    async execute(ctx, plan, data, signal) { planGuard(ctx, plan); const result = await original.execute(ctx, plan, data, signal); signal.throwIfAborted(); guard(ctx); return result; },
    verify(ctx, plan, data, delivery) { planGuard(ctx, plan); return original.verify(ctx, plan, data, delivery); },
  };
  // No discovery fallback, extra binding, document executor or effectful adapter is present here.
  return new ExecutionCatalog([selected.capability], [selected.binding], [adapter]);
}
