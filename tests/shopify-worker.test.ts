import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { CatalogAgentProgram, CATALOG_AGENT_REF } from '../packages/capabilities/catalog-agent.js';
import { checkedAgentCatalogObservation } from '../packages/ontology/catalog-agent-projection.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { digest } from '../packages/core/delegation.js';
import { JobStore } from '../packages/core/store.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { backend, owner, principal } from './backend-fixture.js';
import { merchant, input, ids, decision, step, observe, model, setup, fixture, knownChoice, answer } from './fixtures/catalog-agent.js';

test('Catalog program is absent by default, owner scoped, configured consistently and construction makes no HTTP', () => {
  assert(!createExecutionCatalog().summaries(owner).some(c => c.ref.id === CATALOG_AGENT_REF.id));
  const t = setup(); try {
    assert(t.catalog.summaries(owner, 16, 'sandbox').some(c => c.ref.id === CATALOG_AGENT_REF.id && c.ref.version === '2'));
    assert(!t.catalog.summaries('other-owner').some(c => c.ref.id === CATALOG_AGENT_REF.id));
    assert(!t.catalog.summaries(owner).some(c => c.ref.id === CATALOG_AGENT_REF.id), 'synthetic sources cannot satisfy a live task');
    assert.deepEqual(t.catalog.bindings(CATALOG_AGENT_REF, owner), [], 'no legacy provider workflow is registered');
    const env = { EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(40), EIGOS_SHOPIFY_CATALOG_MERCHANTS: JSON.stringify([merchant]), EIGOS_SHOPIFY_AUDIT_DIR: '/tmp/shopify-private-test' };
    assert.deepEqual(readConfig(env).EIGOS_SHOPIFY_CATALOG_MERCHANTS, readWorkerConfig(env).EIGOS_SHOPIFY_CATALOG_MERCHANTS);
    for (const override of [{ NODE_ENV: 'production' }, { HOST: '0.0.0.0' }, { EIGOS_SHOPIFY_CATALOG_MERCHANTS: JSON.stringify([{ ...merchant, accessToken: 'forbidden' }]) }, { EIGOS_SHOPIFY_CATALOG_MERCHANTS: JSON.stringify([{ ...merchant, domain: 'evil.example' }]) }, { EIGOS_SHOPIFY_CATALOG_MERCHANTS: JSON.stringify([merchant, merchant]) }, { EIGOS_SHOPIFY_AUDIT_DIR: 'relative' }]) assert.throws(() => readWorkerConfig({ ...env, ...override }));
    assert.equal(t.calls.length, 0);
  } finally { t.store.close(); }
});

test('Agent chooses a query, limit and non-first variants; no hidden detail, discovery or refresh', async () => {
  const t = setup(); try {
    const job = t.b.submit({ goal: 'Find dark coffee and return the third and fourth variants, read-only', requirements: [{ id: 'no-order', kind: 'condition', strength: 'hard', expected: { predicate: 'execution.no_order' } }] });
    const scoped = await t.b.run(); assert(scoped.delegation!.agent); assert.equal(t.calls.length, 0, 'grounding and scope initialization perform no source reads');
    const done = await t.finish(job.id); assert.equal(done.state, 'completed'); assert(done.delegation!.acceptance?.accepted);
    assert.equal(done.delegation!.plan, undefined); assert.equal(done.delegation!.resolution, undefined);
    assert.deepEqual(t.calls.map(c => c.operation), ['search_catalog']); assert.equal(t.calls[0]!.catalog.query, 'dark roast'); assert.equal(t.calls[0]!.catalog.pagination.limit, 7);
    assert.deepEqual(answer(done).selections[0]!.items.map(i => i.variantId), [ids[2], ids[3]]); assert.equal(answer(done).stockQuantity, 'unknown');
    assert(t.calls.every(c => !c.headers.authorization && !c.headers['Shopify-Buyer-IP']));
    const state = done.delegation!.agent!; assert.equal(state.observations.length, 1); assert.equal(state.plans[0]!.steps[0]!.action, 'SearchPublicCatalog'); assert(state.completion);
    assert.equal(checkedAgentCatalogObservation(t.store.ontology.read(owner, state.observations[0]!).properties.snapshot).items.length, 4, 'all observed variants reach the model');
    const ledger = t.b.tasks.get(principal, job.id).delegation!.actions!; assert.equal(ledger.length, 1); assert.equal(ledger[0]!.state, 'effect_confirmed');
    for (const type of ['Order', 'Payment', 'CheckoutSession']) assert.equal(t.store.ontology.query(owner, { type }).items.length, 0);
    const offers = t.store.ontology.related(owner, state.observations[0]!, 'offers', { remaining: 1000 })!;
    assert.equal(offers.length, 4); assert.equal(t.store.ontology.evaluate(owner, { function: 'withinBudget', object: offers[0]!.ref, budget: { minor: '99999', currency: 'USD' }, priceBasis: 'firm_quote' }).status, 'unknown');
  } finally { t.store.close(); }
});

test('A known-ID goal composes discovery and merchant lookup, skipping search and detail', async () => {
  const t = setup(knownChoice); try {
    const job = t.b.submit({ goal: `Check Coffee variant ${ids[1]} directly, no purchase`, requirements: [{ id: 'merchant', kind: 'condition', strength: 'hard', expected: { predicate: 'catalog.merchant_verified' } }] });
    const done = await t.finish(job.id); assert.equal(done.state, 'completed');
    assert.deepEqual(t.calls.map(c => c.operation), ['discovery', 'lookup_catalog']); assert.deepEqual(t.calls[1]!.catalog.ids, [ids[1]]);
    assert.equal(done.delegation!.agent!.plans.length, 1); assert.equal(done.delegation!.agent!.plans[0]!.steps.length, 2);
    const intents = t.store.intents(owner, job.id); assert.equal(intents.length, 2); assert(intents.every(i => i.effect === 'read' && i.state === 'effect_confirmed' && t.store.attempts(owner, i.id).length === 1));
    assert.equal(t.store.ontology.query('other-owner', { type: 'CatalogObservation' }).items.length, 0);
  } finally { t.store.close(); }
});

test('Merchant option labels never replace the product name in ontology or delivery', async () => {
  for (const label of ['12 oz / Whole Bean', 'FLOW: Original Medium Roast Whole Bean Coffee']) {
    const t = setup(knownChoice); try {
      t.flags.productTitle = 'FLOW: Original Medium Roast Whole Bean Coffee'; t.flags.variantTitle = label;
      const job = t.b.submit({ goal: `Check ${ids[1]}` }), done = await t.finish(job.id); assert.equal(done.state, 'completed');
      const expected = label === t.flags.productTitle ? label : `${t.flags.productTitle} — ${label}`;
      assert.equal(answer(done).selections[0]!.items[0]!.title, expected);
      const observation = done.delegation!.agent!.observations.find(r => r.type === 'CatalogObservation')!;
      const value = checkedAgentCatalogObservation(t.store.ontology.read(owner, observation).properties.snapshot);
      assert.equal(value.items[0]!.title, expected);
      const offers = t.store.ontology.related(owner, observation, 'offers', { remaining: 1000 })!;
      const variants = t.store.ontology.related(owner, offers[0]!.ref, 'productVariant', { remaining: 1000 })!;
      assert.equal(variants[0]!.properties.name, expected);
    } finally { t.store.close(); }
  }
});

test('Changed merchant facts reach the Agent, which explicitly selects a different comparison', async () => {
  const choices: string[][] = [];
  const t = setup((ctx, access) => {
    const observations = observe(ctx, access), search = observations.find(o => o.snapshot.action === 'SearchPublicCatalog'), endpoint = observations.find(o => o.snapshot.action === 'DiscoverMerchantCatalog'), reads = observations.filter(o => o.snapshot.action === 'ReadMerchantVariants');
    if (!search) return decision(ctx, [step('find', 'SearchPublicCatalog', { scope: ctx.state.scope, merchantId: 'coffee', query: 'coffee beans', limit: 2 })]);
    if (!reads.length) { choices.push([ids[0]!, ids[1]!]); return decision(ctx, [step('discover', 'DiscoverMerchantCatalog', { scope: ctx.state.scope, merchantId: 'coffee' }), step('compare', 'ReadMerchantVariants', { scope: ctx.state.scope, merchantId: 'coffee', observation: search.ref, variantIds: [ids[0], ids[1]] }, ['discover'], [{ stepId: 'discover', targetKey: 'endpoint' }])]); }
    if (reads.length === 1 && reads[0]!.snapshot.items[0]!.displayPrice!.minor === '5000') { choices.push([ids[1]!, ids[2]!]); return decision(ctx, [step('change_choice', 'ReadMerchantVariants', { scope: ctx.state.scope, merchantId: 'coffee', endpoint: endpoint!.ref, observation: search.ref, variantIds: [ids[1], ids[2]] })]); }
    return decision(ctx, [], { selections: [{ observation: reads.at(-1)!.ref, variantIds: [ids[1], ids[2]] }], rationale: 'The initially cheaper variant rose to 50 USD; choose the observed 20 and 30 USD alternatives' });
  });
  try {
    t.flags.changeAtMerchant = true; const job = t.b.submit({ goal: 'Compare two lower-priced coffee variants using merchant prices; keep read-only' });
    const done = await t.finish(job.id); assert.equal(done.state, 'completed');
    assert.deepEqual(t.calls.map(c => c.operation), ['search_catalog', 'discovery', 'lookup_catalog', 'lookup_catalog']); assert.deepEqual(choices, [[ids[0], ids[1]], [ids[1], ids[2]]]);
    assert.deepEqual(answer(done).selections[0]!.items.map(i => i.displayPrice!.minor), ['2000', '3000']); assert.equal(done.delegation!.agent!.plans.length, 3);
    const firstMerchant = done.delegation!.agent!.observations.map(r => checkedAgentCatalogObservation(t.store.ontology.read(owner, r).properties.snapshot)).find(s => s.action === 'ReadMerchantVariants')!;
    assert.equal(firstMerchant.items[0]!.displayPrice!.minor, '5000'); assert.equal(done.delegation!.agent!.feedback.length, 0, 'price change is evidence, not a forced workflow failure');
  } finally { t.store.close(); }
});

test('Detail is an optional explicitly selected action with the exact observed merchant and variant', async () => {
  const t = setup((ctx, access) => {
    const observations = observe(ctx, access), detail = observations.find(o => o.snapshot.action === 'InspectCatalogVariant');
    if (detail) return decision(ctx, [], { selections: [{ observation: detail.ref, variantIds: [ids[2]] }], rationale: 'Detail for the explicitly selected third variant' });
    if (observations.length) return decision(ctx, [step('detail', 'InspectCatalogVariant', { scope: ctx.state.scope, merchantId: 'coffee', observation: observations[0]!.ref, variantId: ids[2] })]);
    return decision(ctx, [step('search', 'SearchPublicCatalog', { scope: ctx.state.scope, merchantId: 'coffee', query: 'coffee', limit: 4 })]);
  });
  try {
    const job = t.b.submit({ goal: 'Inspect the third Coffee variant' }); const done = await t.finish(job.id); assert.equal(done.state, 'completed');
    assert.deepEqual(t.calls.map(c => c.operation), ['search_catalog', 'get_product']); assert.deepEqual(t.calls[1]!.catalog, { id: ids[2], context: { address_country: 'US' }, filters: { shops: [merchant.shopId] } });
  } finally { t.store.close(); }
});

test('Unregistered writes, unconfigured merchants and fabricated IDs cannot dispatch', async () => {
  for (const bad of ['CreateCart', 'PayOrder', 'merchant', 'variant']) {
    const t = setup((ctx, access) => {
      observe(ctx, access);
      if (bad === 'variant') return decision(ctx, [step('find', 'InspectCatalogVariant', { scope: ctx.state.scope, merchantId: 'coffee', observation: { type: 'CatalogObservation', id: 'invented' }, variantId: ids[0] })]);
      return decision(ctx, [step('bad', bad === 'merchant' ? 'SearchPublicCatalog' : bad, { scope: ctx.state.scope, merchantId: bad === 'merchant' ? 'unapproved' : 'coffee', query: 'coffee', limit: 1 })]);
    });
    try { const job = t.b.submit({ goal: 'Read Coffee' }); const done = await t.finish(job.id); assert.equal(done.state, 'paused'); assert.equal(t.calls.length, 0); assert.equal(done.delegation!.agent!.feedback.length, 3); assert.equal(done.artifact, undefined); }
    finally { t.store.close(); }
  }
});

test('Skipping ontology reads cannot produce an action plan or HTTP request', async () => {
  const t = setup(ctx => decision(ctx, [step('find', 'SearchPublicCatalog', { scope: ctx.state.scope, merchantId: 'coffee', query: 'coffee', limit: 1 })]));
  try { t.b.submit({ goal: 'Read Coffee' }); await t.b.run(); await assert.rejects(t.b.run(), /actual definition and object reads|cite successful receipts/); assert.equal(t.calls.length, 0); }
  finally { t.store.close(); }
});

test('Completion requires an actual current ontology status evaluation', async () => {
  const t = setup((ctx, access) => {
    const observed = observe(ctx, access, false);
    return observed.length ? decision(ctx, [], { selections: [{ observation: observed[0]!.ref, variantIds: [ids[0]] }], rationale: 'Missing evaluation fixture' }) : decision(ctx, [step('find', 'SearchPublicCatalog', { scope: ctx.state.scope, merchantId: 'coffee', query: 'coffee', limit: 1 })]);
  });
  try { const job = t.b.submit({ goal: 'Read Coffee' }); const done = await t.finish(job.id); assert.equal(done.state, 'paused'); assert.equal(done.artifact, undefined); assert.equal(t.calls.length, 1); }
  finally { t.store.close(); }
});

test('Empty bounded results do not become complete absence or stock claims', async () => {
  const t = setup(); try { t.flags.empty = true; const job = t.b.submit({ goal: 'Read Coffee' }); const done = await t.finish(job.id); assert.equal(done.state, 'rejected'); assert.equal(done.artifact, undefined); assert.equal(t.calls.length, 1); assert.match(done.error!, /completeness remains unknown/); }
  finally { t.store.close(); }
});

test('Canceling an in-flight read preserves prior observations but never applies its late return', async () => {
  for (const at of ['discovery', 'lookup_catalog']) {
    const t = setup(knownChoice); let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(r => { started = r; }), gate = new Promise<void>(r => { release = r; });
    t.flags.before = async op => { if (op === at) { started(); await gate; } };
    try {
      const job = t.b.submit({ goal: `Check ${ids[1]}` }); await t.b.run(); const pending = t.b.run(); await waiting;
      t.b.tasks.cancel(principal, job.id); release(); await pending;
      const current = t.store.get(owner, job.id); assert.equal(current.state, 'canceled'); assert.equal(current.artifact, undefined);
      assert.equal(current.delegation!.agent!.observations.length, at === 'discovery' ? 0 : 1); assert.equal(t.store.ontology.query(owner, { type: 'CatalogObservation' }).items.length, 0);
      assert(t.store.intents(owner, job.id).some(i => i.state === 'canceled_after_dispatch')); assert.equal(t.calls.length, at === 'discovery' ? 1 : 2);
    } finally { release?.(); t.store.close(); }
  }
});

test('Lease loss rejects late projection and resumes the durable frontier without replaying it', async () => {
  const t = setup(); let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(r => { started = r; }), gate = new Promise<void>(r => { release = r; });
  t.flags.before = async () => { started(); await gate; };
  try {
    const job = t.b.submit({ goal: 'Read Coffee' }); await t.b.run(); const pending = t.b.run(); await waiting;
    const replacement = t.store.claim(['eigos.delegate'], 15000, Date.now() + 20000)!; assert(replacement);
    release(); await pending;
    assert.equal(t.store.ontology.query(owner, { type: 'CatalogObservation' }).items.length, 0); assert.equal(t.store.intents(owner, job.id)[0]!.state, 'effect_unknown');
    await t.b.coordinator.run(replacement, new AbortController().signal); assert.equal(t.calls.length, 1); assert.equal(t.store.get(owner, job.id).delegation!.agent!.pendingPlanId, undefined);
    assert.equal(t.store.get(owner, job.id).delegation!.agent!.feedback.at(-1)!.kind, 'runtime');
  } finally { release?.(); t.store.close(); }
});

test('Evidence tampering invalidates source status and leaves the delivered artifact unchanged', async () => {
  const t = setup(); try {
    const job = t.b.submit({ goal: 'Read Coffee' }), done = await t.finish(job.id), before = digest(done.artifact), ref = done.delegation!.agent!.observations[0]!, record = t.store.ontology.read(owner, ref);
    const snapshot = checkedAgentCatalogObservation(record.properties.snapshot); const altered = structuredClone(snapshot); altered.items[0]!.displayPrice!.minor = '1'; assert.throws(() => checkedAgentCatalogObservation(altered));
    t.store.ontology.ingest(owner, { objects: [{ ref, expectedRevision: record.revision, properties: { ...record.properties, displayTitle: 'tampered' } }] }, { kind: 'synthetic', id: 'test', observedAt: new Date().toISOString() });
    assert.equal(t.store.ontology.evaluate(owner, { function: 'catalogObservationStatus', object: ref }).status, 'unknown'); assert.equal(digest(t.store.get(owner, job.id).artifact), before);
  } finally { t.store.close(); }
});

test('Source observations from another task cannot be used as action inputs even by the same owner', async () => {
  const t = setup(); try {
    const first = t.b.submit({ goal: 'Read Coffee' }), done = await t.finish(first.id), foreign = done.delegation!.agent!.observations[0]!;
    const second = backend(t.catalog, model((ctx, access) => {
      observe(ctx, access); access.session.call('query_ontology', { object: foreign });
      return decision(ctx, [step('detail', 'InspectCatalogVariant', { scope: ctx.state.scope, merchantId: 'coffee', observation: foreign, variantId: ids[0] })]);
    }), t.store);
    const job = second.submit({ goal: 'Read another Coffee', executionEnvironment: 'sandbox' }); for (let i = 0; i < 4; i++) await second.run();
    assert.equal(t.store.get(owner, job.id).state, 'paused'); assert.equal(t.calls.length, 1);
    const program = new CatalogAgentProgram([merchant], { connector: t.connector }); assert.throws(() => program.initialize(t.store.ontology, 'other-owner', done.delegation!.request, input));
  } finally { t.store.close(); }
});

test('A restarted Worker continues from accepted observations without repeating the provider call', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-catalog-agent-')), path = join(directory, 'tasks.sqlite'), f = fixture();
  let store = new JobStore(path);
  const catalog = () => createExecutionCatalog({ store, shopifyCatalog: { merchants: [merchant], connector: f.connector } });
  try {
    let b = backend(catalog(), model(), store); const job = b.submit({ goal: 'Read Coffee', executionEnvironment: 'sandbox' });
    await b.run(); await b.run(); assert.equal(f.calls.length, 1); const before = store.get(owner, job.id).delegation!.agent!;
    store.close(); store = new JobStore(path); b = backend(catalog(), model(), store);
    const done = await b.run(); assert.equal(done.id, job.id); assert.equal(done.state, 'completed'); assert.equal(f.calls.length, 1);
    assert.deepEqual(done.delegation!.agent!.plans, before.plans); assert.deepEqual(done.delegation!.agent!.observations, before.observations);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Altered choices cannot dispatch under an unchanged model-output receipt', async () => {
  const t = setup(); try {
    const reasoner = model(), original = reasoner.act!;
    reasoner.act = async (...args) => { const result = await original(...args); result.decision.steps[0]!.argumentsJson = JSON.stringify({ scope: args[0].state.scope, merchantId: 'coffee', query: 'changed after model return', limit: 1 }); return result; };
    const b = backend(t.catalog, reasoner, t.store); b.submit({ goal: 'Read Coffee', executionEnvironment: 'sandbox' }); await b.run();
    await assert.rejects(b.run(), /differs from the recorded model output/); assert.equal(t.calls.length, 0);
  } finally { t.store.close(); }
});

test('A later contradictory observation prevents completing with the older price', async () => {
  const t = setup((ctx, access) => {
    const all = observe(ctx, access), search = all.find(o => o.snapshot.action === 'SearchPublicCatalog'), read = all.find(o => o.snapshot.action === 'ReadMerchantVariants');
    if (!search) return decision(ctx, [step('search', 'SearchPublicCatalog', { scope: ctx.state.scope, merchantId: 'coffee', query: 'coffee', limit: 1 })]);
    if (!read) return decision(ctx, [step('discover', 'DiscoverMerchantCatalog', { scope: ctx.state.scope, merchantId: 'coffee' }), step('read', 'ReadMerchantVariants', { scope: ctx.state.scope, merchantId: 'coffee', observation: search.ref, variantIds: [ids[0]] }, ['discover'], [{ stepId: 'discover', targetKey: 'endpoint' }])]);
    return decision(ctx, [], { selections: [{ observation: search.ref, variantIds: [ids[0]] }], rationale: 'Attempting to keep the old lower price' });
  });
  try {
    t.flags.changeAtMerchant = true; const job = t.b.submit({ goal: 'Read Coffee' }), done = await t.finish(job.id);
    assert.equal(done.state, 'paused'); assert.equal(done.artifact, undefined); assert.equal(t.calls.length, 3);
    assert.match(done.delegation!.agent!.feedback.at(-1)!.message, /later observation disagrees/);
  } finally { t.store.close(); }
});

test('The action model cannot search unrelated owner data or read another task object', async () => {
  const t = setup((ctx, access) => {
    assert.equal(access.session.catalog().readScope, 'request');
    const denied = access.session.call('query_ontology', { type: 'SavedAddress' }) as { error: string };
    assert.equal(denied.error, 'FORBIDDEN');
    observe(ctx, access);
    return { ...decision(ctx), kind: 'no_feasible_plan', message: 'Isolation test finished' };
  });
  try { const job = t.b.submit({ goal: 'Read Coffee' }); const done = await t.finish(job.id); assert.equal(done.state, 'rejected'); assert.equal(t.calls.length, 0); }
  finally { t.store.close(); }
});

test('An expired window with verified progress rolls over the SAME task without an owner reply', async () => {
  const t = setup(); try {
    const job = t.b.submit({ goal: 'Read Coffee' }); await t.b.run();
    const current = t.store.get(owner, job.id); current.createdAt = new Date(Date.now() - 10000).toISOString(); current.delegation!.executionBudget!.window.startedAt = current.createdAt; t.store.save(owner, current);
    const coordinator = new Coordinator(t.store, model(), t.catalog, { maxTaskMs: 1000 }), claim = t.store.claim(['eigos.delegate'], 15000)!;
    await coordinator.run(claim, new AbortController().signal);
    let done = t.store.get(owner, job.id); assert.equal(done.state, 'working'); assert.equal(done.runs!.length, current.runs!.length); assert.equal(t.calls.length, 0);
    assert.equal(done.delegation!.executionBudget!.window.reason, 'automatic'); assert.equal(done.delegation!.request.messages.length, 1);
    for (let n = 0; n < 10; n++) {
      const next = t.store.claim(['eigos.delegate'], 15000); if (!next) break;
      await coordinator.run(next, new AbortController().signal);
    }
    done = t.store.get(owner, job.id); assert.equal(done.state, 'completed'); assert.equal(done.id, job.id); assert.equal(done.createdAt, current.createdAt);
  } finally { t.store.close(); }
});
