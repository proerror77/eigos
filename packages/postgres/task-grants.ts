import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {DomainError,type Job,type Principal} from '../core/domain.js';
import {digest} from '../core/delegation.js';
import {taskDataGrantSchema,taskExecutionAuthoritySchema,SECURITY_CONTRACT,POLICY_VERSION,securityDefaults} from '../security/contracts.js';
import {SecurityError} from '../security/errors.js';
import {storedSourceSchema} from '../security/source-policy.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {postgresBusinessSchema} from './runtime-transaction.js';
import {postgresAgentWriteAdmission} from './task-read-access.js';
import {PostgresTaskBindings} from './task-bindings.js';

type TaskGrant=z.infer<typeof taskDataGrantSchema>;
/** Internal provisioning only. Public commands supply checked personal inputs;
 * neither an OAuth scope nor this function itself creates business authority. */
export async function postgresProvisionTask(client:Client,principal:Principal,job:Job,policyDigest:string,
  inputs:TaskGrant['inputs'],options:{previous?:TaskGrant;replacePersonalInputs?:boolean;builder?:StagedKernelBuilder}={}) {
  const admission=await postgresAgentWriteAdmission(client,structuredClone(principal),policyDigest),{actor,parent}=admission;
  const q=`"${postgresBusinessSchema(client)}"`,request=job.delegation?.request;
  if(!request||request.id!==job.id)throw new SecurityError('AUTHORIZATION_REQUIRED');
  const at=Date.now(),issuedAt=new Date(at).toISOString(),previous=options.previous&&taskDataGrantSchema.parse(structuredClone(options.previous));
  if(previous&&(previous.ownerKey!==actor.ownerKey||previous.installationId!==actor.installationId||previous.taskId!==job.id))throw new SecurityError('ACCESS_REVOKED');
  const rows=await client.query(`SELECT owner,CASE WHEN jsonb_typeof("${postgresBusinessSchema(client)}".eigos_try_jsonb(body)#>'{delegation,request,revision}')='number'
    THEN("${postgresBusinessSchema(client)}".eigos_try_jsonb(body)#>>'{delegation,request,revision}')::numeric END AS request_revision
    FROM ${q}.jobs WHERE id=$1 LIMIT 2`,[job.id]);
  if(rows.rowCount!==1||rows.rows[0]?.owner!==actor.ownerKey||String(rows.rows[0]?.request_revision)!==String(request.revision))throw new DomainError('CONFLICT','Grant must bind the current owned request revision');
  const sources=await client.query(`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body
    FROM ${q}.security_sources WHERE owner=$1 AND installation_id=$2 AND state='active' LIMIT 257`,[actor.ownerKey,actor.installationId]);
  if(sources.rows.length>256||sources.rows.some(row=>row.body===null))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
  const rules=sources.rows.flatMap(row=>{
    const source=storedSourceSchema.parse(JSON.parse(String(row.body)));
    if(source.bindingId!==row.binding_id||source.programId!==row.program_id||source.parentGrant.id!==parent.id||source.parentGrant.revision!==parent.revision||Date.parse(source.expiresAt)<=at)return [];
    return source.outputTypes.flatMap(type=>{const resource=parent.resources.find(resource=>resource.type===type);return resource?[{programId:source.programId,programDigest:source.programDigest,sourceBindingId:source.bindingId,type,fields:resource.fields}]:[];});
  });
  const selected=options.replacePersonalInputs?inputs:previous?.inputs??inputs;
  const grant=taskDataGrantSchema.parse({version:SECURITY_CONTRACT,id:randomUUID(),revision:1,kind:'task_data',status:'active',ownerKey:actor.ownerKey,
    memberId:actor.memberId,approvedByMemberId:actor.memberId,installationId:actor.installationId,parentGrant:{id:parent.id,revision:parent.revision},issuedAt,
    expiresAt:new Date(Math.min(Date.parse(parent.expiresAt),previous?Date.parse(previous.expiresAt):at+securityDefaults.taskGrantMaxSeconds*1000,
      job.delegation?.pipelineValidation?Date.parse(job.delegation.pipelineValidation.expiresAt):Infinity)).toISOString(),
    taskId:job.id,requestRevision:request.revision,purpose:previous?.purpose??'delegated_task',
    operations:previous?[...new Set([...previous.operations,...(options.replacePersonalInputs&&selected.length?['member_asset.read']:[])])]
      :['task.process',...(selected.length?['member_asset.read']:[]),...(principal.scopes.includes('tasks:read')?['task.query','task.result.read',...(parent.channels.includes('controlled_download')?['artifact.export']:[])]:[])],
    inputs:selected,outputs:previous?.outputs??rules,channels:previous?.channels??parent.channels});
  const permitted=(type:string,fields:string[])=>fields.every(field=>parent.resources.some(resource=>resource.type===type&&resource.fields.includes(field)));
  if(grant.purpose!=='delegated_task'||Date.parse(grant.expiresAt)<=at||!grant.channels.every(channel=>parent.channels.includes(channel))
    ||!grant.inputs.every(input=>permitted(input.object.type,input.fields))
    ||!grant.outputs.every(output=>permitted(output.type,output.fields)&&parent.sourceBindingIds.includes(output.sourceBindingId)))throw new SecurityError('ACCESS_REVOKED');
  for(const input of grant.inputs){const row=await client.query(`SELECT revision FROM ${q}.ontology_objects WHERE owner=$1 AND type=$2 AND id=$3`,[actor.ownerKey,input.object.type,input.object.id]);
    if(row.rowCount!==1||String(row.rows[0]?.revision)!==String(input.objectRevision))throw new DomainError('CONFLICT','Grant input must reference a current owned object revision');}
  if(previous){
    const revoked=await client.query(`UPDATE ${q}.security_grants SET state='revoked',revision=revision+1 WHERE owner=$1 AND id=$2 AND revision=$3 AND state='active'`,[actor.ownerKey,previous.id,previous.revision]);
    if(revoked.rowCount!==1)throw new SecurityError('POLICY_CHANGED');
    await client.query(`UPDATE ${q}.security_task_authorities SET state='revoked' WHERE data_grant_id=$1`,[previous.id]);
    await client.query(`INSERT INTO ${q}.security_events(id,at,kind,subject_digest,revision) VALUES($1,$2,'grant_revoked',$3,$4)`,[randomUUID(),at,digest(previous.id),previous.revision+1]);
  }
  await client.query(`INSERT INTO ${q}.security_grants(id,kind,owner,member_id,installation_id,parent_id,parent_revision,revision,state,expires_at,body)
    VALUES($1,'task_data',$2,$3,$4,$5,$6,1,'active',$7,$8)`,[grant.id,grant.ownerKey,grant.memberId,grant.installationId,parent.id,parent.revision,Date.parse(grant.expiresAt),JSON.stringify(grant)]);
  const bindings=new PostgresTaskBindings(client,options.builder);await bindings.bindInputs(grant,parent);await bindings.project(grant,parent,job);
  const authority=taskExecutionAuthoritySchema.parse({version:SECURITY_CONTRACT,id:randomUUID(),revision:1,ownerKey:actor.ownerKey,memberId:actor.memberId,installationId:actor.installationId,
    taskId:job.id,requestRevision:grant.requestRevision,agentGrant:grant.parentGrant,dataGrant:{id:grant.id,revision:grant.revision},submittedScopes:[...new Set(principal.scopes)],
    authEpoch:actor.authEpoch,policyVersion:POLICY_VERSION,issuedAt,expiresAt:grant.expiresAt});
  if(!grant.operations.includes('task.process')||!authority.submittedScopes.includes('tasks:write')||grant.inputs.length>0&&!authority.submittedScopes.includes('tasks:read'))throw new SecurityError('ACCESS_REVOKED');
  await client.query(`INSERT INTO ${q}.security_task_authorities(id,owner,member_id,installation_id,task_id,request_revision,agent_grant_id,agent_grant_revision,data_grant_id,data_grant_revision,auth_epoch,state,expires_at,body)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,'active',$11,$12)`,[authority.id,authority.ownerKey,authority.memberId,authority.installationId,job.id,authority.requestRevision,parent.id,parent.revision,grant.id,actor.authEpoch,Date.parse(authority.expiresAt),JSON.stringify(authority)]);
  await client.query(`INSERT INTO ${q}.security_events(id,at,kind,subject_digest,revision) VALUES($1,$2,'task_grant_issued',$3,1),($4,$2,'task_authority_attached',$5,1)`,[randomUUID(),at,digest(grant.id),randomUUID(),digest(authority.id)]);
  return {grant,authority};
}
