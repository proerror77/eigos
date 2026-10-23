import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupCommerce, commerceReads, commerceDecision, commerceStep } from './fixtures/commerce-agent.js';
import { owner, principal } from './backend-fixture.js';
import { AgentReadError } from '../packages/core/agent-program.js';
import { agentModelContext } from '../packages/coordinator/model-context.js';
import type { AgentPlanningContext, PlanningAccess } from '../packages/coordinator/coordinator.js';

function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const frontier = (ctx: AgentPlanningContext, access: PlanningAccess) => {
  commerceReads(ctx, access);
  return commerceDecision(ctx, [
    commerceStep('slow_context', 'ReadCommerceContext', { scope: ctx.state.scope }),
    commerceStep('directory', 'SearchCommerceMerchants', { scope: ctx.state.scope, query: 'coffee' }),
    commerceStep('product', 'ReadCommerceProduct', { scope: ctx.state.scope, merchantId: 'cedar-ca', query: 'coffee' }, ['directory'], [{ stepId: 'directory', targetKey: 'discovery' }]),
  ]);
};
test('Independent reads overlap; a consumer starts when its own dependency settles without waiting for another branch', { timeout: 60000 }, async () => {
  const t = await setupCommerce({ target: 'quote', choice: frontier }), held = latch(), firstRead = latch(), consumer = latch(); let pending: Promise<unknown> | undefined;
  const started: string[] = [];
  t.provider.flags.beforeResponse = async action => { started.push(action); firstRead.resolve(); if (action === 'ReadCommerceContext') await held.promise; if (action === 'ReadCommerceProduct') consumer.resolve(); };
  try {
    const id = t.submit().id; await t.b.run(); pending = t.b.run();
    // Bound provider scheduling after dispatch begins, separately from catalog
    // construction and planning on a busy CI runner. The slow branch stays held.
    await firstRead.promise;
    await Promise.race([consumer.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Dependent read stalled behind the independent branch')), 4000); timer.unref(); })]);
    assert.deepEqual(new Set(started), new Set(['ReadCommerceContext', 'SearchCommerceMerchants', 'ReadCommerceProduct']));
    assert.equal(t.store.intents(owner, id).find(i => i.stepId === 'slow_context')!.state, 'dispatching');
    held.resolve(); await pending;
    assert(t.store.intents(owner, id).every(i => i.state === 'effect_confirmed' && t.store.attempts(owner, i.id).length === 1));
    assert.equal(t.store.get(owner, id).delegation!.agent!.observations.length, 3);
  } finally { held.resolve(); await pending; await t.close(); }
});

test('A failed read cancels its consumers while the independent branch remains recorded', async () => {
  const t = await setupCommerce({ target: 'quote', choice: frontier });
  const program = t.catalog.agentProgram({ id: 'commerce.journey.sandbox', version: '2' }, owner)!, invoke = program.invoke.bind(program);
  program.invoke = async (...args) => { if (args[1] === 'SearchCommerceMerchants') throw new AgentReadError('Synthetic unavailable directory'); return invoke(...args); };
  try {
    const id = t.submit().id; await t.b.run(); await t.b.run();
    const intents = t.store.intents(owner, id);
    assert.equal(intents.find(i => i.stepId === 'product')!.state, 'canceled_before_dispatch');
    assert.equal(intents.find(i => i.stepId === 'slow_context')!.state, 'effect_confirmed');
    assert.equal(t.provider.counts().ReadCommerceProduct, undefined); assert.equal(t.store.get(owner, id).delegation!.agent!.observations.length, 1);
  } finally { await t.close(); }
});

for (const stop of ['cancel', 'lease_loss'] as const) test(`Concurrent late reads preserve audit without projecting after ${stop}`, { timeout: 60000 }, async () => {
  const t = await setupCommerce({ target: 'quote', choice: frontier }), held = latch(), both = latch(); let count = 0, pending: Promise<unknown> | undefined;
  t.provider.flags.beforeResponse = async () => { if (++count === 2) both.resolve(); await held.promise; };
  try {
    const id = t.submit().id; await t.b.run(); pending = t.b.run(); await both.promise;
    if (stop === 'cancel') t.b.tasks.cancel(principal, id);
    else assert(t.store.claim(['eigos.delegate'], 15000, Date.now() + 20000));
    held.resolve(); await pending;
    assert.equal(t.store.get(owner, id).delegation!.agent!.observations.length, 0);
    assert.equal(t.provider.counts().ReadCommerceProduct, undefined);
    assert.equal(t.store.intents(owner, id).reduce((n, intent) => n + t.store.observations(owner, intent.id).length, 0), 2);
  } finally { held.resolve(); await pending; await t.close(); }
});

test('Model context omits internal evidence duplication while preserving task, choices, outcomes and full durable evidence', async () => {
  let observed = false;
  const t = await setupCommerce({ target: 'quote', choice: (ctx, access) => {
    const summary = agentModelContext(ctx), serialized = JSON.stringify(summary);
    if (ctx.state.plans.length) {
      observed = true; const before = JSON.stringify(ctx);
      assert(!serialized.includes('ontologyPlanning')); assert(!serialized.includes('propertiesDigest'));
      assert.deepEqual(summary.request, ctx.request); assert.deepEqual(summary.state.observations, ctx.state.observations);
      assert.deepEqual(summary.actionOutcomes, ctx.actionOutcomes); assert(ctx.state.plans[0]!.ontologyPlanning.reads.length > 0);
      assert(serialized.length < before.length * 0.8);
      commerceReads(ctx, access); return { ...commerceDecision(ctx), kind: 'clarify', message: 'End this synthetic context test' };
    }
    return frontier(ctx, access);
  } });
  try { const id = t.submit().id; await t.b.run(); await t.b.run(); await t.b.run(); assert(observed); }
  finally { await t.close(); }
});
