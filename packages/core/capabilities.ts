import { DomainError, type Job } from './domain.js';
import type { ServiceDefinition } from './services.js';

export interface CapabilityDefinition {
  id: string;
  version: string;
  providerId: string;
  ontologyVersion: string;
  service: ServiceDefinition;
  inputSchema: object;
  ontology: object;
  // Explicit adapter-owned migration path, never an implicit fallback provider.
  legacyOntologyVersions?: string[];
}
export type Preparation = { kind: 'needs_input'; question: string } | {
  kind: 'ready'; input: Record<string, unknown>; details: Record<string, unknown>; prepared?: unknown;
};
export interface RegisteredCapability {
  readonly definition: CapabilityDefinition;
  available(owner: string): boolean;
  prepare(job: Job, input: unknown): Preparation;
  // Invoked inside the fenced task transaction. Domain execution/verification belong here or in tick().
  start(job: Job, preparation: Extract<Preparation, { kind: 'ready' }>): void;
  authorize?(job: Job, input: unknown): void;
  cancel?(job: Job): void;
  tick?(): void;
}
export class CapabilityRegistry {
  private readonly entries = new Map<string, RegisteredCapability>();
  constructor(capabilities: RegisteredCapability[]) {
    for (const capability of capabilities) {
      if (this.entries.has(capability.definition.id)) throw new Error('Duplicate capability registration');
      this.entries.set(capability.definition.id, capability);
    }
  }
  definitions(owner?: string): CapabilityDefinition[] {
    return [...this.entries.values()].filter(c => owner === undefined || c.available(owner)).map(c => structuredClone(c.definition));
  }
  get(id: string, owner: string): RegisteredCapability {
    const capability = this.entries.get(id);
    if (!capability || !capability.available(owner)) throw new DomainError('INVALID_INPUT', 'Capability is not registered or available to this identity');
    return capability;
  }
  forJob(job: Job, owner: string): RegisteredCapability {
    const d = job.delegation;
    if (!d) throw new DomainError('CONFLICT', 'Task has no selected capability');
    if (!d.capabilityId) {
      const legacy = [...this.entries.values()].filter(c => c.definition.legacyOntologyVersions?.includes(d.ontologyVersion) && c.available(owner));
      if (legacy.length === 1) return legacy[0]!;
      throw new DomainError('CONFLICT', 'Task has no available capability binding');
    }
    const capability = this.get(d.capabilityId, owner);
    if (capability.definition.version !== d.capabilityVersion || capability.definition.providerId !== d.providerId || capability.definition.ontologyVersion !== d.ontologyVersion) {
      throw new DomainError('CONFLICT', 'Selected capability version is unavailable; do not substitute a different provider');
    }
    return capability;
  }
  tick(): void { for (const capability of this.entries.values()) capability.tick?.(); }
  delegationService(): ServiceDefinition {
    const definitions = this.definitions();
    return {
      id: 'eigos.delegate', name: 'Delegate to registered EIGOS capabilities', requiredInputs: ['goal'],
      description: 'Submit a goal in natural language. EIGOS selects only a registered capability matching the requested outcome, asks for missing inputs, validates its plan and applies capability-specific execution and acceptance. Unsupported outcomes are rejected, not silently changed. Current registered capabilities: ' + definitions.map(d => `${d.id}: ${d.service.description}`).join(' | '),
      tags: ['delegation', 'ontology', ...new Set(definitions.flatMap(d => d.service.tags))],
      examples: definitions.flatMap(d => d.service.examples).slice(0, 8), inputModes: ['text/plain', 'application/json'],
      outputModes: [...new Set(definitions.flatMap(d => d.service.outputModes))],
    };
  }
}
