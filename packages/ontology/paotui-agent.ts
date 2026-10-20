import { z } from 'zod';
import { objectRefSchema, type ActionDefinition, type FunctionDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';
import { atomicReceiptSchema, parcelInputSchema } from '../capabilities/paotui-atomic.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(200);
const scope = objectRefSchema.extend({ type: z.literal('PaotuiTask') }), observation = objectRefSchema.extend({ type: z.literal('PaotuiObservation') });
const parcel = objectRefSchema.extend({ type: z.literal('Parcel') }), route = objectRefSchema.extend({ type: z.literal('DeliveryRoute') });
export const paotuiTaskInputSchema = z.strictObject({ goodsName: parcelInputSchema.shape.goodsName.optional() });
export const paotuiActionSchemas = {
  ReadSavedAddresses: z.strictObject({ scope }),
  ReadSavedAddressDetail: z.strictObject({ scope, book: observation, selector: z.string().trim().min(1).max(200), role: z.enum(['sender', 'recipient']) }),
  PreviewDeliveryQuote: z.strictObject({ scope, parcel, route, sender: observation, recipient: observation }),
};
/** Decoder only: old completed source records are never rewritten or replayed. */
export const legacyPaotuiActionSchemas = { ...paotuiActionSchemas, PreviewDeliveryQuote: z.strictObject({ scope, sender: observation, recipient: observation, ...parcelInputSchema.shape }) };
const snapshot = z.strictObject({ ref: objectRefSchema, revision: z.number().int().positive(), propertiesDigest: sha, linksDigest: sha });
export const paotuiQuoteContextSchema = z.strictObject({
  parcel: snapshot.extend({ ref: parcel }), route: snapshot.extend({ ref: route }),
  senderAddress: snapshot.extend({ ref: objectRefSchema.extend({ type: z.literal('SavedAddress') }) }),
  recipientAddress: snapshot.extend({ ref: objectRefSchema.extend({ type: z.literal('SavedAddress') }) }),
  provider: objectRefSchema.extend({ type: z.literal('Provider') }), channel: objectRefSchema.extend({ type: z.literal('Channel') }),
  facts: parcelInputSchema, serviceDigest: sha,
});
export type PaotuiQuoteContext = z.infer<typeof paotuiQuoteContextSchema>;
export type PaotuiAction = keyof typeof paotuiActionSchemas;
export const paotuiActionIds = Object.keys(paotuiActionSchemas) as [PaotuiAction, ...PaotuiAction[]];
export const paotuiSummarySchema = z.strictObject({ action: z.enum(paotuiActionIds), count: z.number().int().min(0).max(100).optional(), role: z.enum(['sender', 'recipient']).optional(),
  totalPrice: z.strictObject({ minor: z.string().regex(/^\d+$/), currency: z.literal('CNY') }).optional(), weightKg: z.number().positive().optional(), service: z.enum(['ordinary', 'express']).optional(),
  observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), noOrder: z.literal(true), noPayment: z.literal(true) });
export const paotuiObservationSchema = z.strictObject({
  id: text, requestId: text, requestRevision: z.number().int().positive(), configurationDigest: sha, connectionDigest: sha,
  action: z.enum(paotuiActionIds), actionInput: z.record(z.string(), z.unknown()), scope,
  planId: text, intentId: text, attemptId: text, modelRunId: text,
  receipt: atomicReceiptSchema, providerInput: z.record(z.string(), z.unknown()), result: z.record(z.string(), z.unknown()),
  summary: paotuiSummarySchema, contentDigest: sha, inputState: paotuiQuoteContextSchema.optional(),
});
export type PaotuiObservation = z.infer<typeof paotuiObservationSchema>;
export const paotuiCompletionSchema = z.strictObject({ observation, rationale: z.string().min(1).max(2000) });
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string, restricted = false): PropertyDefinition => ({ kind, schema, description, restricted, required: true, source: 'Owned task scope or exact model-selected single source read' });
const base = { id: p('string', text, 'Immutable identity'), displayTitle: p('string', text, 'Safe business title'), requestRevision: p('integer', z.number().int().positive(), 'Owning request revision') };
export const paotuiAgentObjects: ObjectTypeDefinition[] = [
  { id: 'PaotuiTask', version: '1', name: '美团只读任务', aliases: ['PaotuiTask', '美团查询范围'], description: 'An owned, read-only source scope. The model selects address-book reads, explicitly requested address details, and quote previews. No workflow is preselected.', primaryKey: 'id', titleKey: 'displayTitle', visibility: 'technical',
    properties: { ...base, configurationDigest: p('string', sha, 'Program binding'), connectionDigest: p('string', sha, 'Pinned owned source revision'), outcome: p('string', z.enum(['quote', 'addresses']), 'Requested result'), allowedActions: p('array', z.array(z.string()).max(3), 'Bound read actions'), privateContext: p('struct', z.record(z.string(), z.unknown()), 'Private credential grant metadata; contains no token and cannot be queried by a model', true) } },
  { id: 'PaotuiObservation', version: '1', name: '美团只读观察', aliases: ['PaotuiObservation'], description: 'One source read with a safe summary. Full addresses, contact details and provider IDs remain private. Evaluate paotuiObservationStatus before using this observation.', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }],
    properties: { ...base, summary: p('struct', paotuiSummarySchema, 'Safe result and validity window'), privateSnapshot: p('struct', z.record(z.string(), z.unknown()), 'Private exact source response and action provenance', true) } },
];
export const paotuiAgentLinks: LinkDefinition[] = [
  { id: 'PaotuiTaskRequest', description: 'Owned task revision', from: { type: 'PaotuiTask', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'paotuiTasks', many: true } },
  { id: 'PaotuiObservationRequest', description: 'Observation belongs to this request', from: { type: 'PaotuiObservation', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'paotuiObservations', many: true } },
  { id: 'PaotuiObservationTask', description: 'Pinned source scope', from: { type: 'PaotuiObservation', name: 'scope', many: false, required: true }, to: { type: 'PaotuiTask', name: 'observations', many: true } },
  { id: 'PaotuiObservationEvidence', description: 'Validated single-read source receipt', from: { type: 'PaotuiObservation', name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: 'paotuiObservations', many: true } },
  { id: 'PaotuiObservationQuote', description: 'Typed quote from this preview', from: { type: 'PaotuiObservation', name: 'quote', many: false }, to: { type: 'DeliveryQuote', name: 'paotuiObservation', many: false } },
  { id: 'PaotuiTaskParcel', description: 'Current owner-declared parcel; completeness is checked before pricing', from: { type: 'PaotuiTask', name: 'parcel', many: false }, to: { type: 'Parcel', name: 'paotuiTasks', many: true } },
  { id: 'PaotuiTaskRoute', description: 'Current route identity, including incomplete selections', from: { type: 'PaotuiTask', name: 'route', many: false }, to: { type: 'DeliveryRoute', name: 'paotuiTasks', many: true } },
  { id: 'PaotuiTaskProvider', description: 'Stable source provider; not proof of order or fulfillment authority', from: { type: 'PaotuiTask', name: 'provider', many: false }, to: { type: 'Provider', name: 'paotuiTasks', many: true } },
  { id: 'PaotuiTaskChannel', description: 'Stable owned read channel; current authority remains pinned by the task scope', from: { type: 'PaotuiTask', name: 'channel', many: false }, to: { type: 'Channel', name: 'paotuiTasks', many: true } },
  { id: 'PaotuiObservationAddresses', description: 'Owned saved address identities observed in this immutable book read', from: { type: 'PaotuiObservation', name: 'addresses', many: true }, to: { type: 'SavedAddress', name: 'bookObservations', many: true } },
  { id: 'PaotuiObservationAddress', description: 'Owned saved address whose private detail was read', from: { type: 'PaotuiObservation', name: 'address', many: false }, to: { type: 'SavedAddress', name: 'detailObservations', many: true } },
];
const descriptions: Record<PaotuiAction, string> = {
  ReadSavedAddresses: 'Read the owner\'s address book once. Returns only a count to the model. To let the owner choose, issue a clarify decision with [[saved_addresses]]; the host displays private choices only in the owned task response.',
  ReadSavedAddressDetail: 'Read one saved address\'s contact detail once. Supply an exact user-supplied address name or previously displayed choice label and its sender/recipient role. The host resolves it uniquely within the referenced current book; model-invented or ambiguous choices are rejected. No book or quote call is implied.',
  PreviewDeliveryQuote: 'Read one fee preview for the current Parcel and selected DeliveryRoute references, with two evidenced, user-selected address details. Read their owned relationships first. Parcel facts and the current request service are materialized from Ontology; do not restate them as action arguments. The private connector materializes contacts. This action does not read the book or details and cannot create orders or payments.',
};
const actionInputs: Record<PaotuiAction, Record<string, string>> = {
  ReadSavedAddresses: { scope: 'PaotuiTask' },
  ReadSavedAddressDetail: { scope: 'PaotuiTask', book: 'PaotuiObservation' },
  PreviewDeliveryQuote: { scope: 'PaotuiTask', parcel: 'Parcel', route: 'DeliveryRoute', sender: 'PaotuiObservation', recipient: 'PaotuiObservation' },
};
const actionChanges: Record<PaotuiAction, string[]> = {
  ReadSavedAddresses: ['PaotuiObservation', 'SourceReceipt', 'SavedAddress', 'DeliveryRoute', 'ServiceRequest.selectedRoute'],
  ReadSavedAddressDetail: ['PaotuiObservation', 'SourceReceipt'],
  PreviewDeliveryQuote: ['PaotuiObservation', 'SourceReceipt', 'DeliveryQuote'],
};
export const paotuiAgentActions: ActionDefinition[] = paotuiActionIds.map(id => ({ id, description: descriptions[id], inputs: actionInputs[id], changes: actionChanges[id], submissionCriteria: ['same_owner', 'current_request_revision', 'current_source_grant', 'user_selected_addresses', 'read_only'], read: { version: '2', effect: 'read', inputSchema: z.toJSONSchema(paotuiActionSchemas[id]), resultType: 'PaotuiObservation' } }));
export const paotuiAgentFunctions: FunctionDefinition[] = [{ id: 'paotuiObservationStatus', version: '1', inputTypes: ['PaotuiObservation'], description: 'Verify immutable source content, owned task relationships, and freshness; return only safe summary fields. Source connection authority is rechecked separately before each action and completion.' }];
