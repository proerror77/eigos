import { z } from 'zod';
import type { ActionDefinition, FunctionDefinition, LinkDefinition, ObjectTypeDefinition, PropertyDefinition } from './model.js';
import { moneySchema } from './execution.js';

const text = z.string().min(1).max(500), time = z.iso.datetime({ offset: true }), sha = z.string().regex(/^[a-f0-9]{64}$/);
export const commerceItemsSchema = z.array(z.object({ id: text, lineId: text, title: text, quantity: z.number().int().min(1).max(1000), unitPrice: moneySchema }).strict()).min(1).max(20);
export const commerceReceiptSchema = z.object({ id: text, method: z.string(), path: text, startedAt: time, receivedAt: time, status: z.number().int(), inputDigest: sha, responseSha256: sha, environment: z.literal('sandbox'), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional() }).strict();
export const commerceSnapshotSchema = z.object({
  environment: z.literal('sandbox'), merchantId: text, merchantOrigin: z.url(), protocolVersion: z.literal('2026-04-08'),
  requestId: text, requestRevision: z.number().int().positive(), preparationTaskId: text,
  operation: z.enum(['prepare', 'confirm']), inputDigest: sha, configurationDigest: sha,
  expectedItems: z.array(z.object({ id: text, quantity: z.number().int().min(1).max(1000) }).strict()).min(1).max(20),
  budget: moneySchema.optional(),
  checkout: z.object({ id: text, state: z.enum(['incomplete', 'requires_escalation', 'ready_for_complete', 'complete_in_progress', 'completed', 'canceled']), items: commerceItemsSchema, total: moneySchema, quoteDigest: sha, fulfillmentDigest: sha, buyerDigest: sha, destinationDigest: sha.optional(), expiresAt: time.optional(), continueUrl: z.url().optional(), orderId: text.optional(), messageCodes: z.array(z.string().max(200)).max(30), receipt: commerceReceiptSchema }).strict(),
  order: z.object({ id: text, checkoutId: text, items: commerceItemsSchema, total: moneySchema, permalinkUrl: z.url(),
    fulfillment: z.enum(['pending', 'partial', 'delivered', 'failed', 'unknown']),
    events: z.array(z.object({ id: text, type: text, occurredAt: time, allocations: z.array(z.object({ lineId: text, itemId: text, quantity: z.number().int().nonnegative().max(1000) }).strict()).max(20) }).strict()).max(100),
    destinationDigest: sha.optional(), adjustmentCount: z.number().int().nonnegative(), receipt: commerceReceiptSchema,
  }).strict().optional(),
}).strict();
export type CommerceSnapshot = z.infer<typeof commerceSnapshotSchema>;
export interface CommerceAssessment { status: 'satisfied' | 'unsatisfied' | 'unknown'; criteria: { id: string; result: 'pass' | 'fail' | 'unknown'; reason: string }[]; endpoint: 'checkout_prepared' | 'order_confirmed' }
export function assessCommerce(snapshot: CommerceSnapshot, now = Date.now()): CommerceAssessment {
  const checks: CommerceAssessment['criteria'] = [], expected = [...snapshot.expectedItems].sort((a, b) => a.id.localeCompare(b.id));
  const match = (actual: typeof snapshot.checkout.items) => {
    const items = actual.map(i => ({ id: i.id, quantity: i.quantity })).sort((a, b) => a.id.localeCompare(b.id));
    return JSON.stringify(items) === JSON.stringify(expected);
  };
  checks.push({ id: 'checkout_items', result: match(snapshot.checkout.items) ? 'pass' : 'fail', reason: 'The merchant must return the exact requested item identities and quantities' });
  checks.push({ id: 'business_errors', result: snapshot.checkout.messageCodes.length ? 'unknown' : 'pass', reason: 'Business error messages require resolution; HTTP success alone is insufficient' });
  if (snapshot.operation === 'prepare') checks.push({ id: 'checkout_exists', result: ['incomplete', 'requires_escalation', 'ready_for_complete'].includes(snapshot.checkout.state) ? 'pass' : 'fail', reason: 'Preparing a checkout does not place an order or prove delivery' });
  else {
    checks.push({ id: 'checkout_completed', result: snapshot.checkout.state === 'completed' ? 'pass' : snapshot.checkout.state === 'canceled' ? 'fail' : 'unknown', reason: 'An accepted completion can remain asynchronous' });
    checks.push({ id: 'same_order', result: !snapshot.order ? 'unknown' : snapshot.order.id === snapshot.checkout.orderId && snapshot.order.checkoutId === snapshot.checkout.id ? 'pass' : 'fail', reason: 'Read the original order independently and bind it to the original checkout' });
    checks.push({ id: 'order_items', result: !snapshot.order ? 'unknown' : match(snapshot.order.items) ? 'pass' : 'fail', reason: 'Final order items must preserve the requested identities and quantities' });
    checks.push({ id: 'order_total', result: !snapshot.order ? 'unknown' : snapshot.order.total.currency === snapshot.checkout.total.currency && snapshot.order.total.minor === snapshot.checkout.total.minor ? 'pass' : 'fail', reason: 'The final order total must match the approved checkout total' });
    checks.push({ id: 'order_destination', result: !snapshot.order?.destinationDigest || !snapshot.checkout.destinationDigest ? 'unknown' : snapshot.order.destinationDigest === snapshot.checkout.destinationDigest ? 'pass' : 'fail', reason: 'Every ordered item must retain the selected shipping destination' });
    checks.push({ id: 'post_purchase_changes', result: !snapshot.order || snapshot.order.adjustmentCount ? 'unknown' : 'pass', reason: 'Returns, cancellation, refunds and edits need their own semantics and must not be silently ignored' });
  }
  if (snapshot.operation === 'prepare' && snapshot.checkout.expiresAt) checks.push({ id: 'session_validity', result: Date.parse(snapshot.checkout.expiresAt) > now ? 'pass' : 'fail', reason: 'An expired checkout is not a usable prepared session' });
  if (snapshot.budget) {
    const actual = snapshot.order?.total ?? snapshot.checkout.total;
    checks.push({ id: 'budget', result: actual.currency === snapshot.budget.currency && BigInt(actual.minor) <= BigInt(snapshot.budget.minor) ? 'pass' : 'fail', reason: 'All charges use the merchant total and the explicitly fixed currency' });
  }
  return { status: checks.some(c => c.result === 'fail') ? 'unsatisfied' : checks.some(c => c.result === 'unknown') ? 'unknown' : 'satisfied', criteria: checks, endpoint: snapshot.operation === 'prepare' ? 'checkout_prepared' : 'order_confirmed' };
}

const property = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string, required = false): PropertyDefinition => ({ kind, schema, description, required, source: 'Owner-bound UCP checkout request or validated HTTP observation; sandbox evidence only' });
const definition = (id: string, name: string, fields: Record<string, PropertyDefinition>): ObjectTypeDefinition => ({ id, version: '1', name, aliases: [id, name], description: name, primaryKey: 'id', titleKey: 'displayTitle', properties: { id: property('string', text, 'Namespaced object identity', true), displayTitle: property('string', text, 'Human-readable title', true), ...fields } });
export const commerceObjects = [
  definition('CheckoutRequest', '结账要求', { requestRevision: property('integer', z.number().int().positive(), 'Fixed EIGOS request revision', true), operation: property('string', z.enum(['prepare', 'confirm']), 'Prepare a session or confirm the exact order', true), expectedItems: property('array', commerceSnapshotSchema.shape.expectedItems, 'Requested product identities and integer quantities', true), preparationTaskId: property('string', text, 'Original owned checkout preparation task', true), budget: property('struct', moneySchema, 'Maximum total in explicit minor units') }),
  { ...definition('CheckoutSession', '结账会话', { merchantId: property('string', text, 'Configured merchant namespace', true), merchantOrigin: property('string', z.url(), 'Pinned local test merchant origin', true), providerCheckoutId: property('string', text, 'Business-issued checkout reference', true), protocolVersion: property('string', z.literal('2026-04-08'), 'Negotiated UCP schema version', true), state: property('string', commerceSnapshotSchema.shape.checkout.shape.state, 'Checkout state, separate from payment and fulfillment', true), items: property('array', commerceItemsSchema, 'Merchant-returned product identities, counts and unit prices', true), total: property('struct', moneySchema, 'Complete merchant checkout total', true), quoteDigest: property('string', sha, 'Fixed items, total, selected fulfillment, buyer and terms fingerprint', true), sourceStartedAt: property('timestamp', time, 'Local start of the authenticated source read; not a merchant version', true), snapshot: property('struct', commerceSnapshotSchema, 'Sanitized source snapshot used by independent functions', true) }), interfaces: [{ id: 'EvidenceBacked' }] },
];
const link = (id: string, from: string, name: string, to: string, inverse: string, many = false, required = true): LinkDefinition => ({ id, description: `${from}.${name} ↔ ${to}.${inverse}`, from: { type: from, name, many, required }, to: { type: to, name: inverse, many: true } });
export const commerceLinks = [
  link('CheckoutRequestTask', 'CheckoutRequest', 'request', 'ServiceRequest', 'checkoutRequirements'),
  link('CheckoutRequestSession', 'CheckoutRequest', 'session', 'CheckoutSession', 'requirements', false, false),
  link('CheckoutSessionTask', 'CheckoutSession', 'preparationRequest', 'ServiceRequest', 'preparedCheckouts'),
  link('RequestCheckoutSession', 'ServiceRequest', 'checkoutSessions', 'CheckoutSession', 'usedByRequests', true, false),
  link('CheckoutSessionEvidence', 'CheckoutSession', 'sourceReceipts', 'SourceReceipt', 'checkoutSessions', true),
  link('OrderCheckout', 'Order', 'checkout', 'CheckoutSession', 'orders', false, false),
  link('CheckoutSessionVariants', 'CheckoutSession', 'variants', 'ProductVariant', 'checkoutSessions', true, false),
  link('ProductVariantCurrentCommerceReceipt', 'ProductVariant', 'currentCommerceReceipt', 'SourceReceipt', 'currentCommerceVariants', false, false),
  link('OrderLineAgreementReceipt', 'OrderLine', 'agreementReceipt', 'SourceReceipt', 'agreedOrderLines', false, false),
];
export const commerceFunctions: FunctionDefinition[] = [
  { id: 'checkoutReadiness', version: '1', inputTypes: ['CheckoutSession'], description: 'Source-backed readiness of this checkout; a prepared session does not prove purchase, payment or delivery' },
  { id: 'commerceOrderOutcome', version: '1', inputTypes: ['CheckoutSession'], description: 'Compare the independently read original order with fixed checkout items, total and budget; order confirmation is not fulfillment' },
];
export const commerceActions: ActionDefinition[] = [
  { id: 'PrepareCheckout', version: '1', kind: 'business', effects: ['reserve'], resultTypes: ['CheckoutSession'], description: 'Prepare a local test checkout session; no order or payment. Requires a separate sandbox dispatch permit.', inputs: { request: 'ServiceRequest', requirements: 'CheckoutRequest' }, changes: ['CheckoutRequest', 'CheckoutSession', 'ProductVariant', 'SourceReceipt', 'ServiceRequest.progress'], submissionCriteria: ['same_owner', 'current_request_revision', 'current_requirements', 'within_authority'], providerOperation: 'ucp.checkout.create' },
  { id: 'CompleteCheckout', version: '1', kind: 'business', effects: ['order', 'payment'], resultTypes: ['Order', 'CheckoutSession'], description: 'Confirm the exact local test checkout. Both order and payment effects require authorization; this proposal never grants it.', inputs: { request: 'ServiceRequest', requirements: 'CheckoutRequest', checkout: 'CheckoutSession' }, changes: ['CheckoutRequest', 'CheckoutSession', 'ProductVariant', 'Order', 'OrderLine', 'SourceReceipt', 'ServiceRequest.progress'], submissionCriteria: ['same_owner', 'current_request_revision', 'current_requirements', 'checkout_ready', 'within_authority'], providerOperation: 'ucp.checkout.complete' },
];
