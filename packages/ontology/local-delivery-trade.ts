import { deliveryAddressNames, deliveryAddressType } from './delivery-addresses.js';
import { personalPlaceVersionType } from './personal-places.js';
import { z } from 'zod';
import { deliveryMerchantId, localDeliveryProviders, localDeliveryServices, type LocalDeliveryProvider } from './local-delivery.js';
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
  search: objectRefSchema.optional(),
  cartRevision: digest,
});
export const deliveryPreviewInput = deliveryScope.extend({
  cartRevision: digest,
  maxAmountMinor: positiveCents,
  lineIds: z.array(nativeId).min(1).max(50).optional(),
  retailDelivery: z.enum(['platform', 'earliest']).optional(),
  cartChange: objectRefSchema.optional(),
});
export const deliveryCheckoutInput = z.strictObject({ checkout: objectRefSchema });
export const deliveryWindowInput = deliveryCheckoutInput.extend({ optionIndex: z.number().int().nonnegative().max(49) });


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
  provider: z.enum(localDeliveryProviders), orders: z.array(deliveryHistoryEntry).max(20), complete: z.boolean(), observedAt: time, evidence,
});
const identity = { id: digest, name: text, channel: tradeChannel, bindingId: digest, observedAt: time,
  evidence: z.enum(['provider', 'provider_mock']) };

export const deliveryCartChangeRecord = z.strictObject({
  ...identity, operationRef: z.uuid(), deliveryAddressKey: digest.optional(),
  state: z.enum(['changed', 'declined', 'unknown']),
  cart: deliveryCartReport.nullable(),
});
const cartChangeRead = deliveryCartChangeRecord.omit({ bindingId: true, operationRef: true, deliveryAddressKey: true }).extend({ change: objectRefSchema });
const readCartChange = z.strictObject({ change: objectRefSchema });

export const deliveryFulfillment = z.enum(['unknown', 'in_progress', 'completed', 'canceled']);
export const deliveryOrderRecord = z.strictObject({
  ...identity, nativeOrderId: nativeId, state: z.enum(['submitted', 'observed']),
  supplierStatus: text.nullable(), amountMinor: cents.nullable(),
  fulfillment: deliveryFulfillment,
});
export const taobaoCheckoutStates = ['quoted', 'declined', 'order_unknown', 'awaiting_payment', 'payment_handoff',
  'payment_unknown', 'payment_verification', 'payment_failed', 'paid'] as const;
export const hemaCheckoutStates = ['quoted', 'declined', 'order_unknown', 'awaiting_payment', 'payment_handoff'] as const;

export const deliveryCheckoutRecord = z.strictObject({
  ...identity,
  sourceTaskId: z.uuid().nullable(),
  scope: deliveryScope,
  addressDigest: digest,
  deliveryAddressKey: digest.optional(),
  personalPlaceVersionKey: digest.optional(),
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
  state: z.enum(taobaoCheckoutStates),
  orderIds: z.array(nativeId).max(50),
  supplierOrders: z.array(deliveryHistoryEntry).max(50),
  supplierObservedAt: time.nullable().optional(),
  observation: z.enum(['idle', 'watching', 'finished', 'timed_out', 'source_unavailable', 'stopped']).optional(),
});
const checkoutRead = deliveryCheckoutRecord.omit({ bindingId: true, sourceTaskId: true, addressDigest: true, deliveryAddressKey: true, personalPlaceVersionKey: true, version: true,
  quoteRef: true, windows: true }).extend({
  checkout: objectRefSchema,
  windows: z.array(z.strictObject({ index: z.number().int().nonnegative(), label: text, feeMinor: cents, selected: z.boolean() })).max(50),
  paymentEntry: z.enum(['taobao_private_checkout', 'hema_official_app']).nullable(),
  orders: z.array(deliveryOrderRecord.omit({ bindingId: true }).extend({ order: objectRefSchema })).max(50),
});

export const deliveryApproval = z.strictObject({ decision: z.enum(['approve', 'decline']), termsDigest: digest });
type Definition = Pick<OntologyDocument, 'objectTypes' | 'interfaceTypes' | 'linkTypes' | 'functionTypes' | 'actionTypes'>;
function object(apiName: string, description: string, shape: Record<string, z.ZodType>): Definition['objectTypes'][number] {
  return { apiName, displayName: apiName, description, primaryKey: 'id', titleProperty: 'name', interfaces: {},
    properties: Object.fromEntries(Object.entries(shape).map(([name, schema]) => [name, { description: name, required: !schema.isOptional(), schema: json(schema) }])),
  };
}


const channels = { TaobaoInstantDelivery: z.enum(['taobao_meal', 'taobao_retail']), Hema: z.literal('hema') } as const;
const inputs = {
  TaobaoInstantDelivery: {
    cart: deliveryScope.extend({ channel: channels.TaobaoInstantDelivery, merchantId: deliveryMerchantId }),
    item: deliveryItemInput.extend({ channel: channels.TaobaoInstantDelivery, merchantId: deliveryMerchantId }),
    change: deliveryCartChange.extend({ channel: channels.TaobaoInstantDelivery, merchantId: deliveryMerchantId }),
    preview: deliveryPreviewInput.omit({ lineIds: true }).extend({ channel: channels.TaobaoInstantDelivery, merchantId: deliveryMerchantId }),
  },
  Hema: {
    cart: deliveryScope.omit({ channel: true }),
    item: deliveryItemInput.omit({ channel: true }).extend({ merchantId: deliveryMerchantId, query: label.max(100) }),
    change: deliveryCartChange.omit({ channel: true, choiceRefs: true, removeLine: true }).extend({
      merchantId: deliveryMerchantId, itemId: deliveryMerchantId, query: label.max(100),
      quantity: count, variantRef: nativeId,
    }),
    preview: deliveryPreviewInput.omit({ channel: true, retailDelivery: true }).extend({ lineIds: z.array(nativeId).min(1).max(50) }),
  },
} as const;

function tradeService(provider: LocalDeliveryProvider) {
  const search = localDeliveryServices[provider];
  const channel = channels[provider], hema = provider === 'Hema';
  const cartChangeType = provider + 'CartChange', checkoutType = provider + 'Checkout', orderType = provider + 'Order';
  const cartContract = provider + 'CartEditing', orderContract = provider + 'Ordering';
  const searchCartLink = search.object + 'Cart', cartCheckoutLink = provider + 'CartCheckout', checkoutOrderLink = provider + 'CheckoutOrder';
  const checkoutProcess = checkoutType + 'StateLog', orderProcess = orderType + 'FulfillmentLog';
  const read = {
    cart: 'read' + provider + 'Cart', item: 'read' + provider + 'ItemOptions', recentOrders: 'read' + provider + 'RecentOrders',
    cartChange: 'read' + provider + 'CartChange', checkout: 'read' + provider + 'Checkout',
  };
  const names = {
    change: 'Change' + provider + 'Cart', preview: 'Preview' + provider + 'Checkout',
    selectWindow: 'SelectHemaDeliveryWindow', submit: 'Submit' + provider + 'Order',
    preparePayment: 'Prepare' + provider + 'Payment', pay: 'PayTaobaoInstantDeliveryOrder',
    refresh: 'Refresh' + provider + 'Order', stopObservation: 'Stop' + provider + 'OrderObservation',
  };
  const approvals = {
    cart: hema ? 'hema.cart_approval' : 'taobao_instant_delivery.cart_approval',
    order: hema ? 'hema.order_approval' : 'taobao_instant_delivery.order_approval',
    payment: 'taobao_instant_delivery.payment_approval',
  };
  return { provider, search, channel, input: inputs[provider], cartChangeType, checkoutType, orderType, cartContract, orderContract,
    searchCartLink, cartCheckoutLink, checkoutOrderLink, checkoutProcess, orderProcess, read, names, approvals };
}

export const deliveryTradeServices = {
  TaobaoInstantDelivery: tradeService('TaobaoInstantDelivery'),
  Hema: tradeService('Hema'),
};
type TradeService = ReturnType<typeof tradeService>;

export function deliveryEditFunction(action: string) {
  return action[0]!.toLowerCase() + action.slice(1);
}

function definitionFor(service: TradeService): Definition {
  const { provider, search, channel, input, cartChangeType, checkoutType, orderType, cartContract, orderContract,
    searchCartLink, cartCheckoutLink, checkoutOrderLink, read, names } = service;
  const action = (name: keyof typeof names, schema: z.ZodObject, description: string) => ({
    alias: name, apiName: names[name], schema, description,
  });
  const cartOps = [action('change', input.change, 'Change the selected cart after approval on the original PA task.')];
  const checkoutOps = [
    action('preview', input.preview, 'Obtain a time-bounded checkout quote for the bound cart revision.'),
    action('submit', deliveryCheckoutInput, 'Create one supplier order after approval of the original checkout.'),
    action('preparePayment', deliveryCheckoutInput, 'Verify the original order and prepare the account’s payment handoff.'),
    action('refresh', deliveryCheckoutInput, 'Read the original supplier order status without dispatching any transaction.'),
    action('stopObservation', deliveryCheckoutInput, 'Stop the scheduled original-order readback.'),
    provider === 'Hema'
      ? action('selectWindow', deliveryWindowInput, 'Select a Hema delivery window from the original quote and reprice.')
      : action('pay', deliveryCheckoutInput, 'Pay the original Taobao Instant Delivery order after separate approval.'),
  ];
  const cart = deliveryCartReport.extend({ channel });
  const state = provider === 'Hema' ? z.enum(hemaCheckoutStates) : z.enum(taobaoCheckoutStates);
  const checkoutShape = deliveryCheckoutRecord.extend({ channel, state, scope: deliveryScope.extend({ channel }) });
  const order = deliveryOrderRecord.extend({ channel });
  const change = deliveryCartChangeRecord.extend({ channel, cart: cart.nullable() });
  const groups = [
    { type: cartChangeType, contract: cartContract, fields: change.shape, operations: cartOps, description: 'Change to the bound supplier account cart.' },
    { type: checkoutType, contract: orderContract, fields: checkoutShape.shape, operations: checkoutOps, description: 'Original checkout and order lifecycle.' },
  ];
  const addressLinks = deliveryAddressNames(provider);
  const noLinks: Record<string, string> = {};
  const checkoutLinks = { deliveryAddress: deliveryAddressType, personalPlaceVersion: personalPlaceVersionType };
  const editTypes = groups.flatMap(({ type, operations }) => operations.map(op => ({ ...op, type,
    fn: deliveryEditFunction(op.apiName), existing: 'checkout' in op.schema.shape,
  })));
  const readFn = (apiName: string, schema: z.ZodObject, returns: z.ZodObject, description: string,
    dependencies: NonNullable<Definition['functionTypes'][number]['dependencies']> = {}) => ({
    apiName, description, source: provider, parameters: json(schema), returns: json(returns), dependencies,
  });
  return {
    objectTypes: [
      object(orderType, 'Confirmed supplier order and its independently observed fulfillment.', order.shape),
      ...groups.map(({ type, contract, fields, description, operations }) => ({
        ...object(type, description, fields), interfaces: { [contract]: { properties: { name: 'name' },
          links: type === checkoutType ? { deliveryAddress: 'deliveryAddress', personalPlaceVersion: 'personalPlaceVersion' } : noLinks,
          actions: Object.fromEntries(operations.map(op => [op.alias, { action: op.apiName,
            parameters: Object.fromEntries(Object.keys(op.schema.shape).map(name => [name, name])) }])) } },
      })),
    ],
    linkTypes: [
      { apiName: searchCartLink, description: 'Cart change attributed to the original supplier search.',
        from: { type: search.object, name: 'cartChanges', cardinality: 'many' }, to: { type: cartChangeType, name: 'search', cardinality: 'one' } },
      { apiName: cartCheckoutLink, description: 'Checkout that used the exact cart revision produced by the original change.',
        from: { type: cartChangeType, name: 'checkouts', cardinality: 'many' }, to: { type: checkoutType, name: 'cartChange', cardinality: 'one' } },
      ...Object.entries(checkoutLinks).map(([name, target]) => ({
        apiName: name === 'deliveryAddress' ? addressLinks.checkoutAddressLink : addressLinks.checkoutVersionLink,
        description: 'The ' + name + ' used to quote this checkout.',
        from: { type: checkoutType, name, cardinality: 'one' as const },
        to: { type: target, name: provider[0]!.toLowerCase() + provider.slice(1) + 'Checkouts', cardinality: 'many' as const },
      })),
      { apiName: checkoutOrderLink, description: 'Supplier orders produced by this approved checkout.',
        from: { type: checkoutType, name: 'orders', cardinality: 'many' }, to: { type: orderType, name: 'checkout', cardinality: 'one' } },
    ],
    interfaceTypes: groups.map(({ contract, description, operations }) => ({
      apiName: contract, description, properties: { name: { description: 'Delivery record name', required: true, schema: json(text) } },
      optionalProperties: [],
      links: contract === orderContract ? Object.fromEntries(Object.entries(checkoutLinks).map(([name, target]) =>
        [name, { target, cardinality: 'one' as const, required: false }])) : {},
      actions: Object.fromEntries(operations.map(op => {
        const objectParameters: Record<string, string> = 'checkout' in op.schema.shape ? { checkout: contract } : {};
        return [op.alias, { parameters: json(op.schema), objectParameters, required: true }];
      })),
    })),
    actionTypes: editTypes.map((op): Definition['actionTypes'][number] => ({
      apiName: op.apiName, description: op.description, parameters: json(op.schema), function: op.fn,
      objectParameters: op.existing ? { checkout: checkoutType } : {}, submissionCriteria: [],
      ...(op.alias === 'refresh' ? { typeClasses: [{ kind: 'observation', name: 'readback' }] } : {}),
    })),
    functionTypes: [
      readFn(read.cart, input.cart, cart, 'Read the bound cart revision, selection and prices.'),
      readFn(read.item, input.item, deliveryItemReport.extend({ channel }), 'Read current product options for the bound delivery account.'),
      readFn(read.recentOrders, z.strictObject({}), deliveryHistoryReport.extend({ provider: z.literal(provider) }),
        'Read the bound account’s first page of official orders.'),
      readFn(read.cartChange, readCartChange, cartChangeRead.extend({ channel, cart: cart.nullable() }),
        'Read the result of an approved or unresolved cart change.', { objectTypes: [cartChangeType] }),
      readFn(read.checkout, deliveryCheckoutInput, checkoutRead.extend({ channel, state, scope: deliveryScope.extend({ channel }),
        orders: z.array(order.omit({ bindingId: true }).extend({ order: objectRefSchema })).max(50) }),
        'Read the original checkout and supplier order.', { objectTypes: [checkoutType, orderType], linkTypes: [checkoutOrderLink] }),
      ...editTypes.map(op => ({
        apiName: op.fn, description: op.description, parameters: json(op.schema), returns: json(objectRefSchema), edits: true,
        ...(op.alias !== 'stopObservation' ? { source: provider } : {}),
        dependencies: op.alias === 'change' ? { objectTypes: [cartChangeType, search.object], linkTypes: [searchCartLink] }
          : op.alias === 'preview' ? { objectTypes: [checkoutType, cartChangeType, search.object, deliveryAddressType, personalPlaceVersionType],
            linkTypes: [cartCheckoutLink, searchCartLink, addressLinks.searchVersionLink, 'PersonalPlaceCurrentVersion',
              addressLinks.checkoutAddressLink, addressLinks.checkoutVersionLink] }
            : op.alias === 'submit' || op.alias === 'refresh'
              ? { objectTypes: [checkoutType, orderType], linkTypes: [checkoutOrderLink] } : { objectTypes: [checkoutType] },
      })),
    ],
  };
}

const definitions = localDeliveryProviders.map(provider => definitionFor(deliveryTradeServices[provider]));
export const localDeliveryTradeDefinition: Definition = {
  objectTypes: definitions.flatMap(def => def.objectTypes),
  linkTypes: definitions.flatMap(def => def.linkTypes),
  interfaceTypes: definitions.flatMap(def => def.interfaceTypes),
  actionTypes: definitions.flatMap(def => def.actionTypes),
  functionTypes: definitions.flatMap(def => def.functionTypes),
};
