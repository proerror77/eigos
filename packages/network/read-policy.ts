import { DomainError } from '../core/domain.js';
import { NetworkError, type Publication } from './contracts.js';
import type { NetworkDirectory } from './directory.js';
import type { NetworkCollaboration } from './collaboration.js';
import type { NetworkStore } from './store.js';
import type { NetworkQueryResult } from './service.js';

export interface PublicationReadPolicy {
  store: NetworkStore; directory: NetworkDirectory; collaboration: NetworkCollaboration;
  evidence?: (publication: Publication) => void;
  candidateState?: (listingId: string, viewerId: string) => NetworkQueryResult['capabilityState'];
}
/** Shared by the public directory and the native bounded ontology reader.
 * Missing, withdrawn and inaccessible objects use the same absent result. */
export function baseNetworkPublication(policy: Omit<PublicationReadPolicy, 'collaboration'>, pub: Publication, viewerId: string): NetworkQueryResult | undefined {
  try {
    const grant = policy.store.get('grant', pub.grantId);
    if (pub.state !== 'active' || grant.status !== 'consumed' || grant.usedPublicationId !== pub.id || Date.parse(pub.visibleUntil) <= policy.store.now()) return;
    policy.directory.profile(pub.profileId, pub.owner); policy.directory.mayRead(grant, pub.memberId, viewerId);
    policy.directory.validateContent(pub.content, pub.owner, pub.profileId);
    if (pub.content.kind === 'evidence_card') { if (!policy.evidence) return; policy.evidence(pub); }
    return { version: 1, ref: { kind: 'publication', id: pub.id, revision: pub.revision }, profileId: pub.profileId, spaceId: grant.spaceId,
      content: pub.content, visibleUntil: pub.visibleUntil,
      ...(pub.content.kind === 'listing' && policy.candidateState ? { capabilityState: policy.candidateState(pub.content.listingId, viewerId) } : {}) };
  } catch (error) {
    if (error instanceof NetworkError && error.status < 500 && error.status !== 429 || error instanceof DomainError) return;
    throw error;
  }
}
export function readNetworkPublication(policy: PublicationReadPolicy, pub: Publication, viewerId: string): NetworkQueryResult | undefined {
  const base = baseNetworkPublication(policy, pub, viewerId); if (!base) return;
  try {
    if (!policy.collaboration.readable(pub, viewerId)) return;
    return { ...base, ...(pub.content.kind === 'need' ? { need: policy.collaboration.view(policy.collaboration.need(pub.needId ?? pub.id)) } : {}),
      ...(pub.content.kind === 'message' ? { message: { id: pub.messageId ?? pub.id, revision: policy.store.get('message', pub.messageId ?? pub.id).revision } } : {}) };
  } catch (error) {
    if (error instanceof NetworkError && error.status < 500 || error instanceof DomainError) return;
    throw error;
  }
}
