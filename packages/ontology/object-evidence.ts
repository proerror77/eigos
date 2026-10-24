import { digest } from '../core/delegation.js';
import { domainEvidenceScopes } from './service-domains.js';
import { commerceEvidenceScopes } from './commerce-journey.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';
import {withIntegrity} from '../security/context.js';

export function sourceProof(store: OntologyObjectStore, owner: string, ref: ObjectRef, budget: ReadBudget) {
  return withIntegrity(()=>sourceProofInternal(store,owner,ref,budget));
}
function sourceProofInternal(store:OntologyObjectStore,owner:string,ref:ObjectRef,budget:ReadBudget) {
  const receipts = store.related(owner, ref, 'sourceReceipts', budget), subject = store.read(owner, ref, budget);
  const scopes: Record<string, string> = { CheckoutSession: 'checkout_session', DeliveryQuote: 'delivery_quote', ProductOffer: 'goods_offer', ReservationOffer: 'reservation', ReservationSlot: 'reservation', Order: 'order', Shipment: 'delivery', DeliveryEvent: 'delivery', DeliveryAllocation: 'delivery', Reservation: 'reservation', Payment: 'payment', Refund: 'refund', ...domainEvidenceScopes };
  const linksDigest = store.relationshipDigest(owner, ref, budget);
  scopes.RegistrationOffer = 'reservation'; scopes.RegistrationRecord = 'reservation';
  scopes.BookingOffers = 'reservation'; scopes.BookingObservation = 'reservation'; scopes.BookingPaymentObservation = 'payment';
  scopes.StripePaymentObservation = 'payment';
  scopes.DidiPlaceObservation = 'domain_ride'; scopes.RideEstimateObservation = 'domain_ride';
  scopes.MeituanReadObservation = (subject.properties.snapshot as { data?: { kind?: string } } | undefined)?.data?.kind === 'locations' ? 'public_locations' : 'delivery_quote';
  scopes.CatalogRead = 'goods_offer';
  scopes.CatalogObservation = 'goods_offer'; scopes.CatalogEndpoint = 'goods_offer';
  Object.assign(scopes, commerceEvidenceScopes);
  const propertiesDigest=store.security?store.evidencePropertiesDigest(owner,ref,budget):digest(subject.properties);
  if (!scopes[ref.type] || !receipts?.length || receipts.some(r => !r.properties.sourceIdentity || !r.properties.sourceEventId || !r.properties.contentDigest || !r.properties.evidenceLevel || r.properties.evidenceLevel === 'user_asserted' || r.properties.scope !== scopes[ref.type] || !r.properties.observedAt || Date.parse(String(r.properties.observedAt)) > store.now() || !(r.properties.subjects as { object: ObjectRef; digest: string; linksDigest: string }[] | undefined)?.some(s => s.object.type === ref.type && s.object.id === ref.id && s.digest === propertiesDigest && s.linksDigest === linksDigest))) return undefined;
  return { refs: receipts.map(r => r.ref), levels: receipts.map(r => String(r.properties.evidenceLevel)) };
}
