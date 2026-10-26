// Deterministic choices and provider/model substitutes. Native PA + LLM evidence
// is collected separately; this suite exercises the actual durable runtime.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { digest } from '../packages/core/delegation.js';
import { backend, evidence, owner, principal, observeTaskContext, acknowledgeReads } from './backend-fixture.js';
import { fixture, merchant, input, ids } from './fixtures/catalog-agent.js';
import type { Reasoner, AgentPlanningContext, PlanningAccess } from '../packages/coordinator/coordinator.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import type { ActionDiscoveryPage, ActionBindingPin } from '../packages/core/action-bindings.js';
import type { Job } from '../packages/core/domain.js';
import { SourceAuthorizationRequired } from '../packages/core/member-source.js';
import { componentContext } from '../packages/core/composed-actions.js';
import type { Executor } from '../packages/capabilities/executor.js';
import type { ObjectRef } from '../packages/ontology/model.js';
import type { AcceptedPortValue } from '../packages/ontology/composition-contract.js';
import { aggregateGoalFacts } from '../packages/coordinator/goal-program.js';
import type { Delivery } from '../packages/core/catalog.js';
import { createCurrentKernelDefinition, createHistoricalKernelDefinition, createSeedDefinition, CURRENT_KERNEL_VERSION } from '../packages/ontology/seed-definition.js';

const goal = 'Use the synthetic fixture to compare 2 coffee results and produce a Markdown document from their accepted source facts.';
const getPin = (access: PlanningAccess, actionId: string): ActionBindingPin => {
  const page = access.session.call('discover_actions', { actionId }) as ActionDiscoveryPage;
  const binding = page.items?.[0]?.bindings.find(value => value.readiness === 'ready');
  assert(binding, JSON.stringify(page)); return binding.pin;
};
function read(ctx: AgentPlanningContext, access: PlanningAccess) {
  observeTaskContext(access);
  for (const component of ctx.state.composition!.contexts) access.session.call('query_ontology', { object: component.scope });
  for (const ref of ctx.state.observations) {
    access.session.call('query_ontology', { object: ref });
    if (ref.type.startsWith('Catalog')) access.session.call('evaluate_ontology', { function: 'catalogObservationStatus', object: ref });
  }
}
const decision = (ctx: AgentPlanningContext, fields: Partial<AgentDecision>): AgentDecision => ({ kind: 'execute', requestRevision: ctx.request.revision, message: 'Synthetic choice from observed runtime state', steps: [], completionJson: '', ...fields });
const completion = (ctx: AgentPlanningContext, catalog: ObjectRef, document?: ObjectRef) => ({
  components: [{ contextId: 'catalog', proposalJson: JSON.stringify({ selections: [{ observation: catalog, variantIds: ids.slice(0, 2) }], rationale: 'Two actually observed synthetic variants' }) },
    ...(document ? [{ contextId: 'document', proposalJson: JSON.stringify({ document }) }] : [])],
  criteria: [{ id: 'facts', contextIds: ['catalog'] }, { id: 'draft', contextIds: ['document'] }], conditions: [],
});
function next(ctx: AgentPlanningContext, access: PlanningAccess): AgentDecision {
  read(ctx, access);
  if (!ctx.state.composition!.contexts.length) return decision(ctx, { kind: 'prepare', contexts: [
    { id: 'catalog', bindingDigest: getPin(access, 'SearchPublicCatalog').digest, inputJson: JSON.stringify(input) },
    { id: 'document', bindingDigest: getPin(access, 'ComposeDocument').digest, inputJson: JSON.stringify({ format: 'markdown' }) },
  ] });
  const scope = (id: string) => ctx.state.composition!.contexts.find(component => component.id === id)!.scope;
  const catalog = ctx.state.observations.find(ref => ref.type === 'CatalogObservation'), document = ctx.state.observations.find(ref => ref.type === 'DocumentDraft');
  if (!catalog) return decision(ctx, { steps: [{ id: 'read_catalog', action: 'SearchPublicCatalog', bindingDigest: getPin(access, 'SearchPublicCatalog').digest, contextId: 'catalog',
    argumentsJson: JSON.stringify({ scope: scope('catalog'), merchantId: merchant.id, query: 'coffee', limit: 4 }), dependsOn: [], inputRefs: [], contributesTo: ['facts'] }] });
  const docAttempt = ctx.state.plans.flatMap(plan => plan.steps).find(step => step.action === 'ComposeDocument');
  if (!docAttempt) {
    const producer = ctx.state.plans.flatMap(plan => plan.steps).find(step => step.action === 'SearchPublicCatalog')!;
    return decision(ctx, { steps: [{ id: 'make_document', action: 'ComposeDocument', bindingDigest: getPin(access, 'ComposeDocument').digest, contextId: 'document',
      argumentsJson: JSON.stringify({ scope: scope('document') }), dependsOn: [], inputRefs: [], contributesTo: ['draft'],
      acceptedInputs: [{ intentId: producer.intentId, port: 'citations', targetKey: 'citations' }] }] });
  }
  return decision(ctx, { kind: 'complete', completionJson: JSON.stringify(completion(ctx, catalog, document)) });
}
function setup(options: { path?: string; failDocument?: boolean; choice?: typeof next; executor?: Executor } = {}) {
  const source = fixture(), store = new JobStore(options.path ?? ':memory:'), documents: Job[] = [];
  const executor: Executor = options.executor ?? { run: async job => {
    documents.push(structuredClone(job));
    if (options.failDocument) throw new Error('Synthetic second service outage');
    return { output: { decision: 'complete', message: 'Synthetic draft', artifact: '# Coffee comparison\n\nThe accepted synthetic source supplies the product facts.' }, evidence: evidence() };
  } };
  const catalog = createExecutionCatalog({ store, shopifyCatalog: { merchants: [merchant], connector: source.connector }, documentEnabled: true, documentExecutor: executor });
  const model: Reasoner = {
    ground: async (request, _capabilities, _signal, access) => {
      observeTaskContext(access);
      const decision = { kind: 'compose' as const, requestRevision: request.revision, message: 'Freeze both requested outcomes', requirementsJson: '[]', conditionsJson: '[]', criteriaJson: JSON.stringify([
        { id: 'facts', description: 'Source-backed product comparison', predicate: 'catalog.observed', phase: 'fact', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: request.requirements.map(requirement => requirement.id) },
        { id: 'draft', description: 'Actual document from the source evidence', predicate: 'document.markdown', phase: 'artifact', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: [] },
      ]) };
      return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
    plan: async () => { throw new Error('A composed task must never enter the fixed-recipe planner'); },
    act: async (ctx, _signal, access) => { const selected = (options.choice ?? next)(ctx, access); acknowledgeReads(access); return { decision: selected, evidence: { ...evidence(), decisionDigest: digest(selected) } }; },
  };
  const b = backend(catalog, model, store), submit = () => b.submit({ goal, executionEnvironment: 'sandbox', requirements: [{ id: 'count', kind: 'quantity', role: 'result_count', strength: 'hard', expected: { amount: '2', unit: 'result' } }] });
  const finish = async (id: string) => {
    for (let n = 0; n < 12; n++) {
      const job = store.get(owner, id);
      if (!['working', 'submitted'].includes(job.state) || job.delegation?.agent?.composition?.assessment) return job;
      await b.run();
    }
    throw new Error(JSON.stringify(store.get(owner, id).delegation?.agent?.feedback));
  };
  return { ...source, b, store, catalog, documents, submit, finish };
}

test('one whole goal executes two independently pinned programs and passes original citation evidence', async () => {
  const t = setup(); try {
    const submitted = t.submit(), done = await t.finish(submitted.id), state = done.delegation!.agent!;
    assert.equal(done.state, 'completed', JSON.stringify(state?.feedback ?? done.delegation?.groundingFeedback)); assert.equal(state.version, '2');
    assert.equal(state.programRef.id, 'eigos.goal'); assert.equal(state.composition!.assessment!.accepted, true);
    assert.equal(state.composition!.contexts.length, 2); assert.equal(t.calls.length, 1); assert.equal(t.documents.length, 1);
    const steps = state.plans.flatMap(plan => plan.steps); assert.equal(steps.length, 2);
    assert.equal(new Set(steps.map(step => step.binding!.programRef.id)).size, 2);
    assert(state.plans.every(plan => plan.version === '3' && plan.modelRunId && plan.ontologyPlanning.reads.some(read => read.actionBindings?.pins.length)));
    assert.equal(done.delegation!.plan, undefined); assert.equal(done.delegation!.resolution, undefined);
    const intents = t.store.intents(owner, done.id); assert(intents.every(intent => intent.state === 'effect_confirmed'));
    assert(intents.every(intent => steps.some(step => step.intentId === intent.id && digest(step.binding!.ref) === digest(intent.bindingRef))));
    const producer = intents.find(intent => intent.stepId === 'read_catalog')!, ports = producer.acceptedOutput!.ports as AcceptedPortValue[];
    assert(ports.some(port => port.port === 'citations' && port.evidence.origin === 'synthetic' && port.observationId === producer.latestObservationId));
    const sourceMessage = t.documents[0]!.messages.at(-1)!.text; assert(sourceMessage.includes(merchant.domain)); assert(sourceMessage.includes(ids[0]!));
    assert.equal(done.runs!.filter(run => run.purpose === 'document').length, 1);
    const documentProof = state.composition!.assessment!.components.find(component => component.contextId === 'document')!;
    assert(!documentProof.delivery!.facts.conditions!.includes('execution.supplied_information_only'), 'A document cannot erase the task\'s preceding provider read');
    assert.equal(done.delegation!.acceptance!.checks.find(check => check.requirementId === 'count')!.result, 'pass');
  } finally { t.store.close(); }
});

test('invalid completion fields receive bounded schema feedback and can be corrected without repeating sources', async () => {
  let selections = 0;
  const t = setup({ choice: (ctx, access) => {
    const selected = next(ctx, access);
    if (selected.kind === 'complete' && selections++ === 0) {
      const value = JSON.parse(selected.completionJson); delete value.conditions;
      value.PRIVATE_FIELD_NAME = 'PRIVATE_SOURCE_VALUE'; selected.completionJson = JSON.stringify(value);
    }
    return selected;
  } });
  try {
    const submitted = t.submit(), done = await t.finish(submitted.id);
    assert.equal(done.state, 'completed'); assert.equal(selections, 2);
    const feedback = done.delegation!.agent!.feedback.find(value => value.kind === 'completion')!;
    assert.match(feedback.message, /schema mismatch at conditions, completion|schema mismatch at completion, conditions/);
    assert(!feedback.message.includes('PRIVATE_'));
    assert.equal(t.calls.length, 1); assert.equal(t.documents.length, 1);
    assert.equal(done.delegation!.acceptance!.accepted, true);
  } finally { t.store.close(); }
});

test('second-service failure preserves the first result and leaves the whole goal incomplete', async () => {
  const t = setup({ failDocument: true }); try {
    const done = await t.finish(t.submit().id), assessment = done.delegation!.agent!.composition!.assessment!;
    assert.equal(done.state, 'working'); assert.equal(assessment.accepted, false); assert.equal(done.artifact!.data.execution, 'partial');
    assert.equal(assessment.criteria.find(criterion => criterion.id === 'facts')!.result, 'pass');
    assert.equal(assessment.criteria.find(criterion => criterion.id === 'draft')!.result, 'unknown');
    assert(assessment.components.some(component => component.contextId === 'catalog' && component.delivery));
    assert.equal(done.delegation!.acceptance, undefined); assert.equal(t.calls.length, 1); assert.equal(t.documents.length, 1);
  } finally { t.store.close(); }
});

test('a document alone cannot remove an unsatisfied required source result', async () => {
  const t = setup({ choice: (ctx, access) => {
    const selected = next(ctx, access);
    if (selected.kind === 'complete') {
      const value = JSON.parse(selected.completionJson); value.components = value.components.filter((component: { contextId: string }) => component.contextId === 'document');
      value.criteria = value.criteria.filter((criterion: { id: string }) => criterion.id === 'draft'); selected.completionJson = JSON.stringify(value);
    }
    return selected;
  } }); try {
    const done = await t.finish(t.submit().id); assert.notEqual(done.state, 'completed');
    assert.equal(done.delegation!.agent!.composition!.assessment!.criteria.find(criterion => criterion.id === 'facts')!.result, 'unknown');
    assert.equal(done.delegation!.agent!.composition!.goal.criteria.length, 2);
  } finally { t.store.close(); }
});

test('a same-name action cannot dispatch under another component context', async () => {
  const t = setup({ choice: (ctx, access) => {
    const selected = next(ctx, access);
    if (selected.kind === 'execute' && selected.steps[0]!.action === 'SearchPublicCatalog') selected.steps[0]!.contextId = 'document';
    return selected;
  } }); try {
    const done = await t.finish(t.submit().id); assert.equal(done.state, 'paused'); assert.equal(t.calls.length, 0); assert.equal(t.documents.length, 0);
    assert(done.delegation!.agent!.feedback.some(feedback => (/Component (context|program reference) changed|component context/i).test(feedback.message)));
  } finally { t.store.close(); }
});

test('a document citing older conflicting facts cannot close a goal alongside a newer source result', async () => {
  let mode: 'normal' | 'refresh' | 'complete' = 'normal';
  const t = setup({ choice: (ctx, access) => {
    if (mode === 'normal') return next(ctx, access);
    read(ctx, access);
    if (mode === 'refresh') {
      const scope = ctx.state.composition!.contexts.find(component => component.id === 'catalog')!.scope;
      return decision(ctx, { steps: [{ id: 'refresh_catalog', action: 'SearchPublicCatalog', bindingDigest: getPin(access, 'SearchPublicCatalog').digest, contextId: 'catalog', argumentsJson: JSON.stringify({ scope, merchantId: merchant.id, query: 'coffee', limit: 4 }), dependsOn: [], inputRefs: [], contributesTo: ['facts'] }] });
    }
    const catalog = ctx.state.observations.filter(ref => ref.type === 'CatalogObservation').at(-1)!, document = ctx.state.observations.find(ref => ref.type === 'DocumentDraft')!;
    return decision(ctx, { kind: 'complete', completionJson: JSON.stringify(completion(ctx, catalog, document)) });
  } }); try {
    const id = t.submit().id; for (let i = 0; i < 4; i++) await t.b.run();
    assert.equal(t.documents.length, 1); t.flags.price.set(ids[0]!, 9000); mode = 'refresh'; await t.b.run(); mode = 'complete';
    const done = await t.b.run(), assessment = done.delegation!.agent!.composition!.assessment!;
    assert.equal(assessment.accepted, false); assert.equal(done.state, 'working');
    assert.equal(assessment.criteria.find(criterion => criterion.id === 'facts')!.result, 'pass');
    assert.equal(assessment.criteria.find(criterion => criterion.id === 'draft')!.result, 'unknown');
    assert.match(assessment.components.find(component => component.contextId === 'document')!.reason!, /later source observation conflicts/i);
    assert.equal(t.calls.length, 2); assert.equal(t.store.get(owner, id).delegation!.request.revision, 1);
  } finally { t.store.close(); }
});

test('a late document model result after cancellation is audit evidence only', async () => {
  let started!: () => void, release!: () => void;
  const called = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const t = setup({ executor: { run: async () => { started(); await held; return { output: { decision: 'complete', message: 'Late synthetic draft', artifact: '# Late result' }, evidence: evidence() }; } } });
  let pending: Promise<Job> | undefined;
  try {
    const id = t.submit().id; for (let i = 0; i < 3; i++) await t.b.run();
    pending = t.b.run(); await called; t.b.tasks.cancel(principal, id); release(); await pending;
    const done = t.store.get(owner, id), intent = t.store.intents(owner, id).find(intent => intent.stepId === 'make_document')!;
    assert.equal(done.state, 'canceled'); assert.equal(done.delegation!.agent!.observations.filter(ref => ref.type === 'DocumentDraft').length, 0);
    assert.equal(intent.acceptedOutput, undefined); assert.equal(t.store.observations(owner, intent.id).length, 1);
    assert.equal(done.delegation!.agent!.composition!.assessment, undefined);
  } finally { release(); await pending; t.store.close(); }
});

test('accepted citations and per-action pins survive a database restart in the original task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-composed-')), path = join(directory, 'tasks.sqlite');
  const first = setup({ path }); let second: ReturnType<typeof setup> | undefined;
  try {
    const id = first.submit().id; await first.b.run(); await first.b.run(); await first.b.run();
    const sourceIntent = first.store.intents(owner, id)[0]!.id; first.store.close();
    second = setup({ path }); const done = await second.finish(id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation!.agent!.feedback)); assert.equal(second.calls.length, 0);
    assert.equal(second.store.intents(owner, id).filter(intent => intent.id === sourceIntent).length, 1); assert.equal(second.documents.length, 1);
  } finally { second?.store.close(); if (!second) { try { first.store.close(); } catch { /* Already closed. */ } } rmSync(directory, { recursive: true, force: true }); }
});

test('money aggregation keeps distinct commitments and never counts their quote/payment twice', () => {
  const delivery = (key: string, minor: string, phase: 'quote' | 'payment'): Delivery => ({ artifact: { id: randomUUID(), name: 'test', data: { goal: 'synthetic', deliverable: 'synthetic', execution: 'completed' } }, facts: { totalPrice: { minor, currency: 'CNY' } }, evidenceRefs: [key], economicFacts: [{ key, phase, amount: { minor, currency: 'CNY' }, evidenceRefs: [key] }] });
  const a = delivery('A', '40', 'quote'), b = delivery('B', '50', 'quote'), paid = delivery('A', '40', 'payment');
  assert.deepEqual(aggregateGoalFacts([a, b, paid]).totalPrice, { minor: '90', currency: 'CNY' });
  assert.equal(aggregateGoalFacts([a, delivery('A', '45', 'payment')]).totalPrice, undefined);
  assert.equal(aggregateGoalFacts([a, { ...b, economicFacts: undefined }]).totalPrice, undefined);
});

test('v15 and v16 remain exact historical models while the current kernel carries composition contracts', () => {
  const old = createSeedDefinition(), previous = createHistoricalKernelDefinition(old.registry), current = createCurrentKernelDefinition(old.registry);
  assert.equal(old.audit.model.digest, 'efd2ef430b621b1c4f83b8d4e79a794126d24257bfa5022a5c1de8bdd6e48776');
  assert.equal(previous.audit.model.digest, '9cc72c92efa54600967979971dc0e568d01d849b683bbe4e7d6d8931150eef57');
  assert.equal(current.audit.model.version, CURRENT_KERNEL_VERSION); assert(current.document.actions.find(action => action.id === 'ComposeDocument')?.composition);
  assert(previous.document.actions.every(action => !action.composition));
});


test('renewing one source keeps the fixed whole goal and another service accepted result', async () => {
  let resumed = false;
  const t = setup({ choice: (ctx, access) => {
    if (!resumed) return next(ctx, access);
    if (!ctx.state.composition!.contexts.some(value => value.id === 'renewed_document')) {
      read(ctx, access);
      return decision(ctx, { kind: 'prepare', contexts: [{ id: 'renewed_document', bindingDigest: getPin(access, 'ComposeDocument').digest, inputJson: JSON.stringify({ format: 'markdown' }) }] });
    }
    const selected = next(ctx, access), scope = ctx.state.composition!.contexts.find(value => value.id === 'renewed_document')!.scope;
    selected.steps = selected.steps.map(step => step.action === 'ComposeDocument' ? { ...step, contextId: 'renewed_document', argumentsJson: JSON.stringify({ scope }) } : step);
    if (selected.kind === 'complete') {
      const complete = JSON.parse(selected.completionJson);
      complete.components = complete.components.map((value: { contextId: string }) => value.contextId === 'document' ? { ...value, contextId: 'renewed_document' } : value);
      complete.criteria = complete.criteria.map((value: { contextIds: string[] }) => ({ ...value, contextIds: value.contextIds.map(id => id === 'document' ? 'renewed_document' : id) }));
      selected.completionJson = JSON.stringify(complete);
    }
    return selected;
  } });
  try {
    const program = t.catalog.agentProgram({ id: 'document.compose', version: '2' }, owner)!;
    program.sourceAuthorization = () => ({ provider: 'meituan-paotui', state: 'connected', nextAction: 'continue' });
    const id = t.submit().id; for (let i = 0; i < 3; i++) await t.b.run();
    const waiting = t.store.get(owner, id), before = structuredClone(waiting.delegation!.agent!);
    waiting.state = 'auth-required'; waiting.delegation!.phase = 'awaiting_authorization';
    waiting.delegation!.sourceAuthorization = new SourceAuthorizationRequired().connection!;
    t.store.save(owner, waiting);
    const resumedJob = t.b.tasks.resumeSource(principal, { taskId: id, requestId: randomUUID(), expectedRevision: waiting.revision }, () => {});
    assert.equal(resumedJob.delegation!.request.revision, before.requestRevision);
    assert.deepEqual(resumedJob.delegation!.agent!.composition!.goal, before.composition!.goal);
    assert.deepEqual(resumedJob.delegation!.agent!.plans, before.plans);
    assert.deepEqual(resumedJob.delegation!.agent!.observations, before.observations);
    assert.deepEqual(resumedJob.delegation!.agent!.composition!.retiredContexts!.map(value => value.id), ['document']);
    const context = resumedJob.delegation!.agent!.composition!.contexts.find(value => value.id === 'document')!;
    assert.throws(() => componentContext({ graph: t.store.ontology, owner, request: resumedJob.delegation!.request, state: resumedJob.delegation!.agent!, modelRuns: resumedJob.runs }, context, program), /retired/);
    resumed = true;
    const done = await t.finish(id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation!.agent!.feedback));
    assert.equal(t.calls.length, 1); assert.equal(t.documents.length, 1);
  } finally { t.store.close(); }
});
