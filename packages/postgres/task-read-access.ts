import type { Client } from 'pg';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { ownerKey, requireScope, taskIdSchema, type Principal } from '../core/domain.js';
import { accessContextSchema, agentAccessGrantSchema, securityEnvelopeSchema, taskDataGrantSchema } from '../security/contracts.js';
import { SecurityError } from '../security/errors.js';
import { postgresBusinessSchema } from './runtime-transaction.js';
import { postgresOntologyReadContext } from './ontology-release.js';
import { roleAllows, roleSchema } from '../security/resource-role.js';
import { currentKernelImplementation } from '../ontology/definition-store.js';

/** Resolve a current agent task-read grant. The principal and policy digest
 * must come from trusted authentication and reviewed server configuration.
 * This is an internal admission check, not field/output authorization. All writers must use the business
 * transaction fence; callers must recheck before returning protected data. */
export async function postgresTaskReadGrant(client: Client, principal: Principal, taskId: string, policyDigest: string) {
  const schema = postgresBusinessSchema(client), q = `"${schema}"`, id = taskIdSchema.parse(taskId);
  requireScope(principal,'tasks:read');
  if (!/^[a-f0-9]{64}$/.test(policyDigest)) throw new Error('Invalid PostgreSQL policy digest');
  const actor = accessContextSchema.parse(principal.access), owner = ownerKey(principal);
  if (actor.actorKind !== 'agent' || actor.ownerKey !== owner || actor.clientId !== principal.clientId
    || digest([...actor.tokenScopes].sort()) !== digest([...new Set(principal.scopes)].sort())) throw new SecurityError('AUTHORIZATION_REQUIRED');
  const now = Date.now();
  const row = (await client.query(`SELECT p.revision AS policy_revision,d.digest AS policy_digest,m.expires_at AS manager_expires_at,
    s.installation_id,s.owner,s.member_id,s.client_id,s.epoch,s.state,s.valid_until,
    EXISTS(SELECT 1 FROM ${q}.security_fences f WHERE f.owner=s.owner AND f.state<>'cleared'
      AND ((f.kind='member' AND f.target_id=s.member_id) OR (f.kind='connection' AND f.target_id=s.client_id)
        OR (f.kind='installation' AND f.target_id=s.installation_id))) AS fenced
    FROM ${q}.security_policy p JOIN ${q}.security_policy_definitions d ON d.slot=p.slot
    JOIN ${q}.security_settings cfg ON cfg.slot=p.slot AND cfg.version=2 AND cfg.mode='foundation'
    JOIN ${q}.security_manager m ON m.slot=p.slot
    LEFT JOIN ${q}.security_subjects s ON s.installation_id=$1 WHERE p.slot=1`,[actor.installationId])).rows[0];
  const revision = Number(row?.policy_revision), managerExpiry = Number(row?.manager_expires_at);
  if (!row || !Number.isSafeInteger(revision) || revision < 1 || row.policy_digest !== policyDigest || !Number.isSafeInteger(managerExpiry) || managerExpiry <= now) throw new SecurityError('AUTHORITY_UNAVAILABLE');
  const epoch = Number(row.epoch), subjectExpiry = Number(row.valid_until);
  if (row.installation_id !== actor.installationId || row.owner !== owner || row.member_id !== actor.memberId || row.client_id !== actor.clientId
    || row.state !== 'active' || row.fenced !== false || !Number.isSafeInteger(subjectExpiry) || subjectExpiry <= now) throw new SecurityError('ACCESS_REVOKED');
  if (!Number.isSafeInteger(epoch) || epoch !== actor.authEpoch) throw new SecurityError('POLICY_CHANGED');
  const parentRows = await client.query(`SELECT revision,state,CASE WHEN octet_length(body)<=1048576 THEN body END AS body
    FROM ${q}.security_grants WHERE installation_id=$1 AND kind='agent_access' AND state='active' AND expires_at>$2 LIMIT 2`,[actor.installationId,now]);
  if (parentRows.rowCount !== 1 || parentRows.rows[0].body === null) throw new SecurityError('AUTHORIZATION_REQUIRED');
  const parentRow = parentRows.rows[0], parent = agentAccessGrantSchema.parse({ ...JSON.parse(String(parentRow.body)), revision:Number(parentRow.revision),status:parentRow.state });
  if (parent.id !== actor.agentGrant.id || parent.revision !== actor.agentGrant.revision) throw new SecurityError('POLICY_CHANGED');
  if (parent.ownerKey !== owner || parent.memberId !== actor.memberId || parent.installationId !== actor.installationId) throw new SecurityError('ACCESS_REVOKED');
  const rows = await client.query(`SELECT d.revision,d.state,CASE WHEN octet_length(d.body)<=1048576 THEN d.body END AS body
    FROM ${q}.security_grants d JOIN ${q}.jobs j ON j.id=$1 AND j.owner=d.owner
    CROSS JOIN LATERAL (SELECT ${q}.eigos_try_jsonb(d.body) AS value OFFSET 0) data
    CROSS JOIN LATERAL (SELECT ${q}.eigos_try_jsonb(j.body) AS value OFFSET 0) job
    CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(job.value)='object' THEN j.body::json ELSE '{}'::json END AS value OFFSET 0) source
    WHERE d.owner=$2 AND d.installation_id=$3 AND d.kind='task_data' AND d.state='active' AND d.expires_at>$4
      AND d.parent_id=$5 AND d.parent_revision=$6 AND jsonb_typeof(data.value)='object'
      AND jsonb_typeof(data.value->'taskId')='string' AND data.value->>'taskId'=$1
      AND jsonb_typeof(data.value->'requestRevision')='number' AND jsonb_typeof(job.value#>'{delegation,request,revision}')='number'
      AND (data.value->>'requestRevision')::numeric=(job.value#>>'{delegation,request,revision}')::numeric
      AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN jsonb_typeof(data.value)='object' THEN d.body::json ELSE '{}'::json END)
        WHERE key IN ('taskId','requestRevision') GROUP BY key HAVING count(*)>1)
      AND NOT EXISTS (SELECT 1 FROM json_each(source.value) WHERE key='delegation' GROUP BY key HAVING count(*)>1)
      AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_typeof(source.value->'delegation')='object' THEN source.value->'delegation' ELSE '{}'::json END)
        WHERE key='request' GROUP BY key HAVING count(*)>1)
      AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_typeof(source.value#>'{delegation,request}')='object' THEN source.value#>'{delegation,request}' ELSE '{}'::json END)
        WHERE key='revision' GROUP BY key HAVING count(*)>1) LIMIT 2`,[id,owner,actor.installationId,now,parent.id,parent.revision]);
  if (rows.rowCount !== 1 || rows.rows[0].body === null) throw new SecurityError('AUTHORIZATION_REQUIRED');
  const grantRow = rows.rows[0], grant = taskDataGrantSchema.parse({ ...JSON.parse(String(grantRow.body)),revision:Number(grantRow.revision),status:grantRow.state });
  if (grant.ownerKey !== owner || grant.memberId !== actor.memberId || grant.installationId !== actor.installationId || grant.taskId !== id
    || grant.parentGrant.id !== parent.id || grant.parentGrant.revision !== parent.revision || grant.purpose !== 'delegated_task'
    || !grant.operations.includes('task.result.read') || grant.inputs.length > 0 && !grant.operations.includes('member_asset.read')
    || !grant.channels.includes('agent_response') || !parent.channels.includes('agent_response')) throw new SecurityError('AUTHORIZATION_REQUIRED');
  return { actor, parent, grant, policyRevision:revision };
}

/** Recheck admission after an awaited read. The action must additionally apply
 * object/field and recipient policy before exposing protected output. */
export async function withPostgresTaskReadGrant<T>(client: Client, principal: Principal, taskId: string, policyDigest: string, action: (admission: Awaited<ReturnType<typeof postgresTaskReadGrant>>) => Promise<T>): Promise<T> {
  const captured = structuredClone(principal);
  const before = await postgresTaskReadGrant(client,captured,taskId,policyDigest), result = await action(before);
  const after = await postgresTaskReadGrant(client,captured,taskId,policyDigest);
  if (digest(before) !== digest(after)) throw new SecurityError('POLICY_CHANGED');
  return result;
}

/** Check resource.view against the reviewed security model, as SQLite does.
 * The task's pinned model is independently validated but never substitutes
 * for current policy. Object, field, source, lineage and output checks remain. */
export async function postgresTaskResourceViewAllowed(client: Client, principal: Principal, taskId: string, policyDigest: string, kind: string, id: string): Promise<boolean> {
  const captured = structuredClone(principal);
  return withPostgresTaskReadGrant(client,captured,taskId,policyDigest,async admission => {
    const schema = postgresBusinessSchema(client);
    await postgresOntologyReadContext(client,ownerKey(captured),{taskId},captured.scopes.includes('ontology:admin'));
    const result = await client.query(`SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM "${schema}".security_roles WHERE subject_id IN ($1,$2) LIMIT 257`,[admission.actor.memberId,admission.actor.installationId]);
    if (result.rows.length > 256 || result.rows.some(row=>row.body===null)) throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const roles = result.rows.map(row=>roleSchema.parse(JSON.parse(String(row.body))));
    return roleAllows(currentKernelImplementation(),roles,admission.actor.memberId,admission.actor.installationId,kind,id,'resource.view',Date.now);
  });
}

const recipientSchema = z.strictObject({ classification:z.enum(['private','sensitive']), markings:securityEnvelopeSchema.shape.requiredMarkings,
  channels:securityEnvelopeSchema.shape.channels, expiresAt:z.iso.datetime({offset:true}) });

/** Read current recipient clearance for an admitted task. This is not an
 * output authorization: callers must also recompute and validate the complete
 * current envelope, lineage, fields and channel at the point of output. */
export async function postgresTaskReadClearance(client: Client, principal: Principal, taskId: string, policyDigest: string) {
  const captured=structuredClone(principal);
  const result=await withPostgresTaskReadGrant(client,captured,taskId,policyDigest,async admission=>{
    const schema=postgresBusinessSchema(client);
    const rows=await client.query(`SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM "${schema}".security_recipients WHERE installation_id=$1 LIMIT 2`,[admission.actor.installationId]);
    if (rows.rowCount === 0) return undefined;
    if (rows.rowCount !== 1 || rows.rows[0].body === null) throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const result=recipientSchema.parse(JSON.parse(String(rows.rows[0].body)));
    return Date.parse(result.expiresAt)>Date.now()?result:undefined;
  });
  return result && Date.parse(result.expiresAt)>Date.now()?result:undefined;
}

/** Resolve the admitted task's exact read model. The returned model still
 * requires object, field, lineage and recipient checks before data leaves. */
export async function postgresTaskReadOntology(client: Client, principal: Principal, taskId: string, policyDigest: string) {
  const captured = structuredClone(principal);
  return withPostgresTaskReadGrant(client,captured,taskId,policyDigest,() =>
    postgresOntologyReadContext(client,ownerKey(captured),{taskId},captured.scopes.includes('ontology:admin')));
}
