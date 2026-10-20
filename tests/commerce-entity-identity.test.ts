import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { digest } from '../packages/core/delegation.js';
import { commerceSnapshotSchema } from '../packages/ontology/commerce.js';
import { commerceVariantRef, projectCommerceSnapshot } from '../packages/ontology/commerce-projection.js';
import { linkSnapshotDigest, type LinkWrite } from '../packages/ontology/object-store.js';
import { sourceProof } from '../packages/ontology/object-evidence.js';
import type { ObjectRef } from '../packages/ontology/model.js';
import { backend, owner } from './backend-fixture.js';

function fixture() {
  const f = backend(new ExecutionCatalog([], [], [])), graph = f.store.ontology, base = Date.now() - 60000;
  let sequence = 0;
  const task = () => f.submit({ goal: 'Inspect the explicit local sandbox checkout' });
  const snapshot = (job: ReturnType<typeof task>, options: {
    checkout?: string; order?: string; preparationTaskId?: string; title?: string; price?: string; quantity?: number;
    startedAt?: number; observedAt?: number; merchant?: string; origin?: string; adjustments?: number;
  } = {}) => {
    const started = options.startedAt ?? base + ++sequence * 1000, received = options.observedAt ?? started + 100;
    const checkoutId = options.checkout ?? randomUUID(), input = { checkout: checkoutId };
    const item = { id: 'item-1', lineId: 'line-1', title: options.title ?? 'Test Coffee', quantity: options.quantity ?? 1, unitPrice: { minor: options.price ?? '1000', currency: 'USD' as const } };
    const total = { minor: (BigInt(item.unitPrice.minor) * BigInt(item.quantity)).toString(), currency: 'USD' as const };
    const costBreakdown = [{ type: 'total', amount: total }], costTermsDigest = digest(costBreakdown);
    const quoteDigest = digest({ items: [item], total, costTermsDigest });
    const receipt = (kind: string) => ({ id: randomUUID(), method: 'GET', path: `/${kind}/${checkoutId}`, startedAt: new Date(started).toISOString(),
      receivedAt: new Date(received).toISOString(), status: 200, inputDigest: digest(input), responseSha256: digest({ kind, quoteDigest, id: options.order, adjustments: options.adjustments ?? 0 }), environment: 'sandbox' as const });
    const value = commerceSnapshotSchema.parse({ environment: 'sandbox', merchantId: options.merchant ?? 'fixture-merchant', merchantOrigin: options.origin ?? 'http://127.0.0.1:8181',
      protocolVersion: '2026-04-08', requestId: job.id, requestRevision: 1, preparationTaskId: options.preparationTaskId ?? job.id, operation: options.order ? 'confirm' : 'prepare',
      inputDigest: digest(input), configurationDigest: digest({ fixture: true }), expectedItems: [{ id: item.id, quantity: 1 }],
      checkout: { id: checkoutId, state: options.order ? 'completed' : 'ready_for_complete', items: [item], total, costBreakdown, costTermsDigest, quoteDigest, destinationComplete: true,
        fulfillmentDigest: digest('fulfillment'), buyerDigest: digest('buyer'), destinationDigest: digest('destination'),
        ...(options.order ? { orderId: options.order } : { expiresAt: new Date(Date.now() + 300000).toISOString() }), messageCodes: [], receipt: receipt('checkout') },
      ...(options.order ? { order: { id: options.order, checkoutId, items: [item], total, costBreakdown, costTermsDigest, permalinkUrl: `http://127.0.0.1:8181/orders/${options.order}`,
        fulfillment: 'pending', events: [], destinationDigest: digest('destination'), adjustmentCount: options.adjustments ?? 0, receipt: receipt('order') } } : {}),
    });
    return { value, input };
  };
  const project = (s: ReturnType<typeof snapshot>) => f.store.transaction(() => projectCommerceSnapshot(graph, owner, { id: s.value.requestId, revision: 1 }, `commerce.ucp.${s.value.operation}.sandbox`, s.input, s.value));
  const related = (ref: ObjectRef, link: string) => graph.related(owner, ref, link, { remaining: 1000 }) ?? [];
  return { ...f, graph, base, task, snapshot, project, related };
}

test('different checkout quotes retain one product identity and distinct pinned order terms and receipts', () => {
  const f = fixture();
  try {
    const firstTask = f.task(), first = f.snapshot(firstTask, { checkout: 'checkout-a' }), firstResult = f.project(first);
    assert.equal(firstResult.state, 'typed_result');
    const variantRef = commerceVariantRef(first.value.merchantId, first.value.merchantOrigin, 'item-1'), variant = f.graph.read(owner, variantRef);
    assert.deepEqual(f.related(firstResult.subject!, 'variants').map(v => v.ref), [variantRef], 'Preparation already exposes the quoted business item');
    const firstReceipt = f.related(firstResult.subject!, 'sourceReceipts')[0]!, firstReceiptBefore = structuredClone(firstReceipt);
    const secondTask = f.task(), second = f.snapshot(secondTask, { checkout: 'checkout-b', price: '1500' }), secondResult = f.project(second);
    assert.equal(secondResult.state, 'typed_result');
    assert.deepEqual(f.related(secondResult.subject!, 'variants').map(v => v.ref), [variantRef]);
    assert.deepEqual(f.graph.read(owner, variantRef), variant, 'A price or quote change is not a new product specification');
    assert.notEqual(first.value.checkout.quoteDigest, second.value.checkout.quoteDigest);
    assert.equal(f.graph.read(owner, firstResult.subject!).properties.quoteDigest, first.value.checkout.quoteDigest);
    assert.equal(f.graph.read(owner, secondResult.subject!).properties.quoteDigest, second.value.checkout.quoteDigest);
    assert.deepEqual(f.graph.read(owner, firstReceipt.ref), firstReceiptBefore);
    assert(sourceProof(f.graph, owner, firstResult.subject!, { remaining: 1000 }));
    assert(sourceProof(f.graph, owner, secondResult.subject!, { remaining: 1000 }));
    const confirmA = f.snapshot(f.task(), { checkout: 'checkout-a', order: 'order-a', preparationTaskId: firstTask.id });
    const confirmB = f.snapshot(f.task(), { checkout: 'checkout-b', order: 'order-b', preparationTaskId: secondTask.id, price: '1500' });
    assert.equal(f.project(confirmA).state, 'typed_result'); assert.equal(f.project(confirmB).state, 'typed_result');
    const lines = f.graph.query(owner, { type: 'OrderLine' }).items;
    assert.equal(lines.length, 2); assert.equal(f.graph.query(owner, { type: 'ProductVariant' }).items.length, 1);
    for (const line of lines) assert.deepEqual(f.related(line.ref, 'productVariant').map(v => v.ref), [variantRef]);
    assert.equal(new Set(lines.map(line => line.properties.agreedSpecificationRef)).size, 1);
    assert.deepEqual(new Set(lines.map(line => line.properties.agreedPriceRef)), new Set([first.value.checkout.quoteDigest, second.value.checkout.quoteDigest]));
    const receipts = lines.map(line => f.related(line.ref, 'agreementReceipt')[0]!);
    assert.equal(new Set(receipts.map(receipt => receipt.ref.id)).size, 2);
    for (const [index, receipt] of receipts.entries()) assert((receipt.properties.subjects as { object: ObjectRef; digest: string }[]).some(subject => subject.object.id === lines[index]!.ref.id && subject.digest === digest(lines[index]!.properties)));
    const before = receipts.map(receipt => structuredClone(receipt));
    assert.equal(f.project(confirmB).state, 'typed_result', 'Identical readback preserves its original agreement receipt');
    assert.deepEqual(receipts.map(receipt => f.graph.read(owner, receipt.ref)), before);
  } finally { f.store.close(); }
});

test('same-content reads advance current provenance without product revision and stale conflicting snapshots cannot regress it', () => {
  const f = fixture();
  try {
    const first = f.snapshot(f.task(), { checkout: 'earliest', startedAt: f.base + 1000 }), firstResult = f.project(first), ref = commerceVariantRef(first.value.merchantId, first.value.merchantOrigin, 'item-1');
    const entity = f.graph.read(owner, ref), originalReceipt = f.related(ref, 'currentCommerceReceipt')[0]!;
    const fresh = f.snapshot(f.task(), { checkout: 'fresh', startedAt: f.base + 5000 }), freshResult = f.project(fresh);
    assert.equal(freshResult.state, 'typed_result'); assert.deepEqual(f.graph.read(owner, ref), entity);
    const currentReceipt = f.related(ref, 'currentCommerceReceipt')[0]!;
    assert.notEqual(currentReceipt.ref.id, originalReceipt.ref.id);
    const older = f.snapshot(f.task(), { checkout: 'late-old', title: 'Outdated title', startedAt: f.base + 3000, observedAt: f.base + 6000 });
    const before = f.graph.query(owner, { type: 'CheckoutSession' }).items.length;
    assert.equal(f.project(older).state, 'invalid_source');
    assert.equal(f.graph.query(owner, { type: 'CheckoutSession' }).items.length, before);
    assert.deepEqual(f.graph.read(owner, ref), entity); assert.deepEqual(f.related(ref, 'currentCommerceReceipt')[0], currentReceipt);
    const newer = f.snapshot(f.task(), { checkout: 'new-spec', title: 'Current changed title', startedAt: f.base + 7000 });
    assert.equal(f.project(newer).state, 'typed_result'); assert.equal(f.graph.read(owner, ref).revision, entity.revision + 1);
    assert(sourceProof(f.graph, owner, firstResult.subject!, { remaining: 1000 }), 'Old quote receipt remains exact historical evidence after the entity changes');
    assert.deepEqual(f.graph.read(owner, originalReceipt.ref), originalReceipt);
  } finally { f.store.close(); }
});

test('later order adjustments never rewrite the original line agreement', () => {
  const f = fixture();
  try {
    const job = f.task(), original = f.snapshot(job, { checkout: 'checkout', order: 'order' });
    assert.equal(f.project(original).state, 'typed_result');
    const line = f.graph.query(owner, { type: 'OrderLine' }).items[0]!, agreement = f.related(line.ref, 'agreementReceipt')[0]!;
    const adjusted = f.snapshot(job, { checkout: 'checkout', order: 'order', price: '2000', quantity: 2, title: 'Changed observed title', adjustments: 1 });
    assert.equal(f.project(adjusted).state, 'typed_result');
    assert.deepEqual(f.graph.read(owner, line.ref), line);
    assert.deepEqual(f.related(line.ref, 'agreementReceipt')[0], agreement);
    assert.deepEqual(f.graph.read(owner, agreement.ref), agreement);
    assert.equal(f.graph.query(owner, { type: 'Order' }).items[0]!.properties.orderState, 'unknown');
    assert.equal(f.graph.query(owner, { type: 'ProductVariant' }).items[0]!.revision, 2);
  } finally { f.store.close(); }
});

test('merchant origin and merchant identity remain separate namespaces, without name-based product merging', () => {
  const f = fixture();
  try {
    const a = f.snapshot(f.task()), b = f.snapshot(f.task(), { origin: 'http://127.0.0.1:8282' }), c = f.snapshot(f.task(), { merchant: 'another-merchant' });
    for (const value of [a, b, c]) assert.equal(f.project(value).state, 'typed_result');
    assert.equal(f.graph.query(owner, { type: 'ProductVariant' }).items.length, 3);
    assert.throws(() => f.graph.read('another-owner', commerceVariantRef(a.value.merchantId, a.value.merchantOrigin, 'item-1')));
  } finally { f.store.close(); }
});

test('legacy per-quote product rows and their original order-line references are never rewritten', () => {
  const f = fixture();
  try {
    const job = f.task(), next = f.snapshot(job, { checkout: 'legacy-checkout', order: 'legacy-order' }), s = next.value, namespace = { merchant: s.merchantId, origin: s.merchantOrigin };
    const oldQuote = digest('legacy-quote'), variant = { type: 'ProductVariant', id: digest({ ...namespace, item: 'item-1', quote: oldQuote }) };
    const order = { type: 'Order', id: digest({ ...namespace, order: s.order!.id }) }, line = { type: 'OrderLine', id: digest({ ...namespace, order: s.order!.id, line: 'line-1' }) }, receipt = { type: 'SourceReceipt', id: 'legacy-receipt' };
    const record = (ref: ObjectRef, values: Record<string, unknown>) => ({ ref, properties: { [f.graph.model.object(ref.type).primaryKey]: ref.id, displayTitle: 'Legacy exact record', ...values } });
    const oldVariant = record(variant, { name: 'Original title', sourceProductRef: { namespace: `ucp:${s.merchantId}`, id: 'item-1' }, specification: [{ name: 'merchant_item_id', value: 'item-1' }], specificationRevision: oldQuote });
    const oldOrder = record(order, { providerOrderReference: s.order!.id, orderState: 'confirmed', total: s.order!.total, fulfillmentState: 'pending', sourceStartedAt: new Date(f.base).toISOString() });
    const oldLine = record(line, { quantityOrdered: { amount: '1', unit: 'piece' }, agreedSpecificationRef: `${variant.id}:${oldQuote}`, agreedPriceRef: oldQuote });
    const links: LinkWrite[] = [{ type: 'OrderRequest', from: order, to: { type: 'ServiceRequest', id: job.id } }, { type: 'OrderLineOrder', from: line, to: order }, { type: 'OrderLineVariant', from: line, to: variant }, { type: 'OrderEvidence', from: order, to: receipt }];
    const oldReceipt = record(receipt, { sourceIdentity: `ucp:${s.merchantId}:${s.merchantOrigin}`, sourceEventId: 'legacy-event', scope: 'order', observedAt: new Date(f.base).toISOString(), evidenceLevel: 'synthetic', contentDigest: digest('legacy-response'),
      subjects: [{ object: order, digest: digest(oldOrder.properties), linksDigest: linkSnapshotDigest(order, links) }], safeSummary: 'Historical synthetic receipt' });
    f.graph.ingest(owner, { objects: [oldVariant, oldOrder, oldLine, oldReceipt], links }, { kind: 'synthetic', id: 'legacy-fixture', observedAt: new Date(f.base).toISOString() });
    const beforeVariant = f.graph.read(owner, variant), beforeLine = f.graph.read(owner, line), beforeReceipt = f.graph.read(owner, receipt);
    assert.equal(f.project(next).state, 'typed_result');
    assert.deepEqual(f.graph.read(owner, variant), beforeVariant); assert.deepEqual(f.graph.read(owner, line), beforeLine); assert.deepEqual(f.graph.read(owner, receipt), beforeReceipt);
    assert.deepEqual(f.related(line, 'productVariant').map(value => value.ref), [variant]);
    assert.equal(f.related(line, 'agreementReceipt').length, 0, 'Do not invent a historical agreement receipt');
    assert.equal(f.graph.query(owner, { type: 'ProductVariant' }).items.length, 2, 'Legacy identity remains historical; the current entity is separate without an authorized migration');
  } finally { f.store.close(); }
});
