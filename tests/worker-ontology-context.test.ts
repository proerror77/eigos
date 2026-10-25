import { syntheticGoalReview } from './backend-fixture.js';
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
import { backend, evidence, interpretation, owner, principal } from './backend-fixture.js';
import { didiDataflow, dataflowCompletion } from './fixtures/didi-dataflow.js';
import { didiFixture, input, syntheticKey } from './fixtures/didi.js';
import { DIDI_PROGRAM_REF } from '../packages/capabilities/didi/program.js';
import type { AgentDecision, AgentStep } from '../packages/ontology/agent-actions.js';
import type { AgentPlanningContext } from '../packages/coordinator/coordinator.js';
import type { RideEstimateObservation } from '../packages/ontology/ride-estimate.js';
import type { ObjectRef } from '../packages/ontology/model.js';
import { planningSnapshot } from '../packages/ontology/planning-contract.js';
import { expandPromptData, SessionPromptData, expandSessionPromptData } from '../packages/coordinator/prompt-data.js';
import { verifyInitialPlan } from '../packages/coordinator/initial-selection.js';

function sessionFixture() {
  const data = drillCase('QD-1'), db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, undefined, () => data.now, undefined, {skipLegacyMigration:true});
  graph.ingest(owner, data.batch, data.source);
  return { ...data, db, graph, session: new OntologyPlanningSession(graph, owner, data.request) };
}
const frame = (prompt: string) => expandPromptData(JSON.parse(prompt.split('\n\n').at(-1)!));

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

test('Initial definitions omit broad relationship navigation; model can retrieve it while action dependencies remain intact', () => {
  const f = sessionFixture();
  try {
    const context = f.session.prepareContext({ actions: ['EstimateDidiRide'] });
    const initial = context.entries[0]!.result as any;
    assert.equal(initial.types[0].links, undefined); assert.equal(initial.types[0].linksAvailable, true);
    assert.equal(initial.actions[0].read.mcp.requires.length, 2);
    const expanded = f.session.call('describe_ontology', { search: 'ServiceRequest', limit: 1, actions: [], functions: [] }) as any;
    assert(expanded.types[0].links.length > 0);
    assert.equal(f.session.receipts().at(-1)!.origin, 'model');
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

function syntheticContextDidi(initial: false | 'valid' | 'bad_binding' | 'dependent' | 'dataflow' = false, reuse = false) {
  const source = didiFixture(), store = new JobStore(':memory:');
  const catalog = createExecutionCatalog({ store, didi: { ...source.binding, connector: source.connector } });
  const requests: { calls: number; packet: any }[] = [];
  const step = (id: string, action: string, args: object): AgentStep => ({ id, action, argumentsJson: JSON.stringify(args), dependsOn: [], inputRefs: [] });
  const dictionary: unknown[] = [], encoder = new SessionPromptData(), keys: (string | undefined)[] = [];
  const model = { ontologyContextPreparation: 'worker_snapshot' as const, runStructured: async (prompt: string) => {
    const packet = reuse ? expandSessionPromptData(JSON.parse(prompt.split('\n\n').at(-1)!), dictionary) : frame(prompt);
    requests.push({ calls: source.calls.filter(call => call.method === 'tools/call').length, packet });
    assert(!prompt.includes(syntheticKey)); assert(!prompt.includes('PRIVATE_TRACE'));
    const blocks = [packet.task];
    const ctx = blocks.find(value => value.state?.scope) as AgentPlanningContext | undefined;
    if (!ctx) {
      const request = packet.task.request;
      const initialSteps = initial === 'dataflow' ? didiDataflow().map(step => ({ ...step, scopeInputs: ['scope'] })) : initial ? [
        { id: 'chosen_destination', action: initial === 'dependent' ? 'EstimateDidiRide' : 'SearchDidiPlaces', argumentsJson: JSON.stringify({ role: 'destination', keywords: input.destination }), scopeInputs: [initial === 'bad_binding' ? 'notTheScope' : 'scope'] },
        { id: 'chosen_origin', action: 'SearchDidiPlaces', argumentsJson: JSON.stringify({ role: 'origin', keywords: input.origin }), scopeInputs: ['scope'] },
      ] : undefined;
      return { output: { kind: 'final', calls: [], finalJson: JSON.stringify({ ...interpretation(request, DIDI_PROGRAM_REF.id, input), capabilityRef: DIDI_PROGRAM_REF, ...(initialSteps ? { initialSteps } : {}), ...(initial === 'dataflow' ? { plannedCompletion: dataflowCompletion } : {}) }) }, evidence: evidence() };
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
  if (reuse) Object.assign(model, { openStructuredSession: async (_schema: object, _signal: AbortSignal, key?: string) => {
    keys.push(key);
    return { packData: (data: unknown) => encoder.pack(data), run: (prompt: string) => model.runStructured(prompt), close: async () => {} };
  } });
  const b = backend(catalog, Object.assign(new CodexReasoner(model), { reviewGoal: syntheticGoalReview }), store);
  return { ...source, store, catalog, b, requests, keys, close: () => { store.close(); source.close(); } };
}

test('Same-task conversation reuse still obtains fresh reads for every autonomous choice and independently validates completion', async () => {
  const f = syntheticContextDidi('valid', true);
  try {
    f.b.submit(); await f.b.run(); await f.b.run(); const done = await f.b.run();
    assert.equal(done.state, 'completed', JSON.stringify({ feedback: done.delegation?.agent?.feedback, recovery: done.delegation?.recovery, error: done.error })); assert(done.delegation!.acceptance!.accepted);
    assert.equal(f.keys.length, 3); assert(f.keys[0]); assert.equal(new Set(f.keys).size, 1);
    assert.deepEqual(f.requests.map(request => request.calls), [0, 2, 3]);
    const contexts = done.runs!.filter(r => r.purpose !== 'goal_coverage').map(run => run.ontologyContext!);
    assert.equal(new Set(contexts.map(context => context.digest)).size, 3);
    assert.equal(new Set(contexts.flatMap(context => context.receiptIds)).size, contexts.flatMap(context => context.receiptIds).length);
    assert(done.runs!.filter(r => r.purpose !== 'goal_coverage').every(run => run.promptData?.encoding === 'session-json-v1'));
    const packing=done.runs!.filter(r => r.purpose !== 'goal_coverage')[2]!.promptData!;
    assert((packing.reusedValues ?? 0)>0, 'The same-task dictionary actually reuses exact values');
    assert(packing.encodedBytes<packing.sourceBytes, 'Lossless session packing reduces this repeated context without relying on one kernel-specific ratio');
    const base = new OntologyPlanningSession(f.store.ontology, owner, done.delegation!.request).modelSessionKey();
    assert.notEqual(new OntologyPlanningSession(f.store.ontology, 'different-owner', done.delegation!.request).modelSessionKey(), base);
    assert.notEqual(new OntologyPlanningSession(f.store.ontology, owner, { ...done.delegation!.request, revision: done.delegation!.request.revision + 1 }).modelSessionKey(), base);
  } finally { f.close(); }
});

test('A real initial model choice merges interpretation and independent tool selection; scope reads are honestly after the model and before dispatch', async () => {
  const f = syntheticContextDidi('valid');
  try {
    const task = f.b.submit({ goal: 'Synthetic exact route only; no order or payment' });
    const first = await f.b.run();
    assert.equal(f.requests.length, 1); assert.equal(first.runs!.filter(r => r.purpose !== 'goal_coverage').length, 1);
    assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 2, JSON.stringify({ state: first.state, feedback: first.delegation?.agent?.feedback, recovery: first.delegation?.recovery, events: first.delegation?.events.slice(-3) }));
    const plan = first.delegation!.agent!.plans[0]!;
    assert(plan.initialSelection); assert.equal(plan.modelRunId, first.runs![0]!.id);
    assert.deepEqual(plan.steps.map(step => step.id), ['chosen_destination', 'chosen_origin']);
    assert(plan.ontologyPlanning.reads.every(read => read.at >= first.runs![0]!.completedAt));
    assert(plan.initialSelection.groundingPlanning.reads.every(read => read.at <= first.runs![0]!.startedAt));
    assert(first.runs![0]!.ontologyContext!.receiptIds.every(id => plan.initialSelection!.groundingPlanning.reads.some(read => read.id === id)));
    assert(!first.runs![0]!.ontologyContext!.receiptIds.some(id => plan.ontologyPlanning.reads.some(read => read.id === id)));
    let done = await f.b.run(); done = await f.b.run();
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation!.agent!.feedback));
    assert.equal(done.runs!.filter(r => r.purpose !== 'goal_coverage').length, 3); assert.deepEqual(f.requests.map(request => request.calls), [0, 2, 3]);
    assert(done.delegation!.acceptance!.accepted); assert.equal(done.delegation!.agent!.completion!.modelDecision.kind, 'complete');
    assert(f.store.intents(owner, task.id).every(intent => intent.effect === 'read' && intent.state === 'effect_confirmed'));
    const program = f.catalog.agentProgram(DIDI_PROGRAM_REF, owner)!;
    verifyInitialPlan(done, f.store.ontology, program, plan);
    const altered = structuredClone(plan); assert(altered.modelDecision); altered.modelDecision.steps[0]!.argumentsJson = '{}';
    assert.throws(() => verifyInitialPlan(done, f.store.ontology, program, altered), /differs/);
    const invented = structuredClone(plan); invented.initialSelection!.definitionActions = [];
    assert.throws(() => verifyInitialPlan(done, f.store.ontology, program, invented), /definitions/);
  } finally { f.close(); }
});

for (const invalid of ['bad_binding', 'dependent'] as const) test(`Invalid initial ${invalid} never dispatches and returns selection to a fresh model decision`, async () => {
  const f = syntheticContextDidi(invalid);
  try {
    f.b.submit(); const rejected = await f.b.run();
    assert.equal(f.calls.filter(call => call.method === 'tools/call').length, 0);
    assert.equal(f.store.intents(owner, rejected.id).length, 0);
    assert.equal(rejected.delegation!.agent!.initialSelectionPending, undefined);
    assert.equal(rejected.delegation!.agent!.feedback[0]!.kind, 'validation');
    assert.equal((await f.b.run()).delegation!.agent!.plans.length, 1);
    assert.equal(f.requests.length, 2);
  } finally { f.close(); }
});

test('An omitted bounded initial definition returns to a fresh model decision before any dispatch',async()=>{
  const f=syntheticContextDidi('valid'),original=OntologyPlanningSession.prototype.call;
  let omitted=false;
  OntologyPlanningSession.prototype.call=function(tool,input,options){
    const initial=this.graph===f.store.ontology && f.store.get(owner,this.request.id).delegation?.agent?.initialSelectionPending;
    if(!omitted && initial && tool==='describe_ontology' && options?.origin==='worker_context') {
      omitted=true;return original.call(this,tool,input,{...options,maxOutputBytes:10});
    }
    return original.call(this,tool,input,options);
  };
  try {
    f.b.submit();const waiting=await f.b.run();
    assert(omitted);assert.equal(waiting.state,'working');
    assert.equal(waiting.delegation!.agent!.initialSelectionPending,undefined);
    assert.equal(waiting.delegation!.agent!.feedback[0]!.kind,'validation');
    assert.equal(f.store.intents(owner,waiting.id).length,0);
    assert.equal(f.calls.filter(call=>call.method==='tools/call').length,0);
    assert.equal((await f.b.run()).delegation!.agent!.plans.length,1);
    assert.equal(f.requests.length,2);
  }finally{OntologyPlanningSession.prototype.call=original;f.close();}
});

for (const stop of ['handoff', 'cancel'] as const) test(`Initial selection survives a clean ${stop} boundary without another model call or a late source dispatch`, async () => {
  const f = syntheticContextDidi('valid'), checkpoint = f.store.checkpoint.bind(f.store); let stopped = false;
  f.store.checkpoint = (claim, write) => {
    const saved = checkpoint(claim, write);
    if (saved && !stopped && f.store.get(owner, claim.job.id).delegation?.agent?.initialSelectionPending) {
      stopped = true;
      if (stop === 'cancel') f.b.tasks.cancel(principal, claim.job.id);
      else f.store.finish(claim, () => {});
    }
    return saved;
  };
  try {
    const task = f.b.submit(); const paused = await f.b.run();
    assert(stopped); assert.equal(f.requests.length, 1); assert.equal(f.calls.filter(call => call.method === 'tools/call').length, 0);
    if (stop === 'cancel') assert.equal(paused.state, 'canceled');
    else {
      const resumed = await f.b.run(); assert.equal(f.requests.length, 1);
      assert.equal(resumed.delegation!.agent!.plans[0]!.modelRunId, paused.runs![0]!.id);
      assert.equal(f.calls.filter(call => call.method === 'tools/call').length, 2);
      assert.equal(f.store.get(owner, task.id).delegation!.agent!.initialSelectionPending, undefined);
    }
  } finally { f.close(); }
});

test('Four synthetic decisions independently choose tools and only complete after source data and separate host validation', async () => {
  const f = syntheticContextDidi();
  try {
    const task = f.b.submit({ goal: 'Only the synthetic route estimate; no order or payment' });
    let job = task; for (let i = 0; i < 4; i++) job = await f.b.run();
    assert.equal(job.state, 'completed', JSON.stringify(job.delegation?.agent?.feedback)); assert(job.delegation!.acceptance!.accepted);
    assert.equal(f.requests.length, 4); assert.deepEqual(f.requests.map(request => request.calls), [0, 0, 2, 3]);
    assert.equal(job.runs!.filter(r => r.purpose !== 'goal_coverage').length, 4); assert(job.runs!.filter(r => r.purpose !== 'goal_coverage').every(run => run.ontologyContext));
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


test('One grounding model response can choose a dynamic read graph and a conditional future evidence binding', async () => {
  const f = syntheticContextDidi('dataflow', true);
  try {
    const job = f.b.submit(); const done = await f.b.run();
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.equal(f.requests.length, 1); assert.equal(done.runs!.filter(r => r.purpose !== 'goal_coverage').length, 1);
    assert.equal(f.requests[0]!.calls, 0, 'The model has no future provider facts');
    assert.equal(f.calls.filter(call => call.method === 'tools/call').length, 3);
    const state = done.delegation!.agent!, plan = state.plans[0]!;
    assert(plan.initialSelection); verifyInitialPlan(done, f.store.ontology, f.catalog.agentProgram(DIDI_PROGRAM_REF, owner)!, plan);
    assert.equal(plan.steps[2]!.inputRefs[1]!.compute!.function, 'selectDidiPlace');
    assert.equal(state.completion!.mode, 'planned');
    const preModelReads = new Set(done.runs![0]!.ontologyContext!.receiptIds);
    for (const proof of [state.inputResolutions![0]!.ontologyPlanning, state.completion!.ontologyPlanning]) {
      assert(proof.reads.every(read => read.origin === 'worker_context' && !preModelReads.has(read.id)));
    }
    assert.equal(state.completion!.modelRunId, done.runs![0]!.id);
    assert.equal(f.store.get(owner, job.id).delegation!.acceptance!.accepted, true);
  } finally { f.close(); }
});

test('A rejected model reference decoding still retains the actual response receipt before stopping', async () => {
 const f = sessionFixture(), records: any[] = [], raw = { messageId: 'unknown' }, receipt = evidence();
 try {
  const model = {ontologyContextPreparation:'worker_snapshot' as const,runStructured:async()=>({output:{kind:'final',calls:[],finalJson:JSON.stringify(raw)},evidence:receipt})};
  await assert.rejects(reasonWithOntology(model,'Synthetic malformed reference',{},f.session,new AbortController().signal,r=>records.push(r),8,{decodeFinal:{encoding:'fixed_scope_message_refs_v1',apply:()=>{throw new Error('Unknown message reference');}}}),/Unknown message/);
  assert.equal(records.length,1);assert.equal(records[0].id,receipt.id);assert.equal(records[0].decisionDigest,digest(raw));assert.equal(records[0].outputSha256,receipt.outputSha256);
 }finally{f.db.close();}
});

test('Derived request outcome and assessment updates do not invalidate a fixed planning snapshot', () => {
 const f=sessionFixture();
 try {
  f.session.prepareContext();const snapshot=f.session.finish();const ref={type:'ServiceRequest',id:f.request.id};const current=f.graph.read(owner,ref);
  f.graph.ingest(owner,{objects:[{ref,expectedRevision:current.revision,properties:{...current.properties,requestedOutcome:'changed-derived-binding',currentAssessment:{type:'OutcomeAssessment',id:'later-assessment'}}}],links:[]},f.source);
  validatePlanningSnapshot(f.graph,owner,f.request,snapshot,true);
  const updated=f.graph.read(owner,ref);f.graph.ingest(owner,{objects:[{ref,expectedRevision:updated.revision,properties:{...updated.properties,originalGoal:'A changed user goal'}}],links:[]},f.source);
  assert.throws(()=>validatePlanningSnapshot(f.graph,owner,f.request,snapshot,true),/changed/);
 }finally{f.db.close();}
});

test('An explicit literal-scope pin keeps its structured reference decoder on a native-default model', async () => {
 const f=sessionFixture();let calls=0;
 try {
  const ref={id:'fixed.fixture',version:'1'},request={...f.request,capabilityRef:ref};
  const model={ontologyTransport:'native-mcp' as const,ontologyContextPreparation:'worker_snapshot' as const,runStructured:async(_prompt:string,_schema:object,_signal:AbortSignal,options?:unknown)=>{
    calls++;assert.equal(options,undefined,'Fixed program must not open native discovery');
    const raw={kind:'clarify',requestRevision:request.revision,capabilityRef:{id:'none',version:'none'},message:'Synthetic transport selection',inputJson:'{}',requirementsJson:'[]',conditionsJson:'[]',scopeReview:{requestRevision:request.revision,verdict:'clarify',message:'Synthetic scope boundary',clauses:request.messages.map(m=>({messageId:m.id,disposition:'uncovered',inputKeys:[],requirementIds:[],conditionIds:[],reason:'No source action requested'}))}};
    return {output:{kind:'final',calls:[],finalJson:JSON.stringify(raw)},evidence:evidence()};
  }};
  assert.equal(request.messages.length,1);
  const capability={ref,name:'Fixed fixture',description:'Only a fixed fixture',tags:[],inputSchema:{type:'object',additionalProperties:false,properties:{fixed:{const:true}},required:['fixed']},scopeReviewMode:'registered_fixed_input' as const,predicates:[],outcomePredicates:[],requirementRoles:[],locationSemantics:undefined,constraintEvaluation:undefined,sourceAuthorization:undefined};
  const result=await new CodexReasoner(model).ground(request,[capability],new AbortController().signal,{session:f.session,record:()=>{},maxTurns:8});
  assert.equal(calls,1);assert.equal(result.evidence.decisionDecoding?.encoding,'fixed_scope_message_refs_v1');assert.equal(result.decision.kind,'clarify');
 }finally{f.db.close();}
});
