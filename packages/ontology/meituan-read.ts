import { z } from 'zod';
import { objectRefSchema, type ActionDefinition, type FunctionDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';
import { meituanPrimitiveReceiptSchema } from '../capabilities/meituan-primitives.js';
import { paotuiPublicPlaceSchema } from '../capabilities/paotui-public-locations.js';
import { meituanReadDefinition, meituanReadDefinitionRef } from './meituan-read-definition.js';

const text = z.string().min(1).max(1000), sha = z.string().regex(/^[a-f0-9]{64}$/);
export const meituanScopeRef = objectRefSchema.extend({ type: z.literal('MeituanReadTask') });
export const meituanObservationRef = objectRefSchema.extend({ type: z.literal('MeituanReadObservation') });
export const meituanActionSchemas = {
  SearchMeituanLocations: z.strictObject({ scope: meituanScopeRef }),
  ReadMeituanAddresses: z.strictObject({ scope: meituanScopeRef }),
  ReadMeituanSenderDetails: z.strictObject({ scope: meituanScopeRef, addresses: meituanObservationRef }),
  ReadMeituanRecipientDetails: z.strictObject({ scope: meituanScopeRef, addresses: meituanObservationRef }),
  EstimateMeituanDelivery: z.strictObject({ scope: meituanScopeRef, addresses: meituanObservationRef, sender: meituanObservationRef, recipient: meituanObservationRef }),
};
export type MeituanReadAction = keyof typeof meituanActionSchemas;
export const meituanSafeDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('locations'), places: z.array(paotuiPublicPlaceSchema).max(100) }),
  z.strictObject({ kind: z.literal('addresses'), count: z.number().int().min(0).max(100), selectionReady: z.boolean() }),
  z.strictObject({ kind: z.literal('address_detail'), role: z.enum(['sender', 'recipient']), selectionReady: z.literal(true) }),
  z.strictObject({ kind: z.literal('quote'), total: z.strictObject({ minor: z.string().regex(/^(0|[1-9]\d{0,17})$/), currency: z.literal('CNY') }), goodsName: text, category: z.enum(['文件', '快递', '餐饮']), weightKg: z.number().positive().max(50), service: z.enum(['ordinary', 'express']) }),
]);
export const meituanSnapshotSchema = z.strictObject({
  id: z.uuid(), requestId: text, requestRevision: z.number().int().positive(), configurationDigest: sha,
  scope: meituanScopeRef, action: z.enum(Object.keys(meituanActionSchemas) as [MeituanReadAction, ...MeituanReadAction[]]), actionInput: z.record(z.string(), z.unknown()),
  planId: text, intentId: text, attemptId: text, modelRunId: text,
  receipt: meituanPrimitiveReceiptSchema, data: meituanSafeDataSchema, dependencies: z.array(meituanObservationRef).max(8),
  observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), noBusinessWrites: z.literal(true), contentDigest: sha,
});
export type MeituanReadSnapshot = z.infer<typeof meituanSnapshotSchema>;
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Owned task or single validated Meituan read; private contacts never enter model context' });
const base = { id: p('string', text, 'Immutable local identity'), displayTitle: p('string', text, 'Non-private display label'), requestRevision: p('integer', z.number().int().positive(), 'Owning request revision') };
export const meituanReadObjects: ObjectTypeDefinition[] = [
  { id: 'MeituanReadTask', version: '1', name: '美团只读任务', aliases: ['MeituanReadTask', '美团查询'], description: 'Pure task scope. No source preparation or implicit address/quote sequence.', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...base, input: p('struct', z.record(z.string(), z.unknown()), 'Exact scoped business goal'), configurationDigest: p('string', sha, 'Pinned private binding and independent ontology module'), allowedActions: p('array', z.array(z.string()).max(5), 'Only read actions permitted for this purpose') } },
  { id: 'MeituanReadObservation', version: '1', name: '美团只读观察', aliases: ['MeituanReadObservation'], description: 'Source-backed safe facts, without private address options or phone numbers. A valid read is not a quote/order/payment outcome by itself.', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: { ...base, snapshot: p('struct', meituanSnapshotSchema, 'Sanitized source observation and attempt identity') } },
];
export const meituanReadLinks: LinkDefinition[] = [
  { id: 'MeituanTaskRequest', description: 'Owning task revision', from: { type: 'MeituanReadTask', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'meituanTasks', many: true } },
  { id: 'MeituanObservationRequest', description: 'Observation belongs to this request', from: { type: 'MeituanReadObservation', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'meituanObservations', many: true } },
  { id: 'MeituanObservationScope', description: 'Exact read scope', from: { type: 'MeituanReadObservation', name: 'scope', many: false, required: true }, to: { type: 'MeituanReadTask', name: 'observations', many: true } },
  { id: 'MeituanObservationEvidence', description: 'Sanitized facts sealed by the source mapper', from: { type: 'MeituanReadObservation', name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: 'meituanSubjects', many: true } },
  { id: 'MeituanObservationDependency', description: 'Accepted source dependencies, never an automatic execution recipe', from: { type: 'MeituanReadObservation', name: 'dependencies', many: true }, to: { type: 'MeituanReadObservation', name: 'consumers', many: true } },
];
export const meituanReadActions: ActionDefinition[] = meituanReadDefinition.actions.map(action => {
  if (!Object.hasOwn(meituanActionSchemas, action.id)) throw new Error('Unknown Meituan input contract');
  return { id: action.id, description: action.description, inputs: { scope: 'MeituanReadTask' }, changes: [action.resultType], submissionCriteria: ['same_owner', 'current_request_revision', 'explicit_private_selection', 'source_bound_inputs', 'read_only'],
    read: { version: meituanReadDefinition.version, effect: 'read', inputSchema: z.toJSONSchema(meituanActionSchemas[action.id as MeituanReadAction]), resultType: action.resultType, mcp: action.mcp, module: { ...meituanReadDefinitionRef, completion: meituanReadDefinition.completion } } };
});
export const meituanReadFunctions: FunctionDefinition[] = [{ id: 'meituanReadStatus', version: '1', inputTypes: ['MeituanReadObservation'], description: 'Check current owned source evidence and declared dependency observations. Missing private selections stay incomplete; no order or payment can be inferred.' }];
