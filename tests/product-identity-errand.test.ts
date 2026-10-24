import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { digest } from '../packages/core/delegation.js';
import type { AgentActionContext } from '../packages/core/agent-program.js';
import { businessModel, businessConditionSchema } from '../packages/ontology/business-model.js';
import { assessConditions } from '../packages/coordinator/conditions.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';
import type { ObjectRef } from '../packages/ontology/model.js';
import { OntologyObjectStore, linkSnapshotDigest, type LinkWrite } from '../packages/ontology/object-store.js';
import { catalogEntityRefs, projectAgentCatalogObservation } from '../packages/ontology/catalog-agent-projection.js';
import { catalogObservationSchema } from '../packages/ontology/catalog-agent.js';
import { projectCommerceObservation } from '../packages/ontology/commerce-journey-projection.js';
import { checkedCommerceObservation, sourcePayloadDigest } from '../packages/ontology/commerce-journey-functions.js';
import { commerceActionMetadata, type CommerceEntityType, type CommerceJourneyAction } from '../packages/ontology/commerce-journey.js';
import { SHOPIFY_CATALOG_ORIGIN } from '../packages/capabilities/shopify/read-only.js';
import { productAttributesSchema, type ProductAttributes } from '../packages/ontology/product-attributes.js';
import { compareProductAttributes, evaluateProductAttributeFunction } from '../packages/ontology/product-attribute-functions.js';
import { entityIdentityAssertionSchema, pinIdentityEndpoint, projectEntityIdentityAssertion, evaluateIdentityFunction } from '../packages/ontology/identity-mapping.js';
import { compareErrandConstraints, errandConstraintsSchema, evaluateErrandFunction, projectTransactionPartyRole, pinTransactionRoleObject, transactionPartyRoleSchema } from '../packages/ontology/errand-domain.js';

const owner = 'synthetic-owner', baseTime = Date.parse('2026-10-21T01:00:00.000Z');
const attributes = { schemaVersion: '1', profile: 'electronics', color: 'black', condition: 'new', storage: { amount: 256, unit: 'GB' }, package: { kind: 'single_item', itemCount: 1 } } as const;
// All receipts and data are synthetic. Tests use the assembled production model
// and its public evaluators; no external connector is invoked.
function fixture() {
  const db = new DatabaseSync(':memory:'); let now = baseTime + 60000, serial = 0;
  const graph = new OntologyObjectStore(db, businessModel, () => now);
  const source = { kind: 'synthetic' as const, id: 'fixture-source', observedAt: new Date(baseTime).toISOString() };
  const record = (ref: ObjectRef, values: Record<string, unknown>) => ({ ref, properties: { [graph.model.object(ref.type).primaryKey]: ref.id, displayTitle: 'Synthetic business subject', ...values } });
  const put = (ref: ObjectRef, values: Record<string, unknown>, links: LinkWrite[] = []) => graph.ingest(owner, { objects: [record(ref, values)], links }, source);
  const root = { type: 'ServiceRequest', id: randomUUID() };
  put(root, { originalGoal: 'Synthetic domain evidence comparison', revision: 1 });
  const observe = (shop: number, typedAttributes?: ProductAttributes) => {
    const merchant = { id: `shop-${shop}`, name: 'Same display name', shopId: `gid://shopify/Shop/${shop}`, domain: `shop-${shop}.myshopify.com` };
    const scope = { type: 'CatalogTask', id: randomUUID() }, configurationDigest = digest(merchant);
    put(scope, { requestRevision: 1, input: { merchantIds: [merchant.id], country: 'US' }, merchants: [merchant], configurationDigest, allowedActions: ['SearchPublicCatalog'] }, [{ type: 'CatalogTaskRequest', from: scope, to: root }]);
    const id = randomUUID(), start = baseTime + ++serial * 1000, actionInput = { scope, merchantId: merchant.id, query: 'black new 256GB', limit: 10 };
    const body = { id, requestId: root.id, requestRevision: 1, configurationDigest, action: 'SearchPublicCatalog' as const, actionInput,
      planId: randomUUID(), intentId: randomUUID(), attemptId: randomUUID(), modelRunId: randomUUID(), scope, merchant, country: 'US' as const, evidenceKind: 'fixture' as const,
      receipt: { id, endpoint: `${SHOPIFY_CATALOG_ORIGIN}/api/ucp/mcp`, operation: 'search_catalog' as const, startedAt: new Date(start).toISOString(), receivedAt: new Date(start + 100).toISOString(), httpStatus: 200 as const, authentication: 'anonymous' as const, inputSha256: digest(actionInput), responseSha256: digest({ shop, typedAttributes }), responseBytes: 1000 },
      observedAt: new Date(start + 100).toISOString(), expiresAt: new Date(start + 300000).toISOString(), validityBasis: 'local_refresh_limit' as const,
      items: [{ productId: `product-${shop}`, variantId: 'gid://shopify/ProductVariant/123', title: 'Black new 256GB phone', ...(typedAttributes ? { typedAttributes } : {}), displayPrice: { minor: '10000', currency: 'USD' } }],
      completeness: 'partial_or_unknown' as const, stockQuantity: 'unknown' as const, deliveryCommitment: 'unknown' as const, partnerTrust: 'unverified' as const, noBusinessWrites: true as const };
    const snapshot = catalogObservationSchema.parse({ ...body, contentDigest: digest(body) }), observation = projectAgentCatalogObservation(graph, owner, snapshot), variant = catalogEntityRefs(snapshot, snapshot.items[0]!.variantId).variant!;
    return { snapshot, observation, variant, offer: graph.related(owner, observation, 'offers', { remaining: 1000 })![0]!.ref };
  };
  const identity = (left: ReturnType<typeof observe>, right: ReturnType<typeof observe>, changes: Record<string, unknown> = {}) => entityIdentityAssertionSchema.parse({ schemaVersion: '1', ownerDigest: digest(owner), identityKind: 'product_variant',
    left: pinIdentityEndpoint(graph, owner, left.variant, left.observation), right: pinIdentityEndpoint(graph, owner, right.variant, right.observation),
    relation: 'equivalent', lifecycle: 'active', issuerIdentity: 'synthetic-crosswalk', sourceVersion: 1,
    basis: { kind: 'source_crosswalk', reference: 'fixture-explicit-native-variant-crosswalk' }, observedAt: new Date(baseTime + 10000).toISOString(), expiresAt: new Date(baseTime + 120000).toISOString(), reason: 'Explicit synthetic mapping only', ...changes });
  const map = (assertion: ReturnType<typeof identity>) => projectEntityIdentityAssertion(graph, owner, assertion, { sourceIdentity: assertion.issuerIdentity, sourceEventId: `${assertion.issuerIdentity}:${assertion.sourceVersion}`, assertionDigest: digest(assertion), observedAt: assertion.observedAt, evidenceLevel: 'synthetic' });
  const status = (ref: ObjectRef) => graph.evaluate(owner, { function: 'entityIdentityStatus', object: ref });
  const match = (ref: ObjectRef, constraints: unknown = attributes) => graph.evaluate(owner, { function: 'productAttributesMatch', object: ref, constraints });
  return { graph, db, root, observe, identity, map, status, match, put, record, source, setTime: (value: number) => { now = value; } };
}

/** Projection-only source fixture: it starts after synthetic adapter validation.
 * Every payload and receipt is authored here; this is not a provider-auth or
 * order-execution test. The signed HTTP flow is exercised by commerce-agent. */
function commerceAgreementFixture(legacy = false, groupQuantities = [1]) {
  const f = fixture(), scope = { type: 'CommerceTask', id: 'agreement-scope' }, configurationDigest = digest('source-agreement-fixture'), quantity = groupQuantities.reduce((sum, value) => sum + value, 0); let sequence = 0;
  f.put(scope, { requestRevision: 1, input: { query: 'phone', quantity, contextKey: null, target: 'delivery' }, requirements: [], configurationDigest, allowedActions: Object.keys(commerceActionMetadata), environment: 'sandbox' }, [{ type: 'CommerceTaskRequest', from: scope, to: f.root }]);
  const project = (action: CommerceJourneyAction, type: CommerceEntityType, data: Record<string, unknown>, input: Record<string, unknown>, sourceId: string, sourceVersion = 1) => {
    const at = baseTime + ++sequence * 1000, context = { graph: f.graph, owner, request: { id: f.root.id, revision: 1 }, state: { scope, programDigest: configurationDigest }, planId: 'source-plan', intentId: `intent-${sequence}`, attemptId: `attempt-${sequence}`, modelRunId: 'synthetic-model', operationKey: `op-${sequence}` } as unknown as AgentActionContext;
    const payload = { type, sourceId, sourceVersion, data, expiresAt: new Date(baseTime + 300000).toISOString() };
    return projectCommerceObservation(context, action, { scope, ...input }, { payload, receipt: { id: `agreement-source-${sequence}`, requestId: f.root.id, requestRevision: 1, ownerDigest: digest(owner), action, planId: context.planId, intentId: context.intentId, attemptId: context.attemptId, modelRunId: 'synthetic-model', source: commerceActionMetadata[action].source, sourceIdentity: type === 'CommerceDeliveryObservation' ? 'synthetic-carrier' : 'synthetic-merchant', operationKey: context.operationKey!, operationId: `operation-${sequence}`, operationVersion: sourceVersion, method: 'GET', path: '/synthetic/source-observation', status: 200, inputDigest: digest(input), responseSha256: digest(payload), responseBytes: 1000, startedAt: new Date(at).toISOString(), receivedAt: new Date(at + 100).toISOString(), payloadDigest: sourcePayloadDigest(payload), signature: digest('projection-fixture-only'), environment: 'sandbox' } });
  };
  const productData = { merchantId: 'merchant', variantId: 'phone-256', title: 'Phone', sku: 'phone-256', unitPrice: { minor: '10000', currency: 'USD' }, category: 'electronics', availableReported: true, restrictions: [], typedAttributes: attributes };
  const product = project('ReadCommerceProduct', 'CommerceProduct', productData, {}, 'product-1');
  const total = { minor: String(10000 * quantity), currency: 'USD' };
  const groups = groupQuantities.map((quantity, index) => ({ id: `package-${index + 1}`, variantId: 'phone-256', quantity, warehouseId: `warehouse-${index + 1}`, dispatchCountry: 'US', destinationDigest: digest('destination'), carrier: 'Synthetic carrier', service: 'Synthetic delivery', transport: 'road', transitCountries: [] }));
  const component = { id: 'goods', category: 'goods', amount: total, amountStatus: 'fixed', payer: 'buyer', timing: 'checkout', coveredByTotal: true };
  const quoteData = { merchantId: 'merchant', variantId: 'phone-256', quantity, unitPrice: productData.unitPrice, inventoryId: 'synthetic-inventory', inventoryVersion: 1, fulfillmentId: 'synthetic-route', optionId: 'one', customsId: 'synthetic-customs', destinationDigest: digest('destination'), components: [component], buyerTotal: total, scope: 'all_buyer_mandatory_fees', priceKind: 'firm', incoterm: 'domestic', termsVersion: '1', groups, promises: [] };
  const quote = project('QuoteCommerceLandedCost', 'LandedCostQuote', quoteData, { product }, 'quote-1'), quoteSnapshot = checkedCommerceObservation(f.graph.read(owner, quote).properties.snapshot);
  const lines = [{ merchantId: 'merchant', variantId: 'phone-256', title: 'Phone', quantity, unitPrice: productData.unitPrice }];
  const checkoutData = { checkoutId: 'checkout-1', merchantId: 'merchant', quoteId: 'quote-1', quoteDigest: quoteSnapshot.contentDigest, destinationDigest: digest('destination'), lines, total, costComponents: [component], state: 'ready', expiresAt: new Date(baseTime + 300000).toISOString() };
  const checkout = project('PrepareCommerceCheckout', 'CommerceCheckout', checkoutData, { quote }, 'checkout-1');
  const orderData = { orderId: 'order-1', merchantId: 'merchant', checkoutId: 'checkout-1', quoteId: 'quote-1', quoteDigest: quoteSnapshot.contentDigest, destinationDigest: digest('destination'), lines, total, costComponents: [component], state: 'confirmed', fulfillment: 'pending', independentRead: false };
  let legacyBefore;
  if (legacy) {
    const canonical = (type: string, providerId: string) => ({ type, id: digest({ environment: 'commerce-sandbox', configuration: configurationDigest, merchant: 'merchant', providerId, type }) });
    const order = canonical('Order', 'order-1'), line = canonical('OrderLine', 'order-1:phone-256'), variant = f.graph.related(owner, product, 'productVariant', { remaining: 1000 })![0]!.ref;
    const receipt = { type: 'SourceReceipt', id: 'legacy-agreement-source' }, object = f.record(order, { providerOrderReference: 'order-1', orderState: 'unknown' }), links = [{ type: 'OrderRequest', from: order, to: f.root }];
    f.graph.ingest(owner, { objects: [object, f.record(receipt, { sourceIdentity: 'legacy-source', sourceEventId: 'legacy-event', scope: 'order', observedAt: new Date(baseTime).toISOString(), evidenceLevel: 'synthetic', contentDigest: digest(object.properties), subjects: [{ object: order, digest: digest(object.properties), linksDigest: linkSnapshotDigest(order, links) }], safeSummary: 'Preserved legacy synthetic order' }), f.record(line, { quantityOrdered: { amount: '1', unit: 'piece' }, agreedSpecificationRef: '1', agreedPriceRef: 'legacy-price' })], links: [...links, { type: 'OrderEvidence', from: order, to: receipt }, { type: 'OrderLineOrder', from: line, to: order }, { type: 'OrderLineVariant', from: line, to: variant }] }, f.source);
    legacyBefore = f.graph.read(owner, line);
  }
  const orderObservation = project('SubmitCommerceOrder', 'CommerceOrderObservation', orderData, { checkout }, 'order-1');
  const line = f.graph.query(owner, { type: 'OrderLine' }).items[0]!.ref;
  return { ...f, project, scope, productData, product, quote, quoteData, checkout, checkoutData, orderData, orderObservation, line, legacyBefore };
}

test('product profiles distinguish source capacity, color, condition and category; never guess from a title', () => {
  const f = fixture();
  try {
    const good = f.observe(1, attributes), wrong = f.observe(2, { ...attributes, condition: 'used', storage: { amount: 128, unit: 'GB' } }), untyped = f.observe(3);
    assert.equal((f.match(good.variant).value as any).matches, true);
    assert.equal((f.match(good.offer).value as any).matches, true);
    assert.equal((f.match(wrong.variant).value as any).matches, false);
    assert.deepEqual((f.match(wrong.variant).value as any).different, ['condition', 'storage']);
    assert.equal(f.match(untyped.variant).status, 'unknown');
    assert.equal(f.graph.query(owner, { type: 'ProductVariant' }).items.length, 3, 'Equal title and native ID never combine shops');
    assert.throws(() => evaluateProductAttributeFunction(f.graph, 'other-owner', { function: 'productAttributesMatch', object: good.variant, constraints: attributes } as any, { remaining: 10000 }));
    assert.equal(compareProductAttributes({ ...attributes, storage: { amount: 1, unit: 'TB' } }, { ...attributes, storage: { amount: 1000, unit: 'GB' } }).status, 'matches');
    assert.equal(compareProductAttributes({ ...attributes, storage: { amount: 1, unit: 'TiB' } }, { ...attributes, storage: { amount: 1000, unit: 'GB' } }).status, 'different');
    assert.equal(compareProductAttributes({ ...attributes, package: { ...attributes.package, componentCodes: ['device'] } }, attributes).status, 'matches', 'Additional evidenced facts do not change a requested subset');
    assert(!productAttributesSchema.safeParse({ ...attributes, waterproof: true }).success);
    assert(!productAttributesSchema.safeParse({ ...attributes, profile: 'apparel' }).success, 'An apparel profile cannot contain storage');
  } finally { f.db.close(); }
});

test('typed product condition checks preserve request scope and pass, fail and unknown evidence outcomes', () => {
  const f = fixture();
  try {
    const good = f.observe(1, attributes), wrong = f.observe(2, { ...attributes, color: 'white' }), untyped = f.observe(3);
    const check = (object: ObjectRef, requestId: string = f.root.id) => {
      const condition = businessConditionSchema.parse({ id: 'typed-product', predicateRef: { id: 'goods.attributes_match', version: '1' }, subject: { type: object.type, role: 'product_attributes', object }, phase: 'precondition', strength: 'hard', operator: 'eq', expected: attributes, source: { messageId: 'synthetic-message', quote: 'new black 256 GB electronics' } });
      return assessConditions(f.graph, owner, { id: requestId, revision: 1, conditions: [condition] } as ServiceRequest)[0]!;
    };
    assert.equal(check(good.variant).result, 'pass'); assert.equal(check(good.offer).result, 'pass');
    assert.equal(check(wrong.variant).result, 'fail'); assert.equal(check(untyped.variant).result, 'unknown');
    const other = { type: 'ServiceRequest', id: 'other-owned-request' }; f.put(other, { originalGoal: 'A separate request by the same owner', revision: 1 });
    assert.equal(check(good.variant, other.id).result, 'unknown'); assert.equal(check(good.offer, other.id).result, 'unknown');
    assert.deepEqual(check(good.variant).evidenceLevels, ['synthetic']);
  } finally { f.db.close(); }
});

test('updated source attributes invalidate old fixed offers while original observation bytes remain intact', () => {
  const f = fixture();
  try {
    const first = f.observe(1, attributes), old = f.graph.read(owner, first.observation), original = f.graph.read(owner, first.variant);
    const changed = f.observe(1, { ...attributes, color: 'white' });
    assert.deepEqual(changed.variant, first.variant);
    assert.equal(f.graph.read(owner, first.variant).revision, original.revision + 1);
    assert.equal(f.match(first.offer).status, 'unknown');
    assert.equal((f.match(changed.variant).value as any).matches, false);
    assert.deepEqual(f.graph.read(owner, first.observation), old);
  } finally { f.db.close(); }
});

test('commerce product observations preserve one variant across source price currencies and retain the exact typed evidence', () => {
  const f = fixture();
  try {
    const scope = { type: 'CommerceTask', id: 'commerce-scope' }, configurationDigest = digest('synthetic-commerce');
    f.put(scope, { requestRevision: 1, input: { query: 'phone', quantity: 1, contextKey: null, target: 'quote' }, requirements: [], configurationDigest, allowedActions: ['ReadCommerceProduct'], environment: 'sandbox' }, [{ type: 'CommerceTaskRequest', from: scope, to: f.root }]);
    let serial = 0;
    const read = (currency: 'CNY' | 'USD', typedAttributes: ProductAttributes | null = attributes, sourceVersion = 1) => {
      const context = { graph: f.graph, owner, request: { id: f.root.id, revision: 1 }, state: { scope, programDigest: configurationDigest }, planId: 'plan', intentId: `intent-${++serial}`, attemptId: `attempt-${serial}`, modelRunId: 'synthetic-model', operationKey: `op-${serial}` } as unknown as AgentActionContext;
      const input = { scope, merchantId: 'merchant', query: 'phone' }, payload = { type: 'CommerceProduct' as const, sourceId: `merchant:variant:${currency}`, sourceVersion, expiresAt: new Date(baseTime + 300000).toISOString(), data: { merchantId: 'merchant', variantId: 'variant', title: 'Phone', sku: 'SKU-1', unitPrice: { minor: currency === 'CNY' ? '70000' : '10000', currency }, category: 'source-category', availableReported: true, restrictions: [], ...(typedAttributes ? { typedAttributes } : {}) } };
      return projectCommerceObservation(context, 'ReadCommerceProduct', input, { payload, receipt: { id: `product-read-${serial}`, requestId: f.root.id, requestRevision: 1, ownerDigest: digest(owner), action: 'ReadCommerceProduct', planId: context.planId, intentId: context.intentId, attemptId: context.attemptId, modelRunId: 'synthetic-model', source: 'merchant', sourceIdentity: 'synthetic-merchant', operationKey: context.operationKey!, operationId: `operation-${serial}`, operationVersion: 1, method: 'GET', path: '/fixture/product', status: 200, inputDigest: digest(input), responseSha256: digest(payload), responseBytes: 1000, startedAt: new Date(baseTime + serial * 1000).toISOString(), receivedAt: new Date(baseTime + serial * 1000 + 100).toISOString(), payloadDigest: sourcePayloadDigest(payload), signature: digest('synthetic-only'), environment: 'sandbox' } });
    };
    const first = read('CNY'), variant = f.graph.related(owner, first, 'productVariant', { remaining: 1000 })![0]!, before = f.graph.read(owner, first);
    const second = read('USD');
    assert.deepEqual(f.graph.read(owner, variant.ref), variant, 'Changing price currency does not rewrite the stable specification');
    assert.deepEqual(f.graph.related(owner, second, 'productVariant', { remaining: 1000 })!.map(value => value.ref), [variant.ref]);
    assert.deepEqual(f.graph.read(owner, first), before, 'Old prices and source observations remain unchanged');
    assert.equal((f.match(variant.ref).value as any).matches, true);
    assert.equal((f.match(second).value as any).matches, true);
    const assess = (object: ObjectRef, requestId: string = f.root.id) => {
      const condition = businessConditionSchema.parse({ id: 'commerce-typed-product', predicateRef: { id: 'goods.attributes_match', version: '1' }, subject: { type: 'CommerceProduct', role: 'product_attributes', object }, phase: 'precondition', strength: 'hard', operator: 'eq', expected: attributes, source: { messageId: 'synthetic-message', quote: 'new black 256 GB electronics' } });
      return assessConditions(f.graph, owner, { id: requestId, revision: 1, conditions: [condition] } as ServiceRequest)[0]!;
    };
    assert.equal(assess(second).result, 'pass');
    f.put({ type: 'ServiceRequest', id: 'other-commerce-request' }, { originalGoal: 'Same owner, distinct request', revision: 1 });
    assert.equal(assess(second, 'other-commerce-request').result, 'unknown');
    assert.throws(() => read('USD', { ...attributes, condition: 'used' }), /regressed or conflicts/);
    const changed = read('USD', { ...attributes, condition: 'used' }, 2);
    assert.equal((f.match(variant.ref).value as any).matches, false);
    assert.equal(assess(changed).result, 'fail');
    const absent = read('USD', null, 3); assert.equal(assess(absent).result, 'unknown');
  } finally { f.db.close(); }
});

test('new order lines retain their original sealed typed agreement across later product and order reads; delivery identity is not physical inspection', () => {
  const f = commerceAgreementFixture();
  try {
    const before = f.graph.read(owner, f.line), receipt = f.graph.related(owner, f.line, 'agreementReceipt', { remaining: 1000 })![0]!;
    const status = () => f.graph.evaluate(owner, { function: 'orderLineAgreementStatus', object: f.line });
    assert.equal(status().status, 'known'); assert.deepEqual((status().value as any).agreedAttributes, attributes);
    assert.deepEqual(f.graph.related(owner, f.line, 'agreedProduct', { remaining: 1000 })!.map(value => value.ref), [f.product]);
    f.graph.ingest(owner, { objects: [{ ref: f.line, properties: before.properties }], links: [{ type: 'OrderLineAgreedCommerceProduct', from: f.line, to: f.product }, { type: 'OrderLineAgreementReceipt', from: f.line, to: receipt.ref }] }, before.source);
    assert.deepEqual(f.graph.read(owner, f.line), before, 'Exact object and relationship replay is idempotent');
    assert.throws(() => f.graph.ingest(owner, { objects: [{ ref: f.line, expectedRevision: before.revision, properties: { ...before.properties, quantityOrdered: { amount: '2', unit: 'piece' } } }] }, before.source), /cannot acquire or replace/);
    assert.throws(() => f.graph.ingest(owner, { objects: [], removeLinks: [{ type: 'OrderLineAgreedCommerceProduct', from: f.line, to: f.product }] }, before.source), /immutable/);
    const changedProduct = f.project('ReadCommerceProduct', 'CommerceProduct', { ...f.productData, typedAttributes: { ...attributes, color: 'white', condition: 'used' } }, {}, 'product-1', 2);
    assert.throws(() => f.graph.ingest(owner, { objects: [], links: [{ type: 'OrderLineAgreedCommerceProduct', from: f.line, to: changedProduct }] }, before.source), /immutable/);
    const order = f.project('ReadCommerceOrder', 'CommerceOrderObservation', { ...f.orderData, independentRead: true }, { order: f.orderObservation }, 'order-1');
    assert.deepEqual(f.graph.read(owner, f.line), before); assert.deepEqual(f.graph.read(owner, receipt.ref), receipt);
    assert.deepEqual((status().value as any).agreedAttributes, attributes, 'Historical specification reads its original observation, not the refreshed catalog');
    f.project('ReadCommerceDelivery', 'CommerceDeliveryObservation', { orderId: 'order-1', merchantId: 'merchant', destinationDigest: digest('destination'), state: 'delivered', events: [{ id: 'event-1', groupId: 'package-1', variantId: 'phone-256', quantity: 1, occurredAt: new Date(baseTime + 6000).toISOString(), milestone: 'delivered', destinationDigest: digest('destination') }] }, { order }, 'delivery-1');
    const allocation = f.graph.query(owner, { type: 'DeliveryAllocation' }).items[0]!;
    assert.equal(allocation.properties.acceptedSpecificationRef, before.properties.agreedSpecificationRef);
    assert.deepEqual(allocation.properties.verificationBasis, { kind: 'source_reported_variant_identity', reportedVariantId: 'phone-256', sourceObservation: f.graph.query(owner, { type: 'CommerceDeliveryObservation' }).items[0]!.ref, physicalAttributes: 'unknown' });
    assert(!JSON.stringify(allocation.properties).includes('typedAttributes'));
    assert.equal((status().value as any).physicalAttributes, 'unknown'); assert.equal((status().value as any).provesDelivery, false);
    assert.deepEqual(f.graph.evaluate(owner, { function: 'remainingQuantity', object: f.line }).value, { amount: '0', unit: 'piece' });
    assert.throws(() => f.graph.evaluate('another-owner', { function: 'orderLineAgreementStatus', object: f.line }));
  } finally { f.db.close(); }
});

test('legacy order lines are never backfilled with a new observed agreement or rewritten by a later source read', () => {
  const f = commerceAgreementFixture(true);
  try {
    assert.deepEqual(f.graph.read(owner, f.line), f.legacyBefore);
    assert.equal(f.graph.related(owner, f.line, 'agreedProduct', { remaining: 1000 })!.length, 0);
    assert.equal(f.graph.related(owner, f.line, 'agreementReceipt', { remaining: 1000 })!.length, 0);
    assert.equal(f.graph.evaluate(owner, { function: 'orderLineAgreementStatus', object: f.line }).status, 'unknown');
    const pin = (object: ObjectRef) => { const snapshot = checkedCommerceObservation(f.graph.read(owner, object).properties.snapshot); return { object, contentDigest: snapshot.contentDigest, sourceId: snapshot.sourceId, sourceVersion: snapshot.sourceVersion, checkedAt: new Date(baseTime + 60000).toISOString() }; };
    const invented = { schemaVersion: '1', basis: 'source_order_and_checkout', merchantId: 'merchant', variantId: 'phone-256', product: pin(f.product), quote: pin(f.quote), checkout: pin(f.checkout), order: pin(f.orderObservation) };
    assert.throws(() => f.graph.ingest(owner, { objects: [{ ref: f.line, expectedRevision: f.legacyBefore!.revision, properties: { ...f.legacyBefore!.properties, sourceAgreement: invented, agreedSpecificationRef: digest(invented) } }] }, f.legacyBefore!.source), /cannot acquire or replace/);
    f.project('ReadCommerceOrder', 'CommerceOrderObservation', { ...f.orderData, independentRead: true }, { order: f.orderObservation }, 'order-1');
    assert.deepEqual(f.graph.read(owner, f.line), f.legacyBefore);
  } finally { f.db.close(); }
});

test('every original quote group remains a planned shipment; a received first package cannot hide a missing second package', () => {
  const f = commerceAgreementFixture(false, [1, 1]);
  try {
    const planned = f.graph.query(owner, { type: 'Shipment' }).items, byGroup = new Map(planned.map(value => [(value.properties.expectedAllocation as any).sourceGroupId, value]));
    assert.equal(planned.length, 2);
    for (const shipment of planned) {
      assert.match(String(shipment.properties.displayTitle), /计划分包.*尚无发货证据/); assert.equal(shipment.properties.shipmentState, 'pending');
      const status = f.graph.evaluate(owner, { function: 'shipmentAllocationStatus', object: shipment.ref });
      assert.equal(status.status, 'known'); assert.equal((status.value as any).status, 'pending'); assert.deepEqual((status.value as any).remainingQuantity, { amount: '1', unit: 'piece' });
    }
    const first = byGroup.get('package-1')!, second = byGroup.get('package-2')!, expected = second.properties.expectedAllocation as Record<string, unknown>;
    f.graph.ingest(owner, { objects: [{ ref: second.ref, properties: second.properties }], links: [{ type: 'ShipmentExpectedOrderLine', from: second.ref, to: f.line }, { type: 'ShipmentExpectedSourceQuote', from: second.ref, to: f.quote }] }, second.source);
    assert.deepEqual(f.graph.read(owner, second.ref), second);
    assert.throws(() => f.graph.ingest(owner, { objects: [{ ref: second.ref, expectedRevision: second.revision, properties: { ...second.properties, expectedAllocation: { ...expected, quantity: { amount: '2', unit: 'piece' } } } }] }, second.source), /cannot acquire or replace/);
    assert.throws(() => f.graph.ingest(owner, { objects: [], removeLinks: [{ type: 'ShipmentExpectedOrderLine', from: second.ref, to: f.line }] }, second.source), /immutable/);
    const originalOrder = f.graph.related(owner, second.ref, 'order', { remaining: 1000 })![0]!.ref;
    assert.throws(() => f.graph.ingest(owner, { objects: [], removeLinks: [{ type: 'ShipmentOrder', from: second.ref, to: originalOrder }] }, second.source), /immutable/);
    f.project('ReadCommerceDelivery', 'CommerceDeliveryObservation', { orderId: 'order-1', merchantId: 'merchant', destinationDigest: digest('destination'), state: 'partial', events: [{ id: 'first-package', groupId: 'package-1', variantId: 'phone-256', quantity: 1, occurredAt: new Date(baseTime + 4500).toISOString(), milestone: 'delivered', destinationDigest: digest('destination') }] }, { order: f.orderObservation }, 'delivery-partial');
    const received = f.graph.evaluate(owner, { function: 'shipmentAllocationStatus', object: first.ref }), missing = f.graph.evaluate(owner, { function: 'shipmentAllocationStatus', object: second.ref });
    assert.equal((received.value as any).status, 'source_reported_quantity_complete'); assert.deepEqual((received.value as any).remainingQuantity, { amount: '0', unit: 'piece' });
    assert.equal((missing.value as any).status, 'pending'); assert.deepEqual((missing.value as any).remainingQuantity, { amount: '1', unit: 'piece' });
    assert.deepEqual(f.graph.read(owner, second.ref), second, 'A missing event does not erase the second planned package');
    assert.deepEqual(f.graph.evaluate(owner, { function: 'remainingQuantity', object: f.line }).value, { amount: '1', unit: 'piece' });
    const refreshedProduct = f.project('ReadCommerceProduct', 'CommerceProduct', { ...f.productData, unitPrice: { minor: '11000', currency: 'USD' } }, {}, 'product-1', 2);
    const changedQuote = f.project('QuoteCommerceLandedCost', 'LandedCostQuote', { ...f.quoteData, unitPrice: { minor: '11000', currency: 'USD' }, buyerTotal: { minor: '22000', currency: 'USD' }, components: [{ ...f.quoteData.components[0], amount: { minor: '22000', currency: 'USD' } }], groups: [{ ...f.quoteData.groups[0], id: 'new-single-package', quantity: 2 }] }, { product: refreshedProduct }, 'new-quote');
    assert.throws(() => f.graph.ingest(owner, { objects: [], links: [{ type: 'ShipmentExpectedSourceQuote', from: second.ref, to: changedQuote }] }, second.source), /immutable/);
    f.project('ReadCommerceOrder', 'CommerceOrderObservation', { ...f.orderData, independentRead: true }, { order: f.orderObservation }, 'order-1');
    assert.equal(f.graph.query(owner, { type: 'Shipment' }).items.length, 2, 'A later price or proposed split cannot replace the original order package plan');
    assert.deepEqual(f.graph.read(owner, second.ref), second);
    assert.equal((f.graph.evaluate(owner, { function: 'shipmentAllocationStatus', object: second.ref }).value as any).physicalAttributes, 'unknown');
  } finally { f.db.close(); }
});

test('new source orders reject duplicate, excessive or misbound planned group allocations atomically', () => {
  const f = commerceAgreementFixture();
  try {
    const group = f.quoteData.groups[0]!;
    for (const [name, groups] of [
      ['duplicate', [group, group]], ['excessive', [{ ...group, quantity: 2 }]],
      ['wrong-variant', [{ ...group, variantId: 'another-variant' }]], ['wrong-destination', [{ ...group, destinationDigest: digest('another-destination') }]],
    ] as const) {
      const quoteId = `quote-${name}`, checkoutId = `checkout-${name}`, quote = f.project('QuoteCommerceLandedCost', 'LandedCostQuote', { ...f.quoteData, groups }, { product: f.product }, quoteId);
      const quoteDigest = checkedCommerceObservation(f.graph.read(owner, quote).properties.snapshot).contentDigest;
      const checkout = f.project('PrepareCommerceCheckout', 'CommerceCheckout', { ...f.checkoutData, checkoutId, quoteId, quoteDigest }, { quote }, checkoutId);
      assert.throws(() => f.project('SubmitCommerceOrder', 'CommerceOrderObservation', { ...f.orderData, orderId: `order-${name}`, checkoutId, quoteId, quoteDigest }, { checkout }, `order-${name}`), /fulfillment groups/);
    }
    assert.throws(() => f.project('SubmitCommerceOrder', 'CommerceOrderObservation', { ...f.orderData, orderId: 'order-changed-total', total: { minor: '20000', currency: 'USD' } }, { checkout: f.checkout }, 'order-changed-total'), /differs from the original fixed source contract/);
    assert.equal(f.graph.query(owner, { type: 'OrderLine' }).items.length, 1); assert.equal(f.graph.query(owner, { type: 'Shipment' }).items.length, 1);
  } finally { f.db.close(); }
});

test('identity assertions navigate both actual objects and are owner/source/version bound without merging', () => {
  const f = fixture();
  try {
    const a = f.observe(1, attributes), b = f.observe(2, attributes), record = f.identity(a, b), ref = f.map(record);
    assert.equal((f.status(ref).value as any).status, 'equivalent');
    assert.deepEqual(f.graph.related(owner, ref, 'leftSubject', { remaining: 1000 })!.map(o => o.ref), [a.variant]);
    assert.deepEqual(f.graph.related(owner, ref, 'rightSubject', { remaining: 1000 })!.map(o => o.ref), [b.variant]);
    assert.equal(f.graph.query(owner, { type: 'ProductVariant' }).items.length, 2);
    assert.equal((f.status(ref).value as any).grantsAuthority, false);
    assert.throws(() => projectEntityIdentityAssertion(f.graph, 'other-owner', record, { sourceIdentity: record.issuerIdentity, sourceEventId: '1', assertionDigest: digest(record), observedAt: record.observedAt, evidenceLevel: 'synthetic' }));
    assert.throws(() => f.map({ ...record, relation: 'different' }), /immutable/);
    assert.throws(() => projectEntityIdentityAssertion(f.graph, owner, record, { sourceIdentity: record.issuerIdentity, sourceEventId: 'live-promotion', assertionDigest: digest(record), observedAt: record.observedAt, evidenceLevel: 'live_readonly' }), /promoted/);
    const unmatched = evaluateIdentityFunction(f.graph, owner, { function: 'entityIdentityBetween', object: a.variant, other: f.observe(3, attributes).variant, identityKind: 'product_variant' } as any, { remaining: 10000 });
    assert.equal((unmatched!.value as any).status, 'unknown');
    f.observe(1, { ...attributes, condition: 'used' });
    assert.equal((f.status(ref).value as any).status, 'unknown', 'A prior identity proof does not apply to a changed variant version');
  } finally { f.db.close(); }
});

test('independent contradictory identity evidence conflicts; revocation, expiry and histories are explicit', () => {
  const f = fixture();
  try {
    const a = f.observe(1, attributes), b = f.observe(2, attributes), assertion = f.identity(a, b), first = f.map(assertion), before = f.graph.read(owner, first);
    const contrary = f.map(f.identity(a, b, { issuerIdentity: 'another-source', relation: 'different' }));
    assert.equal((f.status(first).value as any).status, 'conflict');
    const revoked = f.map(f.identity(a, b, { issuerIdentity: 'another-source', relation: 'different', lifecycle: 'revoked', sourceVersion: 2, supersedes: contrary, observedAt: new Date(baseTime + 20000).toISOString() }));
    assert.equal((f.status(revoked).value as any).status, 'equivalent', 'An independent still-current assertion remains explicitly visible');
    assert.deepEqual(f.graph.read(owner, first), before);
    f.map({ ...assertion, lifecycle: 'revoked', sourceVersion: 2, supersedes: first, observedAt: new Date(baseTime + 20000).toISOString() });
    assert.equal((f.status(first).value as any).status, 'revoked');
    assert.equal((f.status(first).value as any).superseded, true);
    assert.deepEqual(f.graph.read(owner, first), before, 'Revocation appends history; original bytes are untouched');
  } finally { f.db.close(); }
  const e = fixture();
  try { const ref = e.map(e.identity(e.observe(1, attributes), e.observe(2, attributes))); e.setTime(baseTime + 120001); assert.equal((e.status(ref).value as any).status, 'expired'); }
  finally { e.db.close(); }
});

test('errand schemas reject unsupported fields and do not count absent handling or a different subtype as fulfilled', () => {
  const requested = { schemaVersion: '1', serviceType: 'parcel_delivery', handling: { fragile: true, temperatureC: { minimum: 2, maximum: 8 } }, parcel: { packageCount: 2 } };
  assert.equal(compareErrandConstraints(undefined, requested).status, 'unknown');
  assert.equal(compareErrandConstraints({ schemaVersion: '1', serviceType: 'parcel_delivery' }, requested).status, 'unknown');
  assert.equal(compareErrandConstraints(requested, requested).status, 'matches');
  assert.equal(compareErrandConstraints({ ...requested, handling: { ...requested.handling, fragile: false } }, requested).status, 'different');
  assert.equal(compareErrandConstraints(requested, { schemaVersion: '1', serviceType: 'purchase_and_deliver' }).status, 'unsupported');
  assert(!errandConstraintsSchema.safeParse({ ...requested, guaranteedExpress: true }).success);
  assert(!errandConstraintsSchema.safeParse({ ...requested, handling: { temperatureC: { minimum: 8, maximum: 2 } } }).success);
  assert(!errandConstraintsSchema.safeParse({ ...requested, pickupWindow: { startsAt: '2026-10-21T02:00:00Z', endsAt: '2026-10-21T01:00:00Z', timeZone: 'Asia/Shanghai' } }).success);
});

test('only a fresh source-sealed errand commitment for the current parcel and route can match', () => {
  const f = fixture();
  try {
    const parcel = { type: 'Parcel', id: 'quoted-parcel' }, route = { type: 'DeliveryRoute', id: 'quoted-route' }, provider = { type: 'Provider', id: 'quoted-provider' }, channel = { type: 'Channel', id: 'quoted-channel' };
    f.put(parcel, { declaredContents: 'Fragile documents' }, [{ type: 'ParcelRequest', from: parcel, to: f.root }]);
    f.put(route, {}, [{ type: 'RouteRequest', from: route, to: f.root }, { type: 'SelectedRoute', from: f.root, to: route }]);
    f.put(provider, { name: 'Synthetic courier operator' }); f.put(channel, { name: 'Synthetic quote source' });
    const constraints = { schemaVersion: '1', serviceType: 'parcel_delivery', handling: { fragile: true }, parcel: { packageCount: 2 } };
    const quote = (withCommitments: boolean) => {
      const ref = { type: 'DeliveryQuote', id: randomUUID() }, receipt = { type: 'SourceReceipt', id: randomUUID() };
      const object = f.record(ref, { observedAt: new Date(baseTime).toISOString(), expiresAt: new Date(baseTime + 300000).toISOString(), validityBasis: 'provider_expiry', priceKind: 'estimate', pricingCompleteness: 'partial', serviceLevel: 'ordinary', quotedWeight: { amount: '1', unit: 'kg' }, requestRevision: 1, parcelRevision: 1, routeRevision: 1, ...(withCommitments ? { errandCommitments: constraints } : {}) });
      const links = [{ type: 'OfferRequest', from: ref, to: f.root }, { type: 'QuoteParcel', from: ref, to: parcel }, { type: 'QuoteRoute', from: ref, to: route }, { type: 'OfferProvider', from: ref, to: provider }, { type: 'OfferChannel', from: ref, to: channel }];
      f.graph.ingest(owner, { objects: [object, f.record(receipt, { sourceIdentity: 'synthetic-quote', sourceEventId: ref.id, scope: 'delivery_quote', observedAt: new Date(baseTime).toISOString(), evidenceLevel: 'synthetic', contentDigest: digest(object.properties), subjects: [{ object: ref, digest: digest(object.properties), linksDigest: linkSnapshotDigest(ref, links) }], safeSummary: 'Synthetic quote commitments only' })], links: [...links, { type: 'DeliveryQuoteEvidence', from: ref, to: receipt }] }, f.source);
      return ref;
    };
    const known = quote(true), absent = quote(false);
    const evaluate = (object: ObjectRef, expected: unknown = constraints) => evaluateErrandFunction(f.graph, owner, { function: 'errandQuoteMatches', object, constraints: expected } as any, { remaining: 1000 })!;
    assert.equal((evaluate(known).value as any).matches, true);
    assert.deepEqual(evaluate(known).evidenceLevels, ['synthetic']);
    assert.equal(evaluate(absent).status, 'unknown');
    assert.equal((evaluate(known, { schemaVersion: '1', serviceType: 'queue_and_submit' }).value as any).status, 'unsupported');
    const assess = (object: ObjectRef, expected: unknown) => {
      const condition = businessConditionSchema.parse({ id: 'typed-errand', predicateRef: { id: 'errand.quote_matches', version: '1' }, subject: { type: 'DeliveryQuote', role: 'errand_requirements', object }, phase: 'result', strength: 'hard', operator: 'eq', expected, source: { messageId: 'synthetic-message', quote: 'two fragile parcels' } });
      return assessConditions(f.graph, owner, { id: f.root.id, revision: 1, conditions: [condition] } as ServiceRequest)[0]!;
    };
    assert.equal(assess(known, constraints).result, 'pass'); assert.equal(assess(absent, constraints).result, 'unknown');
    assert.equal(assess(known, { schemaVersion: '1', serviceType: 'queue_and_submit' }).result, 'fail');
    const old = f.graph.read(owner, parcel);
    f.graph.ingest(owner, { objects: [{ ref: parcel, expectedRevision: old.revision, properties: { ...old.properties, declaredContents: 'Changed contents' } }] }, { ...f.source, observedAt: new Date(baseTime + 1000).toISOString() });
    assert.equal(evaluate(known).status, 'unknown', 'Changing the parcel invalidates the old commitment even with an intact source receipt');
  } finally { f.db.close(); }
});

test('hotel identity uses actual source observations and does not identify room types, rate plans or stock', () => {
  const f = fixture();
  try {
    const hotel = (name: string) => {
      const entity = { type: 'HotelProperty', id: name }, observation = { type: 'HotelPropertyObservation', id: `${name}:v1` }, provider = { type: 'Provider', id: `${name}:operator` }, receipt = { type: 'SourceReceipt', id: `${name}:receipt` };
      f.put(provider, { name: 'Synthetic lodging operator' });
      const object = f.record(entity, { sourceId: '123', sourceRevision: '1', hotelName: 'Same name hotel', address: 'Same display address', timeZone: 'Asia/Shanghai' });
      const observed = f.record(observation, { sourceIdentity: name, providerIdentity: provider.id, nativeIdentity: '123', sourceRevision: '1', sourceVersion: 1, sourceEventId: 'event-1', observedAt: new Date(baseTime).toISOString(), contentDigest: digest(object.properties), valuesDigest: digest(object.properties), snapshot: object.properties });
      const links = [{ type: 'HotelPropertyCurrentObservation', from: entity, to: observation }, { type: 'HotelPropertyObservationEntity', from: observation, to: entity }, { type: 'HotelPropertyObservationProvider', from: observation, to: provider }];
      const sealed = f.record(receipt, { sourceIdentity: name, sourceEventId: 'event-1', scope: 'domain_hotel', observedAt: new Date(baseTime).toISOString(), evidenceLevel: 'synthetic', contentDigest: digest([object.properties, observed.properties]), subjects: [object, observed].map(value => ({ object: value.ref, digest: digest(value.properties), linksDigest: linkSnapshotDigest(value.ref, links) })), safeSummary: 'Synthetic hotel identity evidence' });
      f.graph.ingest(owner, { objects: [object, observed, sealed], links: [...links, { type: 'HotelPropertyEvidence', from: entity, to: receipt }, { type: 'HotelPropertyObservationEvidence', from: observation, to: receipt }] }, f.source);
      return { entity, observation };
    };
    const a = hotel('source-a'), b = hotel('source-b'), assertion = entityIdentityAssertionSchema.parse({ schemaVersion: '1', ownerDigest: digest(owner), identityKind: 'hotel_property', left: pinIdentityEndpoint(f.graph, owner, a.entity, a.observation), right: pinIdentityEndpoint(f.graph, owner, b.entity, b.observation), relation: 'equivalent', lifecycle: 'active', issuerIdentity: 'synthetic-crosswalk', sourceVersion: 1, basis: { kind: 'issuer_verified_identifiers', reference: 'explicit-property-registration-crosswalk' }, observedAt: new Date(baseTime + 10000).toISOString(), expiresAt: new Date(baseTime + 120000).toISOString(), reason: 'Synthetic property-level match only' });
    const ref = f.map(assertion);
    assert.equal((f.status(ref).value as any).status, 'equivalent');
    assert.equal((f.status(ref).value as any).transfersTerms, false);
    assert(!entityIdentityAssertionSchema.safeParse({ ...assertion, identityKind: 'room_type' }).success);
    assert.equal(f.graph.query(owner, { type: 'HotelProperty' }).items.length, 2);
    assert.equal(f.graph.query(owner, { type: 'RoomInventory' }).items.length, 0, 'Identity matching creates no room inventory or availability');
  } finally { f.db.close(); }
});

test('scoped roles reuse existing actors and selected contacts; user declarations never become a seller or courier proof', () => {
  const f = fixture();
  try {
    const parcel = { type: 'Parcel', id: 'parcel' }, provider = { type: 'Provider', id: 'provider' }, address = { type: 'SavedAddress', id: 'contact' };
    f.put(parcel, { declaredContents: 'Documents' }, [{ type: 'ParcelRequest', from: parcel, to: f.root }]);
    f.put(provider, { name: 'Existing operator' }); f.put(address, { label: 'Selected private contact', sourceReference: 'PRIVATE_NOT_A_PERSON_ID' });
    const assignment = transactionPartyRoleSchema.parse({ schemaVersion: '1', ownerDigest: digest(owner), role: 'courier', scope: pinTransactionRoleObject(f.graph, owner, parcel), party: pinTransactionRoleObject(f.graph, owner, provider), state: 'assigned', issuerIdentity: 'synthetic-contract', sourceVersion: 1, observedAt: new Date(baseTime + 10000).toISOString(), expiresAt: new Date(baseTime + 120000).toISOString(), basisReference: 'contract-role-1' });
    const create = (value: typeof assignment, evidenceLevel: 'synthetic' | 'user_asserted') => projectTransactionPartyRole(f.graph, owner, value, { sourceIdentity: value.issuerIdentity, sourceEventId: `${value.role}:${value.sourceVersion}`, assignmentDigest: digest(value), observedAt: value.observedAt, evidenceLevel });
    assert.throws(() => create(assignment, 'user_asserted'), /cannot prove/);
    const ref = create(assignment, 'synthetic'), before = f.graph.read(owner, ref);
    const evaluate = (object: ObjectRef) => evaluateErrandFunction(f.graph, owner, { function: 'transactionRoleStatus', object }, { remaining: 1000 })!;
    assert.equal((evaluate(ref).value as any).status, 'assigned');
    const sender = create({ ...assignment, role: 'sender', party: pinTransactionRoleObject(f.graph, owner, address) }, 'user_asserted');
    assert.equal((evaluate(sender).value as any).status, 'declared');
    assert.equal(f.graph.query(owner, { type: 'Provider' }).items.length, 1, 'Role assignments do not create duplicate parties');
    assert(!JSON.stringify(evaluate(sender)).includes('PRIVATE_NOT_A_PERSON_ID'));
    assert.throws(() => create({ ...assignment, role: 'seller', party: pinTransactionRoleObject(f.graph, owner, address) }, 'synthetic'));
    const revoked = create({ ...assignment, state: 'revoked', sourceVersion: 2, supersedes: ref, observedAt: new Date(baseTime + 20000).toISOString() }, 'synthetic');
    assert.equal((evaluate(ref).value as any).status, 'superseded'); assert.equal((evaluate(revoked).value as any).status, 'revoked');
    assert.deepEqual(f.graph.read(owner, ref), before);
    assert.throws(() => evaluateErrandFunction(f.graph, 'other-owner', { function: 'transactionRoleStatus', object: ref }, { remaining: 1000 }));
  } finally { f.db.close(); }
});
