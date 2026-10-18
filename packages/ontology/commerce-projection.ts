import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { commerceSnapshotSchema } from './commerce.js';
import { moneySchema } from './execution.js';
import type { ObjectRef } from './model.js';
import { linkSnapshotDigest, type LinkWrite, type ObjectWrite, type OntologyObjectStore } from './object-store.js';

export const checkoutRequestSchema = z.object({ requestId: z.string(), requestRevision: z.number().int().positive(), preparationTaskId: z.string(), operation: z.enum(['prepare', 'confirm']), expectedItems: commerceSnapshotSchema.shape.expectedItems, budget: moneySchema.optional() }).strict();
function upsert(graph: OntologyObjectStore, owner: string, ref: ObjectRef, title: string, values: Record<string, unknown>): ObjectWrite {
  let revision: number | undefined;
  try { revision = graph.read(owner, ref).revision; } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
  return { ref, properties: { [graph.model.object(ref.type).primaryKey]: ref.id, displayTitle: title, ...values }, ...(revision ? { expectedRevision: revision } : {}) };
}
export function projectCheckoutRequest(graph: OntologyObjectStore, owner: string, request: { id: string; revision: number }, raw: unknown) {
  const data = checkoutRequestSchema.parse(raw);
  if (data.requestId !== request.id || data.requestRevision !== request.revision || graph.read(owner, { type: 'ServiceRequest', id: request.id }).properties.revision !== request.revision) throw new DomainError('CONFLICT', 'Checkout request projection is stale or belongs to another task');
  const { requestId: _id, ...properties } = data, ref = { type: 'CheckoutRequest', id: `${request.id}:r${request.revision}` };
  graph.ingest(owner, { objects: [upsert(graph, owner, ref, '固定结账要求', properties)], links: [{ type: 'CheckoutRequestTask', from: ref, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
  return ref;
}
export function projectCommerceSnapshot(graph: OntologyObjectStore, owner: string, request: { id: string; revision: number }, capabilityId: string, input: Record<string, unknown>, raw: unknown): { state: 'typed_result' | 'invalid_source'; subject?: ObjectRef } {
  const parsed = commerceSnapshotSchema.safeParse(raw); if (!parsed.success) return { state: 'invalid_source' };
  const s = parsed.data;
  if (capabilityId !== `commerce.ucp.${s.operation}.sandbox` || s.requestId !== request.id || s.requestRevision !== request.revision || s.inputDigest !== digest(input)) return { state: 'invalid_source' };
  const root = graph.read(owner, { type: 'ServiceRequest', id: request.id });
  if (root.properties.revision !== request.revision) return { state: 'invalid_source' };
  graph.read(owner, { type: 'ServiceRequest', id: s.preparationTaskId });
  const namespace = { merchant: s.merchantId, origin: s.merchantOrigin }, session: ObjectRef = { type: 'CheckoutSession', id: digest({ ...namespace, checkout: s.checkout.id }) };
  const observed = s.order?.receipt ?? s.checkout.receipt;
  try {
    const previous = graph.read(owner, session), oldTime = Date.parse(String(previous.properties.sourceStartedAt));
    if (oldTime > Date.parse(observed.startedAt)) return { state: 'invalid_source' };
    const old = commerceSnapshotSchema.parse(previous.properties.snapshot), oldReceipt = old.order?.receipt ?? old.checkout.receipt;
    if (oldTime === Date.parse(observed.startedAt) && oldReceipt.responseSha256 !== observed.responseSha256) return { state: 'invalid_source' };
    if (old.preparationTaskId !== s.preparationTaskId) return { state: 'invalid_source' };
  } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
  const objects: ObjectWrite[] = [], links: LinkWrite[] = [], removeLinks: LinkWrite[] = [];
  const add = (ref: ObjectRef, title: string, properties: Record<string, unknown>) => { const o = upsert(graph, owner, ref, title, properties); objects.push(o); return o; };
  const requirement = add({ type: 'CheckoutRequest', id: `${request.id}:r${request.revision}` }, '固定结账要求', { requestRevision: request.revision, operation: s.operation, expectedItems: s.expectedItems, preparationTaskId: s.preparationTaskId, ...(s.budget ? { budget: s.budget } : {}) });
  links.push({ type: 'CheckoutRequestTask', from: requirement.ref, to: root.ref }, { type: 'CheckoutRequestSession', from: requirement.ref, to: session }, { type: 'CheckoutSessionTask', from: session, to: { type: 'ServiceRequest', id: s.preparationTaskId } }, { type: 'RequestCheckoutSession', from: root.ref, to: session });
  const record = add(session, 'UCP 本地测试结账会话', { merchantId: s.merchantId, merchantOrigin: s.merchantOrigin, providerCheckoutId: s.checkout.id, protocolVersion: s.protocolVersion, state: s.checkout.state, items: s.checkout.items, total: s.checkout.total, quoteDigest: s.checkout.quoteDigest, sourceStartedAt: observed.startedAt, snapshot: s });
  const sealed: { object: ObjectWrite; scope: string; event: string; observedAt: string; content: string }[] = [{ object: record, scope: 'checkout_session', event: observed.id, observedAt: observed.receivedAt, content: observed.responseSha256 }];
  if (s.order) {
    const order = s.order, ref = { type: 'Order', id: digest({ ...namespace, order: order.id }) };
    const storedOrder = add(ref, 'UCP 本地测试订单', { providerOrderReference: order.id, orderState: order.adjustmentCount ? 'unknown' : 'confirmed', total: order.total, fulfillmentState: order.fulfillment, sourceStartedAt: order.receipt.startedAt });
    links.push({ type: 'OrderRequest', from: ref, to: root.ref }, { type: 'OrderCheckout', from: ref, to: session });
    sealed.push({ object: storedOrder, scope: 'order', event: order.receipt.id, observedAt: order.receipt.receivedAt, content: order.receipt.responseSha256 });
    for (const item of order.items) {
      const variant = { type: 'ProductVariant', id: digest({ ...namespace, item: item.id, quote: s.checkout.quoteDigest }) };
      add(variant, item.title, { name: item.title, sourceProductRef: { namespace: `ucp:${s.merchantId}`, id: item.id }, specification: [{ name: 'merchant_item_id', value: item.id }], specificationRevision: s.checkout.quoteDigest });
      const line = { type: 'OrderLine', id: digest({ ...namespace, order: order.id, line: item.lineId }) };
      add(line, item.title, { quantityOrdered: { amount: String(item.quantity), unit: 'piece' }, agreedSpecificationRef: `${variant.id}:${s.checkout.quoteDigest}`, agreedPriceRef: s.checkout.quoteDigest });
      links.push({ type: 'OrderLineOrder', from: line, to: ref }, { type: 'OrderLineVariant', from: line, to: variant });
    }
  }
  for (const sealedObject of sealed) {
    const object = sealedObject.object, receiptRef = { type: 'SourceReceipt', id: digest({ object: object.ref, event: sealedObject.event, content: sealedObject.content }) };
    try {
      for (const old of graph.related(owner, object.ref, 'sourceReceipts', { remaining: 1000 }) ?? []) if (old.ref.id !== receiptRef.id) removeLinks.push({ type: `${object.ref.type}Evidence`, from: object.ref, to: old.ref });
    } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
    add(receiptRef, 'UCP 官方本地测试来源回执', { sourceIdentity: `ucp:${s.merchantId}:${s.merchantOrigin}`, sourceEventId: sealedObject.event, scope: sealedObject.scope, observedAt: sealedObject.observedAt, evidenceLevel: 'synthetic', contentDigest: sealedObject.content, subjects: [{ object: object.ref, digest: digest(object.properties), linksDigest: linkSnapshotDigest(object.ref, links) }], safeSummary: '已校验本地测试商家 HTTP 回执；不代表真实交易或付款到账' });
    links.push({ type: `${object.ref.type}Evidence`, from: object.ref, to: receiptRef }, { type: 'ReceiptRequest', from: receiptRef, to: root.ref });
  }
  graph.ingest(owner, { objects, links, removeLinks }, { kind: 'synthetic', id: `ucp:${s.merchantId}`, observedAt: observed.receivedAt });
  return { state: 'typed_result', subject: session };
}
