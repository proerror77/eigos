import type { Comparison, DiscoveryCoverage, Offer } from '../ontology/supply.js';
import type { ServiceRequest } from '../ontology/execution.js';
import { digest } from '../core/delegation.js';

export function compareOffers(request: ServiceRequest, offers: Offer[], coverage: DiscoveryCoverage[]): Comparison {
  const groups = new Map<string, Comparison['merchantGroups'][number]>();
  for (const offer of offers) {
    const key = JSON.stringify([offer.merchant.namespace, offer.merchant.id]); const group = groups.get(key) ?? { merchant: offer.merchant, offerIds: [], channels: [] };
    group.offerIds.push(offer.id); if (!group.channels.includes(offer.channelId)) group.channels.push(offer.channelId); groups.set(key, group);
  }
  const productMatches: Comparison['productMatches'] = [];
  for (let i = 0; i < offers.length; i++) for (let j = i + 1; j < offers.length; j++) {
    const a = offers[i]!, b = offers[j]!;
    const same = (x: { namespace: string; id: string }, y: { namespace: string; id: string }) => x.namespace === y.namespace && x.id === y.id;
    const sameGlobal = a.product.globalProductRef && b.product.globalProductRef && same(a.product.globalProductRef, b.product.globalProductRef);
    const sameNative = same(a.product.sourceProductRef, b.product.sourceProductRef);
    const hasSpecification = (spec: Record<string, unknown>) => Object.entries(spec).some(([k, v]) => k !== 'name' && v != null && v !== 'unknown' && (Array.isArray(v) ? v.length > 0 : typeof v === 'object' ? Object.keys(v).length > 0 : true));
    const evidencedSpecs = digest(a.product.specification) === a.product.specificationDigest && digest(b.product.specification) === b.product.specificationDigest && a.evidenceRefs.length && b.evidenceRefs.length && hasSpecification(a.product.specification) && hasSpecification(b.product.specification);
    productMatches.push({ left: a.id, right: b.id,
      kind: sameGlobal || sameNative ? (a.product.specificationDigest === b.product.specificationDigest ? 'same_external_product' : 'different')
        : evidencedSpecs ? (a.product.name === b.product.name && a.product.specificationDigest === b.product.specificationDigest ? 'same_observed_specification' : 'different') : 'unknown',
      evidenceRefs: [...new Set([...a.evidenceRefs, ...b.evidenceRefs])] });
  }
  return { requestId: request.id, requestRevision: request.revision, offers, merchantGroups: [...groups.values()], productMatches, coverage };
}
