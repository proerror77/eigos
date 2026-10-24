import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { objectRefSchema, type ModelDefinition, type PropertyDefinition } from './model.js';

const text = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/), time = z.iso.datetime({ offset: true });
const receiptRef = objectRefSchema.extend({ type: z.literal('SourceReceipt') });
export const identityAssertionRefSchema = objectRefSchema.extend({ type: z.literal('EntityIdentityAssertion') });
export const identityKindSchema = z.enum(['product_variant', 'hotel_property', 'room_type', 'vehicle_class', 'vehicle', 'driver']);
export const identityTypes: Record<z.infer<typeof identityKindSchema>, string> = { product_variant: 'ProductVariant', hotel_property: 'HotelProperty', room_type: 'RoomType', vehicle_class: 'VehicleClass', vehicle: 'TransportVehicle', driver: 'TransportDriver' };
export const identityEndpointSchema = z.strictObject({
  object: objectRefSchema, revision: z.number().int().positive(), propertiesDigest: sha,
  sourceIdentity: text, sourceRecordId: text, sourceVersion: text,
  evidenceObject: objectRefSchema, evidenceDigest: sha, receipt: receiptRef, receiptDigest: sha,
});
export const entityIdentityAssertionSchema = z.strictObject({
  schemaVersion: z.literal('1'), ownerDigest: sha, identityKind: identityKindSchema,
  left: identityEndpointSchema, right: identityEndpointSchema,
  relation: z.enum(['equivalent', 'different', 'unknown']), lifecycle: z.enum(['active', 'revoked']),
  issuerIdentity: text, sourceVersion: z.number().int().positive(),
  basis: z.strictObject({ kind: z.enum(['source_crosswalk', 'issuer_verified_identifiers']), reference: text }),
  observedAt: time, expiresAt: time, supersedes: identityAssertionRefSchema.optional(), reason: z.string().min(1).max(1000),
}).superRefine((value, ctx) => {
  if (value.left.object.type !== identityTypes[value.identityKind] || value.right.object.type !== identityTypes[value.identityKind]) ctx.addIssue({ code: 'custom', message: 'Identity level must match both concrete subject types' });
  if (digest(value.left.object) === digest(value.right.object)) ctx.addIssue({ code: 'custom', message: 'A cross-source assertion requires two distinct objects' });
  if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) ctx.addIssue({ code: 'custom', message: 'Identity validity must have an increasing interval' });
  if (value.lifecycle === 'revoked' && !value.supersedes) ctx.addIssue({ code: 'custom', message: 'A revocation must identify the exact original assertion' });
});
export type EntityIdentityAssertion = z.infer<typeof entityIdentityAssertionSchema>;
export const identityFunctionSchemas = [
  z.strictObject({ function: z.literal('entityIdentityStatus'), object: identityAssertionRefSchema }),
  z.strictObject({ function: z.literal('entityIdentityBetween'), object: objectRefSchema, other: objectRefSchema, identityKind: identityKindSchema }),
];
const prop = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Immutable owner-bound assertion from a trusted source mapping; grants no business or visibility authority' });
export function extendIdentityMappingModel(base: ModelDefinition): ModelDefinition {
  return { ...base,
    objects: [...base.objects.map(type => Object.values(identityTypes).includes(type.id) ? { ...type, version: String(Number(type.version) + 1), interfaces: [...(type.interfaces ?? []), { id: 'IdentitySubject' }] } : type),
      { id: 'EntityIdentityAssertion', version: '1', name: '实体同一性证据', aliases: ['EntityIdentityAssertion', '跨来源身份映射'], description: 'Immutable assertion about two exact source-bound subjects. Same hotel is separate from room, rate, stock or offer identity. Same vehicle class never proves the same vehicle or driver. No ID merge, inherited terms, stock aggregation or authorization.', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: { id: prop('string', text, 'Immutable issuer event identity'), displayTitle: prop('string', text, 'Identity evidence label'), assertion: prop('struct', entityIdentityAssertionSchema, 'Exact subject versions, source receipts, identity level, issuer, basis, time and supersession') } }],
    interfaces: [...base.interfaces, { id: 'IdentitySubject', description: 'An existing source-scoped business subject that may have independently evidenced identity assertions. This interface grants no equivalence, access, transitivity or execution authority.', properties: {} }],
    links: [...base.links,
      { id: 'IdentityAssertionLeft', description: 'First real object at the exact source version stated by the immutable assertion.', from: { type: 'EntityIdentityAssertion', name: 'leftSubject', many: false, required: true }, to: { type: 'IdentitySubject', name: 'identityAssertionsAsLeft', many: true } },
      { id: 'IdentityAssertionRight', description: 'Second real object; visibility is still checked for this owner.', from: { type: 'EntityIdentityAssertion', name: 'rightSubject', many: false, required: true }, to: { type: 'IdentitySubject', name: 'identityAssertionsAsRight', many: true } },
      { id: 'IdentityAssertionPredecessor', description: 'New issuer version supersedes an old assertion without changing its historical bytes or either entity.', from: { type: 'EntityIdentityAssertion', name: 'predecessor', many: false }, to: { type: 'EntityIdentityAssertion', name: 'successors', many: true } },
      { id: 'EntityIdentityAssertionEvidence', description: 'Source receipt seals the exact assertion and both subject relationships.', from: { type: 'EntityIdentityAssertion', name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: 'identityAssertions', many: true } },
    ],
    functions: [...base.functions,
      { id: 'entityIdentityStatus', version: '1', inputTypes: ['EntityIdentityAssertion'], description: 'Evaluate the current evidence for an immutable identity assertion, including contradictory issuers, exact source versions, expiry and later revocation. History remains separately readable.' },
      { id: 'entityIdentityBetween', version: '1', inputTypes: ['IdentitySubject'], description: 'Compare two explicitly readable source subjects using only sealed assertions at the requested identity level. Returns equivalent, different, unknown, conflict, revoked or expired. Never merges entities or joins price, stock, permission or order terms.' },
    ],
  };
}
