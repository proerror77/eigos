import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { AgentActionContext } from '../core/agent-program.js';
import { objectRefSchema, type ObjectRef } from './model.js';
import { linkSnapshotDigest, type ObjectWrite, type LinkWrite } from './object-store.js';
import { commerceObservationSchema, commerceSourceReceiptSchema, commerceEvidenceScopes, parseCommerceEntity, type CommerceEntityType, type CommerceObservation } from './commerce-journey.js';
import { checkedCommerceObservation, sourcePayloadDigest, commerceObservationReadiness, readCommerceObservation } from './commerce-journey-functions.js';
import { commerceProductVariantValues, orderLineSourceAgreementSchema, shipmentExpectedAllocationSchema } from './product-attributes.js';

export interface CommerceSourceResult {
  payload: { type: CommerceEntityType; sourceId: string; sourceVersion: number; data: Record<string, unknown>; expiresAt: string };
  receipt: import('zod').z.infer<typeof commerceSourceReceiptSchema>;
}

/** Follow only the already sealed dependency chain, at the same historical
 * check times used by the source validator. Catalog refreshes are not inputs to
 * an original order agreement. */
function originalCommerceAgreement(graph: AgentActionContext['graph'], owner: string, root: ObjectRef, snapshot: CommerceObservation, variantId: string, quantity: number) {
  const fail = (reason: string): never => { throw new DomainError('CONFLICT', reason); };
  const records = new Map<string, { object: ObjectRef; snapshot: CommerceObservation; checkedAt: string }>(), memo = new Map<string, CommerceObservation>(), budget = { remaining: 5000 };
  const contractual = (type: string) => ['CommerceOrderObservation', 'CommercePaymentObservation', 'CommerceDeliveryObservation'].includes(type);
  const visit = (object: ObjectRef, value: CommerceObservation, at: number) => {
    const key = digest(object);
    if (records.has(key)) return;
    if (records.size >= 24) fail('Order agreement dependency bound exceeded');
    records.set(key, { object, snapshot: value, checkedAt: new Date(at).toISOString() });
    const parentAt = contractual(value.type) ? Date.parse(value.dependencyCheckedAt ?? value.receipt.startedAt) : at;
    for (const dependency of value.dependencies) {
      const child = checkedCommerceObservation(graph.read(owner, dependency.ref, budget).properties.snapshot);
      const checkedAt = dependency.checkedAt ? Date.parse(dependency.checkedAt) : contractual(value.type) && contractual(child.type) ? Date.parse(child.receipt.receivedAt) : parentAt;
      const verified = readCommerceObservation(graph, owner, dependency.ref, { at: checkedAt, budget, memo });
      if (verified.contentDigest !== dependency.contentDigest) fail('Order agreement dependency differs from its pinned source');
      visit(dependency.ref, verified, checkedAt);
    }
  };
  visit(root, snapshot, Date.parse(snapshot.observedAt));
  const submitted = [...records.values()].filter(value => value.snapshot.type === 'CommerceOrderObservation' && ['SubmitCommerceOrder', 'SubmitCommerceUnpaidOrder'].includes(value.snapshot.action));
  if (submitted.length !== 1) fail('A new order line needs one exact original source submission');
  const original = submitted[0]!, order = parseCommerceEntity('CommerceOrderObservation', original.snapshot.data);
  const findInput = (parent: typeof original, key: string, type: string) => {
    const ref = objectRefSchema.parse(parent.snapshot.actionInput[key]), found = records.get(digest(ref));
    if (ref.type !== type || !found || !parent.snapshot.dependencies.some(d => digest(d.ref) === digest(ref) && d.contentDigest === found.snapshot.contentDigest)) fail('Order agreement lacks its exact product, quote or checkout dependency');
    return found!;
  };
  const checkout = findInput(original, 'checkout', 'CommerceCheckout'), quote = findInput(checkout, 'quote', 'LandedCostQuote'), product = findInput(quote, 'product', 'CommerceProduct');
  const c = parseCommerceEntity('CommerceCheckout', checkout.snapshot.data), q = parseCommerceEntity('LandedCostQuote', quote.snapshot.data), p = parseCommerceEntity('CommerceProduct', product.snapshot.data);
  const line = order.lines.find(line => line.variantId === variantId);
  if (!line || line.quantity !== quantity || p.variantId !== variantId || q.variantId !== variantId || p.merchantId !== order.merchantId || q.merchantId !== order.merchantId || c.merchantId !== order.merchantId
    || order.checkoutId !== c.checkoutId || order.quoteId !== quote.snapshot.sourceId || order.quoteDigest !== quote.snapshot.contentDigest || c.quoteDigest !== quote.snapshot.contentDigest
    || c.quoteId !== quote.snapshot.sourceId || order.destinationDigest !== c.destinationDigest || c.destinationDigest !== q.destinationDigest
    || digest(order.total) !== digest(c.total) || digest(c.total) !== digest(q.buyerTotal) || digest(order.costComponents) !== digest(c.costComponents) || digest(c.costComponents) !== digest(q.components)
    || q.quantity !== quantity || digest(c.lines) !== digest(order.lines) || digest(q.unitPrice) !== digest(line.unitPrice)) fail('Order line differs from the original fixed source contract');
  if (new Set(q.groups.map(group => group.id)).size !== q.groups.length || q.groups.some(group => group.variantId !== variantId || group.destinationDigest !== q.destinationDigest)
    || q.groups.reduce((sum, group) => sum + group.quantity, 0) !== quantity) fail('Original fulfillment groups must uniquely allocate exactly the ordered source variant and quantity');
  const pin = (record: typeof original) => ({ object: record.object, contentDigest: record.snapshot.contentDigest, sourceId: record.snapshot.sourceId, sourceVersion: record.snapshot.sourceVersion, checkedAt: record.checkedAt });
  return { agreement: orderLineSourceAgreementSchema.parse({ schemaVersion: '1', basis: 'source_order_and_checkout', merchantId: order.merchantId, variantId,
    product: pin(product), quote: pin(quote), checkout: pin(checkout), order: pin(original) }), original: original.snapshot, groups: q.groups };
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
    const historical = identityRead || ['UpdateCommerceCart', 'CancelCommerceCart'].includes(action) && key === 'cart' || action === 'PrepareCommerceCheckout' && key === 'cart' || ['SubmitCommerceOrder', 'SubmitCommerceUnpaidOrder'].includes(action);
    return [{ ref: ref.data, contentDigest: snapshot.contentDigest, ...(historical ? { checkedAt: identityRead ? snapshot.observedAt : ctx.originalDispatchAt ?? receipt.startedAt } : {}) }];
  });
  const base = { ...payload, requestId: request.id, requestRevision: request.revision, configurationDigest: state.programDigest, scope: state.scope, action, actionInput: input, dependencies,
    ...(['CommerceOrderObservation', 'CommercePaymentObservation', 'CommerceDeliveryObservation'].includes(payload.type) && ctx.originalDispatchAt ? { dependencyCheckedAt: ctx.originalDispatchAt } : {}),
    observedAt: receipt.receivedAt, receipt, evidenceLevel: 'synthetic' as const, realOperationsAllowed: false as const };
  const snapshot = commerceObservationSchema.parse({ ...base, contentDigest: digest(base) });
  const objects: ObjectWrite[] = [], links: LinkWrite[] = [], removeLinks: LinkWrite[] = [];
  const root = { type: 'ServiceRequest', id: request.id }, immutable = { type: payload.type, id: digest({ scope: state.scope, receipt: receipt.id, type: payload.type }) };
  const sealed: { object: ObjectWrite; scope: string; summary?: string }[] = [];
  const agreements: { object: ObjectWrite; original: CommerceObservation }[] = [];
  const add = (ref: ObjectRef, values: Record<string, unknown>, scope?: string, mutable = false, summary?: string) => {
    let revision: number | undefined;
    if (mutable) { try { revision = graph.read(owner, ref).revision; } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; } }
    const object: ObjectWrite = { ref, properties: { [graph.model.object(ref.type).primaryKey]: ref.id, displayTitle: `沙箱 ${ref.type}`, ...values }, ...(revision ? { expectedRevision: revision } : {}) };
    objects.push(object); if (scope) sealed.push({ object, scope, summary }); return object;
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
  if (payload.type === 'CommerceProduct') {
    const product = parseCommerceEntity('CommerceProduct', payload.data), ref = canonical('ProductVariant', product.merchantId, product.variantId);
    const values = commerceProductVariantValues(product), properties = { variantId: ref.id, displayTitle: product.title, ...values, specificationRevision: digest(values) };
    let old;
    try { old = graph.read(owner, ref); } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
    const previous = old ? graph.related(owner, ref, 'currentCommerceProduct', { remaining: 1000 }) ?? [] : [];
    for (const record of previous) {
      const source = checkedCommerceObservation(record.properties.snapshot), prior = parseCommerceEntity('CommerceProduct', source.data);
      if (source.receipt.sourceIdentity !== receipt.sourceIdentity || prior.merchantId !== product.merchantId || prior.variantId !== product.variantId
        || Date.parse(source.observedAt) > Date.parse(receipt.receivedAt)
        || source.sourceId === payload.sourceId && (source.sourceVersion > payload.sourceVersion || source.sourceVersion === payload.sourceVersion && digest(prior) !== digest(product))) throw new DomainError('CONFLICT', 'Commerce product source identity or version regressed or conflicts');
      removeLinks.push({ type: 'ProductVariantCurrentCommerceProduct', from: ref, to: record.ref });
    }
    if (!old || digest(old.properties) !== digest(properties)) objects.push({ ref, properties, ...(old ? { expectedRevision: old.revision } : {}) });
    links.push({ type: 'CommerceProductVariant', from: immutable, to: ref }, { type: 'ProductVariantCurrentCommerceProduct', from: ref, to: immutable });
  }
  if (payload.type === 'CommerceOrderObservation') {
    const order = parseCommerceEntity('CommerceOrderObservation', payload.data), ref = canonical('Order', order.merchantId, order.orderId);
    add(ref, { providerOrderReference: order.orderId, orderState: order.state, total: order.total, fulfillmentState: order.fulfillment, sourceStartedAt: receipt.startedAt }, 'order', true);
    links.push({ type: 'OrderRequest', from: ref, to: root });
    for (const line of order.lines) {
      const variant = canonical('ProductVariant', order.merchantId, line.variantId), lineRef = canonical('OrderLine', order.merchantId, `${order.orderId}:${line.variantId}`);
      // Neither a later independent read nor a changed catalog can backfill or
      // rewrite a previously fixed line, including legacy lines without a seal.
      try { graph.read(owner, lineRef); continue; } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
      // Product identities are stable; contract terms stay on the immutable
      // commerce observation and the fixed order line, not a mutable catalog.
      try { graph.read(owner, variant); } catch (e) {
        if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e;
        add(variant, { name: line.title, sourceProductRef: { namespace: `commerce-sandbox:${order.merchantId}`, id: line.variantId }, specification: [{ name: 'variant', value: line.variantId }], specificationRevision: '1' });
      }
      const { agreement, original, groups } = originalCommerceAgreement(graph, owner, immutable, snapshot, line.variantId, line.quantity);
      const record = add(lineRef, { quantityOrdered: { amount: String(line.quantity), unit: 'piece' }, agreedSpecificationRef: digest(agreement), agreedPriceRef: agreement.quote.contentDigest, sourceAgreement: agreement });
      agreements.push({ object: record, original });
      links.push({ type: 'OrderLineOrder', from: lineRef, to: ref }, { type: 'OrderLineVariant', from: lineRef, to: variant },
        { type: 'OrderLineAgreedCommerceProduct', from: lineRef, to: agreement.product.object }, { type: 'OrderLineAgreedLandedCostQuote', from: lineRef, to: agreement.quote.object },
        { type: 'OrderLineAgreedCommerceCheckout', from: lineRef, to: agreement.checkout.object }, { type: 'OrderLineAgreedCommerceOrder', from: lineRef, to: agreement.order.object });
      for (const group of groups) {
        const shipment = canonical('Shipment', order.merchantId, `${order.orderId}:${group.id}`);
        const expectedAllocation = shipmentExpectedAllocationSchema.parse({ schemaVersion: '1', basis: 'source_quoted_fulfillment_group', orderLine: lineRef,
          quantity: { amount: String(group.quantity), unit: 'piece' }, agreedSpecificationRef: digest(agreement), sourceQuote: agreement.quote.object,
          sourceQuoteDigest: agreement.quote.contentDigest, sourceGroupId: group.id, destinationDigest: group.destinationDigest });
        // A legacy batch without an original plan is not retroactively assigned
        // one. Existing planned batches are already bound to their first terms.
        try {
          const old = graph.read(owner, shipment);
          if (old.properties.expectedAllocation && digest(old.properties.expectedAllocation) !== digest(expectedAllocation)) throw new DomainError('CONFLICT', 'A planned package cannot be assigned to another original agreement');
          continue;
        } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
        add(shipment, { displayTitle: `沙箱计划分包：${group.id}（尚无发货证据）`, shipmentState: 'pending', expectedAllocation }, 'delivery', false, '原始沙箱报价的计划分包与预期数量；不证明已发货或已收到');
        links.push({ type: 'ShipmentOrder', from: shipment, to: ref }, { type: 'ShipmentExpectedOrderLine', from: shipment, to: lineRef }, { type: 'ShipmentExpectedSourceQuote', from: shipment, to: agreement.quote.object });
      }
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
      let previous;
      try { previous = graph.read(owner, shipment); } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
      const expected = previous?.properties.expectedAllocation ? shipmentExpectedAllocationSchema.parse(previous.properties.expectedAllocation) : undefined;
      const received = delivery.events.filter(event => event.groupId === groupId && event.milestone === 'delivered').reduce((sum, event) => sum + event.quantity, 0);
      if (expected && (expected.sourceGroupId !== groupId || expected.destinationDigest !== delivery.destinationDigest || received > Number(expected.quantity.amount))) throw new DomainError('CONFLICT', 'Delivery group exceeds or differs from its original expected allocation');
      add(shipment, { displayTitle: `沙箱来源交付批次：${groupId}`, ...(previous?.properties.providerReference ? { providerReference: previous.properties.providerReference } : {}),
        shipmentState: expected ? received === Number(expected.quantity.amount) ? 'delivered' : received > 0 ? 'partial' : 'pending' : delivery.state,
        ...(expected ? { expectedAllocation: expected } : {}) }, 'delivery', true);
      links.push({ type: 'ShipmentOrder', from: shipment, to: order });
      if (expected) links.push({ type: 'ShipmentExpectedOrderLine', from: shipment, to: expected.orderLine }, { type: 'ShipmentExpectedSourceQuote', from: shipment, to: expected.sourceQuote });
      for (const event of delivery.events.filter(e => e.groupId === groupId && e.milestone === 'delivered')) {
        const eventRef = canonical('DeliveryEvent', delivery.merchantId, event.id), allocation = canonical('DeliveryAllocation', delivery.merchantId, event.id), line = canonical('OrderLine', delivery.merchantId, `${delivery.orderId}:${event.variantId}`);
        const agreedLine = graph.read(owner, line);
        add(eventRef, { occurredAt: event.occurredAt, observedAt: receipt.receivedAt, sourceVersion: payload.sourceVersion, eventKind: 'delivered', sourceEventKey: `${delivery.merchantId}:${event.id}` }, 'delivery', true);
        add(allocation, { deliveredQuantity: { amount: String(event.quantity), unit: 'piece' }, acceptedSpecificationRef: agreedLine.properties.agreedSpecificationRef, verificationState: 'accepted', evidenceRef: receipt.id,
          verificationBasis: { kind: 'source_reported_variant_identity', reportedVariantId: event.variantId, sourceObservation: immutable, physicalAttributes: 'unknown' } }, 'delivery', true);
        links.push({ type: 'EventShipment', from: eventRef, to: shipment }, { type: 'AllocationShipment', from: allocation, to: shipment }, { type: 'AllocationOrderLine', from: allocation, to: line }, { type: 'AllocationEvent', from: allocation, to: eventRef });
      }
    }
  }
  for (const { object, original } of agreements) {
    const receiptRef = { type: 'SourceReceipt', id: digest({ namespace: 'commerce-line-agreement', line: object.ref, sourceEvent: original.receipt.id }) };
    add(receiptRef, { sourceIdentity: original.receipt.sourceIdentity, sourceEventId: original.receipt.id, scope: 'order', observedAt: original.receipt.receivedAt, evidenceLevel: 'synthetic', contentDigest: original.receipt.responseSha256,
      subjects: [{ object: object.ref, digest: digest(object.properties), linksDigest: linkSnapshotDigest(object.ref, links) }], safeSummary: '原始沙箱下单所固定的商品观察、完整报价与结账条款；不证明实物属性已检验' });
    links.push({ type: 'OrderLineAgreementReceipt', from: object.ref, to: receiptRef });
  }
  for (const { object, scope, summary } of sealed) {
    const receiptRef = { type: 'SourceReceipt', id: digest({ object: object.ref, source: receipt.id }) };
    try { for (const old of graph.related(owner, object.ref, 'sourceReceipts', { remaining: 1000 }) ?? []) removeLinks.push({ type: `${object.ref.type}Evidence`, from: object.ref, to: old.ref }); }
    catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
    add(receiptRef, { sourceIdentity: receipt.sourceIdentity, sourceEventId: receipt.id, scope, observedAt: receipt.receivedAt, evidenceLevel: 'synthetic', contentDigest: receipt.responseSha256, subjects: [{ object: object.ref, digest: digest(object.properties), linksDigest: linkSnapshotDigest(object.ref, links) }], safeSummary: summary ?? '隔离交易沙箱 HTTP 回执；不代表真实商家、税率、库存、交易或交付' });
    links.push({ type: `${object.ref.type}Evidence`, from: object.ref, to: receiptRef }, { type: 'ReceiptRequest', from: receiptRef, to: root });
  }
  graph.ingest(owner, { objects, links, removeLinks }, { kind: 'synthetic', id: receipt.sourceIdentity, observedAt: receipt.receivedAt });
  return immutable;
}
