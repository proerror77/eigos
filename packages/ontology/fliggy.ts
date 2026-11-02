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
  fliggyInputSchema,
  fliggyResultSchema,
} from '../capabilities/fliggy/contracts.js';
import { sharedBusinessProperties as shared } from './shared-business-interfaces.js';
import { fliggyItemSchema } from '../capabilities/fliggy/contracts.js';
import { loadMcpReadModule, mcpReadModuleRef } from './mcp-read.js';
export const fliggyDefinition = loadMcpReadModule(
  new URL('./definitions/fliggy-readonly.json', import.meta.url),
);
export const fliggyModule = mcpReadModuleRef(fliggyDefinition);
export const fliggyActionSchema = z.strictObject({
  scope: objectRefSchema.extend({ type: z.literal('FliggySearchTask') }),
});
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  text = z.string().min(1).max(500);
export const fliggyObservationSchema = z.strictObject({
  id: z.uuid(),
  requestId: text,
  requestRevision: z.number().int().positive(),
  configurationDigest: sha,
  scope: fliggyActionSchema.shape.scope,
  actionInput: fliggyActionSchema,
  planId: text,
  intentId: text,
  attemptId: text,
  modelRunId: text,
  input: fliggyInputSchema,
  data: fliggyResultSchema,
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  evidenceKind: z.enum(['live_readonly', 'fixture']),
  contentDigest: sha,
});
export function checkedFliggy(value: unknown) {
  const s = fliggyObservationSchema.parse(value),
    { contentDigest, ...body } = s;
  if (
    digest(body) !== contentDigest ||
    digest(s.scope) !== digest(s.actionInput.scope) ||
    s.data.items.some(item => item.kind !== s.input.kind) ||
    Date.parse(s.expiresAt) !== Date.parse(s.observedAt) + 300000
  )
    throw new Error('INVALID_FLIGGY_OBSERVATION');
  return s;
}
const p = (
  kind: PropertyDefinition['kind'],
  schema: z.ZodType,
): PropertyDefinition => ({
  kind,
  schema,
  description: 'Owned travel search scope or validated source observation',
  required: true,
  source: 'Fliggy read-only search',
});
const base = {
  id: p('string', text),
  displayTitle: p('string', text),
  requestRevision: p('integer', z.number().int().positive()),
};
export const fliggyObjects: ObjectTypeDefinition[] = [
  {
    id: 'FliggySearchTask',
    version: '1',
    name: 'Fliggy travel search task',
    aliases: ['FliggySearchTask'],
    description: 'Fixed travel search criteria',
    primaryKey: 'id',
    titleKey: 'displayTitle',
    properties: {
      ...base,
      input: p('struct', fliggyInputSchema),
      allowedActions: p('array', z.array(z.enum(['SearchFliggyFlights','SearchFliggyHotels','SearchFliggyMarriottHotels','SearchFliggyMarriottPackages']))),
      configurationDigest: p('string', sha),
    },
  },
  {
    id: 'FliggySearchObservation',
    version: '1',
    name: 'Fliggy travel search observation',
    aliases: ['FliggySearchObservation'],
    description:
      'Reference travel prices, no reservation or confirmed availability',
    primaryKey: 'id',
    titleKey: 'displayTitle',
    interfaces: [{ id: 'EvidenceBacked' }],
    properties: { ...base, snapshot: p('struct', fliggyObservationSchema) },
  },
];
export const fliggyLinks: LinkDefinition[] = [
  {
    id: 'FliggyTaskRequest',
    description: 'Owned task',
    from: {
      type: 'FliggySearchTask',
      name: 'request',
      many: false,
      required: true,
    },
    to: { type: 'ServiceRequest', name: 'travelSearchTasks', many: true },
  },
  ...(
    [
      { name: 'request', type: 'ServiceRequest' },
      { name: 'scope', type: 'FliggySearchTask' },
      { name: 'sourceReceipts', type: 'SourceReceipt' },
    ] as const
  ).map((x) => ({
    id: `FliggyObservation${x.name}`,
    description: 'Bound search provenance',
    from: {
      type: 'FliggySearchObservation',
      name: x.name,
      many: x.name === 'sourceReceipts',
      required: true,
    },
    to: { type: x.type, name: 'fliggyResults', many: true },
  })),
];
export const fliggyActions: ActionDefinition[] =
  fliggyDefinition.actions.map((a) => ({
    id: a.id,
    description: a.description,
    inputs: { scope: 'FliggySearchTask' },
    changes: [a.resultType],
    submissionCriteria: ['same_owner', 'current_request_revision', 'read_only'],
    read: {
      version: '1',
      effect: 'read',
      inputSchema: z.toJSONSchema(fliggyActionSchema),
      resultType: a.resultType,
      mcp: a.mcp,
      module: {
        ...fliggyModule,
        completion: fliggyDefinition.completion,
      },
    },
  }));
export const fliggyFunctions: FunctionDefinition[] = [
  {
    id: 'fliggySearchStatus',
    version: '1',
    inputTypes: ['FliggySearchObservation'],
    description:
      'Validate source proof, scope, revision and local freshness; prices are references',
  },
];

fliggyObjects[0]!.visibility = 'technical';
fliggyObjects[1]!.visibility = 'technical';
fliggyObjects.push({ id: 'FliggyTravelOption', version: '1', name: '飞猪旅行候选观察', aliases: ['FliggyTravelOption'],
  description: 'A source-discovered option for exact criteria. Masked/from prices and package prose are not a verified SKU, calendar quote or availability.',
  primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'ObservedFact' }], properties: {
    ...base, observedAt: shared.observedAt, expiresAt: shared.expiresAt,
    kind: p('string', z.enum(['flight','hotel','marriottHotel','marriottPackage'])),
    data: p('struct', fliggyItemSchema), criteria: p('struct', fliggyInputSchema),
    priceKind: p('string', z.literal('reference')), comparisonStatus: p('string', z.literal('unverified')),
    commissionRate: p('string', z.literal('unknown')), commissionSettlement: p('string', z.literal('unknown')),
  },
}, { id: 'TravelProduct', version: '1', name: '旅行渠道商品', aliases: ['TravelProduct'],
  description: 'Source-qualified product/item identity (SPU). Neither a SKU nor a hotel/room identity can be inferred from its title.',
  primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{id:'EvidenceBacked'}], properties: {
    id: p('string', text), displayTitle: p('string', text), sourceId: p('string', text), name: p('string', z.string().min(1).max(2000)),
    classification: p('string', z.literal('unknown')),
  },
});
const link = (id: string, from: string, name: string, to: string, reverse: string, many = false, required = false): LinkDefinition => ({
  id, description: 'Explicit source-qualified travel relationship', from: { type: from, name, many, required }, to: { type: to, name: reverse, many: true },
});
fliggyLinks.push(
  link('FliggyObservationOptions','FliggySearchObservation','options','FliggyTravelOption','observations',true),
  link('FliggyTravelOptionEvidence','FliggyTravelOption','sourceReceipts','SourceReceipt','fliggyOptions',true,true),
  link('FliggyTravelOptionRequest','FliggyTravelOption','request','ServiceRequest','fliggyOptions',false,true),
  link('FliggyTravelOptionProvider','FliggyTravelOption','provider','Provider','fliggyOptions',false,true),
  link('FliggyTravelOptionHotel','FliggyTravelOption','hotel','HotelProperty','fliggyOptions'),
  link('FliggyTravelOptionProduct','FliggyTravelOption','product','TravelProduct','observedOptions'),
  link('TravelProductEvidence','TravelProduct','sourceReceipts','SourceReceipt','travelProducts',true,true),
);
