import { z } from 'zod';
import { deliveryMerchantId } from './local-delivery.js';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

const text = z.string().trim().min(1).max(500);
const label = text.max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const cents = z.number().int().nonnegative().safe();
const positiveCents = cents.positive();
const count = z.number().int().min(1).max(100);
const units = z.number().positive().finite();
const nativeId = z.string().regex(/^\d{1,40}$/);
export const tradeChannel = z.enum(['taobao_meal', 'taobao_retail', 'hema']);
export const deliveryScope = z.strictObject({
  channel: tradeChannel, merchantId: deliveryMerchantId.optional(),
});
export const deliveryItemInput = deliveryScope.extend({
  itemId: deliveryMerchantId, query: label.max(100).optional(),
});
export const deliveryCartChange = deliveryScope.extend({
  itemId: deliveryMerchantId.optional(),
  query: label.max(100).optional(),
  quantity: count.optional(),
  variantRef: z.string().max(80).optional(),
  choiceRefs: z.array(digest).max(30).optional(),
  removeLine: digest.optional(),
  cartRevision: digest,
});
export const deliveryPreviewInput = deliveryScope.extend({
  cartRevision: digest,
  maxAmountMinor: positiveCents,
  lineIds: z.array(nativeId).min(1).max(50).optional(),
  retailDelivery: z.enum(['platform', 'earliest']).optional(),
});
export const deliveryCheckoutInput = z.strictObject({ checkout: objectRefSchema });
export const deliveryWindowInput = deliveryCheckoutInput.extend({ optionIndex: z.number().int().nonnegative().max(49) });
export const deliveryChannelInput = z.strictObject({ channel: tradeChannel });

const evidence = z.enum(['live_readonly', 'provider_mock']);
export const deliveryLine = z.strictObject({
  lineId: z.string().min(1).max(160).nullable(),
  name: text,
  specification: z.string().max(500).nullable(),
  quantity: units,
  unitPriceMinor: cents.nullable(),
  lineTotalMinor: cents.nullable(),
});
export const deliveryCartReport = z.strictObject({
  channel: tradeChannel, merchantId: deliveryMerchantId.nullable(), revision: digest,
  currency: z.literal('CNY'), items: z.array(deliveryLine.extend({ selected: z.boolean(), available: z.boolean() })).max(500),
  observedAt: time, evidence,
});
const choice = z.strictObject({ ref: digest, name: text, amountMinor: cents, available: z.boolean() });
export const deliveryItemReport = z.strictObject({
  channel: tradeChannel, merchantId: deliveryMerchantId, itemId: deliveryMerchantId, name: text,
  minimumQuantity: units,
  variants: z.array(z.strictObject({
    ref: z.string().min(1).max(80), name: text, listedPriceMinor: cents.nullable(), stockQuantity: z.number().nonnegative().nullable(),
    available: z.boolean(), groups: z.array(z.strictObject({
      name: text, minimum: z.number().int().nonnegative(), maximum: z.number().int().nonnegative(), choices: z.array(choice).max(100),
    })).max(50),
  })).max(100),
  currency: z.literal('CNY'),
});
export const deliveryHistoryEntry = z.strictObject({
  id: nativeId, status: text, merchant: text, amountMinor: cents.nullable(),
});
export const deliveryHistoryReport = z.strictObject({
  channel: tradeChannel, orders: z.array(deliveryHistoryEntry).max(20), complete: z.boolean(), observedAt: time, evidence,
});
const identity = { id: digest, name: text, channel: tradeChannel, bindingId: digest, observedAt: time,
  evidence: z.enum(['provider', 'provider_mock']) };

export const deliveryCartChangeType = 'LocalDeliveryCartChange';
export const deliveryCartChangeRecord = z.strictObject({
  ...identity, operationRef: z.uuid(),
  state: z.enum(['changed', 'declined', 'unknown']),
  cart: deliveryCartReport.nullable(),
});
const cartChangeRead = deliveryCartChangeRecord.omit({ bindingId: true, operationRef: true }).extend({ change: objectRefSchema });
const readCartChange = z.strictObject({ change: objectRefSchema });

export const deliveryCheckoutType = 'LocalDeliveryCheckout';
export const deliveryCheckoutRecord = z.strictObject({
  ...identity,
  sourceTaskId: z.uuid().nullable(),
  scope: deliveryScope,
  addressDigest: digest,
  version: digest,
  quoteRef: z.uuid(),
  expiresAt: time,
  maxAmountMinor: positiveCents,
  totalMinor: positiveCents,
  currency: z.literal('CNY'),
  items: z.array(deliveryLine).min(1).max(500),
  fees: z.array(z.strictObject({ name: text, amountMinor: cents })).max(50),
  discountMinor: cents.nullable(),
  deliveryTime: z.string().max(500).nullable(),
  requiresDeliveryChoice: z.boolean(),
  windows: z.array(z.strictObject({ source: z.uuid(), label: text, feeMinor: cents, selected: z.boolean() })).max(50),
  state: z.enum(['quoted', 'declined', 'order_unknown', 'awaiting_payment', 'payment_handoff',
    'payment_unknown', 'payment_verification', 'payment_failed', 'paid']),
  orderIds: z.array(nativeId).max(50),
  supplierOrders: z.array(deliveryHistoryEntry).max(50),
});
const checkoutRead = deliveryCheckoutRecord.omit({ bindingId: true, sourceTaskId: true, addressDigest: true, version: true,
  quoteRef: true, windows: true }).extend({
  checkout: objectRefSchema,
  windows: z.array(z.strictObject({ index: z.number().int().nonnegative(), label: text, feeMinor: cents, selected: z.boolean() })).max(50),
  paymentEntry: z.enum(['taobao_private_checkout', 'hema_official_app']).nullable(),
});

export const deliveryApproval = z.strictObject({ decision: z.enum(['approve', 'decline']), termsDigest: digest });
type Definition = Pick<OntologyDocument, 'objectTypes' | 'interfaceTypes' | 'functionTypes' | 'actionTypes'>;
function object(apiName: string, description: string, shape: Record<string, z.ZodType>): Definition['objectTypes'][number] {
  return { apiName, displayName: apiName, description, primaryKey: 'id', titleProperty: 'name', interfaces: {},
    properties: Object.fromEntries(Object.entries(shape).map(([name, schema]) => [name, { description: name, required: true, schema: json(schema) }])),
  };
}

const operations = [
  { alias: 'change', action: 'ChangeLocalDeliveryCart', fn: 'changeLocalDeliveryCart', input: deliveryCartChange, type: deliveryCartChangeType,
    description: 'Change the bound cart after exact cart terms are approved on the original PA task. Supports meal add and remove, simple retail add, and Hema SKU add.' },
  { alias: 'preview', action: 'PreviewLocalDeliveryCheckout', fn: 'previewLocalDeliveryCheckout', input: deliveryPreviewInput, type: deliveryCheckoutType,
    description: 'Read the original cart revision and obtain a time-bounded checkout quote with items and CNY amount.' },
  { alias: 'selectWindow', action: 'SelectLocalDeliveryWindow', fn: 'selectLocalDeliveryWindow', input: deliveryWindowInput, type: deliveryCheckoutType,
    description: 'Reprice a Hema quote for a selected delivery window from that quote.' },
  { alias: 'submit', action: 'SubmitLocalDeliveryOrder', fn: 'submitLocalDeliveryOrder', input: deliveryCheckoutInput, type: deliveryCheckoutType,
    description: 'Create the order once after the original PA confirms the exact checkout amount and delivery terms.' },
  { alias: 'preparePayment', action: 'PrepareLocalDeliveryPayment', fn: 'prepareLocalDeliveryPayment', input: deliveryCheckoutInput, type: deliveryCheckoutType,
    description: 'Verify the original order and direct the buyer to its official or private payment interface.' },
  { alias: 'pay', action: 'PayTaobaoInstantDeliveryOrder', fn: 'payTaobaoInstantDeliveryOrder', input: deliveryCheckoutInput, type: deliveryCheckoutType,
    description: 'Submit the exact Taobao order amount once after independent PA payment approval and provider payment readiness.' },
  { alias: 'refresh', action: 'RefreshLocalDeliveryOrder', fn: 'refreshLocalDeliveryOrder', input: deliveryCheckoutInput, type: deliveryCheckoutType,
    description: 'Reconcile the original order and payment from provider evidence without dispatching a new transaction.' },
] as const;

const tradeTypes = [
  { type: deliveryCartChangeType, contract: 'DeliveryCartEditing', fields: deliveryCartChangeRecord.shape,
    description: 'An approved, declined or uncertain change to the connected account cart.' },
  { type: deliveryCheckoutType, contract: 'DeliveryOrdering', fields: deliveryCheckoutRecord.shape,
    description: 'A provider checkout quote and the lifecycle of its original delivery order.' },
] as const;

export const localDeliveryTradeDefinition: Definition = {
  objectTypes: tradeTypes.map(({ type, contract, fields, description }) => ({
    ...object(type, description, fields),
    interfaces: { [contract]: {
      properties: { name: 'name' }, links: {},
      actions: Object.fromEntries(operations.filter(op => op.type === type).map(op => [op.alias, {
        action: op.action, parameters: Object.fromEntries(Object.keys(op.input.shape).map(name => [name, name])),
      }])),
    } },
  })),
  interfaceTypes: tradeTypes.map(({ type, contract, description }) => ({
    apiName: contract, description, properties: { name: { description: 'Delivery record name', required: true, schema: json(text) } },
    optionalProperties: [], links: {},
    actions: Object.fromEntries(operations.filter(op => op.type === type).map(op => {
      const objectParameters: Record<string, string> = 'checkout' in op.input.shape ? { checkout: contract } : {};
      return [op.alias, { parameters: json(op.input), objectParameters, required: true }];
    })),
  })),
  actionTypes: operations.map((op): Definition["actionTypes"][number] => ({
    apiName: op.action, description: op.description, parameters: json(op.input),
    objectParameters: 'checkout' in op.input.shape ? { checkout: deliveryCheckoutType } : {},
    function: op.fn, submissionCriteria: [],
  })),
  functionTypes: [
    { apiName: 'readLocalDeliveryCart', description: 'Read the bound cart revision, selection and prices.', parameters: json(deliveryScope),
      returns: json(deliveryCartReport), dependencies: {} },
    { apiName: 'readLocalDeliveryItemOptions', description: 'Read current product variants and meal options for a delivery store and item.',
      parameters: json(deliveryItemInput), returns: json(deliveryItemReport), dependencies: {} },
    { apiName: 'readLocalDeliveryRecentOrders', description: 'Read the bound account’s first page of recent official orders.',
      parameters: json(deliveryChannelInput), returns: json(deliveryHistoryReport), dependencies: {} },
    { apiName: 'readLocalDeliveryCartChange', description: 'Read the result of an approved or unresolved cart change.',
      parameters: json(readCartChange), returns: json(cartChangeRead), dependencies: { objectTypes: [deliveryCartChangeType] } },
    { apiName: 'readLocalDeliveryCheckout', description: 'Read the quote, original order and independent payment status kept in the Ontology.',
      parameters: json(deliveryCheckoutInput), returns: json(checkoutRead), dependencies: { objectTypes: [deliveryCheckoutType] } },
    ...operations.map(op => ({
      apiName: op.fn, description: op.description, parameters: json(op.input), returns: json(objectRefSchema),
      edits: true, dependencies: { objectTypes: [op.type] },
    })),
  ],
};
