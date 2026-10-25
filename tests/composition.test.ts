// Real Coordinator/Action runtime; all provider responses and model decisions here are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { Coordinator, type AgentPlanningContext, type PlanningAccess, type Reasoner } from '../packages/coordinator/coordinator.js';
import type { AgentDecision, AgentStep } from '../packages/ontology/agent-actions.js';
import { digest } from '../packages/core/delegation.js';
import { backend, evidence, interpretation, owner, principal, syntheticGoalReview } from './backend-fixture.js';
import { didiFixture } from './fixtures/didi.js';
import { meituanPrimitiveFixture } from './fixtures/meituan-agent.js';
import type { CompositionInput } from '../packages/ontology/composition.js';
import type { ObjectRef } from '../packages/ontology/model.js';

export const compositionExample = (dependent = true): CompositionInput => ({ components: [
  { id: 'geo', capabilityRef: { id: 'geo.search', version: '1' }, goal: '查美团公开地点', input: { city: '北京市', keyword: '天安门' }, dependsOn: [], bindings: [], requirementIds: [], conditionIds: [] },
  { id: 'didi', capabilityRef: { id: 'ride.estimate.query', version: '1' }, goal: dependent ? '用滴滴搜索上一步返回的地点名称' : '查滴滴公开地点', input: { mode: 'places', city: '北京市', ...(!dependent ? { keywords: '天安门' } : {}) }, dependsOn: dependent ? ['geo'] : [], bindings: dependent ? [{ from: 'geo', targetKey: 'keywords', path: ['places', '0', 'name'] }] : [], requirementIds: [], conditionIds: [] },
] });
function read(ctx: AgentPlanningContext, access: PlanningAccess) {
  access.session.call('describe_ontology', { actions: ['ActivateServiceComponent', 'CompleteServiceComponent', 'SearchMeituanLocations', 'SearchDidiPlaces'] });
  access.session.call('query_ontology', { object: { type: 'ServiceRequest', id: ctx.request.id } });
  access.session.call('query_ontology', { object: ctx.state.scope });
  for (const [id, component] of Object.entries(ctx.state.components!)) {
    if (component.scope) access.session.call('query_ontology', { object: component.scope });
    for (const ref of component.observations) {
      access.session.call('query_ontology', { object: ref });
      access.session.call('evaluate_ontology', { function: id === 'geo' ? 'meituanReadStatus' : 'rideEstimateStatus', object: ref });
    }
  }
}
const step = (id: string, action: string, args: object): AgentStep => ({ id, action, argumentsJson: JSON.stringify(args), dependsOn: [], inputRefs: [] });
export function chooseComposition(ctx: AgentPlanningContext, access: PlanningAccess): AgentDecision {
  read(ctx, access);
  const execute = (steps: AgentStep[]): AgentDecision => ({ kind: 'execute', requestRevision: ctx.request.revision, message: 'Synthetic model-selected cross-service decision', steps, completionJson: '' });
  const components = ctx.state.components!, definitions = (ctx.state.input as unknown as CompositionInput).components;
  const initial = definitions.filter(n => components[n.id]?.scope && !components[n.id]!.observations.length);
  if (initial.length) return execute(initial.map(n => n.id === 'geo' ? step('geo_read', n.capabilityRef.id === 'address.book.read' ? 'ReadMeituanAddresses' : 'SearchMeituanLocations', { scope: components.geo!.scope }) : step('didi_read', 'SearchDidiPlaces', { scope: components.didi!.scope, role: 'search', keywords: components.didi!.input!.keywords })));
  for (const node of definitions) {
    const state = components[node.id]!;
    if (!state.scope && node.dependsOn.every(id => components[id]?.result)) return execute([step('activate', 'ActivateServiceComponent', { scope: ctx.state.scope, componentId: node.id })]);
    if (state.scope && !state.result && state.observations.length) return execute([step('verify', 'CompleteServiceComponent', { scope: ctx.state.scope, componentId: node.id, completionJson: JSON.stringify({ observation: state.observations.at(-1), rationale: 'Actual independent source observation' }) })]);
  }
  return { kind: 'complete', requestRevision: ctx.request.revision, message: 'All selected service goals verified', steps: [], completionJson: JSON.stringify({ rationale: 'Verify the whole original goal' }) };
}
function fixture(input = compositionExample(), choice = chooseComposition) {
  const didi = didiFixture(), meituan = meituanPrimitiveFixture(), store = new JobStore(':memory:');
  const catalog = createExecutionCatalog({ store, meituan: meituan.reader, didi: { ...didi.binding, connector: didi.connector } });
  const model: Reasoner = { reviewGoal: syntheticGoalReview, ground: async request => ({ decision: { ...interpretation(request, 'services.compose.live', input), capabilityRef: { id: 'services.compose.live', version: '1' } }, evidence: evidence() }),
    plan: async () => { throw new Error('No legacy cross-service recipe'); }, act: async (ctx, _signal, access) => { const decision = choice(ctx, access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } }; } };
  const b = backend(catalog, model, store);
  const finish = async (id: string) => { for (let i = 0; i < 15; i++) { const current = store.get(owner, id); if (!['working', 'submitted'].includes(current.state)) return current; await b.run(); } throw new Error(JSON.stringify(store.get(owner, id).delegation?.agent?.feedback)); };
  return { didi, meituan, store, catalog, model, b, finish, close: () => { store.close(); didi.close(); } };
}

test('Two services share one task; deferred inputs come from verified upstream output and all results enter the root assessment', async () => {
  const f = fixture();
  try {
    const job = f.b.submit({ goal: '先查美团公开地点，再把返回的地点名称交给滴滴搜索，两个来源都要返回。' });
    const done = await f.finish(job.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    const c = done.delegation!.agent!.components!;
    assert.equal(c.didi!.input!.keywords, '合成公开地点');
    assert.equal(f.meituan.calls.length, 1); assert.equal(f.didi.calls.filter(c => c.method === 'tools/call').length, 1);
    assert.equal(done.delegation!.outcome!.evidenceRefs.length, 2); assert.equal(done.delegation!.outcome!.evidenceLevel, 'synthetic');
    assert.equal((done.artifact!.data.result as { allComponentsVerified: boolean }).allComponentsVerified, true);
    const root = f.store.ontology.read(owner, { type: 'ServiceRequest', id: job.id });
    assert.equal(root.properties.requestedOutcome, 'services.compose.live');
    const assessment = root.properties.currentAssessment as ObjectRef;
    assert.equal(f.store.ontology.related(owner, assessment, 'sourceReceipts', { remaining: 1000 })!.length, 2);
    assert.equal(f.store.list(owner, { offset: 0, limit: 10 }).total, 1);
    assert(f.store.intents(owner, job.id).every(i => ['read', 'local'].includes(i.effect)));
  } finally { f.close(); }
});

test('Independent components can use a parallel Action frontier without implicit service ordering', async () => {
  const f = fixture(compositionExample(false));
  try {
    const job = f.b.submit(); await f.b.run(); await f.b.run();
    const current = f.store.get(owner, job.id);
    assert.equal(current.delegation!.agent!.plans[0]!.steps.length, 2); assert.equal(current.state, 'working');
    assert.equal((await f.finish(job.id)).state, 'completed');
  } finally { f.close(); }
});

for (const kind of ['cycle', 'omission', 'unknown_program', 'prototype_path'] as const) test(`Invalid composition is blocked before source calls: ${kind}`, async () => {
  const input = compositionExample();
  if (kind === 'cycle') input.components[0]!.dependsOn = ['didi'];
  if (kind === 'unknown_program') input.components[1]!.capabilityRef.id = 'unknown.service';
  if (kind === 'prototype_path') input.components[1]!.bindings[0]!.path = ['__proto__'];
  const f = fixture(input);
  try {
    f.b.submit(kind === 'omission' ? { requirements: [{ id: 'no-order', kind: 'condition', strength: 'hard', expected: { predicate: 'execution.no_order' } }] } : {});
    await assert.rejects(f.b.run()); assert.equal(f.meituan.calls.length, 0); assert.equal(f.didi.calls.length, 0);
  } finally { f.close(); }
});

test('A premature parent completion cannot hide an unstarted component', async () => {
  const f = fixture(compositionExample(), (ctx, access) => { read(ctx, access); return { kind: 'complete', requestRevision: ctx.request.revision, message: 'Premature synthetic claim', steps: [], completionJson: '{"rationale":"done"}' }; });
  try {
    const job = f.b.submit(); await f.b.run(); await f.b.run(); const current = f.store.get(owner, job.id);
    assert.notEqual(current.state, 'completed'); assert(!current.artifact); assert(current.delegation!.agent!.feedback.some(f => f.message.includes('Every component')));
  } finally { f.close(); }
});

test('Restart continues the same component graph without replaying completed service actions', async () => {
  const f = fixture();
  try {
    const job = f.b.submit(); for (let i = 0; i < 3; i++) await f.b.run();
    const before = f.store.get(owner, job.id).delegation!.agent!.components!.geo!.result;
    assert(before);
    const next = new Coordinator(f.store, f.model, f.catalog);
    for (let i = 0; i < 10 && f.store.get(owner, job.id).state === 'working'; i++) await next.run(f.store.claim(['eigos.delegate'], 15000)!, new AbortController().signal);
    const done = f.store.get(owner, job.id); assert.equal(done.state, 'completed', JSON.stringify(done.delegation!.agent!.feedback));
    assert.equal(f.meituan.calls.length, 1); assert.equal(done.delegation!.agent!.components!.geo!.result!.ref.id, before.ref.id);
  } finally { f.close(); }
});

test('Cancellation fences all component observations and prevents downstream activation', async () => {
  const f = fixture();
  try {
    const job = f.b.submit(); await f.b.run(); f.meituan.setBefore(async () => { f.b.tasks.cancel(principal, job.id); }); await f.b.run();
    const canceled = f.store.get(owner, job.id); assert.equal(canceled.state, 'canceled'); assert.equal(canceled.delegation!.agent!.components!.geo!.observations.length, 0);
    assert(!canceled.delegation!.agent!.components!.didi!.scope); assert.equal(f.didi.calls.length, 0);
  } finally { f.close(); }
});

import { participantFixture, participantChoice } from './fixtures/free-booking.js';
import { setupPABooking, bookingChoice, bookingProgramRef } from './fixtures/pa-booking.js';

test('Cross-service reservations keep separate exact grants and PA payment retains the original component source', async () => {
  const registration = participantFixture(), booking = await setupPABooking();
  const store = new JobStore(':memory:');
  const regProgram = registration.catalog.agentProgram({ id: 'booking.participant.free', version: '1' }, owner)!;
  const bookProgram = booking.catalog.agentProgram(bookingProgramRef, owner)!;
  const { ExecutionCatalog } = await import('../packages/core/catalog.js');
  const catalog = new ExecutionCatalog([regProgram.capability(), bookProgram.capability()], [], [], [], [regProgram, bookProgram]);
  const input: CompositionInput = { components: [
    { id: 'registration', capabilityRef: regProgram.ref, goal: '确认免费报名', input: registration.input, dependsOn: [], bindings: [], requirementIds: ['total', 'people'], conditionIds: [], budgetShares: [{ requirementId: 'total', minor: '0' }] },
    { id: 'booking', capabilityRef: bookProgram.ref, goal: '预约并由 PA 模拟付款后确认', input: { query: 'consultation', participants: 2, startsAt: null }, dependsOn: [], bindings: [], requirementIds: ['total', 'people'], conditionIds: [], budgetShares: [{ requirementId: 'total', minor: '20000' }] },
  ] };
  const model: Reasoner = { reviewGoal: syntheticGoalReview, ground: async request => ({ decision: { ...interpretation(request, 'services.compose.sandbox', input), capabilityRef: { id: 'services.compose.sandbox', version: '1' } }, evidence: evidence() }), plan: async () => { throw new Error('No recipe'); },
    act: async (ctx, _signal, access) => {
      access.session.call('describe_ontology', { actions: ['CompleteServiceComponent'] });
      access.session.call('query_ontology', { object: ctx.state.scope });
      let decision: AgentDecision | undefined;
      for (const [id, program, chooser] of [['registration', regProgram, participantChoice], ['booking', bookProgram, bookingChoice]] as const) {
        const state = ctx.state.components![id]!;
        const inner = chooser({ ...ctx, actionIds: [...program.actionIds], state: { ...ctx.state, scope: state.scope!, input: state.input!, observations: state.observations, programRef: program.ref, programDigest: program.configurationDigest } }, access);
        if (!state.result) {
          decision = inner.kind === 'complete' ? { ...inner, kind: 'execute', steps: [step('accept_component', 'CompleteServiceComponent', { scope: ctx.state.scope, componentId: id, completionJson: inner.completionJson })], completionJson: '' } : inner;
          break;
        }
      }
      decision ??= { kind: 'complete', requestRevision: ctx.request.revision, message: 'Both services independently confirmed', steps: [], completionJson: '{"rationale":"All components verified"}' };
      return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    } };
  const b = backend(catalog, model, store, { allowSandbox: true }); let grants = 0, payments = 0;
  try {
    const job = b.submit({ executionEnvironment: 'sandbox', requirements: [{ id: 'total', kind: 'budget', role: 'service_total', strength: 'hard', expected: { minor: '20000', currency: 'CNY' } }, { id: 'people', kind: 'quantity', role: 'participant_count', strength: 'hard', expected: { amount: '3', unit: 'person' } }] });
    for (let i = 0; i < 30; i++) {
      const current = store.get(owner, job.id);
      if (current.state === 'completed') break;
      if (current.state === 'auth-required') {
        const a = current.delegation!.authorizationRequest!;
        b.tasks.authorize(principal, job.id, { action: 'approve_plan', requestId: randomUUID(), planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' }); grants++;
      } else if (current.delegation!.phase === 'awaiting_pa_payment') {
        const handoff = current.delegation!.agent!.paPayment!.request;
        const selected = b.tasks.selectPaymentRoute(principal, { action: 'select_payment_route', taskId: job.id, requestId: randomUUID(), handoffId: handoff.id, handoffDigest: handoff.digest, wallet: { status: 'available', reason: 'ready', observedAt: new Date().toISOString() } });
        await booking.wallet.pay(handoff, handoff.terms.amount, selected.delegation!.agent!.paPayment!.selection!.operationId); payments++;
        b.tasks.reportPayment(principal, { action: 'report_payment_result', taskId: job.id, requestId: randomUUID(), handoffId: handoff.id, handoffDigest: handoff.digest, outcome: 'submitted' });
      } else if (['working', 'submitted'].includes(current.state)) await b.run();
      else throw new Error(JSON.stringify({ state: current.state, question: current.question, error: current.error, feedback: current.delegation!.agent!.feedback }));
    }
    const done = store.get(owner, job.id); assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert(done.delegation!.acceptance!.checks.every(c => c.result === 'pass'));
    assert.equal(grants, 2); assert.equal(payments, 1); assert.equal(registration.counters().submits, 1);
    assert.equal(store.grants(owner, job.id).length, 2); assert.equal(done.delegation!.agent!.paPayment!.status, 'verified');
  } finally { store.close(); registration.store.close(); await booking.close(); }
});

test('The graph rejects invalid future input and non-exported output fields before any source action', async () => {
  for (const mutate of [(input: CompositionInput) => { input.components[1]!.input.mode = 'create_order'; }, (input: CompositionInput) => { input.components[1]!.bindings[0]!.path = ['privatePayload']; }]) {
    const input = compositionExample(); mutate(input); const f = fixture(input);
    try { f.b.submit(); await assert.rejects(f.b.run()); assert.equal(f.meituan.calls.length, 0); assert.equal(f.didi.calls.length, 0); }
    finally { f.close(); }
  }
});


test('A root shared budget cannot be amplified through independent component allocations', async () => {
  const input = compositionExample(false);
  for (const n of input.components) { n.requirementIds = ['total']; n.budgetShares = [{ requirementId: 'total', minor: '100' }]; }
  const f = fixture(input);
  try {
    f.b.submit({ requirements: [{ id: 'total', kind: 'budget', strength: 'hard', expected: { minor: '100', currency: 'CNY' } }] });
    await assert.rejects(f.b.run(), /original total/); assert.equal(f.meituan.calls.length, 0); assert.equal(f.didi.calls.length, 0);
  } finally { f.close(); }
});

test('Absent price evidence cannot become a zero shared total or a completed parent', async () => {
  const input = compositionExample(false); for (const n of input.components) n.requirementIds = ['total'];
  const f = fixture(input);
  try {
    const job = f.b.submit({ requirements: [{ id: 'total', kind: 'budget', strength: 'hard', expected: { minor: '10000', currency: 'CNY' } }] });
    const final = await f.finish(job.id); assert.equal(final.state, 'input-required'); assert(!final.artifact);
    assert(final.delegation!.agent!.feedback.some(f => f.message.includes('hard requested outcome')));
  } finally { f.close(); }
});

test('Owner-only deliverables do not leak through composition model context or exported graph output', async () => {
  const input = compositionExample(false); input.components[0]!.capabilityRef = { id: 'address.book.read', version: '1' }; input.components[0]!.input = {}; input.components[0]!.goal = '查看本人地址簿';
  const f = fixture(input);
  try {
    const job = f.b.submit(); const done = await f.finish(job.id); assert.equal(done.state, 'completed', JSON.stringify(done.delegation!.agent!.feedback));
    assert(JSON.stringify(done.artifact).includes('private-a'), 'The original owner deliverable remains available to its PA');
    const state = done.delegation!.agent!, program = f.catalog.agentProgram(state.programRef, owner)!;
    const modelData = JSON.stringify(program.describeComponents!({ graph: f.store.ontology, owner, request: done.delegation!.request, state }));
    for (const marker of ['private-a', '13800001111', '测试住处']) assert(!modelData.includes(marker));
    const result = f.store.ontology.read(owner, state.components!.geo!.result!.ref);
    assert.deepEqual(result.properties.output, {});
  } finally { f.close(); }
});

test('Tampering with a projected handoff cannot substitute a new downstream input', async () => {
  const f = fixture();
  try {
    const job = f.b.submit(); for (let i = 0; i < 3; i++) await f.b.run();
    const state = f.store.get(owner, job.id).delegation!.agent!, ref = state.components!.geo!.result!.ref, record = f.store.ontology.read(owner, ref);
    f.store.ontology.ingest(owner, { objects: [{ ref, expectedRevision: record.revision, properties: { ...record.properties, output: { places: [{ name: '替换后的错误目标' }] } } }] }, { kind: 'task', id: job.id, observedAt: new Date().toISOString() });
    await f.b.run(); const current = f.store.get(owner, job.id);
    assert.equal(f.didi.calls.length, 0); assert(!current.delegation!.agent!.components!.didi!.scope);
    assert(current.delegation!.agent!.feedback.some(f => f.message.includes('Dependency result changed')));
  } finally { f.close(); }
});
