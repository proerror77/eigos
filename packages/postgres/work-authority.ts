import type { Client } from 'pg';
import { taskExecutionAuthoritySchema } from '../security/contracts.js';
import { postgresBusinessSchema } from './runtime-transaction.js';

/** PostgreSQL equivalent of SecurityStore.workAuthority. This only resolves
 * current task authority; the caller must separately validate the Worker claim,
 * task state and policy scope before any operation. */
export async function postgresWorkAuthority(client: Client, owner: string, taskId: string, policyDigest: string) {
  const schema = postgresBusinessSchema(client);
  const now = Date.now();
  if (!owner || !taskId || !Number.isSafeInteger(now) || now < 0 || !/^[a-f0-9]{64}$/.test(policyDigest)) throw new Error('Invalid PostgreSQL task authority input');
  const q = `"${schema}"`, json = `${q}.eigos_try_jsonb`;
  const result = await client.query(`SELECT a.body FROM ${q}.security_task_authorities a
    JOIN ${q}.jobs j ON j.id=a.task_id AND j.owner=a.owner
    JOIN ${q}.security_subjects s ON s.installation_id=a.installation_id AND s.owner=a.owner AND s.member_id=a.member_id
    JOIN ${q}.security_grants g ON g.id=a.agent_grant_id AND g.owner=a.owner AND g.installation_id=a.installation_id AND g.kind='agent_access'
    JOIN ${q}.security_grants d ON d.id=a.data_grant_id AND d.owner=a.owner AND d.installation_id=a.installation_id AND d.kind='task_data' AND d.parent_id=g.id AND d.parent_revision=g.revision
    JOIN ${q}.security_manager m ON m.slot=1
    JOIN ${q}.security_settings cfg ON cfg.slot=1 AND cfg.version=2 AND cfg.mode='foundation'
    JOIN ${q}.security_policy pol ON pol.slot=1 AND pol.revision BETWEEN 1 AND 9007199254740991
    JOIN ${q}.security_policy_definitions pd ON pd.slot=1 AND pd.digest=$1
    WHERE a.state='active' AND s.state='active' AND g.state='active' AND d.state='active'
    AND s.epoch=a.auth_epoch AND g.revision=a.agent_grant_revision AND d.revision=a.data_grant_revision
    AND a.request_revision=CASE WHEN pg_catalog.jsonb_typeof(${json}(j.body) #> '{delegation,request,revision}')='number' THEN (${json}(j.body) #>> '{delegation,request,revision}')::numeric END
    AND ${json}(d.body) #>> '{purpose}'='delegated_task'
    AND a.expires_at>$2 AND s.valid_until>$2 AND g.expires_at>$2 AND d.expires_at>$2 AND m.expires_at>$2
    AND a.owner=$3 AND a.task_id=$4 LIMIT 2`, [policyDigest, now, owner, taskId]);
  if (!result.rowCount) return undefined;
  if (result.rowCount !== 1) throw new Error('Multiple PostgreSQL task authorities');
  return taskExecutionAuthoritySchema.parse(JSON.parse(String(result.rows[0].body)));
}
