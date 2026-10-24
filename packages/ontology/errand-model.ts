import { z } from 'zod';
import { objectRefSchema, type ModelDefinition, type PropertyDefinition } from './model.js';

const text = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/), time = z.iso.datetime({ offset: true });
const money = z.strictObject({ minor: z.string().regex(/^(0|[1-9]\d{0,17})$/), currency: z.string().regex(/^[A-Z]{3}$/) });
const window = z.strictObject({ startsAt: time, endsAt: time, timeZone: text }).superRefine((value, ctx) => {
  if (Date.parse(value.endsAt) < Date.parse(value.startsAt)) ctx.addIssue({ code: 'custom', message: 'Errand time window ends before it starts' });
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }); } catch { ctx.addIssue({ code: 'custom', message: 'Errand window requires an IANA time zone' }); }
});
export const parcelDetailsSchema = z.strictObject({
  packageCount: z.number().int().positive().max(100).optional(),
  dimensionsCm: z.strictObject({ length: z.number().positive().max(1000), width: z.number().positive().max(1000), height: z.number().positive().max(1000) }).optional(),
  packaging: z.enum(['sealed', 'unsealed']).optional(),
});
export const parcelHandlingSchema = z.strictObject({
  fragile: z.boolean().optional(), keepUpright: z.boolean().optional(),
  temperatureC: z.strictObject({ minimum: z.number().min(-100).max(100), maximum: z.number().min(-100).max(100) }).refine(value => value.minimum <= value.maximum, 'Temperature range is reversed').optional(),
  handoff: z.enum(['leave_at_door', 'named_recipient', 'signature']).optional(),
  insuredValue: money.optional(),
});
/** These are business request profiles. Only parcel_delivery has an existing
 * read-only price-preview binding; the other subtypes define no executor. */
export const errandConstraintsSchema = z.strictObject({
  schemaVersion: z.literal('1'), serviceType: z.enum(['parcel_delivery', 'purchase_and_deliver', 'queue_and_submit']),
  serviceLevel: z.enum(['ordinary', 'express']).optional(),
  parcel: parcelDetailsSchema.optional(), handling: parcelHandlingSchema.optional(),
  pickupWindow: window.optional(), deliveryWindow: window.optional(),
});
export const errandQuoteCommitmentsSchema = errandConstraintsSchema;
const scopeTypes = ['ProductOffer', 'Order', 'Shipment', 'DeliveryQuote', 'Parcel', 'DeliveryRoute'];
const role = z.enum(['seller', 'fulfiller', 'sender', 'receiver', 'courier']);
const pin = z.strictObject({ object: objectRefSchema, revision: z.number().int().positive(), propertiesDigest: sha, linksDigest: sha });
export const transactionPartyRoleRefSchema = objectRefSchema.extend({ type: z.literal('TransactionPartyRole') });
export const transactionPartyRoleSchema = z.strictObject({
  schemaVersion: z.literal('1'), ownerDigest: sha, role,
  scope: pin, party: pin, participation: pin.optional(),
  state: z.enum(['assigned', 'revoked']), issuerIdentity: text, sourceVersion: z.number().int().positive(),
  observedAt: time, expiresAt: time, basisReference: text, supersedes: transactionPartyRoleRefSchema.optional(),
}).superRefine((value, ctx) => {
  if (!scopeTypes.includes(value.scope.object.type)) ctx.addIssue({ code: 'custom', message: 'Role requires an exact supported transaction scope' });
  const partyType = ['sender', 'receiver'].includes(value.role) ? 'SavedAddress' : 'Provider';
  if (value.party.object.type !== partyType) ctx.addIssue({ code: 'custom', message: 'Business actors reuse Provider; sender and receiver reuse their selected contact address, without inventing a person identity' });
  if (value.participation && value.participation.object.type !== 'ChannelParticipation') ctx.addIssue({ code: 'custom', message: 'Channel role must reference existing ChannelParticipation' });
  if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) ctx.addIssue({ code: 'custom', message: 'Role validity interval is invalid' });
  if (value.state === 'revoked' && !value.supersedes) ctx.addIssue({ code: 'custom', message: 'Revocation requires the original assignment' });
});
export type TransactionPartyRole = z.infer<typeof transactionPartyRoleSchema>;
export const errandFunctionSchemas = [
  z.strictObject({ function: z.literal('errandQuoteMatches'), object: objectRefSchema.extend({ type: z.literal('DeliveryQuote') }), constraints: errandConstraintsSchema }),
  z.strictObject({ function: z.literal('transactionRoleStatus'), object: transactionPartyRoleRefSchema }),
];
const prop = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string, required = false): PropertyDefinition => ({ kind, schema, description, required, source: 'Exact owner request or source-sealed contract, kept distinct; no inferred provider handling or authority' });
export function extendErrandDomainModel(base: ModelDefinition): ModelDefinition {
  const extensions: Record<string, Record<string, PropertyDefinition>> = {
    Parcel: { parcelDetails: prop('struct', parcelDetailsSchema, 'Owner-declared package count, dimensions and packaging; never a courier measurement'), handlingRequirements: prop('struct', parcelHandlingSchema, 'Owner-requested handling; not evidence that any courier accepts it') },
    DeliveryRoute: { errandRequirements: prop('struct', errandConstraintsSchema, 'Explicit route service subtype, time windows and handling requirements; absence is unknown') },
    DeliveryQuote: { errandCommitments: prop('struct', errandQuoteCommitmentsSchema, 'Only handling and time conditions actually returned by this quote source; a fee preview alone proves none') },
  };
  return { ...base,
    objects: [...base.objects.map(type => ({ ...type, ...([...scopeTypes, 'Provider', 'SavedAddress'].includes(type.id) ? { version: String(Number(type.version) + 1) } : {}), ...(extensions[type.id] ? { properties: { ...type.properties, ...extensions[type.id] } } : {}),
      ...([...scopeTypes, 'Provider', 'SavedAddress'].includes(type.id) ? { interfaces: [...(type.interfaces ?? []), { id: scopeTypes.includes(type.id) ? 'TransactionRoleScope' : 'TransactionParty' }] } : {}) })),
      { id: 'TransactionPartyRole', version: '1', name: '交易参与角色', aliases: ['TransactionPartyRole', '销售履约及收发责任'], description: 'An exact scoped assignment using existing Provider or selected SavedAddress. ChannelParticipation describes broader channel participation and is not by itself this order\'s seller, fulfiller or courier. A selected address proves no real-world person identity.', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: { id: prop('string', text, 'Immutable role source event', true), displayTitle: prop('string', text, 'Safe role description', true), assignment: prop('struct', transactionPartyRoleSchema, 'Exact role, scope and existing party versions with issuer, validity and source history', true) } }],
    interfaces: [...base.interfaces,
      { id: 'TransactionRoleScope', description: 'Existing quote, order, shipment, parcel or route with exact scoped party assignments; assignments grant no authority.', properties: {} },
      { id: 'TransactionParty', description: 'Existing Provider for commercial/service responsibility, or SavedAddress for the selected sender/receiver contact; no duplicate seller, buyer or courier entity.', properties: {} }],
    links: [...base.links,
      { id: 'TransactionRoleScope', description: 'The exact business object version to which this role applies.', from: { type: 'TransactionPartyRole', name: 'scope', many: false, required: true }, to: { type: 'TransactionRoleScope', name: 'partyRoles', many: true } },
      { id: 'TransactionRoleParty', description: 'Reuses the existing party or selected private contact endpoint, without copying contact data.', from: { type: 'TransactionPartyRole', name: 'party', many: false, required: true }, to: { type: 'TransactionParty', name: 'transactionRoles', many: true } },
      { id: 'TransactionRoleParticipation', description: 'Optional supporting channel role, never a substitute for transaction-scoped assignment.', from: { type: 'TransactionPartyRole', name: 'channelParticipation', many: false }, to: { type: 'ChannelParticipation', name: 'transactionRoles', many: true } },
      { id: 'TransactionRolePredecessor', description: 'Append-only role update or revocation; original assignment is retained.', from: { type: 'TransactionPartyRole', name: 'predecessor', many: false }, to: { type: 'TransactionPartyRole', name: 'successors', many: true } },
      { id: 'TransactionPartyRoleEvidence', description: 'Source receipt seals the assignment and all its exact relationships.', from: { type: 'TransactionPartyRole', name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: 'partyRoles', many: true } },
    ],
    functions: [...base.functions,
      { id: 'errandQuoteMatches', version: '1', inputTypes: ['DeliveryQuote'], description: 'Check requested parcel/handling/time fields against the exact source quote. Missing handling is unknown. Purchase-and-deliver and queue-and-submit have no executable binding and cannot pass a delivery preview.' },
      { id: 'transactionRoleStatus', version: '1', inputTypes: ['TransactionPartyRole'], description: 'Validate exact owned scope and party versions, source receipt, expiry and supersession. Owner-selected contacts stay declared; a source assignment grants no execution authority.' },
    ],
  };
}
