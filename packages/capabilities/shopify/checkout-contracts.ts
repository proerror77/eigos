import { z } from 'zod';
import { moneySchema } from '../../ontology/execution.js';
import { shopifyMerchantSchema } from './contracts.js';
import { digest } from '../../core/delegation.js';

export const SHOP_MCP_ENDPOINT = 'https://mcp.shop.com';
export const SHOP_MCP_PROTOCOL = '2026-07-28';
export const SHOP_CHECKOUT_VERSION = '2026-08-25';
export const shopVariantId = z.string().regex(/^gid:\/\/shopify\/ProductVariant\/[0-9]+$/);
export const shopCheckoutId = z.string().startsWith('gid://shopify/Checkout/').min(25).max(4096).refine(value => !/[\r\n]/.test(value));
export const shopLineItemSchema = z.strictObject({ variantId: shopVariantId, quantity: z.number().int().min(1).max(1000) });
export const shopLineItemsSchema = z.array(shopLineItemSchema).min(1).max(20).refine(items => new Set(items.map(item => item.variantId)).size === items.length, 'Duplicate product variants');
export const shopCheckoutInputSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('prepare'), merchantId: shopifyMerchantSchema.shape.id, items: shopLineItemsSchema }),
  z.strictObject({ mode: z.literal('status'), sourceTaskId: z.uuid() }),
]);
export type ShopCheckoutInput = z.infer<typeof shopCheckoutInputSchema>;
export const shopSelectedProductSchema = z.strictObject({ variantId: shopVariantId, title: z.string().min(1).max(1000), quantity: z.number().int().min(1).max(1000), unitPrice: moneySchema, available: z.boolean() });
export type ShopSelectedProduct = z.infer<typeof shopSelectedProductSchema>;
const text = z.string().min(1).max(2000), sha = z.string().regex(/^[a-f0-9]{64}$/), at = z.iso.datetime({ offset: true });
export const shopMessageSchema = z.object({ type: z.string().max(80), code: z.string().max(200).optional(), content: z.string().max(4000).optional(), severity: z.string().max(80).optional() });
export const shopLookupSchema = z.object({
  ucp: z.object({ version: z.literal(SHOP_CHECKOUT_VERSION) }),
  products: z.array(z.object({ title: text, variants: z.array(z.object({
    id: shopVariantId, title: text.optional(), price: z.object({ amount: z.number().int().nonnegative().safe(), currency: z.string().regex(/^[A-Z]{3}$/) }),
    availability: z.object({ available: z.boolean() }),
    seller: z.object({ id: shopifyMerchantSchema.shape.shopId, domain: shopifyMerchantSchema.shape.domain, name: text }),
    options: z.array(z.object({ name: text, label: text })).max(30).optional(),
    inputs: z.array(z.object({ id: text, match: z.string() })).max(50).optional(),
  })).max(100) })).max(50), messages: z.array(shopMessageSchema).max(100).default([]),
});
export const shopCheckoutResponseSchema = z.object({
  ucp: z.object({ version: z.literal(SHOP_CHECKOUT_VERSION), payment_handlers: z.record(z.string().max(200), z.array(z.object({ id: text, config: z.object({ shop_id: z.string().max(200).optional() }).optional() })).max(20)).optional() }),
  id: shopCheckoutId, status: z.enum(['incomplete', 'requires_escalation', 'ready_for_complete', 'complete_in_progress', 'completed', 'canceled']),
  currency: z.string().regex(/^[A-Z]{3}$/),
  line_items: z.array(z.object({ id: text, item: z.object({ id: shopVariantId, title: text, price: z.number().int().nonnegative().safe() }), quantity: z.number().int().min(1).max(1000) })).min(1).max(20),
  totals: z.array(z.object({ type: z.string().min(1).max(100), amount: z.number().int().nonnegative().safe(), display_text: text.optional() })).max(40),
  payment: z.object({ instruments: z.array(z.unknown()).max(20) }),
  messages: z.array(shopMessageSchema).max(100).default([]),
  expires_at: at.optional(), continue_url: z.url().max(8192).optional(),
  order: z.object({ id: text }).passthrough().optional(),
});
export type ShopCheckoutResponse = z.infer<typeof shopCheckoutResponseSchema>;
export const shopCheckoutDataSchema = z.strictObject({
  checkoutId: text, status: shopCheckoutResponseSchema.shape.status, currency: z.string().regex(/^[A-Z]{3}$/),
  items: z.array(shopSelectedProductSchema.omit({ available: true })).min(1).max(20),
  totals: z.array(z.strictObject({ type: z.string().max(100), amount: moneySchema, displayText: text.optional() })).max(40),
  paymentHandlers: z.array(z.strictObject({ namespace: text, id: text })).max(100),
  paymentInstrumentCount: z.number().int().nonnegative().max(20), orderId: text.optional(),
  messages: z.array(shopMessageSchema).max(100), hasContinueUrl: z.boolean(),
  expiresAt: at.optional(), finalShippingAndTaxVerified: z.literal(false),
});
export type ShopCheckoutData = z.infer<typeof shopCheckoutDataSchema>;
export const shopCheckoutReceiptSchema = z.strictObject({
  id: z.uuid(), endpoint: z.literal(SHOP_MCP_ENDPOINT), protocolVersion: z.literal(SHOP_MCP_PROTOCOL),
  tool: z.enum(['lookup_catalog', 'create_checkout', 'get_checkout']), startedAt: at, receivedAt: at,
  httpStatus: z.literal(200), requestDigest: sha, responseSha256: sha, responseBytes: z.number().int().positive().max(2_097_152),
  operationKey: z.string().regex(/^[a-f0-9]{64}$/).optional(), idempotencyKey: z.uuid().optional(),
});
export type ShopCheckoutReceipt = z.infer<typeof shopCheckoutReceiptSchema>;
export interface ShopCallContext { ownerDigest: string; requestId: string; intentId: string; operationKey: string; assertDispatchAllowed?: () => void }
export interface ShopCallResult { value: unknown; receipt: ShopCheckoutReceipt; isError: boolean }
export type ShopTool = ShopCheckoutReceipt['tool'];
export interface ShopCheckoutConnector {
  readonly evidenceKind: 'provider' | 'fixture';
  call(tool: ShopTool, args: Record<string, unknown>, context: ShopCallContext, signal: AbortSignal): Promise<ShopCallResult>;
  originalCreation(context: ShopCallContext, requestDigest: string): ShopCallResult | undefined;
}

export const shopCheckoutSnapshotSchema = z.strictObject({
  version: z.literal('1'), id: text, ownerDigest: sha, requestId: z.uuid(), requestRevision: z.number().int().positive(),
  configurationDigest: sha, scopeId: text, action: z.enum(['ReadShopifyCheckoutProducts', 'CreateShopifyCheckout', 'ReadShopifyCheckout']),
  actionInputDigest: sha, planId: text, intentId: text, attemptId: text, modelRunId: text,
  merchant: shopifyMerchantSchema, selection: shopLineItemsSchema, receipt: shopCheckoutReceiptSchema,
  evidenceKind: z.enum(['provider', 'fixture']), products: z.array(shopSelectedProductSchema).min(1).max(20).optional(),
  checkout: shopCheckoutDataSchema.optional(), privateCheckoutId: shopCheckoutId.optional(), continueUrl: z.url().max(8192).optional(),
  originalIntentId: text.optional(), originalTaskId: z.uuid().optional(), originalOperationKey: sha.optional(),
  originalObservation: z.strictObject({ type: z.literal('ShopifyCheckoutObservation'), id: text }).optional(),
  creationReceipt: shopCheckoutReceiptSchema.optional(), creationIdentityDigest: sha.optional(), recoveredByRead: z.literal(true).optional(),
  observedAt: at, expiresAt: at, contentDigest: sha,
});
export type ShopCheckoutSnapshot = z.infer<typeof shopCheckoutSnapshotSchema>;

export function checkoutIdempotencyKey(operationKey: string): string {
  const hash = digest({ protocol: 'shopify-unpaid-checkout-v1', operationKey: sha.parse(operationKey) });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export const shopLookupArguments = (merchant: z.infer<typeof shopifyMerchantSchema>, items: z.infer<typeof shopLineItemsSchema>) => ({
  catalog: { ids: items.map(item => item.variantId), context: { address_country: 'US', currency: 'USD' }, filters: { shops: [merchant.shopId] } },
});
export const shopCreateArguments = (merchant: z.infer<typeof shopifyMerchantSchema>, items: z.infer<typeof shopLineItemsSchema>, operationKey: string) => ({
  shop: merchant.domain, checkout: { line_items: items.map(item => ({ item: { id: item.variantId }, quantity: item.quantity })) }, meta: { 'idempotency-key': checkoutIdempotencyKey(operationKey) },
});
