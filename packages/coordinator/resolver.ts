import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import { ExecutionCatalog, type AdapterContext, type Preparation } from '../core/catalog.js';
import { digest } from '../core/delegation.js';
import { moneySchema, type CandidateFacts, type Ref, type RequirementCheck, type ServiceRequest, type ResolvedCandidate, type ResolutionScope } from '../ontology/execution.js';
export type { ResolvedCandidate } from '../ontology/execution.js';

export function checkRequirements(request: ServiceRequest, facts: CandidateFacts, evidenceRefs: string[], predicates: string[] = []): RequirementCheck[] {
  return request.requirements.map(requirement => {
    let pass: boolean | undefined;
    switch (requirement.kind) {
      case 'quantity': if (facts.quantity && /^(0|[1-9]\d*)$/.test(facts.quantity.amount)) pass = facts.quantity.unit === requirement.expected.unit && facts.quantity.amount === requirement.expected.amount; break;
      case 'budget': {
        const price = moneySchema.safeParse(facts.totalPrice);
        if (price.success && price.data.currency === requirement.expected.currency) pass = BigInt(price.data.minor) <= BigInt(requirement.expected.minor);
        break;
      }
      case 'deadline': if (facts.deliveryBy && z.iso.datetime({ offset: true }).safeParse(facts.deliveryBy).success) pass = Date.parse(facts.deliveryBy) <= Date.parse(requirement.expected.at); break;
      case 'location': if (facts.locationRef) pass = facts.locationRef === requirement.expected.ref; break;
      case 'condition': if (predicates.includes(requirement.expected.predicate) && facts.conditions) pass = facts.conditions.includes(requirement.expected.predicate); break;
    }
    const result = pass === undefined || !evidenceRefs.length ? 'unknown' : pass ? 'pass' : 'fail';
    return { requirementId: requirement.id, result, reason: result === 'unknown' ? 'No compatible, evidenced fact for this requirement' : result === 'pass' ? 'Observed fact meets the fixed requirement' : 'Observed fact violates the fixed requirement', evidenceRefs: [...evidenceRefs] };
  });
}
export function hardRequirementsPass(request: ServiceRequest, checks: RequirementCheck[]): boolean {
  return request.requirements.filter(r => r.strength === 'hard').every(r => checks.find(c => c.requirementId === r.id)?.result === 'pass');
}
export interface Resolution {
  candidates: ResolvedCandidate[];
  privateData: Map<string, unknown>;
  scope: ResolutionScope;
}
export class CapabilityResolver {
  constructor(private catalog: ExecutionCatalog) {}
  async resolve(ctx: AdapterContext, capabilityRef: Ref, input: unknown, signal: AbortSignal): Promise<Resolution> {
    const bindings = this.catalog.bindings(capabilityRef, ctx.owner);
    const predicates = this.catalog.capability(capabilityRef).predicates.map(p => p.id);
    if (bindings.length > 8) throw new DomainError('CONFLICT', 'Provider retrieval limit exceeded; narrow the discovery scope');
    const candidates: ResolvedCandidate[] = []; const privateData = new Map<string, unknown>();
    for (const binding of bindings) {
      signal.throwIfAborted();
      const { adapter } = this.catalog.binding(binding.ref, ctx.owner);
      let preparation: Preparation;
      try { preparation = await adapter.prepare(structuredClone(ctx), structuredClone(input), signal); }
      catch (error) {
        signal.throwIfAborted();
        if (error instanceof DomainError || error instanceof SyntaxError) throw error;
        candidates.push({ id: randomUUID(), binding, status: 'unavailable', facts: {}, evidenceRefs: [], requirementChecks: checkRequirements(ctx.request, {}, []), observedAt: new Date().toISOString(), expiresAt: new Date().toISOString() });
        continue;
      }
      const id = randomUUID();
      if (preparation.kind === 'needs_input') {
        candidates.push({ id, binding, status: 'needs_input', question: preparation.question, facts: {}, evidenceRefs: [], requirementChecks: checkRequirements(ctx.request, {}, []), observedAt: new Date().toISOString(), expiresAt: new Date().toISOString() });
        continue;
      }
      const checks = checkRequirements(ctx.request, preparation.facts, preparation.evidenceRefs, predicates);
      const quoteBody = preparation.authorization ? { id: randomUUID(), amount: moneySchema.parse(preparation.authorization.amount), expiresAt: preparation.expiresAt, environment: preparation.authorization.environment } : undefined;
      candidates.push({ id, binding, status: 'ready', input: structuredClone(preparation.input), details: structuredClone(preparation.details), facts: structuredClone(preparation.facts),
        evidenceRefs: [...preparation.evidenceRefs], requirementChecks: checks, observedAt: preparation.observedAt, expiresAt: preparation.expiresAt,
        ...(quoteBody ? { quote: { ...quoteBody, digest: digest(quoteBody) } } : {}) });
      privateData.set(id, preparation.privateData);
    }
    return { candidates, privateData, scope: { capabilityRef, searchedBindingRefs: bindings.map(b => b.ref), observedAt: new Date().toISOString(), realSupply: false } };
  }
}
