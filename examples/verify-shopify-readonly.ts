import { mkdir, writeFile } from 'node:fs/promises';
import { ShopifyCatalogAccess, ShopifyReadError, ShopifyReadOnlyClient, SHOPIFY_CATALOG_READS, SHOPIFY_TEST_PROFILE, bindShopifyMerchantVariant, bindShopifyOffer, type ShopifyReadReceipt } from '../packages/capabilities/shopify/read-only.js';

// The default merchant is a public technical sample, not an approved supplier.
// Override both identifiers together when checking a user-selected merchant.
const merchantDomain = process.env.EIGOS_SHOPIFY_MERCHANT_DOMAIN ?? 'purity-coffee.myshopify.com';
const merchantId = process.env.EIGOS_SHOPIFY_MERCHANT_ID ?? 'gid://shopify/Shop/40613871783';
const country = process.env.EIGOS_SHOPIFY_COUNTRY ?? 'US';
const query = process.env.EIGOS_SHOPIFY_QUERY ?? 'coffee beans';
const trace: ShopifyReadReceipt[] = [];
const report: Record<string, unknown> = {
  schemaVersion: 1, startedAt: new Date().toISOString(), status: 'incomplete',
  scope: 'Shopify production endpoints, catalog reads only',
  platformProfile: { url: SHOPIFY_TEST_PROFILE, identity: 'shopify_hosted_test_fixture', eigosIdentityVerified: false },
  merchant: { domain: merchantDomain, catalogReportedId: merchantId, relationship: 'public_technical_sample_not_approved_supplier' },
  authorization: { merchantBusinessConsentVerified: false, buyerConsentVerified: false, checkoutAuthorized: false, orderRead: 'not_attempted_no_owned_order_or_order_scope' },
  boundary: { cart: 'disabled', checkout: 'disabled', order: 'disabled', payment: 'disabled', fulfillment: 'not_verified', executableBinding: 'not_published_to_gateway_or_worker' },
  requests: trace,
};
const signal = AbortSignal.timeout(120000);

try {
  if (Boolean(process.env.EIGOS_SHOPIFY_MERCHANT_DOMAIN) !== Boolean(process.env.EIGOS_SHOPIFY_MERCHANT_ID)) throw new ShopifyReadError('MERCHANT_ID_AND_DOMAIN_REQUIRED_TOGETHER');
  const mode = process.env.EIGOS_SHOPIFY_AUTH_MODE ?? 'anonymous';
  if (!['anonymous', 'token'].includes(mode)) throw new ShopifyReadError('INVALID_AUTH_MODE');
  const clientId = process.env.EIGOS_SHOPIFY_CLIENT_ID, secret = process.env.EIGOS_SHOPIFY_CLIENT_SECRET;
  if (mode === 'token' && (!clientId || !secret)) throw new ShopifyReadError('INCOMPLETE_CREDENTIAL_CONFIGURATION');
  // Existing credentials never silently upgrade an anonymous probe.
  const access = mode === 'token' ? await ShopifyCatalogAccess.exchange(clientId!, secret!, signal) : undefined;
  report.authentication = access ? { mode: 'token', credentialExchange: 'accepted', tokenMetadata: access.toJSON(), globalCatalogAccepted: false, merchantCatalogAccepted: false } : { mode: 'anonymous', credentialExchange: 'not_attempted_anonymous_scope', tokenAuthorizationVerified: false };
  const onReceipt = (receipt: ShopifyReadReceipt) => { trace.push(receipt); };
  await mkdir('data/shopify-readonly/responses', { recursive: true, mode: 0o700 });
  const onEvidence = async (receipt: ShopifyReadReceipt, response: Uint8Array) => { await writeFile(`data/shopify-readonly/responses/${receipt.id}.json`, response, { mode: 0o600 }); };
  const global = new ShopifyReadOnlyClient({ access, onReceipt, onEvidence });
  const globalTools = await global.listTools(signal);
  if (globalTools.enabledReads.length !== SHOPIFY_CATALOG_READS.length) throw new ShopifyReadError('CATALOG_TOOLS_MISSING');
  report.globalTools = globalTools.tools;
  const search = await global.read('search_catalog', { query, context: { address_country: country }, pagination: { limit: 3 }, filters: { shops: [merchantId] } }, signal);
  const candidates = search.value.products.flatMap(p => p.variants.map(v => ({ productId: p.id, variant: v }))).filter(c => c.variant.seller?.id === merchantId && c.variant.seller.domain === merchantDomain);
  const selected = candidates[0];
  if (!selected?.variant.seller) throw new ShopifyReadError('SELECTED_MERCHANT_NOT_IN_RESULTS');
  const identity = { variantId: selected.variant.id, sellerId: merchantId, merchantDomain };
  bindShopifyOffer(search.value, identity);
  // Read the cluster as returned by search, then keep exactly the chosen offer.
  const detail = await global.read('get_product', { id: selected.productId, context: { address_country: country } }, signal);
  const offer = bindShopifyOffer(detail.value, identity);
  report.selection = { productId: selected.productId, variantId: offer.id, seller: offer.seller, price: offer.price, availableReported: offer.availability?.available ?? null, nativeCheckoutEligibleReported: offer.eligible?.native_checkout ?? null, discoveryReceipt: search.receipt.id, detailReceipt: detail.receipt.id, messages: search.value.messages };
  if (access) (report.authentication as Record<string, unknown>).globalCatalogAccepted = true;
  const buyerIp = access ? process.env.EIGOS_SHOPIFY_BUYER_IP : undefined;
  const merchant = new ShopifyReadOnlyClient({ merchantDomain, access, ...(buyerIp ? { buyerIp: { address: buyerIp, source: 'explicit-operator-input' as const } } : {}), onReceipt, onEvidence });
  const profile = await merchant.discover(signal);
  report.discovery = { protocolVersion: profile.value.ucp.version, capabilities: Object.keys(profile.value.ucp.capabilities), endpointPinned: true, receipt: profile.receipt.id };
  const merchantTools = await merchant.listTools(signal);
  report.merchantTools = { advertised: merchantTools.tools, enabled: merchantTools.enabledReads };
  if (access && !buyerIp) throw new ShopifyReadError('BUYER_IP_REQUIRED');
  const lookup = await merchant.read('lookup_catalog', { ids: [offer.id], context: { address_country: country } }, signal);
  const actual = bindShopifyMerchantVariant(lookup.value, identity);
  if (!offer.price || !actual.price) throw new ShopifyReadError('SOURCE_PRICE_MISSING');
  report.readback = { variantId: actual.id, sku: actual.sku, price: actual.price, availableReported: actual.availability?.available ?? null, identityMatched: true, priceMatchesGlobal: actual.price.amount === offer.price.amount && actual.price.currency === offer.price.currency, receipt: lookup.receipt.id, messages: lookup.value.messages, stockQuantity: 'unknown', destinationDeliveryCommitment: 'unknown' };
  if (access) (report.authentication as Record<string, unknown>).merchantCatalogAccepted = true;
  report.status = 'readonly_query_verified';
} catch (error) {
  report.failure = error instanceof ShopifyReadError ? { code: error.code, httpStatus: error.httpStatus } : { code: signal.aborted ? 'DEADLINE_EXCEEDED' : 'UNEXPECTED_FAILURE' };
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.mutationToolCalls = trace.filter(r => r.operation !== 'discovery' && r.operation !== 'tools/list' && !(SHOPIFY_CATALOG_READS as readonly string[]).includes(r.operation)).length;
  await mkdir('data/shopify-readonly', { recursive: true, mode: 0o700 });
  await writeFile('data/shopify-readonly/report.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
