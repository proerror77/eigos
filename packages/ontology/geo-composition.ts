import { z } from 'zod';
import { publicGeoQuerySchema } from '../capabilities/paotui-contracts.js';
import { paotuiPublicPlaceSchema } from '../capabilities/paotui-public-locations.js';
import { objectRefSchema, type ActionDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';

const text = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/);
const property = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Exact owned public query and verified original source receipt' });
const common = { id: property('string', text, 'Immutable query identity'), displayTitle: property('string', text, 'Query label'), requestRevision: property('integer', z.number().int().positive(), 'Original request revision') };
export const geoActionSchema = z.strictObject({ scope: objectRefSchema.extend({ type: z.literal('GeoQueryTask') }) });
export const geoObservationSchema = z.strictObject({ configurationDigest: sha, scope: objectRefSchema.extend({ type: z.literal('GeoQueryTask') }), query: publicGeoQuerySchema,
  planId: z.uuid(), intentId: z.uuid(), attemptId: z.uuid(), sourceReceipt: text, resultDigest: sha, observedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }),
  locations: z.array(objectRefSchema.extend({ type: z.literal('Place') })).max(100), preview: z.array(paotuiPublicPlaceSchema).max(4), previewComplete: z.boolean(), completeCoverageKnown: z.literal(false),
});
export const geoCompositionObjects: ObjectTypeDefinition[] = [
  { id: 'GeoQueryTask', version: '1', name: '公开地点查询范围', aliases: ['GeoQueryTask'], description: 'Pure public city and keyword scope; no user goal or private address data is sent to the source', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common, input: property('struct', publicGeoQuerySchema, 'Exact city and public keyword'), configurationDigest: property('string', sha, 'Pinned configured reader and allowlist') } },
  { id: 'GeoObservation', version: '1', name: '公开地点查询结果', aliases: ['GeoObservation'], description: 'Original query result, independently mapped public places and explicit unknown search coverage; no merchant or delivery claims', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: { ...common, snapshot: property('struct', geoObservationSchema, 'Bounded metadata and preview; complete result remains in the original task artifact') } },
];
export const geoCompositionLinks: LinkDefinition[] = [
  ...geoCompositionObjects.map(object => ({ id: `${object.id}Request`, description: 'Original owned query task', from: { type: object.id, name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: `geo${object.id}`, many: true } })),
  { id: 'GeoObservationScope', description: 'Original configured scope', from: { type: 'GeoObservation', name: 'scope', many: false, required: true }, to: { type: 'GeoQueryTask', name: 'observations', many: true } },
  { id: 'GeoObservationPlaces', description: 'Only places returned by this exact public query', from: { type: 'GeoObservation', name: 'locations', many: true }, to: { type: 'Place', name: 'geoQueries', many: true } },
  { id: 'GeoObservationEvidence', description: 'Original source receipt of this query', from: { type: 'GeoObservation', name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: 'geoObservations', many: true } },
];
export const geoCompositionAction: ActionDefinition = { id: 'ReadPublicLocations', version: '1', kind: 'source_read', description: 'Perform exactly the configured public city/keyword query. Read-only POIs are not merchants, product stock, a guaranteed boundary match or fulfillment. Preserve explicit query and unknown result coverage.', inputs: { scope: 'GeoQueryTask' }, resultTypes: ['GeoObservation'], effects: ['read'], changes: ['GeoObservation', 'Place', 'SourceReceipt'], submissionCriteria: ['same_owner', 'current_request_revision', 'configured_public_query'], read: { version: '1', effect: 'read', inputSchema: z.toJSONSchema(geoActionSchema), resultType: 'GeoObservation' } };
