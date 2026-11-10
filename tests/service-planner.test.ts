import assert from 'node:assert/strict';
import { test } from 'node:test';
import { servicePlanningSchema, type ServiceNeed } from '../packages/ontology/service-planning.js';
import { expandServiceNeeds, planServicesProgram } from '../packages/coordinator/service-planner.js';
import { OntologyPlanningSession, planningToolCatalog } from '../packages/coordinator/planning-session.js';
import { setupDidi, input } from './fixtures/didi.js';
import { owner } from './backend-fixture.js';
import { DIDI_PROGRAM_REF } from '../packages/capabilities/didi/program.js';
import { digest } from '../packages/core/delegation.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';
import { DomainError } from '../packages/core/domain.js';
import { z } from 'zod';
import { OntologyModel, type ActionDefinition } from '../packages/ontology/model.js';
import type { ActionDiscoveryPage, ActionDiscoveryQuery } from '../packages/core/action-bindings.js';

function planServices(request: ServiceRequest, model: OntologyModel, input: unknown, discover: (query: ActionDiscoveryQuery) => ActionDiscoveryPage,
  active?: () => void, visible?: (id: string) => boolean) {
  const result = planServicesProgram(request, model, input, function* (query) { return discover(query); }, active, visible).next();
  assert(result.done);
  return result.value;
}
type Plan = ReturnType<typeof planServices>;
const source = { messageId: 'instruction', quote: 'Plan the explicitly requested Tokyo round trip.' };
const trip = (extra: object = {}) => ({ goal: { kind: 'round_trip', source, origin: 'Shanghai', destination: 'Tokyo', originRegion: 'CN', destinationRegion: 'JP',
  participants: 2, phase: 'quote', ...extra } });
const need = (extra: object = {}): ServiceNeed => ({ id: 'estimate', role: 'transport.estimate', source,
  output: { type: 'RideEstimateObservation', phase: 'quote' }, target: { origin: input.origin, destination: input.destination }, dependsOn: [], ...extra });
function taskSource(request: ServiceRequest) { return { messageId: request.messages[0]!.id, quote: request.messages[0]!.text }; }
function session(t: ReturnType<typeof setupDidi>, request: ServiceRequest, options: { active?: () => void; read?: ConstructorParameters<typeof OntologyPlanningSession>[5] } = {}) {
  return new OntologyPlanningSession(t.store.ontologyForJob(owner, t.store.get(owner, request.id)), owner, request, [], options.active, options.read,
    'request', [], { actionCatalog: t.catalog });
}

test('round-trip rules expand only explicitly selected services and preserve distinct roles and regional scopes', () => {
  const parsed = servicePlanningSchema.parse(trip({ lodging: true, arrivalTransfer: true, departureTransfer: true, dining: true, budget: { minor: '100000', currency: 'JPY' } }));
  const needs = expandServiceNeeds(parsed);
  assert.equal(needs.length, 6);
  assert.deepEqual(needs.map(value => value.need.role), ['flight.outbound', 'flight.return', 'lodging.stay', 'transfer.arrival', 'transfer.departure', 'dining.reservation']);
  assert.deepEqual(needs[3]!.need.dependsOn, ['outbound_flight', 'lodging']);
  assert.deepEqual(needs[4]!.need.dependsOn, ['return_flight', 'lodging']);
  assert.equal(needs[0]!.need.serviceConditions!.region, 'CN');
  assert.equal(needs[1]!.need.serviceConditions!.region, 'JP');
  assert(needs.every(value => value.derivedBy?.rule === 'travel.round_trip' && value.need.budget === undefined));
  assert.equal(expandServiceNeeds(servicePlanningSchema.parse(trip())).length, 2, 'A flight-only request does not manufacture paid extras');
  const booked = expandServiceNeeds(servicePlanningSchema.parse(trip({ phase: 'commitment', dining: true })));
  assert.equal(booked.at(-1)!.need.output.type, 'Reservation');
  assert.equal(booked[0]!.need.output.type, 'FlightReservation');
});

test('a complete synthetic Tokyo metadata catalog yields six distinct need plans without claiming bookings or availability', () => {
  // These additional types and bindings exist only in this isolated fixture;
  // they are not installed as real flight or restaurant capabilities.
  const types = ['FlightOffer', 'HotelOption', 'VehicleOption', 'ReservationOffer'];
  const actions: ActionDefinition[] = types.map(type => ({ id: `Read${type}`, version: '1', kind: 'source_read', description: 'Synthetic contract only',
    inputs: {}, changes: [type], submissionCriteria: ['same_owner'], resultTypes: [type], effects: ['read'],
    read: { version: '1', effect: 'read', resultType: type, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    composition: { version: '1', inputs: {}, outputs: { result: { kind: 'object', type, cardinality: 'one', semantics: { role: type, phase: 'quote' }, evidence: { origins: ['synthetic'] } } },
      checks: [], effectScope: { effects: ['read'], targetInputs: [], recovery: { kind: 'none' }, compensation: [] } },
  }));
  const model = new OntologyModel({ id: 'synthetic.travel', version: '1', objects: types.map(id => ({ id, version: '1', name: id, description: 'Isolated synthetic planning output', aliases: [], primaryKey: 'id', titleKey: 'id',
    properties: { id: { kind: 'string', schema: z.string().min(1), description: 'Synthetic identity', source: 'isolated synthetic fixture', required: true } } })), actions, interfaces: [], links: [], functions: [] });
  const release = { ontologyId: model.ref.id, releaseId: 'synthetic-release', digest: model.ref.digest };
  const request: ServiceRequest = { id: 'synthetic-task', revision: 1, originalGoal: source.quote, requirements: [], executionEnvironment: 'sandbox',
    messages: [{ id: source.messageId, text: source.quote, receivedAt: new Date().toISOString() }] };
  const plan = planServices(request, model, trip({ lodging: true, arrivalTransfer: true, departureTransfer: true, dining: true }), query => {
    const matches = actions.filter(action => action.resultTypes!.includes(query.outputType!));
    const items: ActionDiscoveryPage['items'] = matches.map(action => {
      const body = { ref: { id: `synthetic:${action.id}`, version: '1' }, actionId: action.id, actionVersion: '1', definitionDigest: digest(action), compositionDigest: digest(action.composition),
        programRef: { id: `synthetic.${action.id}`, version: '1' }, configurationDigest: digest('synthetic-only'), ontologyRelease: release,
        ownerDigest: digest(owner), requestId: request.id, requestRevision: request.revision };
      return { action, status: 'available', bindings: [{ pin: { ...body, digest: digest(body) }, readiness: 'ready', reason: 'Synthetic configured contract',
        environment: 'sandbox', inputSchema: action.read!.inputSchema, completionSchema: {}, guidance: 'Synthetic fixture only' }] };
    });
    return { ontologyRelease: release, requestId: request.id, requestRevision: request.revision, items,
      page: { limit: 10, hasMore: false }, authorization: 'per_action_required', allowedEffects: ['read'], snapshotDigest: digest(items) };
  });
  assert.equal(plan.needs.length, 6); assert(plan.needs.every(value => value.alternatives.length === 1 && !value.gaps.length));
  assert.equal(new Set(plan.needs.flatMap(value => value.alternatives[0]!.steps.map(step => step.id))).size, 6);
  const incoming = plan.needs.find(value => value.need.id === 'arrival_transfer')!, outgoing = plan.needs.find(value => value.need.id === 'departure_transfer')!;
  assert.deepEqual(incoming.alternatives[0]!.bindingDigests, outgoing.alternatives[0]!.bindingDigests, 'The same provider may serve both needs');
  assert.notEqual(incoming.alternatives[0]!.rootStepId, outgoing.alternatives[0]!.rootStepId);
  assert.equal(plan.executionAllowed, false); assert.equal(plan.businessCompletion, false); assert.equal(plan.availabilityProof, false);
  assert(plan.needs.every(value => value.applicability.every(check => check.result === 'unknown')));
});

test('the task tool derives both declared place reads and exact output links without a model or provider call', () => {
  const t = setupDidi();
  try {
    const job = t.b.submit(), request = job.delegation!.request, s = session(t, request);
    const plan = s.call('plan_services', { goal: { kind: 'needs', needs: [need({ source: taskSource(request) })] } }) as Plan;
    assert.equal(plan.executionAllowed, false); assert.equal(plan.execution, 'not_started');
    assert.equal(plan.needs[0]!.alternatives.length, 1, JSON.stringify(plan));
    const steps = plan.needs[0]!.alternatives[0]!.steps;
    assert.deepEqual(steps.map(step => [step.action, step.role]), [['SearchDidiPlaces', 'origin'], ['SearchDidiPlaces', 'destination'], ['EstimateDidiRide', 'transport.estimate']]);
    assert.equal(new Set(steps.map(step => step.id)).size, 3);
    assert.deepEqual(steps[2]!.dependsOn, steps.slice(0, 2).map(step => step.id));
    assert.deepEqual(steps[2]!.inputBindings.map(binding => binding.targetKey), ['originObservation', 'originPlaceId', 'destinationObservation', 'destinationPlaceId']);
    assert(steps[2]!.inputBindings.filter(binding => binding.derive).every(binding => binding.derive!.function === 'selectDidiPlace'));
    assert(steps[2]!.unresolvedArguments.includes('scope'));
    assert.equal(plan.contracts.length, 2);
    assert.equal(plan.contracts[0]!.binding.ontologyRelease.digest, job.delegation!.ontologyRelease!.digest);
    assert.equal(plan.discoveryPages, 2);
    assert.equal(t.calls.length, 0, 'Planning metadata must never reach source transport');
    assert.equal(t.store.intents(owner, job.id).length, 0);
    assert.equal(t.store.get(owner, job.id).runs?.length ?? 0, 0);
    assert.equal(s.lastReceipt()!.status, 'ok');
    assert.equal(s.lastReceipt()!.actionBindings!.pins.length, 2);
    const { digest: expected, ...body } = plan; assert.equal(expected, digest(body));
    const original = s.lastReceipt()!.actionBindings!.pins[0]!.digest;
    plan.contracts[0]!.binding.digest = 'changed-after-delivery';
    assert.equal(s.lastReceipt()!.actionBindings!.pins[0]!.digest, original, 'Returned proposal data cannot mutate the accepted discovery receipt');
  } finally { t.close(); }
});

test('the same program can serve two needs without merging their step, role or target identities', () => {
  const t = setupDidi();
  try {
    const job = t.b.submit(), request = job.delegation!.request, basis = taskSource(request);
    const plan = session(t, request).call('plan_services', { goal: { kind: 'needs', needs: [
      need({ id: 'arrival', role: 'transfer.arrival', source: basis }),
      need({ id: 'departure', role: 'transfer.departure', source: basis, target: { origin: input.destination, destination: input.origin } }),
    ] } }) as Plan;
    const [arrival, departure] = plan.needs.map(value => value.alternatives[0]!);
    assert(arrival && departure, JSON.stringify(plan));
    assert(!arrival.steps.some(step => departure.steps.some(other => other.id === step.id)));
    assert.notDeepEqual(plan.needs[0]!.need.target, plan.needs[1]!.need.target);
    assert.equal(plan.discoveryPages, 2, 'Identical immutable metadata may be shared inside this single read only');
    assert.equal(t.calls.length, 0);
  } finally { t.close(); }
});

test('missing flight definitions differ from unavailable restaurant bindings, and a total JPY ceiling is never allocated to every component', () => {
  const t = setupDidi();
  try {
    const job = t.b.submit(), request = job.delegation!.request;
    const args = trip({ source: taskSource(request), lodging: true, arrivalTransfer: true, departureTransfer: true, dining: true, budget: { minor: '500000', currency: 'JPY' } });
    const plan = session(t, request).call('plan_services', args) as Plan;
    assert.equal(plan.needs.length, 6);
    for (const id of ['outbound_flight', 'return_flight']) assert.equal(plan.needs.find(value => value.need.id === id)!.gaps[0]!.code, 'definition_missing');
    const dining = plan.needs.find(value => value.need.id === 'dining')!;
    assert.equal(dining.need.output.type, 'ReservationOffer');
    assert.equal(dining.gaps[0]!.code, 'binding_unavailable', 'The published restaurant type exists; only a compatible configured action is absent');
    const booked = session(t, request).call('plan_services', trip({ source: taskSource(request), phase: 'commitment', dining: true })) as Plan;
    assert.equal(booked.needs.find(value => value.need.id === 'dining')!.gaps[0]!.code, 'binding_unavailable');
    assert.equal(plan.totalBudget!.currency, 'JPY'); assert.equal(plan.budgetStatus, 'unknown');
    assert(plan.needs.every(value => value.need.budget === undefined));
    assert(plan.needs.every(value => value.applicability.every(check => check.result === 'unknown')));
    assert.equal(t.calls.length, 0);
  } finally { t.close(); }
});

test('quote observations never satisfy commitment or payment phases, even with the same output type', () => {
  const t = setupDidi();
  try {
    const job = t.b.submit(), request = job.delegation!.request;
    for (const output of [{ type: 'RideEstimateObservation', phase: 'commitment' }, { type: 'RideEstimateObservation', phase: 'payment' }, { type: 'RideEstimateObservation', phase: 'quote', cardinality: 'many' }]) {
      const plan = session(t, request).call('plan_services', { goal: { kind: 'needs', needs: [need({ source: taskSource(request), output })] } }) as Plan;
      assert.equal(plan.needs[0]!.alternatives.length, 0);
      assert.equal(plan.needs[0]!.gaps[0]!.code, 'binding_unavailable');
    }
  } finally { t.close(); }
});

test('unknown specific wallet acceptance remains separate from coarse service readiness', () => {
  const t = setupDidi();
  try {
    const job = t.b.submit(), request = job.delegation!.request;
    const plan = session(t, request).call('plan_services', { goal: { kind: 'needs', needs: [need({ source: taskSource(request), payment: { instrument: 'synthetic-wallet', currency: 'JPY' } })] } }) as Plan;
    assert.equal(plan.needs[0]!.alternatives.length, 1);
    assert.equal(plan.needs[0]!.applicability.find(check => check.check === 'payment_acceptance')!.result, 'unknown');
    assert.equal(plan.authorization, 'per_action_required');
    assert.equal(plan.executionAllowed, false);
  } finally { t.close(); }
});

test('bounded discovery discloses incomplete coverage instead of claiming that a source or market does not exist', () => {
  const t = setupDidi();
  try {
    const job = t.b.submit(), request = job.delegation!.request;
    const plan = session(t, request).call('plan_services', { maxDiscoveryPages: 1, goal: { kind: 'needs', needs: [need({ source: taskSource(request) })] } }) as Plan;
    assert.equal(plan.coverage, 'incomplete'); assert.equal(plan.discoveryPages, 1);
    assert.equal(plan.needs[0]!.alternatives.length, 0);
    assert(plan.needs[0]!.gaps.some(gap => gap.code === 'dependency_unavailable'));
  } finally { t.close(); }
});

test('long need identities still produce valid bounded step IDs and hidden types are indistinguishable from unavailable types', () => {
  const t = setupDidi();
  try {
    const job = t.b.submit(), request = job.delegation!.request, graph = t.store.ontologyForJob(owner, job);
    const args = { goal: { kind: 'needs', needs: [need({ id: 'n'.repeat(64), source: taskSource(request) })] } };
    const plan = session(t, request).call('plan_services', args) as Plan;
    assert(plan.needs[0]!.alternatives[0]!.steps.every(step => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(step.id)));
    const hidden = planServices(request, graph.model, args, () => assert.fail('Hidden type must not trigger discovery'), undefined, () => false);
    assert.equal(hidden.needs[0]!.gaps[0]!.code, 'definition_missing');
    assert.equal(hidden.contracts.length, 0);
  } finally { t.close(); }
});

test('malformed need graphs, foreign instructions, invalid times and unsupported tool bindings are rejected before discovery', () => {
  const t = setupDidi();
  try {
    const job = t.b.submit(), request = job.delegation!.request, basis = taskSource(request);
    const invalid = [
      [need()],
      [need({ source: basis }), need({ source: basis })],
      [need({ source: basis, dependsOn: ['missing'] })],
      [need({ source: basis, dependsOn: ['estimate'] })],
      [need({ source: basis, target: { startsAt: '2026-11-05T03:00:00Z', endsAt: '2026-11-05T02:00:00Z' } })],
      [need({ source: basis, target: { timeZone: 'not-a-time-zone' } })],
    ];
    for (const needs of invalid) {
      const s = session(t, request), result = s.call('plan_services', { goal: { kind: 'needs', needs } }) as { error: string };
      assert.equal(result.error, 'INVALID_INPUT'); assert.equal(s.lastReceipt()!.status, 'rejected'); assert.equal(s.lastReceipt()!.actionBindings, undefined);
    }
    const unbound = new OntologyPlanningSession(t.store.ontology, owner, request);
    assert.equal((unbound.call('plan_services', trip({ source: basis })) as { error: string }).error, 'FORBIDDEN');
    assert(!planningToolCatalog().some(tool => tool.name === 'plan_services'));
    assert(planningToolCatalog(true, true).some(tool => tool.name === 'plan_services'));
    assert.equal(t.calls.length, 0);
  } finally { t.close(); }
});

test('metadata permission changes are checked again in the next plan, never inherited from a previous result', () => {
  const t = setupDidi();
  try {
    const job = t.b.submit(), request = job.delegation!.request;
    const args = { goal: { kind: 'needs', needs: [need({ source: taskSource(request) })] } };
    const first = session(t, request).call('plan_services', args) as Plan;
    assert(first.needs[0]!.alternatives.length);
    t.catalog.agentProgram(DIDI_PROGRAM_REF, owner)!.permitted = () => false;
    const next = session(t, request).call('plan_services', args) as Plan;
    assert.equal(next.needs[0]!.alternatives.length, 0);
    assert.equal(next.contracts.length, 0);
  } finally { t.close(); }
});

test('task ownership, current revision, cancellation fences and rejected output cannot yield usable discovery pins', () => {
  const t = setupDidi();
  try {
    const job = t.b.submit(), request = job.delegation!.request, args = { goal: { kind: 'needs', needs: [need({ source: taskSource(request) })] } };
    const stale = session(t, { ...request, revision: request.revision + 1 });
    assert.equal((stale.call('plan_services', args) as { error: string }).error, 'CONFLICT');
    const foreign = new OntologyPlanningSession(t.store.ontology, 'another-owner', request, [], undefined, undefined, 'request', [], { actionCatalog: t.catalog });
    assert.equal((foreign.call('plan_services', args) as { error: string }).error, 'NOT_FOUND');
    let current = true;
    const stopped = session(t, request, { active: () => { if (!current) throw new DomainError('FORBIDDEN', 'Task lease ended'); } });
    current = false; assert.throws(() => stopped.call('plan_services', args), /lease ended/);
    const bounded = session(t, request);
    bounded.call('plan_services', args, { origin: 'worker_context', maxOutputBytes: 1 });
    assert.equal(bounded.lastReceipt()!.status, 'rejected'); assert.equal(bounded.lastReceipt()!.actionBindings, undefined);
    assert.equal(t.calls.length, 0);
  } finally { t.close(); }
});
