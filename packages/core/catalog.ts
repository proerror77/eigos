import { authorizationScope } from '../security/context.js';
import { ConnectionAuthorizationRequired, DomainError, type Job } from './domain.js';
import type { ServiceDefinition } from './services.js';
import { type Ref, type ServiceCapability, type ProviderBinding, type CandidateFacts, type ExecutionPlan, type ServiceRequest } from '../ontology/execution.js';
import type { DiscoveredBinding, DiscoveryCoverage, ProductOfferSnapshot } from '../ontology/supply.js';
import type { ActionContext, ActionResult, PreparedStep } from '../ontology/actions.js';
import { digest } from './delegation.js';
import type { AgentProgram } from './agent-program.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import { actionDiscoverySchema, type ActionBindingPin, type ActionDiscoveryEntry, type ActionDiscoveryPage, type ActionDiscoveryQuery, type DiscoveredActionBinding } from './action-bindings.js';
import { actionEffects, actionVersion } from '../ontology/composition-contract.js';
import { permittedCapability, permittedProgram, secureProgram, secureAdapter, secureDiscovery } from '../security/execution.js';
import { businessModel } from '../ontology/business-model.js';
import {requireRecovery} from '../security/recovery.js';
import type {SecurityStore} from '../security/store.js';
import { CompositionProgram } from '../coordinator/composition-program.js';

export interface AdapterContext { owner: string; request: ServiceRequest }
/** A bounded view for reusing one adapter operation. It links to the real sealed
 * frontier instead of pretending that the entire task is a legacy fixed plan. */
export interface AdapterInvocationView {
  id: string; capabilityRef: Ref; bindingRef: Ref; bindingSnapshots: ProviderBinding[];
  steps: import('../ontology/execution.js').PlanStep[]; details: Record<string, unknown>;
  sourcePlan: { id: string; digest: string; stepId: string; intentId: string };
}
export type AdapterPlan = ExecutionPlan | AdapterInvocationView;
export type Preparation = { kind: 'needs_input'; question: string; details?: Record<string, unknown> } | { kind: 'unavailable'; reason: string; details?: Record<string, unknown> } | {
  kind: 'ready'; input: Record<string, unknown>; details: Record<string, unknown>;
  facts: CandidateFacts; evidenceRefs: string[]; observedAt: string; expiresAt: string;
  authorization?: { amount: { minor: string; currency: string }; environment: 'local_simulation' };
  // Persisted privately; raw data and credentials never enter the model or task metadata.
  privateData?: unknown;
  recipe?: PreparedStep[];
};
export interface Delivery {
  evidenceLevel?: string; requirementChecks?: import('../ontology/execution.js').RequirementCheck[];
  conditionSubject?: import('../ontology/model.js').ObjectRef; artifact: NonNullable<Job['artifact']>; facts: CandidateFacts; evidenceRefs: string[];
  /** Trusted verifier's economic identity prevents summing a quote and its payment twice. */
  economicFacts?: { key: string; phase: 'quote' | 'commitment' | 'payment' | 'refund'; amount: { minor: string; currency: string }; role?: keyof NonNullable<CandidateFacts['amounts']>; evidenceRefs: string[] }[];
  consumedPorts?: string[];
}
export interface ProviderAdapter {
  readonly id: string;
  permitted(owner: string): boolean;
  sourceAuthorization?(owner: string): { provider: string; state: string; nextAction: string };
  prepare(ctx: AdapterContext, input: unknown, signal: AbortSignal): Promise<Preparation>;
  verify(ctx: AdapterContext, plan: AdapterPlan, privateData: unknown, delivery: Delivery): { accepted: boolean; reason: string };
}
export interface ExecutionAdapter extends ProviderAdapter {
  execute(ctx: AdapterContext, plan: AdapterPlan, privateData: unknown, signal: AbortSignal): Promise<Delivery>;
}
export interface ActionAdapter extends ProviderAdapter {
  readonly environment: 'sandbox' | 'live';
  dispatch(ctx: ActionContext, privateData: unknown, signal: AbortSignal): Promise<ActionResult>;
  observe(ctx: ActionContext, privateData: unknown, signal: AbortSignal): Promise<ActionResult>;
  reconcile(ctx: ActionContext, privateData: unknown, signal: AbortSignal): Promise<ActionResult>;
  resume?(ctx: ActionContext, privateData: unknown, signal: AbortSignal): Promise<ActionResult>;
  validateInput(step: import('../ontology/execution.js').PlanStep, input: Record<string, unknown>): void;
  verifyAction(ctx: ActionContext, result: ActionResult): { accepted: boolean; reason: string };
  prepareRemediation?(ctx: AdapterContext, originalPlan: ExecutionPlan, remoteRef: string, action: 'cancel' | 'refund', reason: string, originalIntents: import('../ontology/actions.js').ActionIntent[]): Preparation;
}
export type RegisteredAdapter = ExecutionAdapter | ActionAdapter;
export const isActionAdapter = (adapter: RegisteredAdapter): adapter is ActionAdapter => 'dispatch' in adapter;
export interface DiscoverySource {
  readonly id: string;
  readonly capabilityRefs: Ref[];
  readonly adapterId: string;
  readonly channelId: string;
  readonly configurationDigest?: string;
  // Source semantics for fallback coverage when discovery cannot return a result.
  readonly realSupply?: boolean;
  permitted(owner: string): boolean;
  discover(ctx: AdapterContext, input: unknown, signal: AbortSignal): Promise<{
    candidates: { binding: DiscoveredBinding; preparation: Preparation; offer?: ProductOfferSnapshot }[];
    coverage: DiscoveryCoverage;
  }>;
}
const key = (ref: Ref) => JSON.stringify([ref.id, ref.version]);
export const sameRef = (a: Ref, b: Ref) => a.id === b.id && a.version === b.version;
export const bindingDigest = (b: ProviderBinding) => digest({ ref: b.ref, capabilityRef: b.capabilityRef, providerId: b.providerId, channelId: b.channelId, merchantId: b.merchantId, adapterId: b.adapterId, protocol: b.protocol, enabled: b.enabled, recovery: b.recovery, verificationLevel: b.verification.level, configurationDigest: b.configurationDigest });

export class ExecutionCatalog {
  private services = new Map<string, ServiceCapability>();
  private providers = new Map<string, ProviderBinding>();
  private adapters = new Map<string, RegisteredAdapter>();
  private discovered = new Map<string, DiscoveredBinding>();
  private sources: DiscoverySource[];
  private programBindings = new Map<string, { binding: ProviderBinding; program: AgentProgram }>();
  private programs = new Map<string, AgentProgram>();
  private dynamicBase?: ExecutionCatalog;
  private ontologyScope?: string;
  private ontologyModel?: OntologyObjectStore['model'];
  private security?:SecurityStore;
  secureWith(security:SecurityStore) {if(this.security && this.security!==security && (this.security.enabled || security.enabled))throw new Error('A catalog cannot cross security stores');this.security=security;}
  constructor(services: ServiceCapability[], bindings: ProviderBinding[], adapters: RegisteredAdapter[], sources: DiscoverySource[] = [], programs: AgentProgram[] = [],
    private readonly dynamicFactory?: (graph: OntologyObjectStore, owner: string) => AgentProgram | undefined, security?: SecurityStore) {
    if(security) this.secureWith(security);
    const composites = (['live', 'sandbox'] as const).flatMap(environment => {
      const eligible = programs.map(program=>({program,capability:program.capability()})).filter(({program:p,capability:c})=>!p.callerManagedActions && digest([...p.actionIds].sort())===digest(c.actions.map(a=>a.ref.id).sort()) && !p.ref.id.startsWith('services.compose.') && p.ref.id!=='eigos.goal' && ['local',environment].includes(c.environment??'local'));
      // Explicit orchestration selects capability refs, whereas native goals
      // select exact provider pins. Ambiguous capability families stay native.
      const counts=new Map<string,number>();for(const {capability} of eligible)counts.set(key(capability.ref),(counts.get(key(capability.ref))??0)+1);
      const available=eligible.filter(({capability})=>counts.get(key(capability.ref))===1).map(({program})=>program);
      if (services.some(s => s.ref.id === `services.compose.${environment}`)) return [];
      return available.length >= 2 ? [new CompositionProgram(available, environment, program => secureProgram(program, this.security))] : [];
    });
    services = [...services, ...composites.map(p => p.capability())]; programs = [...programs, ...composites];
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) throw new Error('Duplicate adapter');
      this.adapters.set(adapter.id, adapter);
    }
    for (const service of services) {
      if (this.services.has(key(service.ref))) throw new Error('Duplicate capability version');
      this.services.set(key(service.ref), structuredClone(service));
    }
    for (const program of programs) {
      if (this.programs.has(key(program.ref)) || !this.services.has(key(program.capability().ref))) throw new Error('Duplicate or unresolved agent program');
      this.programs.set(key(program.ref), program);
      const binding = program.listingBinding?.();
      if (binding) {
        if (!sameRef(binding.capabilityRef, program.capability().ref) || binding.configurationDigest !== program.configurationDigest || this.programBindings.has(key(binding.ref)) || bindings.some(b => sameRef(b.ref, binding.ref))) throw new Error('Invalid or duplicate agent listing binding');
        this.programBindings.set(key(binding.ref), { binding: structuredClone(binding), program });
      }
    }
    for (const binding of bindings) {
      if (this.providers.has(key(binding.ref))) throw new Error('Duplicate binding version');
      if (!this.services.has(key(binding.capabilityRef)) || !this.adapters.has(binding.adapterId)) throw new Error('Unresolved binding capability or adapter');
      const implementation = this.adapters.get(binding.adapterId)!;
      if (isActionAdapter(implementation) && implementation.environment === 'sandbox' && this.services.get(key(binding.capabilityRef))!.environment !== 'sandbox') throw new Error('Sandbox adapters require an explicitly sandbox-scoped business capability');
      this.providers.set(key(binding.ref), structuredClone(binding));
    }
    if (new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('Duplicate discovery source');
    for (const source of sources) if (!this.adapters.has(source.adapterId) || source.capabilityRefs.some(r => !this.services.has(key(r)))) throw new Error('Unresolved discovery source');
    this.sources = sources;
  }
  /** A task receives the executable program for its immutable release. Existing
   * adapter permission closures remain live; no mutable global model is swapped. */
  forOntology(graph: OntologyObjectStore, owner: string): ExecutionCatalog {
    const base = this.dynamicBase ?? this;
    if (!base.dynamicFactory || !graph.releaseRef) return base;
    const scope = digest({ owner, release: graph.releaseRef });
    if (this.ontologyScope === scope) return this;
    const program = base.dynamicFactory(graph, owner);
    if (!program) return base;
    const catalog = new ExecutionCatalog([...base.services.values(), program.capability()], [...base.providers.values()], [...base.adapters.values()], base.sources,
      [...base.programs.values(), program], base.dynamicFactory, base.security);
    if (base.security) catalog.secureWith(base.security);
    catalog.dynamicBase = base; catalog.ontologyScope = scope; catalog.ontologyModel = graph.model;
    // Discovery records remain owner/request/version bound and are checked
    // against the source's current permission on every subsequent use.
    catalog.discovered = base.discovered;
    return catalog;
  }
  managedProgram(owner: string): AgentProgram | undefined {
    const programs = [...this.programs.values()].filter(program => program.callerManagedActions === true && program.permitted(owner));
    if (programs.length > 1) throw new DomainError('CONFLICT', 'Managed action program is ambiguous');
    return programs[0] ? secureProgram(programs[0], this.security) : undefined;
  }
  /** Owner, environment and release filtering happens before any binding metadata is returned. */
  discoverActions(graph: OntologyObjectStore, owner: string, request: ServiceRequest, input: ActionDiscoveryQuery): ActionDiscoveryPage {
    const { cursor, ...query } = actionDiscoverySchema.parse(input), catalog = this.forOntology(graph, owner);
    if (!graph.releaseRef) throw new DomainError('CONFLICT', 'Action discovery requires a published ontology release');
    const current = graph.read(owner, { type: 'ServiceRequest', id: request.id });
    if (current.properties.revision !== request.revision) throw new DomainError('CONFLICT', 'Action discovery request revision changed');
    for (const type of [query.inputType, query.outputType]) if (type && !graph.model.hasType(type)) throw new DomainError('INVALID_INPUT', 'Unknown action discovery type');
    const environment = request.executionEnvironment ?? 'live';
    const permittedPrograms = [...catalog.programs.values()].filter(program => !(program instanceof CompositionProgram) && permittedProgram(program) && (!query.programRef || sameRef(program.ref, query.programRef)) && program.permitted(owner)
      && (environment === 'sandbox' ? program.capability().environment !== 'live' : program.capability().environment !== 'sandbox'));
    const pipelineViews = new Map<string, ReturnType<OntologyObjectStore['pipelineStatus']>>();
    const pipelineFor = (program: AgentProgram, actionId: string) => {
      const key = digest({ ref: program.ref, configuration: program.configurationDigest, actionId });
      if (!pipelineViews.has(key)) pipelineViews.set(key, graph.pipelineStatus(owner, program.ref, program.configurationDigest, actionId));
      return pipelineViews.get(key)!;
    };
    const definitions = graph.model.actionDefinitions().filter(action => {
      if (catalog.security?.enabled) { const scope = authorizationScope(); if (!scope || scope.policies.security !== catalog.security) throw new DomainError('FORBIDDEN','Current task authority is required for action discovery'); if (!scope.policies.resourceAllowed(scope,'actionType',action.id)) return false; }
      if (query.actionId && action.id !== query.actionId) return false;
      if (query.inputType && !Object.values(action.inputs).some(type => graph.model.assignableType(query.inputType!, type))) return false;
      if (query.outputType && !(action.resultTypes ?? (action.read ? [action.read.resultType] : action.operation ? [action.operation.resultType] : [])).some(type => graph.model.assignableType(type, query.outputType!))) return false;
      if (query.effects && !actionEffects(action).every(effect => query.effects!.includes(effect))) return false;
      const serviceText = permittedPrograms.filter(program => program.actionIds.includes(action.id)).map(program => {
        const capability = program.capability(); return `${capability.name} ${capability.description} ${capability.tags.join(' ')} ${pipelineFor(program, action.id).terms?.join(' ') ?? ''}`;
      }).join(' ');
      return !query.search || `${action.id} ${action.description} ${serviceText}`.toLocaleLowerCase().includes(query.search.toLocaleLowerCase());
    }).sort((a, b) => a.id.localeCompare(b.id));
    const items: ActionDiscoveryEntry[] = definitions.map(action => {
      const bindings: DiscoveredActionBinding[] = [];
      const implementation = graph.model.actionImplementation(action.id);
      for (const program of permittedPrograms) {
        const capability = program.capability();
        if (!program.actionIds.includes(action.id) || !program.permitted(owner) || (environment === 'sandbox' ? capability.environment === 'live' : capability.environment === 'sandbox')) continue;
        if (query.search && !`${action.id} ${action.description} ${capability.name} ${capability.description} ${capability.tags.join(' ')} ${pipelineFor(program, action.id).terms?.join(' ') ?? ''}`.toLocaleLowerCase().includes(query.search.toLocaleLowerCase())) continue;
        if (implementation?.kind === 'declarative' && !program.callerManagedActions || implementation?.kind === 'trusted' && program.callerManagedActions) continue;
        const provider = program.listingBinding?.(), sourceAuthorization = program.sourceAuthorization?.(owner);
        const body: Omit<ActionBindingPin, 'digest'> = {
          ref: { id: `action:${digest({ program: program.ref, actionId: action.id })}`, version: actionVersion(action) ?? 'unversioned' },
          programRef: program.ref, actionId: action.id, actionVersion: actionVersion(action) ?? 'unversioned', definitionDigest: digest(action),
          ...(action.composition ? { compositionDigest: digest(action.composition) } : {}), configurationDigest: program.configurationDigest,
          ...(provider ? { providerBinding: provider.ref, providerSnapshot: structuredClone(provider), providerDefinitionDigest: bindingDigest(provider) } : {}), ontologyRelease: graph.releaseRef!, ownerDigest: digest(owner), requestId: request.id, requestRevision: request.revision,
        };
        let readiness: DiscoveredActionBinding['readiness'] = 'ready', reason = 'Exact task-scoped action binding; current inputs and effect authorization must still pass';
        if (!implementation || !action.composition) { readiness = 'contract_missing'; reason = 'This definition has not yet supplied the complete executable composition contract'; }
        if (action.composition?.effectScope.recovery.kind === 'original_intent' && !program.recover) { readiness = 'contract_missing'; reason = 'Original-intent recovery has no configured read-only implementation'; }
        try {
          if (digest(program.definition(graph, action.id)) !== digest(action)) { readiness = 'contract_mismatch'; reason = 'Runtime action does not match this task ontology release'; }
        } catch { readiness = 'contract_mismatch'; reason = 'Runtime cannot resolve this exact action definition'; }
        if (provider && (!provider.enabled || provider.configurationDigest !== program.configurationDigest)) { readiness = 'disabled'; reason = 'The registered provider binding is disabled or its configuration changed'; }
        if (sourceAuthorization && sourceAuthorization.state !== 'connected') { readiness = 'source_authorization_required'; reason = 'The owner must connect or renew this source before invocation'; }
        const pipeline = pipelineFor(program, action.id);
        if (readiness === 'ready' && !['unmanaged', 'verified', 'validation_only'].includes(pipeline.status)) { readiness = 'pipeline_unverified'; reason = pipeline.reason; }
        const conditions = query.serviceConditions, declared = pipeline.conditions;
        if (readiness === 'ready' && conditions && (!declared
          || conditions.region && !declared.regions.includes(conditions.region)
          || conditions.paymentModes && (declared.payment === 'unknown' || !conditions.paymentModes.includes(declared.payment))
          || conditions.operatorAvailable === false && declared.operatorRequired)) { readiness = 'conditions_unmet'; reason = 'The service has not established the requested region, payment path or operator conditions'; }
        bindings.push({ pin: { ...body, digest: digest(body) }, readiness, reason, environment: capability.environment ?? 'local', inputSchema: capability.inputSchema,
          capability: { name: capability.name, description: capability.description, predicates: capability.predicates, outcomePredicates: capability.outcomePredicates ?? [], requirementRoles: capability.requirementRoles ?? [],
            ...(capability.locationSemantics ? { locationSemantics: capability.locationSemantics } : {}), ...(capability.effectConstraints ? { effectConstraints: capability.effectConstraints } : {}) },
          completionSchema: program.completionSchema, guidance: program.guidance, ...(capability.goalOutcomes ? { goalOutcomes: capability.goalOutcomes } : {}), ...(sourceAuthorization ? { sourceAuthorization } : {}), ...(pipeline.status !== 'unmanaged' ? { pipeline } : {}) });
      }
      bindings.sort((a, b) => a.pin.ref.id.localeCompare(b.pin.ref.id));
      return { action, bindings, status: bindings.some(binding => binding.readiness === 'ready') ? 'available' : bindings.length ? 'not_ready' : implementation ? 'binding_unavailable' : 'definition_only' };
    });
    // Page binding rows, not just action names: many providers of one action
    // must not bypass the normal response and model-context bounds.
    const rows = items.flatMap(item => item.bindings.length ? item.bindings.map(binding => ({ ...item, bindings: [binding] })) : [item]);
    const snapshotDigest = digest({ owner, requestId: request.id, revision: request.revision, environment, release: graph.releaseRef, query: { ...query, limit: undefined }, items });
    let offset = 0;
    if (cursor) {
      let parsed: unknown; try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new DomainError('INVALID_INPUT', 'Invalid action discovery cursor'); }
      const page = parsed as { snapshot?: unknown; offset?: unknown };
      if (!page || typeof page !== 'object' || page.snapshot !== snapshotDigest || !Number.isInteger(page.offset) || Number(page.offset) < 0 || Number(page.offset) > rows.length) throw new DomainError('CONFLICT', 'Action discovery cursor no longer matches the task, permissions or bindings');
      offset = Number(page.offset);
    }
    const selectedRows = rows.slice(offset, offset + query.limit), hasMore = offset + selectedRows.length < rows.length;
    const selected: ActionDiscoveryEntry[] = [];
    for (const row of selectedRows) {
      const existing = selected.find(item => item.action.id === row.action.id);
      if (existing) existing.bindings.push(...row.bindings);
      else selected.push({ ...row, bindings: [...row.bindings] });
    }
    return { ontologyRelease: structuredClone(graph.releaseRef), requestId: request.id, requestRevision: request.revision, items: structuredClone(selected),
      page: { limit: query.limit, hasMore, ...(hasMore ? { cursor: Buffer.from(JSON.stringify({ snapshot: snapshotDigest, offset: offset + selectedRows.length })).toString('base64url') } : {}) },
      authorization: 'per_action_required', allowedEffects: query.effects ?? ['local', 'read', 'object_write', ...(environment === 'sandbox' ? ['reserve', 'order', 'payment', 'change', 'cancel', 'refund'] as const : [])], snapshotDigest };
  }
  /** Resolve the whole pin again. Permission or configuration drift never selects another provider. */
  resolveActionBinding(graph: OntologyObjectStore, owner: string, request: ServiceRequest, pin: ActionBindingPin): { program: AgentProgram; binding: DiscoveredActionBinding } {
    const { digest: expected, ...body } = pin;
    if (digest(body) !== expected || pin.ownerDigest !== digest(owner) || pin.requestId !== request.id || pin.requestRevision !== request.revision || digest(pin.ontologyRelease) !== digest(graph.releaseRef)) throw new DomainError('FORBIDDEN', 'Action binding is not pinned to this exact owned task');
    const found = this.discoverActions(graph, owner, request, { actionId: pin.actionId, programRef: pin.programRef }).items.flatMap(item => item.bindings).find(binding => binding.pin.digest === pin.digest);
    const program = this.forOntology(graph, owner).agentProgram(pin.programRef, owner);
    if (found?.readiness === 'source_authorization_required' && program) {
      program.assertSourceAvailable?.(owner);
      throw new ConnectionAuthorizationRequired('The exact action binding requires current source authorization');
    }
    // Preserve the exact runtime for original-operation readback even when a
    // pipeline proof expires. New invocation is checked again at dispatch.
    if (!found || !['ready', 'pipeline_unverified'].includes(found.readiness)) throw new DomainError('CONFLICT', 'The exact action binding is unavailable or requires source authorization');
    if (!program) throw new DomainError('CONFLICT', 'The action runtime is unavailable');
    program.assertSourceAvailable?.(owner);
    return { program, binding: found };
  }
  /** Runtime readiness is separate from authorization to invoke an action. */
  actionAvailability(graph: OntologyObjectStore, owner: string, actionId: string): { status: 'executable' | 'definition_only' | 'handler_unavailable'; kind?: 'declarative' | 'trusted'; reason: string } {
    const implementation = graph.model.actionImplementation(actionId);
    if (!implementation) return { status: 'definition_only', reason: 'This definition has no registered executable implementation' };
    const catalog = this.forOntology(graph, owner);
    const candidates = [...catalog.programs.values()].filter(program => !(program instanceof CompositionProgram) && permittedProgram(program) && program.actionIds.includes(actionId) && program.permitted(owner));
    for (const program of candidates) {
      if (implementation.kind === 'declarative' && !program.callerManagedActions) continue;
      if (implementation.kind === 'trusted' && program.callerManagedActions) continue;
      try {
        const definition = program.definition(graph, actionId);
        if (digest(definition) !== digest(graph.model.action(actionId))) continue;
        if (!['unmanaged', 'verified', 'validation_only'].includes(graph.pipelineStatus(owner, program.ref, program.configurationDigest, actionId).status)) continue;
        return { status: 'executable', kind: implementation.kind, reason: 'A permitted configured runtime supports this exact definition; invocation still requires task scope and current authorization' };
      } catch { /* A registered definition cannot substitute for a matching runtime. */ }
    }
    if (implementation.kind === 'trusted') {
      const definition = graph.model.action(actionId), requiredEffects = [...(definition.effects ?? [])].sort();
      for (const capability of catalog.services.values()) {
        const supported = capability.actions.some(action => action.ref.id === definition.providerOperation
          && action.ref.version === implementation.handlerRef.version
          && digest([action.effect, ...(action.additionalEffects ?? [])].sort()) === digest(requiredEffects));
        if (supported && catalog.bindings(capability.ref, owner).some(binding => isActionAdapter(catalog.adapters.get(binding.adapterId)!))) {
          return { status: 'executable', kind: 'trusted', reason: 'An enabled permitted provider binding supports this exact operation version and effects; task preparation and current authorization are still required' };
        }
      }
    }
    return { status: 'handler_unavailable', kind: implementation.kind, reason: 'No permitted configured runtime supports this exact action contract for this identity' };
  }
  // Metadata only, for the configured operator's listing review; never installs discovered code.
  configuredBinding(ref: Ref): ProviderBinding | undefined { const value = this.providers.get(key(ref)) ?? this.programBindings.get(key(ref))?.binding; return value ? structuredClone(value) : undefined; }

  capability(ref: Ref): ServiceCapability {
    const definition = this.services.get(key(ref));
    if (!definition) throw new DomainError('CONFLICT', 'Capability version is unavailable');
    return structuredClone(definition);
  }
  agentProgram(ref: Ref, owner: string): AgentProgram | undefined {
    const program = this.programs.get(key(ref));
    if (program && !program.permitted(owner)) throw new DomainError('FORBIDDEN', 'Agent program is unavailable to this identity');
    return program ? secureProgram(program,this.security) : undefined;
  }
  /** Feedback belongs to one actual configured runtime, never to an aggregate
   * of providers merely sharing a semantic capability name. */
  programForCapability(ref: Ref, owner: string): AgentProgram | undefined {
    const matches=[...this.programs.values()].filter(program=>sameRef(program.capability().ref,ref) && program.permitted(owner) && permittedProgram(program));
    return matches.length===1 ? this.agentProgram(matches[0]!.ref,owner) : undefined;
  }
  source(ref: Ref, owner: string): { binding: ProviderBinding; program: AgentProgram } | { binding: ProviderBinding; adapter: RegisteredAdapter } {
    const selected = this.programBindings.get(key(ref));
    if (!selected) return this.binding(ref, owner);
    if (!selected.binding.enabled || !selected.program.permitted(owner)) throw new DomainError('FORBIDDEN', 'Agent source is unavailable to this identity');
    return { binding: structuredClone(selected.binding), program: secureProgram(selected.program, this.security) };
  }
  binding(ref: Ref, owner: string, requestId?: string): { binding: ProviderBinding; adapter: RegisteredAdapter } {
    const binding = this.providers.get(key(ref)) ?? (requestId ? this.discovered.get(JSON.stringify([owner, requestId, key(ref)])) : undefined);
    const adapter = binding && this.adapters.get(binding.adapterId);
    if (!binding?.enabled || !adapter?.permitted(owner)) throw new DomainError('FORBIDDEN', 'Provider binding is unavailable to this identity');
    return { binding: structuredClone(binding), adapter: secureAdapter(binding,adapter,this.security) };
  }
  discoverySources(ref: Ref, owner: string): DiscoverySource[] { return this.sources.filter(s => permittedCapability(ref.id) && s.capabilityRefs.some(r => sameRef(r, ref)) && s.permitted(owner)).map(s=>secureDiscovery(s,ref.id,this.security)); }
  hasRemediation(): boolean { return [...this.adapters.values()].some(a => isActionAdapter(a) && !!a.prepareRemediation); }
  /** Reviewed server metadata for the member control plane, without credentials,
   * source locators or an implicit grant for programs restricted to another owner. */
  securityProfiles(owner:string) {
    const model = this.security?.model ?? this.ontologyModel ?? businessModel;
    return [...this.programs.values()].filter(p=>p.permitted(owner)).map(program=>{
      const ontology=program.capability().ontology;
      const objects=ontology && 'objects' in ontology && Array.isArray(ontology.objects) ? ontology.objects.filter((v):v is string=>typeof v==='string') : [];
      return {
      capabilityId:program.capability().ref.id,bindingId:`program:${program.ref.id}`,programId:program.ref.id,programDigest:program.configurationDigest,
      name:program.capability().name,operations:[...program.actionIds,...(program.observeOriginal?['recover_original']:[])],
      outputTypes:[...new Set([...(program.projectionTypes??objects),...program.actionIds.flatMap(id=>{
        const action=model.action(id); return [...Object.values(action.inputs),...action.changes.map(c=>c.split('.')[0]!)];
      })])].filter(t=>model.hasType(t) && !model.isInterface(t) && t!=='ServiceRequest'),
    };});
  }
  async observeOriginal(operation:import('../security/recovery.js').OriginalOperation,signal:AbortSignal) {
    requireRecovery(operation,this.security);
    const program=this.programs.get(key(operation.programRef));
    if(!program?.observeOriginal || !program.permitted(operation.owner) || program.configurationDigest!==operation.programDigest) throw new DomainError('FORBIDDEN','Original source observer is unavailable');
    return program.observeOriginal(operation,signal);
  }
  registerDiscovered(ctx: AdapterContext, binding: DiscoveredBinding): void {
    const source = this.sources.find(s => s.id === binding.discovery.sourceId && s.adapterId === binding.adapterId && s.channelId === binding.channelId && s.capabilityRefs.some(r => sameRef(r, binding.capabilityRef)));
    if (!source?.permitted(ctx.owner) || binding.discovery.requestId !== ctx.request.id || binding.discovery.requestRevision !== ctx.request.revision || !binding.discovery.evidenceRefs.length) throw new DomainError('FORBIDDEN', 'Discovered binding has invalid source, identity or request provenance');
    if (source.configurationDigest !== undefined && binding.configurationDigest !== source.configurationDigest) throw new DomainError('CONFLICT', 'Pinned discovery source configuration has changed');
    const id = JSON.stringify([ctx.owner, ctx.request.id, key(binding.ref)]); const previous = this.discovered.get(id);
    if (previous && bindingDigest(previous) !== bindingDigest(binding)) throw new DomainError('CONFLICT', 'A pinned discovered provider identity cannot change');
    this.discovered.set(id, structuredClone(binding));
  }
  bindings(ref: Ref, owner: string): ProviderBinding[] {
    return [...this.providers.values()].filter(b => permittedCapability(ref.id) && sameRef(b.capabilityRef, ref) && b.enabled && this.adapters.get(b.adapterId)!.permitted(owner)).map(b => structuredClone(b));
  }
  summaries(owner: string, limit = 16, environment: 'live' | 'sandbox' = 'live') {
    const page = this.summaryPage(owner, limit, environment);
    if (page.hasMore) throw new DomainError('CONFLICT', 'Capability retrieval limit exceeded; a narrower discovery scope is required');
    return page.items;
  }
  /** Bounded bootstrap only. The action directory searches all permitted programs. */
  summaryPage(owner: string, limit = 16, environment: 'live' | 'sandbox' = 'live', graph?: OntologyObjectStore) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new DomainError('INVALID_INPUT', 'Invalid capability page size');
    const programs = (ref: Ref) => [...this.programs.values()].filter(program => {
      if (!sameRef(program.capability().ref, ref) || !permittedProgram(program) || !program.permitted(owner)) return false;
      if (!graph) return true;
      const states = program.actionIds.map(action => graph.pipelineStatus(owner, program.ref, program.configurationDigest, action).status);
      return states.every(status => status === 'unmanaged') || states.some(status => status === 'verified' || status === 'validation_only');
    });
    const permitted = [...this.services.values()].filter(s => (environment === 'sandbox' ? s.environment !== 'live' : s.environment !== 'sandbox') && (this.bindings(s.ref, owner).length || this.discoverySources(s.ref, owner).length || programs(s.ref).length));
    const items = permitted.slice(0, limit).map(s => ({ ref: structuredClone(s.ref), name: s.name, description: s.description, tags: [...s.tags], inputSchema: structuredClone(s.inputSchema), predicates: structuredClone(s.predicates), outcomePredicates: s.outcomePredicates ?? [], ...(s.goalOutcomes ? { goalOutcomes: structuredClone(s.goalOutcomes) } : {}), requirementRoles: structuredClone(s.requirementRoles ?? []), locationSemantics: s.locationSemantics, constraintEvaluation: s.constraintEvaluation, scopeReviewMode: s.scopeReviewMode, ...(this.programs.get(key(s.ref)) instanceof CompositionProgram ? { composition: structuredClone(s.ontology) } : {}),
      sourceAuthorization: programs(s.ref).map(program => program.sourceAuthorization?.(owner)).find(Boolean) ?? this.bindings(s.ref, owner).map(b => this.adapters.get(b.adapterId)?.sourceAuthorization?.(owner)).find(Boolean) }));
    return { items, hasMore: permitted.length > items.length };
  }
  delegationService(): ServiceDefinition {
    const definitions = [...this.services.values()];
    return { id: 'eigos.delegate', name: 'Ontology-grounded EIGOS execution', requiredInputs: ['goal'],
      description: 'Submit a goal. Ontology + LLM ground the request, resolve provider facts, propose a versioned plan and independently verify delivery. Unknown hard requirements prevent execution. Registered business capabilities: ' + definitions.map(s => `${s.ref.id}: ${s.description}`).join(' | '),
      tags: ['delegation', 'ontology', 'planning'], examples: [], inputModes: ['text/plain', 'application/json'], outputModes: ['application/json', 'text/markdown'] };
  }
}
