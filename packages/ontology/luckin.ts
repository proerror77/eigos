import { z } from 'zod';
import { json, time } from './service-contracts.js';
import { objectRefSchema, type OntologyDocument } from './schema.js';

const id = z.number().int().positive().safe();
const text = z.string().trim().min(1).max(300);
const minor = z.number().int().nonnegative().safe();
export const luckinSource = 'Luckin';
export const pickupOrderType = 'LuckinPickupOrder';
export const proofHash = z.string().regex(/^[a-f0-9]{64}$/);
export const luckinOrderId = z.string().regex(/^[0-9]{1,30}$/);
const coordinates = { latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) };
export const luckinShop = z.strictObject({
  shopId: id, name: text, address: text, ...coordinates,
  opensAt: text.optional(), closesAt: text.optional(),
});
const productKey = { shopId: id, productId: id };
const sku = z.string().trim().min(1).max(100);
export const luckinLine = z.strictObject({ productId: id, sku, quantity: z.number().int().min(1).max(20) });
export const luckinProduct = z.strictObject({
  productId: id, sku, name: text, listPriceMinor: minor.nullable(), estimatedPriceMinor: minor.nullable(),
  options: z.array(z.strictObject({
    groupId: id, name: text,
    values: z.array(z.strictObject({ optionId: id, label: text, selected: z.boolean().nullable(),
      selectable: z.boolean().nullable(), surchargeMinor: minor.nullable() })).max(80),
  })).max(30),
});
export const pickupInput = z.strictObject({
  shopId: id, items: z.array(luckinLine).min(1).max(10), currency: z.literal('CNY'),
});
export const pickupQuote = z.strictObject({
  shop: luckinShop, items: z.array(luckinLine.extend({ name: text, optionsLabel: text.nullable() })).min(1).max(10),
  totalMinor: minor, originalTotalMinor: minor, currency: z.literal('CNY'), couponDigest: proofHash,
});
export const pickupCreated = z.strictObject({
  orderId: luckinOrderId, paymentRequired: z.boolean(), totalMinor: minor.nullable(), dispatchedAt: time, quoteDigest: proofHash, currency: z.literal('CNY'),
});
export const pickupStatus = z.strictObject({
  orderId: luckinOrderId, providerStatus: z.enum(['awaiting_payment', 'placed', 'preparing', 'ready', 'completed', 'canceled']),
  pickupCode: z.string().trim().min(1).max(40).nullable(),
});
export const pickupRefInput = z.strictObject({ order: objectRefSchema });
export const pickupConfirmation = z.strictObject({
  order: objectRefSchema, quote: pickupQuote, quoteDigest: proofHash, connectionRef: proofHash, expiresAt: time,
});
export const luckinEvidence = z.strictObject({ connectionRef: proofHash, observedAt: time, evidence: z.literal('pa_reported') });
export const luckinReply = (data: z.ZodType) => z.discriminatedUnion('status', [
  luckinEvidence.extend({ status: z.literal('available'), data }),
  z.strictObject({ status: z.enum(['not_connected', 'unavailable', 'declined', 'changed', 'unknown']) }),
]);
export const luckinReads = {
  findLuckinShops: {
    capability: 'luckin.shops.read', input: z.strictObject({ ...coordinates, shopName: text.optional() }),
    result: z.array(luckinShop).max(30), description: 'Find nearby Luckin pickup stores from a supplied location. Return store IDs, exact addresses and opening hours. Ask which shop to use and use verified coordinates.',
  },
  searchLuckinProducts: {
    capability: 'luckin.products.search', input: z.strictObject({ shopId: id, query: text }),
    result: z.array(luckinProduct).max(30), description: 'Read purchasable pickup coffee and drink SKUs and their reference prices at the selected Luckin store.',
  },
  readLuckinProduct: {
    capability: 'luckin.product.read', input: z.strictObject(productKey), result: luckinProduct,
    description: 'Read available Luckin SKU options such as temperature, cup size and sweetness at the selected store.',
  },
  selectLuckinProductOption: {
    capability: 'luckin.product.option', input: z.strictObject({ ...productKey, sku, groupId: id, optionId: id }),
    result: luckinProduct, description: 'Resolve a new Luckin SKU and price using one available option read from product details.',
  },
  readLuckinPickupStatus: {
    capability: 'luckin.pickup.status', input: z.strictObject({ orderId: luckinOrderId }),
    result: pickupStatus, description: 'Read the same Luckin pickup order from the owner’s PA after payment. Return its current status and any available pickup code.',
  },
} as const;
export const luckinPreviewCapability = 'luckin.pickup.preview';
export const luckinCreateCapability = 'luckin.pickup.create';

const orderShape = {
  id: z.string(), name: text, quote: pickupQuote, quoteDigest: proofHash, connectionRef: proofHash,
  sourceTaskId: z.uuid(), observedAt: time, expiresAt: time,
  state: z.enum(['previewed', 'awaiting_payment', 'placed', 'price_changed']),
  merchantAmountMinor: minor.nullable(),
  merchantOrderId: luckinOrderId.nullable(), evidence: z.literal('pa_reported'),
};
export const pickupOrder = z.strictObject(orderShape);
const properties = Object.fromEntries(Object.entries(orderShape).map(([name, schema]) =>
  [name, { description: name, required: true, schema: json(schema) }]));
const definitions = [
  { action: 'PreviewLuckinPickup', fn: 'previewLuckinPickup', parameters: json(pickupInput), objectParameters: {},
    description: 'After the PA confirms the Luckin pickup store and SKUs with quantities, record the official preview. To place an order, use apply_action to prepare the preview and then SubmitLuckinPickup on the same task.' },
  { action: 'SubmitLuckinPickup', fn: 'submitLuckinPickup', parameters: json(pickupRefInput), objectParameters: { order: pickupOrderType },
    description: 'On the original pickup task, request the authenticated PA’s explicit approval of this exact preview and record the original Luckin merchant order. The PA handles the manual payment link.' },
];

export const luckinDefinition: Pick<OntologyDocument, 'objectTypes' | 'functionTypes' | 'actionTypes'> = {
  objectTypes: [{ apiName: pickupOrderType, displayName: '瑞幸到店自取订单',
    description: 'Supplier-backed Luckin preview, precise approved terms and, after PA confirmation, the original merchant order ID.',
    primaryKey: 'id', titleProperty: 'name', properties, interfaces: {} }],
  functionTypes: [
    ...Object.entries(luckinReads).map(([apiName, operation]) => ({
      apiName, source: luckinSource, parameters: json(operation.input),
      returns: json(luckinEvidence.extend({ data: operation.result })), dependencies: {}, description: operation.description,
    })),
    ...definitions.map(operation => ({ apiName: operation.fn, source: luckinSource, edits: true,
      parameters: operation.parameters, returns: json(objectRefSchema), dependencies: { objectTypes: [pickupOrderType] },
      description: operation.description })),
    { apiName: 'readLuckinPickup', source: luckinSource, parameters: json(pickupRefInput),
      returns: json(z.strictObject({ order: objectRefSchema, details: pickupOrder.omit({ connectionRef: true, sourceTaskId: true }) })),
      description: 'Read the recorded Luckin exact quote and original merchant order ID. Awaiting payment remains separate from paid and ready to pick up.',
      dependencies: { objectTypes: [pickupOrderType] } },
  ],
  actionTypes: definitions.map(operation => ({ apiName: operation.action, parameters: operation.parameters,
    objectParameters: operation.objectParameters as Record<string, string>, submissionCriteria: [],
    function: operation.fn, description: operation.description })),
};
