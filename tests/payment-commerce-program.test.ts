// Synthetic provider/model; real shared task, evidence and acceptance engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { digest } from '../packages/core/delegation.js';
import { ownerKey } from '../packages/core/domain.js';
import { readConfig } from '../packages/core/config.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import { commerceProviders, providerCapabilityIds, type CommerceProvider, type CommerceQuery } from '../packages/capabilities/payment-commerce/contracts.js';
import type { CommerceReadOptionsMap } from '../packages/capabilities/payment-commerce/program.js';
import { backend, interpretation, evidence, observeTaskContext, acknowledgeReads, syntheticGoalReview, owner, principal } from './backend-fixture.js';

const cases: { provider: CommerceProvider; query: CommerceQuery }[] = [
  { provider: 'alipay', query: { action: 'QueryAlipayTrade', parameters: { outTradeNo: 'original_order' } } },
  { provider: 'wechatpay', query: { action: 'QueryWechatPayTrade', parameters: { outTradeNo: 'original_order' } } },
  { provider: 'unionpay', query: { action: 'QueryUnionPayTrade', parameters: { orderId: 'originalorder', txnTime: '20261103120000' } } },
  { provider: 'taobao', query: { action: 'SearchTaobaoProducts', parameters: { query: '帽子', page: 1, limit: 3 } } },
  { provider: 'taobao', query: { action: 'GetTaobaoProducts', parameters: { itemIds: ['123', '9007199254740993'] } } },
];
test('All five provider actions complete as source reads without claiming a payment or fulfillment', { timeout: 300000 }, async () => {
  const store = new JobStore(':memory:'), calls: { provider: string; query: CommerceQuery }[] = [];
  let current = cases[0]!;
  const paymentCommerce: CommerceReadOptionsMap = Object.fromEntries(commerceProviders.map(provider => [provider, { connectionFile: `/synthetic/${provider}`, evidenceKind: 'fixture',
    connector: { invoke: async (query: CommerceQuery, signal: AbortSignal) => { signal.throwIfAborted(); calls.push({ provider, query }); return { result: { sourceState: 'SYNTHETIC_OBSERVATION' }, observedAt: new Date().toISOString() }; } },
  }]));
  const catalog = createExecutionCatalog({ store, paymentCommerce });
  const model: Reasoner = {
    reviewGoal: syntheticGoalReview,
    ground: async (request, _capabilities, _signal, access) => {
      const decision = { ...interpretation(observeTaskContext(access) ?? request, providerCapabilityIds[current.provider], current.query), capabilityRef: { id: providerCapabilityIds[current.provider], version: '1' } };
      return { decision, evidence: evidence() };
    },
    plan: async () => { throw new Error('No legacy recipe'); },
    act: async (ctx, _signal, access) => {
      observeTaskContext(access);
      access.session.call('describe_ontology', { actions: [current.query.action] }); access.session.call('query_ontology', { object: ctx.state.scope });
      const ref = ctx.state.observations[0];
      if (ref) {
        access.session.call('query_ontology', { object: ref });
        access.session.call('evaluate_ontology', { function: 'paymentCommerceReadStatus', object: ref });
      }
      const decision = { kind: ref ? 'complete' as const : 'execute' as const, requestRevision: ctx.request.revision, message: 'Synthetic exact provider read',
        steps: ref ? [] : [{ id: 'read', action: current.query.action, argumentsJson: JSON.stringify({ scope: ctx.state.scope }), dependsOn: [], inputRefs: [] }],
        completionJson: ref ? JSON.stringify({ observation: ref, rationale: 'Return the original source query' }) : '' };
      acknowledgeReads(access);
      return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
  };
  const b = backend(catalog, model, store);
  try {
    const other = ownerKey({ ...principal, subject: 'other-owner' });
    assert(!catalog.summaries(other).some(capability => Object.values(providerCapabilityIds).includes(capability.ref.id)));
    for (const row of cases) {
      current = row;
      const job = b.submit({ goal: `Read ${row.provider}, no order or payment`, executionEnvironment: 'sandbox' });
      for (let n = 0; n < 10 && ['submitted', 'working'].includes(store.get(owner, job.id).state); n++) await b.run();
      const done = store.get(owner, job.id);
      assert.equal(done.state, 'completed', JSON.stringify({ phase: done.delegation?.phase, feedback: done.delegation?.agent?.feedback, grounding: done.delegation?.groundingFeedback, recovery: done.delegation?.recovery }));
      assert.deepEqual(calls.at(-1), row);
      const output = done.artifact!.data.result as { providerRead: { provider: string; noBusinessWrites: boolean; paymentPerformedByEigos: boolean } };
      assert.equal(output.providerRead.provider, row.provider); assert.equal(output.providerRead.noBusinessWrites, true); assert.equal(output.providerRead.paymentPerformedByEigos, false);
      assert(!JSON.stringify(output).includes('/synthetic/')); assert(!JSON.stringify(output).includes('configurationDigest'));
      assert(done.delegation!.agent!.plans.every(plan => plan.steps.every(step => step.effect === 'read')));
      const ref = done.delegation!.agent!.observations[0]!;
      assert.equal(store.ontology.evaluate(owner, { function: 'paymentCommerceReadStatus', object: ref }).status, 'known');
    }
    assert.equal(calls.length, cases.length);
  } finally { store.close(); }
});
test('Provider reads are absent by default and reject public or ownerless configuration', () => {
  const store = new JobStore(':memory:');
  try { assert(!createExecutionCatalog({ store }).summaries(owner).some(capability => Object.values(providerCapabilityIds).includes(capability.ref.id))); }
  finally { store.close(); }
  const local = { EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(40), EIGOS_ALIPAY_CONNECTION_FILE: '/private/alipay.json' };
  assert.throws(() => readConfig(local), /explicit source owner/);
  const foundation = { EIGOS_AUTH_MODE: 'jwt', EIGOS_SECURITY_MODE: 'foundation', EIGOS_PERSONAL_SOURCE_OWNER: owner, PUBLIC_URL: 'https://primary.example',
    OIDC_AGENT_CLIENT_ID: 'synthetic-agent', OAUTH_ISSUER: 'https://issuer.example', OAUTH_JWKS_URL: 'https://issuer.example/jwks', OAUTH_AUDIENCE: 'https://primary.example/' };
  assert.throws(() => readConfig({ ...foundation, EIGOS_ALIPAY_CONNECTION_FILE: 'relative.json' }), /absolute/);
  assert.throws(() => readConfig({ ...local, EIGOS_PERSONAL_SOURCE_OWNER: owner, HOST: '0.0.0.0', PUBLIC_URL: 'https://public.example' }));
  assert.equal(readConfig({ ...foundation, EIGOS_ALIPAY_CONNECTION_FILE: '/private/alipay.json' }).EIGOS_ALIPAY_CONNECTION_FILE, '/private/alipay.json');
});
