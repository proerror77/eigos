import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';
import type { Computation } from './object-functions.js';
import { sourceProof } from './object-evidence.js';
import { assessDomain, domainResourceCriteria, requiredDomainResources, quoteRoleCriteria, type DomainAssessment } from './domain-rules.js';
import { domainEntityLinkName, parseDomainParameters, serviceDomains, type DomainDefinition } from './service-domains.js';
import type { ObjectView } from './object-store.js';

function candidateEntityChecks(store: OntologyObjectStore, owner: string, definition: DomainDefinition, candidate: ObjectView,
  requirement: ObjectView, parameters: Record<string, unknown>, budget: ReadBudget): { criteria: DomainAssessment['criteria']; refs: ObjectRef[]; levels: string[] } {
  const criteria: DomainAssessment['criteria'] = [], refs: ObjectRef[] = [], levels: string[] = [];
  const check = (id: string, result: 'pass' | 'fail' | 'unknown', reason: string) => criteria.push({ id, result, reason });
  const providers = store.related(owner, candidate.ref, 'provider', budget);
  const resources = new Map(definition.objects.map(type => {
    const name = domainEntityLinkName(type);
    return [type, { name, entities: store.related(owner, candidate.ref, name, budget),
      observations: store.related(owner, candidate.ref, `${name}Observations`, budget), explicit: store.related(owner, requirement.ref, name, budget) }];
  }));
  const explicitNamespaces = new Set<string>();
  for (const { explicit } of resources.values()) for (const selected of explicit ?? []) {
    const current = store.related(owner, selected.ref, 'currentObservation', budget);
    const provider = current?.length === 1 ? store.related(owner, current[0]!.ref, 'provider', budget) : undefined;
    if (!sourceProof(store, owner, selected.ref, budget) || provider?.length !== 1) check('resource_selection_source', 'unknown', 'An explicit resource selection lacks source-qualified identity evidence');
    else explicitNamespaces.add(provider[0]!.ref.id);
  }
  if (explicitNamespaces.size > 1) check('resource_selection_namespace', 'unknown', 'Resources from different provider namespaces need an explicit verified identity mapping');
  else if (explicitNamespaces.size === 1 && (providers?.length !== 1 || !explicitNamespaces.has(providers[0]!.ref.id))) check('resource_selection_namespace', 'fail', 'The candidate provider does not match the explicitly selected resource namespace');
  const alternatives = store.related(owner, requirement.ref, 'options', budget);
  const validated = new Map<string, ObjectView[]>();
  for (const type of definition.objects) {
    const { name, entities, observations, explicit } = resources.get(type)!;
    if (!entities || !observations || !explicit) {
      check(`${name}_scope`, 'unknown', 'Candidate resource references exceed the bounded evidence contract'); continue;
    }
    if (explicit.length && (explicit.length !== entities.length || explicit.some(value => !entities.some(e => e.ref.id === value.ref.id)))) {
      check(`${name}_selection`, 'fail', 'This candidate does not preserve the explicitly selected resource identities');
    }
    if (!entities.length && !observations.length) {
      if (requiredDomainResources[definition.id].includes(type)) check(`${name}_required`, 'unknown', 'A necessary requested resource has no authoritative typed observation');
      continue;
    }
    if (entities.length !== observations.length || providers?.length !== 1) {
      check(`${name}_scope`, 'unknown', 'Candidate resources require their own provider-bound observations'); continue;
    }
    const observationEntities = new Map<string, ObjectView[]>();
    for (const observation of observations) {
      const linked = store.related(owner, observation.ref, 'entity', budget);
      if (linked?.length === 1 && linked[0]!.ref.type === type) {
        const id = linked[0]!.ref.id; observationEntities.set(id, [...(observationEntities.get(id) ?? []), observation]);
      }
    }
    for (const entity of entities) {
      const matched = observationEntities.get(entity.ref.id) ?? [];
      if (matched.length !== 1) { check(`${name}_scope`, 'unknown', 'An exact resource observation is missing or ambiguous'); continue; }
      const observation = matched[0]!, observationProvider = store.related(owner, observation.ref, 'provider', budget);
      const entityProof = sourceProof(store, owner, entity.ref, budget), observationProof = sourceProof(store, owner, observation.ref, budget);
      refs.push(entity.ref, observation.ref, ...(entityProof?.refs ?? []), ...(observationProof?.refs ?? []));
      levels.push(...(entityProof?.levels ?? []), ...(observationProof?.levels ?? []));
      const p = entity.properties, o = observation.properties;
      if (!entityProof || !observationProof || observationProvider?.length !== 1 || observationProvider[0]!.ref.id !== providers[0]!.ref.id
        || o.valuesDigest !== digest(p) || digest(o.snapshot) !== digest(p) || o.sourceRevision !== p.sourceRevision || o.nativeIdentity !== p.sourceId) {
        check(`${name}_source`, 'unknown', 'The candidate resource is stale, changed, or belongs to another provider observation'); continue;
      }
      check(`${name}_source`, 'pass', 'Candidate resource identity and exact source observation are retained');
      validated.set(type, [...(validated.get(type) ?? []), entity]);
      const identity: Record<string, string> = { Hospital: 'hospitalId', MedicalDepartment: 'departmentId', Practitioner: 'practitionerId', FoodMerchant: 'merchantId', HotelProperty: 'hotelId', RoomType: 'roomTypeId', VehicleClass: 'vehicleClass' };
      if (identity[type]) check(`${name}_identity`, o.nativeIdentity === parameters[identity[type]!] ? 'pass' : 'fail', 'The source-native resource identity must match the explicit request within this provider namespace');
      if (identity[type] && explicitNamespaces.size === 0) {
        const matching = new Set<string>();
        for (const alternative of alternatives ?? []) {
          if (alternative.properties.requestRevision !== candidate.properties.requestRevision || !alternative.properties.expiresAt || Date.parse(String(alternative.properties.expiresAt)) <= store.now()) continue;
          const otherEntities = store.related(owner, alternative.ref, name, budget);
          if (!otherEntities) { check(`${name}_namespace`, 'unknown', 'Resource identity alternatives exceed the bounded comparison'); continue; }
          for (const other of otherEntities) if (other.properties.sourceId === parameters[identity[type]!]) matching.add(other.ref.id);
        }
        if (!alternatives || matching.size > 1) check(`${name}_namespace`, 'unknown', 'The requested native identifier matches different source-qualified resources; select an exact resource or provide a verified identity mapping');
      }
      criteria.push(...domainResourceCriteria(type, p, parameters, store.now()));
    }
  }
  if (definition.id === 'food') {
    const wanted = parameters.items as { sku: string }[], items = validated.get('MenuItem') ?? [];
    for (const item of wanted) {
      const matching = items.filter(value => value.properties.sku === item.sku);
      check('requested_menu_coverage', matching.length === 1 ? 'pass' : matching.length > 1 ? 'fail' : 'unknown', 'Every requested SKU requires exactly one source-qualified menu observation');
    }
  }
  if (definition.id === 'itinerary') {
    const wanted = parameters.legs as { id: string; origin: string; destination: string; startsAt: string; endsAt: string; transferMinutes: number }[], legs = validated.get('TravelLeg') ?? [];
    for (const leg of wanted) {
      const matching = legs.filter(value => value.properties.id === leg.id);
      check('requested_leg_coverage', matching.length === 1 ? 'pass' : matching.length > 1 ? 'fail' : 'unknown', 'Each requested itinerary leg requires its own feasibility observation');
    }
    for (const [index, leg] of wanted.entries()) {
      check('leg_window', Date.parse(leg.startsAt) >= Date.parse(String(parameters.startsAt)) && Date.parse(leg.endsAt) <= Date.parse(String(parameters.endsAt)) ? 'pass' : 'fail', 'Each requested leg must fit the task time window');
      const previous = wanted[index - 1];
      if (previous) check('leg_connection', previous.destination === leg.origin && Date.parse(leg.startsAt) >= Date.parse(previous.endsAt) + leg.transferMinutes * 60000 ? 'pass' : 'fail', 'Leg continuity and the requested transfer time must be physically possible');
    }
  }
  return { criteria, refs, levels };
}

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
    { id: 'terms', result: p.termsMatch === true ? 'pass' : p.termsMatch === false ? 'fail' : 'unknown', reason: 'The fixed cancellation, service and data terms must be covered' },
  ];
  const entities = candidateEntityChecks(store, owner, definition, object, requirement, parameters, budget);
  criteria.push(...entities.criteria); refs.push(...entities.refs); levels.push(...entities.levels);
  criteria.push(...quoteRoleCriteria(definition.id, parameters, p));
  const value: DomainAssessment = { status: criteria.some(c => c.result === 'fail') ? 'unsatisfied' : criteria.some(c => c.result === 'unknown') ? 'unknown' : 'satisfied', criteria, endpoint: 'eligible_option' };
  return { status: 'known', value, evidenceRefs: refs, evidenceLevels: levels };
}
