import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Job } from '../../packages/core/domain.js';
import type { ObjectRef } from '../../packages/ontology/model.js';
import type { ObjectView, ObjectQuery } from '../../packages/ontology/object-store.js';
import { FixtureProcesses } from '../fixtures/process-scope.js';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 15000; let last: T | undefined;
  while (Date.now() < deadline) { last = await read(); if (accept(last)) return last; await pause(30); }
  const diagnosticInput: unknown = last;
  const job = diagnosticInput && typeof diagnosticInput === 'object' && 'delegation' in diagnosticInput ? diagnosticInput as Job : undefined;
  const diagnostic = job ? { id: job.id, state: job.state, revision: job.revision, error: job.error, question: job.question,
    phase: job.delegation?.phase, recovery: job.delegation?.recovery, actions: job.delegation?.actions,
    authorizationBudget: job.delegation?.authorizationBudget, events: job.delegation?.events?.slice(-12) } : last;
  assert.fail(label + ': ' + JSON.stringify(diagnostic));
}
async function fixture(t: TestContext, fault: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-full-e2e-')); const paths: Record<string, string> = {};
  const mcp = new Client({ name: 'full-backend-e2e', version: '3' });
  const processes = new FixtureProcesses(t, async () => {
    try { await mcp.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const child = (file: string, env: NodeJS.ProcessEnv) => processes.start(resolve('dist/tests/fixtures', file + '.js'), env);
  for (const name of ['gateway', 'alternate', 'provider', 'control']) { const path = join(dir, name + '.token'); writeFileSync(path, randomUUID() + randomUUID(), { mode: 0o600 }); paths[name] = path; }
  const provider = await child('business-provider', { PROVIDER_DATABASE: join(dir, 'provider.sqlite'), PROVIDER_TOKEN_FILE: paths.provider, PROVIDER_CONTROL_TOKEN_FILE: paths.control });
  const providerUrl = `http://127.0.0.1:${provider.ready.port}`; const workers: Awaited<ReturnType<typeof child>>[] = [];
  const common = { EIGOS_AUTH_MODE: 'development', HOST: '127.0.0.1', EIGOS_COORDINATOR: 'codex', EIGOS_EXECUTOR: 'disabled', EIGOS_ACTION_SANDBOX: 'true', EIGOS_SANDBOX_PROVIDER_URL: providerUrl, EIGOS_SANDBOX_TOKEN_FILE: paths.provider, DATABASE_PATH: join(dir, 'tasks.sqlite') };
  const gateway = await child('ontology-gateway', { ...common, GATEWAY_TOKEN_FILE: paths.gateway, ALTERNATE_TOKEN_FILE: paths.alternate });
  const base = `http://127.0.0.1:${gateway.ready.port}`; const bearer = readFileSync(paths.gateway!, 'utf8'); const alternate = readFileSync(paths.alternate!, 'utf8');
  await mcp.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  const api = async (path: string, value?: object) => { const r = await fetch(providerUrl + '/_control/' + path, { method: value ? 'POST' : 'GET', headers: { Authorization: `Bearer ${readFileSync(paths.control!, 'utf8')}`, 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) }); assert(r.ok); return r.json(); };
  await api('faults', fault);
  const startWorker = async () => { const w = await child('ontology-worker', { ...common, PUBLIC_URL: base }); workers.push(w); return w; };
  await startWorker();
  const rpc = async (method: string, params: object, token = bearer) => { const r = await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) }); return r.json(); };
  const get = async (id: string) => { const r = await mcp.callTool({ name: 'get_task', arguments: { taskId: id } }); assert(!r.isError); return (r.structuredContent as { result: Job }).result; };
  const task = async (extra: object = {}) => {
    const deadline = new Date(Date.now() + 600000).toISOString(); const requestId = randomUUID();
    const args = { executionEnvironment: 'sandbox', goal: JSON.stringify({ sandbox: true, quantity: 20, unit: '杯', deadline }), requestId, requirements: [{ id: 'cups', kind: 'quantity', strength: 'hard', expected: { amount: '20', unit: '杯' } }, { id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '50000', currency: 'CNY' } }, { id: 'deadline', kind: 'deadline', strength: 'hard', expected: { at: deadline, timezone: 'Asia/Shanghai', original: deadline } }, { id: 'delivery', kind: 'condition', strength: 'hard', expected: { predicate: 'delivery.confirmed' } }], ...extra };
    const sent = await mcp.callTool({ name: 'submit_task', arguments: args }); assert(!sent.isError); const j = (sent.structuredContent as { result: Job }).result;
    const repeated = await mcp.callTool({ name: 'submit_task', arguments: args }); assert.equal((repeated.structuredContent as { result: Job }).result.id, j.id);
    return waitFor(() => get(j.id), x => x.state === 'auth-required', 'plan authorization');
  };
  const appPost = async (id: string, action: string, body: object) => { const r = await fetch(base + `/tasks/${id}/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const approve = async (j: Job, extra: object = {}) => {
    const request = j.delegation!.authorizationRequest!;
    const body = { action: 'approve_plan', requestId: randomUUID(), planDigest: request.planDigest, allowedEffects: request.effects, maxAmount: request.maxAmount, payeeIds: request.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox', ...extra };
    const r = await appPost(j.id, 'authorize', body); assert.equal(r.status, 200, JSON.stringify(r)); const retry = await appPost(j.id, 'authorize', body); assert.equal(retry.status, 200);
  };
  const query = async (args: ObjectQuery): Promise<ObjectView[]> => {
    const response = await mcp.callTool({ name: 'query_ontology', arguments: args });
    assert(!response.isError, JSON.stringify(response));
    const value = (response.structuredContent as { result: { items: ObjectView[]; page: { hasMore: boolean } } }).result;
    assert.equal(value.page.hasMore, false, 'Fixture readback must inspect the complete bounded relationship');
    return value.items;
  };
  const related = (from: ObjectRef, link: string) => query({ from, link, limit: 50 });
  const chain = async (id: string, judgment: 'satisfied' | 'unsatisfied') => {
    const request = { type: 'ServiceRequest', id };
    const parties = await related(request, 'requester'); assert.equal(parties.length, 1);
    const proposals = await related(request, 'proposals'); assert.equal(proposals.length, 1);
    const proposal = proposals[0]!;
    const engagements = await related(proposal.ref, 'engagements'); assert.equal(engagements.length, 1);
    assert.deepEqual((await related(engagements[0]!.ref, 'requester'))[0]!.ref, parties[0]!.ref);
    assert.equal((await related(engagements[0]!.ref, 'provider')).length, 1);
    const grants = await related(proposal.ref, 'authorizations'); assert(grants.length > 0);
    assert(grants.every(value => value.properties.environment === 'sandbox' && value.properties.kind === 'plan_grant'));
    for (const grant of grants) {
      assert.deepEqual((await related(grant.ref, 'approver'))[0]!.ref, parties[0]!.ref);
      const attempts = await related(grant.ref, 'attempts'); assert(attempts.length > 0, 'Every issued fixture permit was used for an actual dispatch');
      for (const attempt of attempts) assert.equal((await related(attempt.ref, 'step')).length, 1);
    }
    const results = await related(proposal.ref, 'businessResults'); assert(results.length > 0);
    for (const value of results) {
      assert.equal(value.properties.evidenceLevel, 'synthetic');
      assert.equal((await related(value.ref, 'executionResult')).length, 1);
      assert((await related(value.ref, 'sourceReceipts')).length >= 1);
      assert((await related(value.ref, 'subjects')).length > 0);
    }
    const assessments = await related(proposal.ref, 'assessments'); assert.equal(assessments.length, 1);
    assert.equal(assessments[0]!.properties.judgment, judgment);
    const findings = await related(assessments[0]!.ref, 'findings');
    assert.equal(findings.length, (assessments[0]!.properties.criterionResults as unknown[]).length);
    assert(findings.some(value => value.properties.origin === 'independent_verifier'));
    assert(findings.some(value => value.properties.origin === 'completion_target'));
    assert.equal((await related(assessments[0]!.ref, 'specification')).length, 1);
    assert((await related(assessments[0]!.ref, 'businessResults')).length > 0);
    const decisions = await related(request, 'businessDecisions');
    for (const action of ['SubmitServiceRequest', 'ProposeServiceExecution', 'AuthorizeProposal', 'AssessServiceOutcome']) assert(decisions.some(value => value.properties.actionId === action));
    return { request, proposal, engagement: engagements[0]!, grants, results, assessment: assessments[0]! };
  };
  return { dir, base, workers, task, get, approve, api, rpc, alternate, appPost, startWorker, mcp, query, related, chain, processes };
}

for (const crashAfter of ['order', 'payment'] as const) test(`E2E: remote ${crashAfter} success + Worker crash recovers by original key; two Workers never replay effects`, { timeout: 45000 }, async t => {
  const f = await fixture(t, crashAfter === 'order' ? { holdOrder: true } : { holdPayment: true });
  const offered = await f.task(); await f.approve(offered);
  const paid = await waitFor(() => f.api('ledger'), x => crashAfter === 'order' ? x.counters.ordersCreated === 1 : x.counters.charges === 1, 'remote business effect accepted');
  assert.equal((await f.get(offered.id)).state, 'working');
  await f.processes.stop(f.workers[0]!.process, 'SIGKILL');
  await f.startWorker(); await f.startWorker();
  await waitFor(() => f.get(offered.id), x => x.delegation!.actions?.find(a => a.stepId === 'payment')?.state === 'effect_confirmed', 'original payment reconciliation');
  const before = await f.get(offered.id); assert.equal(before.state, 'working'); assert.equal(before.artifact, undefined);
  await f.api('advance', { orderId: paid.orders[0].id, fulfillment: 'delivered' });
  const done = await waitFor(() => f.get(offered.id), x => x.state === 'completed', 'whole outcome accepted');
  assert.equal(done.delegation!.outcome!.status, 'satisfied'); assert(done.delegation!.acceptance!.checks.every(c => c.result === 'pass'));
  const last = await f.api('ledger'); assert.equal(last.counters.ordersCreated, 1); assert.equal(last.counters.charges, 1); assert.equal(last.counters.orderPostCalls, 1); assert.equal(last.counters.payPostCalls, 1); assert(last.counters.reconcileCalls >= 1);
  const a2a = await f.rpc('GetTask', { id: done.id }); assert.equal(a2a.result.status.state, 'TASK_STATE_COMPLETED');
  const other = await f.rpc('GetTask', { id: done.id }, f.alternate); assert(other.error); assert.equal(other.result, undefined);
  const chain = await f.chain(done.id, 'satisfied');
  const offer = (await f.related(chain.proposal.ref, 'selectedOffer'))[0]!;
  assert.equal(offer.ref.type, 'FulfillmentOffer');
  assert.deepEqual((await f.related(offer.ref, 'provider'))[0]!.ref, (await f.related(chain.engagement.ref, 'provider'))[0]!.ref);
  const budget = await f.mcp.callTool({ name: 'evaluate_ontology', arguments: { function: 'withinBudget', object: offer.ref, budget: { minor: '50000', currency: 'CNY' }, priceBasis: 'firm_quote' } });
  assert.equal((budget.structuredContent as { result: { value: string } }).result.value, 'pass');
  const order = (await f.related(chain.request, 'orders'))[0]!;
  assert.equal(order.properties.providerOrderReference, last.orders[0].id);
  const line = (await f.related(order.ref, 'lines'))[0]!;
  assert.equal((await f.related(line.ref, 'productVariant')).length, 0, 'No SKU is fabricated for a quantity-only simulator service');
  const remaining = await f.mcp.callTool({ name: 'evaluate_ontology', arguments: { function: 'remainingQuantity', object: line.ref } });
  assert.equal((remaining.structuredContent as { result: { value: { amount: string } } }).result.value.amount, '0');
});

test('E2E: revoked permits preserve in-flight facts and stop later payment until exact reauthorization', { timeout: 45000 }, async t => {
  const f = await fixture(t, { holdOrder: true }); const offered = await f.task(); await f.approve(offered);
  const created = await waitFor(() => f.api('ledger'), x => x.counters.ordersCreated === 1, 'remote order accepted');
  assert.equal((await f.appPost(offered.id, 'revoke-authorization', { requestId: randomUUID() })).status, 200);
  await waitFor(() => f.get(offered.id), x => x.delegation!.actions?.find(a => a.stepId === 'order')?.state === 'effect_confirmed', 'in-flight fact retained');
  assert.equal((await f.get(offered.id)).state, 'auth-required'); assert.equal((await f.api('ledger')).counters.charges ?? 0, 0);
  await f.approve(await f.get(offered.id)); await waitFor(() => f.api('ledger'), x => x.counters.charges === 1, 'reauthorized payment');
  await f.api('advance', { orderId: created.orders[0].id, fulfillment: 'delivered' }); await waitFor(() => f.get(offered.id), x => x.state === 'completed', 'accepted after reauthorization');
  const final = await f.api('ledger'); assert.equal(final.counters.ordersCreated, 1); assert.equal(final.counters.charges, 1);
  const chain = await f.chain(offered.id, 'satisfied'); assert.equal(chain.grants.length, 2);
  assert.equal(chain.grants.filter(grant => grant.properties.revoked === true).length, 1);
});

test('E2E: a real/default-environment request cannot be satisfied by a sandbox provider', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const result = await f.mcp.callTool({ name: 'submit_task', arguments: { goal: JSON.stringify({ sandbox: true, quantity: 20, unit: '杯' }), requestId: randomUUID() } }); assert(!result.isError);
  const job = (result.structuredContent as { result: Job }).result;
  const rejected = await waitFor(() => f.get(job.id), j => j.state === 'rejected', 'no synthetic fulfillment for real request');
  assert.equal(rejected.artifact, undefined); assert.equal(rejected.delegation!.intentId, undefined); assert.equal((await f.api('ledger')).counters.ordersCreated ?? 0, 0);
});

test('E2E: partial delivery fails, refund application is pending, receipt resolves linked task without rewriting original', { timeout: 45000 }, async t => {
  const f = await fixture(t); const offered = await f.task(); await f.approve(offered);
  const ledger = await waitFor(() => f.api('ledger'), x => x.counters.charges === 1, 'simulated payment');
  await f.api('advance', { orderId: ledger.orders[0].id, fulfillment: 'partial', quantity: 15 });
  const failed = await waitFor(() => f.get(offered.id), x => x.state === 'failed', 'partial must fail'); assert.equal(failed.artifact, undefined);
  const asked = await f.mcp.callTool({ name: 'request_remediation', arguments: { originalTaskId: failed.id, action: 'refund', reason: '数量不足', requestId: 'refund-once' } }); assert(!asked.isError);
  const remedy = (asked.structuredContent as { result: Job }).result; assert.notEqual(remedy.id, failed.id); await f.approve(remedy);
  await waitFor(() => f.api('ledger'), x => x.counters.refundRequests === 1, 'refund submitted');
  const pending = await f.get(remedy.id); assert.notEqual(pending.state, 'completed'); assert.equal(pending.artifact, undefined);
  await f.api('advance', { orderId: ledger.orders[0].id, refund: 'refunded' });
  const refunded = await waitFor(() => f.get(remedy.id), x => x.state === 'completed', 'refund actually observed'); assert.equal(refunded.delegation!.outcome!.status, 'satisfied');
  const original = await f.get(failed.id); assert.equal(original.state, 'failed'); assert.equal(original.afterSales![0]!.state, 'resolved');
  const retry = await f.mcp.callTool({ name: 'request_remediation', arguments: { originalTaskId: failed.id, action: 'refund', reason: '重新查询', requestId: 'another-message' } }); assert.equal((retry.structuredContent as { result: Job }).result.id, remedy.id);
  const last = await f.api('ledger'); assert.equal(last.counters.refundRequests, 1); assert.equal(last.counters.refundPayments, 1);
  const originalChain = await f.chain(failed.id, 'unsatisfied'), remedyChain = await f.chain(remedy.id, 'satisfied');
  assert.deepEqual((await f.related(originalChain.engagement.ref, 'provider'))[0]!.ref, (await f.related(remedyChain.engagement.ref, 'provider'))[0]!.ref);
  const cases = await f.related(originalChain.request, 'afterSalesCases'); assert.equal(cases.length, 1);
  assert.equal(cases[0]!.properties.progress, 'resolved');
  assert.deepEqual((await f.related(cases[0]!.ref, 'originalAssessment'))[0]!.ref, originalChain.assessment.ref);
  assert.deepEqual((await f.related(cases[0]!.ref, 'remedyAssessments'))[0]!.ref, remedyChain.assessment.ref);
  assert.deepEqual((await f.related(cases[0]!.ref, 'remedyRequest'))[0]!.ref, remedyChain.request);
  assert((await f.related(cases[0]!.ref, 'originalResults')).length > 0);
  assert((await f.related(cases[0]!.ref, 'remedyResults')).length > 0);
  const refunds = await f.related(cases[0]!.ref, 'refunds'); assert.equal(refunds.length, 1);
  assert.equal(refunds[0]!.properties.refundState, 'refunded');
  assert.deepEqual(refunds[0]!.properties.amount, { minor: '45000', currency: 'CNY' });
  const payment = (await f.related(refunds[0]!.ref, 'originalPayment'))[0]!;
  assert.equal(payment.properties.paymentState, 'paid');
  assert.deepEqual((await f.related(payment.ref, 'order'))[0]!.ref, (await f.related(cases[0]!.ref, 'order'))[0]!.ref);
});

test('E2E: cancel records late facts, prevents payment and uses a separately authorized business cancellation', { timeout: 45000 }, async t => {
  const f = await fixture(t, { holdOrder: true }); const offered = await f.task(); await f.approve(offered);
  const created = await waitFor(() => f.api('ledger'), x => x.counters.ordersCreated === 1, 'remote order accepted');
  const canceled = await f.rpc('CancelTask', { id: offered.id }); assert.equal(canceled.result.status.state, 'TASK_STATE_CANCELED');
  await waitFor(() => f.get(offered.id), x => x.delegation!.actions?.find(a => a.stepId === 'order')?.state === 'effect_confirmed', 'late order fact reconciled');
  const last = await f.api('ledger'); assert.equal(last.counters.charges ?? 0, 0); assert.equal(last.orders[0].orderState, 'confirmed'); assert.equal((await f.get(offered.id)).state, 'canceled');
  const requested = await f.appPost(offered.id, 'aftersales', { action: 'cancel', reason: '撤回订单', requestId: randomUUID() }); assert.equal(requested.status, 200); const remedy = requested.body.task as Job;
  await f.approve(remedy); await waitFor(() => f.get(remedy.id), x => x.state === 'completed', 'business cancellation confirmed');
  const final = await f.api('ledger'); assert.equal(final.orders[0].id, created.orders[0].id); assert.equal(final.orders[0].orderState, 'canceled'); assert.equal(final.counters.cancellations, 1); assert.equal(final.counters.charges ?? 0, 0);
});

test('E2E: cancellation during an unknown payment retains its budget until reconciliation and never completes the canceled goal', { timeout: 45000 }, async t => {
  const f = await fixture(t, { holdPayment: true }); const offered = await f.task(); await f.approve(offered);
  const paid = await waitFor(() => f.api('ledger'), x => x.counters.charges === 1, 'remote payment committed');
  const inFlight = await f.get(offered.id); assert.equal(inFlight.delegation!.authorizationBudget!.find(b => b.minor === '45000')!.state, 'held');
  assert.equal((await f.rpc('CancelTask', { id: offered.id })).result.status.state, 'TASK_STATE_CANCELED');
  const known = await waitFor(() => f.get(offered.id), x => x.delegation!.actions?.find(a => a.stepId === 'payment')?.state === 'effect_confirmed', 'payment result reconciled after cancellation');
  assert.equal(known.state, 'canceled'); assert.equal(known.artifact, undefined); assert.equal(known.delegation!.authorizationBudget!.find(b => b.minor === '45000')!.state, 'consumed');
  assert(known.delegation!.businessFacts!.some(fact => fact.snapshot.payment === 'paid'));
  await f.api('advance', { orderId: paid.orders[0].id, fulfillment: 'delivered' }); assert.equal((await f.get(offered.id)).state, 'canceled');
  const ledger = await f.api('ledger'); assert.equal(ledger.counters.charges, 1); assert.equal(ledger.counters.payPostCalls, 1);
});
