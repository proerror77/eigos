import { z } from 'zod';
import { sandboxAgentCapability } from './agent-profiles.js';
import { paymentInput, paymentReply, preparePaymentInput } from './payments.js';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const alipayRehearsalSource = 'AlipayAgentPayRehearsal';
export const alipayOrderType = 'AlipayRehearsalOrder';
export const alipayPaymentType = 'AlipayAgentPayRehearsal';
export const alipayOrderPaymentLink = 'AlipayRehearsalOrderPayment';
export const alipayPACapability = 'payments.alipay_agent_pay';

const identifier = z.string().min(1).max(180);
const orderId = z.string().regex(/^sim-[A-Za-z0-9_-]{1,100}$/);
const status = z.enum(['awaiting_payment', 'processing', 'paid', 'paid_other_method', 'expired']);
const evidence = z.literal('synthetic');
const orderFacts = {
  name: identifier,
  merchant: identifier,
  merchantOrderId: orderId,
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.literal('CNY'),
};
const terms = {
  ...orderFacts,
  skuId: identifier,
  quantity: z.number().int().positive().max(100),
  checkoutDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: time,
};
const paymentFacts = { ...terms, status, observedAt: time, independentRead: z.literal(true), evidence };
const transactionId = z.string().regex(/^sim-[A-Za-z0-9_-]{1,150}$/);

export const alipayRegistrationInput = z.strictObject({ merchantOrderId: orderId });
export const alipayCheckoutTerms = z.strictObject(terms);
export const alipayOrderObservation = z.strictObject({
  ...terms, status, observedAt: time, evidence,
  transactionId: transactionId.optional(),
}).refine(order => (order.status === 'paid' || order.status === 'paid_other_method') === Boolean(order.transactionId),
  'A completed payment requires a synthetic transaction observation');
export const alipayTransactionObservation = z.strictObject({
  merchantOrderId: orderId, merchant: identifier, amountMinor: orderFacts.amountMinor, currency: orderFacts.currency,
  checkoutDigest: terms.checkoutDigest, transactionId, evidence,
});
export const alipayPARequest = z.strictObject({
  ...terms, payment: objectRefSchema, environment: evidence,
});
export const alipayPAReply = paymentReply;

const properties = (shape: Record<string, z.ZodType>) => Object.fromEntries(
  Object.entries(shape).map(([name, schema]) => [name, { description: name, schema: json(schema), required: !schema.isOptional() }]),
);
const tag = { typeClasses: [sandboxAgentCapability] };
const operations = [
  { action: 'RegisterAlipayRehearsalOrder', fn: 'registerAlipayRehearsalOrder', input: alipayRegistrationInput,
    objectParameters: {}, description: 'Read and register an existing synthetic supplier order.' },
  { action: 'PrepareAlipayAgentPayRehearsal', fn: 'prepareAlipayAgentPayRehearsal', input: preparePaymentInput,
    objectParameters: { order: alipayOrderType }, description: 'Bind the exact amount and checkout identity to the original rehearsal task.' },
  { action: 'HandoffAlipayAgentPayRehearsal', fn: 'handoffAlipayAgentPayRehearsal', input: paymentInput,
    objectParameters: { payment: alipayPaymentType }, description: 'Send a synthetic checkout request to the original PA.' },
  { action: 'RefreshAlipayAgentPayRehearsal', fn: 'refreshAlipayAgentPayRehearsal', input: paymentInput,
    objectParameters: { payment: alipayPaymentType }, description: 'Read the exact supplier order and its independently observed synthetic payment.' },
];

type RehearsalDefinition = Pick<OntologyDocument, 'objectTypes' | 'linkTypes' | 'actionTypes'> & {
  functionTypes: (OntologyDocument['functionTypes'][number] & { version: string })[];
};

/** Opt-in resources for a rehearsal through the existing Action and PA runtime. */
export const alipayAgentPayRehearsal: RehearsalDefinition = {
  objectTypes: [
    { apiName: alipayOrderType, ...tag, displayName: 'Alipay rehearsal order',
      description: 'An existing supplier order read from a synthetic order authority.',
      primaryKey: 'id', titleProperty: 'name',
      properties: properties({ id: identifier, ...terms, authorityId: identifier }),
      interfaces: {} },
    { apiName: alipayPaymentType, ...tag, displayName: 'Alipay Agent Pay rehearsal',
      description: 'One payment request linked to the exact supplier order, bound to one PA task.',
      primaryKey: 'id', titleProperty: 'name',
      properties: properties({ id: identifier, ...paymentFacts, taskId: z.uuid(), transactionId: transactionId.optional() }),
      interfaces: {} },
  ],
  linkTypes: [{ apiName: alipayOrderPaymentLink, description: 'One payment request for the original supplier order.',
    from: { type: alipayOrderType, name: 'payment', cardinality: 'one' },
    to: { type: alipayPaymentType, name: 'order', cardinality: 'one' } }],
  functionTypes: operations.map(({ fn, input, description }) => ({
    apiName: fn, version: '1', description, parameters: json(input), returns: json(objectRefSchema), edits: true,
    ...tag, source: alipayRehearsalSource,
    dependencies: { objectTypes: [alipayOrderType, alipayPaymentType], linkTypes: [alipayOrderPaymentLink] },
  })),
  actionTypes: operations.map(({ action, fn, input, objectParameters, description }) => ({
    apiName: action, description, parameters: json(input), objectParameters: { ...objectParameters } as Record<string, string>,
    function: fn, submissionCriteria: [], ...tag,
  })),
};
