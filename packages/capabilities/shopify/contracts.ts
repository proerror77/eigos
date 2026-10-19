import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { SHOPIFY_CATALOG_ORIGIN, SHOPIFY_UCP_VERSION, shopifyMerchantOrigin } from './read-only.js';

const text = z.string().min(1).max(500), sha = z.string().regex(/^[a-f0-9]{64}$/), time = z.iso.datetime({ offset: true });
export const shopifyMerchantSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), name: z.string().min(1).max(100),
  shopId: z.string().regex(/^gid:\/\/shopify\/Shop\/[0-9]+$/),
  domain: z.string().refine(v => { try { shopifyMerchantOrigin(v); return true; } catch { return false; } }),
});
export const shopifyMerchantsSchema = z.array(shopifyMerchantSchema).max(8).refine(v => ['id', 'shopId', 'domain'].every(k => new Set(v.map(m => m[k as keyof typeof m])).size === v.length), 'Merchant identities must be unique');
export type ShopifyMerchant = z.infer<typeof shopifyMerchantSchema>;
export const catalogQuerySchema = z.strictObject({ merchantId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), query: z.string().trim().min(1).max(300), country: z.literal('US') });
export type CatalogQuery = z.infer<typeof catalogQuerySchema>;
export const catalogReceiptSchema = z.strictObject({ id: text, endpoint: z.url(), operation: z.enum(['discovery', 'tools/list', 'search_catalog', 'get_product', 'lookup_catalog']), startedAt: time, receivedAt: time, httpStatus: z.literal(200), authentication: z.literal('anonymous'), inputSha256: sha, responseSha256: sha, responseBytes: z.number().int().positive().max(1048576) });
export const catalogItemSchema = z.strictObject({
  globalProductId: text, variantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/[0-9]+$/), title: z.string().min(1).max(500), sku: text.optional(),
  displayPrice: z.strictObject({ minor: z.string().regex(/^(0|[1-9]\d{0,17})$/), currency: z.literal('USD') }),
  availableReported: z.boolean().optional(), nativeCheckoutEligibleReported: z.boolean().optional(),
  globalReceiptId: text, merchantReceiptId: text,
});
export const catalogSnapshotSchema = z.strictObject({
  id: text, source: z.literal('shopify'), authentication: z.literal('anonymous'), protocolVersion: z.literal(SHOPIFY_UCP_VERSION),
  requestId: text, requestRevision: z.number().int().positive(), configurationDigest: sha, inputDigest: sha,
  query: catalogQuerySchema, merchant: shopifyMerchantSchema,
  phase: z.enum(['prepared', 'verified']), evidenceKind: z.enum(['live_readonly', 'fixture']),
  startedAt: time, observedAt: time, expiresAt: time, validityBasis: z.literal('local_refresh_limit'),
  completeness: z.literal('partial_or_unknown'), stockQuantity: z.literal('unknown'), deliveryCommitment: z.literal('unknown'), partnerTrust: z.literal('unverified'),
  items: z.array(catalogItemSchema).max(3), receipts: z.array(catalogReceiptSchema).min(2).max(12),
  noBusinessWrites: z.literal(true), contentDigest: sha,
});
export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;
export function sealCatalogSnapshot(value: Omit<CatalogSnapshot, 'contentDigest'>): CatalogSnapshot { return catalogSnapshotSchema.parse({ ...value, contentDigest: digest(value) }); }
export function checkedCatalogSnapshot(value: unknown): CatalogSnapshot {
  const s = catalogSnapshotSchema.parse(value), { contentDigest, ...body } = s;
  if (contentDigest !== digest(body) || s.inputDigest !== digest(s.query) || s.merchant.id !== s.query.merchantId) throw new Error('Catalog snapshot does not bind its query and content');
  const origin = shopifyMerchantOrigin(s.merchant.domain), receipts = new Map(s.receipts.map(r => [r.id, r]));
  if (receipts.size !== s.receipts.length || new Set(s.items.map(i => i.variantId)).size !== s.items.length) throw new Error('Duplicate catalog identities or receipts');
  if (Date.parse(s.startedAt) > Date.parse(s.observedAt) || Date.parse(s.expiresAt) !== Date.parse(s.startedAt) + 300000) throw new Error('Invalid catalog observation window');
  for (const r of s.receipts) {
    const expected = r.operation === 'discovery' ? `${origin}/.well-known/ucp` : r.operation === 'lookup_catalog' ? `${origin}/api/ucp/mcp` : `${SHOPIFY_CATALOG_ORIGIN}/api/ucp/mcp`;
    if (r.endpoint !== expected || Date.parse(r.startedAt) < Date.parse(s.startedAt) || Date.parse(r.receivedAt) < Date.parse(r.startedAt) || Date.parse(r.receivedAt) > Date.parse(s.observedAt)) throw new Error('Catalog source or observation mismatch');
  }
  if (s.receipts.filter(r => r.operation === 'search_catalog').length !== 1 || s.receipts.filter(r => r.operation === 'discovery').length !== (s.phase === 'prepared' ? 1 : 2)) throw new Error('Catalog discovery evidence missing');
  for (const item of s.items) if (receipts.get(item.globalReceiptId)?.operation !== 'get_product' || receipts.get(item.merchantReceiptId)?.operation !== 'lookup_catalog') throw new Error('Catalog item lacks both global and merchant evidence');
  if (s.phase === 'verified' && s.items.length && s.receipts.filter(r => r.operation === 'lookup_catalog').length !== 2) throw new Error('Catalog result needs an independent final merchant read');
  return s;
}
