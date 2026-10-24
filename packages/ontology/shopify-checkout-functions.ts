import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { shopCheckoutSnapshotSchema, shopLookupArguments, shopCreateArguments, checkoutIdempotencyKey, type ShopCheckoutSnapshot } from '../capabilities/shopify/checkout-contracts.js';
import type { Computation } from './object-functions.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';
import { sourceProof } from './object-evidence.js';

export function checkedShopCheckoutSnapshot(value: unknown): ShopCheckoutSnapshot {
  const snapshot = shopCheckoutSnapshotSchema.parse(value), { contentDigest, ...body } = snapshot;
  if (snapshot.recoveredByRead && snapshot.action !== 'CreateShopifyCheckout') throw new DomainError('CONFLICT', 'Only an uncertain original creation can be reconciled');
  const tool = snapshot.recoveredByRead ? 'get_checkout' : { ReadShopifyCheckoutProducts: 'lookup_catalog', CreateShopifyCheckout: 'create_checkout', ReadShopifyCheckout: 'get_checkout' }[snapshot.action];
  const sourceArguments = snapshot.action === 'ReadShopifyCheckoutProducts' ? shopLookupArguments(snapshot.merchant, snapshot.selection)
    : snapshot.action === 'CreateShopifyCheckout' && !snapshot.recoveredByRead ? shopCreateArguments(snapshot.merchant, snapshot.selection, snapshot.receipt.operationKey!)
      : { shop: snapshot.merchant.domain, id: snapshot.privateCheckoutId };
  if (contentDigest !== digest(body) || snapshot.id !== snapshot.receipt.id || snapshot.receipt.tool !== tool || digest(sourceArguments) !== snapshot.receipt.requestDigest
    || snapshot.observedAt !== snapshot.receipt.receivedAt || Date.parse(snapshot.receipt.startedAt) > Date.parse(snapshot.observedAt)
    || Date.parse(snapshot.expiresAt) !== Date.parse(snapshot.receipt.startedAt) + 300000) throw new DomainError('CONFLICT', 'Shopify source identity, input or validity window changed');
  const selected = snapshot.selection.map(item => [item.variantId, item.quantity]).sort();
  if (snapshot.action === 'ReadShopifyCheckoutProducts') {
    if (!snapshot.products || snapshot.checkout || snapshot.privateCheckoutId || snapshot.continueUrl || digest(snapshot.products.map(item => [item.variantId, item.quantity]).sort()) !== digest(selected)) throw new DomainError('CONFLICT', 'Product observation differs from the selected variants');
  } else {
    if (!snapshot.checkout || !snapshot.privateCheckoutId || snapshot.checkout.checkoutId !== snapshot.privateCheckoutId.split('?')[0]
      || digest(snapshot.checkout.items.map(item => [item.variantId, item.quantity]).sort()) !== digest(selected)
      || snapshot.checkout.hasContinueUrl !== !!snapshot.continueUrl) throw new DomainError('CONFLICT', 'Checkout does not preserve its original identity and items');
    if (!snapshot.creationReceipt || snapshot.creationReceipt.tool !== 'create_checkout' || !snapshot.originalOperationKey
      || snapshot.creationReceipt.operationKey !== snapshot.originalOperationKey || snapshot.creationReceipt.requestDigest !== digest(shopCreateArguments(snapshot.merchant, snapshot.selection, snapshot.originalOperationKey))
      || snapshot.creationReceipt.idempotencyKey !== checkoutIdempotencyKey(snapshot.originalOperationKey)
      || snapshot.creationIdentityDigest !== digest(snapshot.privateCheckoutId)) throw new DomainError('CONFLICT', 'Checkout identity lacks its original creation receipt');
    if (snapshot.receipt.tool === 'get_checkout' && Date.parse(snapshot.receipt.startedAt) < Date.parse(snapshot.creationReceipt.receivedAt)) throw new DomainError('CONFLICT', 'Checkout readback predates its original creation');
    if (snapshot.action === 'CreateShopifyCheckout' && (snapshot.originalIntentId !== snapshot.intentId || snapshot.originalTaskId !== snapshot.requestId || !snapshot.recoveredByRead && snapshot.originalOperationKey !== snapshot.receipt.operationKey)) throw new DomainError('CONFLICT', 'Checkout creation lost its original operation');
    if (snapshot.action === 'ReadShopifyCheckout' && (!snapshot.originalObservation || !snapshot.originalIntentId || !snapshot.originalTaskId || !snapshot.originalOperationKey)) throw new DomainError('CONFLICT', 'Checkout read lacks its original creation provenance');
  }
  return snapshot;
}

export function evaluateShopCheckoutFunction(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (input.function !== 'shopifyCheckoutObservationStatus') return;
  if (!['ShopifyCheckoutProducts', 'ShopifyCheckoutObservation'].includes(input.object.type)) throw new DomainError('INVALID_INPUT', 'Shopify status requires an owned source observation');
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: [input.object], evidenceLevels: [] });
  const record = graph.readPrivate(owner, input.object, budget), proof = sourceProof(graph, owner, input.object, budget);
  if (!proof) return unknown('Shopify public projection or source receipt changed');
  let snapshot: ShopCheckoutSnapshot;
  try { snapshot = checkedShopCheckoutSnapshot(record.properties.snapshot); } catch { return unknown('Shopify original source snapshot is invalid'); }
  if (snapshot.ownerDigest !== digest(owner) || Date.parse(snapshot.observedAt) > graph.now() || Date.parse(snapshot.expiresAt) <= graph.now()) return unknown('Shopify evidence is foreign, expired or from the future');
  const roots = graph.related(owner, input.object, 'request', budget), scopes = graph.related(owner, input.object, 'scope', budget), receipts = graph.related(owner, input.object, 'sourceReceipts', budget);
  const level = snapshot.evidenceKind === 'fixture' ? 'synthetic' : snapshot.receipt.tool === 'create_checkout' ? 'live_operation' : 'live_readonly';
  if (roots?.length !== 1 || roots[0]!.ref.id !== snapshot.requestId || roots[0]!.properties.revision !== snapshot.requestRevision
    || scopes?.length !== 1 || scopes[0]!.ref.id !== snapshot.scopeId || scopes[0]!.properties.configurationDigest !== snapshot.configurationDigest
    || digest(scopes[0]!.properties.merchant) !== digest(snapshot.merchant) || digest(scopes[0]!.properties.selection) !== digest(snapshot.selection)
    || receipts?.length !== 1 || receipts[0]!.properties.contentDigest !== snapshot.contentDigest || receipts[0]!.properties.sourceEventId !== snapshot.receipt.id
    || receipts[0]!.properties.sourceIdentity !== `shopify-shop:${snapshot.merchant.shopId}:${snapshot.merchant.domain}` || proof.levels.some(value => value !== level)) return unknown('Shopify source scope, merchant or receipt no longer matches');
  if (digest(snapshot.products ?? null) !== digest(record.properties.items ?? snapshot.products ?? null) || digest(snapshot.checkout ?? null) !== digest(record.properties.data ?? snapshot.checkout ?? null)) return unknown('Public Shopify facts differ from the sealed original observation');
  return { status: 'known', value: { action: snapshot.action, merchant: snapshot.merchant, ...(snapshot.action === 'ReadShopifyCheckoutProducts' ? { items: snapshot.products } : {}), ...(snapshot.checkout ? { checkout: snapshot.checkout } : {}),
    observedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt, receiptId: snapshot.receipt.id, evidenceKind: snapshot.evidenceKind, paymentActionsAllowed: false, orderActionsAllowed: false }, evidenceRefs: [input.object, ...proof.refs], evidenceLevels: proof.levels };
}
