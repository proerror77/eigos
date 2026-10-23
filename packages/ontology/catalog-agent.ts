import { z } from 'zod';
import { catalogReadDefinition, catalogReadDefinitionRef } from './catalog-read-definition.js';
import { objectRefSchema, type ActionDefinition, type FunctionDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';
import { catalogReceiptSchema, shopifyMerchantSchema } from '../capabilities/shopify/contracts.js';

const text = z.string().min(1).max(1000), sha = z.string().regex(/^[a-f0-9]{64}$/), time = z.iso.datetime({ offset: true });
export const variantIdSchema = z.string().regex(/^gid:\/\/shopify\/ProductVariant\/[0-9]+$/);
const scope = objectRefSchema.extend({ type: z.literal('CatalogTask') });
const observation = objectRefSchema.extend({ type: z.literal('CatalogObservation') });
const endpoint = objectRefSchema.extend({ type: z.literal('CatalogEndpoint') });
const merchantId = shopifyMerchantSchema.shape.id;
export const catalogTaskInputSchema = z.strictObject({ merchantIds: z.array(merchantId).min(1).max(8), country: z.literal('US') });
export const catalogActionSchemas = {
  SearchPublicCatalog: z.strictObject({ scope, merchantId, query: z.string().trim().min(1).max(300), limit: z.number().int().min(1).max(10) }),
  InspectCatalogVariant: z.strictObject({ scope, merchantId, observation, variantId: variantIdSchema }),
  DiscoverMerchantCatalog: z.strictObject({ scope, merchantId }),
  ReadMerchantVariants: z.strictObject({ scope, merchantId, endpoint, variantIds: z.array(variantIdSchema).min(1).max(10), observation: observation.optional() }),
};
export type CatalogAction = keyof typeof catalogActionSchemas;
export const catalogActionIds = catalogReadDefinition.actions.map(a => a.id) as CatalogAction[];
export const catalogObservedItemSchema = z.strictObject({
  productId: text, variantId: variantIdSchema, title: text, sku: z.string().max(500).optional(),
  displayPrice: z.strictObject({ minor: z.string().regex(/^(0|[1-9]\d{0,17})$/), currency: z.string().regex(/^[A-Z]{3}$/) }).optional(),
  availableReported: z.boolean().optional(), nativeCheckoutEligibleReported: z.boolean().optional(),
});
export const catalogObservationSchema = z.strictObject({
  id: text, requestId: text, requestRevision: z.number().int().positive(), configurationDigest: sha,
  action: z.enum(Object.keys(catalogActionSchemas) as [CatalogAction, ...CatalogAction[]]), actionInput: z.record(z.string(), z.unknown()),
  planId: text, intentId: text, attemptId: text, modelRunId: text,
  scope, merchant: shopifyMerchantSchema, country: z.literal('US'),
  evidenceKind: z.enum(['live_readonly', 'fixture']), receipt: catalogReceiptSchema,
  observedAt: time, expiresAt: time, validityBasis: z.literal('local_refresh_limit'),
  items: z.array(catalogObservedItemSchema).max(40), profile: z.record(z.string(), z.unknown()).optional(),
  completeness: z.literal('partial_or_unknown'), stockQuantity: z.literal('unknown'), deliveryCommitment: z.literal('unknown'), partnerTrust: z.literal('unverified'),
  noBusinessWrites: z.literal(true), contentDigest: sha,
});
export type CatalogObservation = z.infer<typeof catalogObservationSchema>;
export const catalogCompletionSchema = z.strictObject({
  selections: z.array(z.strictObject({ observation, variantIds: z.array(variantIdSchema).min(1).max(10) })).min(1).max(8),
  rationale: z.string().min(1).max(2000),
});

const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Trusted task scope or validated single source response and its exact agent action' });
const base = { id: p('string', text, 'Immutable identity'), displayTitle: p('string', text, 'Business label'), requestRevision: p('integer', z.number().int().positive(), 'Owning request revision') };
export const catalogAgentObjects: ObjectTypeDefinition[] = [
  { id: 'CatalogTask', version: '1', name: '商品查询任务', aliases: ['CatalogTask', '商品查询范围'], description: 'Agent scope: authorized merchants and market, without any predefined query, selected product or action order', primaryKey: 'id', titleKey: 'displayTitle',
    properties: { ...base, input: p('struct', catalogTaskInputSchema, 'Merchant and market scope selected from the goal'), merchants: p('array', z.array(shopifyMerchantSchema).min(1).max(8), 'Configured canonical merchant identities'), configurationDigest: p('string', sha, 'Exact execution binding'), allowedActions: p('array', z.array(z.string()).max(4), 'Explicitly bound read actions; definitions alone grant no execution') } },
  ...(['CatalogObservation', 'CatalogEndpoint'] as const).map(id => ({ id, version: '1', name: id === 'CatalogObservation' ? '商品观察' : '商家目录端点', aliases: [id], description: id === 'CatalogObservation' ? 'Immutable facts from one model-selected read; freshness and source must be evaluated before use' : 'A fresh, source-verified merchant discovery document; conveys no checkout or payment authority', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }],
    properties: { ...base, snapshot: p('struct', catalogObservationSchema, 'Exact action, source receipt, facts and explicit unknowns') } })),
];
export const catalogAgentLinks: LinkDefinition[] = [
  { id: 'CatalogTaskRequest', description: 'Catalog scope belongs to one task revision', from: { type: 'CatalogTask', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'catalogTasks', many: true } },
  ...(['CatalogObservation', 'CatalogEndpoint'] as const).flatMap(type => [
    { id: `${type}Request`, description: 'Source observation belongs to this request', from: { type, name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: type === 'CatalogObservation' ? 'catalogObservations' : 'catalogEndpoints', many: true } },
    { id: `${type}Task`, description: 'Fixed merchant and market scope for this observation', from: { type, name: 'scope', many: false, required: true }, to: { type: 'CatalogTask', name: type === 'CatalogObservation' ? 'observations' : 'endpoints', many: true } },
    { id: `${type}Evidence`, description: 'Receipt binds source and normalized observation', from: { type, name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: type === 'CatalogObservation' ? 'catalogObservations' : 'catalogEndpoints', many: true } },
  ]),
  { id: 'CatalogObservationOffers', description: 'Display-price offers from this exact read', from: { type: 'CatalogObservation', name: 'offers', many: true }, to: { type: 'ProductOffer', name: 'catalogObservation', many: false } },
];
export const catalogAgentActions: ActionDefinition[] = catalogReadDefinition.actions.map(action => {
  if (!Object.hasOwn(catalogActionSchemas, action.id)) throw new Error('Unknown catalog data contract');
  return { id: action.id, description: action.description, inputs: { scope: 'CatalogTask' }, changes: [action.resultType],
    submissionCriteria: ['same_owner', 'current_request_revision', 'configured_merchant', 'source_bound_inputs', 'read_only'],
    read: { version: catalogReadDefinition.version, effect: 'read', inputSchema: z.toJSONSchema(catalogActionSchemas[action.id as CatalogAction]), resultType: action.resultType,
      mcp: action.mcp, module: { ...catalogReadDefinitionRef, completion: catalogReadDefinition.completion } } };
});
export const catalogAgentFunctions: FunctionDefinition[] = [
  { id: 'catalogObservationStatus', version: '1', inputTypes: ['CatalogObservation', 'CatalogEndpoint'], description: 'Validate a single observation\'s identity, source, relationships and freshness; return its facts and explicit unknowns. A known empty observation is partial evidence, never proof of complete absence.' },
];
