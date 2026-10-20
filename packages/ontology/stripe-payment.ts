import { z } from 'zod';
import { moneySchema } from './execution.js';
import { objectRefSchema, type ActionDefinition, type FunctionDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';

const id = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/), instant = z.iso.datetime({ offset: true });
const scope = objectRefSchema.extend({ type: z.literal('CommerceTask') });
const order = objectRefSchema.extend({ type: z.literal('CommerceOrderObservation') });
const payment = objectRefSchema.extend({ type: z.literal('StripePaymentObservation') });
export const stripePaymentActionSchemas = {
  PrepareStripePayment: z.strictObject({ scope, order }),
  PayStripePayment: z.strictObject({ scope, order, payment }),
  ReadStripePayment: z.strictObject({ scope, order, payment }),
};
export type StripePaymentAction = keyof typeof stripePaymentActionSchemas;
export const stripeActionMetadata = {
  PrepareStripePayment: { effect: 'change', description: 'Create one unconfirmed Stripe test PaymentIntent for the independently read unpaid sandbox order. Needs an exact zero-cost change permit; no charge occurs.' },
  PayStripePayment: { effect: 'payment', description: 'Confirm the original PaymentIntent using a scope-limited shared payment token from the Stripe sandbox test helper. Needs an exact payment permit bound to the order, amount and configured account. No live key or user wallet is supported.' },
  ReadStripePayment: { effect: 'read', description: 'Independently GET the original Stripe test PaymentIntent and expanded charge. Verify account, order binding, amount, currency, capture and refunds; never infer settlement or fulfillment.' },
} as const;
export const stripePaymentDataSchema = z.strictObject({
  paymentIntentId: z.string().regex(/^pi_[a-zA-Z0-9]{1,150}$/), accountId: z.string().regex(/^acct_[a-zA-Z0-9]{1,100}$/),
  merchantId: id, orderId: id, orderDigest: sha, bindingDigest: sha, prepareOperationDigest: sha,
  amount: moneySchema, amountReceived: z.string().regex(/^\d+$/),
  status: z.enum(['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture', 'canceled', 'succeeded']),
  captureMethod: z.literal('automatic'), livemode: z.literal(false), hasPaymentError: z.boolean(),
  charge: z.strictObject({ id: z.string().regex(/^ch_[a-zA-Z0-9]{1,150}$/), paymentIntentId: z.string(), amount: moneySchema, paid: z.boolean(), captured: z.boolean(), refunded: z.boolean(), amountRefunded: z.string().regex(/^\d+$/), disputed: z.boolean(), livemode: z.literal(false) }).nullable(),
  independentRead: z.boolean(), tokenSource: z.literal('stripe_test_helper'),
});
export type StripePaymentData = z.infer<typeof stripePaymentDataSchema>;
export const stripeHttpReceiptSchema = z.strictObject({ method: z.enum(['GET', 'POST']), path: z.string().min(1).max(250), status: z.number().int().min(200).max(299), requestId: z.string().regex(/^req_[A-Za-z0-9]{1,150}$/), startedAt: instant, receivedAt: instant, responseSha256: sha });
export const stripePaymentObservationSchema = z.strictObject({
  requestId: id, requestRevision: z.number().int().positive(), ownerDigest: sha, scope, configurationDigest: sha,
  action: z.enum(['PrepareStripePayment', 'PayStripePayment', 'ReadStripePayment']), order, orderContentDigest: sha,
  planId: id, intentId: id, attemptId: id, modelRunId: id, operationKey: id,
  data: stripePaymentDataSchema, receipts: z.array(stripeHttpReceiptSchema).min(2).max(6),
  observedAt: instant, expiresAt: instant, evidenceLevel: z.enum(['synthetic', 'provider_test']), contentDigest: sha,
});
export type StripePaymentObservation = z.infer<typeof stripePaymentObservationSchema>;
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Owner-bound Stripe test API read; injected transports remain synthetic' });
export const stripePaymentObjects: ObjectTypeDefinition[] = [{ id: 'StripePaymentObservation', version: '1', name: 'Stripe 测试支付观测', aliases: ['Stripe', 'Agentic payment'], description: 'One private-credential-free observation of a test PaymentIntent, its fixed sandbox order and capture evidence. Not settlement, live payment or merchant fulfillment.', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: { id: p('string', id, 'Immutable observation identity'), displayTitle: p('string', id, 'Observation label'), requestRevision: p('integer', z.number().int().positive(), 'Owning request revision'), data: p('struct', stripePaymentDataSchema, 'Normalized test payment status without credentials'), snapshot: p('struct', stripePaymentObservationSchema, 'Immutable task, model, operation and HTTP provenance') } }];
export const stripePaymentLinks: LinkDefinition[] = [
  { id: 'StripePaymentRequest', description: 'Payment evidence is restricted to its request', from: { type: 'StripePaymentObservation', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'stripePayments', many: true } },
  { id: 'StripePaymentScope', description: 'Exact configured commerce scope', from: { type: 'StripePaymentObservation', name: 'scope', many: false, required: true }, to: { type: 'CommerceTask', name: 'stripePayments', many: true } },
  { id: 'StripePaymentOrder', description: 'Independently read fixed unpaid order', from: { type: 'StripePaymentObservation', name: 'order', many: false, required: true }, to: { type: 'CommerceOrderObservation', name: 'stripePayments', many: true } },
  { id: 'StripePaymentEvidence', description: 'Receipt seals normalized facts and relationships', from: { type: 'StripePaymentObservation', name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: 'stripePayments', many: true } },
];
export const stripePaymentActions: ActionDefinition[] = Object.entries(stripePaymentActionSchemas).map(([id, schema]) => {
  const m = stripeActionMetadata[id as StripePaymentAction];
  return { id, description: m.description, inputs: { scope: 'CommerceTask' }, changes: ['StripePaymentObservation'], submissionCriteria: ['same_owner', 'current_request_revision', 'independent_unpaid_order', 'configured_stripe_test_account', 'exact_order_amount_currency', ...(m.effect === 'read' ? [] : ['exact_plan_authority', 'model_evaluated_payment_inputs'])], ...(m.effect === 'read' ? { read: { version: '1', effect: 'read', inputSchema: z.toJSONSchema(schema), resultType: 'StripePaymentObservation' } } : { operation: { version: '1', effect: m.effect, environment: 'sandbox', inputSchema: z.toJSONSchema(schema), resultType: 'StripePaymentObservation' } }) };
});
export const stripePaymentFunctions: FunctionDefinition[] = [{ id: 'stripePaymentStatus', version: '1', inputTypes: ['StripePaymentObservation'], description: 'Check original-order identity, account, freshness, evidence strength and test capture. Only an independent succeeded GET with exact captured charge establishes test_paid; not bank settlement.' }];
