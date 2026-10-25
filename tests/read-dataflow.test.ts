// Synthetic model/source tests; live timing is recorded separately.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest } from '../packages/core/delegation.js';
import type { AgentStep } from '../packages/ontology/agent-actions.js';
import { didiDataflow, dataflowCompletion } from './fixtures/didi-dataflow.js';
import { dataflowValue } from '../packages/coordinator/read-dataflow.js';
import { chooseDidi, input, observeDidi, setupDidi } from './fixtures/didi.js';
import { owner, principal } from './backend-fixture.js';

const choice: Parameters<typeof setupDidi>[0] = (ctx, access) => {
  observeDidi(ctx, access);
  return { kind: 'execute', requestRevision: ctx.request.revision, message: 'Model chooses this graph and its future evidence binding', steps: didiDataflow(ctx.state.scope), completionJson: '', plannedCompletion: dataflowCompletion };
};

test('Selected pure derivations bind non-first real sources, and planned completion has post-source host evidence', async () => {
  const t = setupDidi(choice);
  try {
    const job = t.b.submit(), done = await t.finish(job.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.equal(done.runs!.filter(r => r.purpose !== 'goal_coverage').length, 2, 'Grounding plus one selected graph; no extra result-interpretation model');
    assert.equal(done.delegation!.agent!.plans.length, 1);
    assert.deepEqual(t.calls.filter(c => c.method === 'tools/call').map(c => c.name), ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    assert.equal(t.calls.find(c => c.name === 'taxi_estimate')!.args!.from_name, input.origin);
    const state = done.delegation!.agent!, proof = state.inputResolutions![0]!;
    assert.equal(proof.stepId, 'price'); assert.equal(proof.ontologyPlanning.mode, 'worker_context');
    assert(proof.ontologyPlanning.reads.every(read => read.origin === 'worker_context'));
    assert.equal(t.store.attempts(owner, proof.intentId)[0]!.inputDigest, proof.inputDigest);
    const completion = state.completion!;
    assert.equal(completion.mode, 'planned'); assert.equal(completion.modelDecision.kind, 'execute');
    assert.equal(completion.modelRunId, state.plans[0]!.modelRunId);
    assert(completion.ontologyPlanning.reads.every(read => read.origin === 'worker_context'));
    assert(completion.ontologyPlanning.reads.every(read => read.at >= done.runs!.at(-1)!.completedAt));
    assert(done.delegation!.acceptance!.accepted);
    assert.equal(state.pendingPlanId, undefined);
    assert(t.store.intents(owner, job.id).every(intent => intent.effect === 'read' && intent.state === 'effect_confirmed'));
  } finally { t.close(); }
});

test('Ambiguous deferred selection stops before an estimate and returns observations for a new model choice', async () => {
  const t = setupDidi((ctx, access) => {
    if (!ctx.state.feedback.length) return choice!(ctx, access);
    observeDidi(ctx, access);
    return { kind: 'clarify', requestRevision: ctx.request.revision, message: 'Which full address matches your endpoint?', steps: [], completionJson: '' };
  });
  try {
    t.flags.ambiguous = true;
    const job = t.b.submit(); await t.b.run(); await t.b.run();
    const pending = t.store.get(owner, job.id);
    assert.equal(pending.state, 'working'); assert(!pending.artifact);
    assert(pending.delegation!.agent!.feedback.some(feedback => feedback.message.includes('Ambiguous')));
    assert.equal(t.calls.filter(call => call.name === 'maps_textsearch').length, 2);
    assert(!t.calls.some(call => call.name === 'taxi_estimate'));
    await t.b.run(); assert.equal(t.store.get(owner, job.id).state, 'input-required');
    assert.equal(t.store.get(owner, job.id).runs!.filter(r => r.purpose !== 'goal_coverage').length, 3, 'New judgment remains a model decision');
  } finally { t.close(); }
});

for (const mutate of [
  (steps: AgentStep[]) => { steps[2]!.inputRefs[1]!.compute!.function = 'remainingQuantity'; },
  (steps: AgentStep[]) => { steps[2]!.inputRefs[1]!.compute!.path = ['notDeclared']; },
  (steps: AgentStep[]) => { steps[2]!.inputRefs[1]!.stepId = 'to'; },
  (steps: AgentStep[]) => { steps[2]!.dependsOn = ['from']; },
]) test('An undeclared derivation or mismatched source cannot dispatch any selected graph', async () => {
  const t = setupDidi((ctx, access) => { const decision = choice!(ctx, access); mutate(decision.steps); return decision; });
  try {
    const job = t.b.submit(); await t.b.run(); await t.b.run();
    assert.equal(t.calls.filter(call => call.method === 'tools/call').length, 0);
    assert(t.store.get(owner, job.id).delegation!.agent!.feedback.some(feedback => feedback.kind === 'validation'));
  } finally { t.close(); }
});

test('A premature evidence binding cannot turn a place observation into a completed estimate', async () => {
  const t = setupDidi((ctx, access) => {
    const decision = choice!(ctx, access); decision.steps = decision.steps.slice(0, 2);
    decision.plannedCompletion = { ...dataflowCompletion, inputRefs: [{ stepId: 'from', targetKey: 'observation' }] };
    return decision;
  });
  try {
    const job = t.b.submit(); await t.b.run(); await t.b.run();
    const current = t.store.get(owner, job.id);
    assert.equal(current.state, 'working'); assert(!current.artifact); assert(!current.delegation!.acceptance);
    assert(current.delegation!.agent!.feedback.some(feedback => feedback.kind === 'completion'));
  } finally { t.close(); }
});

test('An unmet hard outcome still blocks planned completion', async () => {
  const t = setupDidi(choice);
  try {
    const job = t.b.submit({ requirements: [{ id: 'different-origin', kind: 'location', role: 'origin', strength: 'hard', expected: { ref: '北京东站' } }] });
    await t.b.run(); await t.b.run();
    const current = t.store.get(owner, job.id);
    assert.notEqual(current.state, 'completed'); assert(!current.artifact);
    assert(current.delegation!.agent!.feedback.some(feedback => feedback.message.includes('hard requested outcome')));
  } finally { t.close(); }
});

test('Cancellation during selected dataflow reads prevents estimate, binding acceptance and completion', async () => {
  const t = setupDidi(choice);
  try {
    const job = t.b.submit(); await t.b.run();
    t.flags.before = async () => { t.b.tasks.cancel(principal, job.id); };
    await t.b.run();
    const current = t.store.get(owner, job.id);
    assert.equal(current.state, 'canceled'); assert(!current.artifact);
    assert(!t.calls.some(call => call.name === 'taxi_estimate'));
    assert(!current.delegation!.agent!.inputResolutions?.length);
  } finally { t.close(); }
});

test('A persisted selected graph resumes after claim handoff without another model choice or duplicate reads', async () => {
  const t = setupDidi(choice);
  try {
    const job = t.b.submit(); await t.b.run();
    const checkpoint = t.store.checkpoint.bind(t.store);
    t.store.checkpoint = (claim, update) => {
      const saved = checkpoint(claim, update);
      return t.store.get(owner, job.id).delegation!.agent!.pendingPlanId ? false : saved;
    };
    const first = t.store.claim(['eigos.delegate'], 15000)!;
    await t.b.coordinator.run(first, new AbortController().signal);
    t.store.checkpoint = checkpoint; t.store.release(first);
    const pinned = t.store.get(owner, job.id).delegation!.agent!.plans[0]!;
    assert.equal(t.calls.filter(call => call.method === 'tools/call').length, 0);
    const done = await t.b.run();
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation!.agent!.feedback));
    assert.equal(done.runs!.filter(r => r.purpose !== 'goal_coverage').length, 2);
    assert.equal(done.delegation!.agent!.plans[0]!.digest, pinned.digest);
    assert.equal(t.calls.filter(call => call.method === 'tools/call').length, 3);
  } finally { t.close(); }
});

test('The model may retain its staged choices and explicit completion instead of selecting a dataflow', async () => {
  const t = setupDidi(chooseDidi);
  try { const job = t.b.submit(), done = await t.finish(job.id); assert.equal(done.state, 'completed'); assert.equal(done.runs!.filter(r => r.purpose !== 'goal_coverage').length, 4); assert.equal(done.delegation!.agent!.completion!.mode, undefined); }
  finally { t.close(); }
});

test('A model-selected place-only graph completes from one search and never adds an estimate', async () => {
  const t = setupDidi((ctx, access) => {
    observeDidi(ctx, access);
    return { kind: 'execute', requestRevision: ctx.request.revision, message: 'Only search is relevant to this goal', completionJson: '',
      steps: [{ id: 'search', action: 'SearchDidiPlaces', argumentsJson: JSON.stringify({ scope: ctx.state.scope, role: 'search', keywords: input.origin }), dependsOn: [], inputRefs: [] }],
      plannedCompletion: { argumentsJson: JSON.stringify({ rationale: 'Return the source candidate list only' }), inputRefs: [{ stepId: 'search', targetKey: 'observation' }] } };
  }, { mode: 'places', city: input.city, keywords: input.origin });
  try {
    const job = t.b.submit(), done = await t.finish(job.id);
    assert.equal(done.state, 'completed');
    assert.equal(t.calls.filter(call => call.method === 'tools/call').length, 1);
    assert(!t.calls.some(call => call.name === 'taxi_estimate'));
    assert.equal(done.delegation!.agent!.completion!.mode, 'planned');
  } finally { t.close(); }
});

test('An address mentioned elsewhere in the request cannot override the selected endpoint role', async () => {
  const t = setupDidi(choice);
  try {
    const job = t.b.submit({ goal: '只查北京西站到西二旗地铁站。另有无关地址：非目标地点地点1号。' });
    const done = await t.finish(job.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    const estimate = t.calls.find(call => call.name === 'taxi_estimate')!;
    assert.equal(estimate.args!.from_name, input.origin);
    assert.equal(estimate.args!.to_name, input.destination);
  } finally { t.close(); }
});

for (const mode of ['empty', 'wrong_city', 'single_mismatch'] as const) test(`Deferred selection keeps ${mode} source facts unresolved`, async () => {
  const t = setupDidi(choice);
  try {
    if (mode === 'empty') t.flags.empty = true;
    else t.flags.transform = (body, request) => {
      if (request.method === 'tools/call' && request.params.name === 'maps_textsearch') {
        const places = JSON.parse(body.result.content[0].text);
        if (mode === 'wrong_city') for (const place of places) place.city = '上海市';
        body.result.content[0].text = JSON.stringify(mode === 'single_mismatch' ? places.slice(0, 1) : places);
      }
      return body;
    };
    const job = t.b.submit(); await t.b.run(); await t.b.run();
    assert(!t.calls.some(call => call.name === 'taxi_estimate'));
    const current = t.store.get(owner, job.id);
    assert(!current.artifact); assert(current.delegation!.agent!.feedback.some(feedback => feedback.kind === 'validation'));
  } finally { t.close(); }
});

test('Output paths preserve literal data and require an actual own field', () => {
  assert.equal(dataflowValue({ value: null }, ['value']), null);
  assert.throws(() => dataflowValue({}, ['constructor']));
  assert.equal(digest(dataflowValue({ value: { id: 'actual' } }, ['value'])), digest({ id: 'actual' }));
});
