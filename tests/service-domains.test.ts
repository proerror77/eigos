import { syntheticGoalReview } from './backend-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { digest } from '../packages/core/delegation.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { businessModel } from '../packages/ontology/business-model.js';
import { domainNames, parseDomainParameters, serviceDomain, type ServiceDomain } from '../packages/ontology/service-domains.js';
import { assessDomain, type DomainAssessment } from '../packages/ontology/domain-rules.js';
import { domainCapabilityId, projectDomainSnapshot } from '../packages/ontology/domain-projection.js';
import { OntologyPlanningSession } from '../packages/coordinator/planning-session.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { domainCapability } from '../packages/capabilities/domain-service.js';
import { backend, evidence, interpretation, observePlanning, observeTaskContext, acknowledgeReads, owner, principal, proposal } from './backend-fixture.js';
import { domainFixture, domainProvider } from './fixtures/service-domains.js';
import type { Job } from '../packages/core/domain.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';
import { assessConditions } from '../packages/coordinator/conditions.js';

function graphFixture(domain: ServiceDomain) {
  const f = domainFixture(domain), db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, undefined, () => f.now);
  const request: ServiceRequest = { id: f.snapshot.requestId, revision: 1, originalGoal: `${serviceDomain(domain).name}合成验证`, requirements: [], messages: [{ id: 'message', text: `${serviceDomain(domain).name}合成验证`, receivedAt: new Date(f.now).toISOString() }] };
  graph.ingest(owner, { objects: [{ ref: { type: 'ServiceRequest', id: request.id }, properties: { requestId: request.id, displayTitle: '合成委托', originalGoal: request.originalGoal, revision: 1, progress: 'planning' } }] }, { kind: 'synthetic', id: 'test', observedAt: new Date(f.now).toISOString() });
  const projected = projectDomainSnapshot(graph, owner, domainCapabilityId(domain), request, f.parameters, f.snapshot);
  assert.equal(projected.state, 'typed_result');
  return { ...f, db, graph, request, option: projected.subject!, session: new OntologyPlanningSession(graph, owner, request) };
}

for (const domain of domainNames) {
  test(`${domain}: typed objects, bidirectional relationships, conditions and action proposals are queryable`, () => {
    const f = graphFixture(domain), d = serviceDomain(domain);
    try {
      assert(businessModel.describe({ search: d.name, limit: 5 }).types.length);
      const option = f.graph.read(owner, f.option), requirements = f.graph.related(owner, option.ref, 'requirements', { remaining: 1000 })![0]!;
      assert.equal(f.graph.related(owner, requirements.ref, 'options', { remaining: 1000 })![0]!.ref.id, option.ref.id);
      assert.equal((f.graph.evaluate(owner, { function: d.eligibleFunction, object: f.option }).value as DomainAssessment).status, 'satisfied');
      f.session.call('describe_ontology', { search: d.requestType });
      f.session.call('query_ontology', { type: d.requestType }); f.session.call('query_ontology', { type: d.candidateType });
      const before = f.graph.revision(owner), action = f.session.call('propose_action', { action: d.action, inputs: [{ name: 'request', object: { type: 'ServiceRequest', id: f.request.id }, revision: 1 }, { name: 'requirements', object: requirements.ref, revision: requirements.revision }, { name: 'option', object: option.ref, revision: option.revision }] }) as { checks: { criterion: string; result: string }[]; executionAllowed: boolean };
      assert.equal(action.executionAllowed, false); assert.equal(action.checks.find(c => c.criterion === 'eligible_option')!.result, 'pass'); assert.equal(action.checks.find(c => c.criterion === 'within_authority')!.result, 'unknown'); assert.equal(f.graph.revision(owner), before);
      const result = projectDomainSnapshot(f.graph, owner, domainCapabilityId(domain), f.request, f.parameters, { ...f.snapshot, observation: f.result });
      assert.equal(result.state, 'typed_result');
      const assessed = f.graph.evaluate(owner, { function: d.outcomeFunction, object: result.subject! }); assert.equal((assessed.value as DomainAssessment).status, 'satisfied'); assert.deepEqual(assessed.evidenceLevels, ['synthetic']);
      const withCondition: ServiceRequest = { ...f.request, conditions: [{ id: 'domain-complete', predicateRef: { id: `domain.${domain}.complete`, version: '1' }, subject: { type: d.resultType, role: 'domain_outcome' }, phase: 'result', strength: 'hard', operator: 'eq', expected: requirements.ref, source: { messageId: 'message', quote: f.request.originalGoal } }] };
      assert.equal(assessConditions(f.graph, owner, withCondition, result.subject, 'result')[0]!.result, 'pass');
      withCondition.conditions![0]!.expected = { type: d.requestType, id: 'another-request' };
      assert.equal(assessConditions(f.graph, owner, withCondition, result.subject, 'result')[0]!.result, 'unknown');
      assert.equal(f.graph.query('other-owner', { type: d.resultType }).items.length, 0);
      const object = f.graph.read(owner, result.subject!);
      f.graph.ingest(owner, { objects: [{ ref: object.ref, expectedRevision: object.revision, properties: { ...object.properties, providerReference: 'tampered' } }] }, { kind: 'synthetic', id: 'test', observedAt: new Date(f.now).toISOString() });
      assert.equal(f.graph.evaluate(owner, { function: d.outcomeFunction, object: object.ref }).status, 'unknown');
    } finally { f.db.close(); }
  });
  test(`${domain}: source scope, old requirements, partial price and private identity fail closed`, () => {
    const f = graphFixture(domain), d = serviceDomain(domain);
    try {
      assert.equal(projectDomainSnapshot(f.graph, owner, domainCapabilityId(domain), f.request, f.parameters, { ...f.snapshot, requestRevision: 2 }).state, 'invalid_source');
      assert.equal(projectDomainSnapshot(f.graph, owner, domainCapabilityId(domain), f.request, f.parameters, { ...f.snapshot, environment: 'live' }).state, 'invalid_source');
      const opt = f.graph.read(owner, f.option);
      f.graph.ingest(owner, { objects: [{ ref: opt.ref, expectedRevision: opt.revision, properties: { ...opt.properties, feesComplete: false } }] }, { kind: 'synthetic', id: 'test', observedAt: new Date(f.now).toISOString() });
      assert.equal(f.graph.evaluate(owner, { function: d.eligibleFunction, object: opt.ref }).status, 'unknown');
      if (domain === 'appointment') { assert(!JSON.stringify(f.graph.query(owner, { type: 'PatientProfile' })).includes('PRIVATE_')); assert.throws(() => f.graph.query(owner, { type: 'PatientProfile', select: ['identityDocument'] }), /Restricted property/); }
    } finally { f.db.close(); }
  });
}

test('six domain outcomes disprove the domain-specific false completions', () => {
  const cases: [ServiceDomain, Record<string, unknown>, string][] = [
    ['ride', { state: 'accepted', pickedUpAt: undefined, arrivedAt: undefined }, 'unknown'], ['ride', { destination: 'wrong-stop' }, 'unsatisfied'], ['ride', { fareComplete: false }, 'unknown'],
    ['appointment', { state: 'pending', paymentState: 'paid' }, 'unknown'], ['appointment', { patientKey: 'another-patient' }, 'unsatisfied'], ['appointment', { state: 'waitlisted' }, 'unknown'],
    ['food', { state: 'partial', deliveredItems: [{ sku: 'meal-A', quantity: 1, specification: 'large-no-peanuts' }], finalDelivery: false, deliveredAt: undefined }, 'unknown'], ['food', { deliveredItems: [{ sku: 'meal-A', quantity: 1, specification: 'large-no-peanuts' }], finalDelivery: true }, 'unsatisfied'], ['food', { ingredientCheck: 'unknown' }, 'unknown'],
    ['hotel', { state: 'pending', paymentState: 'paid' }, 'unknown'], ['hotel', { roomTypeId: 'other-room' }, 'unsatisfied'], ['hotel', { rooms: 2 }, 'unsatisfied'],
    ['itinerary', { unbookedDisclosed: false }, 'unsatisfied'],
    ['vehicle', { state: 'held' }, 'unknown'], ['vehicle', { mode: 'chauffeured' }, 'unsatisfied'], ['vehicle', { eligibilityVerified: false }, 'unsatisfied'],
  ];
  for (const [domain, change, expected] of cases) { const f = domainFixture(domain); assert.equal(assessDomain(domain, f.parameters, { ...f.result, ...change }, f.now).status, expected, `${domain}: ${JSON.stringify(change)}`); }
});

test('itinerary transfer feasibility and booking endpoints are independently enforced', () => {
  const f = domainFixture('itinerary');
  const overlap = structuredClone(f.result); overlap.legs![1]!.startsAt = overlap.legs![0]!.endsAt;
  assert.equal(assessDomain('itinerary', f.parameters, overlap, f.now).status, 'unsatisfied');
  const unknown = structuredClone(f.result); unknown.legs![0]!.feasibility = 'unknown';
  assert.equal(assessDomain('itinerary', f.parameters, unknown, f.now).status, 'unknown');
  const p = { ...f.parameters, endpoint: 'booked' as const }, r = { ...f.result, state: 'booked', requestDigest: digest(p) };
  assert.equal(assessDomain('itinerary', p, r, f.now).status, 'unknown');
});

test('hotel stay and rental return require observations beyond a booking confirmation', () => {
  const h = domainFixture('hotel'), hp = { ...h.parameters, endpoint: 'stay_completed' as const };
  assert.equal(assessDomain('hotel', hp, { ...h.result, requestDigest: digest(hp) }, h.now).status, 'unknown');
  const v = domainFixture('vehicle'), vp = { ...v.parameters, startsAt: v.at(-120), endsAt: v.at(60), endpoint: 'completed' as const };
  const vr = { ...v.result, requestDigest: digest(vp), startsAt: vp.startsAt, endsAt: vp.endsAt, state: 'returned', pickedUpAt: v.at(-100), returnedAt: v.at(-1), returnAccepted: true, depositState: 'disputed' };
  assert.equal(assessDomain('vehicle', vp, vr, v.now).status, 'unsatisfied');
  assert.equal(assessDomain('vehicle', vp, { ...vr, depositState: 'pending' }, v.now).status, 'unknown');
});

test('domain input schemas reject invalid dates, duplicate SKUs and impossible intervals', () => {
  const h = domainFixture('hotel'); assert.throws(() => parseDomainParameters('hotel', { ...h.parameters, checkOut: h.parameters.checkIn }));
  const f = domainFixture('food'); assert.throws(() => parseDomainParameters('food', { ...f.parameters, items: [...f.parameters.items, ...f.parameters.items] }));
  const r = domainFixture('ride'); assert.throws(() => parseDomainParameters('ride', { ...r.parameters, pickupBy: r.parameters.arriveBy }));
});

test('hospital, department and practitioner links retain source identities rather than display names', () => {
  const f = graphFixture('appointment');
  try {
    const department = f.graph.query(owner, { type: 'MedicalDepartment' }).items[0]!;
    const hospital = f.graph.related(owner, department.ref, 'hospital', { remaining: 1000 })![0]!;
    assert.equal(hospital.properties.sourceId, (f.parameters as { hospitalId: string }).hospitalId);
    const wrong = structuredClone(f.snapshot); wrong.entities.find(e => e.type === 'MedicalDepartment')!.properties.hospitalId = 'other-campus';
    const before = f.graph.revision(owner);
    assert.equal(projectDomainSnapshot(f.graph, owner, domainCapabilityId('appointment'), f.request, f.parameters, wrong).state, 'invalid_source');
    assert.equal(f.graph.revision(owner), before);
  } finally { f.db.close(); }
});

test('chauffeured bookings do not require a customer driver licence; self-drive still requires eligibility', () => {
  const f = domainFixture('vehicle');
  const { driverKey: _driver, ...base } = f.parameters;
  const parameters = { ...base, mode: 'chauffeured' as const };
  assert.doesNotThrow(() => parseDomainParameters('vehicle', parameters));
  assert.throws(() => parseDomainParameters('vehicle', { ...base, mode: 'self_drive' }));
  const { driverKey: _actual, ...result } = f.result;
  assert.equal(assessDomain('vehicle', parameters, { ...result, mode: 'chauffeured', requestDigest: digest(parameters) }, f.now).status, 'satisfied');
});

test('equivalent appointment instants with different UTC offsets retain the same meaning', () => {
  const f = domainFixture('appointment');
  const shifted = new Date(Date.parse(f.parameters.startsAt) + 8 * 3600000).toISOString().replace('Z', '+08:00');
  assert.equal(assessDomain('appointment', f.parameters, { ...f.result, startsAt: shifted }, f.now).status, 'satisfied');
});

function runtimeFixture(domain: ServiceDomain, options: Parameters<typeof domainProvider>[1] = {}) {
  const f = domainProvider(domain, options), capability = domainCapability(domain), catalog = createExecutionCatalog({ domainSandboxProviders: [f.provider] });
  const b = backend(catalog, { reviewGoal: syntheticGoalReview, ground: async (request, _caps, _signal, access) => ({ decision: { ...interpretation(observeTaskContext(access) ?? request, capability.ref.id, f.parameters), capabilityRef: capability.ref }, evidence: evidence() }), plan: async (context, _signal, access) => { observePlanning(context, access); const candidate = context.resolution.candidates[0]!; assert(candidate.ontologySubject); access.session.call('query_ontology', { object: candidate.ontologySubject }); const result = access.session.call('evaluate_ontology', { function: serviceDomain(domain).eligibleFunction, object: candidate.ontologySubject }) as { value: DomainAssessment }; assert(result.value, JSON.stringify(result)); assert.equal(result.value.status, 'satisfied'); acknowledgeReads(access); return { decision: proposal(context), evidence: evidence() }; } }, undefined, { allowSandbox: true });
  const approve = (job: Job) => { const a = job.delegation!.authorizationRequest!; b.tasks.authorize(principal, job.id, { action: 'approve_plan', requestId: randomUUID(), planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' }); };
  const tick = async (jobId: string) => {
    // The coordinator can defer the task beyond the provider intent's nextAt.
    // Wait for the durable task schedule as well, including under a busy host.
    const next = Math.max(b.store.get(owner, jobId).delegation!.nextAt ?? 0, Math.min(...b.store.intents(owner, jobId).map(i => i.nextAt)));
    await new Promise(r => setTimeout(r, Math.max(0, next - Date.now()) + 20)); return b.run();
  };
  return { ...f, ...b, catalog, approve, tick };
}

for (const domain of domainNames) test(`${domain}: shared coordinator, durable actions and independent closeout complete only the sandbox goal`, async () => {
  const f = runtimeFixture(domain);
  try {
    assert.equal(f.catalog.summaries(owner, 16, 'live').some(s => s.ref.id === domainCapabilityId(domain)), false);
    const quantity = domain === 'food' ? { amount: '2', unit: '份' } : domain === 'hotel' ? { amount: '1', unit: '间' } : { amount: domain === 'appointment' ? '1' : '2', unit: '人' };
    f.submit({ executionEnvironment: 'sandbox', goal: `${serviceDomain(domain).name}合成业务验证`, requirements: [
      { id: 'count', kind: 'quantity', strength: 'hard', expected: quantity },
      { id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '50000', currency: 'CNY' } },
      { id: 'deadline', kind: 'deadline', strength: 'hard', expected: { at: f.at(60), timezone: 'Asia/Shanghai', original: f.at(60) } },
    ] });
    let job = await f.run();
    if (domain !== 'itinerary') { assert.equal(job.state, 'auth-required'); assert.equal(f.counters().submits, 0); f.approve(job); job = await f.run(); }
    assert.equal(job.state, 'completed'); assert.equal(job.delegation!.plan!.completionTarget, 'domain'); assert.equal(job.delegation!.outcome!.status, 'satisfied');
    assert.equal(f.counters().submits, 1); assert.equal(f.store.intents(owner, job.id).length, 1); assert.equal((job.artifact!.data.result as { environment: string }).environment, 'sandbox'); assert(!JSON.stringify(job.artifact).includes('PRIVATE_'));
    assert(job.delegation!.ontologyReads!.some(r => r.tool === 'evaluate_ontology')); assert.match(JSON.stringify(f.store.providerFeedback(owner, job.delegation!.plan!.bindingRef)), /"evidenceLevel":"sandbox"/);
    const results = f.store.ontology.query(owner, { type: serviceDomain(domain).resultType }).items; assert.equal(results.length, 1);
  } finally { f.store.close(); }
});

test('pending domain operation waits for original-key readback without a second dispatch', async () => {
  const f = runtimeFixture('appointment', { pending: true });
  try { f.submit({ executionEnvironment: 'sandbox' }); const offered = await f.run(); f.approve(offered); const pending = await f.run(); assert.equal(pending.state, 'working'); assert.equal(pending.artifact, undefined); f.complete(); const done = await f.tick(pending.id); assert.equal(done.state, 'completed'); assert.deepEqual(f.counters(), { submits: 1, lookups: 1 }); } finally { f.store.close(); }
});

test('a lost domain submission response is reconciled under its original key', async () => {
  const f = runtimeFixture('ride', { failAfterSubmit: true });
  try { f.submit({ executionEnvironment: 'sandbox' }); const offered = await f.run(); f.approve(offered); const pending = await f.run(); assert.equal(pending.state, 'working'); const done = await f.tick(pending.id); assert.equal(done.state, 'completed'); assert.deepEqual(f.counters(), { submits: 1, lookups: 1 }); } finally { f.store.close(); }
});

test('canceling a prepared domain action prevents dispatch; live tasks cannot use the sandbox', async () => {
  const f = runtimeFixture('hotel');
  try {
    f.submit({ executionEnvironment: 'sandbox' }); const ready = await f.run();
    f.tasks.cancel(principal, ready.id); assert.throws(() => f.approve(ready)); assert.equal(f.counters().submits, 0);
    const current = f.tasks.get(principal, ready.id); assert.equal(current.state, 'canceled');
    f.submit({ executionEnvironment: 'live' }); const unavailable = await f.run();
    assert.equal(unavailable.state, 'working'); assert.equal(unavailable.delegation!.phase, 'grounding');
    assert.match(unavailable.delegation!.groundingFeedback![0]!.message, /exact capability reference and version/);
    assert.equal(unavailable.delegation!.plan, undefined); assert.equal(f.counters().submits, 0);
  } finally { f.store.close(); }
});

test('pending and final observations update one business identity and preserve old receipts', async () => {
  const f = runtimeFixture('appointment', { pending: true });
  try {
    f.submit({ executionEnvironment: 'sandbox' }); const ready = await f.run(); f.approve(ready); const pending = await f.run();
    const before = f.store.ontology.query(owner, { type: 'MedicalAppointment' }).items; assert.equal(before.length, 1); assert.equal(before[0]!.properties.state, 'pending');
    f.complete(); const done = await f.tick(pending.id); assert.equal(done.state, 'completed');
    const after = f.store.ontology.query(owner, { type: 'MedicalAppointment' }).items; assert.equal(after.length, 1); assert.deepEqual(after[0]!.ref, before[0]!.ref); assert(after[0]!.revision > before[0]!.revision); assert.equal(after[0]!.properties.state, 'confirmed');
    assert.equal(f.store.ontology.related(owner, after[0]!.ref, 'sourceReceipts', { remaining: 1000 })!.length, 1);
    assert(f.store.ontology.query(owner, { type: 'SourceReceipt' }).items.length >= 3);
  } finally { f.store.close(); }
});

test('a final fare exceeding the fixed user budget cannot hide behind a cheaper candidate quote', async () => {
  const f = runtimeFixture('ride', { pending: true });
  try {
    f.submit({ executionEnvironment: 'sandbox', requirements: [{ id: 'total', kind: 'budget', strength: 'hard', expected: { minor: '15000', currency: 'CNY' } }] });
    const ready = await f.run(); f.approve(ready); const pending = await f.run(); f.complete();
    for (const operation of f.ledger.values()) operation.observation.finalFare = { minor: '20000', currency: 'CNY' };
    const done = await f.tick(pending.id); assert.equal(done.state, 'failed'); assert.equal(done.delegation!.outcome!.status, 'unsatisfied'); assert.equal(done.artifact, undefined);
  } finally { f.store.close(); }
});
