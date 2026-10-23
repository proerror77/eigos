import test from 'node:test';
import assert from 'node:assert/strict';
import { setupCheckout, checkoutInput } from './fixtures/shopify-checkout.js';
import { owner, principal } from './backend-fixture.js';

test('unpaid Shopify preparation requires an exact nonfinancial permit and original readback', async () => {
  const t = setupCheckout();
  try {
    const id = t.submit().id, waiting = await t.finish(id);
    assert.equal(waiting.state, 'auth-required', JSON.stringify(waiting.delegation?.agent?.feedback));
    assert.equal(t.countCreates(), 0);
    const authorization = waiting.delegation!.authorizationRequest!;
    assert.equal(authorization.kind, 'external_draft');
    if (authorization.kind !== 'external_draft') throw new Error('Missing draft authority');
    for (const draft of [{ ...authorization.draft, paymentAllowed: true }, { ...authorization.draft, orderAllowed: true }, { ...authorization.draft, merchant: { ...authorization.draft.merchant, domain: 'other.myshopify.com' } }, { ...authorization.draft, items: authorization.draft.items.map(item => ({ ...item, quantity: 2 })) }]) assert.throws(() => t.approve(id, { draft }));
    assert.throws(() => t.approve(id, { environment: 'sandbox' }));
    assert.throws(() => t.approve(id, { expiresAt: new Date(Date.parse(authorization.draft.sourceExpiresAt) + 1).toISOString() }));
    t.approve(id);
    const done = await t.finish(id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.equal(t.countCreates(), 1); assert.equal(t.calls.filter(call => call.tool === 'get_checkout').length, 1);
    const artifact = (done.artifact!.data.result as any).components[0].artifact.data.result;
    assert.equal(artifact.checkout.status, 'requires_escalation'); assert.match(artifact.checkout.continueUrl, /^https:\/\/shop.app\/checkouts\//);
    assert.equal(artifact.noPaymentActions, true); assert.equal(artifact.noOrderActions, true); assert.equal(artifact.evidenceKind, 'provider');
    assert.equal(t.store.grants(owner, id)[0]!.kind, 'external_draft');
    assert.deepEqual(t.b.tasks.get(principal, id).delegation!.authorizationBudget, []);
    const observation = done.delegation!.agent!.observations.find(ref => ref.type === 'ShopifyCheckoutObservation')!;
    const publicRead = t.b.tasks.queryOntology(principal, { object: observation, taskId: id });
    assert(!JSON.stringify(publicRead).includes('private-checkout-key')); assert(!JSON.stringify(publicRead).includes('snapshot'));
    assert.throws(() => t.b.tasks.queryOntology(principal, { object: observation, properties: ['snapshot'], taskId: id }));
  } finally { t.store.close(); }
});

test('status-only follow-up reads the original owned checkout without another creation or permit', async () => {
  const t = setupCheckout();
  try {
    const originalId = t.submit().id; await t.finish(originalId); t.approve(originalId); await t.finish(originalId);
    const provider = [...t.checkouts.values()][0]!; provider.status = 'completed'; provider.order = { id: 'gid://shopify/Order/99' }; delete provider.continue_url;
    const statusId = t.submit({ mode: 'status', sourceTaskId: originalId }).id, done = await t.finish(statusId);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    const result = (done.artifact!.data.result as any).components[0].artifact.data.result;
    assert.equal(result.checkout.status, 'completed'); assert.equal(result.checkout.orderId, 'gid://shopify/Order/99'); assert.equal(result.sourceTaskId, originalId);
    assert.equal(t.countCreates(), 1); assert.equal(t.store.grants(owner, statusId).length, 0);
    assert.equal(t.calls.filter(call => call.tool === 'get_checkout').length, 2);
    assert.throws(() => t.b.tasks.get({ ...principal, subject: 'another-member' }, originalId));
  } finally { t.store.close(); }
});

test('lost creation response recovers only by reading the original checkout', async () => {
  const t = setupCheckout();
  try {
    t.flags.lostCreate = true;
    const id = t.submit(checkoutInput).id; await t.finish(id); t.approve(id);
    const done = await t.finish(id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.equal(t.countCreates(), 1); assert.equal(t.calls.filter(call => call.tool === 'create_checkout').length, 1);
    const intent = t.store.intents(owner, id).find(intent => intent.effect === 'external_draft')!;
    assert.equal(t.store.attempts(owner, intent.id).filter(attempt => attempt.kind === 'dispatch').length, 1);
    assert.equal(t.store.attempts(owner, intent.id).filter(attempt => attempt.kind === 'reconcile').length, 1);
    assert.equal(t.calls.filter(call => call.tool === 'get_checkout').length, 2);
  } finally { t.store.close(); }
});

test('cancellation during provider preflight prevents the draft write', async () => {
  const t = setupCheckout();
  try {
    const id = t.submit().id; await t.finish(id); t.approve(id);
    t.flags.before = async tool => { if (tool === 'create_checkout') t.b.tasks.cancel(principal, id); };
    await t.run();
    assert.equal(t.countCreates(), 0); assert.equal(t.store.get(owner, id).state, 'canceled');
    assert.equal(t.store.get(owner, id).delegation?.acceptance, undefined);
  } finally { t.store.close(); }
});

for (const boundary of ['revoked', 'lease-expired'] as const) test(`${boundary} during provider preflight blocks the unpaid write`, async () => {
  const t = setupCheckout(), originalNow = Date.now;
  try {
    const id = t.submit().id; await t.finish(id); t.approve(id);
    t.flags.before = async tool => {
      if (tool !== 'create_checkout') return;
      if (boundary === 'revoked') t.store.revokeGrants(owner, id);
      else Date.now = () => originalNow() + 61000;
    };
    await t.run();
    assert.equal(t.countCreates(), 0);
    assert.equal(t.store.intents(owner, id).find(value => value.effect === 'external_draft')!.acceptedOutput, undefined);
  } finally { Date.now = originalNow; t.store.close(); }
});

test('late creation after cancellation remains original audit evidence and cannot complete the task', async () => {
  const t = setupCheckout();
  try {
    const id = t.submit().id; await t.finish(id); t.approve(id);
    t.flags.afterCreate = () => t.b.tasks.cancel(principal, id);
    await t.run();
    assert.equal(t.countCreates(), 1); assert.equal(t.store.get(owner, id).state, 'canceled');
    assert.equal(t.store.get(owner, id).delegation?.acceptance, undefined);
    const intent = t.store.intents(owner, id).find(value => value.effect === 'external_draft')!;
    assert.equal(intent.acceptedOutput, undefined); assert.equal(t.store.observations(owner, intent.id).length, 1);
  } finally { t.store.close(); }
});

test('unrecoverable original response stops for review and never creates again', async () => {
  const t = setupCheckout();
  try {
    t.flags.lostCreate = true; t.flags.journalLost = true;
    const id = t.submit().id; await t.finish(id); t.approve(id);
    const result = await t.finish(id);
    assert.equal(result.state, 'input-required'); assert.equal(result.delegation?.acceptance, undefined);
    assert.equal(t.countCreates(), 1); assert.equal(t.calls.filter(call => call.tool === 'create_checkout').length, 1);
    assert.equal(t.store.intents(owner, id).find(value => value.effect === 'external_draft')!.state, 'needs_review');
  } finally { t.store.close(); }
});

test('disabled private draft authority stops before provider creation', async () => {
  const t = setupCheckout({ allowExternalDrafts: false });
  try {
    const result = await t.finish(t.submit().id);
    assert.notEqual(result.state, 'completed'); assert.equal(t.countCreates(), 0);
    assert.equal(result.delegation?.authorizationRequest, undefined);
  } finally { t.store.close(); }
});


test('an expired selected-products preview cannot authorize a later creation', async () => {
  const t = setupCheckout(), originalNow = Date.now;
  try {
    const id = t.submit().id; await t.finish(id);
    Date.now = () => originalNow() + 300001;
    assert.throws(() => t.approve(id)); assert.equal(t.countCreates(), 0); assert.equal(t.store.grants(owner, id).length, 0);
  } finally { Date.now = originalNow; t.store.close(); }
});

test('completion cannot select an older unpaid observation after a newer source read reports completion', async () => {
  const t = setupCheckout({ staleCompletion: true });
  try {
    const id = t.submit().id; await t.finish(id); t.approve(id);
    t.flags.before = async tool => {
      if (tool === 'get_checkout' && t.calls.some(call => call.tool === 'get_checkout')) {
        const provider = [...t.checkouts.values()][0]!; provider.status = 'completed'; provider.order = { id: 'gid://shopify/Order/99' }; delete provider.continue_url;
      }
    };
    const result = await t.finish(id);
    assert.notEqual(result.state, 'completed'); assert.equal(result.delegation?.acceptance, undefined); assert.equal(t.countCreates(), 1);
    assert.match(JSON.stringify(result.delegation!.agent!.composition!.assessment), /latest accepted readback/);
  } finally { t.store.close(); }
});
