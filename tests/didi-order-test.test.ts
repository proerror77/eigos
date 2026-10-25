import { createFixedInputCoverage, registeredFixedInput } from '../packages/ontology/goal-coverage.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JobStore } from '../packages/core/store.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { digest } from '../packages/core/delegation.js';
import { ORDER_TEST_REF, orderTestInputSchema } from '../packages/ontology/didi-order-test.js';
import type { AgentDecision, AgentStep } from '../packages/ontology/agent-actions.js';
import type { Reasoner, AgentPlanningContext, PlanningAccess } from '../packages/coordinator/coordinator.js';
import { DidiMockOrderConnector, MOCK_ORDER_ENDPOINT, parseMockOrderStatus, type MockOrderSource } from '../packages/capabilities/didi/order-test-connector.js';
import { didiFixture } from './fixtures/didi.js';
import { backend, owner, principal, interpretation, evidence, syntheticGoalReview } from './backend-fixture.js';

const scopeInput = { city: '北京市', origin: '北京西站', destination: '西二旗-地铁站', serviceClass: '快车', target: 'created' };
const secretTrace = 'PRIVATE_MOCK_TRACE_NEVER_IN_MODEL';
const readGraph = (scope: object): AgentStep[] => [
 { id: 'from', action: 'SearchDidiTestPlaces', argumentsJson: JSON.stringify({ scope, role: 'origin' }), dependsOn: [], inputRefs: [] },
 { id: 'to', action: 'SearchDidiTestPlaces', argumentsJson: JSON.stringify({ scope, role: 'destination' }), dependsOn: [], inputRefs: [] },
 { id: 'quote', action: 'EstimateDidiTestOrder', argumentsJson: JSON.stringify({ scope }), dependsOn: ['from', 'to'], inputRefs: [
  { stepId: 'from', targetKey: 'origin' }, { stepId: 'from', targetKey: 'originPlaceId', compute: { function: 'selectDidiOrderTestPlace', path: ['placeId'] } },
  { stepId: 'to', targetKey: 'destination' }, { stepId: 'to', targetKey: 'destinationPlaceId', compute: { function: 'selectDidiOrderTestPlace', path: ['placeId'] } },
 ] },
];
function choose(ctx: AgentPlanningContext, access: PlanningAccess): AgentDecision {
 access.session.prepareContext({ actions: [...ctx.actionIds], refs: [ctx.state.scope, ...ctx.state.observations.slice().reverse()] });
 const quote = ctx.state.observations.find(r => r.type === 'DidiOrderTestQuote');
 return { kind: 'execute', requestRevision: ctx.request.revision, message: quote ? 'Choose exact Mock create and original-ID verification, subject to a separate permit' : 'Choose source maps and Mock quote only', completionJson: '', steps: quote ? [
  { id: 'create', action: 'CreateDidiTestOrder', argumentsJson: JSON.stringify({ scope: ctx.state.scope, quote, productCategory: '1' }), dependsOn: [], inputRefs: [] },
  { id: 'verify', action: 'QueryDidiTestOrder', argumentsJson: JSON.stringify({ scope: ctx.state.scope }), dependsOn: ['create'], inputRefs: [{ stepId: 'create', targetKey: 'order' }] },
 ] : readGraph(ctx.state.scope), ...(quote ? { plannedCompletion: { argumentsJson: JSON.stringify({ rationale: 'Only verified Mock creation' }), inputRefs: [{ stepId: 'verify', targetKey: 'observation' }] } } : {}) };
}
function fixture(initial = false, fixed = false) {
 const maps = didiFixture(), store = new JobStore(':memory:'), calls: { tool: string; input: Record<string, unknown> }[] = [];
 const flags = { loseCreation: false, badStatus: false, cancelOnCreate: undefined as undefined | (() => void) };
 const source: MockOrderSource = { evidenceKind: 'fixture', invoke: async (tool, input) => {
  calls.push({ tool, input });
  if (tool === 'taxi_create_order') { flags.cancelOnCreate?.(); if (flags.loseCreation) throw new Error('Synthetic lost response after possible acceptance'); }
  const raw = tool === 'taxi_estimate' ? { structuredContent: { traceId: secretTrace, phoneNumberSuffix: 'PRIVATE_PHONE_SUFFIX', items: [{ productName: '快车', productCategory: '1', priceText: '15' }] } }
    : tool === 'taxi_create_order' ? { structuredContent: { orderId: 'mock-order-id', status: 'created', from: { name: '北京西站' }, to: { name: '西二旗地铁站' }, phoneNumberSuffix: 'PRIVATE_PHONE_SUFFIX' } }
    : { content: [{ type: 'text', text: flags.badStatus ? 'unknown prose; do not accept' : '系统正在为您匹配最近的司机...\n提示：您可以随时取消订单' }] };
  const at = new Date().toISOString();
  return { raw, receipt: { id: randomUUID(), bindingId: maps.binding.bindingId, environment: 'mock', endpoint: MOCK_ORDER_ENDPOINT, tool, inputDigest: digest(input), responseSha256: digest(raw), toolSchemaDigest: digest({ tool }), startedAt: at, receivedAt: at } };
 } };
 const catalog = createExecutionCatalog({ store, didi: { ...maps.binding, connector: maps.connector }, didiOrderTestEnabled: true, didiOrderTestSource: source });
 const model: Reasoner = { reviewGoal: syntheticGoalReview, ground: async (r, _caps, _signal, access) => {
  const prepared = initial ? access.session.prepareContext({ actions: ['SearchDidiTestPlaces', 'EstimateDidiTestOrder'] }) : undefined;
  const decision = { ...interpretation(r, ORDER_TEST_REF.id, scopeInput), capabilityRef: ORDER_TEST_REF, ...(fixed ? { scopeReview: (await syntheticGoalReview({ request: r, capability: catalog.capability(ORDER_TEST_REF), input: scopeInput })).decision } : {}), ...(initial ? { initialSteps: readGraph({}).map(s => { const input = JSON.parse(s.argumentsJson); delete input.scope; return { ...s, argumentsJson: JSON.stringify(input), scopeInputs: ['scope'] }; }) } : {}) };
  const run = { ...evidence(), decisionDigest: digest(decision), ...(prepared ? { ontologyContext: { digest: prepared.digest, receiptIds: prepared.receiptIds, startedAt: prepared.startedAt, preparedAt: prepared.preparedAt, model: prepared.model, requestRevision: prepared.requestRevision } } : {}) };
  return { decision, evidence: run };
 }, plan: async () => { throw new Error('No recipe'); }, act: async (ctx, _signal, access) => { const decision = choose(ctx, access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } }; } };
 const b = backend(catalog, model, store, { allowSandbox: true });
 const submit = () => b.submit({ executionEnvironment: 'sandbox', capabilityRef: ORDER_TEST_REF, goal: '只做官方 Mock 下单测试，确认快车报价后创建并查询，禁止真实派车付款。' });
 const approve = (id: string) => { const a = store.get(owner, id).delegation!.authorizationRequest!; return b.tasks.authorize(principal, id, { action: 'approve_plan', requestId: randomUUID(), planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' }); };
 return { ...b, catalog, model, maps, source, calls, flags, submit, approve, close: () => { store.close(); maps.close(); } };
}

test('Official Mock order path displays the quote, waits for exact authority, then creates and independently reads without another model reply', async () => {
 const f = fixture();
 try {
  const job = f.submit(); await f.run(); await f.run(); await f.run();
  const waiting = f.store.get(owner, job.id);
  assert.equal(waiting.state, 'auth-required', JSON.stringify(waiting.delegation!.agent!.feedback));
  assert.match(waiting.question!, /15 元/); assert.match(waiting.question!, /Mock/); assert.match(waiting.question!, /北京西站/);
  assert.deepEqual(f.calls.map(c => c.tool), ['taxi_estimate']);
  assert(!JSON.stringify(waiting).includes(secretTrace)); assert(!JSON.stringify(waiting).includes('PRIVATE_PHONE_SUFFIX'));
  const modelCalls = waiting.runs!.length; f.approve(job.id); const done = await f.run();
  assert.equal(done.state, 'completed', JSON.stringify(done.delegation!.agent!.feedback));
  assert.equal(done.runs!.length, modelCalls); assert.equal(done.delegation!.agent!.completion!.mode, 'planned');
  assert.deepEqual(f.calls.map(c => c.tool), ['taxi_estimate', 'taxi_create_order', 'taxi_query_order']);
  assert.equal(f.calls[2]!.input.order_id, 'mock-order-id'); assert.equal(f.calls[1]!.input.estimate_trace_id, secretTrace);
  assert.equal(done.delegation!.outcome!.evidenceLevel, 'synthetic'); assert.equal((done.artifact!.data.result as any).realOrder, false);
  assert(!JSON.stringify(done).includes(secretTrace)); assert(!JSON.stringify(done).includes('PRIVATE_PHONE_SUFFIX'));
 } finally { f.close(); }
});

test('A lost creation response is not retried and does not trigger an account-wide order lookup', async () => {
 const f = fixture();
 try {
  const job = f.submit(); await f.run(); await f.run(); await f.run(); f.approve(job.id); f.flags.loseCreation = true; await f.run();
  for (let i = 0; i < 3; i++) { await new Promise(r => setTimeout(r, 1050)); const claim = f.store.claim(['eigos.delegate'], 15000); if (claim) await f.coordinator.run(claim, new AbortController().signal); }
  const current = f.store.get(owner, job.id); assert.equal(current.state, 'input-required');
  assert.equal(f.calls.filter(c => c.tool === 'taxi_create_order').length, 1); assert.equal(f.calls.filter(c => c.tool === 'taxi_query_order').length, 0);
 } finally { f.close(); }
});

test('Cancellation during the acknowledged Mock write preserves audit evidence but cannot complete or query a replacement order', async () => {
 const f = fixture();
 try {
  const job = f.submit(); await f.run(); await f.run(); await f.run(); f.approve(job.id); f.flags.cancelOnCreate = () => { f.tasks.cancel(principal, job.id); };
  await f.run(); const current = f.store.get(owner, job.id);
  assert.equal(current.state, 'canceled'); assert(!current.artifact); assert.equal(f.calls.filter(c => c.tool === 'taxi_create_order').length, 1); assert.equal(f.calls.filter(c => c.tool === 'taxi_query_order').length, 0);
 } finally { f.close(); }
});

test('Unrecognized status prose is not independent order confirmation', async () => {
 const f = fixture();
 try { const job = f.submit(); await f.run(); await f.run(); await f.run(); f.approve(job.id); f.flags.badStatus = true; await f.run(); assert.notEqual(f.store.get(owner, job.id).state, 'completed'); }
 finally { f.close(); }
});

test('Mock transport rejects production and ambiguous queries before a network call', async () => {
 const maps = didiFixture(); let calls = 0;
 try {
  assert.throws(() => new DidiMockOrderConnector(maps.binding), /MOCK_ENDPOINT_REQUIRED/);
  const source = new DidiMockOrderConnector({ ...maps.binding, environment: 'mock' }, async () => { calls++; throw new Error('No network'); });
  await assert.rejects(source.invoke('taxi_query_order', {}, new AbortController().signal));
  await assert.rejects(source.invoke('taxi_create_order', { product_category: '1', estimate_trace_id: secretTrace, caller_car_phone: '13800000000' }, new AbortController().signal));
  assert.equal(calls, 0);
  assert.throws(() => parseMockOrderStatus({ structuredContent: { orderId: 'other', statusCode: 0 } }, 'owned'), /ORDER_ID_MISMATCH/);
  assert.throws(() => orderTestInputSchema.parse({ ...scopeInput, origin: '上海虹桥站' }));
 } finally { maps.close(); }
});

test('A capability hint cannot select the sandbox program in a live request or bypass goal coverage', async () => {
 const f = fixture();
 try { const job = f.tasks.submit(principal, { service: 'eigos.delegate', goal: 'real ride', requestId: randomUUID(), capabilityRef: ORDER_TEST_REF }); await f.run(); assert.equal(f.store.get(owner, job.id).state, 'rejected'); assert.equal(f.calls.length, 0); }
 finally { f.close(); }
});

test('One grounding reply may select quote preparation in a mixed program, but the write still needs a later source-backed decision and permit', async () => {
 const f = fixture(true);
 try {
  const job = f.submit(); await f.run(); const quoted = f.store.get(owner, job.id);
  assert(quoted.delegation!.agent!.observations.some(r => r.type === 'DidiOrderTestQuote'));
  assert.equal(quoted.runs!.length, 2, 'Grounding and independent goal coverage, no invented response');
  assert.deepEqual(f.calls.map(c => c.tool), ['taxi_estimate']);
  await f.run(); const waiting = f.store.get(owner, job.id); assert.equal(waiting.state, 'auth-required'); assert.equal(waiting.runs!.length, 3);
  f.approve(job.id); const done = await f.run(); assert.equal(done.state, 'completed'); assert.equal(done.runs!.length, 3);
 } finally { f.close(); }
});

test('A canceled task may query an ID retained in its late creation audit, without projecting completion or replaying creation', async () => {
 const f = fixture();
 try {
  const job = f.submit(); await f.run(); await f.run(); await f.run(); f.approve(job.id); f.flags.cancelOnCreate = () => { f.tasks.cancel(principal, job.id); }; const first = f.store.claim(['eigos.delegate'], 15000)!; await f.coordinator.run(first, new AbortController().signal); f.store.release(first);
  const claim = f.store.claim(['eigos.delegate'], 15000); assert(claim?.recovery); await f.coordinator.run(claim, new AbortController().signal);
  assert.equal(f.calls.filter(c => c.tool === 'taxi_create_order').length, 1); assert.equal(f.calls.filter(c => c.tool === 'taxi_query_order').length, 1);
  const done = f.store.get(owner, job.id); assert.equal(done.state, 'canceled'); assert(!done.artifact); assert(!done.delegation!.agent!.observations.some(r => r.type === 'DidiTestOrderObservation'));
 } finally { f.close(); }
});

 test('PA-pinned fixed scope reviews the original request in the actual initial response without a second interpretation', async () => {
 const f = fixture(true, true);
 try {
  f.model.reviewGoal = async () => { throw new Error('Unexpected second review'); };
  const job = f.submit(); await f.run(); await f.run();
  const waiting = f.store.get(owner, job.id);
  assert.equal(waiting.state, 'auth-required'); assert.equal(waiting.delegation!.goalCoverage!.reviewOrigin, 'registered_fixed_input');
  assert.equal(waiting.runs!.length, 2);
  f.approve(job.id); const done = await f.run(); assert.equal(done.state, 'completed'); assert.equal(done.runs!.length, 2);
 } finally { f.close(); }
});

test('Fixed-scope coverage rejects an unpinned scope, altered input, extra constraints and changed response provenance', async () => {
 const f = fixture(true, true);
 try {
  const job = f.submit(); await f.run(); const current = f.store.get(owner, job.id), d = current.delegation!;
  const recorded = d.groundingDecisions![0]!, run = current.runs!.find(r => r.id === recorded.modelRunId)!;
  const ctx = { request: d.request, capability: f.catalog.capability(ORDER_TEST_REF), input: scopeInput };
  assert(createFixedInputCoverage(ctx, recorded.decision, run));
  assert.throws(() => createFixedInputCoverage({ ...ctx, request: { ...ctx.request, capabilityRef: undefined } }, recorded.decision, run));
  assert.throws(() => createFixedInputCoverage({ ...ctx, input: { ...scopeInput, origin: 'different' } }, recorded.decision, run));
  assert.throws(() => createFixedInputCoverage(ctx, { ...recorded.decision, requirementsJson: '[{}]' }, run));
  assert.throws(() => createFixedInputCoverage(ctx, recorded.decision, { ...run, decisionDigest: 'changed' }));
  assert.throws(() => registeredFixedInput({ ...ctx.capability, inputSchema: { type: 'object', additionalProperties: false, properties: { origin: { type: 'string' } }, required: ['origin'] } }));
 } finally { f.close(); }
});
