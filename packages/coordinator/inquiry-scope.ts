import { ExecutionCatalog, sameRef, isActionAdapter, type AdapterContext, type ExecutionAdapter } from '../core/catalog.js';
import type { AgentProgram } from '../core/agent-program.js';
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
  const selected = guard();
  if ('program' in selected) {
    const original = selected.program;
    const program: AgentProgram = {
      ref: original.ref, configurationDigest: original.configurationDigest, actionIds: original.actionIds, guidance: original.guidance, completionSchema: original.completionSchema,
      permitted(candidate) { if (candidate !== owner) return false; guard(); return original.permitted(candidate); },
      capability: () => selected.capability, listingBinding: () => selected.binding,
      sourceAuthorization: candidate => { if (candidate !== owner) throw new DomainError('FORBIDDEN', 'Inquiry owner changed'); guard(); return original.sourceAuthorization?.(candidate); },
      initialize(graph, candidate, request, input) { guard({ owner: candidate, request }); return original.initialize(graph, candidate, request, input); },
      schema: action => original.schema(action), definition: (graph, action) => original.definition(graph, action),
      validate(ctx, action, input) { guard(ctx); original.validate(ctx, action, input); },
      async invoke(ctx, action, input, signal) { guard(ctx); const result = await original.invoke(ctx, action, input, signal); signal.throwIfAborted(); guard(ctx); return result; },
      project(ctx, action, input, result) { guard(ctx); return original.project(ctx, action, input, result); },
      complete(ctx, proposal, reads) { guard(ctx); return original.complete(ctx, proposal, reads); },
      clarify(ctx, message) { guard(ctx); return original.clarify?.(ctx, message) ?? message; },
    };
    return new ExecutionCatalog([selected.capability], [], [], [], [program]);
  }
  const original = selected.adapter;
  if (isActionAdapter(original)) throw new DomainError('FORBIDDEN', 'Inquiry source must be read-only');
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
