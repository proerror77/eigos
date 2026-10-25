import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { loadMcpReadModule } from './mcp-read.js';
import { objectRefSchema, type ActionDefinition, type ObjectTypeDefinition, type LinkDefinition, type PropertyDefinition, type FunctionDefinition } from './model.js';
import { didiPlaceSchema, didiPriceSchema, didiReceiptSchema } from '../capabilities/didi/contracts.js';
import { mockOrderReceiptSchema } from '../capabilities/didi/order-test-contracts.js';
export const orderTestModule = loadMcpReadModule(new URL('./definitions/didi-order-test.json', import.meta.url));
export const orderTestModuleRef = { id: orderTestModule.id, version: orderTestModule.version, digest: digest(orderTestModule) };
export const ORDER_TEST_REF = { id: 'ride.order.test', version: '1' } as const;
const text = z.string().min(1).max(500), sha = z.string().regex(/^[a-f0-9]{64}$/);
const scope = objectRefSchema.extend({ type: z.literal('DidiOrderTestTask') }), place = objectRefSchema.extend({ type: z.literal('DidiOrderTestPlaceObservation') }), quote = objectRefSchema.extend({ type: z.literal('DidiOrderTestQuote') }), order = objectRefSchema.extend({ type: z.literal('DidiTestOrderObservation') });
export const orderTestInputSchema = z.strictObject({ city: z.literal('北京市'), origin: z.literal('北京西站'), destination: z.literal('西二旗-地铁站'), serviceClass: z.literal('快车'), target: z.literal('created') });
export const orderTestActionSchemas = {
  SearchDidiTestPlaces: z.strictObject({ scope, role: z.enum(['origin', 'destination']) }),
  EstimateDidiTestOrder: z.strictObject({ scope, origin: place, originPlaceId: sha, destination: place, destinationPlaceId: sha }),
  CreateDidiTestOrder: z.strictObject({ scope, quote, productCategory: z.literal('1') }),
  QueryDidiTestOrder: z.strictObject({ scope, order }),
};
export type OrderTestAction = keyof typeof orderTestActionSchemas;
export const orderTestCompletionSchema = z.strictObject({ observation: objectRefSchema.extend({ type: z.literal('DidiTestOrderObservation') }), rationale: text });
export const orderTestDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('places'), role: z.enum(['origin', 'destination']), places: z.array(didiPlaceSchema).max(50) }),
  z.strictObject({ kind: z.literal('quote'), items: z.array(didiPriceSchema).min(1).max(50), traceDigest: sha, route: z.strictObject({ origin: didiPlaceSchema, destination: didiPlaceSchema }) }),
  z.strictObject({ kind: z.literal('created'), orderId: text, fromName: text, toName: text, status: z.literal('created'), productCategory: z.literal('1'), quote, creationIntentId: text }),
  z.strictObject({ kind: z.literal('status'), orderId: text, statusCode: z.number().int().min(0).max(12), statusText: text, encoding: z.enum(['structured', 'exact_mock_text']), identityEchoed: z.boolean(), original: order.optional(), quote, productCategory: z.literal('1'), creationIntentId: text }),
]);
export const orderTestSnapshotSchema = z.strictObject({
  id: z.uuid(), requestId: text, requestRevision: z.number().int().positive(), scope, configurationDigest: sha,
  action: z.enum(['SearchDidiTestPlaces', 'EstimateDidiTestOrder', 'CreateDidiTestOrder', 'QueryDidiTestOrder']), actionInput: z.record(z.string(), z.unknown()),
  planId: text, intentId: text, attemptId: text, modelRunId: text,
  receipt: z.union([didiReceiptSchema, mockOrderReceiptSchema]), evidenceKind: z.enum(['live_readonly', 'provider_mock', 'fixture']), data: orderTestDataSchema,
  observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), contentDigest: sha,
});
export type OrderTestSnapshot = z.infer<typeof orderTestSnapshotSchema>;
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Owned public map read or official Mock endpoint; never a real ride or charge' });
const base = { id: p('string', text, 'Immutable identity'), displayTitle: p('string', text, 'Safe label'), requestRevision: p('integer', z.number().int().positive(), 'Root request revision') };
export const orderTestTypes = ['DidiOrderTestPlaceObservation', 'DidiOrderTestQuote', 'DidiTestOrderObservation'] as const;
export const orderTestObjects: ObjectTypeDefinition[] = [
  { id: 'DidiOrderTestTask', version: '1', name: '滴滴官方测试下单', aliases: ['DidiOrderTestTask', '滴滴测试订单'], description: 'Official Mock fixed route and class; real maps only, no production ordering or payment', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...base, input: p('struct', orderTestInputSchema, 'Explicit official test scope'), configurationDigest: p('string', sha, 'Pinned read-only map and Mock order bindings') } },
  ...orderTestTypes.map(id => ({ id, version: '1', name: id, aliases: [id], description: 'Source-backed test observation; trace, phone and driver data are not exposed', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: { ...base, snapshot: p('struct', orderTestSnapshotSchema, 'Bound source receipt and sanitized data') } })),
];
export const orderTestLinks: LinkDefinition[] = [
  { id: 'DidiOrderTestTaskRequest', description: 'Owned test request', from: { type: 'DidiOrderTestTask', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'didiOrderTests', many: true } },
  ...orderTestTypes.flatMap(type => [
    { id: `${type}Request`, description: 'Owned request', from: { type, name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: `${type}Results`, many: true } },
    { id: `${type}Scope`, description: 'Pinned test scope', from: { type, name: 'scope', many: false, required: true }, to: { type: 'DidiOrderTestTask', name: type, many: true } },
    { id: `${type}Evidence`, description: 'Actual source receipt', from: { type, name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: `${type}Subjects`, many: true } },
  ]),
];
export const orderTestActions: ActionDefinition[] = [
  ...orderTestModule.actions.map(a => ({ id: a.id, description: a.description, inputs: { scope: 'DidiOrderTestTask' }, changes: [a.resultType], submissionCriteria: ['same_owner', 'current_request_revision', 'owned_source', 'no_real_order'], read: { version: '1', effect: 'read' as const, inputSchema: z.toJSONSchema(orderTestActionSchemas[a.id as OrderTestAction]), resultType: a.resultType, mcp: a.mcp, module: { ...orderTestModuleRef, completion: orderTestModule.completion } } })),
  { id: 'CreateDidiTestOrder', description: 'Create one official Mock order for the verified fixed route and 快车 estimate. Needs an exact sandbox permit after the quote is displayed; no production write branch. Unknown creation cannot be repeated.', inputs: { scope: 'DidiOrderTestTask', quote: 'DidiOrderTestQuote' }, changes: ['DidiTestOrderObservation'], submissionCriteria: ['same_owner', 'current_request_revision', 'fresh_owned_estimate', 'exact_sandbox_permit', 'mock_endpoint_only'], providerOperation: orderTestModule.externalResults![0]!.tool, operation: { version: '1', effect: 'order', environment: 'sandbox', inputSchema: z.toJSONSchema(orderTestActionSchemas.CreateDidiTestOrder), resultType: 'DidiTestOrderObservation' } },
];
export const orderTestFunctions: FunctionDefinition[] = [
  { id: 'didiOrderTestIdentity', version: '1', inputTypes: ['DidiTestOrderObservation'], description: 'Verify the historical owned order ID for an explicit refresh or recovery; never claim current order state or authority to create again' },
  { id: 'didiOrderTestStatus', version: '1', inputTypes: [...orderTestTypes], description: 'Verify original task, source receipt, Mock boundary and freshness. A returned order ID is not independent readback; matching is not driver acceptance or a real trip.' },
  { id: 'selectDidiOrderTestPlace', version: '1', inputTypes: ['DidiOrderTestPlaceObservation'], description: 'Select only a unique exact requested source name in the requested city; no first-result default or remembered coordinates.' },
];
