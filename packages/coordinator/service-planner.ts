import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ActionDiscoveryPage, ActionDiscoveryQuery, DiscoveredActionBinding } from '../core/action-bindings.js';
import type { ServiceRequest } from '../ontology/execution.js';
import type { OntologyModel } from '../ontology/model.js';
import type { GraphProgram } from '../ontology/graph-program.js';
import { assertPortCompatible, actionEffects } from '../ontology/composition-contract.js';
import { servicePlanningSchema, type ServicePlanningInput, type ServiceNeed, type ServiceNeedPlan, type ServicePlanningContract, type PlannedServiceStep } from '../ontology/service-planning.js';

const fail = (message: string): never => { throw new DomainError('INVALID_INPUT', message); };
type Discovered = { action: ActionDiscoveryPage['items'][number]['action']; binding: DiscoveredActionBinding };
type Discovery = { items: Discovered[]; complete: boolean };
type Discover = (query: ActionDiscoveryQuery) => GraphProgram<ActionDiscoveryPage>;

/** Pure, bounded requirement expansion. Selecting this rule does not authorize
 * travel, and omitted lodging/dining/transfers are never silently added. */
export function expandServiceNeeds(input: ServicePlanningInput): ServiceNeedPlan[] {
  const goal = input.goal;
  if (goal.kind === 'needs') return goal.needs.map(need => empty(need));
  const output = (quote: string, commitment: string) => ({ type: goal.phase === 'quote' ? quote : commitment, phase: goal.phase });
  const make = (id: string, role: string, type: ServiceNeed['output'], region: string, target: ServiceNeed['target'], dependsOn: string[] = []) => empty({
    id, role, source: goal.source, output: type, target: { ...target, participants: goal.participants },
    serviceConditions: { region }, ...(goal.payment ? { payment: goal.payment } : {}), dependsOn,
  }, { rule: 'travel.round_trip', version: '1', source: goal.source });
  const needs = [
    make('outbound_flight', 'flight.outbound', output('FlightOffer', 'FlightReservation'), goal.originRegion, { origin: goal.origin, destination: goal.destination }),
    make('return_flight', 'flight.return', output('FlightOffer', 'FlightReservation'), goal.destinationRegion, { origin: goal.destination, destination: goal.origin }),
  ];
  if (goal.lodging) needs.push(make('lodging', 'lodging.stay', output('HotelOption', 'HotelReservation'), goal.destinationRegion, { destination: goal.destination }));
  if (goal.arrivalTransfer) needs.push(make('arrival_transfer', 'transfer.arrival', output('VehicleOption', 'VehicleBooking'), goal.destinationRegion,
    { destination: goal.destination }, ['outbound_flight', ...(goal.lodging ? ['lodging'] : [])]));
  if (goal.departureTransfer) needs.push(make('departure_transfer', 'transfer.departure', output('VehicleOption', 'VehicleBooking'), goal.destinationRegion,
    { origin: goal.destination }, ['return_flight', ...(goal.lodging ? ['lodging'] : [])]));
  if (goal.dining) needs.push(make('dining', 'dining.reservation', output('ReservationOffer', 'Reservation'), goal.destinationRegion,
    { destination: goal.destination }, goal.lodging ? ['lodging'] : []));
  // A root ceiling is not an allocation to every service. It is returned at
  // plan level and remains unknown until complete, de-duplicated costs exist.
  return needs;
}
function empty(need: ServiceNeed, derivedBy?: ServiceNeedPlan['derivedBy']): ServiceNeedPlan {
  return { need, ...(derivedBy ? { derivedBy } : {}), coverage: 'complete', alternatives: [], gaps: [], applicability: [
    { check: 'actual_scope_and_time', result: 'unknown', reason: 'Declared coverage does not establish the exact route, venue or service time' },
    { check: 'live_availability', result: 'unknown', reason: 'A current provider observation is required' },
    ...(need.payment ? [{ check: 'payment_acceptance', result: 'unknown' as const, reason: 'The exact merchant, instrument, currency and market require current acceptance evidence' }] : []),
    ...(need.budget ? [{ check: 'budget', result: 'unknown' as const, reason: 'A complete current quote in the budget currency is required' }] : []),
  ] };
}
function validateNeeds(needs: ServiceNeedPlan[], request: ServiceRequest) {
  const ids = new Set(needs.map(value => value.need.id));
  if (ids.size !== needs.length) fail('Service need identities must be unique');
  for (const { need } of needs) {
    if (!request.messages.some(message => message.id === need.source.messageId && message.text.includes(need.source.quote))) fail('Service need has no exact current-task instruction quotation');
    if (new Set(need.dependsOn).size !== need.dependsOn.length || need.dependsOn.some(id => !ids.has(id))) fail('Service need dependency is unknown or repeated');
    if (need.target.startsAt && need.target.endsAt && Date.parse(need.target.startsAt) >= Date.parse(need.target.endsAt)) fail('Service need time range must increase');
    if (need.target.timeZone) { try { new Intl.DateTimeFormat('en', { timeZone: need.target.timeZone }); } catch { fail('Invalid service time zone'); } }
  }
  const visited = new Set<string>();
  const visit = (id: string, path: Set<string>) => {
    if (path.has(id)) fail('Service need dependencies must be acyclic');
    if (visited.has(id)) return;
    for (const previous of needs.find(value => value.need.id === id)!.need.dependsOn) visit(previous, new Set([...path, id]));
    visited.add(id);
  };
  for (const id of ids) visit(id, new Set());
}
function required(action: Discovered['action']) {
  return (action.inputSchema ?? action.read?.inputSchema ?? action.operation?.inputSchema ?? {}) as { required?: string[] };
}
function compatible(model: OntologyModel, item: Discovered, need: ServiceNeed): boolean {
  return Object.values(item.action.composition?.outputs ?? {}).some(port => port.kind === 'object'
    && model.assignableType(port.type, need.output.type) && port.semantics.phase === need.output.phase
    && port.cardinality === (need.output.cardinality ?? 'one')
    && (!need.output.role || port.semantics.role === need.output.role));
}

/** Reads metadata only. No AgentProgram initialize/invoke, provider query,
 * executable plan, authorization, result observation or model run is created. */
export function* planServicesProgram(request: ServiceRequest, model: OntologyModel, raw: unknown, discover: Discover, active: () => void = () => {}, typeAvailable: (id: string) => boolean = id => model.hasType(id)) {
  const input = servicePlanningSchema.parse(raw), needs = expandServiceNeeds(input);
  validateNeeds(needs, request);
  let pages = 0;
  const proofs: string[] = [], contracts = new Map<string, ServicePlanningContract>();
  const cache = new Map<string, Discovery>();
  function* find(query: ActionDiscoveryQuery): GraphProgram<Discovery> {
    const key = digest(query), cached = cache.get(key);
    if (cached) return cached;
    const items: Discovered[] = [];
    let cursor: string | undefined, complete = false;
    do {
      active();
      if (pages >= input.maxDiscoveryPages) break;
      const page = yield* discover({ ...query, limit: 10, ...(cursor ? { cursor } : {}) });
      pages++; proofs.push(page.snapshotDigest);
      if (page.requestId !== request.id || page.requestRevision !== request.revision) fail('Discovery belongs to another task revision');
      for (const item of page.items) for (const binding of item.bindings) {
        const pin = binding.pin;
        if (pin.requestId !== request.id || pin.requestRevision !== request.revision || digest(pin.ontologyRelease) !== digest(page.ontologyRelease)) fail('Discovery binding has another task or release');
        items.push({ action: item.action, binding });
        const pipeline = binding.pipeline?.conditions;
        const contract: ServicePlanningContract = { version: '1', binding: pin, effects: actionEffects(item.action),
          inputs: item.action.composition?.inputs ?? {}, outputs: item.action.composition?.outputs ?? {},
          requiredArguments: required(item.action).required ?? [], contextInputSchema: binding.inputSchema,
          submissionCriteria: item.action.submissionCriteria, sourceDependencies: item.action.read?.mcp?.requires ?? [],
          ...(pipeline ? { declaredConditions: structuredClone(pipeline) } : {}),
          readiness: binding.readiness, reason: binding.reason };
        contracts.set(pin.digest, contract);
      }
      complete = !page.page.hasMore;
      if (!complete && (!page.page.cursor || page.page.cursor === cursor)) fail('Discovery pagination failed to advance');
      cursor = page.page.cursor;
    } while (!complete);
    const result = { items, complete }; cache.set(key, result); return result;
  }
  for (const plan of needs) {
    active();
    const need = plan.need;
    if (!typeAvailable(need.output.type)) {
      plan.gaps.push({ code: 'definition_missing', reason: `Output type ${need.output.type} is unavailable in this task's permitted published view; no provider availability claim is possible` });
      continue;
    }
    const results = yield* find({ outputType: need.output.type, ...(need.serviceConditions ? { serviceConditions: need.serviceConditions } : {}) });
    if (!results.complete) plan.coverage = 'incomplete';
    for (const root of results.items.filter(item => compatible(model, item, need))) {
      if (plan.alternatives.length >= input.maxAlternatives) break;
      if (root.binding.readiness !== 'ready') { plan.gaps.push({ code: root.binding.readiness, reason: root.binding.reason }); continue; }
      const steps: PlannedServiceStep[] = [];
      function* expand(item: Discovered, role: string, path: string[], ancestors: Set<string>): GraphProgram<PlannedServiceStep | undefined> {
        const key = `${item.binding.pin.programRef.id}:${item.action.id}`;
        if (ancestors.has(key) || path.length > 6 || steps.length >= 16) {
          plan.gaps.push({ code: 'dependency_bound', reason: 'A declared action dependency is cyclic or exceeds the planning bound' }); return;
        }
        const next = new Set([...ancestors, key]);
        const step: PlannedServiceStep = { id: `${need.id.slice(0, 46)}_${digest({ path, binding: item.binding.pin.digest }).slice(0, 16)}`, needId: need.id, role,
          action: item.action.id, bindingDigest: item.binding.pin.digest, dependsOn: [], inputBindings: [], unresolvedArguments: [...(required(item.action).required ?? [])] };
        for (const dep of item.action.read?.mcp?.requires ?? []) {
          const sources = yield* find({ actionId: dep.action, programRef: item.binding.pin.programRef,
            ...(need.serviceConditions ? { serviceConditions: need.serviceConditions } : {}) });
          if (!sources.complete) plan.coverage = 'incomplete';
          const source = sources.items.find(value => value.action.id === dep.action && value.binding.readiness === 'ready');
          const destinationPort = item.action.composition?.inputs[dep.observationInput];
          const port = source && Object.entries(source.action.composition?.outputs ?? {}).find(([, value]) => {
            if (!destinationPort || value.kind !== 'object' || !model.assignableType(value.type, dep.objectType)) return false;
            try { assertPortCompatible(model, value, destinationPort); return true; } catch { return false; }
          });
          if (!source || !port) { plan.gaps.push({ code: 'dependency_unavailable', reason: `No current compatible ${dep.action} output for ${dep.observationInput}` }); return; }
          const producer = yield* expand(source, dep.name, [...path, dep.name], next);
          if (!producer) return;
          step.dependsOn.push(producer.id);
          step.inputBindings.push({ targetKey: dep.observationInput, stepId: producer.id, port: port[0], evaluate: dep.evaluate });
          if (dep.selectionInput && dep.derive) step.inputBindings.push({ targetKey: dep.selectionInput, stepId: producer.id, port: port[0], derive: dep.derive });
        }
        step.unresolvedArguments = step.unresolvedArguments.filter(name => !step.inputBindings.some(binding => binding.targetKey === name));
        if (steps.length >= 16) { plan.gaps.push({ code: 'dependency_bound', reason: 'Action dependency count exceeds the planning bound' }); return; }
        steps.push(step); return step;
      }
      const rootStep = yield* expand(root, need.role, [need.id, root.action.id], new Set());
      if (rootStep) plan.alternatives.push({ rootStepId: rootStep.id, steps, bindingDigests: [...new Set(steps.map(step => step.bindingDigest))] });
    }
    if (!plan.alternatives.length && !plan.gaps.length) plan.gaps.push({ code: results.complete ? 'binding_unavailable' : 'coverage_incomplete',
      reason: results.complete ? 'No compatible current binding in the permitted configured catalog' : 'The bounded discovery did not cover every candidate' });
  }
  const used = new Set(needs.flatMap(need => need.alternatives.flatMap(alternative => alternative.bindingDigests)));
  const selectedContracts = [...contracts.values()].filter(contract => used.has(contract.binding.digest));
  const body = { version: '1' as const, planner: { id: 'eigos.service-planner', version: '1' },
    requestId: request.id, requestRevision: request.revision, requestDigest: digest(request), model: model.ref, inputDigest: digest(input),
    needs, contracts: selectedContracts, discoveryPages: pages, discoveryDigest: digest(proofs),
    coverage: needs.every(need => need.coverage === 'complete') ? 'complete' as const : 'incomplete' as const,
    ...(input.goal.kind === 'round_trip' && input.goal.budget ? { totalBudget: input.goal.budget,
      budgetStatus: 'unknown' as const, budgetReason: 'No complete current costs or currency conversion evidence have been read' } : {}),
    execution: 'not_started' as const, executionAllowed: false as const, availabilityProof: false as const, businessCompletion: false as const, authorization: 'per_action_required' as const,
  };
  active();
  return { ...body, digest: digest(body) };
}

export type ServicePlan = ReturnType<typeof planServicesProgram> extends GraphProgram<infer Result> ? Result : never;
