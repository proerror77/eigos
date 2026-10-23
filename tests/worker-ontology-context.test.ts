// Synthetic model and provider fixtures. Real native PA timing is a separate check.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { OntologyPlanningSession, validatePlanningSnapshot } from '../packages/coordinator/planning-session.js';
import { reasonWithOntology } from '../packages/coordinator/reasoning-loop.js';
import { CodexReasoner } from '../packages/coordinator/coordinator.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { digest } from '../packages/core/delegation.js';
import { drillCase } from './fixtures/ontology-drill.js';
import { backend, evidence, interpretation, owner } from './backend-fixture.js';
import { didiFixture, input, syntheticKey } from './fixtures/didi.js';
import { DIDI_PROGRAM_REF } from '../packages/capabilities/didi/program.js';
import type { AgentDecision, AgentStep } from '../packages/ontology/agent-actions.js';
import type { AgentPlanningContext } from '../packages/coordinator/coordinator.js';
import type { RideEstimateObservation } from '../packages/ontology/ride-estimate.js';
import type { ObjectRef } from '../packages/ontology/model.js';
import { planningSnapshot } from '../packages/ontology/planning-contract.js';

function sessionFixture() {
  const data = drillCase('QD-1'), db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, undefined, () => data.now);
  graph.ingest(owner, data.batch, data.source);
  return { ...data, db, graph, session: new OntologyPlanningSession(graph, owner, data.request) };
}
const frame = (prompt: string) => JSON.parse(prompt.split('\n\n').at(-1)!);

test('Fresh Worker context performs actual reads before one model response and binds the receipts to its evidence', async () => {
  const f = sessionFixture(); let responses = 0;
  try {
    const model = { ontologyContextPreparation: 'worker_snapshot' as const, runStructured: async (prompt: string) => {
      responses++; const packet = frame(prompt);
      assert.equal(packet.budget.toolCallsRemaining, 18);
      assert(packet.conversation.some((entry: any) => entry.call.tool === 'query_ontology' && entry.result.items.some((item: any) => item.ref.id === f.request.id)));
      const reads = f.session.receipts(); assert.equal(reads.length, 2); assert(reads.every(read => read.origin === 'worker_context' && read.status === 'ok'));
      assert.equal(packet.workerContext.digest, digest({ model: f.graph.model.ref, requestRevision: f.request.revision, reads }));
      return { output: { kind: 'final', calls: [], finalJson: '{"selected":"from fresh input"}' }, evidence: evidence() };
    } };
    const response = await reasonWithOntology(model, 'Synthetic bounded task', {}, f.session, new AbortController().signal, () => {}, 8, {});
    assert.equal(responses, 1); assert.equal(response.evidence.ontologyContext!.receiptIds.length, 2);
    assert.deepEqual(response.output, { selected: 'from fresh input' });
    const snapshot = f.session.finish(); assert.equal(snapshot.mode, 'worker_context'); validatePlanningSnapshot(f.graph, owner, f.request, snapshot, true);
  } finally { f.db.close(); }
});

test('Model-requested follow-up reads remain available and are attributed separately from initial context', async () => {
  const f = sessionFixture(); let responses = 0;
  try {
    const model = { ontologyContextPreparation: 'worker_snapshot' as const, runStructured: async (prompt: string) => {
      const packet = frame(prompt); responses++;
      if (responses === 1) return { output: { kind: 'read', calls: [{ tool: 'describe_ontology', argumentsJson: '{"actions":[],"functions":[],"includeConditionSchema":true}' }], finalJson: '' }, evidence: evidence() };
      assert.equal(packet.budget.toolCallsRemaining, 17);
      return { output: { kind: 'final', calls: [], finalJson: '{}' }, evidence: evidence() };
    } };
    await reasonWithOntology(model, 'Synthetic follow-up', {}, f.session, new AbortController().signal, () => {}, 8, {});
    assert.equal(responses, 2); assert.deepEqual(f.session.receipts().map(read => read.origin), ['worker_context', 'worker_context', 'model']);
    assert.equal(f.session.finish().mode, 'worker_context_with_queries');
  } finally { f.db.close(); }
});

test('A valid snapshot digest cannot conceal a different read initiator or snapshot mode', () => {
  const f = sessionFixture();
  try {
    f.session.prepareContext(); const { digest: _digest, ...body } = f.session.finish();
    assert.throws(() => validatePlanningSnapshot(f.graph, owner, f.request, planningSnapshot({ ...body, mode: 'model_queries' }), false), /attribution/);
    assert.throws(() => validatePlanningSnapshot(f.graph, owner, f.request, planningSnapshot({ ...body, mode: 'worker_context_with_queries' }), false), /attribution/);
    const reads = body.reads.map(read => ({ ...read, origin: 'invented-source' as never }));
    assert.throws(() => validatePlanningSnapshot(f.graph, owner, f.request, planningSnapshot({ ...body, reads }), false), /origin/);
  } finally { f.db.close(); }
});

test('Initial context cannot read unrelated task objects, manufacture snapshot credit, or grow beyond its bound', () => {
  const f = sessionFixture();
  try {
    const quote = f.batch.objects.find(object => object.ref.type === 'DeliveryQuote')!.ref;
    const scoped = new OntologyPlanningSession(f.graph, owner, f.request, [], () => {}, () => {}, 'request');
    const prepared = scoped.prepareContext({ refs: [quote] });
    assert(prepared.entries.some(entry => (entry.result as any).error === 'FORBIDDEN'));
    assert(!scoped.retrievedRefs().some(ref => ref.type === quote.type && ref.id === quote.id));
    const result = f.session.call('query_ontology', { object: quote }, { origin: 'worker_context', maxOutputBytes: 10 }) as any;
    assert.equal(result.error, 'CONTEXT_NOT_INCLUDED'); assert.deepEqual(f.session.retrievedRefs(), []); assert.deepEqual(f.session.receipts()[0]!.objects, []);
    const bounded = new OntologyPlanningSession(f.graph, owner, f.request);
    const context = bounded.prepareContext({ refs: f.batch.objects.map(object => object.ref) });
    assert(context.entries.length <= 10); assert(Buffer.byteLength(JSON.stringify(context.entries)) < 85000);
    assert(bounded.receipts().length < 20);
  } finally { f.db.close(); }
});

test('Fresh context is not reused across decisions and concurrent object changes invalidate it', () => {
  const f = sessionFixture();
  try {
    const first = f.session.prepareContext(), snapshot = f.session.finish();
    const next = new OntologyPlanningSession(f.graph, owner, f.request).prepareContext();
    assert.notDeepEqual(first.receiptIds, next.receiptIds); assert.notEqual(first.digest, next.digest);
    const ref = { type: 'ServiceRequest', id: f.request.id }, current = f.graph.read(owner, ref);
    f.graph.ingest(owner, { objects: [{ ref, properties: { ...current.properties, originalGoal: 'Changed by a concurrent owner' }, expectedRevision: current.revision }] }, { kind: 'task', id: f.request.id, observedAt: new Date(f.graph.now()).toISOString() });
    assert.throws(() => validatePlanningSnapshot(f.graph, owner, f.request, snapshot, true), /changed/);
  } finally { f.db.close(); }
});

test('Cancellation during context preparation stops before opening or invoking a model', async () => {
  const f = sessionFixture(), controller = new AbortController(); let calls = 0;
  try {
    const scoped = new OntologyPlanningSession(f.graph, owner, f.request, [], () => controller.signal.throwIfAborted(), () => controller.abort());
    const model = { ontologyContextPreparation: 'worker_snapshot' as const, runStructured: async () => { calls++; throw new Error('No model after cancellation'); } };
    await assert.rejects(reasonWithOntology(model, 'Synthetic cancellation', {}, scoped, controller.signal, () => {}, 8, {}), /abort/i);
    assert.equal(calls, 0); assert.equal(scoped.receipts().length, 1);
  } finally { f.db.close(); }
});

function syntheticContextDidi() {
  const source = didiFixture(), store = new JobStore(':memory:');
  const catalog = createExecutionCatalog({ store, didi: { ...source.binding, connector: source.connector } });
  const requests: { calls: number; packet: any }[] = [];
  const step = (id: string, action: string, args: object): AgentStep => ({ id, action, argumentsJson: JSON.stringify(args), dependsOn: [], inputRefs: [] });
  const model = { ontologyContextPreparation: 'worker_snapshot' as const, runStructured: async (prompt: string) => {
    const packet = frame(prompt); requests.push({ calls: source.calls.filter(call => call.method === 'tools/call').length, packet });
    assert(!prompt.includes(syntheticKey)); assert(!prompt.includes('PRIVATE_TRACE'));
    const blocks = prompt.split('\n\n').flatMap(part => { try { return [JSON.parse(part)]; } catch { return []; } });
    const ctx = blocks.find(value => value.state?.scope) as AgentPlanningContext | undefined;
    if (!ctx) {
      const request = blocks.find(value => value.originalGoal && value.messages);
      return { output: { kind: 'final', calls: [], finalJson: JSON.stringify({ ...interpretation(request, DIDI_PROGRAM_REF.id, input), capabilityRef: DIDI_PROGRAM_REF }) }, evidence: evidence() };
    }
    const objects = packet.conversation.flatMap((entry: any) => entry.result.items ?? []);
    const observations: { ref: ObjectRef; snapshot: RideEstimateObservation }[] = objects.filter((object: any) => object.properties.snapshot).map((object: any) => ({ ref: object.ref, snapshot: object.properties.snapshot as RideEstimateObservation }));
    const estimate = observations.find((object: any) => object.snapshot.data.kind === 'estimate');
    let chosen: AgentDecision;
    if (estimate) chosen = { kind: 'complete', requestRevision: ctx.request.revision, message: 'Synthetic model selected actual returned quote', steps: [], completionJson: JSON.stringify({ observation: estimate.ref, rationale: 'Source estimates only' }) };
    else if (!observations.length) chosen = { kind: 'execute', requestRevision: ctx.request.revision, message: 'Synthetic model chose its own independent frontier and order', steps: [step('destination_first', 'SearchDidiPlaces', { scope: ctx.state.scope, role: 'destination', keywords: input.destination }), step('origin_second', 'SearchDidiPlaces', { scope: ctx.state.scope, role: 'origin', keywords: input.origin })], completionJson: '' };
    else {
      const from = observations.find((object: any) => object.snapshot.actionInput.role === 'origin')!, to = observations.find((object: any) => object.snapshot.actionInput.role === 'destination')!;
      if (from.snapshot.data.kind !== 'places' || to.snapshot.data.kind !== 'places') throw new Error('Invalid fixture source');
      chosen = { kind: 'execute', requestRevision: ctx.request.revision, message: 'Synthetic model selected exact non-first source candidates', steps: [step('estimate_after_sources', 'EstimateDidiRide', { scope: ctx.state.scope, originObservation: from.ref, originPlaceId: from.snapshot.data.places.find(place => place.name === input.origin)!.id, destinationObservation: to.ref, destinationPlaceId: to.snapshot.data.places.find(place => place.name === input.destination)!.id })], completionJson: '' };
    }
    return { output: { kind: 'final', calls: [], finalJson: JSON.stringify(chosen) }, evidence: evidence() };
  } };
  const b = backend(catalog, new CodexReasoner(model), store);
  return { ...source, store, b, requests, close: () => { store.close(); source.close(); } };
}

test('Four synthetic decisions independently choose tools and only complete after source data and separate host validation', async () => {
  const f = syntheticContextDidi();
  try {
    const task = f.b.submit({ goal: 'Only the synthetic route estimate; no order or payment' });
    let job = task; for (let i = 0; i < 4; i++) job = await f.b.run();
    assert.equal(job.state, 'completed', JSON.stringify(job.delegation?.agent?.feedback)); assert(job.delegation!.acceptance!.accepted);
    assert.equal(f.requests.length, 4); assert.deepEqual(f.requests.map(request => request.calls), [0, 0, 2, 3]);
    assert.equal(job.runs!.length, 4); assert(job.runs!.every(run => run.ontologyContext));
    assert.equal(job.delegation!.agent!.plans.length, 2); assert.equal(job.delegation!.agent!.completion!.modelDecision.kind, 'complete');
    assert(job.delegation!.agent!.plans.every(plan => plan.ontologyPlanning.mode === 'worker_context'));
    assert(job.delegation!.ontologyReads!.every(read => read.origin === 'worker_context'));
    assert.deepEqual(f.calls.filter(call => call.method === 'tools/call').map(call => call.name), ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    assert.equal(f.calls.find(call => call.name === 'taxi_estimate')!.args!.from_name, input.origin);
    assert(job.artifact!.data.deliverable.includes('73.05'));
    assert(f.store.intents(owner, task.id).every(intent => intent.effect === 'read' && intent.state === 'effect_confirmed'));
    for (const type of ['Order', 'Payment', 'RideTrip']) assert.equal(f.store.ontology.query(owner, { type }).items.length, 0);
  } finally { f.close(); }
});

test('Context evaluation retains expired source status and prevents dispatch even if a model proposes it', async () => {
  const f = syntheticContextDidi();
  try {
    const task = f.b.submit(); await f.b.run(); await f.b.run();
    const now = f.store.ontology.now; Object.defineProperty(f.store.ontology, 'now', { value: () => now() + 300001 });
    const rejected = await f.b.run();
    assert.notEqual(rejected.state, 'completed'); assert(rejected.delegation!.agent!.feedback.some(feedback => feedback.kind === 'validation'));
    assert.equal(f.calls.filter(call => call.method === 'tools/call').length, 2);
    const evaluations = f.requests.at(-1)!.packet.conversation.filter((entry: any) => entry.call.tool === 'evaluate_ontology');
    assert(evaluations.length && evaluations.every((entry: any) => entry.result.status === 'unknown'));
    assert(f.store.intents(owner, task.id).every(intent => intent.effect === 'read'));
  } finally { f.close(); }
});
