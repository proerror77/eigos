// All providers are synthetic. The semantic-review transport is exercised
// independently; these tests do not measure a live model's error rate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { backend, evidence, owner, principal, syntheticGoalReview } from './backend-fixture.js';
import { chooseDidi, didiModel, observeDidi, setupDidi } from './fixtures/didi.js';
import { CodexReasoner } from '../packages/coordinator/coordinator.js';
import { digest } from '../packages/core/delegation.js';
import { assertGoalCoverage, validateGoalReview } from '../packages/ontology/goal-coverage.js';
import { boundAgentAction } from '../packages/core/agent-action-binding.js';
import type { ObjectRef } from '../packages/ontology/model.js';

test('Independent review rejects wrong-city interpretation before any provider call and exposes the gap in Ontology', async () => {
  const t = setupDidi(); let reviews = 0;
  const reviewer = new CodexReasoner({ runStructured: async prompt => {
    const ctx = JSON.parse(prompt.split('\n\n').at(-1)!);
    assert.match(ctx.request.originalGoal, /上海/); assert.equal(ctx.input.city, '北京市'); reviews++;
    assert(!('groundingDecisions' in ctx));
    const synthetic = await syntheticGoalReview(ctx);
    synthetic.decision.verdict = 'clarify'; synthetic.decision.message = '你的目标是上海路线，当前解释成了北京路线，请确认原路线。';
    synthetic.decision.clauses = synthetic.decision.clauses.map(c => ({ ...c, disposition: 'conflict', inputKeys: [], requirementIds: [], conditionIds: [] }));
    return { output: synthetic.decision, evidence: evidence() };
  } });
  const b = backend(t.catalog, { ...didiModel(), reviewGoal: reviewer.reviewGoal.bind(reviewer) }, t.store);
  try {
    const job = b.submit({ goal: '只查询上海虹桥站到上海浦东机场的滴滴估价，不查询北京。' });
    const pending = await b.run();
    assert.equal(pending.state, 'input-required'); assert.equal(reviews, 1); assert.equal(t.calls.length, 0); assert(!pending.artifact);
    const coverage = t.store.ontology.related(owner, { type: 'ServiceRequest', id: job.id }, 'goalCoverage', { remaining: 1000 })!;
    assert.equal(coverage.length, 1); assert.equal((coverage[0]!.properties.review as { verdict: string }).verdict, 'clarify');
    const assessment = t.store.ontology.read(owner, t.store.ontology.read(owner, { type: 'ServiceRequest', id: job.id }).properties.currentAssessment as ObjectRef);
    assert.equal(assessment.properties.judgment, 'needs_human');
    assert.equal(pending.runs!.filter(r => r.purpose === 'goal_coverage').length, 1);
  } finally { t.close(); }
});

test('Omitted request text, missing criterion mappings and unknown fields cannot pass a covered review', async () => {
  const t = setupDidi();
  try {
    const job = t.b.submit({ goal: '查估价，不下单。', requirements: [{ id: 'origin', kind: 'location', role: 'origin', strength: 'hard', expected: { ref: '北京西站' } }] });
    await t.b.run(); const current = t.store.get(owner, job.id), d = current.delegation!;
    const ctx = { request: d.request, capability: t.catalog.capability(d.agent!.programRef), input: d.agent!.input };
    const valid = (await syntheticGoalReview(ctx)).decision;
    const omitted = structuredClone(valid); omitted.clauses[0]!.quote = '查估价，';
    assert.throws(() => validateGoalReview(ctx, omitted), /omitted or changed/);
    const criterion = structuredClone(valid); criterion.clauses[0]!.requirementIds = [];
    assert.throws(() => validateGoalReview(ctx, criterion), /acceptance criterion/);
    const keys = structuredClone(valid); keys.clauses[0]!.inputKeys.push('invented');
    assert.throws(() => validateGoalReview(ctx, keys), /unknown input/);
    const allContext = structuredClone(valid); allContext.clauses[0] = { ...allContext.clauses[0]!, disposition: 'context', inputKeys: [], requirementIds: [] };
    assert.throws(() => validateGoalReview(ctx, allContext), /unresolved goal/);
    const mutated = structuredClone(current); mutated.delegation!.agent!.input.city = '上海市';
    assert.throws(() => assertGoalCoverage(mutated, ctx.capability), /differs from the reviewed goal/);
  } finally { t.close(); }
});

test('A Worker without a goal reviewer fails closed instead of restoring the old completion hole', async () => {
  const t = setupDidi(), model = didiModel(); model.reviewGoal = undefined;
  try {
    const b = backend(t.catalog, model, t.store); b.submit();
    await assert.rejects(b.run(), /no independent goal coverage reviewer/); assert.equal(t.calls.length, 0);
  } finally { t.close(); }
});

test('A completed task has an owned coverage → assessment → feedback chain and records all model calls', async () => {
  const t = setupDidi();
  try {
    const job = t.b.submit({ goal: '查询北京西站到西二旗地铁站的估价。' }), done = await t.finish(job.id);
    assert.equal(done.state, 'completed'); assert.equal(done.runs!.length, 5);
    const request = t.store.ontology.read(owner, { type: 'ServiceRequest', id: job.id });
    assert.equal(request.properties.requestedOutcome, 'ride.estimate.query'); assert.equal(request.properties.projectionState, 'typed_result');
    const outcome = t.store.ontology.read(owner, request.properties.currentAssessment as ObjectRef);
    assert.equal(outcome.properties.judgment, 'satisfied'); assert.equal(outcome.properties.evidenceLevel, 'synthetic');
    const evaluated = t.store.ontology.evaluate(owner, { function: 'taskOutcomeStatus', object: request.ref });
    assert.equal(evaluated.status, 'known'); assert.equal((evaluated.value as { status: string }).status, 'satisfied');
    assert.deepEqual(outcome.properties.evidenceRefs, done.delegation!.acceptance!.evidenceRefs);
    const sourceReceipts = t.store.ontology.related(owner, outcome.ref, 'sourceReceipts', { remaining: 1000 })!;
    assert.equal(sourceReceipts.length, 1); assert.equal(sourceReceipts[0]!.properties.evidenceLevel, 'synthetic');
    const coverage = t.store.ontology.related(owner, outcome.ref, 'goalCoverage', { remaining: 1000 })!;
    assert.equal(coverage[0]!.properties.digest, done.delegation!.goalCoverage!.digest);
    const feedback = t.store.ontology.related(owner, request.ref, 'executionFeedback', { remaining: 1000 })!;
    assert.equal(feedback.length, 1); assert.equal(feedback[0]!.properties.judgment, 'satisfied');
    assert.equal(t.store.ontology.related(owner, feedback[0]!.ref, 'assessment', { remaining: 1000 })![0]!.ref.id, outcome.ref.id);
    const ref = done.delegation!.agent!.programRef, config = done.delegation!.agent!.programDigest;
    const facts = t.store.capabilityFacts(owner, ref);
    assert.equal(facts.verifications.length, 1); assert.equal(t.store.providerEvidenceView(owner, ref, config).sampleCount, 1);
    assert.equal(t.store.providerEvidenceView(owner, ref, 'wrong-configuration').sampleCount, 0);
    assert.equal(t.store.providerEvidenceView('other-owner', ref).sampleCount, 0);
    assert.throws(() => t.store.ontology.read('other-owner', outcome.ref), /not found/);
    t.store.save(owner, done); assert.equal(t.store.capabilityFacts(owner, ref).verifications.length, 1, 'Repeated readback cannot create extra success samples');
  } finally { t.close(); }
});

test('Clarification re-reviews the revised goal while preserving prior coverage and assessments', async () => {
  const t = setupDidi((ctx, access) => {
    if (ctx.request.revision !== 1 || !ctx.state.observations.length) return chooseDidi(ctx, access);
    observeDidi(ctx, access); return { kind: 'clarify', requestRevision: 1, message: '请确认路线。', steps: [], completionJson: '' };
  });
  try {
    const job = t.b.submit(); await t.b.run(); await t.b.run(); await t.b.run();
    const old = t.store.get(owner, job.id).delegation!.goalCoverage!;
    t.b.tasks.reply(principal, { taskId: job.id, requestId: randomUUID(), answer: '确认北京西站到西二旗。' });
    assert.equal(t.store.ontology.read(owner, { type: 'ServiceRequest', id: job.id }).properties.projectionState, 'request_only');
    const done = await t.finish(job.id); assert.equal(done.state, 'completed'); assert.equal(done.delegation!.goalCoverage!.requestRevision, 2);
    assert.notEqual(done.delegation!.goalCoverage!.digest, old.digest);
    assert(t.store.ontology.related(owner, { type: 'ServiceRequest', id: job.id }, 'goalCoverage', { remaining: 1000 })!.some(o => o.ref.id === old.digest));
    assert.equal(done.runs!.filter(r => r.purpose === 'goal_coverage').length, 2);
  } finally { t.close(); }
});

test('Cancellation and late source results never overwrite the unknown assessment or become positive feedback', async () => {
  const t = setupDidi();
  try {
    const job = t.b.submit(); await t.b.run(); t.flags.before = async () => { t.b.tasks.cancel(principal, job.id); };
    await t.b.run(); const canceled = t.store.get(owner, job.id);
    assert.equal(canceled.state, 'canceled'); assert.equal(canceled.delegation!.outcome!.status, 'unknown');
    assert.equal(canceled.delegation!.agent!.observations.length, 0);
    const feedback = t.store.providerFeedback(owner, canceled.delegation!.agent!.programRef) as { taskState: string; outcome: string }[];
    assert.equal(feedback[0]!.taskState, 'canceled'); assert.equal(feedback[0]!.outcome, 'unknown');
    assert(!(t.store.capabilityFacts(owner, canceled.delegation!.agent!.programRef).verifications as { result: string }[]).some(v => v.result === 'passed'));
  } finally { t.close(); }
});

test('Outcome projection failure rolls back completed Task, graph and feedback together', async () => {
  const t = setupDidi();
  try {
    const job = t.b.submit(); await t.b.run(); await t.b.run(); await t.b.run();
    const ingest = t.store.ontology.ingest.bind(t.store.ontology);
    t.store.ontology.ingest = (who, batch, source) => {
      if (batch.objects.some(o => o.ref.type === 'OutcomeAssessment' && o.properties.judgment === 'satisfied')) throw new Error('Synthetic projection outage');
      return ingest(who, batch, source);
    };
    await t.b.run(); const current = t.store.get(owner, job.id);
    assert.notEqual(current.state, 'completed'); assert(!current.artifact); assert(!current.delegation!.acceptance);
    assert(!(t.store.capabilityFacts(owner, current.delegation!.agent!.programRef).verifications as { result: string }[]).some(v => v.result === 'passed'));
  } finally { t.close(); }
});

test('Registered Actions, not a mutable program allowlist, fix executable effect, schema and version', () => {
  const t = setupDidi();
  try {
    const program = t.catalog.agentProgram({ id: 'ride.estimate.query', version: '1' }, owner)!;
    assert.equal(boundAgentAction(t.store.ontology, program, 'SearchDidiPlaces').read!.effect, 'read');
    assert.throws(() => boundAgentAction(t.store.ontology, program, 'SubmitFreeRegistration'), /Program binding/);
    const capability = program.capability.bind(program);
    program.capability = () => ({ ...capability(), actions: capability().actions.map(a => ({ ...a, effect: 'payment' })) });
    assert.throws(() => boundAgentAction(t.store.ontology, program, 'SearchDidiPlaces'), /Program binding/);
  } finally { t.close(); }
});

test('Feedback follows the current binding when a revised task changes its selected program', async () => {
  const t = setupDidi();
  try {
    const job = t.b.submit(); await t.b.run(); const current = t.store.get(owner, job.id), old = current.delegation!.agent!.programRef;
    // Exercise storage attribution independently of any connector/permission.
    const changed = structuredClone(current); changed.delegation!.agent!.programRef = { id: 'synthetic-revised-program', version: '1' };
    t.store.recordFeedback(owner, changed, 'unverified', false);
    assert.equal(t.store.providerFeedback(owner, old).length, 0);
    assert.equal(t.store.providerFeedback(owner, changed.delegation!.agent!.programRef).length, 1);
  } finally { t.close(); }
});

test('Canceled coverage review cannot publish a proof or start sources', async () => {
  const t = setupDidi(), model = didiModel(); let taskId = '';
  model.reviewGoal = async ctx => { t.b.tasks.cancel(principal, taskId); return syntheticGoalReview(ctx); };
  const b = backend(t.catalog, model, t.store);
  try {
    taskId = b.submit().id; await b.run(); const current = t.store.get(owner, taskId);
    assert.equal(current.state, 'canceled'); assert(!current.delegation!.goalCoverage); assert.equal(t.calls.length, 0);
  } finally { t.close(); }
});

test('Subsequent grounding receives same-configuration feedback only with owner read authority', async () => {
  const t = setupDidi();
  try {
    await t.finish(t.b.submit().id);
    const model = didiModel(), ground = model.ground, seen: unknown[] = [];
    model.ground = async (...args) => {
      seen.push((args[1].find(s => s.ref.id === 'ride.estimate.query') as unknown as { verificationHistory?: unknown }).verificationHistory);
      return ground(...args);
    };
    const b = backend(t.catalog, model, t.store);
    const allowed = b.submit(); await b.run();
    assert.equal((seen[0] as { sampleCount: number }).sampleCount, 1);
    b.tasks.cancel(principal, allowed.id);
    b.tasks.submit({ ...principal, scopes: ['tasks:write'] }, { service: 'eigos.delegate', goal: '查询原路线估价', requestId: randomUUID() });
    await b.run(); assert.equal(seen[1], undefined);
  } finally { t.close(); }
});

test('Unchanged model checkpoints do not rewrite coverage, outcomes or feedback relationships', async () => {
  const t = setupDidi();
  try {
    const job = t.b.submit(); await t.b.run(); const current = t.store.get(owner, job.id);
    const ingest = t.store.ontology.ingest.bind(t.store.ontology), types: string[] = [];
    t.store.ontology.ingest = (who, batch, source) => { types.push(...batch.objects.map(o => o.ref.type)); ingest(who, batch, source); };
    current.updatedAt = new Date(Date.parse(current.updatedAt) + 1).toISOString();
    t.store.save(owner, current);
    assert.deepEqual(types, [], 'An unchanged checkpoint must not traverse and rewrite the outcome relationship graph');
  } finally { t.close(); }
});


test('Native whole-goal contracts receive independent semantic coverage before any component or provider action', async () => {
  const t = setupDidi(); let reviews = 0, actions = 0;
  const model: import('../packages/coordinator/coordinator.js').Reasoner = {
    ontologyContextMode: 'task',
    ground: async (request, _capabilities, _signal, access) => {
      const original = (await import('./backend-fixture.js')).observeTaskContext(access) ?? request;
      return { decision: {kind:'compose', requestRevision:original.revision, message:'Synthetic omitted second outcome', requirementsJson:'[]', conditionsJson:'[]', criteriaJson:JSON.stringify([{id:'estimate',description:'Only a ride estimate',predicate:'ride.estimate_observed',phase:'quote',messageId:original.messages[0]!.id,quote:original.messages[0]!.text,requirementIds:[]}])}, evidence:evidence() };
    },
    reviewGoal: async ctx => {
      reviews++; assert.equal(ctx.capability.ref.id,'eigos.goal');
      assert((ctx.capability.ontology as {goal?:unknown}).goal);
      const result=await syntheticGoalReview(ctx);result.decision.verdict='unsupported';result.decision.message='The fixed goal omitted the requested document';
      result.decision.clauses=result.decision.clauses.map(c=>({...c,disposition:'uncovered',inputKeys:[],requirementIds:[],conditionIds:[]}));result.evidence.decisionDigest=digest(result.decision);return result;
    },
    act: async()=>{actions++;throw new Error('Source planning must not precede goal review');},
    plan: async()=>{throw new Error('No adapter planning');},
  };
  const b=backend(t.catalog,model,t.store);
  try {
    const capability=t.catalog.capability({id:'ride.estimate.query',version:'1'});
    const outcome=capability.goalOutcomes?.[0];assert(outcome);
    const ground=model.ground;model.ground=async(...args)=>{const result=await ground(...args);if(result.decision.kind==='compose'){const c=JSON.parse(result.decision.criteriaJson);c[0].predicate=outcome.predicate;c[0].phase=outcome.phase;result.decision.criteriaJson=JSON.stringify(c);}return result;};
    const job=b.submit({goal:'查询滴滴估价并生成出行说明文档。'});await b.run();await b.run();
    assert.equal(reviews,1);assert.equal(actions,0);assert.equal(t.calls.length,0);assert.equal(t.store.get(owner,job.id).state,'rejected');
  }finally{t.close();}
});
