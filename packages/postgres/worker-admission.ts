import type {Client} from 'pg';
import {agentAccessGrantSchema,taskDataGrantSchema,taskExecutionAuthoritySchema} from '../security/contracts.js';
import {SecurityError} from '../security/errors.js';
import {BACKEND_VERSION} from '../ontology/execution.js';
import {postgresBusinessSchema,postgresBusinessAuthorityDigest,postgresConstrainReadDeadline} from './runtime-transaction.js';

/** Internal SQL shared by business admission and lease-only renewal. The
 * supplied schema is server configuration, never a model/tool argument. */
export function postgresWorkerScopeQuery(schema:string):string{
  if(!/^eigos_business_[a-z0-9_]{1,40}$/.test(schema))throw new Error('Invalid PostgreSQL business schema');
  const q=`"${schema}"`,json=`${q}.eigos_try_jsonb`;
  return `SELECT a.id AS authority_row_id,a.owner,a.member_id,a.installation_id,a.task_id,a.request_revision,a.auth_epoch AS epoch,
    a.agent_grant_id AS parent_id,a.agent_grant_revision AS parent_revision,a.data_grant_id AS data_id,a.data_grant_revision AS data_revision,
    a.expires_at AS authority_until,CASE WHEN octet_length(a.body)<=1048576 THEN a.body END AS authority_body,
    g.state AS parent_state,g.expires_at AS parent_until,d.state AS data_state,d.expires_at AS data_until,
    CASE WHEN octet_length(g.body)<=1048576 THEN g.body END AS parent_body,CASE WHEN octet_length(d.body)<=1048576 THEN d.body END AS data_body,
    s.valid_until,s.client_id,m.expires_at AS manager_until,p.revision AS policy_revision,pd.digest AS policy_digest,
    runtime.id AS runtime_id,runtime.revision AS runtime_revision,runtime.configuration_digest AS runtime_digest,
    j.state AS stored_state,job.value->>'state' AS job_state,
    CASE WHEN jsonb_typeof(job.value->'revision')='number' THEN(job.value->>'revision')::numeric END AS job_revision,
    COALESCE(job.value#>'{delegation,recoveryPending}'='true'::jsonb,false) AS recovery_pending,
    EXISTS(SELECT 1 FROM ${q}.security_fences f WHERE f.owner=s.owner AND f.state<>'cleared'
      AND((f.kind='member' AND f.target_id=s.member_id) OR(f.kind='connection' AND f.target_id=s.client_id) OR(f.kind='installation' AND f.target_id=s.installation_id))) AS fenced
    FROM ${q}.security_task_authorities a JOIN ${q}.jobs j ON j.id=a.task_id AND j.owner=a.owner
    JOIN ${q}.security_subjects s ON s.installation_id=a.installation_id AND s.owner=a.owner AND s.member_id=a.member_id
    JOIN ${q}.security_grants g ON g.id=a.agent_grant_id AND g.owner=a.owner AND g.member_id=a.member_id AND g.installation_id=a.installation_id AND g.kind='agent_access'
    JOIN ${q}.security_grants d ON d.id=a.data_grant_id AND d.owner=a.owner AND d.member_id=a.member_id AND d.installation_id=a.installation_id AND d.kind='task_data'
    JOIN ${q}.security_manager m ON m.slot=1 JOIN ${q}.security_settings cfg ON cfg.slot=m.slot AND cfg.version=2 AND cfg.mode='foundation'
    JOIN ${q}.security_policy p ON p.slot=m.slot JOIN ${q}.security_policy_definitions pd ON pd.slot=p.slot AND pd.digest=$1
    CROSS JOIN ${q}.eigos_current_runtime_authority() runtime
    CROSS JOIN LATERAL(SELECT ${json}(j.body) AS value OFFSET 0) job
    CROSS JOIN LATERAL(SELECT CASE WHEN jsonb_typeof(job.value)='object' THEN j.body::json ELSE '{}'::json END AS value OFFSET 0) source
    CROSS JOIN LATERAL(SELECT CASE WHEN octet_length(d.body)<=1048576 THEN ${json}(d.body) END AS value OFFSET 0) data
    WHERE a.owner=$2 AND a.task_id=$3 AND a.state='active' AND s.state='active' AND g.state='active' AND d.state='active'
      AND a.auth_epoch=s.epoch AND a.agent_grant_revision=g.revision AND a.data_grant_revision=d.revision
      AND d.parent_id=g.id AND d.parent_revision=g.revision AND data.value->>'purpose'='delegated_task'
      AND a.request_revision=CASE WHEN jsonb_typeof(job.value#>'{delegation,request,revision}')='number' THEN(job.value#>>'{delegation,request,revision}')::numeric END
      AND job.value->>'id'=j.id AND job.value->>'authorityId'=runtime.id AND job.value->>'executionMode'='worker-security-v2'
      AND job.value->>'service'='eigos.delegate' AND job.value#>>'{delegation,backendVersion}'='${BACKEND_VERSION}'
      AND a.expires_at>$4 AND s.valid_until>$4 AND g.expires_at>$4 AND d.expires_at>$4 AND m.expires_at>$4
      AND p.revision BETWEEN 1 AND 9007199254740991
      AND NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN jsonb_typeof(data.value)='object' THEN d.body::json ELSE '{}'::json END)
        WHERE key IN('taskId','requestRevision','purpose') GROUP BY key HAVING count(*)>1)
      AND NOT EXISTS(SELECT 1 FROM json_each(source.value)
        WHERE key IN('id','state','revision','authorityId','executionMode','service','delegation') GROUP BY key HAVING count(*)>1)
      AND NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN json_typeof(source.value->'delegation')='object' THEN source.value->'delegation' ELSE '{}'::json END)
        WHERE key='request' GROUP BY key HAVING count(*)>1)
      AND NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN json_typeof(source.value#>'{delegation,request}')='object' THEN source.value#>'{delegation,request}' ELSE '{}'::json END)
        WHERE key='revision' GROUP BY key HAVING count(*)>1) LIMIT 2`;
}

/** Parse the exact same persisted delegation for both transaction types. This
 * does not itself establish a claim or grant any output/model channel. */
export function parsePostgresWorkerScope(row:Record<string,unknown>,owner:string,taskId:string,policyDigest:string){
  if(row.fenced!==false||typeof row.authority_body!=='string'||typeof row.parent_body!=='string'||typeof row.data_body!=='string')throw new SecurityError('ACCESS_REVOKED');
  const authority=taskExecutionAuthoritySchema.parse(JSON.parse(row.authority_body));
  const parent=agentAccessGrantSchema.parse({...JSON.parse(row.parent_body),revision:Number(row.parent_revision),status:row.parent_state});
  const grant=taskDataGrantSchema.parse({...JSON.parse(row.data_body),revision:Number(row.data_revision),status:row.data_state});
  const policyRevision=Number(row.policy_revision),revision=Number(row.job_revision);
  if(authority.id!==row.authority_row_id||row.owner!==owner||row.task_id!==taskId||row.member_id!==authority.memberId||row.installation_id!==authority.installationId
    ||parent.id!==row.parent_id||grant.id!==row.data_id||authority.ownerKey!==owner||parent.ownerKey!==owner||grant.ownerKey!==owner
    ||parent.memberId!==authority.memberId||grant.memberId!==authority.memberId||parent.installationId!==authority.installationId||grant.installationId!==authority.installationId
    ||grant.taskId!==taskId||authority.taskId!==taskId||parent.id!==authority.agentGrant.id||parent.revision!==authority.agentGrant.revision
    ||grant.id!==authority.dataGrant.id||grant.revision!==authority.dataGrant.revision||grant.parentGrant.id!==parent.id||grant.parentGrant.revision!==parent.revision
    ||grant.requestRevision!==authority.requestRevision||Number(row.request_revision)!==authority.requestRevision||Number(row.epoch)!==authority.authEpoch
    ||grant.purpose!=='delegated_task'||!grant.operations.includes('task.process')||grant.inputs.length>0&&!grant.operations.includes('member_asset.read')
    ||(authority.authorityOrigin==='agent_submission'?!authority.submittedScopes.includes('tasks:write')||grant.inputs.length>0&&!authority.submittedScopes.includes('tasks:read'):authority.submittedScopes.length!==0)
    ||!Number.isSafeInteger(policyRevision)||policyRevision<1||row.policy_digest!==policyDigest||!Number.isSafeInteger(revision)||revision<0||row.job_state!==row.stored_state)throw new SecurityError('ACCESS_REVOKED');
  const validUntil=Math.min(Number(row.valid_until),Number(row.manager_until),Number(row.parent_until),Number(row.data_until),Number(row.authority_until),
    Date.parse(parent.expiresAt),Date.parse(grant.expiresAt),Date.parse(authority.expiresAt));
  if(!Number.isSafeInteger(validUntil)||validUntil<=Date.now())throw new SecurityError('ACCESS_REVOKED');
  return {authority,parent,grant,policyRevision,validUntil,clientId:String(row.client_id)};
}

/** Business operations additionally retain the original transaction's authority
 * and response deadline. A Worker never borrows an Agent bearer identity. */
export async function postgresWorkerAdmission(client:Client,owner:string,taskId:string,policyDigest:string){
  const schema=postgresBusinessSchema(client);
  const rows=await client.query(postgresWorkerScopeQuery(schema),[policyDigest,owner,taskId,Date.now()]);
  if(rows.rowCount!==1)throw new SecurityError('AUTHORIZATION_REQUIRED');
  const row=rows.rows[0];if(row.runtime_digest!==postgresBusinessAuthorityDigest(client))throw new SecurityError('POLICY_CHANGED');
  const scope=parsePostgresWorkerScope(row,owner,taskId,policyDigest);postgresConstrainReadDeadline(client,scope.validUntil);return scope;
}
