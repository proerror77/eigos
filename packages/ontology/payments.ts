import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const stripeSandboxSource = 'StripeSandbox';
export const sandboxOrderType = 'StripeSandboxOrder';
export const stripePaymentType = 'StripeLinkPaymentRequest';
export const createSandboxOrderInput = z.strictObject({ orderKey: z.uuid() });
export const recoverSandboxOrderInput = z.strictObject({
  merchantOrderId: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string().regex(/^cs_test_[A-Za-z0-9]+$/),
});
export const preparePaymentInput = z.strictObject({ order: objectRefSchema });
export const paymentInput = z.strictObject({ payment: objectRefSchema });
export const paymentReply = z.strictObject({ decision: z.enum(['check_status', 'leave_unpaid']) });

const money = {
  amountMinor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
};
const orderFacts = {
  name: z.string(),
  merchant: z.string(),
  merchantOrderId: z.string(),
  ...money,
};
const paymentFacts = {
  ...orderFacts,
  status: z.enum(['awaiting_payment', 'processing', 'paid', 'paid_other_method', 'expired']),
  expiresAt: time,
  observedAt: time,
  independentRead: z.boolean(),
  evidence: z.enum(['provider_sandbox', 'synthetic']),
};
const properties = (shape: Record<string, z.ZodType>) =>
  Object.fromEntries(Object.entries(shape).map(([name, schema]) => [
    name, { description: name, required: !schema.isOptional(), schema: json(schema) },
  ]));
const propertyMap = (shape: Record<string, z.ZodType>) =>
  Object.fromEntries(Object.keys(shape).map(name => [name, name]));

const prepare = { parameters: json(preparePaymentInput), objectParameters: { order: 'PayableOrder' }, required: true };
const paymentAction = { parameters: json(paymentInput), objectParameters: { payment: 'ManualPayment' }, required: true };
const operations: Array<{ action: string; fn: string; input: z.ZodType; objects: Record<string, string>; description: string }> = [
  { action: 'CreateStripeSandboxOrder', fn: 'createStripeSandboxOrder', input: createSandboxOrderInput,
    objects: {}, description: 'Create a fixed-price order at the configured Stripe sandbox merchant. Explicit PA invocation only.' },
  { action: 'RecoverStripeSandboxOrder', fn: 'recoverStripeSandboxOrder', input: recoverSandboxOrderInput,
    objects: {}, description: 'Read back a known Stripe sandbox session after an unresolved order creation. Explicit PA invocation only.' },
  { action: 'PrepareStripeLinkPayment', fn: 'prepareStripeLinkPayment', input: preparePaymentInput,
    objects: { order: sandboxOrderType }, description: 'Register the original sandbox checkout as a pending manual payment.' },
  { action: 'HandoffStripeLinkPayment', fn: 'handoffStripeLinkPayment', input: paymentInput,
    objects: { payment: stripePaymentType }, description: 'Send the original Stripe sandbox checkout to the authenticated PA on the current task.' },
  { action: 'RefreshStripeLinkPayment', fn: 'refreshStripeLinkPayment', input: paymentInput,
    objects: { payment: stripePaymentType }, description: 'Independently read the original sandbox checkout and verify how it was paid.' },
];

export const paymentsDefinition: OntologyDocument = {
  id: 'EigosPayments',
  version: '1',
  objectTypes: [
    {
      apiName: sandboxOrderType, displayName: 'Stripe sandbox order',
      description: 'Original fixed-price test merchant order and its Stripe checkout identity.',
      primaryKey: 'id', titleProperty: 'name',
      properties: properties({ id: z.string(), ...orderFacts, sessionId: z.string(), authorityId: z.string() }),
      interfaces: { PayableOrder: {
        properties: propertyMap(orderFacts), links: { payment: 'payment' },
        actions: { prepare: { action: 'PrepareStripeLinkPayment', parameters: { order: 'order' } } },
      } },
    },
    {
      apiName: stripePaymentType, displayName: 'Stripe Link payment request',
      description: 'A sandbox payment request for a human payer, with independently read payment evidence.',
      primaryKey: 'id', titleProperty: 'name',
      properties: properties({ id: z.string(), ...paymentFacts, transactionId: z.string().optional() }),
      interfaces: { ManualPayment: {
        properties: propertyMap(paymentFacts), links: { order: 'order' },
        actions: {
          handoff: { action: 'HandoffStripeLinkPayment', parameters: { payment: 'payment' } },
          refresh: { action: 'RefreshStripeLinkPayment', parameters: { payment: 'payment' } },
        },
      } },
    },
  ],
  interfaceTypes: [
    { apiName: 'PayableOrder', description: 'A merchant order with a supported manual payment handoff.',
      properties: properties(orderFacts), optionalProperties: [],
      links: { payment: { target: 'ManualPayment', cardinality: 'one', required: true } },
      actions: { prepare },
    },
    { apiName: 'ManualPayment', description: 'Hand a merchant payment request to the user and read the original payment status.',
      properties: properties(paymentFacts), optionalProperties: [],
      links: { order: { target: 'PayableOrder', cardinality: 'one', required: true } },
      actions: { handoff: paymentAction, refresh: paymentAction },
    },
  ],
  linkTypes: [{
    apiName: 'SandboxOrderPayment', description: 'The one manual payment request for the original sandbox order.',
    from: { type: sandboxOrderType, name: 'payment', cardinality: 'one' },
    to: { type: stripePaymentType, name: 'order', cardinality: 'one' },
  }],
  functionTypes: operations.map(({ fn, input, description }) => ({
    apiName: fn, description, parameters: json(input), returns: json(objectRefSchema),
    source: stripeSandboxSource, edits: true,
    dependencies: { objectTypes: [sandboxOrderType, stripePaymentType], linkTypes: ['SandboxOrderPayment'] },
  })),
  actionTypes: operations.map(({ action, fn, input, objects, description }) => ({
    apiName: action, description, parameters: json(input), objectParameters: objects,
    submissionCriteria: [], function: fn,
  })),
  dataSources: [],
};
