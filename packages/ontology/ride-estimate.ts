import { z } from 'zod';
import { objectRefSchema, type ObjectTypeDefinition, type PropertyDefinition, type LinkDefinition, type ActionDefinition, type FunctionDefinition } from './model.js';
import { didiDataSchema, didiPlaceSchema, didiReceiptSchema } from '../capabilities/didi/contracts.js';
import { didiReadDefinition, didiReadDefinitionRef } from './didi-read-definition.js';

const text = z.string().min(1).max(500), sha = z.string().regex(/^[a-f0-9]{64}$/);
const scope = objectRefSchema.extend({ type: z.literal('RideEstimateTask') });
const places = objectRefSchema.extend({ type: z.literal('DidiPlaceObservation') });
export const rideEstimateInputSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('places'), city: text, keywords: text }),
  z.strictObject({ mode: z.literal('estimate'), city: text, origin: text, destination: text, serviceClass: text.optional() }),
]);
export const rideEstimateActionSchemas = {
  SearchDidiPlaces: z.strictObject({ scope, role: z.enum(['search', 'origin', 'destination']), keywords: text }),
  EstimateDidiRide: z.strictObject({ scope, originObservation: places, originPlaceId: sha, destinationObservation: places, destinationPlaceId: sha }),
};
export type RideEstimateAction = keyof typeof rideEstimateActionSchemas;
export const rideEstimateActionIds = didiReadDefinition.actions.map(action => action.id) as RideEstimateAction[];
export const rideEstimateObservationSchema = z.strictObject({
  id: z.uuid(), requestId: text, requestRevision: z.number().int().positive(), configurationDigest: sha,
  scope, action: z.enum(['SearchDidiPlaces', 'EstimateDidiRide']), actionInput: z.record(z.string(), z.unknown()),
  planId: text, intentId: text, attemptId: text, modelRunId: text,
  receipt: didiReceiptSchema, evidenceKind: z.enum(['live_readonly', 'provider_mock', 'fixture']), data: didiDataSchema,
  route: z.strictObject({ origin: didiPlaceSchema, destination: didiPlaceSchema }).optional(),
  observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), validityBasis: z.literal('local_refresh_limit'),
  noBusinessWrites: z.literal(true), contentDigest: sha,
});
export type RideEstimateObservation = z.infer<typeof rideEstimateObservationSchema>;
export const rideEstimateCompletionSchema = z.strictObject({ observation: objectRefSchema, rationale: z.string().min(1).max(2000) });
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Exact task scope or validated DiDi read; no inferred ride outcome' });
const base = { id: p('string', text, 'Local immutable snapshot identity'), displayTitle: p('string', text, 'Display label'), requestRevision: p('integer', z.number().int().positive(), 'Owning request revision') };
export const rideEstimateObjects: ObjectTypeDefinition[] = [
  { id: 'RideEstimateTask', version: '1', name: '滴滴地点与估价任务', aliases: ['RideEstimateTask', '滴滴查询'], description: 'Read-only scope; no passenger count, full budget, pickup deadline or trip is invented', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...base, input: p('struct', rideEstimateInputSchema, 'User route or place-search goal'), configurationDigest: p('string', sha, 'Private account and environment binding'), allowedActions: p('array', z.array(z.string()).max(2), 'Only these read actions may execute') } },
  ...(['DidiPlaceObservation', 'RideEstimateObservation'] as const).map(id => ({ id, version: '1', name: id === 'DidiPlaceObservation' ? '滴滴地点观察' : '滴滴车型估价观察', aliases: [id], description: 'One immutable, source-bound read. Estimates are not full fares, offers, orders or completed trips.', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: { ...base, snapshot: p('struct', rideEstimateObservationSchema, 'Normalized source result and exact action receipt; no Key or estimate traceId') } })),
];
export const rideEstimateLinks: LinkDefinition[] = [
  { id: 'RideEstimateTaskRequest', description: 'Query scope belongs to one request', from: { type: 'RideEstimateTask', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'rideEstimateTasks', many: true } },
  ...(['DidiPlaceObservation', 'RideEstimateObservation'] as const).flatMap(type => [
    { id: `${type}Request`, description: 'Observation request', from: { type, name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: `${type}Results`, many: true } },
    { id: `${type}Scope`, description: 'Exact account and task scope', from: { type, name: 'scope', many: false, required: true }, to: { type: 'RideEstimateTask', name: `${type}Observations`, many: true } },
    { id: `${type}Evidence`, description: 'Source receipt for this snapshot', from: { type, name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: `${type}Subjects`, many: true } },
    { id: `${type}Provider`, description: 'Official DiDi MCP source', from: { type, name: 'provider', many: false, required: true }, to: { type: 'Provider', name: `${type}Observations`, many: true } },
  ]),
  { id: 'RideEstimateRoute', description: 'Names and coordinates remain in the source snapshot; no inferred coordinate reference system', from: { type: 'RideEstimateObservation', name: 'route', many: false, required: true }, to: { type: 'RideRoute', name: 'estimates', many: true } },
  ...(['Origin', 'Destination'] as const).map(role => ({ id: `RideEstimate${role}Search`, description: 'Coordinates come from this task\'s accepted place search', from: { type: 'RideEstimateObservation', name: `${role.toLowerCase()}Search`, many: false, required: true }, to: { type: 'DidiPlaceObservation', name: `${role.toLowerCase()}Estimates`, many: true } })),
];
export const rideEstimateActions: ActionDefinition[] = didiReadDefinition.actions.map(action => {
  if (!Object.hasOwn(rideEstimateActionSchemas, action.id)) throw new Error('Ontology action has no supported DiDi data contract');
  return { id: action.id, description: action.description, inputs: { scope: 'RideEstimateTask' }, changes: [action.resultType],
    submissionCriteria: ['same_owner', 'current_request_revision', 'source_bound_coordinates', 'read_only'],
    read: { version: didiReadDefinition.version, effect: 'read', inputSchema: z.toJSONSchema(rideEstimateActionSchemas[action.id as RideEstimateAction]), resultType: action.resultType,
      mcp: action.mcp, module: { ...didiReadDefinitionRef, completion: didiReadDefinition.completion } } };
});
export const rideEstimateFunctions: FunctionDefinition[] = [{ id: 'rideEstimateStatus', version: '1', inputTypes: ['DidiPlaceObservation', 'RideEstimateObservation'], description: 'Check source, route, request revision and local freshness. A known estimate is only a read result; fees, availability, pickup and arrival commitments remain unknown.' }];
