import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { moneySchema } from '../../ontology/execution.js';
import { objectRefSchema } from '../../ontology/model.js';
import { paCheckoutRouteSchema } from '../payment-handoff.js';
import { shopCheckoutResponseSchema, shopLineItemsSchema, shopSelectedProductSchema } from './checkout-contracts.js';
import { shopifyMerchantSchema } from './contracts.js';

const id = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/), at = z.iso.datetime({ offset: true });
export const SHOPIFY_PA_PROTOCOL = 'eigos.shopify.pa-checkout.sandbox.v1';
export const SHOPIFY_PA_REF = { id: 'shopify.checkout.pa-payment.sandbox', version: '1' } as const;
export const shopifyPAInputSchema = z.strictObject({ merchantId: id, items: shopLineItemsSchema });
export const shopifyPAProductsSchema = z.strictObject({
  providerId: id, merchant: shopifyMerchantSchema, items: z.array(shopSelectedProductSchema).min(1).max(20),
  total: moneySchema, feesComplete: z.literal(true), expiresAt: at, testMode: z.literal(true),
});
export const shopifyPACheckoutSchema = z.strictObject({
  providerId: id, payeeId: id, merchant: shopifyMerchantSchema, checkout: shopCheckoutResponseSchema,
  total: moneySchema, feesComplete: z.literal(true), termsDigest: sha, expiresAt: at,
  routes: z.array(paCheckoutRouteSchema).min(1).max(2), independentRead: z.boolean(), testMode: z.literal(true),
  orderConfirmation: z.strictObject({ id, checkoutId: id, amount: moneySchema, status: z.literal('confirmed'), confirmedAt: at, test: z.literal(true) }).optional(),
});
export type ShopifyPACheckout = z.infer<typeof shopifyPACheckoutSchema>;
export const shopifyPAPaymentSchema = z.strictObject({
  providerId: id, payeeId: id, checkoutId: id, termsDigest: sha, amount: moneySchema, paidAmount: moneySchema,
  state: z.enum(['unpaid', 'processing', 'paid', 'failed', 'refunded', 'unknown']),
  paymentId: id.optional(), orderId: id.optional(), operationId: z.uuid().optional(),
  route: z.enum(['pa_vault', 'pa_payment_account']).optional(), capturedAt: at.optional(),
  independentRead: z.literal(true), testMode: z.literal(true),
});
export const shopifyPAEntitySchemas = {
  ShopifyPaymentProducts: shopifyPAProductsSchema,
  ShopifyPaymentCheckoutObservation: shopifyPACheckoutSchema,
  ShopifyCheckoutPaymentObservation: shopifyPAPaymentSchema,
};
export type ShopifyPAEntity = keyof typeof shopifyPAEntitySchemas;
export const shopifyPAContextSchema = z.strictObject({
  ownerDigest: sha, requestId: z.uuid(), requestRevision: z.number().int().positive(), action: id,
  planId: id, intentId: id, attemptId: id, modelRunId: id, operationKey: id, readbackSequence: z.number().int().nonnegative(),
});
export const shopifyPAPayloadSchema = z.strictObject({
  type: z.enum(['ShopifyPaymentProducts', 'ShopifyPaymentCheckoutObservation', 'ShopifyCheckoutPaymentObservation']),
  sourceId: id, sourceVersion: z.number().int().positive(), data: z.record(z.string(), z.unknown()), expiresAt: at,
});
export const shopifyPAReceiptSchema = shopifyPAContextSchema.extend({
  id: sha, sourceIdentity: id, method: z.enum(['GET', 'POST']), path: z.string().min(1).max(1000), status: z.literal(200),
  responseSha256: sha, payloadDigest: sha, signature: sha, startedAt: at, receivedAt: at,
});
export const shopifyPASnapshotSchema = z.strictObject({
  payload: shopifyPAPayloadSchema, receipt: shopifyPAReceiptSchema,
  scope: objectRefSchema.extend({ type: z.literal('ShopifyPaymentTask') }), configurationDigest: sha,
  dependencies: z.array(z.strictObject({ ref: objectRefSchema, contentDigest: sha })).max(3),
  evidenceLevel: z.literal('synthetic'), contentDigest: sha,
});
export type ShopifyPASnapshot = z.infer<typeof shopifyPASnapshotSchema>;
export type ShopifyPASourceResult = { payload: z.infer<typeof shopifyPAPayloadSchema>; receipt: z.infer<typeof shopifyPAReceiptSchema> };

export function shopifyPATermsDigest(data: Omit<ShopifyPACheckout, 'termsDigest'> | ShopifyPACheckout) {
  return digest({ providerId: data.providerId, payeeId: data.payeeId, merchant: data.merchant, checkoutId: data.checkout.id,
    currency: data.checkout.currency, items: data.checkout.line_items, totals: data.checkout.totals,
    continueUrl: data.checkout.continue_url, total: data.total, feesComplete: data.feesComplete,
    expiresAt: data.expiresAt, routes: data.routes, testMode: data.testMode });
}
