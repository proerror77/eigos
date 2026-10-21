import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JobStore } from '../packages/core/store.js';
import type { Job } from '../packages/core/domain.js';
import { ActionRuntime } from '../packages/coordinator/runtime.js';
import { Worker } from '../apps/worker/worker.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { BRIEF_CAPABILITY, BRIEF_BINDING, BriefAdapter, verifyBrief } from '../packages/capabilities/brief.js';
import { CsvAuditAdapter } from '../packages/capabilities/csv-audit.js';
import { CSV_CHECKS } from '../packages/ontology/csv-audit.js';
import { BACKEND_VERSION, requirementsSchema, type ServiceRequest } from '../packages/ontology/execution.js';
import { digest, canonical, validPlanDigest } from '../packages/core/delegation.js';
import { groundRequirements } from '../packages/coordinator/requirements.js';
import { CapabilityResolver } from '../packages/coordinator/resolver.js';
import { backend, owner, principal, reasoner, interpretation, proposal, fixtureCapability, fixtureBinding, fixtureAdapter } from './backend-fixture.js';

test('new catalogue separates one business definition from two provider bindings; versions are exact', () => {
  const catalog = new ExecutionCatalog([BRIEF_CAPABILITY], [BRIEF_BINDING, { ...BRIEF_BINDING, ref: { id: 'second', version: '2' }, providerId: 'second' }], [new BriefAdapter()]);
  assert.equal(catalog.summaries(owner).length, 1); assert.equal(catalog.bindings(BRIEF_CAPABILITY.ref, owner).length, 2);
  assert.throws(() => catalog.binding({ id: 'local-brief', version: '1' }, owner), /unavailable/);
  assert.throws(() => new ExecutionCatalog([BRIEF_CAPABILITY], [BRIEF_BINDING, BRIEF_BINDING], [new BriefAdapter()]), /Duplicate binding/);
  assert.throws(() => new ExecutionCatalog([BRIEF_CAPABILITY, BRIEF_CAPABILITY], [], []), /Duplicate capability/);
});

test('disabled and identity-restricted bindings are excluded before model access', () => {
  const catalog = new ExecutionCatalog([fixtureCapability], [{ ...fixtureBinding('disabled'), enabled: false }, fixtureBinding('private')], [fixtureAdapter('disabled', {}), fixtureAdapter('private', {}, { permitted: false })]);
  assert.deepEqual(catalog.summaries(owner), []);
  assert.throws(() => catalog.binding(fixtureBinding('disabled').ref, owner), /unavailable/);
  assert.throws(() => catalog.binding(fixtureBinding('private').ref, owner), /unavailable/);
  assert.deepEqual(createExecutionCatalog({ csvInputDirectory: '/fixture' }).summaries('other').map(s => s.ref.id), ['brief.prepare']);
});

test('LLM proposes a fact-based provider plan; a cheaper provider failing quantity is rejected', async () => {
  const catalog = new ExecutionCatalog([fixtureCapability], [fixtureBinding('cheap'), fixtureBinding('enough')], [fixtureAdapter('cheap', { quantity: { amount: '15', unit: '杯' }, totalPrice: { minor: '30000', currency: 'CNY' } }), fixtureAdapter('enough', { quantity: { amount: '20', unit: '杯' }, totalPrice: { minor: '45000', currency: 'CNY' } })]);
  const b = backend(catalog, reasoner(r => interpretation(r, 'fixture.supply', { quantity: '20' }), ctx => {
    assert.equal(ctx.resolution.candidates[0]!.requirementChecks[0]!.result, 'fail');
    assert(!JSON.stringify(ctx).includes('private-fixture-marker'));
    return proposal(ctx, 1);
  }));
  try {
    b.submit({ goal: '20杯，预算500元', requirements: [{ id: 'cups', kind: 'quantity', strength: 'hard', expected: { amount: '20', unit: '杯' } }, { id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '50000', currency: 'CNY' } }] });
    const done = await b.run(); assert.equal(done.state, 'completed'); assert.equal(done.delegation!.plan!.bindingRef.id, 'enough');
    assert.equal(done.delegation!.request.requirements[0]!.expected && done.delegation!.request.requirements[0]!.provenance.interpretation, 'structured');
    assert(done.delegation!.acceptance!.checks.every(c => c.result === 'pass')); assert(validPlanDigest(done.delegation!.plan!));
  } finally { b.store.close(); }
});

test('unknown inventory, incompatible currency, expired quote and hard failures never become executable', async () => {
  for (const mode of ['unknown', 'currency', 'expired', 'quantity'] as const) {
    const adapter = fixtureAdapter('one', mode === 'quantity' ? { quantity: { amount: '15', unit: '杯' } } : mode === 'currency' ? { totalPrice: { minor: '100', currency: 'USD' } } : {}, mode === 'expired' ? { expiresAt: new Date(Date.now() - 1).toISOString() } : {});
    const b = backend(new ExecutionCatalog([fixtureCapability], [fixtureBinding('one')], [adapter]), reasoner(r => interpretation(r, 'fixture.supply', {})));
    try {
      b.submit({ requirements: mode === 'expired' ? [] : mode === 'currency' ? [{ id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '50000', currency: 'CNY' } }] : [{ id: 'cups', kind: 'quantity', strength: 'hard', expected: { amount: '20', unit: '杯' } }] });
      await assert.rejects(b.run(), /hard requirements|expired/);
    } finally { b.store.close(); }
  }
});

test('planner cannot invent candidates/actions, weaken prepared inputs, change bindings, or use stale revisions', async () => {
  for (const mode of ['candidate', 'action', 'input', 'binding', 'revision', 'dependency', 'extra'] as const) {
    const b = backend(createExecutionCatalog(), reasoner(undefined, ctx => {
      const p = proposal(ctx);
      if (mode === 'candidate') p.candidateId = 'invented';
      if (mode === 'action') p.steps[0]!.actionTypeRef.id = 'purchase_coffee';
      if (mode === 'input') p.steps[0]!.inputJson = JSON.stringify({ goal: 'Changed goal', deliverable: 'Different outcome' });
      if (mode === 'binding') p.steps[0]!.bindingRef.id = 'different-provider';
      if (mode === 'revision') p.requestRevision++;
      if (mode === 'dependency') p.steps[0]!.dependsOn = ['action'];
      if (mode === 'extra') p.steps.push({ ...p.steps[0]!, id: 'payment' });
      return p;
    }));
    try { const j = b.submit(); await assert.rejects(b.run()); const failed = b.store.get(owner, j.id); assert.equal(failed.artifact, undefined); assert.equal(failed.runs!.length, 2); }
    finally { b.store.close(); }
  }
});

test('source-backed extraction preserves quantities and budgets; model cannot rewrite fixed constraints', () => {
  const request: ServiceRequest = { id: randomUUID(), revision: 1, originalGoal: '20杯，预算500元', requirements: [], messages: [{ id: 'm', text: '20杯，预算500元', receivedAt: new Date().toISOString() }] };
  const quantity = { id: 'cups', kind: 'quantity', strength: 'hard', expected: { amount: '20', unit: '杯' } };
  const extracted = [{ requirement: quantity, messageId: 'm', quote: '20杯' }, { requirement: { id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '50000', currency: 'CNY' } }, messageId: 'm', quote: '预算500元' }];
  const fixed = groundRequirements(request, JSON.stringify(extracted)); assert.equal(fixed.requirements.length, 2); assert.deepEqual(groundRequirements(fixed, '[]'), fixed);
  assert.throws(() => groundRequirements(fixed, JSON.stringify([{ requirement: { ...quantity, expected: { amount: '15', unit: '杯' } }, messageId: 'm', quote: '20杯' }])), /replace a fixed requirement/);
  assert.throws(() => groundRequirements(fixed, JSON.stringify([{ requirement: { ...quantity, strength: 'preference' }, messageId: 'm', quote: '20杯' }])), /replace/);
  assert.throws(() => groundRequirements(request, JSON.stringify([{ ...extracted[0], messageId: 'someone-else' }])), /provenance/);
  const mixed = { ...request, messages: [{ ...request.messages[0]!, text: '20杯，预算15元' }] };
  assert.throws(() => groundRequirements(mixed, JSON.stringify([{ requirement: { ...quantity, expected: { amount: '15', unit: '杯' } }, messageId: 'm', quote: '20杯，预算15元' }])), /Quantity/);
  assert.throws(() => groundRequirements(mixed, JSON.stringify([{ requirement: { id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '2000', currency: 'CNY' } }, messageId: 'm', quote: '20杯，预算15元' }])), /Budget/);
  assert.throws(() => requirementsSchema.parse([{ ...quantity, expected: { amount: '-1', unit: '杯' } }]));
});

test('requirements, original text, sources and request revision survive clarification on the same task', async () => {
  const b = backend(createExecutionCatalog(), reasoner(r => r.revision === 1 ? { ...interpretation(r), kind: 'clarify', message: 'What should the brief specify?' } : interpretation(r)));
  try {
    const first = b.submit(); const asked = await b.run(); assert.equal(asked.state, 'input-required');
    b.tasks.reply(principal, { taskId: first.id, answer: 'Record acceptance requirements', requestId: 'reply' });
    const done = await b.run(); assert.equal(done.state, 'completed'); assert.equal(done.delegation!.request.revision, 2); assert.equal(done.delegation!.request.originalGoal, first.goal);
    assert.equal(done.delegation!.request.messages.length, 2); assert.equal(done.runs!.length, 3); assert(verifyBrief(done.artifact!, { goal: 'Prepare a brief', deliverable: 'Record acceptance requirements' }));
  } finally { b.store.close(); }
});

test('registered ontology predicates satisfy JSON/brief-only conditions; unsupported conditions stay unknown', async () => {
  const b = backend(createExecutionCatalog());
  try {
    b.submit({ requirements: [{ id: 'json', kind: 'condition', strength: 'hard', expected: { predicate: 'brief.json' } }, { id: 'only', kind: 'condition', strength: 'hard', expected: { predicate: 'execution.none' } }] });
    const done = await b.run(); assert.equal(done.state, 'completed'); assert(done.delegation!.acceptance!.checks.every(c => c.result === 'pass'));
    b.submit({ requirements: [{ id: 'unknown', kind: 'condition', strength: 'hard', expected: { predicate: 'physical.delivery' } }] });
    await assert.rejects(b.run(), /hard requirements/);
  } finally { b.store.close(); }
});

test('CSV full-audit contract rejects subsets; approval, snapshot and independent verification use new backend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-v2-')); writeFileSync(join(dir, 'sample.csv'), 'record_id,email,amount_cny,event_date\nA,bad,-1,2026-02-30\n');
  const catalog = createExecutionCatalog({ csvInputDirectory: dir });
  const b = backend(catalog, reasoner(r => interpretation(r, 'data.quality.audit.simulated', { fileName: 'sample.csv', checks: [...CSV_CHECKS] })));
  try {
    const adapter = new CsvAuditAdapter(dir);
    await assert.rejects(adapter.prepare({ owner, request: { id: 'test', revision: 1, originalGoal: 'audit', requirements: [], messages: [] } }, { fileName: 'sample.csv', checks: ['invalid_email'] }), /all five/);
    b.submit({ goal: 'Audit sample.csv' }); const ready = await b.run(); const plan = ready.delegation!.plan!;
    assert.equal(ready.state, 'auth-required');  assert.equal(ready.artifact, undefined); assert(!JSON.stringify(plan).includes('base64'));
    const approval = { requestId: 'approve', action: 'confirm_simulated_payment', quoteId: plan.quote!.id, quoteDigest: plan.quote!.digest };
    assert.throws(() => b.tasks.authorize(principal, ready.id, { ...approval, quoteDigest: '0'.repeat(64) }), /Exact/);
    b.tasks.authorize(principal, ready.id, approval); b.tasks.authorize(principal, ready.id, approval);
    const done = await b.run(); assert.equal(done.state, 'completed'); assert(done.delegation!.acceptance!.accepted);
    assert.equal(done.delegation!.request.revision, 1); assert.equal(b.store.observations(owner, done.delegation!.intentId!).length, 1);
    const authorizations = b.store.ontology.query(owner, { from: { type: 'ServiceRequest', id: done.id }, link: 'authorizations' }).items;
    assert.equal(authorizations.length, 1); assert.equal(authorizations[0]!.properties.kind, 'simulation_approval');
    assert.equal(authorizations[0]!.properties.environment, 'local_simulation');
    assert.equal(b.store.ontology.query(owner, { from: authorizations[0]!.ref, link: 'attempts' }).items.length, 1);
    assert.equal(b.store.grants(owner, done.id).length, 0, 'A local quote approval is never a sandbox or real payment permit');
    assert.throws(() => b.store.intent('different-owner', done.delegation!.intentId!), /not found/);
  } finally { b.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('execution is outside the database transaction; late facts survive cancellation without completing the task', async () => {
  let release!: () => void; let started!: () => void; const waiting = new Promise<void>(r => { release = r; }); const dispatched = new Promise<void>(r => { started = r; });
  let calls = 0;
  const adapter = fixtureAdapter('one', {}, { execute: async ctx => { calls++; b.store.transaction(() => {}); started(); await waiting; return { artifact: { id: randomUUID(), name: 'fixture', data: { goal: ctx.request.originalGoal, deliverable: 'Late fixture', execution: 'completed' } }, facts: {}, evidenceRefs: ['late-fixture'] }; } });
  const b = backend(new ExecutionCatalog([fixtureCapability], [fixtureBinding('one')], [adapter]), reasoner(r => interpretation(r, 'fixture.supply', {})));
  try {
    const first = b.submit(); const running = b.run(); await dispatched;
    b.tasks.cancel(principal, first.id); release(); await running;
    const current = b.store.get(owner, first.id); assert.equal(current.state, 'canceled'); assert.equal(current.artifact, undefined); assert.equal(calls, 1);
    assert.equal(b.store.observations(owner, current.delegation!.intentId!).length, 1);
    assert.equal(b.store.claim(['eigos.delegate'], 15000), undefined);
  } finally { release(); b.store.close(); }
});

test('failed independent verification cannot create a completed artifact', async () => {
  const b = backend(new ExecutionCatalog([fixtureCapability], [fixtureBinding('one')], [fixtureAdapter('one', {}, { verify: () => ({ accepted: false, reason: 'Rejected by independent fixture verifier' }) })]), reasoner(r => interpretation(r, 'fixture.supply', {})));
  try { b.submit(); const job = await b.run(); assert.equal(job.state, 'failed'); assert.equal(job.artifact, undefined); assert(!job.delegation!.acceptance!.accepted); }
  finally { b.store.close(); }
});

test('historical delegations are readable but never claimed, continued, canceled or migrated', () => {
  const b = backend(createExecutionCatalog());
  try {
    const job = b.submit(); const historical = JSON.parse(JSON.stringify(job)); delete historical.delegation.backendVersion;
    historical.state = 'input-required'; b.store.save(owner, historical);
    assert.throws(() => b.tasks.reply(principal, { taskId: job.id, answer: 'continue', requestId: 'x' }), /read-only/);
    assert.throws(() => b.tasks.cancel(principal, job.id), /read-only/);
    historical.state = 'working'; b.store.save(owner, historical);
    assert.equal(b.store.claim(['eigos.delegate'], 15000), undefined); assert.equal(b.tasks.get(principal, job.id).state, 'working');
    assert.equal(b.tasks.get(principal, job.id).delegation?.backendVersion, undefined);
  } finally { b.store.close(); }
});

test('new backend does not advertise or accept legacy direct-execution fallbacks', () => {
  const b = backend(createExecutionCatalog());
  try {
    assert.deepEqual(b.tasks.services().map(s => s.id), ['eigos.delegate']);
    for (const service of ['brief.prepare', 'agent.execute', 'meituan.paotui.read']) assert.throws(() => b.tasks.submit(principal, { service, goal: 'fixture', requestId: randomUUID() }), /Invalid input/);
    const now = new Date().toISOString();
    const old: Job = { id: randomUUID(), contextId: randomUUID(), service: 'brief.prepare', goal: 'Historical direct-service fixture', state: 'input-required', messages: [{ id: 'legacy-request', role: 'user', text: 'Historical direct-service fixture', at: now }], createdAt: now, updatedAt: now };
    b.store.save(owner, old);
    assert.throws(() => b.tasks.reply(principal, { taskId: old.id, answer: 'continue', requestId: 'old-reply' }), /read-only/);
    assert.throws(() => b.tasks.cancel(principal, old.id), /read-only/);
  } finally { b.store.close(); }
});

test('canonical plan serialization is property-order independent and new tasks identify the backend', () => {
  assert.equal(canonical({ z: 1, a: { c: 2, b: 3 } }), canonical({ a: { b: 3, c: 2 }, z: 1 }));
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  const b = backend(createExecutionCatalog()); try { assert.equal(b.submit().delegation!.backendVersion, BACKEND_VERSION); } finally { b.store.close(); }
});

test('resolver retains unknown facts and unavailable providers without inventing supply', async () => {
  const adapter = fixtureAdapter('one', {}); adapter.prepare = async () => { throw new Error('channel unavailable'); };
  const catalog = new ExecutionCatalog([fixtureCapability], [fixtureBinding('one')], [adapter]);
  const resolver = new CapabilityResolver(catalog);
  const result = await resolver.resolve({ owner, request: { id: 'request', revision: 1, originalGoal: 'coffee', messages: [], requirements: [] } }, fixtureCapability.ref, {}, new AbortController().signal);
  assert.equal(result.candidates[0]!.status, 'unavailable'); assert.deepEqual(result.candidates[0]!.facts, {}); assert.equal(result.scope.realSupply, false);
});

test('lease loss preserves late observations and never replays a started action', async () => {
  let release!: () => void; let started!: () => void;
  const waiting = new Promise<void>(r => { release = r; }); const dispatched = new Promise<void>(r => { started = r; });
  let calls = 0;
  const adapter = fixtureAdapter('one', {}, { execute: async ctx => { calls++; started(); await waiting; return { artifact: { id: randomUUID(), name: 'fixture', data: { goal: ctx.request.originalGoal, deliverable: 'Late observed result', execution: 'completed' } }, facts: {}, evidenceRefs: ['fixture-late'] }; } });
  const b = backend(new ExecutionCatalog([fixtureCapability], [fixtureBinding('one')], [adapter]), reasoner(r => interpretation(r, 'fixture.supply', {})));
  let running: Promise<import('../packages/core/domain.js').Job> | undefined;
  try {
    const job = b.submit(); running = b.run(); await dispatched;
    const recovery = b.store.claim(['eigos.delegate'], 15000, Date.now() + 30000); assert(recovery);
    assert.equal(b.store.get(owner, job.id).state, 'working'); release(); await running;
    const pending = b.store.get(owner, job.id); assert.equal(pending.artifact, undefined); assert.equal(calls, 1);
    assert.equal(b.store.observations(owner, pending.delegation!.intentId!).length, 1);
    await b.coordinator.run(recovery, new AbortController().signal);
    assert.equal(b.store.get(owner, job.id).state, 'completed'); assert.equal(calls, 1);
    assert.throws(() => b.store.dispatchIntent(owner, pending.delegation!.intentId!), /automatic replay/);
  } finally { release(); await running?.catch(() => {}); b.store.close(); }
});

test('fixed plan cannot switch to a different binding version or a disabled provider at execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-v2-pin-')); writeFileSync(join(dir, 'sample.csv'), 'record_id,email,amount_cny,event_date\nA,a@example.test,1,2026-10-17\n');
  const catalog = createExecutionCatalog({ csvInputDirectory: dir });
  const b = backend(catalog, reasoner(r => interpretation(r, 'data.quality.audit.simulated', { fileName: 'sample.csv', checks: [...CSV_CHECKS] })));
  try {
    b.submit(); const ready = await b.run(); const csvRef = ready.delegation!.plan!.capabilityRef;
    const original = catalog.bindings(csvRef, owner)[0]!;
    for (const binding of [{ ...original, enabled: false }, { ...original, ref: { ...original.ref, version: '3' } }]) {
      const replacement = new ExecutionCatalog([catalog.capability(csvRef)], [binding], [new CsvAuditAdapter(dir)]);
      b.tasks.authorize(principal, ready.id, { requestId: 'approve', action: 'confirm_simulated_payment', quoteId: ready.delegation!.plan!.quote!.id, quoteDigest: ready.delegation!.plan!.quote!.digest });
      const claim = b.store.claim(['eigos.delegate'], 15000)!;
      await assert.rejects(new ActionRuntime(b.store, replacement).run(claim, new AbortController().signal), /unavailable/);
      assert.equal(b.store.intent(owner, ready.delegation!.intentId!).state, 'ready'); b.store.release(claim);
    }
  } finally { b.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('damaged private input is rejected after restart and cannot deliver a report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-v2-damaged-')); const path = join(dir, 'tasks.sqlite');
  writeFileSync(join(dir, 'sample.csv'), 'record_id,email,amount_cny,event_date\nA,a@example.test,1,2026-10-17\n');
  const catalog = createExecutionCatalog({ csvInputDirectory: dir });
  const b = backend(catalog, reasoner(r => interpretation(r, 'data.quality.audit.simulated', { fileName: 'sample.csv', checks: [...CSV_CHECKS] })), new JobStore(path));
  let reopened: JobStore | undefined;
  try {
    b.submit(); const ready = await b.run(); const plan = ready.delegation!.plan!;
    b.tasks.authorize(principal, ready.id, { requestId: 'approve', action: 'confirm_simulated_payment', quoteId: plan.quote!.id, quoteDigest: plan.quote!.digest });
    const intent = b.store.intent(owner, ready.delegation!.intentId!); const corrupt = intent.privateData as { base64: string }; corrupt.base64 = Buffer.from('damaged').toString('base64');
    b.store.close(); const db = new DatabaseSync(path); db.prepare('UPDATE action_intents SET private_data=? WHERE id=?').run(JSON.stringify(corrupt), intent.id); db.close();
    reopened = new JobStore(path); const claim = reopened.claim(['eigos.delegate'], 15000)!;
    await assert.rejects(new ActionRuntime(reopened, catalog).run(claim, new AbortController().signal), /snapshot changed/);
    assert.equal(reopened.get(owner, ready.id).artifact, undefined); assert.equal(reopened.observations(owner, intent.id).length, 0);
    assert.equal(reopened.attempts(owner, intent.id).length, 0);
  } finally { if (reopened) reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Worker distinguishes dispatched failures from rejected plans and retains model/observation evidence', async () => {
  const adapter = fixtureAdapter('one', {}, { execute: async () => { throw new Error('Synthetic execution failure'); } });
  const b = backend(new ExecutionCatalog([fixtureCapability], [fixtureBinding('one')], [adapter]), reasoner(r => interpretation(r, 'fixture.supply', {})));
  const worker = new Worker(b.store, { coordinator: b.coordinator, pollMs: 10 });
  try {
    const job = b.submit(); worker.start();
    for (let i = 0; i < 100 && b.store.get(owner, job.id).state !== 'failed'; i++) await new Promise(r => setTimeout(r, 10));
    const failed = b.store.get(owner, job.id); assert.equal(failed.state, 'failed'); assert.match(failed.error!, /recorded observations/);
    assert.equal(failed.runs!.length, 2); assert.equal(failed.artifact, undefined); assert.equal(b.store.observations(owner, failed.delegation!.intentId!).length, 1);
  } finally { await worker.close(); b.store.close(); }
});
