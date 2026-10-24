// Deterministic model fixture with an independent authenticated loopback provider.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { digest } from '../packages/core/delegation.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import type { ActionDiscoveryPage } from '../packages/core/action-bindings.js';
import { acknowledgeReads, backend, evidence, observeTaskContext, owner, principal } from './backend-fixture.js';
import { createBusinessProvider } from './fixtures/business-provider.js';
import { sandboxOrderSchema } from '../packages/capabilities/sandbox-service.js';
import { sourceProof } from '../packages/ontology/object-evidence.js';

async function setup(unusedSource = false) {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-composed-sandbox-')), token = randomUUID() + randomUUID(), control = randomUUID(), tokenFile = join(directory, 'provider-token');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const provider = createBusinessProvider(':memory:', token, control); provider.server.listen(0, '127.0.0.1'); await once(provider.server, 'listening');
  const address = provider.server.address(); assert(address && typeof address !== 'string'); const endpoint = `http://127.0.0.1:${address.port}`;
  const store = new JobStore(':memory:'), catalog = createExecutionCatalog({ store, sandbox: { endpoint, tokenFile } });
  const model: Reasoner = {
    ground: async (request, _caps, _signal, access) => {
      observeTaskContext(access); const remedy = request.outcome;
      const decision = { kind: 'compose' as const, requestRevision: request.revision, message: 'Keep the exact requested simulator business endpoint', requirementsJson: '[]', conditionsJson: '[]', criteriaJson: JSON.stringify([{ id: 'result', description: 'Independently observed original business endpoint', predicate: remedy === 'refund' ? 'refund.confirmed' : remedy === 'cancel' ? 'order.canceled' : 'delivery.confirmed', phase: remedy === 'refund' ? 'payment' : remedy === 'cancel' ? 'fact' : 'delivery', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: request.requirements.map(value => value.id) }]) };
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
    plan: async () => { throw new Error('Sandbox composition cannot copy a fixed recipe'); },
    act: async (ctx, _signal, access) => {
      observeTaskContext(access); const pin = (actionId: string) => (access.session.call('discover_actions', { actionId }) as ActionDiscoveryPage).items[0]!.bindings[0]!.pin;
      const base: AgentDecision = { kind: 'execute', requestRevision: ctx.request.revision, message: 'Choose the next independently scoped simulator action', steps: [], completionJson: '' };
      let decision: AgentDecision;
      const component = ctx.state.composition!.contexts[0];
      if (!component) {
        const caseId = store.get(owner, ctx.request.id).delegation!.afterSalesCaseId;
        if (caseId) access.session.call('query_ontology', { object: { type: 'AfterSalesCase', id: caseId } });
        decision = { ...base, kind: 'prepare', contexts: [{ id: 'service', bindingDigest: pin(caseId ? 'ReadSandboxRemedyOrder' : 'ReadSandboxQuote').digest, inputJson: JSON.stringify(caseId ? { caseId } : { quantity: 2, unit: '杯' }) }, ...(unusedSource && !caseId ? [{ id: 'unused', bindingDigest: pin('PrepareTaskBrief').digest, inputJson: JSON.stringify({ goal: ctx.request.originalGoal, deliverable: 'Unused fixture scope' }) }] : [])] };
      } else {
        const scope = component.scope; access.session.call('query_ontology', { object: scope });
        const objects = ctx.state.observations.map(ref => store.ontology.read(owner, ref));
        const quote = objects.find(value => value.ref.type === 'SandboxQuoteObservation');
        const latest = objects.filter(value => value.ref.type === 'SandboxOrderObservation').sort((a, b) => sandboxOrderSchema.parse(b.properties.record).version - sandboxOrderSchema.parse(a.properties.record).version)[0];
        if (quote) access.session.call('query_ontology', { object: quote.ref });
        if (latest) access.session.call('query_ontology', { object: latest.ref });
        const record = latest ? sandboxOrderSchema.parse(latest.properties.record) : undefined;
        const done = ctx.request.outcome === 'refund' ? record?.refundState === 'refunded' : ctx.request.outcome === 'cancel' ? record?.orderState === 'canceled' : record && ['partial', 'delivered', 'failed'].includes(record.fulfillmentState);
        if (done) decision = { ...base, kind: 'complete', completionJson: JSON.stringify({ components: [{ contextId: 'service', proposalJson: JSON.stringify({ result: latest!.ref }) }], criteria: [{ id: 'result', contextIds: ['service'] }], conditions: [] }) };
        else {
          const action = ctx.request.outcome ? latest ? ctx.request.outcome === 'refund' ? 'ExecuteSandboxRefund' : 'ExecuteSandboxCancel' : 'ReadSandboxRemedyOrder'
            : !quote ? 'ReadSandboxQuote' : !latest ? 'SubmitSandboxOrder' : record!.paymentState !== 'paid' ? 'ExecuteSandboxPayment' : 'AwaitSandboxDelivery';
          const input = { scope, ...(action === 'SubmitSandboxOrder' ? { quote: quote!.ref } : latest ? { order: latest.ref } : {}), ...(action === 'ExecuteSandboxRefund' || action === 'ExecuteSandboxCancel' ? { reason: '用户请求原订单补救' } : {}) };
          decision = { ...base, steps: [{ id: action, action, contextId: 'service', bindingDigest: pin(action).digest, argumentsJson: JSON.stringify(input), dependsOn: [], inputRefs: [], contributesTo: ['result'] }] };
        }
      }
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
  };
  const b = backend(catalog, model, store, { allowSandbox: true });
  const api = async (path: string, input?: object) => { const response = await fetch(`${endpoint}/_control/${path}`, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${control}`, 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) }); assert(response.ok); return response.json(); };
  const approve = (id: string) => { const a = store.get(owner, id).delegation!.authorizationRequest!; b.tasks.authorize(principal, id, { action: 'approve_plan', requestId: randomUUID(), planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' }); };
  const run = async (id: string) => { if (store.get(owner, id).state === 'auth-required') approve(id); const claim = store.claim(['eigos.delegate'], 15000); if (claim) await b.coordinator.run(claim, new AbortController().signal); else await pause(120); return store.get(owner, id); };
  return { store, catalog, b, api, approve, run, submit: () => b.submit({ goal: '仅在隔离模拟服务中完成 2 杯履约并核验实际送达。', executionEnvironment: 'sandbox' }), close: () => { store.close(); provider.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('composed simulator uses four model-selected atomic operations and independent delivery evidence', async () => {
  const t = await setup(); try {
    const id = t.submit().id;
    for (let i = 0; i < 20; i++) { await t.run(id); const ledger = await t.api('ledger'); if (ledger.counters.charges === 1) { assert.notEqual(t.store.get(owner, id).state, 'completed'); await t.api('advance', { orderId: ledger.orders[0].id, fulfillment: 'delivered' }); break; } }
    for (let i = 0; i < 15 && ['submitted', 'working', 'auth-required'].includes(t.store.get(owner, id).state); i++) await t.run(id);
    const done = t.store.get(owner, id), ledger = await t.api('ledger');
    assert.equal(done.state, 'completed', JSON.stringify({ error: done.error, grounding: done.delegation?.groundingFeedback, recovery: done.delegation?.recovery, feedback: done.delegation?.agent?.feedback, assessment: done.delegation?.agent?.composition?.assessment }));
    assert.equal(done.delegation!.plan, undefined); assert.deepEqual(done.delegation!.agent!.plans.map(plan => plan.steps[0]!.action), ['ReadSandboxQuote', 'SubmitSandboxOrder', 'ExecuteSandboxPayment', 'AwaitSandboxDelivery']);
    assert.equal(ledger.counters.ordersCreated, 1); assert.equal(ledger.counters.charges, 1); assert.equal(t.store.grants(owner, id).length, 2);
    for (const type of ['Order', 'Payment', 'Shipment', 'DeliveryEvent', 'DeliveryAllocation']) { const objects = t.store.ontology.query(owner, { type }).items; assert.equal(objects.length, 1); assert.deepEqual(sourceProof(t.store.ontology, owner, objects[0]!.ref, { remaining: 1000 })?.levels, ['synthetic']); }
  } finally { t.close(); }
});

test('partial delivery stays incomplete and refund preserves its original order even when an unrelated source becomes unavailable', async () => {
  const t = await setup(true); try {
    const id = t.submit().id; let orderId = '';
    for (let i = 0; i < 20; i++) { await t.run(id); const ledger = await t.api('ledger'); if (ledger.counters.charges === 1) { orderId = ledger.orders[0].id; await t.api('advance', { orderId, fulfillment: 'partial', quantity: 1 }); break; } }
    for (let i = 0; i < 12 && ['submitted', 'working', 'auth-required'].includes(t.store.get(owner, id).state); i++) await t.run(id);
    assert.notEqual(t.store.get(owner, id).state, 'completed'); assert.equal(t.store.get(owner, id).artifact?.data.execution, 'partial');
    t.catalog.agentProgram({ id: 'brief.prepare.atomic', version: '1' }, owner)!.assertSourceAvailable = () => { throw new Error('Unrelated fixture source is unavailable'); };
    const remedy = t.b.tasks.requestRemediation(principal, { originalTaskId: id, action: 'refund', reason: '实际只交付一杯，申请原单退款', requestId: randomUUID() });
    assert.equal(remedy.state, 'submitted'); assert.equal(remedy.delegation!.plan, undefined);
    assert.equal(t.b.tasks.requestRemediation(principal, { originalTaskId: id, action: 'refund', reason: '重复请求', requestId: randomUUID() }).id, remedy.id);
    for (let i = 0; i < 24 && ['submitted', 'working', 'auth-required'].includes(t.store.get(owner, remedy.id).state); i++) { await t.run(remedy.id); const ledger = await t.api('ledger'); if (ledger.counters.refundRequests === 1 && ledger.counters.refundPayments !== 1) { assert.notEqual(t.store.get(owner, remedy.id).state, 'completed'); await t.api('advance', { orderId, refund: 'refunded' }); } }
    const done = t.store.get(owner, remedy.id), ledger = await t.api('ledger');
    assert.equal(done.state, 'completed', JSON.stringify({ error: done.error, grounding: done.delegation?.groundingFeedback, recovery: done.delegation?.recovery, feedback: done.delegation?.agent?.feedback, assessment: done.delegation?.agent?.composition?.assessment }));
    assert.equal(ledger.counters.refundRequests, 1); assert.equal(ledger.counters.refundPayments, 1); assert.equal(ledger.counters.ordersCreated, 1); assert.equal(ledger.counters.charges, 1);
    assert.deepEqual(done.delegation!.agent!.plans.map(plan => plan.steps[0]!.action), ['ReadSandboxRemedyOrder', 'ExecuteSandboxRefund']);
    assert.notEqual(t.store.get(owner, id).state, 'completed'); assert.equal(t.store.afterSales(owner, id)[0]!.state, 'resolved');
    assert.equal(t.store.ontology.query(owner, { type: 'Order' }).items.length, 1); assert.equal(t.store.ontology.query(owner, { type: 'Refund' }).items.length, 1);
    assert.equal(t.store.budget(owner, remedy.id).length, 0, 'Refund is not a new spend');
  } finally { t.close(); }
});
