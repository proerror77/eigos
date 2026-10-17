import { DomainError, type Job } from './domain.js';
import type { ServiceDefinition } from './services.js';
import { type Ref, type ServiceCapability, type ProviderBinding, type CandidateFacts, type ExecutionPlan, type ServiceRequest } from '../ontology/execution.js';

export interface AdapterContext { owner: string; request: ServiceRequest }
export type Preparation = { kind: 'needs_input'; question: string } | {
  kind: 'ready'; input: Record<string, unknown>; details: Record<string, unknown>;
  facts: CandidateFacts; evidenceRefs: string[]; observedAt: string; expiresAt: string;
  authorization?: { amount: { minor: string; currency: string }; environment: 'local_simulation' };
  // Persisted privately; raw data and credentials never enter the model or task metadata.
  privateData?: unknown;
};
export interface Delivery { artifact: NonNullable<Job['artifact']>; facts: CandidateFacts; evidenceRefs: string[] }
export interface ExecutionAdapter {
  readonly id: string;
  permitted(owner: string): boolean;
  prepare(ctx: AdapterContext, input: unknown, signal: AbortSignal): Promise<Preparation>;
  execute(ctx: AdapterContext, plan: ExecutionPlan, privateData: unknown, signal: AbortSignal): Promise<Delivery>;
  verify(ctx: AdapterContext, plan: ExecutionPlan, privateData: unknown, delivery: Delivery): { accepted: boolean; reason: string };
}
const key = (ref: Ref) => JSON.stringify([ref.id, ref.version]);
export const sameRef = (a: Ref, b: Ref) => a.id === b.id && a.version === b.version;

export class ExecutionCatalog {
  private services = new Map<string, ServiceCapability>();
  private providers = new Map<string, ProviderBinding>();
  private adapters = new Map<string, ExecutionAdapter>();
  constructor(services: ServiceCapability[], bindings: ProviderBinding[], adapters: ExecutionAdapter[]) {
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
      this.providers.set(key(binding.ref), structuredClone(binding));
    }
  }
  capability(ref: Ref): ServiceCapability {
    const definition = this.services.get(key(ref));
    if (!definition) throw new DomainError('CONFLICT', 'Capability version is unavailable');
    return structuredClone(definition);
  }
  binding(ref: Ref, owner: string): { binding: ProviderBinding; adapter: ExecutionAdapter } {
    const binding = this.providers.get(key(ref));
    const adapter = binding && this.adapters.get(binding.adapterId);
    if (!binding?.enabled || !adapter?.permitted(owner)) throw new DomainError('FORBIDDEN', 'Provider binding is unavailable to this identity');
    return { binding: structuredClone(binding), adapter };
  }
  bindings(ref: Ref, owner: string): ProviderBinding[] {
    return [...this.providers.values()].filter(b => sameRef(b.capabilityRef, ref) && b.enabled && this.adapters.get(b.adapterId)!.permitted(owner)).map(b => structuredClone(b));
  }
  summaries(owner: string, limit = 16) {
    const permitted = [...this.services.values()].filter(s => this.bindings(s.ref, owner).length);
    // Do not silently truncate an unsearched catalogue; add domain retrieval before scaling it.
    if (permitted.length > limit) throw new DomainError('CONFLICT', 'Capability retrieval limit exceeded; a narrower discovery scope is required');
    return permitted.map(s => ({ ref: structuredClone(s.ref), name: s.name, description: s.description, tags: [...s.tags], inputSchema: structuredClone(s.inputSchema), predicates: structuredClone(s.predicates) }));
  }
  delegationService(): ServiceDefinition {
    const definitions = [...this.services.values()];
    return { id: 'eigos.delegate', name: 'Ontology-grounded EIGOS execution', requiredInputs: ['goal'],
      description: 'Submit a goal. Ontology + LLM ground the request, resolve provider facts, propose a versioned plan and independently verify delivery. Unknown hard requirements prevent execution. Registered business capabilities: ' + definitions.map(s => `${s.ref.id}: ${s.description}`).join(' | '),
      tags: ['delegation', 'ontology', 'planning'], examples: [], inputModes: ['text/plain', 'application/json'], outputModes: ['application/json', 'text/markdown'] };
  }
}
