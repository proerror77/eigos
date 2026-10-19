import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { checkedCatalogSnapshot } from '../capabilities/shopify/contracts.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ObjectWrite, type LinkWrite } from './object-store.js';
import type { ObjectRef } from './model.js';

export function projectCatalogRead(graph: OntologyObjectStore, owner: string, request: { id: string; revision: number }, capabilityId: string, input: unknown, value: unknown): { state: 'typed_result' | 'invalid_source'; subject?: ObjectRef } {
  try {
    const s = checkedCatalogSnapshot(value);
    if (capabilityId !== 'commerce.catalog.query' || s.requestId !== request.id || s.requestRevision !== request.revision || s.inputDigest !== digest(input)) return { state: 'invalid_source' };
    const root = { type: 'ServiceRequest', id: request.id }, subject = { type: 'CatalogRead', id: s.id };
    if (graph.read(owner, root).properties.revision !== request.revision) return { state: 'invalid_source' };
    const objects: ObjectWrite[] = [], links: LinkWrite[] = [], sealed: ObjectWrite[] = [];
    const add = (ref: ObjectRef, title: string, fields: Record<string, unknown>, seal = false) => {
      const definition = graph.model.object(ref.type), properties = { [definition.primaryKey]: ref.id, displayTitle: title.slice(0, 500), ...fields }, record = { ref, properties };
      try {
        const previous = graph.read(owner, ref);
        if (digest(previous.properties) !== digest(properties)) throw new Error('Immutable catalog observation changed');
      } catch (error) { if (error instanceof DomainError && error.code === 'NOT_FOUND') objects.push(record); else throw error; }
      if (seal) sealed.push(record);
      return ref;
    };
    add(subject, `${s.merchant.name}: ${s.query.query}`, { requestRevision: request.revision, query: s.query, phase: s.phase, snapshot: s }, true);
    links.push({ type: 'CatalogReadRequest', from: subject, to: root });
    const provider = add({ type: 'Provider', id: digest({ catalogRead: s.id, shop: s.merchant.shopId }) }, s.merchant.name, { name: s.merchant.name, verifiedIdentityRefs: [s.merchant.shopId, `https://${s.merchant.domain}`] });
    const channel = add({ type: 'Channel', id: 'shopify:anonymous-catalog' }, 'Shopify 公开商品目录', { name: 'Shopify 公开商品目录', accessScope: ['anonymous_public_catalog'], supportedOperationRefs: ['search_catalog', 'get_product', 'lookup_catalog'] });
    for (const item of s.items) {
      const variant = add({ type: 'ProductVariant', id: digest({ catalogRead: s.id, variant: item.variantId }) }, item.title, { name: item.title, sourceProductRef: { namespace: 'shopify', id: item.variantId }, specification: [{ name: 'variant_id', value: item.variantId }, ...(item.sku ? [{ name: 'sku', value: item.sku }] : [])], specificationRevision: s.contentDigest });
      const offer = add({ type: 'ProductOffer', id: digest({ catalogRead: s.id, offer: item.variantId }) }, item.title, {
        observedAt: s.observedAt, expiresAt: s.expiresAt, validityBasis: 'local_refresh_limit', priceKind: 'display_price', pricingCompleteness: 'partial',
        pricingTerms: { scope: 'partial', components: [{ role: 'goods', amount: item.displayPrice }] }, capacity: 'unknown', variantRevision: 1,
      }, true);
      links.push({ type: 'CatalogReadOffers', from: subject, to: offer }, { type: 'OfferRequest', from: offer, to: root }, { type: 'OfferProvider', from: offer, to: provider }, { type: 'OfferChannel', from: offer, to: channel }, { type: 'ProductOfferVariant', from: offer, to: variant });
    }
    const receipt = { type: 'SourceReceipt', id: `catalog:${s.id}` };
    add(receipt, 'Shopify 匿名商品读取回执', { sourceIdentity: `shopify:${s.merchant.domain}`, sourceEventId: s.id, scope: 'goods_offer', observedAt: s.observedAt, evidenceLevel: s.evidenceKind === 'fixture' ? 'synthetic' : 'live_readonly', contentDigest: s.contentDigest, subjects: sealed.map(o => ({ object: o.ref, digest: digest(o.properties), linksDigest: linkSnapshotDigest(o.ref, links) })), safeSummary: '已核对商家、商品变体和公开显示价格；库存、配送及商家合作状态未经验证' });
    links.push({ type: 'ReceiptRequest', from: receipt, to: root });
    for (const o of sealed) links.push({ type: o.ref.type === 'CatalogRead' ? 'CatalogReadEvidence' : 'ProductOfferEvidence', from: o.ref, to: receipt });
    graph.ingest(owner, { objects, links }, { kind: s.evidenceKind === 'fixture' ? 'synthetic' : 'provider', id: s.id, observedAt: s.observedAt });
    return { state: 'typed_result', subject };
  } catch { return { state: 'invalid_source' }; }
}
