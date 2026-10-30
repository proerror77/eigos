import { catalogReadDefinition } from './catalog-read-definition.js';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { catalogActionSchemas, catalogObservationSchema, type CatalogObservation } from './catalog-agent.js';
import { SHOPIFY_CATALOG_ORIGIN, ShopifyReadOnlyClient, shopifyMerchantOrigin } from '../capabilities/shopify/read-only.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ObjectWrite, type LinkWrite } from './object-store.js';
import type { ObjectRef } from './model.js';
import { businessFactsEnabled } from './business-fact-projection.js';
import { sourceProof } from './object-evidence.js';

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

/** Provider identity is namespaced by Shopify's trusted shop identifier. An
 * observation, display name or credential never creates a new merchant. */
export function catalogEntityRefs(s: Pick<CatalogObservation, 'merchant' | 'action'>, variantId?: string) {
  const merchantOrigin = shopifyMerchantOrigin(s.merchant.domain), direct = s.action === 'ReadMerchantVariants';
  return {
    provider: { type: 'Provider', id: digest({ namespace: 'shopify:merchant', shopId: s.merchant.shopId }) },
    channel: { type: 'Channel', id: digest({ namespace: 'shopify:catalog-channel', origin: direct ? merchantOrigin : SHOPIFY_CATALOG_ORIGIN }) },
    ...(variantId ? { variant: { type: 'ProductVariant', id: digest({ namespace: 'shopify:variant', shopId: s.merchant.shopId, variantId }) } } : {}),
  };
}

/** Only invoked inside the accepted observation transaction, after the claim fence. */
export function projectAgentCatalogObservation(graph: OntologyObjectStore, owner: string, value: unknown): ObjectRef {
  const s = checkedAgentCatalogObservation(value), root = { type: 'ServiceRequest', id: s.requestId };
  if (graph.read(owner, root).properties.revision !== s.requestRevision) throw new DomainError('CONFLICT', 'Catalog result belongs to an old request revision');
  if (Date.parse(s.observedAt) > graph.now() || Date.parse(s.expiresAt) <= graph.now()) throw new DomainError('CONFLICT', 'Only a current catalog response may update business entities');
  const subject = { type: catalogReadDefinition.actions.find(a => a.id === s.action)!.resultType, id: s.id };
  const objects: ObjectWrite[] = [], sealed: ObjectWrite[] = [], links: LinkWrite[] = [], removeLinks: LinkWrite[] = [];
  const add = (ref: ObjectRef, title: string, fields: Record<string, unknown>, seal = false) => {
    const def = graph.model.object(ref.type), record = { ref, properties: { [def.primaryKey]: ref.id, displayTitle: title.slice(0, 500), ...fields } };
    try { graph.read(owner, ref); throw new DomainError('CONFLICT', 'Catalog observations are immutable and cannot be replayed'); }
    catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; }
    objects.push(record); if (seal) sealed.push(record); return ref;
  };
  const current = (ref: ObjectRef, title: string, fields: Record<string, unknown>) => {
    const def = graph.model.object(ref.type), properties = { [def.primaryKey]: ref.id, displayTitle: title.slice(0, 500), ...fields };
    let old;
    try { old = graph.read(owner, ref); } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
    const changed = !old || digest(old.properties) !== digest(properties);
    if (changed || businessFactsEnabled(graph)) objects.push({ ref, properties, ...(old ? { expectedRevision: old.revision, ...(businessFactsEnabled(graph) && !changed ? { reuseIfUnchanged: true } : {}) } : {}) });
    return { ref, revision: (old?.revision ?? 0) + (changed ? 1 : 0), changed, old };
  };
  add(subject, `${s.merchant.name}: ${s.action}`, { requestRevision: s.requestRevision, snapshot: s }, true);
  links.push({ type: `${subject.type}Request`, from: subject, to: root }, { type: `${subject.type}Task`, from: subject, to: s.scope });
  if (s.items.length) {
    const refs = catalogEntityRefs(s), direct = s.action === 'ReadMerchantVariants', channelName = direct ? '商家公开商品目录' : 'Shopify 公开商品目录';
    const provider = current(refs.provider, s.merchant.name, { name: s.merchant.name, verifiedIdentityRefs: [s.merchant.shopId, shopifyMerchantOrigin(s.merchant.domain)] }).ref;
    const channel = current(refs.channel, channelName, { name: channelName, accessScope: ['anonymous_public_catalog'], supportedOperationRefs: direct ? ['lookup_catalog'] : ['search_catalog', 'get_product'] }).ref;
    for (const item of s.items) {
      const ref = catalogEntityRefs(s, item.variantId).variant!, title = item.title.slice(0, 500);
      const specification = [{ name: 'variant_id', value: item.variantId }, ...(item.sku ? [{ name: 'sku', value: item.sku }] : [])];
      const variant = current(ref, title, { name: title, sourceProductRef: { namespace: 'shopify', id: item.variantId }, specification,
        ...(item.typedAttributes ? { typedAttributes: item.typedAttributes } : {}),
        specificationRevision: digest({ title: item.title, productId: item.productId, variantId: item.variantId, sku: item.sku, ...(item.typedAttributes ? { typedAttributes: item.typedAttributes } : {}) }) });
      links.push({ type: 'CatalogObservationVariants', from: subject, to: ref });
      let previous;
      if (variant.old) {
        const observations = graph.related(owner, ref, 'currentCatalogObservation', { remaining: 1000 });
        const checkoutItems = businessFactsEnabled(graph) && observations?.length === 0 ? graph.related(owner, ref, 'checkoutItems', { remaining: 1000 }) : undefined;
        const checkoutOrigin = checkoutItems?.some(item => sourceProof(graph, owner, item.ref, { remaining: 1000 }));
        if (observations?.length !== 1 && !checkoutOrigin) throw new DomainError('CONFLICT', 'Current catalog variant provenance is missing or ambiguous');
        if (checkoutOrigin && variant.changed && Date.parse(s.receipt.startedAt) < Date.parse(variant.old.source.observedAt)) throw new DomainError('CONFLICT', 'An older catalog read cannot replace a checkout-observed variant');
        previous = observations?.length === 1 ? checkedAgentCatalogObservation(observations[0]!.properties.snapshot) : undefined;
        if (previous && (previous.merchant.shopId !== s.merchant.shopId || !previous.items.some(i => i.variantId === item.variantId))) throw new DomainError('CONFLICT', 'Current catalog variant belongs to another source identity');
        // Changed specifications from an older or overlapping read cannot
        // displace a newer observed specification. An explicit fresh read is
        // required to settle disagreement.
        if (previous && variant.changed && Date.parse(s.receipt.startedAt) < Date.parse(previous.observedAt)) throw new DomainError('CONFLICT', 'An older or overlapping catalog read cannot replace the current product specification');
      }
      if (!previous || Date.parse(s.receipt.startedAt) >= Date.parse(previous.receipt.startedAt) && Date.parse(s.observedAt) >= Date.parse(previous.observedAt)) {
        if (previous) removeLinks.push({ type: 'ProductVariantCurrentCatalogObservation', from: ref, to: { type: 'CatalogObservation', id: previous.id } });
        links.push({ type: 'ProductVariantCurrentCatalogObservation', from: ref, to: subject });
      }
      if (!item.displayPrice) continue;
      const offer = add({ type: 'ProductOffer', id: digest({ observation: s.id, offer: item.variantId }) }, item.title, { observedAt: s.observedAt, expiresAt: s.expiresAt, validityBasis: 'local_refresh_limit', priceKind: 'display_price', pricingCompleteness: 'partial', pricingTerms: { scope: 'partial', components: [{ role: 'goods', amount: item.displayPrice }] }, capacity: 'unknown', variantRevision: variant.revision }, true);
      links.push({ type: 'CatalogObservationOffers', from: subject, to: offer }, { type: 'OfferRequest', from: offer, to: root }, { type: 'OfferProvider', from: offer, to: provider }, { type: 'OfferChannel', from: offer, to: channel }, { type: 'ProductOfferVariant', from: offer, to: ref });
    }
  }
  const receipt = { type: 'SourceReceipt', id: `agent-catalog:${s.id}` };
  add(receipt, 'Agent 商品查询来源回执', { sourceIdentity: `shopify:${s.merchant.domain}`, sourceEventId: s.receipt.id, scope: 'goods_offer', observedAt: s.observedAt, evidenceLevel: s.evidenceKind === 'fixture' ? 'synthetic' : 'live_readonly', contentDigest: s.contentDigest, subjects: sealed.map(o => ({ object: o.ref, digest: digest(o.properties), linksDigest: linkSnapshotDigest(o.ref, links) })), safeSummary: '一次模型选择的匿名只读调用；价格是显示价，库存数量、配送及合作状态未知' });
  links.push({ type: 'ReceiptRequest', from: receipt, to: root });
  for (const o of sealed) links.push({ type: o.ref.type === 'ProductOffer' ? 'ProductOfferEvidence' : `${o.ref.type}Evidence`, from: o.ref, to: receipt });
  graph.ingest(owner, { objects, links, removeLinks }, { kind: s.evidenceKind === 'fixture' ? 'synthetic' : 'provider', id: s.receipt.id, observedAt: s.observedAt });
  return subject;
}
