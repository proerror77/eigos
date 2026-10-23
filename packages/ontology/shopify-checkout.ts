import { z } from 'zod';
import { objectRefSchema, type ActionDefinition, type LinkDefinition, type ObjectTypeDefinition, type FunctionDefinition, type PropertyDefinition } from './model.js';
import type { CompositionPort } from './composition-contract.js';
import { shopCheckoutInputSchema, shopCheckoutSnapshotSchema, shopCheckoutDataSchema, shopSelectedProductSchema, shopLineItemsSchema } from '../capabilities/shopify/checkout-contracts.js';
import { shopifyMerchantSchema } from '../capabilities/shopify/contracts.js';
import { citationPort } from './document-action.js';

const text = z.string().min(1).max(2000), sha = z.string().regex(/^[a-f0-9]{64}$/);
const scope = objectRefSchema.extend({ type: z.literal('ShopifyCheckoutTask') });
const products = objectRefSchema.extend({ type: z.literal('ShopifyCheckoutProducts') });
const checkout = objectRefSchema.extend({ type: z.literal('ShopifyCheckoutObservation') });
export const shopCheckoutActionSchemas = {
  ReadShopifyCheckoutProducts: z.strictObject({ scope }),
  CreateShopifyCheckout: z.strictObject({ scope, products }),
  ReadShopifyCheckout: z.strictObject({ scope, checkout: checkout.optional().describe('Required after creation within a prepare task. Omit in status mode: that scope already binds the original owned sourceTaskId.') }),
};
export type ShopCheckoutAction = keyof typeof shopCheckoutActionSchemas;
export const shopCheckoutActionIds = Object.keys(shopCheckoutActionSchemas) as ShopCheckoutAction[];
export const shopCheckoutCompletionSchema = z.strictObject({ checkout });
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string, restricted = false): PropertyDefinition => ({ kind, schema, description, restricted, required: true, source: 'Owned request or original Shopify Shop MCP observation; no payment execution' });
const base = { id: p('string', text, 'Immutable owned identity'), displayTitle: p('string', z.string().min(1).max(500), 'Business label'), requestRevision: p('integer', z.number().int().positive(), 'Owning request revision') };
export const shopCheckoutObjects: ObjectTypeDefinition[] = [
  { id: 'ShopifyCheckoutTask', version: '1', name: 'Shopify 未付款结账范围', aliases: ['ShopifyCheckoutTask'], description: 'Prepare one unpaid checkout for selected variants, or read a previously prepared owned checkout. Initializing this scope never calls a provider.', primaryKey: 'id', titleKey: 'displayTitle', visibility: 'technical',
    properties: { ...base, input: p('struct', shopCheckoutInputSchema, 'Fixed task purpose and exact selected products, or original owned task'), merchant: p('struct', shopifyMerchantSchema, 'Configured canonical merchant identity'), selection: p('array', shopLineItemsSchema, 'Selected native variants and integer checkout quantities'), configurationDigest: p('string', sha, 'Trusted component binding'), allowedActions: p('array', z.array(z.string()).max(3), 'Only source reads and unpaid draft creation'),
      sourceCheckout: { ...p('struct', checkout, 'Original owned checkout identity for status-only tasks'), required: false } } },
  { id: 'ShopifyCheckoutProducts', version: '1', name: 'Shopify 结账商品观察', aliases: ['ShopifyCheckoutProducts'], description: 'Current selected variant identity, price and availability; no stock reservation, shipping guarantee or payment authority.', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }],
    properties: { ...base, items: p('array', z.array(shopSelectedProductSchema).min(1).max(20), 'Source-confirmed selected variants, sale-unit counts and display prices'), snapshot: p('struct', shopCheckoutSnapshotSchema, 'Original action and source provenance; runtime-only verification', true) } },
  { id: 'ShopifyCheckoutObservation', version: '1', name: 'Shopify 结账状态观察', aliases: ['ShopifyCheckoutObservation'], description: 'One immutable observation of the original merchant checkout. Prepared checkout, order creation, payment and fulfillment are separate states.', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }],
    properties: { ...base, data: p('struct', shopCheckoutDataSchema, 'Current source status, items, provisional totals and required buyer actions; no credentials'), snapshot: p('struct', shopCheckoutSnapshotSchema, 'Original receipt including opaque checkout key and owner-only continue URL; never exposed through Ontology reads', true) } },
];
export const shopCheckoutLinks: LinkDefinition[] = [
  { id: 'ShopifyCheckoutTaskRequest', description: 'Owned checkout request scope', from: { type: 'ShopifyCheckoutTask', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'shopifyCheckoutTasks', many: true } },
  { id: 'ShopifyCheckoutTaskOriginal', description: 'Status-only task explicitly references one earlier owned checkout', from: { type: 'ShopifyCheckoutTask', name: 'originalCheckout', many: false }, to: { type: 'ShopifyCheckoutObservation', name: 'statusRequests', many: true } },
  ...(['ShopifyCheckoutProducts', 'ShopifyCheckoutObservation'] as const).flatMap(type => [
    { id: `${type}Request`, description: 'Observation belongs to this exact request revision', from: { type, name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: type === 'ShopifyCheckoutProducts' ? 'shopifyCheckoutProducts' : 'shopifyCheckoutObservations', many: true } },
    { id: `${type}Scope`, description: 'Observation retains its configured merchant and selected products', from: { type, name: 'scope', many: false, required: true }, to: { type: 'ShopifyCheckoutTask', name: type === 'ShopifyCheckoutProducts' ? 'products' : 'checkouts', many: true } },
    { id: `${type}Evidence`, description: 'Original source receipt seals the observed fields and relationships', from: { type, name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: type === 'ShopifyCheckoutProducts' ? 'shopifyCheckoutProducts' : 'shopifyCheckoutObservations', many: true } },
  ]),
  { id: 'ShopifyCheckoutOriginalCreation', description: 'Every read preserves the original checkout creation, including status-only follow-ups', from: { type: 'ShopifyCheckoutObservation', name: 'originalCreation', many: false }, to: { type: 'ShopifyCheckoutObservation', name: 'readbacks', many: true } },
];
const port = (type: string, role: string, identity = false): CompositionPort => ({ kind: 'object', type, cardinality: 'one', semantics: { role, phase: type === 'ShopifyCheckoutTask' ? 'request' : 'fact' }, evidence: { origins: type === 'ShopifyCheckoutTask' ? ['managed', 'user'] : ['provider', 'synthetic'], ...(identity || type === 'ShopifyCheckoutTask' ? {} : { maxAgeMs: 300000 }) } });
export const shopCheckoutActions: ActionDefinition[] = shopCheckoutActionIds.map(id => {
  const create = id === 'CreateShopifyCheckout', type = id === 'ReadShopifyCheckoutProducts' ? 'ShopifyCheckoutProducts' : 'ShopifyCheckoutObservation';
  const inputs: Record<string, CompositionPort> = { scope: port('ShopifyCheckoutTask', 'ShopifyCheckoutTask') };
  if (create) inputs.products = port('ShopifyCheckoutProducts', 'shopify_checkout_products');
  if (id === 'ReadShopifyCheckout') inputs.checkout = { ...port(type, 'original_shopify_checkout', true), optional: true };
  return { id, version: '1', kind: create ? 'business' : 'source_read', effects: [create ? 'external_draft' : 'read'], resultTypes: [type],
    description: create ? 'Create exactly one real unpaid Shopify checkout for the independently read selected variants after exact nonfinancial draft authorization. No order, payment, customer information or saved wallet is submitted.' : id === 'ReadShopifyCheckoutProducts' ? 'Read selected variants at the configured merchant through official Shop MCP; verify exact seller, variant, price and availability before proposing creation.' : 'Read the original owned Shopify checkout by its private source identity. This never creates, updates, completes or pays a checkout. Old observations may identify the original checkout without claiming current status.',
    inputs: Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, value.kind === 'object' ? value.type : ''])), changes: [type, 'SourceReceipt'], submissionCriteria: ['same_owner', 'current_request_revision', 'configured_merchant', 'original_source_identity', ...(create ? ['exact_external_draft_authority', 'no_order_or_payment'] : ['read_only'])],
    ...(create ? { operation: { version: '1', effect: 'external_draft' as const, environment: 'live' as const, inputSchema: z.toJSONSchema(shopCheckoutActionSchemas[id]), resultType: type } } : { read: { version: '1', effect: 'read' as const, inputSchema: z.toJSONSchema(shopCheckoutActionSchemas[id]), resultType: type } }),
    composition: { version: '1', inputs, outputs: { result: port(type, id === 'ReadShopifyCheckoutProducts' ? 'shopify_checkout_products' : 'shopify_checkout_status'), ...(type === 'ShopifyCheckoutObservation' ? { identity: port(type, 'original_shopify_checkout', true) } : {}), citations: citationPort(type) }, checks: [], effectScope: { effects: [create ? 'external_draft' : 'read'], targetInputs: create ? ['scope', 'products'] : [], recovery: create ? { kind: 'original_intent', version: '1', effect: 'read' } : { kind: 'none' }, compensation: [] } },
  };
});
export const shopCheckoutFunctions: FunctionDefinition[] = [{ id: 'shopifyCheckoutObservationStatus', version: '1', inputTypes: ['ShopifyCheckoutProducts', 'ShopifyCheckoutObservation'], description: 'Verify current original Shop MCP evidence, task ownership and merchant/variant identity. Return current checkout facts without exposing the private key; preparation never proves an order, payment or fulfillment.' }];
