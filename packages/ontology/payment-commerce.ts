import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { commerceProviderSchema, commerceQuerySchema } from '../capabilities/payment-commerce/contracts.js';
import { objectRefSchema, type ObjectTypeDefinition, type LinkDefinition, type ActionDefinition, type FunctionDefinition, type PropertyDefinition } from './model.js';
import { loadMcpReadModule, mcpReadModuleRef } from './mcp-read.js';

export const commerceReadDefinition = loadMcpReadModule(new URL('./definitions/payment-commerce-readonly.json', import.meta.url));
export const commerceReadModule = mcpReadModuleRef(commerceReadDefinition);
export const commerceReadActionSchema = z.strictObject({ scope: objectRefSchema.extend({ type: z.literal('PaymentCommerceReadTask') }) });
const text = z.string().min(1).max(500), sha = z.string().regex(/^[a-f0-9]{64}$/);
export const commerceReadSnapshotSchema = z.strictObject({
  id: z.uuid(), provider: commerceProviderSchema, requestId: text, requestRevision: z.number().int().positive(), configurationDigest: sha,
  scope: commerceReadActionSchema.shape.scope, actionInput: commerceReadActionSchema,
  planId: text, intentId: text, attemptId: text, modelRunId: text,
  query: commerceQuerySchema, result: z.record(z.string(), z.unknown()), observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  evidenceKind: z.enum(['live_readonly', 'provider_mock', 'fixture']), contentDigest: sha,
});
export function checkedCommerceRead(value: unknown) {
  const snapshot = commerceReadSnapshotSchema.parse(value), { contentDigest, ...body } = snapshot;
  if (digest(body) !== contentDigest || digest(snapshot.scope) !== digest(snapshot.actionInput.scope)
    || Date.parse(snapshot.expiresAt) !== Date.parse(snapshot.observedAt) + 300000) throw new Error('Invalid payment/commerce read snapshot');
  return snapshot;
}
const property = (kind: PropertyDefinition['kind'], schema: z.ZodType): PropertyDefinition => ({ kind, schema, description: 'Owned provider query or validated read observation', required: true, source: 'Payment and commerce read-only connector' });
const base = { id: property('string', text), displayTitle: property('string', text), requestRevision: property('integer', z.number().int().positive()) };
export const commerceReadObjects: ObjectTypeDefinition[] = [
  { id: 'PaymentCommerceReadTask', version: '1', name: '支付与商品查询', aliases: ['PaymentCommerceReadTask'], description: 'One fixed provider and read operation; never authorizes a transaction', primaryKey: 'id', titleKey: 'displayTitle',
    properties: { ...base, provider: property('string', commerceProviderSchema), input: property('struct', commerceQuerySchema), allowedActions: property('array', z.array(z.string().min(1).max(100)).min(1).max(2)), configurationDigest: property('string', sha) } },
  { id: 'PaymentCommerceReadObservation', version: '1', name: '支付与商品查询观察', aliases: ['PaymentCommerceReadObservation'], description: 'Source-reported trade state or reference catalog data; no payment or fulfillment claim', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }],
    properties: { ...base, snapshot: property('struct', commerceReadSnapshotSchema) } },
];
export const commerceReadLinks: LinkDefinition[] = [
  { id: 'PaymentCommerceTaskRequest', description: 'Current owned request', from: { type: 'PaymentCommerceReadTask', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'paymentCommerceQueries', many: true } },
  ...([{ name: 'request', type: 'ServiceRequest' }, { name: 'scope', type: 'PaymentCommerceReadTask' }, { name: 'sourceReceipts', type: 'SourceReceipt' }] as const).map(target => ({
    id: `PaymentCommerceObservation${target.name}`, description: 'Exact query and source provenance',
    from: { type: 'PaymentCommerceReadObservation', name: target.name, many: target.name === 'sourceReceipts', required: true }, to: { type: target.type, name: 'paymentCommerceResults', many: true },
  })),
];
export const commerceReadActions: ActionDefinition[] = commerceReadDefinition.actions.map(action => ({
  id: action.id, description: action.description, inputs: { scope: 'PaymentCommerceReadTask' }, changes: [action.resultType], submissionCriteria: ['same_owner', 'current_request_revision', 'read_only'],
  read: { version: '1', effect: 'read', inputSchema: z.toJSONSchema(commerceReadActionSchema), resultType: action.resultType, mcp: action.mcp, module: { ...commerceReadModule, completion: commerceReadDefinition.completion } },
}));
export const commerceReadFunctions: FunctionDefinition[] = [{ id: 'paymentCommerceReadStatus', version: '1', inputTypes: ['PaymentCommerceReadObservation'], description: 'Verify the original provider query, current request revision, source proof and local freshness; never infer payment completion' }];
