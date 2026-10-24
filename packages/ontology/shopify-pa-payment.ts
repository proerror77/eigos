import { z } from 'zod';
import { objectRefSchema, type ActionDefinition, type ObjectTypeDefinition, type LinkDefinition, type FunctionDefinition, type PropertyDefinition } from './model.js';
import type { CompositionPort } from './composition-contract.js';
import { citationPort } from './document-action.js';
import { shopifyPAInputSchema, shopifyPAEntitySchemas, shopifyPASnapshotSchema } from '../capabilities/shopify/pa-checkout-contracts.js';

const id = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/);
const scope = objectRefSchema.extend({ type: z.literal('ShopifyPaymentTask') });
const products = objectRefSchema.extend({ type: z.literal('ShopifyPaymentProducts') });
const checkout = objectRefSchema.extend({ type: z.literal('ShopifyPaymentCheckoutObservation') });
const payment = objectRefSchema.extend({ type: z.literal('ShopifyCheckoutPaymentObservation') });
export const shopifyPAActionSchemas = {
  ReadShopifyPaymentProducts: z.strictObject({ scope }),
  CreateShopifyPaymentCheckout: z.strictObject({ scope, products }),
  ReadShopifyPaymentCheckout: z.strictObject({ scope, checkout }),
  ReadShopifyCheckoutPayment: z.strictObject({ scope, checkout }),
  RequestShopifyPAPayment: z.strictObject({ scope, checkout, payment }),
  WaitForShopifyPAPayment: z.strictObject({ scope, checkout, payment }),
};
export type ShopifyPAAction = keyof typeof shopifyPAActionSchemas;
export const shopifyPACompletionSchema = z.strictObject({ checkout, payment, rationale: z.string().min(1).max(2000) });
export const shopifyPAActionMetadata = {
  ReadShopifyPaymentProducts: { effect: 'read', type: 'ShopifyPaymentProducts', description: 'Read the selected Shopify-shaped variants and complete test price from the isolated merchant. No external Shopify request is made.' },
  CreateShopifyPaymentCheckout: { effect: 'reserve', type: 'ShopifyPaymentCheckoutObservation', description: 'Create exactly one unpaid isolated test checkout for the evaluated variants. Its reservation grant has zero payment spend. Payment remains with the PA.' },
  ReadShopifyPaymentCheckout: { effect: 'read', type: 'ShopifyPaymentCheckoutObservation', description: 'Independently read the original test checkout and merchant order confirmation. An old observation identifies the checkout without proving its current state.' },
  ReadShopifyCheckoutPayment: { effect: 'read', type: 'ShopifyCheckoutPaymentObservation', description: 'Independently read payment attached to the original test checkout, including amount, payee, operation and order. A PA notification provides no payment evidence.' },
  RequestShopifyPAPayment: { effect: 'local', type: 'PAPaymentRequest', description: 'Publish the exact independently verified unpaid checkout to the PA, then pause. The PA selects its own test Vault or payment account; EIGOS receives no payment credential and does not pay.' },
  WaitForShopifyPAPayment: { effect: 'local', type: 'PAPaymentRequest', description: 'After current independent reads, wait on the same unresolved checkout and payment. Never create another checkout, change routes or ask for a repeated payment.' },
} as const;
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Owned request or independently signed isolated Shopify contract simulator; never a live merchant' });
const common = { id: p('string', id, 'Immutable owned identity'), displayTitle: p('string', z.string().min(1).max(500), 'Business label'), requestRevision: p('integer', z.number().int().positive(), 'Original request revision') };
export const shopifyPAObjects: ObjectTypeDefinition[] = [
  { id: 'ShopifyPaymentTask', version: '1', name: 'Shopify 测试结账与 PA 付款', aliases: ['ShopifyPaymentTask'], description: 'Selected test variants, a single checkout and payment executed by the PA through its own test capability', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common, input: p('struct', shopifyPAInputSchema, 'Exact merchant and native variant quantities'), configurationDigest: p('string', sha, 'Original source configuration'), allowedActions: p('array', z.array(id).max(6), 'Atomic source reads, one unpaid checkout and local handoff') } },
  ...Object.entries(shopifyPAEntitySchemas).map(([type, schema]): ObjectTypeDefinition => ({ id: type, version: '1', name: type, aliases: [type], description: 'Independent test merchant observation, with checkout, payment and order kept distinct', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: { ...common, data: p('struct', schema, 'Source facts without PA payment credentials'), snapshot: p('struct', shopifyPASnapshotSchema, 'Owned model action, original terms, dependencies and signed HTTP receipt') } })),
];
export const shopifyPALinks: LinkDefinition[] = [
  { id: 'ShopifyPaymentTaskRequest', description: 'Original owned request', from: { type: 'ShopifyPaymentTask', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'shopifyPaymentTasks', many: true } },
  ...Object.keys(shopifyPAEntitySchemas).flatMap(type => [
    { id: `${type}Request`, description: 'Exact owned request revision', from: { type, name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: type, many: true } },
    { id: `${type}Scope`, description: 'Fixed merchant checkout scope', from: { type, name: 'scope', many: false, required: true }, to: { type: 'ShopifyPaymentTask', name: `observed${type}`, many: true } },
    { id: `${type}Evidence`, description: 'Source seals observed data and relationships', from: { type, name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: type, many: true } },
  ]),
  { id: 'ShopifyPaymentSelectedProducts', description: 'Checkout retains the exact selected variants and quantities', from: { type: 'ShopifyPaymentCheckoutObservation', name: 'products', many: false }, to: { type: 'ShopifyPaymentProducts', name: 'checkouts', many: true } },
  { id: 'ShopifyPaymentOriginalCheckout', description: 'Readback preserves the original checkout', from: { type: 'ShopifyPaymentCheckoutObservation', name: 'original', many: false }, to: { type: 'ShopifyPaymentCheckoutObservation', name: 'readbacks', many: true } },
  { id: 'ShopifyPaymentForCheckout', description: 'Payment belongs to the original checkout', from: { type: 'ShopifyCheckoutPaymentObservation', name: 'checkout', many: false, required: true }, to: { type: 'ShopifyPaymentCheckoutObservation', name: 'payments', many: true } },
  { id: 'PAPaymentCheckoutScope', description: 'Version-3 checkout handoff scope', from: { type: 'PAPaymentRequest', name: 'checkoutScope', many: false }, to: { type: 'ShopifyPaymentTask', name: 'handoffs', many: true } },
  { id: 'PAPaymentCheckout', description: 'Original independently read checkout', from: { type: 'PAPaymentRequest', name: 'checkout', many: false }, to: { type: 'ShopifyPaymentCheckoutObservation', name: 'handoffs', many: true } },
  { id: 'PAPaymentCheckoutUnpaidProof', description: 'Independent unpaid proof before PA dispatch', from: { type: 'PAPaymentRequest', name: 'checkoutUnpaidProof', many: false }, to: { type: 'ShopifyCheckoutPaymentObservation', name: 'handoffs', many: true } },
];
const port = (type: string, identity = false): CompositionPort => ({ kind: 'object', type, cardinality: 'one', semantics: { role: type, phase: type === 'ShopifyPaymentTask' || type === 'PAPaymentRequest' ? 'request' : type === 'ShopifyCheckoutPaymentObservation' ? 'payment' : type === 'ShopifyPaymentCheckoutObservation' ? 'commitment' : 'fact' }, evidence: { origins: type === 'ShopifyPaymentTask' || type === 'PAPaymentRequest' ? ['managed', 'user'] : ['synthetic'], ...(identity || type === 'ShopifyPaymentTask' ? {} : { maxAgeMs: 300000 }) } });
export const shopifyPAActions: ActionDefinition[] = Object.entries(shopifyPAActionSchemas).map(([id, schema]) => {
  const metadata = shopifyPAActionMetadata[id as ShopifyPAAction], inputs: Record<string, CompositionPort> = { scope: port('ShopifyPaymentTask') };
  if (id === 'CreateShopifyPaymentCheckout') inputs.products = port('ShopifyPaymentProducts');
  if (!['ReadShopifyPaymentProducts', 'CreateShopifyPaymentCheckout'].includes(id)) inputs.checkout = port('ShopifyPaymentCheckoutObservation', id.startsWith('Read'));
  if (id === 'RequestShopifyPAPayment' || id === 'WaitForShopifyPAPayment') inputs.payment = port('ShopifyCheckoutPaymentObservation');
  const read = metadata.effect === 'read', create = metadata.effect === 'reserve';
  return { id, version: '1', kind: read ? 'source_read' : 'business', effects: [metadata.effect], resultTypes: [metadata.type], description: metadata.description,
    inputs: Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, value.kind === 'object' ? value.type : ''])), changes: [metadata.type], submissionCriteria: ['same_owner', 'current_request_revision', 'exact_source_terms', 'sandbox_only', ...(create ? ['exact_zero_spend_reservation'] : [])],
    ...(read ? { read: { version: '1', effect: metadata.effect, inputSchema: z.toJSONSchema(schema), resultType: metadata.type } } : { operation: { version: '1', effect: metadata.effect, environment: 'sandbox', inputSchema: z.toJSONSchema(schema), resultType: metadata.type } }),
    composition: { version: '1', inputs, outputs: { result: port(metadata.type), ...(metadata.type === 'ShopifyPaymentCheckoutObservation' ? { identity: port(metadata.type, true) } : {}), citations: citationPort(metadata.type) }, checks: [], effectScope: { effects: [metadata.effect], targetInputs: create ? ['scope', 'products'] : [], recovery: create ? { kind: 'original_intent', version: '1', effect: 'read' } : { kind: 'none' }, compensation: [] } },
  };
});
export const shopifyPAFunctions: FunctionDefinition[] = [{ id: 'shopifyPAPaymentStatus', version: '1', inputTypes: Object.keys(shopifyPAEntitySchemas), description: 'Check exact original checkout/payment terms, owned signed test evidence, freshness and independent readback. PA capability availability or a report never proves a payment.' }];
