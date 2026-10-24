import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupCommerce, commerceChoice, commerceDecision, commerceReads, commerceStep } from './fixtures/commerce-agent.js';
import { evidence, interpretation, owner, observeTaskContext } from './backend-fixture.js';
import { CUSTOMS_POLICY_DIGEST, CUSTOMS_REFERENCE_REFS, CUSTOMS_REFERENCES, CUSTOMS_RULE_REF, seedCustomsPolicy } from '../packages/ontology/customs-policy.js';
import { customsGateStatus, productRegulatoryBoundary } from '../packages/ontology/customs-policy-functions.js';
import type { CommerceSandboxScenario } from '../packages/capabilities/commerce-sandbox/provider.js';

test('Official references remain reference-only; regulated and unregistered classifications cannot enter purchasing', () => {
  assert.equal(CUSTOMS_REFERENCES.length, 6);
  assert(CUSTOMS_REFERENCES.every(r => r.use === 'reference_only' && r.capture === 'official_document_body' && r.contentSha256.length === 64));
  assert(Object.isFrozen(CUSTOMS_REFERENCES) && CUSTOMS_REFERENCES.every(r => Object.isFrozen(r.topics)));
  assert.equal(productRegulatoryBoundary({ title: '受管制测试对象', category: 'tobacco', hsCode: '240210' }).result, 'blocked');
  assert.equal(productRegulatoryBoundary({ title: '雪茄', category: 'roasted_coffee', hsCode: '090121' }).result, 'blocked');
  assert.equal(productRegulatoryBoundary({ title: 'Unclassified sample', category: 'unknown' }).result, 'unknown');
});

test('Agent reads request-scoped policy and source references before a successful synthetic customs evaluation', async () => {
  const t = await setupCommerce({ target: 'quote' });
  try {
    const done = await t.finish(t.submit().id); assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    const state = done.delegation!.agent!, customs = state.observations.find(r => r.type === 'CustomsAssessment')!;
    const result = customsGateStatus(t.store.ontology, owner, customs); assert.equal(result.status, 'pass_sandbox'); assert.equal(result.legalApproval, false); assert.equal(result.policyDigest, CUSTOMS_POLICY_DIGEST);
    assert.deepEqual(new Set(result.references.map(r => r.id)), new Set(CUSTOMS_REFERENCE_REFS.map(r => r.id)));
    const output = done.artifact!.data.result as any; assert.equal(output.customsPolicy.legalApproval, false); assert.equal(output.customsPolicy.coverage, 'synthetic_commerce_only'); assert.equal(output.customsPolicy.references.length, CUSTOMS_REFERENCES.length);
    const book = t.store.ontology.read(owner, CUSTOMS_RULE_REF);
    seedCustomsPolicy(t.store.ontology, owner, state.scope, { type: 'ServiceRequest', id: done.id });
    assert.equal(t.store.ontology.read(owner, CUSTOMS_RULE_REF).revision, book.revision, 'Rebinding a scope must not rewrite immutable source snapshots');
  } finally { await t.close(); }
});

test('New policy references preserve immutable documents already seeded by a previous release', async () => {
  const t = await setupCommerce({ target: 'quote' }), oldAt = '2026-10-20T00:54:23.388Z';
  try {
    const prior = CUSTOMS_REFERENCES.slice(0, 4).map((reference, index) => ({ ref: CUSTOMS_REFERENCE_REFS[index]!, properties: { id: CUSTOMS_REFERENCE_REFS[index]!.id, displayTitle: reference.title, snapshot: reference } }));
    t.store.ontology.ingest(owner, { objects: prior }, { kind: 'provider', id: 'eigos-reviewed-policy-registry', observedAt: oldAt });
    const before = prior.map(item => t.store.ontology.read(owner, item.ref));
    const done = await t.finish(t.submit().id, false); assert.equal(done.state, 'completed');
    for (const original of before) assert.deepEqual(t.store.ontology.read(owner, original.ref), original);
    assert.equal(customsGateStatus(t.store.ontology, owner, done.delegation!.agent!.observations.find(r => r.type === 'CustomsAssessment')!).references.length, 6);
  } finally { await t.close(); }
});

for (const mode of ['no_policy_read', 'no_gate_evaluation'] as const) test(`A model cannot skip ${mode} and obtain a firm quote`, async () => {
  const base = commerceChoice({ target: 'quote' });
  const t = await setupCommerce({ target: 'quote', includeCustomsPlanning: false, choice: (ctx, access) => {
    const decision = base(ctx, access), step = decision.steps.find(s => s.action === 'QuoteCommerceLandedCost');
    if (step) {
      if (mode === 'no_policy_read') access.session.call('evaluate_ontology', { function: 'customsGateStatus', object: JSON.parse(step.argumentsJson).customs });
      else {
        const from = { type: 'ServiceRequest', id: ctx.request.id };
        access.session.call('query_ontology', { from, link: 'customsRuleSets' });
        access.session.call('query_ontology', { from, link: 'regulatoryReferences' });
      }
    }
    return decision;
  } });
  try {
    const done = await t.finish(t.submit().id, false); assert.equal(done.state, 'paused'); assert.equal(done.delegation!.recovery?.code, 'validation_stalled'); assert.equal(done.artifact, undefined);
    assert(done.delegation!.agent!.feedback.some(f => f.message.includes('must query the exact customs rule set')));
    assert.equal(t.provider.counts().QuoteCommerceLandedCost, undefined); assert.equal(t.provider.counts().CreateCommerceCart, undefined); assert.equal(t.provider.counts().SubmitCommerceOrder, undefined);
  } finally { await t.close(); }
});

for (const customsEvidence of ['missing_clause', 'duplicate_clause', 'unregistered_rule', 'stale_rule', 'future_rule'] as const) test(`Even signed source evidence cannot bypass the hard gate: ${customsEvidence}`, async () => {
  const t = await setupCommerce({ target: 'quote', scenario: { customsEvidence } satisfies CommerceSandboxScenario });
  try {
    const done = await t.finish(t.submit().id, false), customs = done.delegation!.agent!.observations.find(r => r.type === 'CustomsAssessment')!;
    assert.equal(customsGateStatus(t.store.ontology, owner, customs).status, 'unknown'); assert.notEqual(done.state, 'completed'); assert.equal(done.artifact, undefined);
    assert.equal(t.provider.counts().QuoteCommerceLandedCost, undefined); assert.equal(t.provider.counts().SubmitCommerceOrder, undefined);
  } finally { await t.close(); }
});

test('An exact PA order permit cannot override policy evidence changed before dispatch', async () => {
  const t = await setupCommerce();
  try {
    const id = t.submit().id; let waiting = await t.finish(id, false);
    for (let i = 0; i < 3 && !waiting.delegation!.authorizationRequest!.effects.includes('order'); i++) { t.approve(waiting); waiting = await t.finish(id, false); }
    assert.equal(waiting.state, 'auth-required'); assert(waiting.delegation!.authorizationRequest!.effects.includes('order')); t.approve(waiting);
    const reference = t.store.ontology.read(owner, CUSTOMS_REFERENCE_REFS[0]!);
    t.store.ontology.ingest(owner, { objects: [{ ref: reference.ref, expectedRevision: reference.revision, properties: { ...reference.properties, snapshot: { ...(reference.properties.snapshot as object), documentVersion: 'unreviewed replacement' } } }] }, reference.source);
    const done = await t.finish(id, false); assert.notEqual(done.state, 'completed'); assert.equal(t.provider.counts().SubmitCommerceOrder, undefined);
    assert(done.delegation!.agent!.feedback.some(f => /changed|policy|customs/i.test(f.message)));
  } finally { await t.close(); }
});

test('An evaluated empty directory ends with a scoped unsupported result without needless PA questions', async () => {
  const query = 'unsupported test category';
  const t = await setupCommerce({ target: 'quote', choice: (ctx, access) => {
    const directory = commerceReads(ctx, access).last('CommerceMerchantSearch', true);
    if (!directory) return commerceDecision(ctx, [commerceStep('directory', 'SearchCommerceMerchants', { scope: ctx.state.scope, query })]);
    assert.deepEqual(directory.snapshot.data.merchants, []);
    return { ...commerceDecision(ctx), kind: 'no_feasible_plan', message: 'No registered source covers this query; no statement is made about worldwide supply or legal eligibility.' };
  } });
  try {
    t.model.ground = async (request, _caps, _signal, access) => ({ decision: { ...interpretation(observeTaskContext(access) ?? request, 'commerce.journey.sandbox', { query, quantity: null, contextKey: null, target: 'quote' }), capabilityRef: { id: 'commerce.journey.sandbox', version: '2' } }, evidence: evidence() });
    const job = t.b.submit({ goal: 'Check only the registered source coverage and stop on an empty directory.', executionEnvironment: 'sandbox' });
    const done = await t.finish(job.id, false); assert.equal(done.state, 'rejected'); assert.equal(done.question, undefined); assert.equal(done.delegation!.agent!.feedback.length, 0);
    assert.deepEqual(t.provider.counts(), { SearchCommerceMerchants: 1 }); assert.equal(done.artifact, undefined);
  } finally { await t.close(); }
});

test('An empty directory for a different query cannot establish the requested coverage gap', async () => {
  const t = await setupCommerce({ target: 'quote', choice: (ctx, access) => {
    const directory = commerceReads(ctx, access).last('CommerceMerchantSearch', true);
    return directory ? { ...commerceDecision(ctx), kind: 'no_feasible_plan', message: 'Try to reject using an unrelated empty search.' } : commerceDecision(ctx, [commerceStep('directory', 'SearchCommerceMerchants', { scope: ctx.state.scope, query: 'unrelated category' })]);
  } });
  try {
    const done = await t.finish(t.submit().id, false); assert.equal(done.state, 'paused'); assert.equal(done.delegation!.recovery?.code, 'validation_stalled');
    assert(done.delegation!.agent!.feedback.some(f => f.message.includes('requested query'))); assert.equal(done.artifact, undefined);
  } finally { await t.close(); }
});
