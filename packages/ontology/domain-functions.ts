import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';
import type { Computation } from './object-functions.js';
import { sourceProof } from './object-evidence.js';
import { assessDomain, type DomainAssessment } from './domain-rules.js';
import { parseDomainParameters, serviceDomains } from './service-domains.js';

export function evaluateDomainFunction(store: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  const definition = serviceDomains.find(d => [d.eligibleFunction, d.outcomeFunction].includes(input.function));
  if (!definition) return;
  const outcome = input.function === definition.outcomeFunction;
  if (input.object.type !== (outcome ? definition.resultType : definition.candidateType)) throw new DomainError('INVALID_INPUT', 'Function requires its registered domain object type');
  const object = store.read(owner, input.object, budget), proof = sourceProof(store, owner, object.ref, budget);
  const refs: ObjectRef[] = [object.ref, ...(proof?.refs ?? [])], levels = proof?.levels ?? [];
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: refs, evidenceLevels: levels });
  if (!proof) return unknown('Domain observation lacks current, scope-bound source evidence');
  const requirements = store.related(owner, object.ref, 'requirements', budget), requests = store.related(owner, object.ref, 'request', budget);
  if (requirements?.length !== 1 || requests?.length !== 1) return unknown('Domain request binding is incomplete');
  const requirement = requirements[0]!, request = requests[0]!;
  const requirementRequest = store.related(owner, requirement.ref, 'request', budget);
  if (requirementRequest?.length !== 1 || requirementRequest[0]!.ref.id !== request.ref.id || requirement.properties.requestRevision !== request.properties.revision || object.properties.requestRevision !== request.properties.revision) return unknown('Domain facts belong to another request or an obsolete requirement revision');
  refs.push(requirement.ref, request.ref);
  const { objectId: _id, displayTitle: _title, requestRevision: _revision, capturedAt: _captured, ...raw } = requirement.properties;
  let parameters: ReturnType<typeof parseDomainParameters>;
  try { parameters = parseDomainParameters(definition.id, raw); } catch { return unknown('Domain requirements are incomplete or inconsistent'); }
  if (outcome) {
    const options = store.related(owner, object.ref, 'selectedOption', budget);
    if (options?.length !== 1 || options[0]!.properties.parametersDigest !== digest(parameters)) return unknown('The result does not retain its selected option and exact requirement snapshot');
    const optionRequest = store.related(owner, options[0]!.ref, 'request', budget);
    const optionRequirements = store.related(owner, options[0]!.ref, 'requirements', budget);
    if (optionRequest?.length !== 1 || optionRequest[0]!.ref.id !== request.ref.id || optionRequirements?.length !== 1 || optionRequirements[0]!.ref.id !== requirement.ref.id) return unknown('The selected option belongs to another business request');
    refs.push(options[0]!.ref);
    const { objectId: _a, displayTitle: _b, requestRevision: _c, sourceVersion: _v, ...result } = object.properties;
    let value: DomainAssessment;
    try { value = assessDomain(definition.id, parameters, result, store.now()); } catch { return unknown('Domain result does not satisfy the registered observation schema'); }
    return { status: 'known', value, evidenceRefs: refs, evidenceLevels: levels };
  }
  const p = object.properties;
  if (p.parametersDigest !== digest(parameters) || !p.offeredParameters || digest(p.offeredParameters) !== digest(parameters)) return unknown('The source option is not bound to all fixed domain requirements');
  if (!p.observedAt || Date.parse(String(p.observedAt)) > store.now() || !p.expiresAt || Date.parse(String(p.expiresAt)) <= store.now()) return unknown('Domain option freshness is missing or expired');
  const price = p.total as { minor?: string; currency?: string } | undefined;
  const maximum = parameters.budget;
  const criteria: DomainAssessment['criteria'] = [
    { id: 'availability', result: p.availability === 'available' ? 'pass' : p.availability === 'unavailable' ? 'fail' : 'unknown', reason: 'Current source availability for the requested quantity and period' },
    { id: 'eligibility', result: p.eligibility === 'verified' ? 'pass' : p.eligibility === 'ineligible' ? 'fail' : 'unknown', reason: 'Domain eligibility must be explicitly verified' },
    { id: 'complete_price', result: p.feesComplete !== true || !price?.minor || price.currency !== maximum.currency ? 'unknown' : BigInt(price.minor) <= BigInt(maximum.minor) ? 'pass' : 'fail', reason: 'All mandatory fees in the requested currency' },
    { id: 'terms', result: p.termsMatch === true ? 'pass' : 'unknown', reason: 'The fixed cancellation, service and data terms must be covered' },
  ];
  const value: DomainAssessment = { status: criteria.some(c => c.result === 'fail') ? 'unsatisfied' : criteria.some(c => c.result === 'unknown') ? 'unknown' : 'satisfied', criteria, endpoint: 'eligible_option' };
  return { status: 'known', value, evidenceRefs: refs, evidenceLevels: levels };
}
