import { z } from 'zod';
import { SCOPES } from '../core/domain.js';
import { objectRefSchema, nameSchema } from '../ontology/model.js';

// Versioned data contracts. Parsing is not authorization; S1 resolves signed
// identity and current grants before producing a server-side AccessContext.
export const SECURITY_CONTRACT = 'eigos.security.v1' as const;
export const POLICY_VERSION = 'eigos.security-baseline.v1' as const;
const id = z.string().min(1).max(200).refine(v => !v.includes('*'), 'Wildcard grants are not supported');
const revision = z.number().int().positive();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
export const ownerIdentitySchema = z.string().max(2000).refine(value => {
  try {
    // Identity values are opaque. A literal '*' in an issuer/subject is not a
    // wildcard selector and must not change the existing ownerKey semantics.
    const part = z.string().min(1);
    const parts = z.tuple([part, part, part]).parse(JSON.parse(value));
    return JSON.stringify(parts) === value;
  } catch { return false; }
}, 'Use the existing canonical issuer/tenant/subject ownerKey');
export const resourceRefSchema = z.strictObject({
  kind: z.enum(['objectType', 'interface', 'linkType', 'actionType', 'function']), id: nameSchema, version: id,
});
export const resourcePermissionSchema = z.enum(['resource.view', 'resource.edit', 'resource.manage', 'action.execute', 'function.invoke']);
export const grantRefSchema = z.strictObject({ id: z.uuid(), revision });
export const dataOperationSchema = z.enum(['task.process', 'task.query', 'member_asset.read', 'task.result.read', 'artifact.export']);
export const channelSchema = z.enum(['member_ui', 'agent_response', 'registered_model', 'controlled_download']);
// Principal.scopes also contains enrollment/OIDC/provider scopes. Preserve the
// verified token facts; only explicit operation checks may use them as authority.
const scopeList = z.array(z.string().min(1).max(200).regex(/^\S+$/)).max(100).refine(v => new Set(v).size === v.length, 'Duplicate scope');
const baseActor = { version: z.literal(SECURITY_CONTRACT), ownerKey: ownerIdentitySchema, authEpoch: revision, policyVersion: z.literal(POLICY_VERSION), checkedAt: instant };
const agentActor = { memberId: z.uuid(), installationId: z.uuid(), clientId: z.string().min(1).max(2000), tokenScopes: scopeList };
export const accessContextSchema = z.discriminatedUnion('actorKind', [
  z.strictObject({ ...baseActor, actorKind: z.literal('member_session'), memberId: z.uuid(), sessionAuditRef: sha }),
  z.strictObject({ ...baseActor, ...agentActor, actorKind: z.literal('agent'), agentGrant: grantRefSchema,
    task: z.strictObject({ id: z.uuid(), requestRevision: revision, dataGrant: grantRefSchema }).optional() }),
  z.strictObject({ ...baseActor, ...agentActor, actorKind: z.literal('worker'), taskId: z.uuid(), requestRevision: revision,
    authorityRef: grantRefSchema, dataGrant: grantRefSchema, claimRef: sha }),
  z.strictObject({ ...baseActor, actorKind: z.literal('development'), installationId: z.uuid(), tokenScopes: scopeList,
    loopbackOnly: z.literal(true), fixture: z.literal(true) }),
]);
export type AccessContext = z.infer<typeof accessContextSchema>;

export const fieldPolicySchema = z.enum(['task_private', 'task_sensitive', 'internal_only', 'derived_from_inputs']);
export type FieldPolicy = z.infer<typeof fieldPolicySchema>;
export const resourceDefaults = {
  Viewer: ['resource.view'],
  Editor: ['resource.view', 'resource.edit'],
  Owner: ['resource.view', 'resource.edit', 'resource.manage'],
} as const;
export const securityDefaults = {
  contract: SECURITY_CONTRACT, policyVersion: POLICY_VERSION, enforcement: 'not_installed',
  agentScope: 'task_only', unknownPolicy: 'deny', crossMemberGraph: 'deny', declassification: 'deny',
  automaticLegacyGrant: false, automaticMemberResourceRole: 'none', unregisteredModelChannel: 'deny',
  gatewayOperationScopes: SCOPES,
  agentGrantMaxSeconds: 30 * 86400, taskGrantMaxSeconds: 86400,
  authorityProjectionLeaseSeconds: 60, authorityProjectionRefreshSeconds: 30,
} as const;

const fields = z.array(nameSchema).min(1).max(200).refine(v => new Set(v).size === v.length, 'Duplicate field');
const typeFields = z.strictObject({ type: nameSchema, fields });
const grantBase = {
  version: z.literal(SECURITY_CONTRACT), id: z.uuid(), revision, ownerKey: ownerIdentitySchema,
  memberId: z.uuid(), installationId: z.uuid(), issuedAt: instant, expiresAt: instant,
  status: z.enum(['active', 'revoked']), approvedByMemberId: z.uuid(),
};
const grantTime = (maxSeconds: number) => (v: { issuedAt: string; expiresAt: string; memberId: string; approvedByMemberId: string }) =>
  v.memberId === v.approvedByMemberId && Date.parse(v.expiresAt) > Date.parse(v.issuedAt)
  && Date.parse(v.expiresAt) - Date.parse(v.issuedAt) <= maxSeconds * 1000;
export const agentAccessGrantSchema = z.strictObject({ ...grantBase, kind: z.literal('agent_access'), scope: z.literal('task_only'),
  capabilityIds: z.array(id).min(1).max(100), resources: z.array(typeFields).min(1).max(200),
  sourceBindingIds: z.array(id).max(100), channels: z.array(channelSchema).min(1).max(4),
}).refine(grantTime(securityDefaults.agentGrantMaxSeconds), 'Invalid controller or grant lifetime');
export const taskDataGrantSchema = z.strictObject({ ...grantBase, kind: z.literal('task_data'), parentGrant: grantRefSchema,
  taskId: z.uuid(), requestRevision: revision, operations: z.array(dataOperationSchema).min(1).max(5), purpose: id,
  inputs: z.array(z.strictObject({ object: objectRefSchema, objectRevision: revision, fields })).max(200),
  outputs: z.array(z.strictObject({ programId: id, programDigest: sha, sourceBindingId: id, type: nameSchema, fields })).max(200),
  channels: z.array(channelSchema).min(1).max(4),
}).refine(grantTime(securityDefaults.taskGrantMaxSeconds), 'Invalid controller or grant lifetime');
export const taskExecutionAuthoritySchema = z.strictObject({
  version: z.literal(SECURITY_CONTRACT), id: z.uuid(), revision, ownerKey: ownerIdentitySchema,
  memberId: z.uuid(), installationId: z.uuid(), taskId: z.uuid(), requestRevision: revision,
  agentGrant: grantRefSchema, dataGrant: grantRefSchema, submittedScopes: scopeList,
  authorityOrigin: z.enum(['agent_submission','member_controller']).default('agent_submission'),
  authEpoch: revision, policyVersion: z.literal(POLICY_VERSION), issuedAt: instant, expiresAt: instant,
}).refine(v => Date.parse(v.expiresAt) > Date.parse(v.issuedAt)
  && Date.parse(v.expiresAt) - Date.parse(v.issuedAt) <= securityDefaults.taskGrantMaxSeconds * 1000, 'Invalid execution lifetime');
export const securityEnvelopeSchema = z.strictObject({
  version: z.literal(SECURITY_CONTRACT), ownerKey: ownerIdentitySchema,
  requiredMarkings: z.array(z.enum(['member_private', 'personal_data', 'precise_location', 'health', 'financial', 'account_private'])).max(6),
  classification: z.enum(['private', 'sensitive', 'internal']),
  channels: z.array(channelSchema).max(4), policyVersion: z.literal(POLICY_VERSION),
  lineage: z.array(z.strictObject({ object: objectRefSchema, revision, contentDigest: sha, fields: z.array(nameSchema).max(200).optional() })).max(200),
  lineageComplete: z.boolean(),
  submission: z.strictObject({ taskId: z.uuid(), requestRevision: revision, contentDigest: sha }).optional(),
});
