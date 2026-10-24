import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JobStore } from '../packages/core/store.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { digest } from '../packages/core/delegation.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import type { SerializableAction, SerializableObjectType } from '../packages/ontology/definition-contracts.js';
import { previewDeclarativeAction } from '../packages/ontology/declarative-actions.js';
import { mergeManagedResultFacts } from '../packages/ontology/managed-result-facts.js';
import { backend, owner, principal, evidence, observeTaskContext, acknowledgeReads } from './backend-fixture.js';

const record: SerializableObjectType = { resourceId: 'fixture:object:MeasuredRecord', id: 'MeasuredRecord', version: '1', name: 'Internal proposal', description: 'Synthetic internal proposal values, not a purchase', aliases: [], primaryKey: 'id', titleKey: 'id', writePolicy: 'managed', properties: {
  id: { kind: 'string', schema: { type: 'string', minLength: 1, maxLength: 200 }, description: 'Identity', source: 'Fixture', required: true },
  price: { kind: 'integer', schema: { type: 'integer' }, description: 'Proposed price in minor currency units', source: 'Fixture', required: true },
  currency: { kind: 'string', schema: { type: 'string' }, description: 'Currency', source: 'Fixture', required: true },
  days: { kind: 'integer', schema: { type: 'integer' }, description: 'Proposed duration in days', source: 'Fixture', required: true },
  secret: { kind: 'integer', schema: { type: 'integer' }, description: 'Private amount', source: 'Fixture', restricted: true },
} };
const action: SerializableAction = { resourceId: 'fixture:action:CreateMeasuredRecord', id: 'CreateMeasuredRecord', version: '1', kind: 'business', description: 'Create an internal proposal', effects: ['object_write'], inputs: {}, changes: ['MeasuredRecord'], resultTypes: ['MeasuredRecord'], submissionCriteria: ['exact_object_write_authority'], inputSchema: {
  type: 'object', properties: { id: { type: 'string' }, price: { type: 'integer' }, currency: { type: 'string' }, days: { type: 'integer' } }, required: ['id', 'price', 'currency', 'days'], additionalProperties: false,
}, implementation: { kind: 'declarative', version: '1', conditions: [], mutations: [{ op: 'create', type: 'MeasuredRecord', id: { parameter: 'id' }, properties: { id: { parameter: 'id' }, price: { parameter: 'price' }, currency: { parameter: 'currency' }, days: { parameter: 'days' } } }],
  resultFacts: [{ kind: 'budget', amountProperty: 'price', currencyProperty: 'currency' }, { kind: 'quantity', amountProperty: 'days', unit: '天' }],
} };
function fixture(store: JobStore, declaration = action) {
  const ns = store.definitions.createNamespace(owner, { id: 'managed.facts', name: 'Result measurements' });
  let draft = store.definitions.createDraft(owner, ns.id, 'Declared result measurement bindings');
  draft = store.definitions.putResource(owner, draft.id, draft.revision, 'object', record);
  draft = store.definitions.putResource(owner, draft.id, draft.revision, 'action', declaration);
  return { ns, draft, publish: () => { const release = store.definitions.publish(owner, draft.id, draft.revision).release; store.definitions.activate(owner, release, ns.generation); return store.ontologyForRelease(release); } };
}
const requested = [
  { id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '80000', currency: 'CNY' } },
  { id: 'duration', kind: 'quantity', strength: 'hard', expected: { amount: '7', unit: '天' } },
];
function modelFor(input: object): Reasoner {
  return { ground: async (request, capabilities, _signal, access) => {
    observeTaskContext(access); const capability = capabilities.find(c => c.tags.includes('dynamic-actions'))!;
    return { decision: { kind: 'resolve', requestRevision: request.revision, capabilityRef: capability.ref, message: 'Create the requested internal proposal', inputJson: JSON.stringify({ actionIds: ['CreateMeasuredRecord'], objects: [] }), requirementsJson: '[]', conditionsJson: '[]' }, evidence: evidence() };
  }, plan: async () => { throw new Error('Managed proposals use the Agent runtime'); }, act: async (ctx, _signal, access) => {
    observeTaskContext(access);
    for (const object of ctx.state.observations) access.session.call('query_ontology', { object });
    const decision: AgentDecision = ctx.state.observations.length
      ? { kind: 'complete', requestRevision: ctx.request.revision, message: 'The stored result was read back', steps: [], completionJson: JSON.stringify({ intentIds: ctx.actionOutcomes!.filter(o => o.state === 'effect_confirmed').map(o => o.intentId) }) }
      : { kind: 'execute', requestRevision: ctx.request.revision, message: 'Create the proposal under exact data authority', steps: [{ id: 'create', action: 'CreateMeasuredRecord', argumentsJson: JSON.stringify(input), dependsOn: [], inputRefs: [] }], completionJson: '' };
    acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
  } };
}

test('published result bindings satisfy preserved hard budget and duration only from committed record readback', async () => {
  const store = new JobStore(':memory:');
  try {
    const f = fixture(store), graph = f.publish(), input = { id: 'trip', price: 70000, currency: 'CNY', days: 7 };
    const b = backend(createExecutionCatalog({ store }), modelFor(input), store), job = b.submit({ ontologyId: f.ns.id, goal: 'Prepare a seven-day internal proposal under CNY 800, without payment', requirements: requested });
    await b.run(); const waiting = await b.run(); assert.equal(waiting.state, 'auth-required', JSON.stringify(waiting.delegation?.agent?.feedback));
    const grant = waiting.delegation!.authorizationRequest!; assert.equal(grant.environment, 'managed');
    assert.equal(graph.query(owner, { type: 'MeasuredRecord' }).items.length, 0);
    b.tasks.authorize(principal, job.id, { action: 'approve_object_write', requestId: randomUUID(), environment: 'managed', planDigest: grant.planDigest, objectWrite: grant.objectWrite, expiresAt: new Date(Date.now() + 60000).toISOString() });
    await b.run(); const done = await b.run();
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.deepEqual(done.delegation!.request.requirements.map(r => ({ id: r.id, expected: r.expected })), requested.map(r => ({ id: r.id, expected: r.expected })));
    assert(done.delegation!.acceptance!.checks.every(check => check.result === 'pass'));
    const intent = store.intents(owner, job.id)[0]!;
    assert.equal(intent.effect, 'object_write'); assert.equal(store.grants(owner, job.id)[0]!.kind, 'object_write');
    assert.equal(store.budget(owner, job.id).length, 0, 'A measured proposal price is not a payment grant');
    assert.deepEqual(graph.read(owner, { type: 'MeasuredRecord', id: 'trip' }).properties, input);
  } finally { store.close(); }
});

for (const [name, input] of [
  ['over budget', { id: 'bad', price: 90000, currency: 'CNY', days: 7 }],
  ['wrong duration', { id: 'bad', price: 70000, currency: 'CNY', days: 8 }],
  ['wrong currency', { id: 'bad', price: 70000, currency: 'USD', days: 7 }],
] as const) test(`result facts reject ${name} before creating an Intent or requesting write authority`, async () => {
  const store = new JobStore(':memory:');
  try {
    const f = fixture(store), graph = f.publish(), b = backend(createExecutionCatalog({ store }), modelFor(input), store);
    const job = b.submit({ ontologyId: f.ns.id, goal: 'Prepare a fixed seven-day CNY proposal', requirements: requested });
    await b.run(); const rejected = await b.run();
    assert.equal(rejected.state, 'working'); assert(rejected.delegation!.agent!.feedback.some(f => f.message.includes('fixed numeric requirements')));
    assert.equal(store.intents(owner, job.id).length, 0); assert.equal(store.grants(owner, job.id).length, 0); assert.equal(graph.query(owner, { type: 'MeasuredRecord' }).items.length, 0);
  } finally { store.close(); }
});

test('result bindings cannot read private fields, treat text as an amount, or fabricate provider facts', () => {
  for (const amountProperty of ['secret', 'currency', 'missing']) {
    const store = new JobStore(':memory:');
    try {
      const declaration = structuredClone(action); assert(declaration.implementation?.kind === 'declarative');
      declaration.implementation.resultFacts = [{ kind: 'budget', amountProperty, currencyProperty: 'currency' }];
      const f = fixture(store, declaration); assert.equal(store.definitions.validate(f.draft.id).valid, false);
    } finally { store.close(); }
  }
  const store = new JobStore(':memory:');
  try {
    const f = fixture(store), graph = f.publish();
    assert.throws(() => previewDeclarativeAction(graph, owner, 'CreateMeasuredRecord', { id: 'unsafe', price: Number.MAX_SAFE_INTEGER + 1, currency: 'CNY', days: 7 }), /safe integer/);
    assert.throws(() => previewDeclarativeAction(graph, owner, 'CreateMeasuredRecord', { id: 'unsafe', price: 70000, currency: 'invalid', days: 7 }), /currency/);
    assert.equal(graph.query(owner, { type: 'MeasuredRecord' }).items.length, 0);
    const declaration = structuredClone(action); assert(declaration.implementation?.kind === 'declarative');
    const draft = store.definitions.createDraft(owner, f.ns.id, 'Reject invented fulfillment');
    assert.throws(() => store.definitions.putResource(owner, draft.id, draft.revision, 'action', { ...declaration, implementation: { ...declaration.implementation, resultFacts: [{ kind: 'condition', predicate: 'payment.completed' }] } }));
  } finally { store.close(); }
});

test('conflicting result measurements do not silently choose the favorable quote', () => {
  assert.throws(() => mergeManagedResultFacts([{ totalPrice: { minor: '70000', currency: 'CNY' } }, { totalPrice: { minor: '90000', currency: 'CNY' } }]), /ambiguous/);
  assert.deepEqual(mergeManagedResultFacts([{ quantity: { amount: '7', unit: '天' } }, { quantity: { amount: '7', unit: '天' } }]), { quantity: { amount: '7', unit: '天' } });
});

test('result facts cannot borrow an unrelated existing record instead of the object being changed', () => {
  const store = new JobStore(':memory:');
  try {
    const declaration = structuredClone(action); assert(declaration.implementation?.kind === 'declarative');
    declaration.implementation.result = { type: 'MeasuredRecord', id: { literal: 'unrelated-cheap-record' } };
    const f = fixture(store, declaration), graph = f.publish();
    graph.ingest(owner, { objects: [{ ref: { type: 'MeasuredRecord', id: 'unrelated-cheap-record' }, properties: { id: 'unrelated-cheap-record', price: 1, currency: 'CNY', days: 7 } }] }, { kind: 'user', id: 'synthetic-owner-fixture', observedAt: new Date().toISOString() });
    assert.throws(() => previewDeclarativeAction(graph, owner, 'CreateMeasuredRecord', { id: 'over-budget-record', price: 90000, currency: 'CNY', days: 7 }), /changed by this action/);
    assert.equal(graph.query(owner, { type: 'MeasuredRecord' }).items.length, 1);
  } finally { store.close(); }
});
