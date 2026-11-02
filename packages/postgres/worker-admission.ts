import type {Client} from 'pg';
import {agentAccessGrantSchema,taskDataGrantSchema} from '../security/contracts.js';
import {SecurityError} from '../security/errors.js';
import {postgresWorkAuthority} from './work-authority.js';
import {postgresBusinessSchema,postgresConstrainReadDeadline} from './runtime-transaction.js';

/** Worker authority is derived from persisted task delegation, never from a
 * borrowed user token or a caller-supplied installation identity. */
export async function postgresWorkerAdmission(client:Client,owner:string,taskId:string,policyDigest:string){
  const authority=await postgresWorkAuthority(client,owner,taskId,policyDigest);
  if(!authority)throw new SecurityError('AUTHORIZATION_REQUIRED');
  const q=`"${postgresBusinessSchema(client)}"`;
  const rows=await client.query(`SELECT s.epoch,s.valid_until,s.client_id,m.expires_at AS manager_until,p.revision AS policy_revision,
    g.revision AS parent_revision,g.state AS parent_state,g.expires_at AS parent_until,
    d.revision AS data_revision,d.state AS data_state,d.expires_at AS data_until,a.expires_at AS authority_until,
    CASE WHEN octet_length(g.body)<=1048576 THEN g.body END AS parent_body,CASE WHEN octet_length(d.body)<=1048576 THEN d.body END AS data_body,
    EXISTS(SELECT 1 FROM ${q}.security_fences f WHERE f.owner=s.owner AND f.state<>'cleared'
      AND ((f.kind='member' AND f.target_id=s.member_id) OR(f.kind='connection' AND f.target_id=s.client_id) OR(f.kind='installation' AND f.target_id=s.installation_id))) AS fenced
    FROM ${q}.security_subjects s JOIN ${q}.security_task_authorities a ON a.installation_id=s.installation_id AND a.owner=s.owner AND a.member_id=s.member_id
    JOIN ${q}.security_grants g ON g.id=a.agent_grant_id JOIN ${q}.security_grants d ON d.id=a.data_grant_id
    CROSS JOIN ${q}.security_manager m CROSS JOIN ${q}.security_policy p
    WHERE a.id=$1 AND a.state='active' AND s.state='active' AND g.state='active' AND d.state='active' AND m.slot=1 AND p.slot=1 LIMIT 2`,[authority.id]);
  const row=rows.rows[0];if(rows.rowCount!==1||!row||row.fenced!==false||typeof row.parent_body!=='string'||typeof row.data_body!=='string')throw new SecurityError('ACCESS_REVOKED');
  const parent=agentAccessGrantSchema.parse({...JSON.parse(row.parent_body),revision:Number(row.parent_revision),status:row.parent_state});
  const grant=taskDataGrantSchema.parse({...JSON.parse(row.data_body),revision:Number(row.data_revision),status:row.data_state});
  const policyRevision=Number(row.policy_revision);
  if(parent.ownerKey!==owner||grant.ownerKey!==owner||authority.ownerKey!==owner||parent.memberId!==authority.memberId||grant.memberId!==authority.memberId
    ||parent.installationId!==authority.installationId||grant.installationId!==authority.installationId||grant.taskId!==taskId||authority.taskId!==taskId
    ||parent.id!==authority.agentGrant.id||parent.revision!==authority.agentGrant.revision||grant.id!==authority.dataGrant.id||grant.revision!==authority.dataGrant.revision
    ||grant.parentGrant.id!==parent.id||grant.parentGrant.revision!==parent.revision||grant.requestRevision!==authority.requestRevision||Number(row.epoch)!==authority.authEpoch
    ||grant.purpose!=='delegated_task'||!grant.operations.includes('task.process')||grant.inputs.length>0&&!grant.operations.includes('member_asset.read')
    ||(authority.authorityOrigin==='agent_submission'?!authority.submittedScopes.includes('tasks:write')||grant.inputs.length>0&&!authority.submittedScopes.includes('tasks:read'):authority.submittedScopes.length!==0)
    ||!Number.isSafeInteger(policyRevision)||policyRevision<1)throw new SecurityError('ACCESS_REVOKED');
  const validUntil=Math.min(Number(row.valid_until),Number(row.manager_until),Number(row.parent_until),Number(row.data_until),Number(row.authority_until),
    Date.parse(parent.expiresAt),Date.parse(grant.expiresAt),Date.parse(authority.expiresAt));
  if(!Number.isSafeInteger(validUntil)||validUntil<=Date.now())throw new SecurityError('ACCESS_REVOKED');
  postgresConstrainReadDeadline(client,validUntil);
  return {authority,parent,grant,policyRevision,validUntil,clientId:String(row.client_id)};
}
