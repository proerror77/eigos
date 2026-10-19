import { paotuiActionIds } from '../ontology/paotui-agent.js';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { bindingDigest, sameRef, isActionAdapter, type ExecutionCatalog } from '../core/catalog.js';
import type { NetworkStore } from './store.js';
import type { InquirySource } from './inquiry-contracts.js';

// Trusted read policies, not names/tags supplied by a seller or a model.
export function quoteCapability(catalog: ExecutionCatalog, ref: InquirySource['capabilityRef']) {
  const c = catalog.capability(ref);
  const legacy = ['1', '2'].includes(c.ref.version) && c.actions.length === 1 && c.actions[0]!.effect === 'read' && c.actions[0]!.ref.id === 'delivery.quote.read' && c.actions[0]!.ref.version === c.ref.version;
  const agent = c.ref.version === '3' && c.ontologyRef.id === 'paotui.agent.actions' && c.actions.length === paotuiActionIds.length && paotuiActionIds.every(id => c.actions.some(a => a.ref.id === id && a.ref.version === '1' && a.effect === 'read'));
  if (c.ref.id !== 'delivery.quote' || c.environment === 'sandbox' || !(legacy || agent)) throw new DomainError('FORBIDDEN', 'No registered quote-only policy for this capability');
  return c;
}
export function validateInquirySource(store: NetworkStore, catalog: ExecutionCatalog, owner: string, source: InquirySource) {
  store.checkFence(source.buyerMemberId);
  const listing = store.get('listing', source.listingId), representation = store.get('representation', listing.representationId, listing.owner);
  const profile = store.get('profile', listing.profileId, listing.owner), publication = store.get('publication', source.listingPublicationId, listing.owner);
  store.checkFence(listing.memberId);
  const grant = store.get('grant', publication.grantId, listing.owner), space = store.get('space', grant.spaceId);
  const membership = (memberId: string) => store.scan('membership', { spaceId: space.id, memberId }, '', 1)[0];
  const publisher = membership(listing.memberId), buyer = membership(source.buyerMemberId);
  if (listing.state !== 'active' || listing.revision !== source.listingRevision || profile.state === 'suspended'
    || representation.state !== 'verified' || !representation.validUntil || Date.parse(representation.validUntil) <= store.now()
    || representation.revision !== listing.representationRevision || representation.providerId !== listing.providerId
    || !representation.capabilityRefs.some(r => sameRef(r, source.capabilityRef))
    || publication.state !== 'active' || publication.content.kind !== 'listing' || publication.content.listingId !== listing.id || publication.content.listingRevision !== listing.revision
    || grant.status !== 'consumed' || grant.usedPublicationId !== publication.id || Date.parse(publication.visibleUntil) <= store.now()
    || space.state !== 'active' || space.epoch !== (grant.spaceEpoch ?? 1) || publisher?.state !== 'active' || buyer?.state !== 'active'
    || publisher.generation !== (grant.publisherGeneration ?? 1) || buyer.generation !== (grant.membershipGenerations?.[source.buyerMemberId] ?? 1)
    || !grant.recipientMemberIds.includes(source.buyerMemberId)) throw new DomainError('FORBIDDEN', 'Selected inquiry source is no longer available');
  const capability = quoteCapability(catalog, source.capabilityRef), selected = catalog.source(source.bindingRef, owner);
  if (!listing.bindingRef || !sameRef(listing.bindingRef, source.bindingRef) || !sameRef(listing.capabilityRef, source.capabilityRef)
    || !sameRef(selected.binding.capabilityRef, source.capabilityRef) || selected.binding.providerId !== source.providerId || listing.providerId !== source.providerId
    || bindingDigest(selected.binding) !== source.bindingDigest || listing.bindingDigest !== source.bindingDigest
    || digest(capability) !== source.capabilityDigest || listing.capabilityDigest !== source.capabilityDigest || ('adapter' in selected && isActionAdapter(selected.adapter)))
    throw new DomainError('FORBIDDEN', 'Selected inquiry binding or definition changed');
  return { capability, ...selected };
}
