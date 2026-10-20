import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, paotuiModel } from './fixtures/paotui-agent.js';
import { backend, evidence, interpretation, owner, principal } from './backend-fixture.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';
import { digest } from '../packages/core/delegation.js';

const goal = '从家里寄到公司，送一个文件，500克，普通送，只查询';
const value = (r: ServiceRequest, kind: 'bad-count' | 'mass' | 'wrong-mass') => ({
  ...interpretation(r, 'delivery.quote', {}), capabilityRef: { id: 'delivery.quote', version: '3' },
  requirementsJson: JSON.stringify([{ requirement: { id: 'quantity', kind: 'quantity', strength: 'hard', expected: kind === 'bad-count' ? { amount: '1', unit: '份文件' } : { amount: kind === 'mass' ? '500' : '2', unit: kind === 'mass' ? 'g' : 'kg' } }, messageId: r.messages[0]!.id, quote: kind === 'bad-count' ? '送一个文件' : '500克' }]),
});

test('rejected item-count interpretation returns feedback and corrects mass in the SAME task before any source read', async () => {
  const f = setup(); let calls = 0;
  const model: Reasoner = { ...paotuiModel(), ground: async (r, _caps, _signal, access) => {
    if (calls) { assert.equal(access.groundingFeedback?.length, 1); assert.match(access.groundingFeedback![0]!.message, /Quantity interpretation/); }
    const decision = value(r, calls++ ? 'mass' : 'bad-count'); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
  } };
  try {
    const b = backend(f.catalog, model, f.store), job = b.submit({ goal });
    const rejected = await b.run(); assert.equal(rejected.id, job.id); assert.equal(rejected.state, 'working'); assert.equal(rejected.delegation!.phase, 'grounding'); assert.equal(rejected.delegation!.groundingFeedback!.length, 1);
    assert.equal(rejected.delegation!.request.requirements.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.store.intents(owner, job.id).length, 0);
    const scoped = await b.run(); assert.equal(scoped.id, job.id); assert(scoped.delegation!.agent); assert.equal(scoped.runs!.length, 2); assert.equal(f.calls.length, 0);
    const mass = scoped.delegation!.request.requirements[0]!; assert.equal(mass.kind, 'quantity'); assert.deepEqual(mass.expected, { amount: '500', unit: 'g' });
    assert(scoped.delegation!.request.messages[0]!.text.includes('一个文件'), 'Declared contents were retained');
  } finally { f.store.close(); }
});

test('three identical interpretation failures stop safely with no guessed weight or provider call', async () => {
  const f = setup(), model: Reasoner = { ...paotuiModel(), ground: async r => ({ decision: value(r, 'wrong-mass'), evidence: evidence() }) };
  try {
    const b = backend(f.catalog, model, f.store), job = b.submit({ goal }); for (let i = 0; i < 3; i++) await b.run();
    const paused = f.store.get(owner, job.id); assert.equal(paused.state, 'paused'); assert.equal(paused.question, undefined); assert.equal(paused.delegation!.groundingFeedback!.length, 3); assert.equal(f.calls.length, 0); assert.equal(paused.delegation!.request.requirements.length, 0); assert(!paused.artifact);
  } finally { f.store.close(); }
});

test('invalid agent input rolls back scope and fixed requirements before a corrected interpretation', async () => {
  const f = setup(); let n = 0;
  const model: Reasoner = { ...paotuiModel(), ground: async (r, _caps, _signal, access) => {
    const decision = value(r, 'mass'); if (!n++) decision.inputJson = JSON.stringify({ weightKg: 0.5 }); else assert.equal(access.groundingFeedback?.[0]?.stage, 'input');
    return { decision, evidence: evidence() };
  } };
  try {
    const b = backend(f.catalog, model, f.store), job = b.submit({ goal }); await b.run();
    assert.equal(f.store.ontology.query(owner, { type: 'PaotuiTask' }).items.length, 0); assert.equal(f.store.get(owner, job.id).delegation!.request.requirements.length, 0);
    await b.run(); assert(f.store.get(owner, job.id).delegation!.agent); assert.equal(f.calls.length, 0);
  } finally { f.store.close(); }
});

test('a late invalid interpretation cannot change a canceled task', async () => {
  const f = setup(); let id = '';
  const model: Reasoner = { ...paotuiModel(), ground: async r => { f.b.tasks.cancel(principal, id); return { decision: value(r, 'wrong-mass'), evidence: evidence() }; } };
  try {
    const b = backend(f.catalog, model, f.store); id = b.submit({ goal }).id; await b.run();
    const canceled = f.store.get(owner, id); assert.equal(canceled.state, 'canceled'); assert.equal(canceled.delegation!.groundingFeedback, undefined); assert.equal(f.calls.length, 0);
  } finally { f.store.close(); }
});
