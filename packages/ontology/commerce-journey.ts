import { z } from 'zod';
import { moneySchema, requirementSchema } from './execution.js';
import { objectRefSchema, type ActionDefinition, type FunctionDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';
import { stockRegulationSchema, shippingLegSchema, shippingRegimeSchema } from './shipping-policy.js';
import { productAttributesSchema } from './product-attributes.js';

const text = z.string().trim().min(1).max(500), id = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true }), country = z.string().regex(/^[A-Z]{2}$/), count = z.number().int().min(1).max(1000);
export const postalAddressSchema = z.strictObject({
  countryCode: country, region: text.optional(), city: text.optional(), postalCode: text.optional(),
  street: text.optional(), extendedAddress: text.optional(), recipient: text.optional(), phone: text.optional(),
});
export type PostalAddress = z.infer<typeof postalAddressSchema>;
export const commerceJourneyInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(300).nullable(), quantity: count.nullable(),
  contextKey: id.nullable(), target: z.enum(['quote', 'cart', 'checkout', 'order', 'payment', 'delivery']),
});
export type CommerceJourneyInput = z.infer<typeof commerceJourneyInputSchema>;
export const factRequirementSchema = z.strictObject({
  fact: id, stage: z.enum(['discovery', 'quote', 'checkout', 'order', 'payment', 'delivery']),
  status: z.enum(['known', 'unknown', 'conflict', 'expired', 'not_applicable']),
  source: z.enum(['pa_context', 'pa_choice', 'merchant', 'inventory', 'fulfillment', 'customs', 'payment', 'carrier']),
  reason: text, suggestedActions: z.array(id).max(5),
});
const item = z.strictObject({ merchantId: id, variantId: id, title: text, quantity: count, unitPrice: moneySchema });
const group = z.strictObject({
  id, variantId: id, quantity: count, warehouseId: id, dispatchCountry: country,
  destinationDigest: sha, carrier: text, service: text, transport: z.enum(['road', 'air', 'sea', 'rail', 'mixed']),
  transitCountries: z.array(country).max(10),
  regulation: stockRegulationSchema.optional(), legs: z.array(shippingLegSchema).min(1).max(12).optional(),
});
const promise = z.strictObject({
  id, issuer: id, kind: z.enum(['estimate', 'commitment', 'unknown']), milestone: z.enum(['dispatch', 'arrival']),
  earliestAt: instant.optional(), latestAt: instant.optional(), timeZone: text, groupIds: z.array(id).min(1).max(20),
  destinationDigest: sha, conditions: z.array(z.strictObject({ code: id, status: z.enum(['met', 'unmet', 'unknown']), description: text })).max(20),
  expiresAt: instant, exceptions: z.array(text).max(20), remedy: text.optional(),
});
const costComponent = z.strictObject({
  id, category: z.enum(['goods', 'shipping', 'tax', 'duty', 'clearance', 'insurance', 'fee', 'discount']),
  amount: moneySchema.optional(), amountStatus: z.enum(['fixed', 'estimate', 'unknown']),
  payer: z.enum(['buyer', 'seller', 'unknown']), timing: z.enum(['checkout', 'arrival', 'included', 'unknown']),
  coveredByTotal: z.boolean(), responsibilityEvidence: id.optional(),
});
export const commerceEntitySchemas = {
  FulfillmentContext: z.strictObject({
    contextKey: id, profileRevision: id, dataUse: z.literal('this_sandbox_task'),
    addresses: z.array(z.strictObject({ id, label: text, address: postalAddressSchema, revision: id, usable: z.boolean() })).max(8),
    preferredAddressId: id.optional(), available: z.boolean(),
  }),
  CommerceMerchantSearch: z.strictObject({
    query: text, coverage: z.enum(['complete_sandbox_directory', 'partial']),
    merchants: z.array(z.strictObject({ id, name: text, registeredCountry: country, categories: z.array(text).max(10), supportedCurrencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(10) })).max(20),
  }),
  CommerceProduct: z.strictObject({
    merchantId: id, variantId: id, title: text, sku: id, unitPrice: moneySchema,
    typedAttributes: productAttributesSchema.optional(),
    goodsOriginCountry: country.optional(), hsCode: z.string().regex(/^[0-9]{6,13}$/).optional(),
    weightGrams: z.number().int().positive().optional(), category: text, availableReported: z.boolean(),
    restrictions: z.array(text).max(20),
  }),
  InventoryObservation: z.strictObject({
    merchantId: id, variantId: id, requestedQuantity: count,
    locations: z.array(z.strictObject({ warehouseId: id, dispatchCountry: country, availability: z.enum(['confirmed', 'unavailable', 'unknown']), confirmedQuantity: z.number().int().nonnegative().max(1000).optional(), availableQuantity: z.number().int().nonnegative().optional(), quantityState: z.enum(['sellable', 'on_hand', 'unknown']), regulation: stockRegulationSchema.optional() })).max(20),
    reserved: z.literal(false),
  }),
  InventoryReservation: z.strictObject({ merchantId: id, variantId: id, warehouseId: id, quantity: count, reservationId: id, state: z.enum(['held', 'released', 'expired', 'unknown']), expiresAt: instant }),
  FulfillmentPlan: z.strictObject({
    merchantId: id, variantId: id, quantity: count, contextKey: id, addressId: id, addressRevision: id,
    destination: postalAddressSchema, destinationDigest: sha, destinationCustomsTerritory: id.optional(),
    options: z.array(z.strictObject({ id, status: z.enum(['available', 'unavailable', 'unknown']), groups: z.array(group).min(1).max(20), promises: z.array(promise).max(20), shippingPrice: moneySchema, incoterm: z.enum(['domestic', 'DDP', 'DAP', 'other', 'unknown']), namedPlace: text, reason: text.optional() })).max(12),
  }),
  CustomsAssessment: z.strictObject({
    merchantId: id, variantId: id, quantity: count, fulfillmentId: id, optionId: id, destinationDigest: sha,
    dispatchCountries: z.array(country).min(1).max(20), destinationCountry: country,
    goodsOriginCountry: country.optional(), hsCode: z.string().regex(/^[0-9]{6,13}$/).optional(),
    status: z.enum(['allowed', 'restricted', 'unknown', 'not_applicable']),
    requirements: z.array(z.strictObject({ code: id, status: z.enum(['met', 'unmet', 'unknown']), description: text })).max(20),
    importer: z.enum(['buyer', 'seller', 'unknown']), dutyPayer: z.enum(['buyer', 'seller', 'unknown']),
    duty: moneySchema.optional(), tax: moneySchema.optional(), clearanceFee: moneySchema.optional(),
    sourceRuleVersion: id, applicableAt: instant, syntheticRules: z.literal(true),
    shippingRegime: shippingRegimeSchema.optional(), routeDigest: sha.optional(),
  }),
  LandedCostQuote: z.strictObject({
    merchantId: id, variantId: id, quantity: count, unitPrice: moneySchema,
    inventoryId: id, inventoryVersion: z.number().int().positive(),
    fulfillmentId: id, optionId: id, customsId: id, destinationDigest: sha,
    components: z.array(costComponent).min(1).max(30), buyerTotal: moneySchema,
    scope: z.enum(['all_buyer_mandatory_fees', 'partial', 'unknown']), priceKind: z.enum(['firm', 'estimate']),
    incoterm: z.enum(['domestic', 'DDP', 'DAP', 'other', 'unknown']), termsVersion: id,
    groups: z.array(group).min(1).max(20), promises: z.array(promise).max(20),
  }),
  Cart: z.strictObject({ cartId: id, merchantId: id, revision: id, state: z.enum(['active', 'canceled', 'converted']), lines: z.array(item).min(1).max(20), inventoryReserved: z.literal(false), estimatedTotal: moneySchema }),
  CartLine: item,
  CommerceCheckout: z.strictObject({ checkoutId: id, merchantId: id, cartId: id.optional(), quoteId: id, quoteDigest: sha, destinationDigest: sha, lines: z.array(item).min(1).max(20), total: moneySchema, costComponents: z.array(costComponent).min(1).max(30), state: z.enum(['ready', 'incomplete', 'completed', 'canceled']), orderId: id.optional(), expiresAt: instant }),
  CommerceOrderObservation: z.strictObject({ orderId: id, merchantId: id, checkoutId: id, quoteId: id, quoteDigest: sha, destinationDigest: sha, lines: z.array(item).min(1).max(20), total: moneySchema, costComponents: z.array(costComponent).min(1).max(30), state: z.enum(['confirmed', 'canceled', 'unknown']), fulfillment: z.enum(['pending', 'partial', 'delivered', 'failed', 'unknown']), independentRead: z.boolean(), paymentProvider: z.literal('stripe_test').optional() }),
  CommercePaymentObservation: z.strictObject({ paymentId: id, orderId: id, merchantId: id, amount: moneySchema, state: z.enum(['authorized', 'captured', 'settled', 'refunded', 'failed', 'pending', 'unknown']), receiptId: id, observedAt: instant }),
  CommerceDeliveryObservation: z.strictObject({ orderId: id, merchantId: id, destinationDigest: sha, state: z.enum(['pending', 'partial', 'delivered', 'failed', 'unknown']), events: z.array(z.strictObject({ id, groupId: id, variantId: id, quantity: count, occurredAt: instant, milestone: z.enum(['shipped', 'customs_hold', 'delivered', 'returned']), destinationDigest: sha })).max(100) }),
  DeliveryPromise: promise,
  FulfillmentGroup: group,
  FactRequirement: factRequirementSchema,
};
export type CommerceEntityType = keyof typeof commerceEntitySchemas;
export type CommerceEntityData<T extends CommerceEntityType> = z.infer<(typeof commerceEntitySchemas)[T]>;
export const commerceEvidenceScopes: Record<string, string> = Object.fromEntries(Object.keys(commerceEntitySchemas).map(type => [type, type === 'CommercePaymentObservation' ? 'payment' : type === 'CommerceOrderObservation' ? 'order' : ['FulfillmentPlan', 'FulfillmentGroup', 'DeliveryPromise', 'CommerceDeliveryObservation'].includes(type) ? 'delivery' : ['Cart', 'CartLine', 'CommerceCheckout'].includes(type) ? 'checkout_session' : 'goods_offer']));
export const commerceEntityTypeSchema = z.enum(Object.keys(commerceEntitySchemas) as [CommerceEntityType, ...CommerceEntityType[]]);
export const commerceSourceReceiptSchema = z.strictObject({
  id, requestId: id, requestRevision: z.number().int().positive(), ownerDigest: sha,
  action: id, planId: id, intentId: id, attemptId: id, modelRunId: id,
  source: z.enum(['pa_context', 'merchant_directory', 'merchant', 'inventory', 'fulfillment', 'customs', 'payment', 'carrier']),
  sourceIdentity: id, operationKey: id, operationId: id, operationVersion: z.number().int().positive(),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']), path: z.string().min(1).max(1000), status: z.number().int(),
  inputDigest: sha, responseSha256: sha, responseBytes: z.number().int().positive(), startedAt: instant, receivedAt: instant,
  payloadDigest: sha,
  signature: sha,
  environment: z.literal('sandbox'),
});
export const commerceObservationSchema = z.strictObject({
  type: commerceEntityTypeSchema, sourceId: id, sourceVersion: z.number().int().positive(),
  requestId: id, requestRevision: z.number().int().positive(), configurationDigest: sha,
  scope: objectRefSchema.extend({ type: z.literal('CommerceTask') }), action: id,
  actionInput: z.record(z.string(), z.unknown()), data: z.record(z.string(), z.unknown()),
  dependencies: z.array(z.strictObject({ ref: objectRefSchema, contentDigest: sha, checkedAt: instant.optional() })).max(16),
  dependencyCheckedAt: instant.optional(),
  projectedFrom: z.strictObject({ parent: objectRefSchema, path: z.array(z.string().min(1).max(80)).min(1).max(8) }).optional(),
  observedAt: instant, expiresAt: instant, receipt: commerceSourceReceiptSchema,
  evidenceLevel: z.literal('synthetic'), realOperationsAllowed: z.literal(false), contentDigest: sha,
});
export type CommerceObservation = z.infer<typeof commerceObservationSchema>;
export function parseCommerceEntity<T extends CommerceEntityType>(type: T, data: unknown): CommerceEntityData<T> {
  return commerceEntitySchemas[type].parse(data) as CommerceEntityData<T>;
}

const scope = objectRefSchema.extend({ type: z.literal('CommerceTask') });
const ref = <T extends CommerceEntityType>(type: T) => objectRefSchema.extend({ type: z.literal(type) });
export const commerceJourneyActionSchemas = {
  ReadCommerceContext: z.strictObject({ scope }),
  SearchCommerceMerchants: z.strictObject({ scope, query: z.string().trim().min(1).max(300) }),
  ReadCommerceProduct: z.strictObject({ scope, discovery: ref('CommerceMerchantSearch'), merchantId: id, query: z.string().trim().min(1).max(300) }),
  ReadCommerceInventory: z.strictObject({ scope, product: ref('CommerceProduct'), quantity: count }),
  ReadCommerceFulfillment: z.strictObject({ scope, product: ref('CommerceProduct'), inventory: ref('InventoryObservation'), context: ref('FulfillmentContext'), addressId: id, quantity: count }),
  ReadCommerceCustoms: z.strictObject({ scope, product: ref('CommerceProduct'), fulfillment: ref('FulfillmentPlan'), optionId: id }),
  QuoteCommerceLandedCost: z.strictObject({ scope, product: ref('CommerceProduct'), inventory: ref('InventoryObservation'), fulfillment: ref('FulfillmentPlan'), optionId: id, customs: ref('CustomsAssessment') }),
  CreateCommerceCart: z.strictObject({ scope, product: ref('CommerceProduct'), quantity: count }),
  ReadCommerceCart: z.strictObject({ scope, cart: ref('Cart') }),
  UpdateCommerceCart: z.strictObject({ scope, cart: ref('Cart'), product: ref('CommerceProduct'), quantity: count }),
  CancelCommerceCart: z.strictObject({ scope, cart: ref('Cart') }),
  PrepareCommerceCheckout: z.strictObject({ scope, quote: ref('LandedCostQuote'), cart: ref('Cart').optional() }),
  SubmitCommerceOrder: z.strictObject({ scope, checkout: ref('CommerceCheckout') }),
  SubmitCommerceUnpaidOrder: z.strictObject({ scope, checkout: ref('CommerceCheckout') }),
  ReadCommerceOrder: z.strictObject({ scope, order: ref('CommerceOrderObservation') }),
  ReadCommercePayment: z.strictObject({ scope, order: ref('CommerceOrderObservation') }),
  ReadCommerceDelivery: z.strictObject({ scope, order: ref('CommerceOrderObservation') }),
};
export type CommerceJourneyAction = keyof typeof commerceJourneyActionSchemas;
export const commerceActionMetadata: Record<CommerceJourneyAction, { type: CommerceEntityType; source: z.infer<typeof commerceSourceReceiptSchema>['source']; effect: 'read' | 'change' | 'cancel' | 'order'; additionalEffects?: ['payment']; description: string }> = {
  ReadCommerceContext: { type: 'FulfillmentContext', source: 'pa_context', effect: 'read', description: 'Query this owner\'s consented PA context for saved delivery destinations. No user address, country or merchant is prefilled in the task scope.' },
  SearchCommerceMerchants: { type: 'CommerceMerchantSearch', source: 'merchant_directory', effect: 'read', description: 'Search the sandbox merchant directory using your chosen business query. Discovery establishes candidates, never purchase authority.' },
  ReadCommerceProduct: { type: 'CommerceProduct', source: 'merchant', effect: 'read', description: 'Query one discovered merchant for a product matching your query, including its source variant, pricing and customs product facts.' },
  ReadCommerceInventory: { type: 'InventoryObservation', source: 'inventory', effect: 'read', description: 'Query a selected product\'s sellable capacity for the requested quantity by warehouse. This does not reserve inventory.' },
  ReadCommerceFulfillment: { type: 'FulfillmentPlan', source: 'fulfillment', effect: 'read', description: 'Query shipping choices for a source product, evidenced quantity and authorized destination. Discover actual dispatch countries, package groups and conditional delivery promises.' },
  ReadCommerceCustoms: { type: 'CustomsAssessment', source: 'customs', effect: 'read', description: 'Query synthetic import eligibility, required facts and tax responsibility for your chosen fulfillment option. Domestic and international routes return distinct evidence; never infer rules or tax rates.' },
  QuoteCommerceLandedCost: { type: 'LandedCostQuote', source: 'merchant', effect: 'read', description: 'Request an exact source quote for your selected inventory, destination, shipping and customs evidence. Evaluate its buyer charges, responsibilities and promises before proceeding.' },
  CreateCommerceCart: { type: 'Cart', source: 'merchant', effect: 'change', description: 'Create a sandbox draft cart for the selected product and quantity. Requires a specific sandbox permit, creates no inventory reservation, order or payment.' },
  ReadCommerceCart: { type: 'Cart', source: 'merchant', effect: 'read', description: 'Read the current state of an original owned cart, including after its previous observation expired. Its old identity is not new execution authority.' },
  UpdateCommerceCart: { type: 'Cart', source: 'merchant', effect: 'change', description: 'Replace the sandbox cart contents at its exact observed version. This invalidates downstream selections; no order or inventory reservation is implied.' },
  CancelCommerceCart: { type: 'Cart', source: 'merchant', effect: 'cancel', description: 'Cancel this exact sandbox draft cart. Order cancellation is a different operation.' },
  PrepareCommerceCheckout: { type: 'CommerceCheckout', source: 'merchant', effect: 'change', description: 'Create a sandbox checkout from an independently evaluated firm quote, optionally using a matching cart. The exact source terms are pinned; no order or payment occurs.' },
  SubmitCommerceOrder: { type: 'CommerceOrderObservation', source: 'merchant', effect: 'order', additionalEffects: ['payment'], description: 'Submit the exact independently validated sandbox checkout with separate order and simulated payment authority. Read the original order and payment independently afterwards; never repeat an unknown submission.' },
  SubmitCommerceUnpaidOrder: { type: 'CommerceOrderObservation', source: 'merchant', effect: 'order', description: 'Submit the exact evaluated sandbox checkout as an unpaid order for the configured Stripe test program. Order authority has zero payment cost; a separate exact payment permit is required later. Retains all goods, quote and shipping gates.' },
  ReadCommerceOrder: { type: 'CommerceOrderObservation', source: 'merchant', effect: 'read', description: 'Independently read the original sandbox order and compare its fixed items, destination and cost allocation.' },
  ReadCommercePayment: { type: 'CommercePaymentObservation', source: 'payment', effect: 'read', description: 'Read the original order\'s separate simulated payment receipt. Order confirmation alone proves no payment settlement.' },
  ReadCommerceDelivery: { type: 'CommerceDeliveryObservation', source: 'carrier', effect: 'read', description: 'Read original sandbox shipment events with package quantities and destination identity. A shipping event or fulfilled counter does not prove arrival.' },
};

const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string, required = true): PropertyDefinition => ({ kind, schema, description, required, source: 'Owner-bound task or source-validated sandbox observation; synthetic evidence never establishes real transactions' });
const common = { id: p('string', id, 'Immutable namespaced identity'), displayTitle: p('string', text, 'Business label'), requestRevision: p('integer', z.number().int().positive(), 'Owning request revision') };
export const commerceJourneyObjects: ObjectTypeDefinition[] = [
  { id: 'CommerceTask', version: '1', name: '交易履约任务', aliases: ['CommerceTask', '交易事实缺口'], description: 'Task scope and desired endpoint; geography and merchant facts are acquired at runtime', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common, input: p('struct', commerceJourneyInputSchema, 'Goal inputs, allowing unknown business context'), requirements: p('array', z.array(requirementSchema).max(40), 'Fixed user conditions; no inferred source facts or execution authority'), configurationDigest: p('string', sha, 'Exact bound sandbox source configuration'), allowedActions: p('array', z.array(id).max(20), 'Bound actions; definitions grant no authority'), environment: p('string', z.literal('sandbox'), 'No live operation is supported') } },
  ...Object.entries(commerceEntitySchemas).map(([type, schema]): ObjectTypeDefinition => ({ id: type, version: '1', name: type, aliases: [type], description: `Commerce ${type}: versioned facts with explicit source, scope and validity`, primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'CommerceFact' }], properties: { ...common, data: p('struct', schema, 'Typed business facts; unknown values are not inferred'), snapshot: p('struct', commerceObservationSchema, 'Exact source response, action and dependency evidence') } })),
];
export const commerceJourneyLinks: LinkDefinition[] = [
  { id: 'CommerceFactDependency', description: 'Typed observations retain the exact input fact versions used for this result', from: { type: 'CommerceFact', name: 'dependsOn', many: true }, to: { type: 'CommerceFact', name: 'usedBy', many: true } },
  { id: 'CommerceTaskRequest', description: 'Current task revision owns its runtime commerce scope', from: { type: 'CommerceTask', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'commerceTasks', many: true } },
  ...commerceJourneyObjects.filter(o => o.id !== 'CommerceTask').flatMap(o => [
    { id: `${o.id}CommerceRequest`, description: 'Observation belongs to one request revision', from: { type: o.id, name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: `commerce${o.id}`, many: true } },
    { id: `${o.id}CommerceScope`, description: 'Observation belongs to the fixed commerce program scope', from: { type: o.id, name: 'scope', many: false, required: true }, to: { type: 'CommerceTask', name: `observed${o.id}`, many: true } },
    { id: `${o.id}Evidence`, description: 'Source receipt binds business data and relationships', from: { type: o.id, name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: `commerce${o.id}`, many: true } },
  ]),
];
export const commerceJourneyActions: ActionDefinition[] = Object.entries(commerceJourneyActionSchemas).map(([id, schema]) => {
  const m = commerceActionMetadata[id as CommerceJourneyAction];
  return { id, description: m.description, inputs: { scope: 'CommerceTask' }, changes: [m.type], submissionCriteria: ['same_owner', 'current_request_revision', 'source_bound_inputs', 'fresh_dependencies', 'sandbox_only', ...(m.effect === 'read' ? [] : ['exact_plan_authority']), ...(['QuoteCommerceLandedCost', 'PrepareCommerceCheckout', 'SubmitCommerceOrder', 'SubmitCommerceUnpaidOrder'].includes(id) ? ['current_customs_policy', 'model_evaluated_customs_gate', 'customs_gate_pass_sandbox'] : []), ...(['CreateCommerceCart', 'UpdateCommerceCart'].includes(id) ? ['supported_commodity_policy'] : [])],
    ...(m.effect === 'read' ? { read: { version: '1', effect: 'read' as const, inputSchema: z.toJSONSchema(schema), resultType: m.type } } : { operation: { version: '1', effect: m.effect, ...(m.additionalEffects ? { additionalEffects: m.additionalEffects } : {}), environment: 'sandbox' as const, inputSchema: z.toJSONSchema(schema), resultType: m.type } }) };
});
export const commerceJourneyFunctions: FunctionDefinition[] = [
  { id: 'commerceObservationStatus', version: '1', inputTypes: commerceJourneyObjects.filter(o => o.id !== 'CommerceTask').map(o => o.id), description: 'Verify exact source, task scope, current versions and recursive input freshness; return typed facts and missing requirements. This read grants no execution authority.' },
  { id: 'commerceJourneyStatus', version: '1', inputTypes: ['CommerceTask'], description: 'Read current commerce facts and stage-specific gaps. Missing buyer choices go to PA; merchant, stock, customs and fulfillment facts go to their source services.' },
];
