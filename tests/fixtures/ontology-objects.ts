// Synthetic business data only. No model, real provider, credential lookup or transaction.
import { businessModel } from '../../packages/ontology/business-model.js';
import { digest } from '../../packages/core/delegation.js';
import { linkSnapshotDigest, type ObjectBatch, type ObjectSource, type ObjectWrite } from '../../packages/ontology/object-store.js';
import type { ObjectRef } from '../../packages/ontology/model.js';

export function syntheticOntology(now = Date.now()) {
  const time = new Date(now - 1000).toISOString(), expiry = new Date(now + 300000).toISOString();
  const startsAt = new Date(now + 86400000).toISOString();
  const objects: ObjectWrite[] = [], links: NonNullable<ObjectBatch['links']> = [], ids: Record<string, ObjectRef> = {};
  const add = (type: string, id: string, properties: Record<string, unknown> = {}) => {
    const def = businessModel.object(type), ref = { type, id };
    objects.push({ ref, properties: { [def.primaryKey]: id, displayTitle: `合成 ${id}`, ...properties } }); ids[id] = ref; return ref;
  };
  const edge = (type: string, from: string, to: string) => links.push({ type, from: ids[from]!, to: ids[to]! });
  const evidence = (subject: string, scope: string) => {
    const object = objects.find(o => o.ref.id === subject)!; const ref = add('SourceReceipt', 'receipt-' + subject, { sourceIdentity: 'synthetic-source', sourceEventId: 'event-' + subject, scope, observedAt: time, evidenceLevel: 'synthetic', contentDigest: digest(object.properties), subjects: [{ object: object.ref, digest: digest(object.properties) }], safeSummary: `合成 ${scope} 回执`, privatePayload: 'PRIVATE_RECEIPT_MARKER' });
    links.push({ type: `${object.ref.type}Evidence`, from: object.ref, to: ref });
  };
  for (const [id, outcome, goal] of [['D', 'delivery_quote', '查1公斤文件普通送估价'], ['G', 'goods_delivery', '20杯咖啡送达，预算500元'], ['R', 'reservation_confirmed', '指定时段4人预订确认']]) add('ServiceRequest', id!, { originalGoal: goal, revision: 1, requestedOutcome: outcome, progress: 'executing', createdAt: time });
  add('Provider', 'provider', { name: '合成服务主体', verifiedIdentityRefs: ['synthetic:provider'] });
  add('Channel', 'channel', { name: '合成渠道', accessScope: ['synthetic-only'], supportedOperationRefs: ['synthetic-read'] });
  add('ChannelParticipation', 'participation', { role: 'fulfiller', validFrom: time, validUntil: expiry, verificationRef: 'synthetic-role-proof' });
  edge('ParticipationProvider', 'participation', 'provider'); edge('ParticipationChannel', 'participation', 'channel');
  add('ServiceEngagement', 'engagement', { progress: 'returned', startedAt: time }); edge('EngagementRequest', 'engagement', 'D'); edge('EngagementProvider', 'engagement', 'provider');
  const origin = { text: '合成寄件地址 A', city: '北京市', sourceRevision: '1' }, destination = { text: '合成收件地址 B', city: '北京市', sourceRevision: '1' };
  add('Place', 'place', { name: '合成公开地点', address: origin, coordinates: { lat: 39.9, lng: 116.4 }, coordinateUnit: 'degree', coordinateSystem: 'unknown' }); evidence('place', 'public_locations');
  add('SavedAddress', 'address-A', { label: 'A', address: origin, contactInstructions: 'PRIVATE_CONTACT_MARKER', sourceReference: 'PRIVATE_ADDRESS_ID_A' });
  add('SavedAddress', 'address-B', { label: 'B', address: destination, contactInstructions: 'PRIVATE_CONTACT_MARKER_B', sourceReference: 'PRIVATE_ADDRESS_ID_B' });
  add('Parcel', 'parcel', { contentsCategory: '文件', declaredWeight: { amount: '1', unit: 'kg' }, declaredContents: '合成文件' }); edge('ParcelRequest', 'parcel', 'D');
  add('DeliveryRoute', 'route', { originSnapshot: origin, destinationSnapshot: destination, selectedAt: time });
  edge('RouteRequest', 'route', 'D'); edge('SelectedRoute', 'D', 'route'); edge('RouteOrigin', 'route', 'address-A'); edge('RouteDestination', 'route', 'address-B');
  const common = { observedAt: time, expiresAt: expiry, validityBasis: 'provider_expiry', priceKind: 'firm_quote', pricingCompleteness: 'complete' };
  const pricing = (minor: string) => ({ total: { minor, currency: 'CNY' }, scope: 'all_mandatory_fees', components: [] });
  add('DeliveryQuote', 'quote-D', { ...common, priceKind: 'estimate', validityBasis: 'local_refresh_limit', serviceLevel: 'ordinary', quotedWeight: { amount: '1000', unit: 'g' }, pricingTerms: pricing('1680'), requestRevision: 1, parcelRevision: 1, routeRevision: 1 });
  edge('QuoteParcel', 'quote-D', 'parcel'); edge('QuoteRoute', 'quote-D', 'route'); evidence('quote-D', 'delivery_quote');
  add('ProductVariant', 'variant', { name: '合成350毫升拿铁', sourceProductRef: { namespace: 'synthetic', id: 'latte-350' }, specification: [{ name: 'volumeMl', value: '350' }, { name: 'milk', value: 'standard' }], specificationRevision: 'spec-1' });
  add('ProductOffer', 'offer-G', { ...common, variantRevision: 1, offeredQuantity: { amount: '20', unit: 'cup' }, pricingTerms: pricing('48000'), capacity: 'confirmed', capacityObservationRef: 'synthetic-capacity', deliveryDestination: destination, deliveryCommitment: startsAt });
  edge('ProductOfferVariant', 'offer-G', 'variant'); evidence('offer-G', 'goods_offer');
  add('Order', 'order', { providerOrderReference: 'synthetic-order', orderState: 'confirmed', createdAt: time }); edge('OrderRequest', 'order', 'G'); evidence('order', 'order');
  add('OrderLine', 'line', { quantityOrdered: { amount: '20', unit: 'cup' }, agreedSpecificationRef: 'spec-1', agreedPriceRef: 'offer-G' }); edge('OrderLineOrder', 'line', 'order'); edge('OrderLineVariant', 'line', 'variant');
  add('Shipment', 'shipment', { providerReference: 'synthetic-shipment', shipmentState: 'partial' }); edge('ShipmentOrder', 'shipment', 'order'); evidence('shipment', 'delivery');
  add('DeliveryEvent', 'delivery-event', { occurredAt: time, observedAt: time, sourceVersion: 1, eventKind: 'partial', sourceEventKey: 'synthetic:delivery-event-1' }); edge('EventShipment', 'delivery-event', 'shipment'); evidence('delivery-event', 'delivery');
  add('DeliveryAllocation', 'allocation', { deliveredQuantity: { amount: '18', unit: 'cup' }, acceptedSpecificationRef: 'spec-1', verificationState: 'accepted', evidenceRef: 'receipt-delivery-event' });
  edge('AllocationShipment', 'allocation', 'shipment'); edge('AllocationOrderLine', 'allocation', 'line'); edge('AllocationEvent', 'allocation', 'delivery-event');
  evidence('allocation', 'delivery');
  add('Venue', 'venue', { name: '合成餐厅 V', address: destination, timeZone: 'Asia/Shanghai' }); edge('VenueProvider', 'venue', 'provider');
  add('ReservationSlot', 'slot', { startsAt, timeZone: 'Asia/Shanghai', partySizeEligibility: 4, availabilityObservedAt: time, expiresAt: expiry }); edge('SlotVenue', 'slot', 'venue'); evidence('slot', 'reservation');
  add('ReservationOffer', 'offer-R', { ...common, depositTerms: { required: true, amount: { minor: '5000', currency: 'CNY' } }, cancellationTerms: '合成可取消条款', holdTerms: '合成占位五分钟' }); edge('ReservationOfferSlot', 'offer-R', 'slot'); evidence('offer-R', 'reservation');
  add('Reservation', 'reservation', { providerReference: 'synthetic-reservation', reservationState: 'confirmed', partySize: 4, confirmedSlotRevision: 1, confirmedAt: time, depositRequired: true, requiredDeposit: { minor: '5000', currency: 'CNY' }, holdExpiresAt: expiry }); edge('ReservationSlot', 'reservation', 'slot'); edge('ReservationRequest', 'reservation', 'R'); evidence('reservation', 'reservation');
  add('Payment', 'payment', { providerReference: 'synthetic-payment', purpose: 'deposit', amount: { minor: '5000', currency: 'CNY' }, paymentState: 'paid', observedAt: time }); edge('PaymentReservation', 'payment', 'reservation'); evidence('payment', 'payment');
  add('AfterSalesCase', 'case', { requestedRemedy: 'refund', progress: 'processing', originalBusinessReference: 'synthetic-reservation' }); edge('CaseReservation', 'case', 'reservation');
  add('Refund', 'refund', { providerReference: 'synthetic-refund', amount: { minor: '5000', currency: 'CNY' }, refundState: 'pending', observedAt: time }); edge('RefundPayment', 'refund', 'payment'); edge('RefundCase', 'refund', 'case'); evidence('refund', 'refund');
  for (const [offer, request] of [['quote-D', 'D'], ['offer-G', 'G'], ['offer-R', 'R']]) { edge('OfferRequest', offer!, request!); edge('OfferProvider', offer!, 'provider'); edge('OfferChannel', offer!, 'channel'); }
  add('Proposal', 'proposal', { requestRevision: 1, selectedAt: time, termsVersion: '1', decisionReason: '合成只读选择' }); edge('ProposalRequest', 'proposal', 'D'); edge('ProposalOffer', 'proposal', 'quote-D'); edge('SelectedProposal', 'D', 'proposal');
  add('Authorization', 'authorization', { actor: 'synthetic-user', allowedActions: ['synthetic-read'], dataScope: ['synthetic-only'], limits: { minor: '0', currency: 'CNY' }, expiresAt: expiry, revoked: false }); edge('AuthorizationProposal', 'authorization', 'proposal');
  add('OutcomeAssessment', 'assessment', { requestRevision: 1, judgment: 'satisfied', assessedAt: time, criterionResults: [{ criterion: 'parcel.quote_matches_request', result: 'pass', evidenceIds: ['receipt-quote-D'] }] }); edge('AssessmentRequest', 'assessment', 'D');
  const condition = (id: string, type: string, role: string, phase: string, operator: string, expected: unknown) => ({ id, predicateRef: { id, version: '1' }, subject: { type, role }, phase, strength: 'hard', operator, expected, source: { messageId: 'synthetic-user-message', quote: '合成场景中明确提出的条件' } });
  objects.find(o => o.ref.id === 'D')!.properties.conditions = [condition('parcel.quote_matches_request', 'DeliveryQuote', 'parcel_quote', 'result', 'eq', { weight: { amount: '1', unit: 'kg' }, serviceLevel: 'ordinary', parcel: ids.parcel, route: ids.route })];
  objects.find(o => o.ref.id === 'G')!.properties.conditions = [
    condition('goods.variant_matches', 'ProductOffer', 'product_variant', 'precondition', 'eq', ids.variant),
    condition('goods.capacity_covers_quantity', 'ProductOffer', 'capacity', 'precondition', 'gte', { amount: '20', unit: 'cup' }),
    condition('offer.total_within_budget', 'ProductOffer', 'total_price', 'precondition', 'lte', { amount: { minor: '50000', currency: 'CNY' }, priceBasis: 'firm_quote', scope: 'all_mandatory_fees' }),
  ];
  objects.find(o => o.ref.id === 'R')!.properties.conditions = [condition('reservation.slot_matches_request', 'ReservationSlot', 'reservation_slot', 'precondition', 'eq', { venue: ids.venue, startsAt, timeZone: 'Asia/Shanghai', partySize: 4 }), condition('reservation.confirmation_effective', 'Reservation', 'confirmation', 'result', 'eq', 'confirmed')];
  for (const receipt of objects.filter(o => o.ref.type === 'SourceReceipt')) for (const subject of receipt.properties.subjects as { object: ObjectRef; linksDigest?: string }[]) subject.linksDigest = linkSnapshotDigest(subject.object, links);
  const source: ObjectSource = { kind: 'synthetic', id: 'n1-three-scenarios', observedAt: time };
  return { batch: { objects, links }, source, ids, now, startsAt };
}
