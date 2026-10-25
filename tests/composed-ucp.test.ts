// Explicit deterministic model choices and local HTTP merchant; no live-model claim.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { digest } from '../packages/core/delegation.js';
import { JobStore } from '../packages/core/store.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import type { ActionDiscoveryPage } from '../packages/core/action-bindings.js';
import { acknowledgeReads, backend, evidence, observeTaskContext, owner, principal } from './backend-fixture.js';
import { ucpMerchant } from './fixtures/ucp-merchant.js';

async function setup() {
  const merchant = await ucpMerchant(), store = new JobStore(':memory:'), catalog = createExecutionCatalog({ store, ucpSandbox: merchant.options });
  const model: Reasoner = {
    ground: async (request, _caps, _signal, access) => {
      observeTaskContext(access);
      const decision = { kind: 'compose' as const, requestRevision: request.revision, message: 'One task with an original prepared checkout and independently confirmed order', requirementsJson: '[]', conditionsJson: '[]', criteriaJson: JSON.stringify([
        { id: 'prepare', predicate: 'ucp.checkout.prepared', phase: 'artifact', description: 'Original checkout prepared' },
        { id: 'confirm', predicate: 'ucp.order.confirmed', phase: 'commitment', description: 'Original order independently confirmed' },
      ].map(value => ({ ...value, messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: [] }))) };
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
    plan: async () => { throw new Error('Composed UCP cannot select a fixed recipe'); },
    act: async (ctx, _signal, access) => {
      observeTaskContext(access);
      const pin = (id: string) => { const bindings=(access.session.call('discover_actions', { actionId: id }) as ActionDiscoveryPage).items[0]!.bindings; assert(bindings.every(b=>!b.pin.programRef.id.startsWith('services.compose.')), 'Native leaves cannot substitute an explicit orchestration context'); return bindings[0]!.pin; };
      const base: AgentDecision = { kind: 'execute', requestRevision: ctx.request.revision, message: 'Choose a scoped atomic operation from accepted evidence', steps: [], completionJson: '' };
      let decision: AgentDecision;
      if (!ctx.state.composition!.contexts.length) decision = { ...base, kind: 'prepare', contexts: [
        { id: 'prepare', bindingDigest: pin('ReadUcpCreateTerms').digest, inputJson: JSON.stringify({ items: [{ id: 'roses', quantity: 2 }], fulfillmentProfile: 'office' }) },
        { id: 'confirm', bindingDigest: pin('ReadUcpConfirmationTerms').digest, inputJson: JSON.stringify({ budget: { minor: '10000', currency: 'USD' } }) },
      ] };
      else {
        const observations = ctx.state.observations.map(ref => store.ontology.read(owner, ref));
        const prepared = observations.find(value => value.ref.type === 'UcpCheckoutObservation' && (value.properties.snapshot as { operation: string }).operation === 'prepare');
        const confirmed = observations.find(value => value.ref.type === 'UcpCheckoutObservation' && (value.properties.snapshot as { operation: string }).operation === 'confirm');
        if (confirmed && prepared) {
          access.session.call('query_ontology', { object: prepared.ref }); access.session.call('query_ontology', { object: confirmed.ref });
          decision = { ...base, kind: 'complete', completionJson: JSON.stringify({ components: [{ contextId: 'prepare', proposalJson: JSON.stringify({ result: prepared.ref }) }, { contextId: 'confirm', proposalJson: JSON.stringify({ result: confirmed.ref }) }], criteria: ['prepare', 'confirm'].map(id => ({ id, contextIds: [id] })), conditions: [] }) };
        } else {
          const contextId = prepared ? 'confirm' : 'prepare', scope = ctx.state.composition!.contexts.find(value => value.id === contextId)!.scope;
          const terms = observations.find(value => value.ref.type === 'UcpOperationTerms' && digest((value.properties.receipt as { scope: unknown }).scope) === digest(scope));
          access.session.call('query_ontology', { object: scope });
          if (terms) access.session.call('query_ontology', { object: terms.ref });
          if (prepared) access.session.call('query_ontology', { object: prepared.ref });
          const action = contextId === 'prepare' ? terms ? 'CreateUcpCheckout' : 'ReadUcpCreateTerms' : terms ? 'ConfirmUcpCheckout' : 'ReadUcpConfirmationTerms';
          decision = { ...base, steps: [{ id: action, action, contextId, bindingDigest: pin(action).digest, argumentsJson: JSON.stringify({ scope, ...(terms ? { terms: terms.ref } : prepared ? { checkout: prepared.ref } : {}) }), dependsOn: [], inputRefs: [], contributesTo: [contextId] }] };
        }
      }
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
  };
  assert(catalog.agentProgram({id:'services.compose.sandbox',version:'1'},owner), 'Explicit orchestration remains available through its own contract');
  const b = backend(catalog, model, store, { allowSandbox: true });
  const submit = () => b.submit({ goal: '仅在隔离沙箱准备结账并确认同一订单；独立核验结账与订单，不要求配送。', executionEnvironment: 'sandbox' });
  const approve = (id: string) => { const a = store.get(owner, id).delegation!.authorizationRequest!; b.tasks.authorize(principal, id, { action: 'approve_plan', requestId: randomUUID(), planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' }); };
  const run = async (id: string) => {
    if (store.get(owner, id).state === 'auth-required') approve(id);
    // Direct test driving has no Worker heartbeat. Bound the lease to the same
    // execution wait and release it even when a transient read needs recovery.
    const claim = store.claim(['eigos.delegate'], 120000);
    if (claim) { try { await b.coordinator.run(claim, new AbortController().signal); } finally { store.release(claim); } }
    else await pause(100);
    return store.get(owner, id);
  };
  const finish = async (id: string) => {
    const deadline = Date.now() + 120000;
    while (['submitted', 'working', 'auth-required'].includes(store.get(owner, id).state) && Date.now() < deadline) await run(id);
    return store.get(owner, id);
  };
  return { merchant, store, b, submit, approve, run, finish, close: async () => { store.close(); await merchant.close(); } };
}

test('one goal composes two UCP bindings without pretending its preparation task already completed', async () => {
  const t = await setup(); try {
    const id = t.submit().id;
    const done = await t.finish(id);
    assert.equal(done.state, 'completed', JSON.stringify({ error: done.error, feedback: done.delegation?.agent?.feedback, assessment: done.delegation?.agent?.composition?.assessment }));
    assert.deepEqual(t.merchant.counts(), { creates: 1, completes: 1 });
    assert.equal(done.delegation!.plan, undefined); assert.equal(t.store.grants(owner, id).length, 2);
    assert.equal(t.store.ontology.query(owner, { type: 'CheckoutRequest' }).items.length, 2, 'Independent scopes retain their separate immutable requirements');
    assert.equal(t.store.ontology.query(owner, { type: 'Payment' }).items.length, 0, 'Mock checkout completion is not independent payment evidence');
    assert.equal(t.store.ontology.query(owner, { type: 'Order' }).items[0]!.properties.fulfillmentState, 'pending');
  } finally { await t.close(); }
});

test('composed UCP rechecks changed quote after approval and retains the useful preparation only', async () => {
  const t = await setup(); try {
    const id = t.submit().id;
    for (let i = 0; i < 10; i++) { await t.run(id); const job = t.store.get(owner, id); if (job.state === 'auth-required' && job.delegation!.authorizationRequest!.effects.includes('order')) break; }
    t.approve(id); const checkout = [...t.merchant.checkouts.values()][0]!; checkout.totals[0].amount += 100;
    const stopped = await t.run(id);
    assert.notEqual(stopped.state, 'completed'); assert.equal(t.merchant.counts().completes, 0);
    assert.equal(stopped.artifact?.data.execution, 'partial');
    assert.equal(t.store.ontology.query(owner, { type: 'UcpCheckoutObservation' }).items.length, 1);
  } finally { await t.close(); }
});

test('composed UCP lost completion response queries the original checkout and keeps exactly one write', async () => {
  const t = await setup(); try {
    const id = t.submit().id; t.merchant.flags.dropComplete = true;
    const done = await t.finish(id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.deepEqual(t.merchant.counts(), { creates: 1, completes: 1 });
    assert.equal(t.merchant.requests.filter(value => value.method === 'POST' && value.path.endsWith('/complete')).length, 1);
    assert(t.merchant.requests.some(value => value.method === 'GET' && value.path.startsWith('/orders/')));
  } finally { await t.close(); }
});


for (const change of ['revoke', 'cancel'] as const) test(`composed UCP ${change} during quote preflight prevents the subsequent provider write`, async () => {
  const t = await setup(); try {
    const id = t.submit().id;
    for (let i = 0; i < 10; i++) { await t.run(id); const job = t.store.get(owner, id); if (job.state === 'auth-required' && job.delegation!.authorizationRequest!.effects.includes('order')) break; }
    t.approve(id);
    t.merchant.flags.beforeCheckoutReadResponse = async () => {
      t.merchant.flags.beforeCheckoutReadResponse = undefined;
      if (change === 'cancel') t.b.tasks.cancel(principal, id); else t.b.tasks.revokeAuthorization(principal, id, randomUUID());
    };
    await t.run(id);
    assert.equal(t.merchant.counts().completes, 0);
    assert.equal(t.merchant.requests.filter(value => value.path.endsWith('/complete')).length, 0);
    assert.notEqual(t.store.get(owner, id).state, 'completed');
    if (change === 'cancel') assert.equal(t.store.get(owner, id).state, 'canceled');
  } finally { await t.close(); }
});
