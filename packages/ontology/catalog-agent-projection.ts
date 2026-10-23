import { catalogReadDefinition } from './catalog-read-definition.js';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { catalogActionSchemas, catalogObservationSchema, type CatalogObservation } from './catalog-agent.js';
import { SHOPIFY_CATALOG_ORIGIN, ShopifyReadOnlyClient, shopifyMerchantOrigin } from '../capabilities/shopify/read-only.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ObjectWrite, type LinkWrite } from './object-store.js';
import type { ObjectRef } from './model.js';

export function checkedAgentCatalogObservation(value: unknown): CatalogObservation {
  const s = catalogObservationSchema.parse(value), { contentDigest, ...body } = s;
  const input = catalogActionSchemas[s.action].parse(s.actionInput);
  const binding = catalogReadDefinition.actions.find(a => a.id === s.action)!.mcp;
  const merchantOrigin = shopifyMerchantOrigin(s.merchant.domain);
  const expectedEndpoint = binding.transport === 'discovery' ? `${merchantOrigin}/.well-known/ucp` : `${binding.connection?.merchantDomain ? merchantOrigin : SHOPIFY_CATALOG_ORIGIN}/api/ucp/mcp`;
  if (digest(body) !== contentDigest || s.id !== s.receipt.id || s.receipt.endpoint !== expectedEndpoint || s.receipt.operation !== binding.tool
    || input.merchantId !== s.merchant.id || digest(input.scope) !== digest(s.scope) || s.observedAt !== s.receipt.receivedAt
    || Date.parse(s.receipt.startedAt) > Date.parse(s.observedAt) || Date.parse(s.expiresAt) !== Date.parse(s.receipt.startedAt) + 300000
    || new Set(s.items.map(i => i.variantId)).size !== s.items.length) throw new DomainError('CONFLICT', 'Catalog observation identity, input, source or validity window is invalid');
  if (binding.transport === 'discovery') {
    if (s.items.length || !s.profile) throw new DomainError('CONFLICT', 'Discovery cannot contain product facts');
    new ShopifyReadOnlyClient({ merchantDomain: s.merchant.domain }).restoreDiscovery(s.profile);
  } else if (s.profile) throw new DomainError('CONFLICT', 'Only discovery can establish a merchant endpoint');
  if (s.action === 'InspectCatalogVariant' && (s.items.length !== 1 || s.items[0]!.variantId !== catalogActionSchemas.InspectCatalogVariant.parse(input).variantId)) throw new DomainError('CONFLICT', 'Detail result does not match the selected variant');
  if (s.action === 'ReadMerchantVariants') {
    const ids = catalogActionSchemas.ReadMerchantVariants.parse(input).variantIds;
    if (ids.length !== s.items.length || s.items.some(i => !ids.includes(i.variantId))) throw new DomainError('CONFLICT', 'Merchant result does not match the selected variants');
  }
  return s;
}

/** Only invoked inside the accepted observation transaction, after the claim fence. */
export function projectAgentCatalogObservation(graph: OntologyObjectStore, owner: string, value: unknown): ObjectRef {
  const s = checkedAgentCatalogObservation(value), root = { type: 'ServiceRequest', id: s.requestId };
  if (graph.read(owner, root).properties.revision !== s.requestRevision) throw new DomainError('CONFLICT', 'Catalog result belongs to an old request revision');
  const subject = { type: catalogReadDefinition.actions.find(a => a.id === s.action)!.resultType, id: s.id };
  const objects: ObjectWrite[] = [], sealed: ObjectWrite[] = [], links: LinkWrite[] = [];
  const add = (ref: ObjectRef, title: string, fields: Record<string, unknown>, seal = false) => {
    const def = graph.model.object(ref.type), record = { ref, properties: { [def.primaryKey]: ref.id, displayTitle: title.slice(0, 500), ...fields } };
    try { graph.read(owner, ref); throw new DomainError('CONFLICT', 'Catalog observations are immutable and cannot be replayed'); }
    catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; }
    objects.push(record); if (seal) sealed.push(record); return ref;
  };
  add(subject, `${s.merchant.name}: ${s.action}`, { requestRevision: s.requestRevision, snapshot: s }, true);
  links.push({ type: `${subject.type}Request`, from: subject, to: root }, { type: `${subject.type}Task`, from: subject, to: s.scope });
  if (s.items.some(i => i.displayPrice)) {
    const provider = add({ type: 'Provider', id: digest({ observation: s.id, shop: s.merchant.shopId }) }, s.merchant.name, { name: s.merchant.name, verifiedIdentityRefs: [s.merchant.shopId, shopifyMerchantOrigin(s.merchant.domain)] });
    const channel = add({ type: 'Channel', id: digest({ observation: s.id, channel: 'shopify' }) }, 'Shopify 公开商品目录', { name: 'Shopify 公开商品目录', accessScope: ['anonymous_public_catalog'], supportedOperationRefs: [s.receipt.operation] });
    for (const item of s.items.filter(i => i.displayPrice)) {
      const variant = add({ type: 'ProductVariant', id: digest({ observation: s.id, variant: item.variantId }) }, item.title, { name: item.title.slice(0, 1000), sourceProductRef: { namespace: 'shopify', id: item.variantId }, specification: [{ name: 'variant_id', value: item.variantId }, ...(item.sku ? [{ name: 'sku', value: item.sku }] : [])], specificationRevision: s.contentDigest });
      const offer = add({ type: 'ProductOffer', id: digest({ observation: s.id, offer: item.variantId }) }, item.title, { observedAt: s.observedAt, expiresAt: s.expiresAt, validityBasis: 'local_refresh_limit', priceKind: 'display_price', pricingCompleteness: 'partial', pricingTerms: { scope: 'partial', components: [{ role: 'goods', amount: item.displayPrice }] }, capacity: 'unknown', variantRevision: 1 }, true);
      links.push({ type: 'CatalogObservationOffers', from: subject, to: offer }, { type: 'OfferRequest', from: offer, to: root }, { type: 'OfferProvider', from: offer, to: provider }, { type: 'OfferChannel', from: offer, to: channel }, { type: 'ProductOfferVariant', from: offer, to: variant });
    }
  }
  const receipt = { type: 'SourceReceipt', id: `agent-catalog:${s.id}` };
  add(receipt, 'Agent 商品查询来源回执', { sourceIdentity: `shopify:${s.merchant.domain}`, sourceEventId: s.receipt.id, scope: 'goods_offer', observedAt: s.observedAt, evidenceLevel: s.evidenceKind === 'fixture' ? 'synthetic' : 'live_readonly', contentDigest: s.contentDigest, subjects: sealed.map(o => ({ object: o.ref, digest: digest(o.properties), linksDigest: linkSnapshotDigest(o.ref, links) })), safeSummary: '一次模型选择的匿名只读调用；价格是显示价，库存数量、配送及合作状态未知' });
  links.push({ type: 'ReceiptRequest', from: receipt, to: root });
  for (const o of sealed) links.push({ type: o.ref.type === 'ProductOffer' ? 'ProductOfferEvidence' : `${o.ref.type}Evidence`, from: o.ref, to: receipt });
  graph.ingest(owner, { objects, links }, { kind: s.evidenceKind === 'fixture' ? 'synthetic' : 'provider', id: s.receipt.id, observedAt: s.observedAt });
  return subject;
}
