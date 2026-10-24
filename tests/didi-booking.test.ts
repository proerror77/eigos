// Synthetic provider/model regression tests. Official mock/Luna proof is separate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { DidiBookingConnector } from '../packages/capabilities/didi/booking-connector.js';
import { mapDidiOrder } from '../packages/capabilities/didi/booking-contracts.js';
import { DIDI_BOOKING_PROGRAM_REF } from '../packages/capabilities/didi/booking-program.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { componentContext } from '../packages/core/composed-actions.js';
import type { ActionDiscoveryPage } from '../packages/core/action-bindings.js';
import { digest } from '../packages/core/delegation.js';
import { readWorkerConfig } from '../packages/core/config.js';
import type { Job } from '../packages/core/domain.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import type { RideOrderSnapshot } from '../packages/ontology/ride-booking.js';
import type { AgentPlanningContext, PlanningAccess, Reasoner } from '../packages/coordinator/coordinator.js';
import { didiFixture, chooseDidi, input, type DidiChoice } from './fixtures/didi.js';
import { backend, evidence, interpretation, observeTaskContext, acknowledgeReads, owner, principal } from './backend-fixture.js';

function chooseBooking(ctx: AgentPlanningContext, access: PlanningAccess): AgentDecision {
  observeTaskContext(access);
  access.session.call('describe_ontology', { actions: ['CreateDidiRide', 'ReadDidiRide'], search: 'DidiOrder', limit: 5 });
  access.session.call('query_ontology', { object: ctx.state.scope });
  const order = ctx.state.observations.filter(o => o.type === 'DidiOrderObservation').at(-1);
  const base = { kind: 'execute' as const, requestRevision: ctx.request.revision, message: 'Explicit mock operation from the original source', steps: [], completionJson: '' };
  if (order) {
    const response = access.session.call('query_ontology', { object: order }) as { items: { properties: { snapshot: RideOrderSnapshot } }[] }, s = response.items[0]!.properties.snapshot;
    access.session.call('evaluate_ontology', { function: 'didiOrderStatus', object: order });
    if (s.action === 'ReadDidiRide') return { ...base, kind: 'complete', completionJson: JSON.stringify({ order, rationale: 'Independently read original mock driver status' }) };
    return { ...base, steps: [{ id: 'read_order', action: 'ReadDidiRide', argumentsJson: JSON.stringify({ scope: ctx.state.scope, order }), dependsOn: [], inputRefs: [] }] };
  }
  const selected = chooseDidi(ctx, access);
  if (selected.kind !== 'complete') return selected;
  const estimate = JSON.parse(selected.completionJson).observation;
  return { ...base, steps: [{ id: 'create_order', action: 'CreateDidiRide', argumentsJson: JSON.stringify({ scope: ctx.state.scope, estimate, productCategory: 'native-fast', productName: '快车', priceText: '73.05', fareBasis: 'estimate_not_final_fare' }), dependsOn: [], inputRefs: [] }] };
}
function setup(choice: DidiChoice = chooseBooking) {
  const f = didiFixture({ booking: true }), store = new JobStore(':memory:'), operations = new DidiBookingConnector(f.binding, f.fetcher, true);
  const catalog = createExecutionCatalog({ store, didi: { ...f.binding, connector: f.connector, bookingEnabled: true, bookingConnector: operations } });
  const model: Reasoner = { ground: async (request, _caps, _signal, access) => ({ decision: { ...interpretation(observeTaskContext(access) ?? request, DIDI_BOOKING_PROGRAM_REF.id, { ...input, serviceClass: '快车' }), capabilityRef: DIDI_BOOKING_PROGRAM_REF }, evidence: evidence() }),
    plan: async () => { throw new Error('No legacy recipe'); }, act: async (ctx, _signal, access) => { const decision = choice(ctx, access); acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } }; } };
  const b = backend(catalog, model, store, { allowSandbox: true });
  const submit = () => b.submit({ goal: '在官方模拟环境查询北京西站到西二旗地铁站的快车估价，确认后模拟叫车并回读原订单号和司机状态。不要真实下单或付款。', executionEnvironment: 'sandbox' });
  const approve = (job: Job) => { const a = job.delegation!.authorizationRequest!; return b.tasks.authorize(principal, job.id, { requestId: randomUUID(), action: 'approve_plan', planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' }); };
  const finish = async (id: string, autoApprove = false) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const job = store.get(owner, id);
      if (job.state === 'auth-required' && autoApprove) { approve(job); continue; }
      if (!['submitted', 'working'].includes(job.state)) return job;
      const claim = store.claim(['eigos.delegate'], 15000);
      if (!claim) { await pause(100); continue; }
      try { await b.coordinator.run(claim, new AbortController().signal); } finally { store.release(claim); }
    }
    throw new Error('Mock fixture did not settle: ' + JSON.stringify({ job: store.get(owner, id), intents: store.intents(owner, id) }));
  };
  return { ...f, store, catalog, model, b, submit, approve, finish, close: () => { store.close(); f.close(); } };
}
const diagnostic = (job: Job) => JSON.stringify({ state: job.state, question: job.question, grounding: job.delegation?.groundingFeedback, feedback: job.delegation?.agent?.feedback });

test('official mock text status keeps request identity and raw report without inventing a status code or driver facts', () => {
  const report = '系统已为您匹配到司机，正在快马加鞭来接您。\n司机信息：\n• 称呼：体验模式司机';
  const result = mapDidiOrder('taxi_query_order', { content: [{ type: 'text', text: report }] }, 'original-order');
  assert.equal(result.orderId, 'original-order'); assert.equal(result.identityBasis, 'requested_order'); assert.equal(result.state, 'reported');
  assert.equal(result.statusText, report); assert.equal(result.statusCode, undefined); assert.equal(result.driver, undefined);
  assert.equal(mapDidiOrder('taxi_query_order', { content: [{ type: 'text', text: '系统正在为您匹配最近的司机...\n提示：您可以随时取消订单' }] }, 'original-order').state, 'reported');
  assert.equal(mapDidiOrder('taxi_query_order', { content: [{ type: 'text', text: '查询失败' }] }, 'original-order').state, 'unknown');
  assert.throws(() => mapDidiOrder('taxi_create_order', { content: [{ type: 'text', text: report }] }));
});

test('mock order waits for exact vehicle/estimate approval, creates once and independently reads the same ID', async () => {
  const f = setup();
  try {
    const task = f.submit(), waiting = await f.finish(task.id);
    assert.equal(waiting.state, 'auth-required', diagnostic(waiting));
    assert.equal(f.calls.filter(c => c.name === 'taxi_create_order').length, 0);
    assert.equal(waiting.delegation!.authorizationRequest!.environment, 'sandbox');
    const confirmation = waiting.delegation!.authorizationRequest!.environment === 'sandbox' ? waiting.delegation!.authorizationRequest!.confirmation : undefined;
    assert.match(JSON.stringify(confirmation), /北京西站.*西二旗地铁站/); assert.match(JSON.stringify(confirmation), /73.05/);
    assert.match(JSON.stringify(waiting.delegation!.agent!.plans), /73.05/);
    f.approve(waiting); const done = await f.finish(task.id);
    assert.equal(done.state, 'completed', diagnostic(done)); assert(done.delegation!.acceptance?.accepted);
    assert.equal(f.calls.filter(c => c.name === 'taxi_create_order').length, 1);
    const query = f.calls.find(c => c.name === 'taxi_query_order'); assert.deepEqual(query!.args, { order_id: 'mock-fixture-order' });
    assert.match(done.artifact!.data.deliverable, /司机已接单/); assert.match(done.artifact!.data.deliverable, /未发出真实叫车/);
    assert(!JSON.stringify(done).includes('PRIVATE_TRACE')); assert(!JSON.stringify(done).includes('didi-fixture-key'));
    const order = f.store.intents(owner, task.id).find(i => i.effect === 'order')!; assert.equal(order.remoteRef, 'mock-fixture-order');
    assert.equal(order.state, 'effect_confirmed'); assert.equal(f.store.grants(owner, task.id).length, 1);
  } finally { f.close(); }
});
test('cancel before approval and changed displayed estimate cannot dispatch a mock order', async () => {
  const f = setup();
  try { const task = f.submit(), waiting = await f.finish(task.id); assert.equal(waiting.state, 'auth-required', diagnostic(waiting)); f.b.tasks.cancel(principal, task.id); assert.throws(() => f.approve(waiting)); assert(!f.calls.some(c => c.name === 'taxi_create_order')); } finally { f.close(); }
  const changed = setup((ctx, access) => { const decision = chooseBooking(ctx, access); const create = decision.steps.find(s => s.action === 'CreateDidiRide'); if (create) create.argumentsJson = JSON.stringify({ ...JSON.parse(create.argumentsJson), priceText: '1.00' }); return decision; });
  try { const done = await changed.finish(changed.submit().id, true); assert.notEqual(done.state, 'completed'); assert(!changed.calls.some(c => c.name === 'taxi_create_order')); } finally { changed.close(); }
});
test('an accepted original order cannot be called a failed operation before its independent readback', async () => {
  let attempted = false;
  const f = setup((ctx, access) => {
    const chosen = chooseBooking(ctx, access);
    if (!attempted && chosen.steps.some(step => step.action === 'ReadDidiRide')) { attempted = true; return { ...chosen, kind: 'no_feasible_plan', steps: [], message: 'Synthetic mistaken failure claim' }; }
    return chosen;
  });
  try {
    const done = await f.finish(f.submit().id, true);
    assert.equal(done.state, 'completed', diagnostic(done)); assert(attempted);
    assert(done.delegation!.agent!.feedback.some(f => f.message.includes('ReadDidiRide')));
    assert.equal(f.calls.filter(c => c.name === 'taxi_create_order').length, 1);
  } finally { f.close(); }
});
test('a hard route mismatch stops before requesting order authorization or dispatch', async () => {
  const f = setup();
  try {
    const job = f.b.submit({ goal: 'Synthetic route conflict', executionEnvironment: 'sandbox', requirements: [{ id: 'origin', kind: 'location', role: 'origin', strength: 'hard', expected: { ref: '另一个未匹配地点' } }] });
    const done = await f.finish(job.id, true); assert.notEqual(done.state, 'completed');
    assert.equal(f.store.grants(owner, job.id).length, 0); assert(!f.calls.some(c => c.name === 'taxi_create_order'));
  } finally { f.close(); }
});
test('lost create response remains one uncertain original operation and never queries an unrelated current order', async () => {
  const f = setup();
  f.flags.transform = (body, request) => { if (request.params?.name === 'taxi_create_order') throw new Error('Synthetic response lost after dispatch'); return body; };
  try {
    const task = f.submit(), waiting = await f.finish(task.id); assert.equal(waiting.state, 'auth-required', diagnostic(waiting)); f.approve(waiting);
    const unresolved = await f.finish(task.id); assert.notEqual(unresolved.state, 'completed');
    assert.equal(f.calls.filter(c => c.name === 'taxi_create_order').length, 1); assert(!f.calls.some(c => c.name === 'taxi_query_order'));
    assert(f.store.intents(owner, task.id).some(i => i.effect === 'order' && ['effect_unknown', 'needs_review'].includes(i.state)));
  } finally { f.close(); }
});
test('production booking is rejected and a different order readback cannot complete', async () => {
  const f = didiFixture(); try { assert.throws(() => new DidiBookingConnector(f.binding), /mock/); } finally { f.close(); }
  assert.throws(() => readWorkerConfig({ EIGOS_DIDI_ORDERS_ENABLED: 'true' }));
  assert.throws(() => readWorkerConfig({ EIGOS_DIDI_ORDERS_ENABLED: 'mock' }), /mock/);
  const wrong = setup(); wrong.flags.transform = (body, request) => { if (request.params?.name === 'taxi_query_order') body.result.structuredContent.orderId = 'unrelated-order'; return body; };
  try { const done = await wrong.finish(wrong.submit().id, true); assert.notEqual(done.state, 'completed'); assert.equal(wrong.calls.filter(c => c.name === 'taxi_create_order').length, 1); } finally { wrong.close(); }
});
test('whole-goal composition preserves a managed ride scope and accepted source ports through confirmation and readback', async () => {
  const t = setup();
  t.model.ground = async (request, _caps, _signal, access) => {
    observeTaskContext(access);
    const decision = { kind: 'compose' as const, requestRevision: request.revision, message: 'Keep estimate and order readback goals', requirementsJson: '[]', conditionsJson: '[]', criteriaJson: JSON.stringify([
      { id: 'estimate', predicate: 'ride.estimate_observed', phase: 'quote', description: 'Observed vehicle estimate', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: [] },
      { id: 'order', predicate: 'ride.mock_order_readback', phase: 'commitment', description: 'Mock order and driver state', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: [] },
    ]) }; acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
  };
  t.model.act = async (ctx, _signal, access) => {
    observeTaskContext(access);
    const pin = (actionId: string) => (access.session.call('discover_actions', { actionId }) as ActionDiscoveryPage).items[0]!.bindings.find(b => b.pin.programRef.id === DIDI_BOOKING_PROGRAM_REF.id)!.pin;
    let decision: AgentDecision;
    if (!ctx.state.composition!.contexts.length) decision = { kind: 'prepare', requestRevision: ctx.request.revision, message: 'Prepare one context for both goals', steps: [], completionJson: '', contexts: [{ id: 'ride', bindingDigest: pin('SearchDidiPlaces').digest, inputJson: JSON.stringify({ ...input, serviceClass: '快车' }) }] };
    else {
      const program = t.catalog.agentProgram(DIDI_BOOKING_PROGRAM_REF, owner)!;
      const scoped = componentContext({ ...ctx, graph: t.store.ontology, owner, intents: t.store.intents(owner, ctx.request.id), modelRuns: t.store.get(owner, ctx.request.id).runs }, ctx.state.composition!.contexts[0]!, program);
      const choice = chooseBooking({ ...ctx, ...scoped, capability: program.capability(), actionIds: [...program.actionIds] }, access);
      decision = choice.kind === 'complete' ? { ...choice, completionJson: JSON.stringify({ components: [{ contextId: 'ride', proposalJson: choice.completionJson }], criteria: [{ id: 'estimate', contextIds: ['ride'] }, { id: 'order', contextIds: ['ride'] }], conditions: [] }) }
        : { ...choice, steps: choice.steps.map(step => ({ ...step, contextId: 'ride', bindingDigest: pin(step.action).digest, contributesTo: ['estimate', 'order'] })) };
    }
    acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
  };
  try {
    const done = await t.finish(t.submit().id, true);
    assert.equal(done.state, 'completed', diagnostic(done)); assert(done.delegation!.agent!.composition!.assessment!.accepted);
    assert.equal(t.calls.filter(c => c.name === 'taxi_create_order').length, 1);
    assert.equal(t.calls.filter(c => c.name === 'taxi_query_order').length, 1);
  } finally { t.close(); }
});
