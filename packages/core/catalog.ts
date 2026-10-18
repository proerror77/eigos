import { DomainError, type Job } from './domain.js';
import type { ServiceDefinition } from './services.js';
import { type Ref, type ServiceCapability, type ProviderBinding, type CandidateFacts, type ExecutionPlan, type ServiceRequest } from '../ontology/execution.js';
import type { DiscoveredBinding, DiscoveryCoverage, ProductOfferSnapshot } from '../ontology/supply.js';
import type { ActionContext, ActionResult, PreparedStep } from '../ontology/actions.js';
import { digest } from './delegation.js';

export interface AdapterContext { owner: string; request: ServiceRequest }
export type Preparation = { kind: 'needs_input'; question: string; details?: Record<string, unknown> } | { kind: 'unavailable'; reason: string; details?: Record<string, unknown> } | {
  kind: 'ready'; input: Record<string, unknown>; details: Record<string, unknown>;
  facts: CandidateFacts; evidenceRefs: string[]; observedAt: string; expiresAt: string;
  authorization?: { amount: { minor: string; currency: string }; environment: 'local_simulation' };
  // Persisted privately; raw data and credentials never enter the model or task metadata.
  privateData?: unknown;
  recipe?: PreparedStep[];
};
export interface Delivery { artifact: NonNullable<Job['artifact']>; facts: CandidateFacts; evidenceRefs: string[] }
export interface ProviderAdapter {
  readonly id: string;
  permitted(owner: string): boolean;
  prepare(ctx: AdapterContext, input: unknown, signal: AbortSignal): Promise<Preparation>;
  verify(ctx: AdapterContext, plan: ExecutionPlan, privateData: unknown, delivery: Delivery): { accepted: boolean; reason: string };
}
export interface ExecutionAdapter extends ProviderAdapter {
  execute(ctx: AdapterContext, plan: ExecutionPlan, privateData: unknown, signal: AbortSignal): Promise<Delivery>;
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
  constructor(services: ServiceCapability[], bindings: ProviderBinding[], adapters: RegisteredAdapter[], sources: DiscoverySource[] = []) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) throw new Error('Duplicate adapter');
      this.adapters.set(adapter.id, adapter);
    }
    for (const service of services) {
      if (this.services.has(key(service.ref))) throw new Error('Duplicate capability version');
      this.services.set(key(service.ref), structuredClone(service));
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
  capability(ref: Ref): ServiceCapability {
    const definition = this.services.get(key(ref));
    if (!definition) throw new DomainError('CONFLICT', 'Capability version is unavailable');
    return structuredClone(definition);
  }
  binding(ref: Ref, owner: string, requestId?: string): { binding: ProviderBinding; adapter: RegisteredAdapter } {
    const binding = this.providers.get(key(ref)) ?? (requestId ? this.discovered.get(JSON.stringify([owner, requestId, key(ref)])) : undefined);
    const adapter = binding && this.adapters.get(binding.adapterId);
    if (!binding?.enabled || !adapter?.permitted(owner)) throw new DomainError('FORBIDDEN', 'Provider binding is unavailable to this identity');
    return { binding: structuredClone(binding), adapter };
  }
  discoverySources(ref: Ref, owner: string): DiscoverySource[] { return this.sources.filter(s => s.capabilityRefs.some(r => sameRef(r, ref)) && s.permitted(owner)); }
  hasRemediation(): boolean { return [...this.adapters.values()].some(a => isActionAdapter(a) && !!a.prepareRemediation); }
  registerDiscovered(ctx: AdapterContext, binding: DiscoveredBinding): void {
    const source = this.sources.find(s => s.id === binding.discovery.sourceId && s.adapterId === binding.adapterId && s.channelId === binding.channelId && s.capabilityRefs.some(r => sameRef(r, binding.capabilityRef)));
    if (!source?.permitted(ctx.owner) || binding.discovery.requestId !== ctx.request.id || binding.discovery.requestRevision !== ctx.request.revision || !binding.discovery.evidenceRefs.length) throw new DomainError('FORBIDDEN', 'Discovered binding has invalid source, identity or request provenance');
    if (source.configurationDigest !== undefined && binding.configurationDigest !== source.configurationDigest) throw new DomainError('CONFLICT', 'Pinned discovery source configuration has changed');
    const id = JSON.stringify([ctx.owner, ctx.request.id, key(binding.ref)]); const previous = this.discovered.get(id);
    if (previous && bindingDigest(previous) !== bindingDigest(binding)) throw new DomainError('CONFLICT', 'A pinned discovered provider identity cannot change');
    this.discovered.set(id, structuredClone(binding));
  }
  bindings(ref: Ref, owner: string): ProviderBinding[] {
    return [...this.providers.values()].filter(b => sameRef(b.capabilityRef, ref) && b.enabled && this.adapters.get(b.adapterId)!.permitted(owner)).map(b => structuredClone(b));
  }
  summaries(owner: string, limit = 16, environment: 'live' | 'sandbox' = 'live') {
    const permitted = [...this.services.values()].filter(s => (environment === 'sandbox' ? s.environment !== 'live' : s.environment !== 'sandbox') && (this.bindings(s.ref, owner).length || this.discoverySources(s.ref, owner).length));
    // Do not silently truncate an unsearched catalogue; add domain retrieval before scaling it.
    if (permitted.length > limit) throw new DomainError('CONFLICT', 'Capability retrieval limit exceeded; a narrower discovery scope is required');
    return permitted.map(s => ({ ref: structuredClone(s.ref), name: s.name, description: s.description, tags: [...s.tags], inputSchema: structuredClone(s.inputSchema), predicates: structuredClone(s.predicates), outcomePredicates: s.outcomePredicates ?? [], locationSemantics: s.locationSemantics }));
  }
  delegationService(): ServiceDefinition {
    const definitions = [...this.services.values()];
    return { id: 'eigos.delegate', name: 'Ontology-grounded EIGOS execution', requiredInputs: ['goal'],
      description: 'Submit a goal. Ontology + LLM ground the request, resolve provider facts, propose a versioned plan and independently verify delivery. Unknown hard requirements prevent execution. Registered business capabilities: ' + definitions.map(s => `${s.ref.id}: ${s.description}`).join(' | '),
      tags: ['delegation', 'ontology', 'planning'], examples: [], inputModes: ['text/plain', 'application/json'], outputModes: ['application/json', 'text/markdown'] };
  }
}
