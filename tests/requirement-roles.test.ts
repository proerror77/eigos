import { businessModel } from '../packages/ontology/business-model.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { groundRequirements } from '../packages/coordinator/requirements.js';
import { checkRequirements } from '../packages/coordinator/resolver.js';
import { domainRequirementRoles } from '../packages/ontology/service-domains.js';
import { equivalentQuantities } from '../packages/ontology/quantity.js';
import { DomainServiceAdapter, domainCapability } from '../packages/capabilities/domain-service.js';
import { domainProvider } from './fixtures/service-domains.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { backend, interpretation, owner, principal, reasoner } from './backend-fixture.js';
import type { RequirementInput, ServiceRequest } from '../packages/ontology/execution.js';
import { proposePlan } from '../packages/coordinator/plan.js';
import { templatePlanning } from '../packages/ontology/planning-contract.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { fixtureAdapter, fixtureBinding, fixtureCapability } from './backend-fixture.js';

function request(text: string): ServiceRequest { return { id: 'roles-request', revision: 1, originalGoal: text, requirements: [], executionEnvironment: 'sandbox', messages: [{ id: 'message', text, receivedAt: new Date().toISOString() }] }; }
const extracted = (requirement: RequirementInput, quote: string) => ({ requirement, messageId: 'message', quote });
const budget = (id: string, role: 'service_total' | 'deposit', minor: string): RequirementInput => ({ id, kind: 'budget', role, strength: 'hard', expected: { minor, currency: 'CNY' } });

test('an unchanged structured foreign-currency budget survives redundant model extraction without weakening its provenance', () => {
  const r = request('预算已通过结构化最小货币单位字段提供。');
  const constraint: RequirementInput = { id: 'service-budget', kind: 'budget', role: 'service_total', strength: 'hard', expected: { minor: '10000', currency: 'USD' } };
  r.requirements.push({ ...constraint, provenance: { source: 'pa', interpretation: 'structured', messageId: 'message', receivedAt: r.messages[0]!.receivedAt } });
  const output = groundRequirements(r, JSON.stringify([extracted(constraint, r.originalGoal)]), [], domainRequirementRoles.vehicle);
  assert.deepEqual(output.requirements, r.requirements);
  const changed = { ...constraint, expected: { minor: '20000', currency: 'USD' } };
  assert.throws(() => groundRequirements(r, JSON.stringify([extracted(changed, r.originalGoal)]), [], domainRequirementRoles.vehicle), /fixed requirement/);
  const empty = request(r.originalGoal);
  assert.throws(() => groundRequirements(empty, JSON.stringify([extracted(constraint, r.originalGoal)]), [], domainRequirementRoles.vehicle), /Non-CNY/);
});

test('same-kind constraints retain independent business roles and their exact message provenance', () => {
  const r = request('服务费预算500元，押金上限2000元，2人，从A取车，到B还车');
  const fixed = groundRequirements(r, JSON.stringify([
    extracted(budget('service', 'service_total', '50000'), '服务费预算500元'), extracted(budget('deposit', 'deposit', '200000'), '押金上限2000元'),
    extracted({ id: 'pickup', kind: 'location', role: 'pickup', strength: 'hard', expected: { ref: 'A' } }, '从A取车'),
    extracted({ id: 'return', kind: 'location', role: 'return', strength: 'hard', expected: { ref: 'B' } }, '到B还车'),
  ]), [], domainRequirementRoles.vehicle);
  assert.equal(fixed.requirements.length, 4);
  const checks = checkRequirements(fixed, { amounts: { service_total: { minor: '40000', currency: 'CNY' }, deposit: { minor: '150000', currency: 'CNY' } }, locations: { pickup: 'A', return: 'B' } }, ['synthetic']);
  assert(checks.every(c => c.result === 'pass'));
  assert(checkRequirements(fixed, { totalPrice: { minor: '0', currency: 'CNY' }, locationRef: 'A' }, ['synthetic']).every(c => c.result === 'unknown'), 'Unscoped facts cannot stand in for scoped evidence');
  const wrong = checkRequirements(fixed, { amounts: { service_total: { minor: '60000', currency: 'CNY' }, deposit: { minor: '100', currency: 'CNY' } }, locations: { pickup: 'B', return: 'A' } }, ['synthetic']);
  assert.equal(wrong.find(c => c.requirementId === 'service')!.result, 'fail'); assert.equal(wrong.find(c => c.requirementId === 'deposit')!.result, 'pass');
  assert(wrong.filter(c => ['pickup', 'return'].includes(c.requirementId)).every(c => c.result === 'fail'));
  assert.throws(() => groundRequirements(fixed, JSON.stringify([extracted(budget('service', 'deposit', '50000'), '服务费预算500元')]), [], domainRequirementRoles.vehicle), /fixed requirement/);
  assert.throws(() => groundRequirements(r, JSON.stringify([extracted(budget('deposit', 'deposit', '200000'), '押金上限2000元')]), [], domainRequirementRoles.ride), /not supported/);
});

test('room and guest counts stay distinct while known unit aliases remain equivalent', () => {
  const r = request('1间房，2人');
  const fixed = groundRequirements(r, JSON.stringify([
    extracted({ id: 'rooms', kind: 'quantity', role: 'room_count', strength: 'hard', expected: { amount: '1', unit: '间房' } }, '1间房'),
    extracted({ id: 'guests', kind: 'quantity', role: 'guest_count', strength: 'hard', expected: { amount: '2', unit: '人' } }, '2人'),
  ]), [], domainRequirementRoles.hotel);
  assert.equal(fixed.requirements.length, 2);
  assert(checkRequirements(fixed, { quantities: { room_count: { amount: '1', unit: 'room' }, guest_count: { amount: '2', unit: 'person' } } }, ['synthetic']).every(c => c.result === 'pass'));
  assert.equal(equivalentQuantities({ amount: '2', unit: 'room' }, { amount: '2', unit: 'person' }), false);
  assert.equal(equivalentQuantities({ amount: '2', unit: 'meal' }, { amount: '2', unit: '份' }), true);
});

test('pickup and arrival deadlines each require a matching commitment or actual occurrence', () => {
  const pickup = '2026-10-19T09:00:00Z', arrival = '2026-10-19T10:00:00Z';
  const r = request(`在${pickup}前上车，在${arrival}前到达`);
  const fixed = groundRequirements(r, JSON.stringify([
    extracted({ id: 'pickup', kind: 'deadline', role: 'pickup', strength: 'hard', expected: { at: pickup, timezone: 'UTC', original: `在${pickup}前上车` } }, `在${pickup}前上车`),
    extracted({ id: 'arrival', kind: 'deadline', role: 'arrival', strength: 'hard', expected: { at: arrival, timezone: 'UTC', original: `在${arrival}前到达` } }, `在${arrival}前到达`),
  ]), [], domainRequirementRoles.ride);
  const partial = checkRequirements(fixed, { deadlines: { arrival } }, ['synthetic']);
  assert.equal(partial[0]!.result, 'unknown'); assert.equal(partial[1]!.result, 'pass');
  const swapped = checkRequirements(fixed, { deadlines: { pickup: arrival, arrival: pickup } }, ['synthetic']);
  assert.equal(swapped[0]!.result, 'fail'); assert.equal(swapped[1]!.result, 'pass');
});

test('source availability does not fill missing milestone commitments or a missing actual deposit', async () => {
  for (const domain of ['ride', 'vehicle'] as const) {
    const f = domainProvider(domain), original = f.provider.prepare;
    f.provider.prepare = async (input, signal) => { const prepared = await original(input, signal); if (domain === 'ride') delete prepared.option.commitments!.pickup; else delete prepared.option.deposit; return prepared; };
    const adapter = new DomainServiceAdapter(f.provider);
    assert.equal((await adapter.prepare({ owner, request: request('合成条件验证') }, f.parameters, new AbortController().signal)).kind, 'unavailable');
  }
});

test('declared step costs respect separate service/deposit caps and reject an unknown purpose', () => {
  const r = groundRequirements(request('服务费预算500元，押金上限2000元'), JSON.stringify([extracted(budget('service', 'service_total', '50000'), '服务费预算500元'), extracted(budget('deposit', 'deposit', '200000'), '押金上限2000元')]), [], domainRequirementRoles.vehicle);
  const action = { id: 'synthetic-payment-description', version: '1' }, capability = { ...fixtureCapability, actions: [{ ref: action, effect: 'payment' as const }] }, binding = fixtureBinding('synthetic-costs');
  const facts = { amounts: { service_total: { minor: '40000', currency: 'CNY' }, deposit: { minor: '150000', currency: 'CNY' } } };
  const catalog = new ExecutionCatalog([capability], [binding], [fixtureAdapter(binding.adapterId, facts)]);
  const candidate = { id: 'cost-candidate', binding, status: 'ready' as const, input: {}, details: {}, facts, evidenceRefs: ['synthetic-quote'], requirementChecks: checkRequirements(r, facts, ['synthetic-quote']), observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), recipe: (['service_total', 'deposit'] as const).map((purpose, i) => ({ id: purpose, operationId: purpose, actionTypeRef: action, input: {}, inputRefs: [], dependsOn: [], cost: { minor: i === 0 ? '40000' : '150000', currency: 'CNY', payeeId: binding.providerId, purpose } })) };
  const plan = (value: typeof candidate) => proposePlan(catalog, owner, r, capability, value, { kind: 'propose_plan', requestRevision: 1, candidateId: value.id, message: 'Synthetic cost declaration only; no execution or approval', steps: value.recipe.map(s => ({ id: s.id, actionTypeRef: action, bindingRef: binding.ref, inputJson: '{}', dependsOn: [] })) }, templatePlanning(r, businessModel.ref));
  assert.equal(plan(candidate).steps.length, 2);
  const missing = structuredClone(candidate); delete (missing.recipe[1]!.cost as { purpose?: string }).purpose;
  assert.throws(() => plan(missing), /fixed request budget/);
  const invalid = structuredClone(candidate); (invalid.recipe[1]!.cost as { purpose?: string }).purpose = 'unknown-purpose';
  assert.throws(() => plan(invalid), /Unknown cost purpose/);
});

for (const domain of ['ride', 'hotel', 'vehicle'] as const) test(`${domain}: the observed real-model role conflict is covered through planning, action and closeout`, async () => {
  const f = domainProvider(domain), capability = domainCapability(domain), r = request(domain === 'hotel' ? '1间房、2人，总费用预算500元' : domain === 'vehicle' ? '2人，服务费用预算500元，押金上限2000元' : '2人，总费用预算500元');
  const roles: { requirement: RequirementInput; quote: string }[] = [{ requirement: budget('service', 'service_total', '50000'), quote: '预算500元' }];
  if (domain === 'hotel') roles.push({ requirement: { id: 'rooms', kind: 'quantity', role: 'room_count', strength: 'hard', expected: { amount: '1', unit: '间房' } }, quote: '1间房' }, { requirement: { id: 'guests', kind: 'quantity', role: 'guest_count', strength: 'hard', expected: { amount: '2', unit: '人' } }, quote: '2人' });
  else roles.push({ requirement: { id: 'people', kind: 'quantity', role: 'passenger_count', strength: 'hard', expected: { amount: '2', unit: '人' } }, quote: '2人' });
  if (domain === 'vehicle') roles.push({ requirement: budget('deposit', 'deposit', '200000'), quote: '押金上限2000元' });
  if (domain === 'ride' && 'pickupBy' in f.parameters) {
    const p = f.parameters, pickupQuote = `${p.pickupBy}前上车`, arrivalQuote = `${p.arriveBy}前到达`;
    r.originalGoal += `；从${p.origin}到${p.destination}，${pickupQuote}，${arrivalQuote}`; r.messages[0]!.text = r.originalGoal;
    roles.push({ requirement: { id: 'origin', kind: 'location', role: 'origin', strength: 'hard', expected: { ref: p.origin } }, quote: p.origin }, { requirement: { id: 'destination', kind: 'location', role: 'destination', strength: 'hard', expected: { ref: p.destination } }, quote: p.destination },
      { requirement: { id: 'pickup', kind: 'deadline', role: 'pickup', strength: 'hard', expected: { at: p.pickupBy, timezone: 'UTC', original: pickupQuote } }, quote: pickupQuote },
      { requirement: { id: 'arrival', kind: 'deadline', role: 'arrival', strength: 'hard', expected: { at: p.arriveBy, timezone: 'UTC', original: arrivalQuote } }, quote: arrivalQuote });
  }
  const catalog = createExecutionCatalog({ domainSandboxProviders: [f.provider] });
  const b = backend(catalog, reasoner(req => ({ ...interpretation(req, capability.ref.id, f.parameters), capabilityRef: capability.ref, requirementsJson: JSON.stringify(roles.map(row => ({ ...row, messageId: req.messages[0]!.id }))) })), undefined, { allowSandbox: true });
  try {
    b.submit({ goal: r.originalGoal, executionEnvironment: 'sandbox' }); const ready = await b.run(); assert.equal(ready.state, 'auth-required');
    const grant = ready.delegation!.authorizationRequest!;
    b.tasks.authorize(principal, ready.id, { action: 'approve_plan', requestId: randomUUID(), planDigest: grant.planDigest, allowedEffects: grant.effects, maxAmount: grant.maxAmount, payeeIds: grant.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' });
    const done = await b.run(); assert.equal(done.state, 'completed'); assert.equal(done.delegation!.request.requirements.length, roles.length); assert(done.delegation!.acceptance!.checks.every(c => c.result === 'pass')); assert.equal(f.counters().submits, 1);
  } finally { b.store.close(); }
});
