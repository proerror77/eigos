import { z } from 'zod';
import { digest } from '../core/delegation.js';
import {
  objectRefSchema,
  type ObjectTypeDefinition,
  type PropertyDefinition,
  type LinkDefinition,
  type ActionDefinition,
  type FunctionDefinition,
} from './model.js';
import {
  flightInputSchema,
  flightDataSchema,
} from '../capabilities/rollinggo-flight/contracts.js';
import { airportSchema, flightSegmentSchema, flightOptionSchema } from '../capabilities/rollinggo-flight/contracts.js';
import { sharedBusinessProperties as shared } from './shared-business-interfaces.js';
import { loadMcpReadModule, mcpReadModuleRef } from './mcp-read.js';
export const rollingGoFlightDefinition = loadMcpReadModule(
  new URL('./definitions/rollinggo-flight-readonly.json', import.meta.url),
);
export const rollingGoFlightModule = mcpReadModuleRef(rollingGoFlightDefinition);
export const rollingGoFlightActionSchema = z.strictObject({
  scope: objectRefSchema.extend({ type: z.literal('RollingGoFlightTask') }),
});
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  text = z.string().min(1).max(500);
export const rollingGoFlightObservationSchema = z.strictObject({
  id: z.uuid(),
  requestId: text,
  requestRevision: z.number().int().positive(),
  configurationDigest: sha,
  scope: rollingGoFlightActionSchema.shape.scope,
  actionInput: rollingGoFlightActionSchema,
  planId: text,
  intentId: text,
  attemptId: text,
  modelRunId: text,
  input: flightInputSchema,
  data: flightDataSchema,
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  evidenceKind: z.enum(['live_readonly', 'fixture']),
  contentDigest: sha,
});
export function checkedRollingGoFlight(value: unknown) {
  const s = rollingGoFlightObservationSchema.parse(value),
    { contentDigest, ...body } = s;
  if (
    digest(body) !== contentDigest ||
    digest(s.scope) !== digest(s.actionInput.scope) ||
    s.data.kind !== s.input.kind ||
    Date.parse(s.expiresAt) !== Date.parse(s.observedAt) + 300000
  )
    throw new Error('INVALID_ROLLINGGO_OBSERVATION');
  return s;
}
const p = (
  kind: PropertyDefinition['kind'],
  schema: z.ZodType,
): PropertyDefinition => ({
  kind,
  schema,
  description: 'Owned flight search scope or validated source observation',
  required: true,
  source: 'RollingGo flight read-only search',
});
const base = {
  id: p('string', text),
  displayTitle: p('string', text),
  requestRevision: p('integer', z.number().int().positive()),
};
export const rollingGoFlightObjects: ObjectTypeDefinition[] = [
  {
    id: 'RollingGoFlightTask',
    version: '1',
    name: 'RollingGo flight search task',
    aliases: ['RollingGoFlightTask'],
    description: 'Fixed flight search criteria',
    primaryKey: 'id',
    titleKey: 'displayTitle',
    properties: {
      ...base,
      input: p('struct', flightInputSchema),
      allowedActions: p('array', z.array(z.enum(['SearchRollingGoAirports', 'SearchRollingGoOneWayFlights', 'SearchRollingGoRoundTripFlights']))),
      configurationDigest: p('string', sha),
    },
  },
  {
    id: 'RollingGoFlightObservation',
    version: '1',
    name: 'RollingGo flight search observation',
    aliases: ['RollingGoFlightObservation'],
    description:
      'Reference flight prices, no reservation or confirmed availability',
    primaryKey: 'id',
    titleKey: 'displayTitle',
    interfaces: [{ id: 'EvidenceBacked' }],
    properties: { ...base, snapshot: p('struct', rollingGoFlightObservationSchema) },
  },
];
export const rollingGoFlightLinks: LinkDefinition[] = [
  {
    id: 'RollingGoFlightTaskRequest',
    description: 'Owned task',
    from: {
      type: 'RollingGoFlightTask',
      name: 'request',
      many: false,
      required: true,
    },
    to: { type: 'ServiceRequest', name: 'flightSearchTasks', many: true },
  },
  ...(
    [
      { name: 'request', type: 'ServiceRequest' },
      { name: 'scope', type: 'RollingGoFlightTask' },
      { name: 'sourceReceipts', type: 'SourceReceipt' },
    ] as const
  ).map((x) => ({
    id: `RollingGoFlightObservation${x.name}`,
    description: 'Bound search provenance',
    from: {
      type: 'RollingGoFlightObservation',
      name: x.name,
      many: x.name === 'sourceReceipts',
      required: true,
    },
    to: { type: x.type, name: 'rollingGoFlightResults', many: true },
  })),
];
export const rollingGoFlightActions: ActionDefinition[] =
  rollingGoFlightDefinition.actions.map((a) => ({
    id: a.id,
    description: a.description,
    inputs: { scope: 'RollingGoFlightTask' },
    changes: [a.resultType],
    submissionCriteria: ['same_owner', 'current_request_revision', 'read_only'],
    read: {
      version: '1',
      effect: 'read',
      inputSchema: z.toJSONSchema(rollingGoFlightActionSchema),
      resultType: a.resultType,
      mcp: a.mcp,
      module: {
        ...rollingGoFlightModule,
        completion: rollingGoFlightDefinition.completion,
      },
    },
  }));
export const rollingGoFlightFunctions: FunctionDefinition[] = [
  {
    id: 'rollingGoFlightSearchStatus',
    version: '1',
    inputTypes: ['RollingGoFlightObservation'],
    description:
      'Validate source proof, scope, revision and local freshness; prices are references',
  },
];

// Domain entities and search observations have separate identities. A fare is
// scoped to one search; it is never a reservation, inventory hold or ticket.
function entity(id: string, fields: Record<string, z.ZodType>): ObjectTypeDefinition {
  return { id, version: '1', name: id, aliases: [id], description: 'Source-qualified flight query data, not fulfillment',
    primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }],
    properties: { id: p('string', text), displayTitle: p('string', text), ...Object.fromEntries(Object.entries(fields).map(([name, schema]) => [name, { ...p('string', schema), required: !schema.isOptional() }])) } };
}
rollingGoFlightObjects[0]!.visibility = 'technical';
rollingGoFlightObjects[1]!.visibility = 'technical';
rollingGoFlightObjects.push(entity('Airport', airportSchema.shape), entity('FlightSegment', flightSegmentSchema.shape), {
  id: 'FlightFare', version: '1', name: '机票参考价格观察', aliases: ['FlightFare'], description: 'One source search option for exact passenger/date/cabin criteria; price unit, total basis and mandatory fees are not proven',
  primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'ObservedFact' }], properties: {
    ...base, observedAt: shared.observedAt, expiresAt: shared.expiresAt,
    criteria: p('struct', flightInputSchema), sourceOption: p('struct', flightOptionSchema),
    priceKind: p('string', z.literal('reference')), priceBasis: p('string', z.literal('unknown')),
    amountUnit: p('string', z.literal('unknown')), pricingCompleteness: p('string', z.literal('unknown')),
  },
});
const link = (id: string, from: string, name: string, to: string, reverse: string, many = false, required = false): LinkDefinition => ({
  id, description: 'Source-backed flight relationship', from: { type: from, name, many, required }, to: { type: to, name: reverse, many: true },
});
rollingGoFlightLinks.push(
  ...['Airport', 'FlightSegment', 'FlightFare'].map(id => link(`${id}Evidence`, id, 'sourceReceipts', 'SourceReceipt', `${id.toLowerCase()}Facts`, true, true)),
  link('RollingGoFlightObservationAirports', 'RollingGoFlightObservation', 'airports', 'Airport', 'flightObservations', true),
  link('RollingGoFlightObservationFares', 'RollingGoFlightObservation', 'fares', 'FlightFare', 'observations', true),
  link('FlightFareRequest', 'FlightFare', 'request', 'ServiceRequest', 'flightFares', false, true),
  link('FlightFareProvider', 'FlightFare', 'provider', 'Provider', 'flightFares', false, true),
  link('FlightFareOutboundSegments', 'FlightFare', 'outboundSegments', 'FlightSegment', 'outboundFares', true),
  link('FlightFareReturnSegments', 'FlightFare', 'returnSegments', 'FlightSegment', 'returnFares', true),
);
