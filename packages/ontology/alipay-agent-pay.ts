import { z } from 'zod';
import { sandboxAgentCapability } from './agent-profiles.js';
import { paymentInput, preparePaymentInput } from './payments.js';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const alipayRehearsalSource = 'AlipayAgentPayRehearsal';
export const alipayOrderType = 'AlipayRehearsalOrder';
export const alipayPaymentType = 'AlipayAgentPayRehearsal';
export const alipayOrderPaymentLink = 'AlipayRehearsalOrderPayment';
export const alipayPACapability = 'payments.alipay_agent_pay.approval';

const identifier = z.string().min(1).max(180);
const orderId = z.string().regex(/^sim-[A-Za-z0-9_-]{1,100}$/);
const status = z.enum(['awaiting_payment', 'processing', 'paid', 'paid_other_method', 'expired']);
const evidence = z.literal('synthetic');
const submissionState = z.enum(['accepted', 'unknown', 'declined']);
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
  ...terms, payment: objectRefSchema, environment: evidence, termsDigest: terms.checkoutDigest,
});
export const alipayPAReply = z.strictObject({ decision: z.enum(['approve', 'decline']), termsDigest: terms.checkoutDigest });
export const alipaySubmission = z.strictObject({
  merchantOrderId: orderId, checkoutDigest: terms.checkoutDigest, evidence, state: z.literal('accepted'),
});
export const alipayPaymentResult = z.strictObject({
  payment: objectRefSchema, ...paymentFacts, transactionId: transactionId.optional(), submissionState: submissionState.optional(),
});

const properties = (shape: Record<string, z.ZodType>) => Object.fromEntries(
  Object.entries(shape).map(([name, schema]) => [name, { description: name, schema: json(schema), required: !schema.isOptional() }]),
);
const tag = { typeClasses: [sandboxAgentCapability] };
const agentPayInterface = 'AgentPay';
const paymentAction = { parameters: json(paymentInput), objectParameters: { payment: agentPayInterface }, required: true };
const operations = [
  { action: 'RegisterAlipayRehearsalOrder', fn: 'registerAlipayRehearsalOrder', input: alipayRegistrationInput,
    objectParameters: {}, description: 'Read and register an existing synthetic supplier order.' },
  { action: 'PrepareAlipayAgentPayRehearsal', fn: 'prepareAlipayAgentPayRehearsal', input: preparePaymentInput,
    objectParameters: { order: alipayOrderType }, description: 'Bind the exact amount and checkout identity to the original rehearsal task.' },
  { action: 'SubmitAlipayAgentPayRehearsal', fn: 'submitAlipayAgentPayRehearsal', input: paymentInput,
    objectParameters: { payment: alipayPaymentType }, description: 'After exact-order approval, submit one synthetic payment through the bound connector.' },
  { action: 'RefreshAlipayAgentPayRehearsal', fn: 'refreshAlipayAgentPayRehearsal', input: paymentInput,
    objectParameters: { payment: alipayPaymentType }, description: 'Read the exact supplier order and its independently observed synthetic payment.' },
];

type RehearsalDefinition = Pick<OntologyDocument, 'objectTypes' | 'interfaceTypes' | 'linkTypes' | 'actionTypes'> & {
  functionTypes: (OntologyDocument['functionTypes'][number] & { version: string })[];
};

/** Opt-in resources for a rehearsal through the existing Action runtime. */
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
      properties: properties({ id: identifier, ...paymentFacts, taskId: z.uuid(), transactionId: transactionId.optional(), submissionState: submissionState.optional() }),
      interfaces: { [agentPayInterface]: {
        properties: { status: 'status' }, links: {},
        actions: {
          submit: { action: 'SubmitAlipayAgentPayRehearsal', parameters: { payment: 'payment' } },
          refresh: { action: 'RefreshAlipayAgentPayRehearsal', parameters: { payment: 'payment' } },
        },
      } } },
  ],
  interfaceTypes: [{
    apiName: agentPayInterface,
    description: 'Submit an authorized payment through its source connector and refresh the original payment evidence.',
    properties: properties({ status }), optionalProperties: [], links: {},
    actions: { submit: paymentAction, refresh: paymentAction },
  }],
  linkTypes: [{ apiName: alipayOrderPaymentLink, description: 'One payment request for the original supplier order.',
    from: { type: alipayOrderType, name: 'payment', cardinality: 'one' },
    to: { type: alipayPaymentType, name: 'order', cardinality: 'one' } }],
  functionTypes: [
    ...operations.map(({ fn, input, description }) => ({
      apiName: fn, version: '1', description,
      parameters: json(input), returns: json(objectRefSchema), edits: true,
      ...tag, source: alipayRehearsalSource,
      dependencies: { objectTypes: [alipayOrderType, alipayPaymentType], linkTypes: [alipayOrderPaymentLink] },
    })),
    {
      apiName: 'readAlipayAgentPayRehearsal', version: '1', ...tag, source: alipayRehearsalSource,
      description: 'Return the payment submission and independently verified order status.',
      parameters: json(paymentInput), returns: json(alipayPaymentResult), dependencies: { objectTypes: [alipayPaymentType] },
    },
  ],
  actionTypes: operations.map(({ action, fn, input, objectParameters, description }) => ({
    apiName: action, description, parameters: json(input), objectParameters: { ...objectParameters } as Record<string, string>,
    function: fn, submissionCriteria: [], ...tag,
  })),
};
