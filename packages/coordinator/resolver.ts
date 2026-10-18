import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import { ExecutionCatalog, bindingDigest, type AdapterContext, type Preparation } from '../core/catalog.js';
import { digest } from '../core/delegation.js';
import { moneySchema, type CandidateFacts, type Ref, type RequirementCheck, type ServiceRequest, type ResolvedCandidate, type ResolutionScope } from '../ontology/execution.js';
import type { Comparison, DiscoveryCoverage, ProductOfferSnapshot } from '../ontology/supply.js';
import { compareOffers } from './comparison.js';
export type { ResolvedCandidate } from '../ontology/execution.js';

class DiscoveryTimeout extends Error {
  constructor() { super('Capability discovery timed out'); }
}

// Abort signals alone cannot bound an adapter that ignores cancellation. Race the
// wait too, and never let a late response reach candidate registration.
async function resolveCall<T>(call: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  let rejectOnAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  signal.addEventListener('abort', forwardAbort, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new DiscoveryTimeout()), timeoutMs);
  try {
    // Attach both settlement handlers before invoking the adapter, including
    // adapters that throw synchronously or reject after cancellation.
    const result = await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return call(controller.signal);
    }), aborted]);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', forwardAbort);
    controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}

export function checkRequirements(request: ServiceRequest, facts: CandidateFacts, evidenceRefs: string[], predicates: string[] = [], locationSemantics?: 'search_area' | 'destination'): RequirementCheck[] {
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
      case 'location': {
        if (facts.locationRef === requirement.expected.ref) pass = true;
        else if (locationSemantics === 'search_area' && facts.searchArea) {
          const city = facts.searchArea.city.replace(/市$/, '').replace(/\s/g, ''); const keyword = facts.searchArea.keyword.replace(/\s/g, '').replace(/(?:附近|周边)(?:的)?$/, '');
          const target = requirement.expected.ref.replace(/\s/g, '').replace(/(?:附近|周边)(?:的)?$/, '');
          const original = request.originalGoal + request.messages.map(m => m.text).join('');
          const stripCity = (s: string) => s.startsWith(city) ? s.slice(city.length).replace(/^市/, '') : s;
          if (city && (target.replace(/市$/, '') === city || (stripCity(target) === stripCity(keyword) && (target.startsWith(city) || original.includes(city))))) pass = true;
        } else if (facts.locationRef) pass = false;
        break;
      }
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
  comparison?: Comparison;
}
export class CapabilityResolver {
  constructor(private catalog: ExecutionCatalog, private providerEvidence?: (owner: string, bindingRef: Ref, definitionDigest: string) => unknown) {}
  async resolve(ctx: AdapterContext, capabilityRef: Ref, input: unknown, signal: AbortSignal): Promise<Resolution> {
    const bindings = this.catalog.bindings(capabilityRef, ctx.owner);
    const predicates = this.catalog.capability(capabilityRef).predicates.map(p => p.id);
    const locationSemantics = this.catalog.capability(capabilityRef).locationSemantics;
    if (bindings.length > 8) throw new DomainError('CONFLICT', 'Provider retrieval limit exceeded; narrow the discovery scope');
    const candidates: ResolvedCandidate[] = []; const privateData = new Map<string, unknown>(); const coverage: DiscoveryCoverage[] = [];
    const append = (binding: ResolvedCandidate['binding'], preparation: Preparation, offer?: ProductOfferSnapshot) => {
      const id = randomUUID();
      if (preparation.kind === 'unavailable') {
        candidates.push({ id, binding, status: 'unavailable', question: preparation.reason, details: preparation.details, facts: {}, evidenceRefs: [], requirementChecks: checkRequirements(ctx.request, {}, []), observedAt: new Date().toISOString(), expiresAt: new Date().toISOString() }); return;
      }
      if (preparation.kind === 'needs_input') {
        candidates.push({ id, binding, status: 'needs_input', question: preparation.question, details: preparation.details, facts: {}, evidenceRefs: [], requirementChecks: checkRequirements(ctx.request, {}, []), observedAt: new Date().toISOString(), expiresAt: new Date().toISOString() }); return;
      }
      const checks = checkRequirements(ctx.request, preparation.facts, preparation.evidenceRefs, predicates, locationSemantics);
      const quoteBody = preparation.authorization ? { id: randomUUID(), amount: moneySchema.parse(preparation.authorization.amount), expiresAt: preparation.expiresAt, environment: preparation.authorization.environment,
        requestDigest: digest(ctx.request), bindingRef: binding.ref, bindingDigest: bindingDigest(binding), inputDigest: digest(preparation.input), detailsDigest: digest(preparation.details) } : undefined;
      candidates.push({ id, binding, status: 'ready', input: structuredClone(preparation.input), details: structuredClone(preparation.details), facts: structuredClone(preparation.facts),
        ...(preparation.recipe ? { recipe: structuredClone(preparation.recipe) } : {}),
        evidenceRefs: [...preparation.evidenceRefs], requirementChecks: checks, observedAt: preparation.observedAt, expiresAt: preparation.expiresAt, ...(offer ? { offer } : {}),
        ...(quoteBody ? { quote: { ...quoteBody, digest: digest(quoteBody) } } : {}) });
      privateData.set(id, preparation.privateData);
    };
    for (const binding of bindings) {
      signal.throwIfAborted();
      const { adapter } = this.catalog.binding(binding.ref, ctx.owner);
      let preparation: Preparation;
      try { preparation = await resolveCall(bounded => adapter.prepare(structuredClone(ctx), structuredClone(input), bounded), signal); }
      catch (error) {
        signal.throwIfAborted();
        if (error instanceof DomainError || error instanceof SyntaxError) throw error;
        candidates.push({ id: randomUUID(), binding, status: 'unavailable', facts: {}, evidenceRefs: [], requirementChecks: checkRequirements(ctx.request, {}, []), observedAt: new Date().toISOString(), expiresAt: new Date().toISOString() });
        continue;
      }
      signal.throwIfAborted();
      append(binding, preparation);
    }
    for (const source of this.catalog.discoverySources(capabilityRef, ctx.owner)) {
      signal.throwIfAborted();
      try {
        const result = await resolveCall(bounded => source.discover(structuredClone(ctx), structuredClone(input), bounded), signal, 60000);
        signal.throwIfAborted(); coverage.push(result.coverage);
        if (result.candidates.length + candidates.length > 8) throw new DomainError('CONFLICT', 'Discovery exceeded the bounded candidate limit');
        for (const discovered of result.candidates) { this.catalog.registerDiscovered(ctx, discovered.binding); append(discovered.binding, discovered.preparation, discovered.offer); }
      } catch (error) {
        signal.throwIfAborted(); if (error instanceof DomainError && error.code === 'INVALID_INPUT') throw error;
        coverage.push({ sourceId: source.id, status: error instanceof DiscoveryTimeout ? 'timeout' : error instanceof DomainError && error.code === 'FORBIDDEN' ? 'needs_authorization' : 'unavailable', queriedAt: new Date().toISOString(), returnedStores: 0, queriedStores: 0, hasMore: false, realSupply: source.realSupply ?? true });
      }
    }
    const offers = candidates.flatMap(c => c.offer ? [c.offer] : []);
    const comparison = offers.length ? compareOffers(ctx.request, offers, coverage) : undefined;
    if (comparison) for (const candidate of candidates) if (candidate.offer && candidate.details) {
      candidate.details.comparisonDigest = digest(comparison);
      const payload = privateData.get(candidate.id);
      if (payload && typeof payload === 'object') privateData.set(candidate.id, { ...payload, comparison });
    }
    if (this.providerEvidence) for (const candidate of candidates) candidate.details = { ...(candidate.details ?? {}), operationalEvidence: this.providerEvidence(ctx.owner, candidate.binding.ref, bindingDigest(candidate.binding)) };
    return { candidates, privateData, scope: { capabilityRef, searchedBindingRefs: candidates.map(c => c.binding.ref), observedAt: new Date().toISOString(), realSupply: coverage.some(c => c.realSupply && c.status === 'returned') || candidates.some(c => c.status === 'ready' && c.details?.evidenceKind === 'live_readonly'), coverage },
      ...(comparison ? { comparison } : {}) };
  }
}
