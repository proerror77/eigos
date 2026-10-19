import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { AgentActionContext } from '../core/agent-program.js';
import { objectRefSchema, type ObjectRef } from './model.js';
import { linkSnapshotDigest, type ObjectWrite, type LinkWrite } from './object-store.js';
import { commerceObservationSchema, commerceSourceReceiptSchema, commerceEvidenceScopes, parseCommerceEntity, type CommerceEntityType, type CommerceObservation } from './commerce-journey.js';
import { checkedCommerceObservation, sourcePayloadDigest, commerceObservationReadiness } from './commerce-journey-functions.js';

export interface CommerceSourceResult {
  payload: { type: CommerceEntityType; sourceId: string; sourceVersion: number; data: Record<string, unknown>; expiresAt: string };
  receipt: import('zod').z.infer<typeof commerceSourceReceiptSchema>;
}
export function projectCommerceObservation(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: CommerceSourceResult): ObjectRef {
  const { graph, owner, request, state } = ctx, receipt = commerceSourceReceiptSchema.parse(result.receipt), payload = result.payload;
  parseCommerceEntity(payload.type, payload.data);
  if (receipt.payloadDigest !== sourcePayloadDigest(payload) || receipt.ownerDigest !== digest(owner) || receipt.requestId !== request.id || receipt.requestRevision !== request.revision || receipt.action !== action || receipt.planId !== ctx.planId || receipt.intentId !== ctx.intentId || receipt.attemptId !== ctx.attemptId || receipt.modelRunId !== ctx.modelRunId || receipt.operationKey !== ctx.operationKey) throw new DomainError('CONFLICT', 'Commerce source receipt is not bound to this exact owned attempt');
  const dependencies = Object.entries(input).flatMap(([key, value]) => {
    const ref = objectRefSchema.safeParse(value); if (key === 'scope' || !ref.success) return [];
    const snapshot = checkedCommerceObservation(graph.read(owner, ref.data).properties.snapshot);
    if (snapshot.requestId !== request.id || snapshot.requestRevision !== request.revision || digest(snapshot.scope) !== digest(state.scope)) throw new DomainError('CONFLICT', 'Commerce dependency belongs to another task revision');
    const identityRead = ['ReadCommerceCart', 'ReadCommerceOrder', 'ReadCommercePayment', 'ReadCommerceDelivery'].includes(action);
    const historical = identityRead || ['UpdateCommerceCart', 'CancelCommerceCart'].includes(action) && key === 'cart' || action === 'PrepareCommerceCheckout' && key === 'cart' || action === 'SubmitCommerceOrder';
    return [{ ref: ref.data, contentDigest: snapshot.contentDigest, ...(historical ? { checkedAt: identityRead ? snapshot.observedAt : ctx.originalDispatchAt ?? receipt.startedAt } : {}) }];
  });
  const base = { ...payload, requestId: request.id, requestRevision: request.revision, configurationDigest: state.programDigest, scope: state.scope, action, actionInput: input, dependencies,
    ...(['CommerceOrderObservation', 'CommercePaymentObservation', 'CommerceDeliveryObservation'].includes(payload.type) && ctx.originalDispatchAt ? { dependencyCheckedAt: ctx.originalDispatchAt } : {}),
    observedAt: receipt.receivedAt, receipt, evidenceLevel: 'synthetic' as const, realOperationsAllowed: false as const };
  const snapshot = commerceObservationSchema.parse({ ...base, contentDigest: digest(base) });
  const objects: ObjectWrite[] = [], links: LinkWrite[] = [], removeLinks: LinkWrite[] = [];
  const root = { type: 'ServiceRequest', id: request.id }, immutable = { type: payload.type, id: digest({ scope: state.scope, receipt: receipt.id, type: payload.type }) };
  const sealed: { object: ObjectWrite; scope: string }[] = [];
  const add = (ref: ObjectRef, values: Record<string, unknown>, scope?: string, mutable = false) => {
    let revision: number | undefined;
    if (mutable) { try { revision = graph.read(owner, ref).revision; } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; } }
    const object: ObjectWrite = { ref, properties: { [graph.model.object(ref.type).primaryKey]: ref.id, displayTitle: `沙箱 ${ref.type}`, ...values }, ...(revision ? { expectedRevision: revision } : {}) };
    objects.push(object); if (scope) sealed.push({ object, scope }); return object;
  };
  const observation = (ref: ObjectRef, s: CommerceObservation) => {
    add(ref, { requestRevision: request.revision, data: s.data, snapshot: s }, commerceEvidenceScopes[ref.type]);
    links.push({ type: `${ref.type}CommerceRequest`, from: ref, to: root }, { type: `${ref.type}CommerceScope`, from: ref, to: state.scope }, ...s.dependencies.map(d => ({ type: 'CommerceFactDependency', from: ref, to: d.ref })));
  };
  observation(immutable, snapshot);
  const child = (type: CommerceEntityType, path: string[], data: Record<string, unknown>) => {
    parseCommerceEntity(type, data);
    const ref = { type, id: digest({ parent: immutable, type, path }) }, body = { ...base, type, sourceId: `${payload.sourceId}:${path.join('.')}`, data, dependencies: [{ ref: immutable, contentDigest: snapshot.contentDigest }], projectedFrom: { parent: immutable, path } };
    observation(ref, commerceObservationSchema.parse({ ...body, contentDigest: digest(body) }));
  };
  if (payload.type === 'Cart') parseCommerceEntity('Cart', payload.data).lines.forEach((line, i) => child('CartLine', ['lines', String(i)], line));
  if (payload.type === 'FulfillmentPlan') parseCommerceEntity('FulfillmentPlan', payload.data).options.forEach((option, i) => {
    option.groups.forEach((group, j) => child('FulfillmentGroup', ['options', String(i), 'groups', String(j)], group));
    option.promises.forEach((promise, j) => child('DeliveryPromise', ['options', String(i), 'promises', String(j)], promise));
  });
  if (payload.type === 'LandedCostQuote') {
    const quote = parseCommerceEntity('LandedCostQuote', payload.data);
    quote.groups.forEach((group, i) => child('FulfillmentGroup', ['groups', String(i)], group));
    quote.promises.forEach((promise, i) => child('DeliveryPromise', ['promises', String(i)], promise));
  }
  const canonical = (type: string, merchant: string, providerId: string) => ({ type, id: digest({ environment: 'commerce-sandbox', configuration: state.programDigest, merchant, providerId, type }) });
  if (payload.type === 'CommerceOrderObservation') {
    const order = parseCommerceEntity('CommerceOrderObservation', payload.data), ref = canonical('Order', order.merchantId, order.orderId);
    add(ref, { providerOrderReference: order.orderId, orderState: order.state, total: order.total, fulfillmentState: order.fulfillment, sourceStartedAt: receipt.startedAt }, 'order', true);
    links.push({ type: 'OrderRequest', from: ref, to: root });
    for (const line of order.lines) {
      const variant = canonical('ProductVariant', order.merchantId, line.variantId), lineRef = canonical('OrderLine', order.merchantId, `${order.orderId}:${line.variantId}`);
      // Product identities are stable; contract terms stay on the immutable
      // commerce observation and the fixed order line, not a mutable catalog.
      add(variant, { name: line.title, sourceProductRef: { namespace: `commerce-sandbox:${order.merchantId}`, id: line.variantId }, specification: [{ name: 'variant', value: line.variantId }], specificationRevision: '1' }, undefined, true);
      add(lineRef, { quantityOrdered: { amount: String(line.quantity), unit: 'piece' }, agreedSpecificationRef: '1', agreedPriceRef: order.quoteDigest }, undefined, true);
      links.push({ type: 'OrderLineOrder', from: lineRef, to: ref }, { type: 'OrderLineVariant', from: lineRef, to: variant });
    }
  }
  if (payload.type === 'CommercePaymentObservation') {
    const payment = parseCommerceEntity('CommercePaymentObservation', payload.data), ref = canonical('Payment', payment.merchantId, payment.paymentId), order = canonical('Order', payment.merchantId, payment.orderId);
    graph.read(owner, order);
    add(ref, { providerReference: payment.receiptId, purpose: 'goods', amount: payment.amount, paymentState: payment.state === 'settled' ? 'paid' : payment.state === 'failed' ? 'failed' : 'pending', observedAt: receipt.receivedAt }, 'payment', true);
    links.push({ type: 'PaymentOrder', from: ref, to: order });
  }
  if (payload.type === 'CommerceDeliveryObservation' && commerceObservationReadiness(graph, owner, snapshot).status !== 'unsatisfied') {
    const delivery = parseCommerceEntity('CommerceDeliveryObservation', payload.data), order = canonical('Order', delivery.merchantId, delivery.orderId);
    graph.read(owner, order);
    for (const groupId of new Set(delivery.events.map(e => e.groupId))) {
      const shipment = canonical('Shipment', delivery.merchantId, `${delivery.orderId}:${groupId}`);
      add(shipment, { providerReference: `${delivery.orderId}:${groupId}`, shipmentState: delivery.state }, 'delivery', true); links.push({ type: 'ShipmentOrder', from: shipment, to: order });
      for (const event of delivery.events.filter(e => e.groupId === groupId && e.milestone === 'delivered')) {
        const eventRef = canonical('DeliveryEvent', delivery.merchantId, event.id), allocation = canonical('DeliveryAllocation', delivery.merchantId, event.id), line = canonical('OrderLine', delivery.merchantId, `${delivery.orderId}:${event.variantId}`);
        graph.read(owner, line);
        add(eventRef, { occurredAt: event.occurredAt, observedAt: receipt.receivedAt, sourceVersion: payload.sourceVersion, eventKind: 'delivered', sourceEventKey: `${delivery.merchantId}:${event.id}` }, 'delivery', true);
        add(allocation, { deliveredQuantity: { amount: String(event.quantity), unit: 'piece' }, acceptedSpecificationRef: '1', verificationState: 'accepted', evidenceRef: receipt.id }, 'delivery', true);
        links.push({ type: 'EventShipment', from: eventRef, to: shipment }, { type: 'AllocationShipment', from: allocation, to: shipment }, { type: 'AllocationOrderLine', from: allocation, to: line }, { type: 'AllocationEvent', from: allocation, to: eventRef });
      }
    }
  }
  for (const { object, scope } of sealed) {
    const receiptRef = { type: 'SourceReceipt', id: digest({ object: object.ref, source: receipt.id }) };
    try { for (const old of graph.related(owner, object.ref, 'sourceReceipts', { remaining: 1000 }) ?? []) removeLinks.push({ type: `${object.ref.type}Evidence`, from: object.ref, to: old.ref }); }
    catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
    add(receiptRef, { sourceIdentity: receipt.sourceIdentity, sourceEventId: receipt.id, scope, observedAt: receipt.receivedAt, evidenceLevel: 'synthetic', contentDigest: receipt.responseSha256, subjects: [{ object: object.ref, digest: digest(object.properties), linksDigest: linkSnapshotDigest(object.ref, links) }], safeSummary: '隔离交易沙箱 HTTP 回执；不代表真实商家、税率、库存、交易或交付' });
    links.push({ type: `${object.ref.type}Evidence`, from: object.ref, to: receiptRef }, { type: 'ReceiptRequest', from: receiptRef, to: root });
  }
  graph.ingest(owner, { objects, links, removeLinks }, { kind: 'synthetic', id: receipt.sourceIdentity, observedAt: receipt.receivedAt });
  return immutable;
}
