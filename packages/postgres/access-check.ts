import type {Client} from 'pg';
import type {Principal} from '../core/domain.js';
import {requireScope} from '../core/domain.js';
import {digest} from '../core/delegation.js';
import {matchesAgentGrant} from '../core/agent-authorization.js';
import type {PlanGrant} from '../ontology/actions.js';
import {objectRefSchema} from '../ontology/model.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {actionSources} from '../security/component-authority.js';
import {checkAccessSchema} from '../security/view-contracts.js';
import {storedSourceSchema} from '../security/source-policy.js';
import {SecurityError} from '../security/errors.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresConstrainReadDeadline} from './runtime-transaction.js';
import {PostgresTaskStorage} from './task-storage.js';
import {postgresWorkAuthority} from './work-authority.js';
import {postgresTaskResourcePermissionValidUntil,type PostgresTaskReadAdmission} from './task-read-access.js';
import {withPostgresTaskPermissionAuthorization,type PostgresTaskPermissionAuthorization} from './task-output.js';

type CheckOperation='task.query'|'task.result.read'|'task.process';
type Args=ReturnType<typeof checkAccessSchema.parse>;
const fingerprint=(admission:PostgresTaskReadAdmission,operation:CheckOperation)=>digest({installation:admission.actor.installationId,epoch:admission.actor.authEpoch,
  grant:{id:admission.grant.id,revision:admission.grant.revision},policyRevision:admission.policyRevision,operation});

/** Source-parity action readiness only. This never authorizes dispatch, reserves
 * budget, exposes values, or replaces the Worker/source semantic proof ports. */
async function checkAction(client:Client,principal:Principal,taskId:string,action:string,policy:string,admission:PostgresTaskReadAdmission,
  auth:PostgresTaskPermissionAuthorization,permission:(kind:string,id:string,operation:'resource.view'|'action.execute'|'function.invoke')=>Promise<boolean>,builder?:StagedKernelBuilder):Promise<string>{
  if(admission.actor.actorKind!=='agent'||!admission.actor.tokenScopes.includes('tasks:write'))return 'AUTHORIZATION_REQUIRED';
  if(!await permission('actionType',action,'resource.view')||!await permission('actionType',action,'action.execute'))return 'AUTHORIZATION_REQUIRED';
  if(!admission.grant.operations.includes('task.process'))return 'AUTHORIZATION_REQUIRED';
  const owner=admission.actor.ownerKey,authority=await postgresWorkAuthority(client,owner,taskId,policy);
  if(!authority||authority.installationId!==admission.actor.installationId||authority.dataGrant.id!==admission.grant.id)return 'AUTHORIZATION_REQUIRED';
  postgresConstrainReadDeadline(client,Date.parse(authority.expiresAt));
  const job=await new PostgresTaskStorage(client,builder).get(owner,taskId),state=job.delegation?.agent,plan=state?.plans.find(value=>value.id===state.pendingPlanId),step=plan?.steps.find(value=>value.action===action);
  if(!plan||!step)return 'PLAN_REQUIRED';
  if(plan.ontologyPlanning.accessDigest!==fingerprint(admission,'task.process'))return 'POLICY_CHANGED';
  const q=`"${postgresBusinessSchema(client)}"`,intent=await client.query(`SELECT state FROM ${q}.action_intents WHERE owner=$1 AND job_id=$2 AND id=$3 LIMIT 2`,[owner,taskId,step.intentId]);
  if(intent.rowCount!==1||intent.rows[0].state!=='ready')return 'ORIGINAL_OPERATION_ONLY';
  try{
    const rows=await client.query(`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.security_sources
      WHERE owner=$1 AND installation_id=$2 AND state='active' ORDER BY __eigos_rowid LIMIT 257`,[owner,admission.actor.installationId]);
    if(rows.rows.length>256||rows.rows.some(row=>typeof row.body!=='string'))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    const sources=rows.rows.map(row=>{const source=storedSourceSchema.parse(JSON.parse(row.body));
      if(source.bindingId!==row.binding_id||source.programId!==row.program_id||source.installationId!==admission.actor.installationId)throw new SecurityError('SOURCE_NOT_AUTHORIZED');return source;
    }).filter(source=>source.parentGrant.id===admission.parent.id&&source.parentGrant.revision===admission.parent.revision&&Date.parse(source.expiresAt)>Date.now());
    for(const needed of actionSources(state!,action,step.input,step)){
      const source=sources.find(value=>value.programId===needed.programRef.id&&value.programDigest===needed.programDigest&&value.operations.includes(action));
      if(!source||!admission.grant.outputs.some(output=>output.programId===needed.programRef.id&&output.programDigest===needed.programDigest&&output.sourceBindingId===source.bindingId))return 'SOURCE_NOT_AUTHORIZED';
      postgresConstrainReadDeadline(client,Date.parse(source.expiresAt));
    }
  }catch{return 'SOURCE_NOT_AUTHORIZED';}
  let nodes=0;
  const inspect=async(value:unknown,depth=0):Promise<boolean>=>{
    if(++nodes>5000||depth>64)return false;
    if(!value||typeof value!=='object')return true;
    const parsed=objectRefSchema.safeParse(value);if(parsed.success)return !!await auth.bindingMetadata(parsed.data);
    for(const item of Object.values(value))if(!await inspect(item,depth+1))return false;return true;
  };
  if(!await inspect(step.input))return 'INSUFFICIENT_ACCESS';
  if(!['read','local'].includes(step.effect)){
    const rows=await client.query(`SELECT id,CASE WHEN octet_length(body)<=8388608 AND sum(octet_length(body)) OVER()<=33554432 THEN body END AS body FROM ${q}.plan_grants WHERE owner=$1 AND job_id=$2 ORDER BY __eigos_rowid LIMIT 257`,[owner,taskId]);
    if(rows.rows.length>256||rows.rows.some(row=>typeof row.body!=='string'))return 'BUSINESS_AUTHORIZATION_REQUIRED';
    const current=Date.now();let expiry=0;
    for(const row of rows.rows){const grant=JSON.parse(row.body) as PlanGrant;
      if(grant.id===row.id&&grant.owner===owner&&grant.jobId===taskId&&Number.isFinite(Date.parse(grant.expiresAt))&&matchesAgentGrant(grant,plan,step,current)){expiry=Date.parse(grant.expiresAt);break;}}
    if(!expiry)return 'BUSINESS_AUTHORIZATION_REQUIRED';postgresConstrainReadDeadline(client,expiry);
  }
  return 'ALLOWED';
}

/** Permission metadata with the same reason precedence and response shape as
 * AuthorizedOntologyView.check. ALLOWED creates no authority or output channel. */
export async function postgresCheckAccess(client:Client,principal:Principal,input:unknown,policy:string,builder?:StagedKernelBuilder){
  requireScope(principal,'tasks:read');const args:Args=checkAccessSchema.parse(input),captured=structuredClone(principal),token=postgresBusinessToken(client);
  const operation:CheckOperation=args.operation==='task.result.read'?'task.result.read':args.operation==='action.execute'?'task.process':'task.query';
  return withPostgresTaskPermissionAuthorization(client,captured,args.taskId,policy,operation,async(auth,admission)=>{
    const binding=args.object?await auth.bindingMetadata(args.object):undefined;
    let reason=(!args.object||!!binding&&(args.fields??[]).every(field=>binding.fields.includes(field)))?'ALLOWED':'INSUFFICIENT_ACCESS';
    const permission=async(kind:string,id:string,operation:'resource.view'|'action.execute'|'function.invoke')=>{
      const until=await postgresTaskResourcePermissionValidUntil(client,captured,args.taskId,policy,kind,id,operation,builder);
      if(until<=Date.now())return false;postgresConstrainReadDeadline(client,until);return true;
    };
    if(args.operation==='resource.view')reason=args.resource&&await permission(args.resource.kind,args.resource.id,'resource.view')?reason:'AUTHORIZATION_REQUIRED';
    if(args.operation==='function.invoke')reason=args.resource?.kind==='function'&&await permission('function',args.resource.id,'resource.view')&&await permission('function',args.resource.id,'function.invoke')?reason:'AUTHORIZATION_REQUIRED';
    if(args.operation==='action.execute')reason=args.resource?.kind==='actionType'?await checkAction(client,captured,args.taskId,args.resource.id,policy,admission,auth,permission,builder):'AUTHORIZATION_REQUIRED';
    if(args.operation==='artifact.export'){
      let available=false;
      try{available=!!args.artifactId&&(await auth.artifacts()).some(artifact=>artifact.id===args.artifactId);}
      catch(error){if(!(error instanceof SecurityError))throw error;}
      // Source artifacts() hides invalid per-artifact evidence. The enclosing
      // permission snapshot still rechecks the Agent/grant/policy at exit.
      reason=available?'ALLOWED':'OUTPUT_NOT_ALLOWED';
    }
    if(postgresBusinessToken(client)!==token)throw new SecurityError('AUTHORIZATION_REQUIRED');
    const allowed=reason==='ALLOWED';return {version:2 as const,allowed,reason,fields:allowed?binding?.fields??[]:[],grant:{id:admission.grant.id,revision:admission.grant.revision},policyRevision:admission.policyRevision,grantsAuthority:false as const};
  },builder);
}
