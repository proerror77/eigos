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
  rollingGoInputSchema,
  rollingGoResultSchema,
} from '../capabilities/rollinggo/connector.js';
import { loadMcpReadModule, mcpReadModuleRef } from './mcp-read.js';
export const rollingGoDefinition = loadMcpReadModule(
  new URL('./definitions/rollinggo-readonly.json', import.meta.url),
);
export const rollingGoModule = mcpReadModuleRef(rollingGoDefinition);
export const rollingGoActionSchema = z.strictObject({
  scope: objectRefSchema.extend({ type: z.literal('RollingGoSearchTask') }),
});
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  text = z.string().min(1).max(500);
export const rollingGoObservationSchema = z.strictObject({
  id: z.uuid(),
  requestId: text,
  requestRevision: z.number().int().positive(),
  configurationDigest: sha,
  scope: rollingGoActionSchema.shape.scope,
  actionInput: rollingGoActionSchema,
  planId: text,
  intentId: text,
  attemptId: text,
  modelRunId: text,
  input: rollingGoInputSchema,
  hotels: rollingGoResultSchema.shape.hotelInformationList,
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  evidenceKind: z.enum(['live_readonly', 'fixture']),
  contentDigest: sha,
});
export function checkedRollingGo(value: unknown) {
  const s = rollingGoObservationSchema.parse(value),
    { contentDigest, ...body } = s;
  if (
    digest(body) !== contentDigest ||
    digest(s.scope) !== digest(s.actionInput.scope) ||
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
  description: 'Owned hotel search scope or validated source observation',
  required: true,
  source: 'RollingGo read-only search',
});
const base = {
  id: p('string', text),
  displayTitle: p('string', text),
  requestRevision: p('integer', z.number().int().positive()),
};
export const rollingGoObjects: ObjectTypeDefinition[] = [
  {
    id: 'RollingGoSearchTask',
    version: '1',
    name: 'RollingGo hotel search task',
    aliases: ['RollingGoSearchTask'],
    description: 'Fixed hotel search criteria',
    primaryKey: 'id',
    titleKey: 'displayTitle',
    properties: {
      ...base,
      input: p('struct', rollingGoInputSchema),
      allowedActions: p('array', z.array(z.literal('SearchRollingGoHotels'))),
      configurationDigest: p('string', sha),
    },
  },
  {
    id: 'RollingGoSearchObservation',
    version: '1',
    name: 'RollingGo hotel search observation',
    aliases: ['RollingGoSearchObservation'],
    description:
      'Reference hotel prices, no reservation or confirmed availability',
    primaryKey: 'id',
    titleKey: 'displayTitle',
    interfaces: [{ id: 'EvidenceBacked' }],
    properties: { ...base, snapshot: p('struct', rollingGoObservationSchema) },
  },
];
export const rollingGoLinks: LinkDefinition[] = [
  {
    id: 'RollingGoTaskRequest',
    description: 'Owned task',
    from: {
      type: 'RollingGoSearchTask',
      name: 'request',
      many: false,
      required: true,
    },
    to: { type: 'ServiceRequest', name: 'hotelSearchTasks', many: true },
  },
  ...(
    [
      { name: 'request', type: 'ServiceRequest' },
      { name: 'scope', type: 'RollingGoSearchTask' },
      { name: 'sourceReceipts', type: 'SourceReceipt' },
    ] as const
  ).map((x) => ({
    id: `RollingGoObservation${x.name}`,
    description: 'Bound search provenance',
    from: {
      type: 'RollingGoSearchObservation',
      name: x.name,
      many: x.name === 'sourceReceipts',
      required: true,
    },
    to: { type: x.type, name: 'rollingGoResults', many: true },
  })),
];
export const rollingGoActions: ActionDefinition[] =
  rollingGoDefinition.actions.map((a) => ({
    id: a.id,
    description: a.description,
    inputs: { scope: 'RollingGoSearchTask' },
    changes: [a.resultType],
    submissionCriteria: ['same_owner', 'current_request_revision', 'read_only'],
    read: {
      version: '1',
      effect: 'read',
      inputSchema: z.toJSONSchema(rollingGoActionSchema),
      resultType: a.resultType,
      mcp: a.mcp,
      module: {
        ...rollingGoModule,
        completion: rollingGoDefinition.completion,
      },
    },
  }));
export const rollingGoFunctions: FunctionDefinition[] = [
  {
    id: 'rollingGoSearchStatus',
    version: '1',
    inputTypes: ['RollingGoSearchObservation'],
    description:
      'Validate source proof, scope, revision and local freshness; prices are references',
  },
];
