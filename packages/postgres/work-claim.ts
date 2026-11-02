import type { Client } from 'pg';
import type { WorkClaim } from '../core/store.js';
import { postgresBusinessAuthorityDigest, postgresBusinessSchema, postgresConstrainReadDeadline } from './runtime-transaction.js';
import { postgresWorkAuthority } from './work-authority.js';

type ClaimFence = { owner: string; taskId: string; token: string; state: string; revision: number; requestRevision: number; recovery: boolean; authorityId: string; epoch: number; policyRevision: number };
function capture(claim: WorkClaim): ClaimFence | undefined {
  const revision = claim.job.revision ?? 0, requestRevision = claim.job.delegation?.request?.revision ?? 0;
  if (!claim.owner || !claim.job.id || !claim.token || !Number.isSafeInteger(revision) || !Number.isSafeInteger(requestRevision)
    || !claim.securityAuthorityId || !Number.isSafeInteger(claim.securityEpoch) || !Number.isSafeInteger(claim.securityPolicyRevision)) return;
  return { owner:claim.owner,taskId:claim.job.id,token:claim.token,state:claim.job.state,revision,requestRevision,recovery:claim.recovery === true,
    authorityId:claim.securityAuthorityId,epoch:claim.securityEpoch!,policyRevision:claim.securityPolicyRevision! };
}
async function active(client: Client, fence: ClaimFence, policyDigest: string): Promise<boolean> {
  const schema = postgresBusinessSchema(client), authorityDigest = postgresBusinessAuthorityDigest(client), q = `"${schema}"`;
  const row = (await client.query(`SELECT c.revision,c.expires_at,p.revision AS policy_revision,
    pg_catalog.jsonb_typeof(body.value) AS body_type,
    CASE WHEN pg_catalog.jsonb_typeof(body.value -> 'state')='string' AND pg_catalog.octet_length(body.value ->> 'state')<=32 THEN body.value ->> 'state' END AS job_state,
    CASE WHEN body.value -> 'revision' IS NULL OR body.value -> 'revision'='null'::jsonb THEN '0' WHEN pg_catalog.jsonb_typeof(body.value -> 'revision')='number' AND pg_catalog.octet_length(body.value ->> 'revision')<=64 THEN body.value ->> 'revision' END AS job_revision,
    CASE WHEN body.value #> '{delegation,request,revision}' IS NULL OR body.value #> '{delegation,request,revision}'='null'::jsonb THEN '0' WHEN pg_catalog.jsonb_typeof(body.value #> '{delegation,request,revision}')='number' AND pg_catalog.octet_length(body.value #>> '{delegation,request,revision}')<=64 THEN body.value #>> '{delegation,request,revision}' END AS request_revision,
    COALESCE(body.value #> '{delegation,recoveryPending}'='true'::jsonb,false) AS recovery_pending
    FROM ${q}.work_claims c JOIN ${q}.runtime_work_claims r ON r.job_id=c.job_id AND r.token=c.token
    JOIN ${q}.jobs j ON j.id=c.job_id AND j.owner=$1 JOIN ${q}.security_policy p ON p.slot=1
    CROSS JOIN LATERAL (SELECT ${q}.eigos_try_jsonb(j.body) AS value OFFSET 0) body
    WHERE c.job_id=$2 AND c.token=$3 AND r.authority_digest=$4`, [fence.owner,fence.taskId,fence.token,authorityDigest])).rows[0];
  if (!row || String(row.revision) !== String(fence.revision) || String(row.policy_revision) !== String(fence.policyRevision)) return false;
  if (row.body_type !== 'object' || (fence.recovery ? row.job_state !== fence.state || row.recovery_pending !== true : row.job_state !== 'working')
    || typeof row.job_revision !== 'string' || !Number.isSafeInteger(Number(row.job_revision)) || Number(row.job_revision) !== fence.revision
    || typeof row.request_revision !== 'string' || !Number.isSafeInteger(Number(row.request_revision)) || Number(row.request_revision) !== fence.requestRevision) return false;
  const authority = await postgresWorkAuthority(client,fence.owner,fence.taskId,policyDigest);
  if (!authority || authority.id !== fence.authorityId || authority.authEpoch !== fence.epoch) return false;
  // A long authority query must not leave an already expired lease eligible.
  if(BigInt(String(row.expires_at))<=BigInt(Date.now()))return false;
  postgresConstrainReadDeadline(client,Number(row.expires_at));return true;
}

/** Current-claim fence for the foundation security mode. The caller must use a
 * fenced business transaction and must separately check its operation scope. */
export async function postgresClaimActive(client: Client, claim: WorkClaim, policyDigest: string): Promise<boolean> {
  postgresBusinessSchema(client);
  const fence = capture(claim);
  return fence ? active(client,fence,policyDigest) : false;
}

/** Renew only the original unexpired token after rechecking current authority. */
export async function postgresRenewClaim(client: Client, claim: WorkClaim, leaseMs: number, policyDigest: string): Promise<boolean> {
  const schema = postgresBusinessSchema(client), fence = capture(claim);
  if (!fence || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !await active(client,fence,policyDigest)) return false;
  const now = Date.now(), expires = now + leaseMs;
  if (!Number.isSafeInteger(expires)) return false;
  const result = await client.query(`UPDATE "${schema}".work_claims SET expires_at=$1 WHERE job_id=$2 AND token=$3 AND expires_at>$4`, [expires,fence.taskId,fence.token,now]);
  return result.rowCount === 1;
}
