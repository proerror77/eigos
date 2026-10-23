import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, paotuiModel } from './fixtures/paotui-agent.js';
import { backend, evidence, interpretation, owner, principal, observeTaskContext } from './backend-fixture.js';
import { CodexReasoner, type Reasoner } from '../packages/coordinator/coordinator.js';
import { DomainError } from '../packages/core/domain.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';
import { PAOTUI_AGENT_REFS } from '../packages/capabilities/paotui-agent.js';
import { digest } from '../packages/core/delegation.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';

const goal = '从家里寄到公司，送一个文件，500克，普通送，只查询';
const value = (r: ServiceRequest, kind: 'bad-count' | 'mass' | 'wrong-mass') => ({
  ...interpretation(r, 'delivery.quote', { goodsName: '一个文件' }), capabilityRef: PAOTUI_AGENT_REFS.quote,
  requirementsJson: JSON.stringify([{ requirement: { id: 'quantity', kind: 'quantity', strength: 'hard', expected: kind === 'bad-count' ? { amount: '1', unit: '份文件' } : { amount: kind === 'mass' ? '500' : '2', unit: kind === 'mass' ? 'g' : 'kg' } }, messageId: r.messages[0]!.id, quote: kind === 'bad-count' ? '送一个文件' : '500克' }]),
});

test('rejected item-count interpretation returns feedback and corrects mass in the SAME task before any source read', async () => {
  const f = setup(); let calls = 0;
  const model: Reasoner = { ...paotuiModel(), ground: async (r, _caps, _signal, access) => {
    observeTaskContext(access);
    if (calls) { assert.equal(access.groundingFeedback?.length, 1); assert.match(access.groundingFeedback![0]!.message, /Quantity interpretation/); }
    const decision = value(r, calls++ ? 'mass' : 'bad-count'); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
  } };
  try {
    const b = backend(f.catalog, model, f.store), job = b.submit({ goal, executionEnvironment: 'sandbox' });
    const rejected = await b.run(); assert.equal(rejected.id, job.id); assert.equal(rejected.state, 'working'); assert.equal(rejected.delegation!.phase, 'grounding'); assert.equal(rejected.delegation!.groundingFeedback!.length, 1);
    assert.equal(rejected.delegation!.request.requirements.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.store.intents(owner, job.id).length, 0);
    const scoped = await b.run(); assert.equal(scoped.id, job.id); assert(scoped.delegation!.agent); assert.equal(scoped.runs!.length, 2); assert.equal(f.calls.length, 0);
    const mass = scoped.delegation!.request.requirements[0]!; assert.equal(mass.kind, 'quantity'); assert.deepEqual(mass.expected, { amount: '500', unit: 'g' });
    assert(scoped.delegation!.request.messages[0]!.text.includes('一个文件'), 'Declared contents were retained');
  } finally { f.store.close(); }
});

test('three identical interpretation failures stop safely with no guessed weight or provider call', async () => {
  const f = setup(), model: Reasoner = { ...paotuiModel(), ground: async (r, _caps, _signal, access) => { observeTaskContext(access); return { decision: value(r, 'wrong-mass'), evidence: evidence() }; } };
  try {
    const b = backend(f.catalog, model, f.store), job = b.submit({ goal, executionEnvironment: 'sandbox' }); for (let i = 0; i < 3; i++) await b.run();
    const paused = f.store.get(owner, job.id); assert.equal(paused.state, 'paused'); assert.equal(paused.question, undefined); assert.equal(paused.delegation!.groundingFeedback!.length, 3); assert.equal(f.calls.length, 0); assert.equal(paused.delegation!.request.requirements.length, 0); assert(!paused.artifact);
  } finally { f.store.close(); }
});

test('invalid agent input rolls back scope and fixed requirements before a corrected interpretation', async () => {
  const f = setup(); let n = 0;
  const model: Reasoner = { ...paotuiModel(), ground: async (r, _caps, _signal, access) => {
    observeTaskContext(access);
    const decision = value(r, 'mass'); if (!n++) decision.inputJson = JSON.stringify({ weightKg: 0.5 }); else assert.equal(access.groundingFeedback?.[0]?.stage, 'input');
    return { decision, evidence: evidence() };
  } };
  try {
    const b = backend(f.catalog, model, f.store), job = b.submit({ goal, executionEnvironment: 'sandbox' }); await b.run();
    assert.equal(f.store.ontology.query(owner, { type: 'PaotuiTask' }).items.length, 0); assert.equal(f.store.get(owner, job.id).delegation!.request.requirements.length, 0);
    await b.run(); assert(f.store.get(owner, job.id).delegation!.agent); assert.equal(f.calls.length, 0);
  } finally { f.store.close(); }
});

test('a late invalid interpretation cannot change a canceled task', async () => {
  const f = setup(); let id = '';
  const model: Reasoner = { ...paotuiModel(), ground: async (r, _caps, _signal, access) => { observeTaskContext(access); f.b.tasks.cancel(principal, id); return { decision: value(r, 'wrong-mass'), evidence: evidence() }; } };
  try {
    const b = backend(f.catalog, model, f.store); id = b.submit({ goal, executionEnvironment: 'sandbox' }).id; await b.run();
    const canceled = f.store.get(owner, id); assert.equal(canceled.state, 'canceled'); assert.equal(canceled.delegation!.groundingFeedback, undefined); assert.equal(f.calls.length, 0);
  } finally { f.store.close(); }
});

test('an unlisted model capability version gets bounded feedback before the exact available version is selected', async () => {
  const f = setup(); let turns = 0;
  const model: Reasoner = { ...paotuiModel(), ground: async (request, capabilities, _signal, access) => {
    const current = observeTaskContext(access)!;
    assert.equal(current.id, request.id);
    assert(capabilities.some(capability => capability.ref.id === PAOTUI_AGENT_REFS.quote.id && capability.ref.version === PAOTUI_AGENT_REFS.quote.version));
    if (turns) assert.match(access.groundingFeedback?.[0]?.message ?? '', /exact capability reference and version/);
    const decision = { ...value(current, 'mass'), capabilityRef: turns++ ? PAOTUI_AGENT_REFS.quote : { id: PAOTUI_AGENT_REFS.quote.id, version: 'unlisted-version' } };
    return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
  } };
  try {
    const b = backend(f.catalog, model, f.store), job = b.submit({ goal, executionEnvironment: 'sandbox' });
    const rejected = await b.run();
    assert.equal(rejected.state, 'working'); assert.equal(rejected.delegation!.phase, 'grounding');
    assert.equal(rejected.delegation!.groundingFeedback!.length, 1); assert.equal(rejected.delegation!.agent, undefined);
    assert.equal(rejected.delegation!.request.requirements.length, 0);
    assert.equal(f.calls.length, 0); assert.equal(f.store.intents(owner, job.id).length, 0);
    const selected = await b.run();
    assert.equal(selected.id, job.id); assert.deepEqual(selected.delegation!.agent!.programRef, PAOTUI_AGENT_REFS.quote);
    assert.equal(selected.delegation!.request.messages.length, 1); assert.equal(selected.runs!.length, 2);
    assert.equal(selected.delegation!.ontologyReads!.filter(receipt => receipt.tool === 'read_task_context' && receipt.status === 'ok').length, 2);
    assert.equal(f.calls.length, 0, 'Scope preparation does not invoke a provider');
  } finally { f.store.close(); }
});

test('three identical unlisted capability selections pause without mapping the version or dispatching', async () => {
  const f = setup(), model: Reasoner = { ...paotuiModel(), ground: async (request, _capabilities, _signal, access) => {
    observeTaskContext(access);
    const decision = { ...value(request, 'mass'), capabilityRef: { id: PAOTUI_AGENT_REFS.quote.id, version: 'unlisted-version' } };
    return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
  } };
  try {
    const b = backend(f.catalog, model, f.store), job = b.submit({ goal, executionEnvironment: 'sandbox' });
    for (let index = 0; index < 3; index++) await b.run();
    const paused = f.store.get(owner, job.id);
    assert.equal(paused.state, 'paused'); assert.equal(paused.delegation!.recovery!.code, 'validation_stalled');
    assert.equal(paused.delegation!.groundingFeedback!.length, 3);
    assert.equal(paused.question, undefined); assert.equal(paused.delegation!.agent, undefined);
    assert.equal(paused.delegation!.request.messages.length, 1);
    assert.equal(f.calls.length, 0); assert.equal(f.store.intents(owner, job.id).length, 0);
  } finally { f.store.close(); }
});

test('actual permission failures remain forbidden and are not converted into model capability feedback', async () => {
  const f = setup(), model: Reasoner = { ...paotuiModel(), ground: async (_request, _capabilities, _signal, access) => {
    observeTaskContext(access);
    throw new DomainError('FORBIDDEN', 'Source permission was revoked');
  } };
  try {
    const b = backend(f.catalog, model, f.store), job = b.submit({ goal, executionEnvironment: 'sandbox' });
    await assert.rejects(b.run(), error => error instanceof DomainError && error.code === 'FORBIDDEN');
    assert.equal(f.store.get(owner, job.id).delegation!.groundingFeedback, undefined);
    assert.equal(f.calls.length, 0);
  } finally { f.store.close(); }
});

test('native grounding fixes whole-goal criteria after its actual Ontology read without selecting a root program', async () => {
  const f = setup(), schemas: any[] = []; let turns = 0;
  const model = { runStructured: async (prompt: string) => {
    const packet = JSON.parse(prompt.split('\n\n').at(-1)!);
    schemas.push(packet.finalSchema);
    const current = packet.conversation[0]?.result?.data?.request as ServiceRequest | undefined;
    const output = turns++ ? { kind: 'final', calls: [], receiptIds: [packet.conversation[0].receipt.id], finalJson: JSON.stringify({ kind: 'compose', requestRevision: current!.revision, message: 'Keep the original read-only parcel quote goal', requirementsJson: value(current!, 'mass').requirementsJson, conditionsJson: '[]', criteriaJson: JSON.stringify([{ id: 'quote', description: 'Original parcel quote', predicate: 'paotui.quote_observed', phase: 'quote', messageId: current!.messages[0]!.id, quote: current!.originalGoal, requirementIds: ['quantity'] }]) }) }
      : { kind: 'read', calls: [{ tool: 'read_task_context', argumentsJson: '{}' }], receiptIds: [], finalJson: '' };
    return { output, evidence: evidence() };
  } };
  try {
    const b = backend(f.catalog, new CodexReasoner(model), f.store), job = b.submit({ goal, executionEnvironment: 'sandbox' }), selected = await b.run();
    assert.equal(selected.id, job.id); assert.equal(selected.delegation!.agent!.programRef.id, 'eigos.goal');
    assert.equal(selected.delegation!.agent!.composition!.contexts.length, 0);
    assert.equal(selected.delegation!.agent!.composition!.goal.criteria[0]!.predicate, 'paotui.quote_observed');
    assert.equal(turns, 2); assert.equal(f.calls.length, 0);
    for (const schema of schemas) {
      assert.equal(schema.properties.capabilityRef, undefined);
      assert.equal(schema.properties.inputJson, undefined);
      assert(schema.properties.kind.enum.includes('compose'));
      assert(schema.required.includes('criteriaJson'));
      assert(schema.required.includes('requestRevision'));
    }
  } finally { f.store.close(); }
});

test('artifact interpretation preserves numeric content while explicit structured quantities remain mandatory', async () => {
  const contentGoal = '生成任务说明和引用该说明的会议文稿；文稿包含45分钟议程和三个讨论问题，实际会议尚未开始。';
  const model = { runStructured: async (prompt: string) => {
    const packet = JSON.parse(prompt.split('\n\n').at(-1)!);
    const current = packet.conversation[0]?.result?.data?.request as ServiceRequest | undefined;
    const output = current ? { kind: 'final', calls: [], receiptIds: [packet.conversation[0].receipt.id], finalJson: JSON.stringify({
      kind: 'compose', requestRevision: current.revision, message: 'Generate the requested materials; do not execute the proposed meeting', requirementsJson: '[]', conditionsJson: '[]',
      criteriaJson: JSON.stringify([
        { id: 'brief', description: contentGoal, predicate: 'brief.json', phase: 'artifact', messageId: current.messages[0]!.id, quote: contentGoal, requirementIds: [] },
        { id: 'document', description: contentGoal, predicate: 'document.markdown', phase: 'artifact', messageId: current.messages[0]!.id, quote: contentGoal, requirementIds: [] },
      ]),
    }) } : { kind: 'read', calls: [{ tool: 'read_task_context', argumentsJson: '{}' }], receiptIds: [], finalJson: '' };
    return { output, evidence: evidence() };
  } };
  const b = backend(createExecutionCatalog({ documentEnabled: true }), new CodexReasoner(model));
  try {
    const draft = b.submit({ goal: contentGoal, executionEnvironment: 'live' });
    await b.run();
    const interpreted = b.store.get(owner, draft.id), request = interpreted.delegation!.request;
    assert.equal(request.originalGoal, contentGoal);
    assert.equal(request.messages[0]!.text, contentGoal);
    assert.deepEqual(request.requirements, []);
    const criteria = interpreted.delegation!.agent!.composition!.goal.criteria;
    assert.deepEqual(criteria.map(value => value.predicate), ['brief.json', 'document.markdown']);
    assert(criteria.every(value => value.description === contentGoal && value.quote === contentGoal));
    assert.equal(b.store.intents(owner, draft.id).length, 0);
    b.tasks.cancel(principal, draft.id);

    const fixed = b.submit({ goal: contentGoal, executionEnvironment: 'live', requirements: [
      { id: 'fixed_quantity', kind: 'quantity', strength: 'hard', expected: { amount: '3', unit: '个' } },
    ] });
    await b.run();
    const rejected = b.store.get(owner, fixed.id);
    assert.equal(rejected.delegation!.request.requirements[0]!.id, 'fixed_quantity');
    assert.equal(rejected.delegation!.agent, undefined);
    assert.match(rejected.delegation!.groundingFeedback!.at(-1)!.message, /Every fixed hard requirement/);
    assert.equal(b.store.intents(owner, fixed.id).length, 0);
  } finally { b.store.close(); }
});
