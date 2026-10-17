import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBusinessProvider } from './fixtures/business-provider.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { SANDBOX_BINDING, SANDBOX_CAPABILITY } from '../packages/capabilities/sandbox-service.js';
import { backend, interpretation, owner, principal, reasoner } from './backend-fixture.js';
import type { Job } from '../packages/core/domain.js';
import type { ActionResult } from '../packages/ontology/actions.js';
import { ActionRuntime } from '../packages/coordinator/runtime.js';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-action-')); const token = randomUUID() + randomUUID(), control = randomUUID();
  const tokenFile = join(dir, 'provider-token'); writeFileSync(tokenFile, token, { mode: 0o600 });
  const provider = createBusinessProvider(':memory:', token, control); provider.server.listen(0, '127.0.0.1'); await once(provider.server, 'listening');
  const address = provider.server.address(); assert(address && typeof address !== 'string'); const endpoint = `http://127.0.0.1:${address.port}`;
  const query = { quantity: 20, unit: '杯', deadline: new Date(Date.now() + 600000).toISOString() };
  const catalog = createExecutionCatalog({ sandbox: { endpoint, tokenFile } });
  const b = backend(catalog, reasoner(r => ({ ...interpretation(r, SANDBOX_CAPABILITY.ref.id, query), capabilityRef: SANDBOX_CAPABILITY.ref })), undefined, { allowSandbox: true });
  const api = async (path: string, input?: object) => { const r = await fetch(endpoint + '/_control/' + path, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${control}`, 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) }); assert(r.ok); return r.json(); };
  const submit = () => b.submit({ executionEnvironment: 'sandbox', goal: '沙箱验证20杯、500元预算，禁止真实交易', requirements: [{ id: 'count', kind: 'quantity', strength: 'hard', expected: { amount: '20', unit: '杯' } }, { id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '50000', currency: 'CNY' } }, { id: 'deadline', kind: 'deadline', strength: 'hard', expected: { at: query.deadline, timezone: 'Asia/Shanghai', original: query.deadline } }, { id: 'delivered', kind: 'condition', strength: 'hard', expected: { predicate: 'delivery.confirmed' } }] });
  const approve = (job: Job, extra: object = {}) => {
    const scope = job.delegation!.authorizationRequest!;
    return b.tasks.authorize(principal, job.id, { action: 'approve_plan', requestId: randomUUID(), planDigest: scope.planDigest, allowedEffects: scope.effects, maxAmount: scope.maxAmount, payeeIds: scope.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox', ...extra });
  };
  const tick = async () => { await pause(120); return b.run(); };
  return { ...b, catalog, api, submit, approve, tick, close: () => { b.store.close(); provider.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('dependent actions consume accepted references; order/payment alone cannot satisfy a delivery goal', async () => {
  const f = await fixture();
  try {
    f.submit(); const offered = await f.run(); assert.equal(offered.state, 'auth-required');
    assert.equal(offered.delegation!.request.requirements.some(r => r.id === 'delivered'), false); assert.equal(offered.delegation!.request.successCriteria![0]!.id, 'delivered');
    assert.throws(() => f.approve(offered, { planDigest: '0'.repeat(64) }), /outside/);
    f.approve(offered); const pending = await f.run(); assert.equal(pending.state, 'working'); assert.equal(pending.artifact, undefined);
    const unresolved = f.store.providerEvidenceView(owner, SANDBOX_BINDING.ref); assert.equal(unresolved.sampleCount, 1); assert.equal(unresolved.taskStateCounts.working, 1); assert.equal(unresolved.outcomeCounts.unknown, 1);
    const ledger = await f.api('ledger'); assert.equal(ledger.counters.ordersCreated, 1); assert.equal(ledger.counters.charges, 1);
    assert.equal(f.store.budget(owner, pending.id).find(b => b.minor === '45000')!.state, 'consumed');
    await f.api('advance', { orderId: ledger.orders[0].id, fulfillment: 'delivered' });
    const done = await f.tick(); assert.equal(done.state, 'completed'); assert.equal(done.delegation!.outcome!.status, 'satisfied'); assert(done.delegation!.acceptance!.checks.every(c => c.result === 'pass'));
    assert.equal(f.store.intents(owner, done.id).length, 3);
    assert(f.store.providerFeedback(owner, SANDBOX_BINDING.ref).every((row: any) => row.evidenceLevel !== 'live_fulfillment'));
    assert.deepEqual(f.store.providerFeedback('other', SANDBOX_BINDING.ref), []);
    f.tasks.reconcile(principal, done.id, 'post-completion-status');
    for (let i = 0; i < 4 && f.store.get(owner, done.id).delegation!.recoveryPending; i++) { await pause(120); await f.run(); }
    assert.equal(f.tasks.get(principal, done.id).state, 'completed'); assert.equal(f.store.providerEvidenceView(owner, SANDBOX_BINDING.ref).evidenceLevelCounts.sandbox, 1);
    const unchanged = await f.api('ledger'); assert.equal(unchanged.counters.charges, 1); assert.equal(unchanged.counters.ordersCreated, 1);
  } finally { f.close(); }
});

test('partial delivery fails; linked refund stays pending until provider confirms the amount; original failure remains', async () => {
  const f = await fixture();
  try {
    f.submit(); const offered = await f.run(); f.approve(offered); const pending = await f.run();
    const ledger = await f.api('ledger'); await f.api('advance', { orderId: ledger.orders[0].id, fulfillment: 'partial', quantity: 15 });
    const failed = await f.tick(); assert.equal(failed.state, 'failed'); assert.equal(failed.artifact, undefined);
    const remedy = f.tasks.requestRemediation(principal, { originalTaskId: failed.id, action: 'refund', reason: '数量不足', requestId: 'refund' }); assert.notEqual(remedy.id, failed.id); assert.equal(remedy.state, 'auth-required');
    assert.equal(f.tasks.requestRemediation(principal, { originalTaskId: failed.id, action: 'refund', reason: '重复请求', requestId: 'refund-again' }).id, remedy.id);
    f.approve(remedy); const processing = await f.run(); assert.equal(processing.id, remedy.id); assert.equal(processing.state, 'working'); assert.equal(processing.artifact, undefined);
    await f.api('advance', { orderId: ledger.orders[0].id, refund: 'refunded' }); const refunded = await f.tick(); assert.equal(refunded.state, 'completed'); assert.equal(refunded.delegation!.outcome!.status, 'satisfied');
    assert.equal(f.tasks.get(principal, failed.id).state, 'failed'); assert.equal(f.tasks.get(principal, failed.id).afterSales![0]!.state, 'resolved');
    const graph = f.store.capabilityFacts(owner, SANDBOX_BINDING.ref); assert.equal(graph.summary.goalKindCounts.delivery, 1); assert.equal(graph.summary.goalKindCounts.refund, 1); assert(graph.changeProposals.every(p => p.publishable === false)); assert(graph.verifications.some(v => v.level === 'sandbox' && v.result === 'passed')); assert.equal(graph.summary.automaticPromotion, false);
    const last = await f.api('ledger'); assert.equal(last.counters.refundRequests, 1); assert.equal(last.counters.refundPayments, 1); assert.equal(last.counters.charges, 1);
  } finally { f.close(); }
});

test('duplicate/out-of-order receipts cannot roll back verified facts; conflicts and budget overruns are retained', async () => {
  const f = await fixture();
  try {
    f.submit(); const offered = await f.run(); f.approve(offered); const pending = await f.run();
    const intent = f.store.intents(owner, pending.id).find(i => i.stepId === 'delivery')!; const attempt = f.store.attempts(owner, intent.id)[0]!; const receipt = intent.lastResult!;
    assert.equal(f.store.recordObservation(owner, intent.id, attempt.id, receipt, true).applied, false);
    f.store.recordObservation(owner, intent.id, attempt.id, { kind: 'unknown', eventId: 'transient-network-error', sourceVersion: 99999, evidenceRefs: [], business: { payment: 'failed' } }, true);
    assert.equal(f.store.intent(owner, intent.id).businessSnapshot!.value.payment, 'paid');
    f.store.recordObservation(owner, intent.id, attempt.id, receipt, true);
    assert.equal(f.store.intent(owner, intent.id).state, 'awaiting_remote'); assert.equal(f.store.intent(owner, intent.id).failedQueries, 0);
    const stale: ActionResult = { ...receipt, eventId: 'older-receipt', sourceVersion: 1, business: { payment: 'not_started' } };
    assert.equal(f.store.recordObservation(owner, intent.id, attempt.id, stale, true).applied, false); assert.equal(f.store.intent(owner, intent.id).lastResult!.business!.payment, 'paid');
    f.store.recordObservation(owner, intent.id, attempt.id, { ...receipt, business: { payment: 'failed' } }, true);
    assert.equal(f.store.intent(owner, intent.id).state, 'needs_review'); assert.equal(f.store.observations(owner, intent.id).length, 4);
    const grant = f.store.grants(owner, pending.id)[0]!; const orderIntent = f.store.intents(owner, pending.id).find(i => i.stepId === 'order')!;
    assert.throws(() => f.store.transaction(() => f.store.reserveBudget(owner, intent.id, grant, { minor: '10000', currency: 'CNY' })), /Cumulative/);
    assert.equal(f.store.intent(owner, orderIntent.id).state, 'effect_confirmed'); assert.throws(() => f.store.intent('other', intent.id), /not found/);
  } finally { f.close(); }
});

test('total wait expiry stops automatic progress, preserves budget and permits only original-operation lookup', async () => {
  const f = await fixture();
  try {
    f.submit(); const offered = await f.run(); f.approve(offered); const pending = await f.run(); const before = f.store.budget(owner, pending.id);
    const runtime = new ActionRuntime(f.store, f.catalog, { allowSandbox: true, maxTaskMs: 1 }); await pause(10);
    const claim = f.store.claim(['eigos.delegate'], 15000, Date.now() + 1000)!; await runtime.run(claim, new AbortController().signal);
    const stopped = f.tasks.get(principal, pending.id); assert.equal(stopped.state, 'input-required'); assert.match(stopped.question!, /时限/); assert.deepEqual(f.store.budget(owner, pending.id), before);
    f.tasks.reconcile(principal, pending.id, 'one-original-lookup'); const lookup = f.store.claim(['eigos.delegate'], 15000)!; await runtime.run(lookup, new AbortController().signal);
    assert.equal(f.tasks.get(principal, pending.id).state, 'input-required'); assert.equal(f.store.claim(['eigos.delegate'], 15000), undefined);
    const ledger = await f.api('ledger'); assert.equal(ledger.counters.ordersCreated, 1); assert.equal(ledger.counters.charges, 1); assert.equal(ledger.counters.orderPostCalls, 1); assert.equal(ledger.counters.payPostCalls, 1);
  } finally { f.close(); }
});
