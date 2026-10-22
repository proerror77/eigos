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
      ...(original.limits ? { limits: original.limits } : {}),
      ...(original.modelCallsPerAction ? { modelCallsPerAction: original.modelCallsPerAction } : {}),
      ...(original.callerManagedActions ? { callerManagedActions: original.callerManagedActions } : {}),
      permitted(candidate) { if (candidate !== owner) return false; guard(); return original.permitted(candidate); },
      capability: () => selected.capability, listingBinding: () => selected.binding,
      sourceAuthorization: candidate => { if (candidate !== owner) throw new DomainError('FORBIDDEN', 'Inquiry owner changed'); guard(); return original.sourceAuthorization?.(candidate); },
      initialize(graph, candidate, request, input, component) { guard({ owner: candidate, request }); return original.initialize(graph, candidate, request, input, component); },
      ...(original.assertSourceAvailable ? { assertSourceAvailable(candidate: string) { if (candidate !== owner) throw new DomainError('FORBIDDEN', 'Inquiry owner changed'); guard(); original.assertSourceAvailable!(candidate); } } : {}),
      ...(original.assertContext ? { assertContext: (ctx) => { guard(ctx); original.assertContext!(ctx); } } : {}),
      ...(original.contextRefs ? { contextRefs: (ctx) => { guard(ctx); return original.contextRefs!(ctx); } } : {}),
      ...(original.prepareRequest ? { prepareRequest: request => { guard({ owner, request }); return original.prepareRequest!(request); } } : {}),
      ...(original.validateRequest ? { validateRequest: request => { guard({ owner, request }); original.validateRequest!(request); } } : {}),
      schema: action => original.schema(action), definition: (graph, action) => original.definition(graph, action),
      validate(ctx, action, input) { guard(ctx); original.validate(ctx, action, input); },
      ...(original.validatePlanning ? { validatePlanning: (ctx, action, input, reads) => { guard(ctx); original.validatePlanning!(ctx, action, input, reads); } } : {}),
      ...(original.validatePause ? { validatePause: (ctx, decision, reads) => { guard(ctx); original.validatePause!(ctx, decision, reads); } } : {}),
      ...(original.simulatedApproval ? { simulatedApproval: (ctx, action, input) => { guard(ctx); return original.simulatedApproval!(ctx, action, input); } } : {}),
      ...(original.privateInput ? { privateInput: (ctx, action, input) => { guard(ctx); return original.privateInput!(ctx, action, input); } } : {}),
      ...(original.authority ? { authority: (ctx, action, input) => { guard(ctx); return original.authority!(ctx, action, input); } } : {}),
      async invoke(ctx, action, input, signal) { guard(ctx); const result = await original.invoke(ctx, action, input, signal); signal.throwIfAborted(); guard(ctx); return result; },
      ...(original.recover ? { recover: async (ctx, action, input, signal) => { guard(ctx); const result = await original.recover!(ctx, action, input, signal); signal.throwIfAborted(); guard(ctx); return result; } } : {}),
      project(ctx, action, input, result) { guard(ctx); return original.project(ctx, action, input, result); },
      ...(original.projectOutputs ? { projectOutputs: (ctx, action, input, result, object) => { guard(ctx); return original.projectOutputs!(ctx, action, input, result, object); } } : {}),
      ...(original.validateOutput ? { validateOutput: (ctx, output) => { guard(ctx); original.validateOutput!(ctx, output); } } : {}),
      ...(original.onAccepted ? { onAccepted: (ctx, action, input, result, object, job) => { guard(ctx); original.onAccepted!(ctx, action, input, result, object, job); } } : {}),
      ...(original.onCompletionAccepted ? { onCompletionAccepted: (ctx, job) => { guard(ctx); original.onCompletionAccepted!(ctx, job); } } : {}),
      ...(original.terminalHandoff ? { terminalHandoff: ctx => { guard(ctx); return original.terminalHandoff!(ctx); } } : {}),
      complete(ctx, proposal, reads) { guard(ctx); return original.complete(ctx, proposal, reads); },
      clarify(ctx, message) { guard(ctx); return original.clarify?.(ctx, message) ?? message; },
    };
    return new ExecutionCatalog([selected.capability], [], [], [], [program]);
  }
  const original = selected.adapter;
  if (isActionAdapter(original)) throw new DomainError('FORBIDDEN', 'Inquiry source must be read-only');
  const planGuard = (ctx: AdapterContext, plan: import('../core/catalog.js').AdapterPlan) => {
    guard(ctx);
    if (!sameRef(plan.capabilityRef, source.capabilityRef) || !sameRef(plan.bindingRef, source.bindingRef) || ('quote' in plan && plan.quote)
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
