// Contract and runtime tests use explicit synthetic model/source decisions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { OntologyPlanningSession, validatePlanningSnapshot } from '../packages/coordinator/planning-session.js';
import { groundConditions, assessConditions } from '../packages/coordinator/conditions.js';
import { groundRequirements } from '../packages/coordinator/requirements.js';
import { checkRequirements } from '../packages/coordinator/resolver.js';
import { CodexReasoner, type PlanningContext } from '../packages/coordinator/coordinator.js';
import { reasonWithOntology } from '../packages/coordinator/reasoning-loop.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { BRIEF_CAPABILITY, BRIEF_BINDING, BriefAdapter } from '../packages/capabilities/brief.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';
import type { BusinessCondition } from '../packages/ontology/business-model.js';
import { equivalentQuantities } from '../packages/ontology/quantity.js';
import { drillCase } from './fixtures/ontology-drill.js';
import { backend, interpretation, proposal, evidence, owner, principal, reasoner, fixtureCapability, fixtureBinding, fixtureAdapter } from './backend-fixture.js';

function fixture(id = 'QD-1') {
  const data = drillCase(id), db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, undefined, () => data.now);
  graph.ingest(owner, data.batch, data.source);
  return { ...data, db, graph, session: new OntologyPlanningSession(graph, owner, data.request) };
}
function observe(f: ReturnType<typeof fixture>, type = 'DeliveryQuote') {
  f.session.call('describe_ontology', { search: type, limit: 1 });
  return f.session.call('query_ontology', { type }) as ReturnType<OntologyObjectStore['query']>;
}
const parcelCondition = (request: ServiceRequest): BusinessCondition => ({ id: 'priced-input', predicateRef: { id: 'parcel.quote_matches_request', version: '1' }, subject: { type: 'DeliveryQuote', role: 'parcel_quote' }, phase: 'result', strength: 'hard', operator: 'eq', expected: { weight: { amount: '1', unit: 'kg' }, serviceLevel: 'ordinary' }, source: { messageId: request.messages[0]!.id, quote: request.messages[0]!.text } });

test('N2 grounds typed conditions without weakening source quantities, services, budgets or prior conditions', () => {
  const request: ServiceRequest = { id: 'R', revision: 1, originalGoal: '只查1公斤文件普通送', messages: [{ id: 'message', text: '只查1公斤文件普通送', receivedAt: new Date().toISOString() }], requirements: [] };
  const c = parcelCondition(request), fixed = groundConditions(request, JSON.stringify([c]));
  assert.equal(fixed.conditions![0]!.phase, 'result');
  for (const change of [
    { expected: { weight: { amount: '2', unit: 'kg' }, serviceLevel: 'ordinary' } },
    { expected: { weight: { amount: '1', unit: 'kg' }, serviceLevel: 'express' } },
    { source: { messageId: 'other', quote: request.originalGoal } },
    { strength: 'preference' },
    { expected: { weight: { amount: '1', unit: 'kg' }, serviceLevel: 'ordinary', route: { type: 'DeliveryRoute', id: 'invented' } } },
  ]) assert.throws(() => groundConditions(fixed, JSON.stringify([{ ...c, ...change }])));
  const budgetRequest = { ...request, originalGoal: '总费用不超过500元', messages: [{ ...request.messages[0]!, text: '总费用不超过500元，另有300元报价' }], requirements: [{ id: 'budget', kind: 'budget' as const, strength: 'hard' as const, expected: { minor: '50000', currency: 'CNY' }, provenance: { source: 'pa' as const, interpretation: 'structured' as const, messageId: 'message', receivedAt: new Date().toISOString() } }] };
  const budget = { id: 'total', predicateRef: { id: 'offer.total_within_budget', version: '1' }, subject: { type: 'ProductOffer', role: 'total_price' }, phase: 'precondition', strength: 'hard', operator: 'lte', expected: { amount: { minor: '30000', currency: 'CNY' }, priceBasis: 'firm_quote', scope: 'all_mandatory_fees' }, source: { messageId: 'message', quote: budgetRequest.messages[0]!.text } };
  assert.throws(() => groundConditions(budgetRequest, JSON.stringify([budget])), /fixed budget/);
});

test('N2 canonical units match quoted Chinese units without accepting quantity or dimension changes', () => {
  assert.equal(equivalentQuantities({ amount: '1', unit: 'constructor' }, { amount: '1', unit: 'kg' }), undefined);
  const request: ServiceRequest = { id: 'mass', revision: 1, originalGoal: '1公斤文件普通送', messages: [{ id: 'message', text: '1公斤文件普通送', receivedAt: new Date().toISOString() }], requirements: [] };
  for (const expected of [{ amount: '1', unit: 'kg' }, { amount: '1000', unit: 'g' }]) {
    const grounded = groundRequirements(request, JSON.stringify([{ requirement: { id: 'weight', kind: 'quantity', strength: 'hard', expected }, messageId: 'message', quote: request.originalGoal }]));
    assert.equal(checkRequirements(grounded, { quantity: { amount: '1', unit: '公斤' } }, ['synthetic-source'])[0]!.result, 'pass');
    assert.equal(checkRequirements(grounded, { quantity: { amount: '2', unit: '公斤' } }, ['synthetic-source'])[0]!.result, 'fail');
  }
  for (const expected of [{ amount: '2', unit: 'kg' }, { amount: '1', unit: 'cup' }]) assert.throws(() => groundRequirements(request, JSON.stringify([{ requirement: { id: 'weight', kind: 'quantity', strength: 'hard', expected }, messageId: 'message', quote: request.originalGoal }])), /Quantity interpretation/);
  const decimal = { ...request, originalGoal: '1.5公斤文件普通送', messages: [{ ...request.messages[0]!, text: '1.5公斤文件普通送' }] };
  const grounded = groundRequirements(decimal, JSON.stringify([{ requirement: { id: 'weight', kind: 'quantity', strength: 'hard', expected: { amount: '1500', unit: 'g' } }, messageId: 'message', quote: decimal.originalGoal }]));
  assert.equal(checkRequirements(grounded, { quantity: { amount: '1.5', unit: '公斤' } }, ['synthetic'])[0]!.result, 'pass');
});

test('N2 condition evaluation distinguishes candidates and preserves future result uncertainty', () => {
  const f = fixture('QG-1');
  try {
    const pass = assessConditions(f.graph, owner, f.request, { type: 'ProductOffer', id: 'offer-G' }, 'precondition');
    assert(pass.length >= 4 && pass.every(c => c.result === 'pass'));
    const unknown = assessConditions(f.graph, owner, f.request, { type: 'ProductOffer', id: 'offer-X' }, 'precondition');
    assert.equal(unknown.find(c => c.conditionId === 'goods.capacity_covers_quantity')!.result, 'unknown');
    const fees = assessConditions(f.graph, owner, f.request, { type: 'ProductOffer', id: 'offer-Y' }, 'precondition');
    assert.equal(fees.find(c => c.conditionId === 'offer.total_within_budget')!.result, 'unknown');
    assert(assessConditions(f.graph, owner, f.request).every(c => c.result === 'unknown'));
    const variant = f.graph.read(owner, f.ids.variant!);
    f.graph.ingest(owner, { objects: [{ ref: variant.ref, properties: { ...variant.properties, specificationRevision: 'changed-spec' }, expectedRevision: variant.revision }] }, f.source);
    const stale = assessConditions(f.graph, owner, f.request, { type: 'ProductOffer', id: 'offer-G' });
    assert.equal(stale.find(c => c.conditionId === 'goods.variant_matches')!.result, 'unknown');
  } finally { f.db.close(); }
  const pending = fixture('QR-2');
  try { assert.equal(assessConditions(pending.graph, owner, pending.request, undefined, 'result')[0]!.result, 'unknown'); }
  finally { pending.db.close(); }
});

test('N2 model reads are bounded, owner-scoped, schema-checked and cannot execute or fabricate an Action', () => {
  const f = fixture();
  try {
    assert.equal((f.session.call('evaluate_ontology', { function: 'offerFreshness', object: f.ids['quote-D'] }) as { error: string }).error, 'FORBIDDEN');
    observe(f);
    const result = f.session.call('evaluate_ontology', { function: 'offerFreshness', object: f.ids['quote-D'] }) as { value: boolean }; assert.equal(result.value, true);
    const before = f.graph.revision(owner);
    const privateRead = f.session.call('query_ontology', { type: 'SavedAddress', select: ['contactInstructions'] }); assert(!JSON.stringify(privateRead).includes('PRIVATE_'));
    const write = f.session.call('propose_action', { action: 'PayDeposit', inputs: [{ name: 'payment', object: f.ids.payment, revision: 1 }] }); assert.match(JSON.stringify(write), /Unknown ontology action/);
    assert.equal(f.graph.revision(owner), before);
    const other = new OntologyPlanningSession(f.graph, 'other-owner', f.request);
    assert.deepEqual((other.call('query_ontology', { type: 'Offer' }) as { items: unknown[] }).items, []);
    assert.equal((other.call('query_ontology', { from: { type: 'ServiceRequest', id: f.request.id }, link: 'offers' }) as { error: string }).error, 'NOT_FOUND');
    for (let i = 0; i < 2; i++) f.session.call('query_ontology', { type: 'Offer', limit: 999 });
    assert.throws(() => f.session.call('query_ontology', { type: 'Offer', limit: 999 }), /Three identical/);
  } finally { f.db.close(); }
});

test('N2 decision Action proposals fix changes and input versions but do not grant execution', () => {
  const f = fixture();
  try {
    observe(f); f.session.call('query_ontology', { type: 'ServiceRequest' });
    const before = f.graph.revision(owner);
    const result = f.session.call('propose_action', { action: 'SelectOffer', inputs: [{ name: 'request', object: f.ids.D, revision: 1 }, { name: 'offer', object: f.ids['quote-D'], revision: 1 }] }) as { executionAllowed: boolean; changes: string[]; checks: { criterion: string; result: string }[] };
    assert.equal(result.executionAllowed, false); assert(result.changes.includes('Proposal.selectedOffer'));
    assert.equal(result.checks.find(c => c.criterion === 'same_request')!.result, 'pass');
    assert.equal(f.graph.revision(owner), before);
    const denied = f.session.call('propose_action', { action: 'SelectOffer', inputs: [{ name: 'request', object: f.ids.G, revision: 1 }, { name: 'offer', object: f.ids['quote-D'], revision: 1 }] }); assert.match(JSON.stringify(denied), /another request/);
  } finally { f.db.close(); }
});

test('N2 plans require actual reads and reject changed object snapshots before a new dispatch', () => {
  const f = fixture();
  try {
    assert.throws(() => f.session.finish(), /actual definition and object reads/);
    observe(f); const snapshot = f.session.finish(); assert.equal(snapshot.mode, 'model_queries');
    validatePlanningSnapshot(f.graph, owner, f.request, snapshot, true);
    const quote = f.graph.read(owner, f.ids['quote-D']!);
    f.graph.ingest(owner, { objects: [{ ref: quote.ref, properties: { ...quote.properties, serviceLevel: 'express' }, expectedRevision: quote.revision }] }, f.source);
    assert.throws(() => validatePlanningSnapshot(f.graph, owner, f.request, snapshot, true), /changed/);
    validatePlanningSnapshot(f.graph, owner, f.request, snapshot, false); // existing unknown operations may still be observed
    assert.throws(() => validatePlanningSnapshot(f.graph, owner, f.request, { ...snapshot, requestRevision: 99 }, false), /contract changed/);
  } finally { f.db.close(); }
});

test('N2 Codex reasoning transport drives real host queries in both interpretation and planning', async () => {
  const prompts: string[] = [];
  const model = { runStructured: async (prompt: string) => {
    prompts.push(prompt);
    const packet = JSON.parse(prompt.split('\n\n').at(-1)!) as { request: ServiceRequest; conversation: unknown[]; finalSchema: { properties: Record<string, unknown> } };
    const request = packet.request;
    const output = !packet.conversation.length ? { kind: 'read', calls: [
      { tool: 'describe_ontology', argumentsJson: JSON.stringify({ search: 'ServiceRequest', limit: 1 }) },
      { tool: 'query_ontology', argumentsJson: JSON.stringify({ type: 'ServiceRequest', where: [{ property: 'requestId', op: 'eq', value: request.id }] }) },
    ], finalJson: '' } : { kind: 'final', calls: [], finalJson: packet.finalSchema.properties.requirementsJson
      ? JSON.stringify(interpretation(request))
      : JSON.stringify(proposal(prompt.split('\n\n').map(part => { try { return JSON.parse(part); } catch { return undefined; } }).find(p => p?.resolution && p?.capability) as PlanningContext)) };
    return { output, evidence: evidence() };
  } };
  const b = backend(new ExecutionCatalog([BRIEF_CAPABILITY], [BRIEF_BINDING], [new BriefAdapter()]), new CodexReasoner(model));
  try {
    b.submit(); const done = await b.run(); assert.equal(done.state, 'completed');
    assert.equal(prompts.length, 4); assert.equal(done.runs!.length, 4);
    assert.equal(done.delegation!.ontologyReads!.length, 4); assert.equal(done.delegation!.plan!.ontologyPlanning.reads.length, 2);
    assert.equal(done.delegation!.plan!.version, '6');
    assert(prompts.some(p => p.includes('propertiesDigest')) === false, 'Internal snapshot hashes need not be shown as business data');
  } finally { b.store.close(); }
});

test('N2 read loop rejects a final answer without reads and honors its model-turn budget', async () => {
  const f = fixture();
  try {
    await assert.rejects(reasonWithOntology({ runStructured: async () => ({ output: { kind: 'final', calls: [], finalJson: '{}' }, evidence: evidence() }) }, 'Synthetic', {}, f.session, new AbortController().signal, () => {}), /skipped required/);
    let calls = 0;
    await assert.rejects(reasonWithOntology({ runStructured: async () => { calls++; return { output: { kind: 'read', calls: [{ tool: 'describe_ontology', argumentsJson: '{}' }], finalJson: '' }, evidence: evidence() }; } }, 'Synthetic', {}, f.session, new AbortController().signal, () => {}, 1), /turn limit/);
    assert.equal(calls, 1);
  } finally { f.db.close(); }
});

test('N2 cancellation fences model responses and prevents the next read or dispatch', async () => {
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { started = r; }), waiting = new Promise<void>(r => { release = r; });
  const model = { runStructured: async () => { started(); await waiting; return { output: { kind: 'read', calls: [{ tool: 'describe_ontology', argumentsJson: '{}' }], finalJson: '' }, evidence: evidence() }; } };
  const b = backend(new ExecutionCatalog([BRIEF_CAPABILITY], [BRIEF_BINDING], [new BriefAdapter()]), new CodexReasoner(model));
  try {
    const job = b.submit(), pending = b.run(); const rejected = assert.rejects(pending, /cancellation|lease loss/);
    await entered; b.tasks.cancel(principal, job.id); release(); await rejected;
    const canceled = b.store.get(owner, job.id); assert.equal(canceled.state, 'canceled'); assert.equal(canceled.artifact, undefined); assert.equal(canceled.delegation!.ontologyReads, undefined);
  } finally { release(); b.store.close(); }
});

test('N2 missing typed precondition evidence blocks a proposed dispatch even when generic facts look ready', async () => {
  let executions = 0;
  const adapter = fixtureAdapter('synthetic', { quantity: { amount: '20', unit: '杯' } }, { execute: async () => { executions++; throw new Error('Must not dispatch'); } });
  const b = backend(new ExecutionCatalog([fixtureCapability], [fixtureBinding('synthetic')], [adapter]), reasoner(request => ({ ...interpretation(request, fixtureCapability.ref.id, {}), conditionsJson: JSON.stringify([
    { id: 'capacity', predicateRef: { id: 'goods.capacity_covers_quantity', version: '1' }, subject: { type: 'ProductOffer', role: 'capacity' }, phase: 'precondition', strength: 'hard', operator: 'gte', expected: { amount: '20', unit: 'cup' }, source: { messageId: request.messages[0]!.id, quote: request.originalGoal } },
  ]) })));
  try {
    const job = b.submit({ goal: '20杯咖啡' }); await assert.rejects(b.run(), /preconditions/);
    assert.equal(executions, 0); assert.equal(b.store.get(owner, job.id).delegation!.plan, undefined);
    assert.equal(b.store.get(owner, job.id).artifact, undefined);
  } finally { b.store.close(); }
});

test('N2 future result conditions allow preparation but cannot be closed out by an unrelated artifact', async () => {
  const b = backend(new ExecutionCatalog([BRIEF_CAPABILITY], [BRIEF_BINDING], [new BriefAdapter()]), reasoner(request => ({ ...interpretation(request), conditionsJson: JSON.stringify([parcelCondition(request)]) })));
  try {
    b.submit({ goal: '查1公斤文件普通送' }); const done = await b.run();
    assert(done.delegation!.plan); assert.equal(done.state, 'failed'); assert.equal(done.artifact, undefined);
    assert.equal(done.delegation!.conditionChecks![0]!.result, 'unknown'); assert.equal(done.delegation!.acceptance!.accepted, false);
    assert.equal(done.delegation!.outcome!.status, 'unknown');
    assert.equal(b.store.ontology.read(owner, { type: 'ServiceRequest', id: done.id }).properties.progress, 'needs_review');
    assert.equal(done.delegation!.plan!.ontologyPlanning.conditionChecks[0]!.phase, 'result');
  } finally { b.store.close(); }
});

test('N2 write-only PA clients keep their task flow without gaining access to other owned requests', async () => {
  const normal = reasoner(); const observed: unknown[] = [];
  const b = backend(new ExecutionCatalog([BRIEF_CAPABILITY], [BRIEF_BINDING], [new BriefAdapter()]), { ...normal, plan: async (context, signal, access) => {
    if (context.request.originalGoal === 'current-write-only-request') {
      observed.push(access.session.call('query_ontology', { type: 'ServiceRequest' }));
      observed.push(access.session.call('query_ontology', { object: { type: 'ServiceRequest', id: previousId } }));
      observed.push(access.session.call('query_ontology', { type: 'Offer' }));
    }
    return normal.plan(context, signal, access);
  } });
  let previousId = '';
  try {
    previousId = b.submit({ goal: 'PRIVATE_PREVIOUS_REQUEST_MARKER' }).id; await b.run();
    const writeOnly = { ...principal, scopes: ['tasks:write'] };
    const current = b.tasks.submit(writeOnly, { service: 'eigos.delegate', goal: 'current-write-only-request', requestId: 'write-only' });
    const done = await b.run(); assert.equal(done.state, 'completed'); assert.equal(done.id, current.id);
    assert.equal(done.delegation!.ontologyReadScope, 'request');
    const query = observed[0] as { items: { ref: { id: string } }[] }; assert.equal(query.items.length, 1); assert.equal(query.items[0]!.ref.id, current.id);
    assert.equal((observed[1] as { error: string }).error, 'FORBIDDEN'); assert.equal((observed[2] as { error: string }).error, 'FORBIDDEN');
    assert(!JSON.stringify(observed).includes('PRIVATE_PREVIOUS_REQUEST_MARKER'));
    assert.throws(() => b.tasks.get(writeOnly, previousId), /tasks:read/);
    assert.equal((await b.tasks.wait(writeOnly, current.id)).state, 'completed');
  } finally { b.store.close(); }
});
