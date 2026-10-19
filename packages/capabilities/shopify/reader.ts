import { randomUUID } from 'node:crypto';
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '../../core/delegation.js';
import { ReplanRequired } from '../../core/domain.js';
import { ShopifyReadOnlyClient, SHOPIFY_UCP_VERSION, bindShopifyOffer, bindShopifyMerchantVariant, type ShopifyReadReceipt } from './read-only.js';
import { catalogReceiptSchema, checkedCatalogSnapshot, sealCatalogSnapshot, type CatalogQuery, type CatalogSnapshot, type ShopifyMerchant } from './contracts.js';

export interface CatalogReadContext { requestId: string; requestRevision: number; configurationDigest: string }
export interface ShopifyCatalogReader {
  readonly evidenceKind: 'live_readonly' | 'fixture';
  discover(ctx: CatalogReadContext, merchant: ShopifyMerchant, query: CatalogQuery, signal: AbortSignal): Promise<CatalogSnapshot>;
  refresh(snapshot: CatalogSnapshot, signal: AbortSignal): Promise<CatalogSnapshot>;
}
/** The Worker supplies no Shopify credential, buyer IP, arbitrary endpoint or prompt.
 * Only the bounded catalog query and configured public merchant reach Shopify. */
export class AnonymousShopifyCatalogReader implements ShopifyCatalogReader {
  readonly evidenceKind: 'live_readonly' | 'fixture';
  constructor(private auditDirectory?: string, private fetcher?: typeof fetch) { this.evidenceKind = fetcher ? 'fixture' : 'live_readonly'; }
  private client(ctx: CatalogReadContext, receipts: ShopifyReadReceipt[], merchantDomain?: string) {
    const context = { requestId: ctx.requestId, requestRevision: ctx.requestRevision, configurationDigest: ctx.configurationDigest };
    return new ShopifyReadOnlyClient({ ...(merchantDomain ? { merchantDomain } : {}), onReceipt: r => { receipts.push(r); }, onEvidence: async (receipt, raw) => {
      if (!this.auditDirectory) return;
      await mkdir(join(this.auditDirectory, 'responses'), { recursive: true, mode: 0o700 });
      await writeFile(join(this.auditDirectory, 'responses', `${receipt.id}.json`), raw, { mode: 0o600 });
      await appendFile(join(this.auditDirectory, 'reads.jsonl'), JSON.stringify({ ...context, receipt }) + '\n', { mode: 0o600 });
    } }, this.fetcher);
  }
  async discover(ctx: CatalogReadContext, merchant: ShopifyMerchant, query: CatalogQuery, signal: AbortSignal): Promise<CatalogSnapshot> {
    const startedAt = new Date().toISOString(), receipts: ShopifyReadReceipt[] = [], global = this.client(ctx, receipts);
    const search = await global.read('search_catalog', { query: query.query, context: { address_country: query.country }, pagination: { limit: 3 }, filters: { shops: [merchant.shopId] } }, signal);
    const selected = search.value.products.flatMap(p => p.variants.filter(v => v.seller?.id === merchant.shopId && v.seller.domain === merchant.domain).slice(0, 1).map(v => ({ product: p.id, variant: v.id, title: v.title ?? p.title }))).slice(0, 3);
    const unique = [...new Map(selected.map(v => [v.variant, v])).values()];
    const details = [];
    for (const selected of unique) {
      signal.throwIfAborted();
      const identity = { variantId: selected.variant, sellerId: merchant.shopId, merchantDomain: merchant.domain };
      bindShopifyOffer(search.value, identity);
      // A global product cluster may return only other sellers in its bounded list.
      // Pin the searched variant and merchant in the request, then still verify both.
      const response = await global.read('get_product', { id: selected.variant, context: { address_country: query.country }, filters: { shops: [merchant.shopId] } }, signal);
      const offer = bindShopifyOffer(response.value, identity);
      details.push({ selected, offer, receipt: response.receipt });
    }
    const storefront = this.client(ctx, receipts, merchant.domain);
    await storefront.discover(signal);
    const lookup = unique.length ? await storefront.read('lookup_catalog', { ids: unique.map(v => v.variant), context: { address_country: query.country } }, signal) : undefined;
    const items: CatalogSnapshot['items'] = details.map(({ selected, offer, receipt }) => {
      const actual = bindShopifyMerchantVariant(lookup!.value, { variantId: offer.id, sellerId: merchant.shopId, merchantDomain: merchant.domain });
      if (!actual.price || !offer.price || actual.price.currency !== 'USD' || digest(actual.price) !== digest(offer.price) || actual.availability?.available !== offer.availability?.available) throw new ReplanRequired('Catalog and merchant observations disagree; no accepted read result');
      return { globalProductId: selected.product, variantId: actual.id, title: selected.title.slice(0, 500), ...(actual.sku ? { sku: actual.sku } : {}), displayPrice: { minor: String(actual.price.amount), currency: 'USD' as const }, ...(actual.availability?.available === undefined ? {} : { availableReported: actual.availability.available }), ...(offer.eligible?.native_checkout === undefined ? {} : { nativeCheckoutEligibleReported: offer.eligible.native_checkout }), globalReceiptId: receipt.id, merchantReceiptId: lookup!.receipt.id };
    });
    const observedAt = new Date().toISOString();
    return sealCatalogSnapshot({ ...ctx, id: randomUUID(), source: 'shopify', authentication: 'anonymous', protocolVersion: SHOPIFY_UCP_VERSION, inputDigest: digest(query), query, merchant, phase: 'prepared', evidenceKind: this.evidenceKind, startedAt, observedAt, expiresAt: new Date(Date.parse(startedAt) + 300000).toISOString(), validityBasis: 'local_refresh_limit', completeness: 'partial_or_unknown', stockQuantity: 'unknown', deliveryCommitment: 'unknown', partnerTrust: 'unverified', items, receipts: receipts.map(r => catalogReceiptSchema.parse(r)), noBusinessWrites: true });
  }
  async refresh(value: CatalogSnapshot, signal: AbortSignal): Promise<CatalogSnapshot> {
    const snapshot = checkedCatalogSnapshot(value), receipts: ShopifyReadReceipt[] = [];
    // Rediscover to keep the endpoint pinned before the independent final lookup.
    const client = this.client(snapshot, receipts, snapshot.merchant.domain);
    await client.discover(signal);
    const lookup = snapshot.items.length ? await client.read('lookup_catalog', { ids: snapshot.items.map(v => v.variantId), context: { address_country: snapshot.query.country } }, signal) : undefined;
    for (const item of snapshot.items) {
      const actual = bindShopifyMerchantVariant(lookup!.value, { variantId: item.variantId, sellerId: snapshot.merchant.shopId, merchantDomain: snapshot.merchant.domain });
      if (!actual.price || actual.price.currency !== item.displayPrice.currency || String(actual.price.amount) !== item.displayPrice.minor || actual.availability?.available !== item.availableReported || actual.sku !== item.sku) throw new ReplanRequired('Merchant price, availability or variant changed; refresh the original query plan');
    }
    signal.throwIfAborted();
    // Keep the preparation freshness window: a lookup cannot renew old global facts.
    const { contentDigest: _old, ...body } = snapshot;
    return sealCatalogSnapshot({ ...body, id: randomUUID(), phase: 'verified', items: snapshot.items.map(i => ({ ...i, merchantReceiptId: lookup!.receipt.id })), receipts: [...snapshot.receipts, ...receipts.map(r => catalogReceiptSchema.parse(r))], observedAt: new Date().toISOString() });
  }
}
