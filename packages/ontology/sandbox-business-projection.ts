import { sandboxOrderSchema, sandboxQuoteSchema } from '../capabilities/sandbox-service.js';
import { digest } from '../core/delegation.js';
import { DomainError, type Job } from '../core/domain.js';
import type { ActionIntent, AfterSalesCase } from './actions.js';
import type { ExecutionObservation } from './execution-projection.js';
import type { ExecutionPlan, ProviderBinding } from './execution.js';
import type { ObjectRef } from './model.js';
import { businessRef as node, businessEdge as edge, optionalObject, businessRelated as related } from './business-chain-write.js';
import { linkSnapshotDigest, type LinkWrite, type ObjectWrite, type OntologyObjectStore } from './object-store.js';

const quantity = (amount: number, unit: string) => ({ amount: String(amount), unit: unit === '杯' ? 'cup' : 'piece' });
type SandboxSource = ExecutionPlan | ProviderBinding;
const realm = (plan: SandboxSource, binding: ActionIntent['bindingRef']) => {
  if (!('bindingDigests' in plan)) return { binding: plan.ref, definition: digest(plan) };
  const pinned = plan.bindingDigests.find(value => digest(value.ref) === digest(binding));
  if (!pinned) throw new DomainError('CONFLICT', 'Sandbox mapping requires its fixed source binding');
  return { binding, definition: pinned.digest };
};
export function sandboxOrderRef(plan: SandboxSource, binding: ActionIntent['bindingRef'], id: string) {
  return node('Order', { source: realm(plan, binding), orderId: id });
}
export function sandboxPartyRefs(plan: SandboxSource, binding: ActionIntent['bindingRef'], providerId: string, channelId: string) {
  return { provider: node('Provider', { source: realm(plan, binding), provider: providerId }),
    channel: node('Channel', { source: realm(plan, binding), channel: channelId }) };
}
interface Normalized { subjects: ObjectRef[]; receipts: ObjectRef[]; deliveredQuantity?: { amount: string; unit: string } }

/** A single accepted simulator observation. All native identifiers stay scoped
 * to the pinned source; cumulative delivery is one allocation, never summed twice. */
export function projectSandboxBusiness(graph: OntologyObjectStore, owner: string, job: Job, intent: ActionIntent, observation: ExecutionObservation, cases: AfterSalesCase[]): Normalized | undefined {
  const plans = [...(job.delegation?.planHistory ?? []), ...(job.delegation?.plan ? [job.delegation.plan] : [])];
  const fixed = plans.find(value => value.digest === intent.planDigest);
  const atomic = [job.delegation?.agent, ...(job.delegation?.agentHistory ?? [])].flatMap(state => state?.plans ?? []).find(plan => plan.digest === intent.planDigest)?.steps.find(step => step.intentId === intent.id)?.binding?.providerSnapshot;
  const plan = fixed?.capabilityRef.id === 'service.fulfillment.sandbox' ? fixed : atomic?.capabilityRef.id === 'service.fulfillment.sandbox.atomic' ? atomic : undefined;
  if (!plan || job.delegation?.request.executionEnvironment !== 'sandbox') return;
  const parsed = sandboxOrderSchema.safeParse(observation.result.output?.record);
  if (!parsed.success) return;
  const record = parsed.data;
  if (!['杯', '份'].includes(record.unit) || record.id !== observation.result.remoteRef) throw new DomainError('CONFLICT', 'Invalid sandbox business observation');
  const receiptFor = (scope: string) => node('SourceReceipt', { requestId: job.id, observationId: observation.id, scope });
  const oldReceipts = ['order', 'payment', 'delivery', 'refund'].flatMap(scope => { const value = optionalObject(graph, owner, receiptFor(scope)); return value ? [value] : []; });
  if (oldReceipts.length) return { subjects: oldReceipts.flatMap(receipt => (receipt.properties.subjects as { object: ObjectRef }[]).map(value => value.object)).filter(ref => optionalObject(graph, owner, ref)), receipts: oldReceipts.map(value => value.ref), deliveredQuantity: quantity(record.deliveredQuantity, record.unit) };
  const scopeFor: Record<string, string> = { Order: 'order', Payment: 'payment', Shipment: 'delivery', DeliveryEvent: 'delivery', DeliveryAllocation: 'delivery', Refund: 'refund' };
  const receipts = new Map<string, ObjectRef>();
  const originalCase = cases.find(item => item.remedyJobId === job.id);
  // Remediation uses the very same original source and order identity.
  const originalRequest = { type: 'ServiceRequest', id: originalCase?.originalJobId ?? job.id };
  const existingOrders = originalCase ? related(graph, owner, originalRequest, 'orders').filter(value => value.properties.providerOrderReference === record.id) : [];
  const order = originalCase ? existingOrders[0]?.ref : sandboxOrderRef(plan, intent.bindingRef, record.id);
  if (!order || existingOrders.length > 1) throw new DomainError('CONFLICT', 'Original sandbox order cannot be resolved');
  const line = node('OrderLine', order), shipment = node('Shipment', order), payment = node('Payment', order);
  const objects: ObjectWrite[] = [], links: LinkWrite[] = [], subjects: ObjectRef[] = [];
  const add = (ref: ObjectRef, values: Record<string, unknown>, evidenced = true) => {
    const previous = optionalObject(graph, owner, ref);
    objects.push({ ref, properties: { [graph.model.object(ref.type).primaryKey]: ref.id, displayTitle: `Sandbox ${ref.type}`, ...values }, ...(previous ? { expectedRevision: previous.revision } : {}) });
    if (evidenced) { const scope = scopeFor[ref.type]!; const receipt = receiptFor(scope); receipts.set(scope, receipt); subjects.push(ref); links.push(edge(`${ref.type}Evidence`, ref, receipt)); }
  };
  const priorOrder = optionalObject(graph, owner, order);
  add(order, { providerOrderReference: record.id, orderState: record.orderState, total: { minor: record.totalMinor, currency: record.currency }, fulfillmentState: record.fulfillmentState,
    createdAt: priorOrder?.properties.createdAt ?? observation.receivedAt });
  add(line, { quantityOrdered: quantity(record.quantity, record.unit), agreedPriceRef: record.quoteId }, false);
  links.push(edge('OrderRequest', order, originalRequest), edge('OrderLineOrder', line, order));
  add(shipment, { shipmentState: record.fulfillmentState });
  links.push(edge('ShipmentOrder', shipment, order));
  add(payment, { amount: { minor: record.paidMinor, currency: record.currency }, paymentState: record.paymentState, observedAt: observation.receivedAt });
  links.push(edge('PaymentOrder', payment, order));
  if (record.deliveredAt) {
    const event = node('DeliveryEvent', { order, cumulative: true }), allocation = node('DeliveryAllocation', { order, cumulative: true });
    const retracted = !['partial', 'delivered'].includes(record.fulfillmentState);
    add(event, { occurredAt: record.deliveredAt, observedAt: observation.receivedAt, sourceVersion: record.version,
      eventKind: retracted ? 'retracted' : record.deliveredQuantity < record.quantity ? 'partial' : 'delivered', sourceEventKey: `${order.id}:cumulative-delivery` });
    add(allocation, { deliveredQuantity: quantity(record.deliveredQuantity, record.unit), verificationState: retracted ? 'revoked' : 'accepted', evidenceRef: receiptFor('delivery').id });
    links.push(edge('EventShipment', event, shipment), edge('AllocationShipment', allocation, shipment), edge('AllocationOrderLine', allocation, line), edge('AllocationEvent', allocation, event));
  }
  const refundCase = originalCase ?? cases.find(item => item.originalJobId === job.id && item.action === 'refund' && item.remoteRef === record.id);
  if (refundCase && record.refundState !== 'not_started') {
    const refund = node('Refund', { payment, caseId: refundCase.id });
    add(refund, { amount: { minor: record.refundedMinor, currency: record.currency }, refundState: record.refundState, observedAt: observation.receivedAt });
    links.push(edge('RefundPayment', refund, payment), edge('RefundCase', refund, { type: 'AfterSalesCase', id: refundCase.id }));
  }
  for (const [scope, receipt] of receipts) {
    const evidenceSubjects = subjects.filter(ref => scopeFor[ref.type] === scope).map(ref => ({ object: ref, digest: digest(objects.find(value => digest(value.ref) === digest(ref))!.properties), linksDigest: linkSnapshotDigest(ref, links) }));
    add(receipt, { sourceIdentity: `sandbox:${digest(realm(plan, intent.bindingRef))}`, sourceEventId: `${record.id}:${record.version}`, scope,
      observedAt: observation.receivedAt, evidenceLevel: 'synthetic', contentDigest: digest(observation.result),
      subjects: evidenceSubjects, safeSummary: `Verified sandbox ${scope} observation; no real money or fulfillment` }, false);
    links.push(edge('ReceiptRequest', receipt, { type: 'ServiceRequest', id: job.id }));
  }
  // Across independent operation keys an older order snapshot must not regress
  // newer payment/refund truth. Keep the receipt as historical evidence only.
  const previousReceipts = priorOrder ? related(graph, owner, order, 'sourceReceipts') : [];
  const newer = previousReceipts.some(value => Number(String(value.properties.sourceEventId).split(':').at(-1)) > record.version);
  const removeLinks = newer ? [] : subjects.flatMap(ref => relatedIfPresent(graph, owner, ref).map(value => edge(`${ref.type}Evidence`, ref, value.ref)));
  graph.ingest(owner, {
    objects: newer ? objects.filter(value => value.ref.type === 'SourceReceipt') : objects,
    links: newer ? links.filter(value => value.from.type === 'SourceReceipt') : links,
    removeLinks,
  }, { kind: 'synthetic', id: observation.id, observedAt: observation.receivedAt });
  return { subjects: subjects.filter(ref => optionalObject(graph, owner, ref)), receipts: [...receipts.values()], deliveredQuantity: quantity(record.deliveredQuantity, record.unit) };
}
function relatedIfPresent(graph: OntologyObjectStore, owner: string, ref: ObjectRef) {
  return optionalObject(graph, owner, ref) ? related(graph, owner, ref, 'sourceReceipts') : [];
}

export function projectSandboxOffer(graph: OntologyObjectStore, owner: string, job: Job, plan: ExecutionPlan, proposal: ObjectRef): ObjectRef | undefined {
  if (plan.capabilityRef.id !== 'service.fulfillment.sandbox' || job.delegation?.request.executionEnvironment !== 'sandbox') return;
  const parsed = sandboxQuoteSchema.safeParse(plan.details.quote); if (!parsed.success) return;
  const quote = parsed.data, candidate = job.delegation.resolution?.candidates.find(value => value.id === plan.candidateId);
  const offer = node('FulfillmentOffer', { requestId: job.id, source: realm(plan, plan.bindingRef), quoteId: quote.id });
  if (optionalObject(graph, owner, offer)) {
    graph.ingest(owner, { objects: [], links: [edge('ProposalOffer', proposal, offer)] }, { kind: 'task', id: job.id, observedAt: job.updatedAt }); return offer;
  }
  if (!candidate || !['杯', '份'].includes(quote.unit)) return;
  const receipt = node('SourceReceipt', { offer, quote });
  const { provider, channel } = sandboxPartyRefs(plan, plan.bindingRef, candidate.binding.providerId, candidate.binding.channelId);
  const links = [edge('OfferRequest', offer, { type: 'ServiceRequest', id: job.id }), edge('OfferProvider', offer, provider), edge('OfferChannel', offer, channel),
    edge('FulfillmentOfferEvidence', offer, receipt), edge('ProposalOffer', proposal, offer), edge('ReceiptRequest', receipt, { type: 'ServiceRequest', id: job.id })];
  const properties = { offerId: offer.id, displayTitle: 'Sandbox fulfillment offer', observedAt: candidate.observedAt, expiresAt: quote.expiresAt,
    validityBasis: 'provider_expiry', priceKind: 'firm_quote', pricingCompleteness: 'complete', requestedQuantity: quantity(quote.quantity, quote.unit), capacity: quantity(quote.capacity, quote.unit),
    pricingTerms: { total: { minor: quote.totalMinor, currency: quote.currency }, scope: 'all_mandatory_fees', components: [] }, deliveryCommitment: quote.deliveryBy, sourceQuoteReference: quote.id, environment: 'sandbox' };
  const values = [{ ref: provider, properties: { providerId: provider.id, displayTitle: 'Sandbox provider', name: candidate.binding.providerId } },
    { ref: channel, properties: { channelId: channel.id, displayTitle: 'Sandbox channel', name: candidate.binding.channelId } },
    { ref: offer, properties }, { ref: receipt, properties: { receiptId: receipt.id, displayTitle: 'Sandbox offer receipt', sourceIdentity: `sandbox:${digest(realm(plan, plan.bindingRef))}`,
      sourceEventId: quote.id, scope: 'goods_offer', observedAt: candidate.observedAt, evidenceLevel: 'synthetic', contentDigest: digest(quote),
      subjects: [{ object: offer, digest: digest(properties), linksDigest: linkSnapshotDigest(offer, links) }], safeSummary: 'Explicit simulator quote; no real merchant supply' } }];
  graph.ingest(owner, { objects: values.map(value => ({ ...value, ...(optionalObject(graph, owner, value.ref) ? { expectedRevision: graph.read(owner, value.ref).revision } : {}) })), links },
    { kind: 'synthetic', id: receipt.id, observedAt: candidate.observedAt });
  return offer;
}
