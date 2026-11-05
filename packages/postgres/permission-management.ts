import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {z} from 'zod';
import {DomainError,ownerKey} from '../core/domain.js';
import {digest} from '../core/delegation.js';
import {ExecutionCatalog} from '../core/catalog.js';
import type {ExecutionAttempt} from '../ontology/actions.js';
import {currentKernelImplementation} from '../ontology/definition-store.js';
import {stagedKernelComponents,type StagedKernelBuilder} from '../ontology/seed-definition.js';
import type {OntologyModel} from '../ontology/model.js';
import type {MemberPermissionCoordinatorPort,MemberPermissionReview} from '../members/ports.js';
import {agentGrantRequestSchema} from '../security/coordinator.js';
import {agentAccessGrantSchema,taskDataGrantSchema,taskExecutionAuthoritySchema,grantRefSchema,SECURITY_CONTRACT,POLICY_VERSION} from '../security/contracts.js';
import {consentExpirySchema} from '../security/consent-lifetime.js';
import {reviewedFieldPolicy} from '../security/field-policy.js';
import {projectionFields} from '../security/projections.js';
import {TASK_PROJECTION_TYPES} from '../security/policy-store.js';
import {roleSchema,roleAllows} from '../security/resource-role.js';
import {sourceAuthorizationSchema,storedSourceSchema,type StoredSource} from '../security/source-policy.js';
import {recoveryObservationSchema,type OriginalOperation} from '../security/recovery.js';
import {SecurityError} from '../security/errors.js';
import {assertReviewedModel} from '../security/model-review.js';
import type {Subject} from '../security/store.js';
import type {PostgresDatabase} from './database.js';
import type {PostgresMemberStore} from './member-store.js';
import type {PostgresAuthorizationPublisher} from './authority-publisher.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresConstrainReadDeadline} from './runtime-transaction.js';
import {postgresConsentDeadline,postgresConsentIndex,postgresConstrainConsent} from './consent.js';
import {postgresOntologyReadContext} from './ontology-release.js';
import {PostgresTaskStorage} from './task-storage.js';
import {PostgresTaskBindings} from './task-bindings.js';

type AgentGrant=z.infer<typeof agentAccessGrantSchema>;
type TaskGrant=z.infer<typeof taskDataGrantSchema>;
type Grant=AgentGrant|TaskGrant;
type TaskAuthority=z.infer<typeof taskExecutionAuthoritySchema>;
type Context={client:Client;q:string;token:object;owner:string;memberId:string;model:OntologyModel;revision:number};
const fields=taskDataGrantSchema.shape;
const taskApprovalSchema=z.strictObject({taskId:z.uuid(),installationId:z.uuid(),expectedRequestRevision:z.number().int().positive(),
  replaces:grantRefSchema.optional(),expectedAgentGrant:grantRefSchema,takeover:z.boolean().default(false),renewOriginal:z.boolean().default(false),
  expectedSources:z.array(z.strictObject({programId:z.string().min(1),programDigest:z.string().regex(/^[a-f0-9]{64}$/),bindingId:z.string().min(1)})).max(100).optional(),
  inputs:fields.inputs,programIds:z.array(z.string().min(1)).max(100),purpose:fields.purpose,operations:fields.operations,channels:fields.channels,expiresAt:fields.expiresAt.default(null)});
const sourceApprovalSchema=z.strictObject({installationId:z.uuid(),bindingId:z.string().min(1),programId:z.string().min(1),operations:z.array(z.string()).min(1),outputTypes:z.array(z.string()).min(1),
  expiresAt:consentExpirySchema.default(null),expectedRevision:z.number().int().positive(),expectedAgentGrant:grantRefSchema});
const sourceRevocationSchema=z.strictObject({installationId:z.uuid(),bindingId:z.string().min(1),expectedRevision:z.number().int().positive()});
const recoveryApprovalSchema=z.strictObject({intentId:z.uuid(),installationId:z.uuid(),expectedIntentDigest:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.iso.datetime({offset:true})});
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
const equalSet=(a:readonly string[],b:readonly string[])=>same([...a].sort(),[...b].sort());

/** Browser-controller port, never bearer admission or a model tool. The host
 * supplies its actual, unbound current-kernel catalogue, trusted policy and
 * sole running publisher. A catalogue bound to another runtime is unsupported.
 * Route all membership revocations through this coordinator; do not install a
 * second deny observer for the same coordinated change. No method assigns a
 * role, model clearance, recipient policy or an unreviewed source. */
export class PostgresPermissionManagement implements MemberPermissionCoordinatorPort {
  constructor(private readonly options:{database:Pick<PostgresDatabase,'run'>;members:PostgresMemberStore;
    publisher:Pick<PostgresAuthorizationPublisher,'publish'|'coordinate'|'withManagement'>;catalog:ExecutionCatalog;policyDigest:string;builder?:StagedKernelBuilder}){
    if(!(options.catalog instanceof ExecutionCatalog)||!/^[a-f0-9]{64}$/.test(options.policyDigest))throw new Error('Actual catalogue and reviewed PostgreSQL permission policy are required');
  }
  private deadline(value:string|null,ctx:Context){return postgresConsentDeadline(value,this.options.policyDigest,ctx.model);}
  private async sql(ctx:Context,text:string,values:unknown[]=[]){
    if(postgresBusinessToken(ctx.client)!==ctx.token)throw new SecurityError('AUTHORIZATION_REQUIRED');
    const result=await ctx.client.query(text,values);
    if(postgresBusinessToken(ctx.client)!==ctx.token)throw new SecurityError('AUTHORIZATION_REQUIRED');return result;
  }
  private async run<T>(memberId:string,action:(ctx:Context)=>Promise<T>,reviewRevision?:number,installationId?:string):Promise<T>{
    z.uuid().parse(memberId);const member=await this.options.members.get(memberId),owner=ownerKey({...member,clientId:'',scopes:[]});
    if(installationId)await this.options.publisher.publish(memberId,z.uuid().parse(installationId));
    return this.options.database.run(client=>this.options.publisher.withManagement(client,async()=>{
      const q=`"${postgresBusinessSchema(client)}"`,rows=await client.query(`SELECT p.revision,d.digest FROM ${q}.security_policy p JOIN ${q}.security_policy_definitions d ON d.slot=p.slot WHERE p.slot=1`);
      const revision=Number(rows.rows[0]?.revision);
      if(rows.rowCount!==1||rows.rows[0].digest!==this.options.policyDigest||!Number.isSafeInteger(revision)||revision<1)throw new SecurityError('POLICY_CHANGED');
      if(reviewRevision!==undefined&&revision!==reviewRevision)throw new DomainError('CONFLICT','Permissions changed; review the current scope again');
      const release=await postgresOntologyReadContext(client,owner,{},false,this.options.builder),kernel=this.options.builder?stagedKernelComponents(this.options.builder).model:currentKernelImplementation();
      // Review the actual immutable model without silently upgrading it to the
      // host kernel. Metadata is derived from that exact published model.
      assertReviewedModel(kernel,release.model);
      return action({client,q,token:postgresBusinessToken(client),owner,memberId,model:release.model,revision});
    }));
  }
  private async subject(ctx:Context,installationId:string):Promise<Subject>{
    const rows=await this.sql(ctx,`SELECT s.*,EXISTS(SELECT 1 FROM ${ctx.q}.security_fences f WHERE f.owner=s.owner AND f.state<>'cleared'
      AND(f.kind='member' AND f.target_id=s.member_id OR f.kind='connection' AND f.target_id=s.client_id OR f.kind='installation' AND f.target_id=s.installation_id)) AS fenced
      FROM ${ctx.q}.security_subjects s WHERE s.installation_id=$1 LIMIT 2`,[installationId]);
    const row=rows.rows[0],epoch=Number(row?.epoch),validUntil=Number(row?.valid_until);
    if(rows.rowCount!==1||row.owner!==ctx.owner||row.member_id!==ctx.memberId||row.installation_id!==installationId||row.state!=='active'||row.fenced!==false
      ||!Number.isSafeInteger(epoch)||epoch<1||!Number.isSafeInteger(validUntil)||validUntil<=Date.now())throw new SecurityError('ACCESS_REVOKED');
    postgresConstrainReadDeadline(ctx.client,validUntil);return {ownerKey:ctx.owner,memberId:ctx.memberId,installationId,clientId:String(row.client_id),active:true,epoch,validUntil};
  }
  private parseGrant(ctx:Context,row:Record<string,unknown>):Grant{
    if(typeof row.body!=='string')throw new SecurityError('POLICY_CHANGED');
    const raw=JSON.parse(row.body),grant=(row.kind==='agent_access'?agentAccessGrantSchema:taskDataGrantSchema).parse({...raw,revision:Number(row.revision),status:row.state});
    if(grant.id!==row.id||grant.kind!==row.kind||grant.ownerKey!==ctx.owner||grant.memberId!==ctx.memberId||grant.installationId!==row.installation_id
      ||postgresConsentIndex(grant.expiresAt,this.options.policyDigest,ctx.model)!==Number(row.expires_at)
      ||('parentGrant'in grant&&(grant.parentGrant.id!==row.parent_id||grant.parentGrant.revision!==Number(row.parent_revision))))throw new SecurityError('POLICY_CHANGED');
    return grant;
  }
  private async allGrants(ctx:Context):Promise<Grant[]>{
    const rows=await this.sql(ctx,`SELECT id,kind,installation_id,parent_id,parent_revision,revision,state,expires_at,CASE WHEN octet_length(body)<=1048576 AND sum(octet_length(body)) OVER()<=8388608 THEN body END AS body
      FROM ${ctx.q}.security_grants WHERE owner=$1 ORDER BY __eigos_rowid LIMIT 2001`,[ctx.owner]);
    if(rows.rows.length>2000)throw new DomainError('CONFLICT','Permission history exceeds its bounded review');return rows.rows.map(row=>this.parseGrant(ctx,row));
  }
  private async parent(ctx:Context,installationId:string):Promise<AgentGrant>{
    await this.subject(ctx,installationId);
    const grants=(await this.allGrants(ctx)).filter((grant):grant is AgentGrant=>grant.kind==='agent_access'&&grant.installationId===installationId&&grant.status==='active');
    if(grants.length!==1||this.deadline(grants[0]!.expiresAt,ctx)<=Date.now())throw new SecurityError('AUTHORIZATION_REQUIRED');
    postgresConstrainConsent(ctx.client,grants[0]!.expiresAt,this.options.policyDigest,ctx.model);return grants[0]!;
  }
  private profiles(ctx:Context){
    const profiles=this.options.catalog.securityProfilesForModel(ctx.owner,ctx.model);
    if(profiles.length>100)throw new DomainError('CONFLICT','Registered source profiles exceed their review bound');
    for(const profile of profiles){for(const type of profile.outputTypes)ctx.model.object(type);for(const action of profile.operations)if(action!=='recover_original')ctx.model.action(action);}
    return profiles;
  }
  private async sources(ctx:Context,installationId:string,parent:AgentGrant):Promise<StoredSource[]>{
    const rows=await this.sql(ctx,`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${ctx.q}.security_sources
      WHERE owner=$1 AND installation_id=$2 AND state='active' LIMIT 257`,[ctx.owner,installationId]);
    if(rows.rows.length>256||rows.rows.some(row=>typeof row.body!=='string'))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    return rows.rows.map(row=>{const source=storedSourceSchema.parse(JSON.parse(row.body));
      if(source.installationId!==installationId||source.bindingId!==row.binding_id||source.programId!==row.program_id)throw new SecurityError('SOURCE_NOT_AUTHORIZED');return source;
    }).filter(source=>this.deadline(source.expiresAt,ctx)>Date.now()&&source.parentGrant.id===parent.id&&source.parentGrant.revision===parent.revision);
  }
  private async event(ctx:Context,kind:string,ref:unknown,revision:number){await this.sql(ctx,`INSERT INTO ${ctx.q}.security_events(id,at,kind,subject_digest,revision) VALUES($1,$2,$3,$4,$5)`,[randomUUID(),Date.now(),kind,digest(ref),revision]);}
  private async changePolicy(ctx:Context,expected:number){
    if(ctx.revision!==expected)throw new SecurityError('POLICY_CHANGED');
    const row=await this.sql(ctx,`UPDATE ${ctx.q}.security_policy SET revision=revision+1 WHERE slot=1 AND revision=$1 RETURNING revision`,[expected]);
    if(row.rowCount!==1)throw new SecurityError('POLICY_CHANGED');ctx.revision=Number(row.rows[0].revision);
  }
  private async insertGrant(ctx:Context,grant:Grant){
    await this.sql(ctx,`INSERT INTO ${ctx.q}.security_grants(id,kind,owner,member_id,installation_id,parent_id,parent_revision,revision,state,expires_at,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [grant.id,grant.kind,grant.ownerKey,grant.memberId,grant.installationId,'parentGrant'in grant?grant.parentGrant.id:null,'parentGrant'in grant?grant.parentGrant.revision:null,grant.revision,grant.status,postgresConsentIndex(grant.expiresAt,this.options.policyDigest,ctx.model),JSON.stringify(grant)]);
  }
  private async revoke(ctx:Context,id:string,expectedRevision:number){
    const grant=(await this.allGrants(ctx)).find(grant=>grant.id===id);if(!grant)throw new DomainError('NOT_FOUND','Grant not found');
    if(grant.revision!==expectedRevision)throw new DomainError('CONFLICT','Grant revision changed');
    await this.sql(ctx,`UPDATE ${ctx.q}.security_grants SET state='revoked',revision=revision+1 WHERE owner=$1 AND(id=$2 OR parent_id=$2)`,[ctx.owner,id]);
    await this.sql(ctx,`UPDATE ${ctx.q}.security_task_authorities SET state='revoked' WHERE owner=$1 AND(agent_grant_id=$2 OR data_grant_id=$2)`,[ctx.owner,id]);
    await this.event(ctx,'grant_revoked',id,expectedRevision+1);
  }
  private async approveAgent(ctx:Context,input:unknown){
    const args=agentGrantRequestSchema.parse(input),subject=await this.subject(ctx,args.installationId);
    for(const resource of args.resources){ctx.model.object(resource.type);const available={...ctx.model.properties(resource.type),...projectionFields(resource.type)};
      for(const field of resource.fields){if(!Object.hasOwn(available,field))throw new DomainError('INVALID_INPUT','Grant fields must be registered');
        if(available[field]!.restricted||reviewedFieldPolicy(ctx.model,resource.type,field)==='internal_only')throw new DomainError('FORBIDDEN','Grant cannot expose an internal or restricted property');}}
    const at=Date.now(),grant=agentAccessGrantSchema.parse({...args,version:SECURITY_CONTRACT,id:randomUUID(),revision:1,kind:'agent_access',scope:'task_only',ownerKey:subject.ownerKey,memberId:ctx.memberId,approvedByMemberId:ctx.memberId,issuedAt:new Date(at).toISOString(),status:'active'});
    if(this.deadline(grant.expiresAt,ctx)<=at)throw new SecurityError('ACCESS_REVOKED');
    if((await this.allGrants(ctx)).some(value=>value.kind==='agent_access'&&value.installationId===args.installationId&&value.status==='active'))throw new DomainError('CONFLICT','Revoke the current installation grant before approving a replacement');
    await this.insertGrant(ctx,grant);await this.event(ctx,'agent_grant_issued',grant.id,grant.revision);return grant;
  }
  private async approveSourceChange(ctx:Context,input:unknown){
    const args=sourceApprovalSchema.parse(input),parent=await this.parent(ctx,args.installationId),profile=this.profiles(ctx).find(value=>value.programId===args.programId&&value.bindingId===args.bindingId);
    if(!profile||!args.operations.every(action=>profile.operations.includes(action))||!args.outputTypes.every(type=>profile.outputTypes.includes(type)))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    if(parent.id!==args.expectedAgentGrant.id||parent.revision!==args.expectedAgentGrant.revision)throw new SecurityError('POLICY_CHANGED');
    const source=sourceAuthorizationSchema.parse({installationId:args.installationId,bindingId:args.bindingId,programId:args.programId,programDigest:profile.programDigest,operations:args.operations,outputTypes:args.outputTypes,expiresAt:args.expiresAt});
    if(!parent.capabilityIds.includes(source.programId)||!parent.sourceBindingIds.includes(source.bindingId)||this.deadline(source.expiresAt,ctx)<=Date.now()||this.deadline(source.expiresAt,ctx)>this.deadline(parent.expiresAt,ctx))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    for(const type of source.outputTypes)ctx.model.object(type);
    const rows=await this.sql(ctx,`SELECT state,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${ctx.q}.security_sources WHERE owner=$1 AND installation_id=$2 AND binding_id=$3 AND program_id=$4 LIMIT 2`,[ctx.owner,source.installationId,source.bindingId,source.programId]);
    if((rows.rowCount??0)>1||rows.rowCount&&typeof rows.rows[0].body!=='string')throw new SecurityError('POLICY_CHANGED');
    const prior=rows.rowCount?storedSourceSchema.parse(JSON.parse(rows.rows[0].body)):undefined;
    const readbackVersions=rows.rows[0]?.state==='active'&&prior?.programDigest===source.programDigest&&same(prior.parentGrant,{id:parent.id,revision:parent.revision})?prior.readbackVersions:undefined;
    const stored=storedSourceSchema.parse({...source,parentGrant:{id:parent.id,revision:parent.revision},...(readbackVersions?{readbackVersions}:{})});
    await this.changePolicy(ctx,args.expectedRevision);
    const written=await this.sql(ctx,`INSERT INTO ${ctx.q}.security_sources(owner,installation_id,binding_id,program_id,state,body) VALUES($1,$2,$3,$4,'active',$5)
      ON CONFLICT(installation_id,binding_id,program_id) DO UPDATE SET state='active',body=excluded.body WHERE security_sources.owner=excluded.owner RETURNING owner`,[ctx.owner,source.installationId,source.bindingId,source.programId,JSON.stringify(stored)]);
    if(written.rowCount!==1)throw new SecurityError('POLICY_CHANGED');
  }
  private async revokeSourceChange(ctx:Context,input:unknown){
    const args=sourceRevocationSchema.parse(input);await this.subject(ctx,args.installationId);await this.changePolicy(ctx,args.expectedRevision);
    const rows=await this.sql(ctx,`SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${ctx.q}.security_sources WHERE owner=$1 AND installation_id=$2 AND binding_id=$3 LIMIT 257`,[ctx.owner,args.installationId,args.bindingId]);
    if(rows.rows.length>256||rows.rows.some(row=>typeof row.body!=='string'))throw new SecurityError('POLICY_CHANGED');
    const bindings=new Set([args.bindingId]);for(const row of rows.rows)for(const version of storedSourceSchema.parse(JSON.parse(row.body)).readbackVersions??[])bindings.add(version.sourceBindingId);
    await this.sql(ctx,`UPDATE ${ctx.q}.security_sources SET state='revoked' WHERE owner=$1 AND installation_id=$2 AND binding_id=$3`,[ctx.owner,args.installationId,args.bindingId]);
    for(const grant of await this.allGrants(ctx))if(grant.kind==='task_data'&&grant.installationId===args.installationId&&grant.status==='active'&&grant.outputs.some(output=>bindings.has(output.sourceBindingId)))await this.revoke(ctx,grant.id,grant.revision);
  }
  private async latestAuthority(ctx:Context,taskId:string):Promise<TaskAuthority|undefined>{
    const rows=await this.sql(ctx,`SELECT id,installation_id,request_revision,agent_grant_id,agent_grant_revision,data_grant_id,data_grant_revision,auth_epoch,expires_at,CASE WHEN octet_length(body)<=1048576 THEN body END AS body FROM ${ctx.q}.security_task_authorities WHERE owner=$1 AND task_id=$2 ORDER BY __eigos_rowid DESC LIMIT 1`,[ctx.owner,taskId]);
    if(!rows.rowCount)return;const authority=taskExecutionAuthoritySchema.parse(JSON.parse(String(rows.rows[0].body)));
    const row=rows.rows[0];
    if(authority.id!==row.id||authority.ownerKey!==ctx.owner||authority.memberId!==ctx.memberId||authority.taskId!==taskId||authority.installationId!==row.installation_id||authority.requestRevision!==Number(row.request_revision)
      ||authority.agentGrant.id!==row.agent_grant_id||authority.agentGrant.revision!==Number(row.agent_grant_revision)||authority.dataGrant.id!==row.data_grant_id||authority.dataGrant.revision!==Number(row.data_grant_revision)
      ||authority.authEpoch!==Number(row.auth_epoch)||postgresConsentIndex(authority.expiresAt,this.options.policyDigest,ctx.model)!==Number(row.expires_at))throw new SecurityError('POLICY_CHANGED');return authority;
  }
  private async attachAuthority(ctx:Context,input:unknown,parent:AgentGrant,grant:TaskGrant,subject:Subject){
    const authority=taskExecutionAuthoritySchema.parse(input);
    if(authority.ownerKey!==ctx.owner||authority.memberId!==ctx.memberId||authority.installationId!==subject.installationId||authority.authEpoch!==subject.epoch
      ||!same(authority.agentGrant,{id:parent.id,revision:parent.revision})||!same(authority.dataGrant,{id:grant.id,revision:grant.revision})||!same(grant.parentGrant,authority.agentGrant)
      ||grant.installationId!==authority.installationId||grant.taskId!==authority.taskId||grant.requestRevision!==authority.requestRevision||!grant.operations.includes('task.process')
      ||(authority.authorityOrigin==='agent_submission'?!authority.submittedScopes.includes('tasks:write')||grant.inputs.length>0&&!authority.submittedScopes.includes('tasks:read'):authority.submittedScopes.length!==0)
      ||authority.revision!==1||Date.parse(authority.issuedAt)>Date.now()||this.deadline(authority.expiresAt,ctx)<=Date.now()||this.deadline(authority.expiresAt,ctx)>Math.min(this.deadline(grant.expiresAt,ctx),this.deadline(parent.expiresAt,ctx)))throw new SecurityError('ACCESS_REVOKED');
    await this.sql(ctx,`INSERT INTO ${ctx.q}.security_task_authorities(id,owner,member_id,installation_id,task_id,request_revision,agent_grant_id,agent_grant_revision,data_grant_id,data_grant_revision,auth_epoch,state,expires_at,body)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13)`,[authority.id,authority.ownerKey,authority.memberId,authority.installationId,authority.taskId,authority.requestRevision,parent.id,parent.revision,grant.id,grant.revision,subject.epoch,postgresConsentIndex(authority.expiresAt,this.options.policyDigest,ctx.model),JSON.stringify(authority)]);
    await this.event(ctx,'task_authority_attached',authority.id,authority.revision);
  }
  private async approveTask(ctx:Context,input:unknown){
    const args=taskApprovalSchema.parse(input),subject=await this.subject(ctx,args.installationId),store=new PostgresTaskStorage(ctx.client,this.options.builder),job=await store.get(ctx.owner,args.taskId),request=job.delegation?.request;
    const claims=await this.sql(ctx,`SELECT 1 FROM ${ctx.q}.work_claims WHERE job_id=$1 AND expires_at>$2 LIMIT 1`,[job.id,Date.now()]);
    if(!request||request.revision!==args.expectedRequestRevision||claims.rowCount)throw new DomainError('CONFLICT','Task is running or its request changed; review its current state');
    const all=await this.allGrants(ctx),taskGrants=all.filter((value):value is TaskGrant=>value.kind==='task_data'&&value.taskId===job.id),grants=taskGrants.filter(value=>value.status==='active');
    const original=args.renewOriginal?await this.latestAuthority(ctx,job.id):undefined,current=args.renewOriginal?taskGrants.find(value=>value.id===original?.dataGrant.id):grants.find(value=>value.installationId===args.installationId),intents=await store.intents(ctx.owner,job.id);
    if(current&&(current.id!==args.replaces?.id||current.revision!==args.replaces.revision)||!current&&args.replaces)throw new DomainError('CONFLICT','Task grant changed; review the current grant');
    if(args.operations.includes('task.process')){
      if(!args.takeover&&!args.renewOriginal)throw new DomainError('INVALID_INPUT','Continuing execution requires explicit takeover or original-PA renewal approval');
      for(const intent of intents)if(!['read','local'].includes(intent.effect)){
        const attempts=await this.sql(ctx,`SELECT 1 FROM ${ctx.q}.action_attempts WHERE owner=$1 AND intent_id=$2 LIMIT 1`,[ctx.owner,intent.id]);
        if(attempts.rowCount)throw new DomainError('CONFLICT','An existing business operation requires its original recovery path');
      }
    }
    const parent=await this.parent(ctx,args.installationId),at=new Date().toISOString(),sources=await this.sources(ctx,args.installationId,parent);
    if(!same({id:parent.id,revision:parent.revision},args.expectedAgentGrant))throw new SecurityError('POLICY_CHANGED');
    if(!args.programIds.every(id=>sources.some(source=>source.programId===id)))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    if(args.renewOriginal){
      const readOnly=(step:{effect:string;additionalEffects?:readonly string[]})=>[step.effect,...(step.additionalEffects??[])].every(effect=>['read','local'].includes(effect));
      const persistentReadOnly=args.expiresAt===null&&intents.every(readOnly)&&(job.delegation?.plan?.steps??[]).every(readOnly)&&(job.delegation?.agent?.plans??[]).every(plan=>plan.steps.every(readOnly));
      const replacedWithParent=current?.status==='revoked'&&current.parentGrant.id!==parent.id&&current.parentGrant.id===original?.agentGrant.id&&current.revision===(original?.dataGrant.revision??0)+1&&all.some(grant=>grant.id===current.parentGrant.id&&grant.status==='revoked');
      if(args.takeover||!original||original.authorityOrigin!=='agent_submission'||original.installationId!==args.installationId||original.authEpoch!==subject.epoch||original.requestRevision!==request.revision
        ||!current||current.installationId!==args.installationId||current.status==='active'&&(current.revision!==original.dataGrant.revision||current.parentGrant.id!==original.agentGrant.id)
        ||current.status!=='active'&&!replacedWithParent||job.state!=='paused'||intents.length>0&&!persistentReadOnly||args.expiresAt===null&&!persistentReadOnly
        ||!args.operations.includes('task.process')||!equalSet(args.operations,current.operations)||!equalSet(args.channels,current.channels)||!same(args.inputs,current.inputs)||args.purpose!==current.purpose
        ||args.expiresAt!==null&&(this.deadline(args.expiresAt,ctx)>Math.min(this.deadline(current.expiresAt,ctx),this.deadline(original.expiresAt,ctx))||this.deadline(current.expiresAt,ctx)<=Date.now()||this.deadline(original.expiresAt,ctx)<=Date.now())
        ||!args.programIds.length||new Set(args.programIds).size!==args.programIds.length||args.programIds.some(id=>!current.outputs.some(output=>output.programId===id)))throw new DomainError('CONFLICT','Review a paused task for its original PA; only explicit persistent consent for a read-only task may replace an expired deadline or retain prior read operations, without changing inputs, processing rights or channels');
      const profiles=this.profiles(ctx);
      if(args.expectedSources?.length!==args.programIds.length||args.programIds.some(id=>{const expected=args.expectedSources!.filter(source=>source.programId===id),source=sources.find(value=>value.programId===id);
        return expected.length!==1||!source||expected[0]!.programDigest!==source.programDigest||expected[0]!.bindingId!==source.bindingId||!profiles.some(profile=>profile.programId===id&&profile.bindingId===source.bindingId&&profile.programDigest===source.programDigest)||this.deadline(args.expiresAt,ctx)>this.deadline(source.expiresAt,ctx);}))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    }
    const outputs=sources.filter(source=>args.programIds.includes(source.programId)).flatMap(source=>source.outputTypes.flatMap(type=>{const resource=parent.resources.find(resource=>resource.type===type);return resource?[{programId:source.programId,programDigest:source.programDigest,sourceBindingId:source.bindingId,type,fields:resource.fields}]:[];}));
    const grant=taskDataGrantSchema.parse({version:SECURITY_CONTRACT,id:randomUUID(),revision:1,kind:'task_data',status:'active',ownerKey:ctx.owner,memberId:ctx.memberId,approvedByMemberId:ctx.memberId,installationId:args.installationId,parentGrant:{id:parent.id,revision:parent.revision},issuedAt:at,expiresAt:args.expiresAt,taskId:job.id,requestRevision:request.revision,inputs:args.inputs,outputs,purpose:args.purpose,operations:args.operations,channels:args.channels});
    const permitted=(type:string,selected:string[])=>selected.every(field=>parent.resources.some(resource=>resource.type===type&&resource.fields.includes(field)));
    if(this.deadline(grant.expiresAt,ctx)<=Date.now()||this.deadline(grant.expiresAt,ctx)>this.deadline(parent.expiresAt,ctx)||!grant.channels.every(channel=>parent.channels.includes(channel))||!grant.inputs.every(input=>permitted(input.object.type,input.fields))||!grant.outputs.every(output=>permitted(output.type,output.fields)&&parent.sourceBindingIds.includes(output.sourceBindingId))||grant.purpose!=='delegated_task'||grant.inputs.length>0&&!grant.operations.includes('member_asset.read'))throw new SecurityError('ACCESS_REVOKED');
    for(const input of grant.inputs){const row=await this.sql(ctx,`SELECT revision FROM ${ctx.q}.ontology_objects WHERE owner=$1 AND type=$2 AND id=$3 LIMIT 2`,[ctx.owner,input.object.type,input.object.id]);if(row.rowCount!==1||Number(row.rows[0].revision)!==input.objectRevision)throw new DomainError('CONFLICT','Grant input must reference a current owned object revision');}
    for(const old of grants)if(old.id===current?.id||args.takeover)await this.revoke(ctx,old.id,old.revision);
    await this.insertGrant(ctx,grant);await new PostgresTaskBindings(ctx.client,this.options.builder).bindInputs(grant,parent);await this.event(ctx,'task_grant_issued',grant.id,grant.revision);
    if(args.renewOriginal){
      await this.attachAuthority(ctx,{...original!,id:randomUUID(),revision:1,agentGrant:grant.parentGrant,dataGrant:{id:grant.id,revision:grant.revision},issuedAt:at,expiresAt:grant.expiresAt},parent,grant,subject);
      job.updatedAt=at;job.revision=(job.revision??0)+1;
      if(job.delegation!.recovery?.code==='source_authorization_required'){const recovery=job.delegation!.recovery;recovery.state='resolved';recovery.resolvedAt=at;recovery.nextAction='none';delete recovery.retryAt;}
      job.delegation!.events.push({at,event:'original_pa_source_authorization_renewed',evidence:grant.id});await store.save(ctx.owner,job);
    }else if(args.takeover){
      await store.cancelActions(ctx.owner,job.id);if(job.delegation!.agent)job.delegation!.agentHistory=[...(job.delegation!.agentHistory??[]),job.delegation!.agent];
      delete job.delegation!.agent;delete job.delegation!.plan;delete job.question;delete job.artifact;job.delegation!.phase='grounding';job.state='submitted';job.delegation!.nextAt=0;job.revision=(job.revision??0)+1;
      if(job.delegation!.recovery&&job.delegation!.recovery.state!=='resolved'){job.delegation!.recovery.state='scheduled';job.delegation!.recovery.retryAt=at;job.delegation!.recovery.nextAction='wait_for_retry';}
      await store.save(ctx.owner,job);await this.attachAuthority(ctx,{version:SECURITY_CONTRACT,id:randomUUID(),revision:1,ownerKey:ctx.owner,memberId:ctx.memberId,installationId:args.installationId,taskId:job.id,requestRevision:request.revision,agentGrant:grant.parentGrant,dataGrant:{id:grant.id,revision:grant.revision},submittedScopes:[],authorityOrigin:'member_controller',authEpoch:subject.epoch,policyVersion:POLICY_VERSION,issuedAt:at,expiresAt:grant.expiresAt},parent,grant,subject);
    }else await new PostgresTaskBindings(ctx.client,this.options.builder).project(grant,parent,job);
    return grant;
  }
  async approveAgentGrant(memberId:string,input:unknown){const args=agentGrantRequestSchema.parse(input);return this.run(memberId,ctx=>this.approveAgent(ctx,args),undefined,args.installationId);}
  async approveSource(memberId:string,input:unknown){const args=sourceApprovalSchema.parse(input);return this.run(memberId,ctx=>this.approveSourceChange(ctx,args),undefined,args.installationId);}
  async approveTaskGrant(memberId:string,input:unknown){const args=taskApprovalSchema.parse(input);return this.run(memberId,ctx=>this.approveTask(ctx,args),undefined,args.installationId);}
  async revokeGrant(memberId:string,id:string,expectedRevision:number){z.uuid().parse(id);z.number().int().positive().parse(expectedRevision);return this.run(memberId,ctx=>this.revoke(ctx,id,expectedRevision));}
  async revokeSource(memberId:string,input:unknown){const args=sourceRevocationSchema.parse(input);return this.run(memberId,ctx=>this.revokeSourceChange(ctx,args),undefined,args.installationId);}
  async agentGrant(installationId:string){
    z.uuid().parse(installationId);const registration=await this.options.members.agents.lookup(installationId);if(!registration?.memberId)throw new SecurityError('AUTHORIZATION_REQUIRED');
    return this.run(registration.memberId,ctx=>this.parent(ctx,installationId),undefined,installationId);
  }
  grants(memberId:string){return this.run(memberId,async ctx=>(await this.allGrants(ctx)).map(({ownerKey:_owner,memberId:_member,approvedByMemberId:_approver,...safe})=>safe));}
  sourceProfiles(memberId:string){return this.run(memberId,async ctx=>({revision:ctx.revision,profiles:this.profiles(ctx)}));}
  async revokeInstallation(memberId:string,installationId:string){
    z.uuid().parse(memberId);z.uuid().parse(installationId);const member=await this.options.members.get(memberId),registration=await this.options.members.agents.lookup(installationId);
    if(!registration||registration.memberId!==memberId)throw new DomainError('NOT_FOUND','Installation not found');
    await this.options.publisher.coordinate({ownerKey:ownerKey({...member,clientId:'',scopes:[]}),kind:'installation',targetId:installationId},()=>this.options.members.agents.revoke(memberId,installationId));
  }
  async setConnectionBlocked(memberId:string,connectionId:string,blocked:boolean){
    z.uuid().parse(memberId);z.uuid().parse(connectionId);z.boolean().parse(blocked);const member=await this.options.members.get(memberId),connection=(await this.options.members.connections(memberId)).find(value=>value.id===connectionId);
    if(!connection)throw new DomainError('NOT_FOUND','Connection not found');
    if(!blocked&&!connection.blocked&&!await this.run(memberId,async ctx=>!!(await this.sql(ctx,`SELECT 1 FROM ${ctx.q}.security_fences WHERE owner=$1 AND kind='connection' AND target_id=$2 AND state<>'cleared' LIMIT 1`,[ctx.owner,connection.clientId])).rowCount))return;
    // coordinate performs deny before membership mutation. Explicit restore
    // clears eligibility only; revoked grants and task authorities stay revoked.
    await this.options.publisher.coordinate({ownerKey:ownerKey({...member,clientId:'',scopes:[]}),kind:'connection',targetId:connection.clientId},()=>this.options.members.block(memberId,connectionId,blocked),!blocked);
  }
  private async original(ctx:Context,intentId:string,unresolved=true){
    const store=new PostgresTaskStorage(ctx.client,this.options.builder),intent=await store.intent(ctx.owner,intentId);
    if(unresolved&&!['effect_unknown','awaiting_remote','dispatching','needs_review'].includes(intent.state)||['read','local'].includes(intent.effect))throw new DomainError('CONFLICT','No unresolved dispatched business operation');
    const rows=await this.sql(ctx,`SELECT CASE WHEN octet_length(body)<=8388608 AND sum(octet_length(body)) OVER()<=33554432 THEN body END AS body FROM ${ctx.q}.action_attempts WHERE owner=$1 AND intent_id=$2 ORDER BY __eigos_rowid LIMIT 2001`,[ctx.owner,intentId]);
    if(rows.rows.length>2000||rows.rows.some(row=>typeof row.body!=='string'))throw new DomainError('CONFLICT','Original attempts exceed their bounded review');
    const attempts=rows.rows.map(row=>JSON.parse(row.body) as ExecutionAttempt),dispatch=attempts.find(value=>value.kind==='dispatch'&&value.intentId===intentId&&value.planDigest===intent.planDigest);
    const job=await store.get(ctx.owner,intent.jobId),states=[...(job.delegation?.agent?[job.delegation.agent]:[]),...(job.delegation?.agentHistory??[])],plan=states.flatMap(state=>state.plans).find(value=>value.digest===intent.planDigest),step=plan?.steps.find(value=>value.intentId===intentId);
    if(!plan||!step||!dispatch)throw new DomainError('CONFLICT','No unresolved dispatched business operation');
    const operation:OriginalOperation={owner:ctx.owner,taskId:intent.jobId,intentId,operationKey:intent.businessOperationKey,...(intent.remoteRef?{remoteRef:intent.remoteRef}:{}),action:step.action,programRef:plan.programRef,programDigest:plan.programDigest,originalDispatchAt:dispatch.startedAt};
    return {operation,intent,digest:digest({operation,planDigest:intent.planDigest,state:intent.state})};
  }
  private async preview(ctx:Context,taskId:string){
    if(!(await this.sql(ctx,`SELECT 1 FROM ${ctx.q}.jobs WHERE owner=$1 AND id=$2 LIMIT 1`,[ctx.owner,taskId])).rowCount)throw new DomainError('NOT_FOUND','Task not found');
    const rows=await this.sql(ctx,`SELECT id,CASE WHEN octet_length(body)<=8388608 THEN ${ctx.q}.eigos_try_jsonb(body)->>'effect' END AS effect FROM ${ctx.q}.action_intents WHERE owner=$1 AND job_id=$2 AND state IN('effect_unknown','awaiting_remote','dispatching','needs_review') LIMIT 2001`,[ctx.owner,taskId]);
    if(rows.rows.length>2000)throw new DomainError('CONFLICT','Original operations exceed their bounded review');
    const result:Awaited<ReturnType<MemberPermissionCoordinatorPort['recoveryPreview']>>=[];
    for(const row of rows.rows){if(typeof row.effect!=='string')throw new SecurityError('POLICY_CHANGED');if(['read','local'].includes(row.effect))continue;
      const original=await this.original(ctx,String(row.id));result.push({intentId:original.operation.intentId,action:original.operation.action,effect:original.intent.effect,programId:original.operation.programRef.id,originalDispatchAt:original.operation.originalDispatchAt,expectedIntentDigest:original.digest,mode:'audit_only'});}
    return result;
  }
  recoveryPreview(memberId:string,taskId:string){z.uuid().parse(taskId);return this.run(memberId,ctx=>this.preview(ctx,taskId));}
  private async recoveryList(ctx:Context){
    const rows=await this.sql(ctx,`SELECT id,task_id,intent_id,state,attempts,CASE WHEN octet_length(body)<=1048576 THEN body END AS body,CASE WHEN octet_length(result)<=1048576 THEN result END AS result,result IS NOT NULL AS has_result
      FROM ${ctx.q}.security_recoveries WHERE owner=$1 ORDER BY __eigos_rowid DESC LIMIT 100`,[ctx.owner]);
    const result:Awaited<ReturnType<MemberPermissionCoordinatorPort['recoveries']>>=[];
    for(const row of rows.rows){if(typeof row.body!=='string'||row.has_result&&typeof row.result!=='string')throw new DomainError('CONFLICT','Recovery result exceeds its bounded review');
      const original=await this.original(ctx,String(row.intent_id),false),permit=JSON.parse(row.body),observation=row.has_result?recoveryObservationSchema.parse(JSON.parse(row.result)):undefined;
      if(permit.id!==row.id||permit.memberId!==ctx.memberId||permit.taskId!==row.task_id||permit.intentId!==row.intent_id||!Object.entries(original.operation).every(([key,value])=>same(permit[key],value))
        ||original.operation.taskId!==row.task_id||observation&&observation.operationKey!==original.operation.operationKey)throw new SecurityError('POLICY_CHANGED');
      result.push({id:z.uuid().parse(row.id),taskId:z.uuid().parse(row.task_id),intentId:z.uuid().parse(row.intent_id),state:z.string().max(100).parse(row.state),attempts:z.coerce.number().int().nonnegative().parse(row.attempts),result:observation,auditOnly:true});}
    return result;
  }
  recoveries(memberId:string){return this.run(memberId,ctx=>this.recoveryList(ctx));}
  private async approveRecoveryChange(ctx:Context,input:unknown):Promise<never>{
    const args=recoveryApprovalSchema.parse(input),original=await this.original(ctx,args.intentId);await this.subject(ctx,args.installationId);await this.parent(ctx,args.installationId);
    if(original.digest!==args.expectedIntentDigest)throw new SecurityError('POLICY_CHANGED');
    if(Date.parse(args.expiresAt)<=Date.now())throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    throw new SecurityError('AUTHORITY_UNAVAILABLE','This PostgreSQL runtime has no installed original-operation observer; the original task and attempt remain unchanged');
  }
  approveRecovery(memberId:string,input:unknown){const args=recoveryApprovalSchema.parse(input);return this.run(memberId,ctx=>this.approveRecoveryChange(ctx,args),undefined,args.installationId);}
  async applyPermissionReview(memberId:string,review:MemberPermissionReview):Promise<void>{
    const parsed=z.strictObject({kind:z.enum(['agent','source','task','revoke','revoke_source','recovery']),input:z.record(z.string(),z.unknown()),policyRevision:z.number().int().positive()}).parse(structuredClone(review));
    const installationId='installationId'in parsed.input?z.uuid().parse(parsed.input.installationId):undefined;
    await this.run(memberId,async ctx=>{
      if(parsed.kind==='agent')await this.approveAgent(ctx,parsed.input);
      else if(parsed.kind==='source')await this.approveSourceChange(ctx,parsed.input);
      else if(parsed.kind==='task')await this.approveTask(ctx,parsed.input);
      else if(parsed.kind==='revoke_source')await this.revokeSourceChange(ctx,parsed.input);
      else if(parsed.kind==='recovery')await this.approveRecoveryChange(ctx,parsed.input);
      else {const value=z.strictObject({grantId:z.uuid(),expectedRevision:z.number().int().positive()}).parse(parsed.input);await this.revoke(ctx,value.grantId,value.expectedRevision);}
    },parsed.policyRevision,installationId);
  }
  private async candidates(ctx:Context){
    const rows=await this.sql(ctx,`SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${ctx.q}.security_roles WHERE subject_id=$1 LIMIT 1001`,[ctx.memberId]);
    if(rows.rows.length>1000||rows.rows.some(row=>typeof row.body!=='string'))throw new DomainError('CONFLICT','Controller roles exceed their bounded review');
    const roles=rows.rows.map(row=>roleSchema.parse(JSON.parse(row.body)));for(const role of roles)this.deadline(role.expiresAt,ctx);
    const types=ctx.model.typeIds().filter(type=>!ctx.model.isInterface(type)&&roleAllows(ctx.model,roles,ctx.memberId,'','objectType',type,'resource.view',Date.now));
    if(!types.length)return [];
    const objects=await this.sql(ctx,`SELECT type,id,revision,CASE WHEN octet_length(body)<=1048576 THEN body END AS body FROM ${ctx.q}.ontology_objects WHERE owner=$1 AND type=ANY($2::text[]) ORDER BY __eigos_rowid DESC LIMIT 500`,[ctx.owner,types]);
    const bindings=new PostgresTaskBindings(ctx.client,this.options.builder),result:Awaited<ReturnType<MemberPermissionCoordinatorPort['managementView']>>['objects']=[];
    for(const row of objects.rows){if(typeof row.body!=='string')throw new DomainError('CONFLICT','Controller candidate exceeds its bounded review');
      const ref={type:String(row.type),id:String(row.id)},available={...ctx.model.properties(ref.type),...projectionFields(ref.type)},selected:string[]=[];
      for(const field of Object.keys(available)){if(reviewedFieldPolicy(ctx.model,ref.type,field)==='internal_only')continue;const envelope=await bindings.envelope(ctx.owner,ref,[field],['member_ui']);if(envelope.classification!=='internal'&&envelope.channels.includes('member_ui'))selected.push(field);}
      const definition=ctx.model.object(ref.type);if(!selected.includes(definition.primaryKey)||!selected.includes(definition.titleKey))continue;
      const body=JSON.parse(row.body);result.push({object:ref,objectRevision:z.coerce.number().int().positive().parse(row.revision),title:String(body.properties[definition.titleKey]??ref.id).slice(0,200),fields:selected});if(result.length===200)break;
    }return result;
  }
  async managementView(memberId:string){
    const registrations=await this.options.members.agents.list(z.uuid().parse(memberId));
    return this.run(memberId,async ctx=>{
      const installations=registrations.map(value=>({id:value.id,name:value.displayName,revoked:value.revoked})),profiles=this.profiles(ctx),all=await this.allGrants(ctx),grants=all.map(({ownerKey:_owner,memberId:_member,approvedByMemberId:_approver,...safe})=>safe);
      const ids=all.flatMap(grant=>grant.kind==='task_data'&&grant.status==='active'&&this.deadline(grant.expiresAt,ctx)>Date.now()?[grant.taskId]:[]);
      const metadata=`SELECT id,state,CASE WHEN body.value->>'id'=j.id AND body.value->>'state'=j.state AND octet_length(body.value->>'goal')<=8192 THEN body.value->>'goal' END AS title,
        CASE WHEN body.value#>'{delegation,request,revision}' IS NULL OR body.value#>'{delegation,request,revision}'='null'::jsonb THEN '0' ELSE body.value#>>'{delegation,request,revision}' END AS request_revision
        FROM ${ctx.q}.jobs j CROSS JOIN LATERAL(SELECT ${ctx.q}.eigos_try_jsonb(j.body) AS value OFFSET 0) body WHERE owner=$1`;
      const rows=await this.sql(ctx,`${metadata} ORDER BY created_at DESC,id DESC LIMIT 50`,[ctx.owner]);
      const granted=ids.length?await this.sql(ctx,`${metadata} AND id=ANY($2::text[])`,[ctx.owner,[...new Set(ids)]]):{rows:[]};
      const selected=new Map<string,Awaited<ReturnType<MemberPermissionCoordinatorPort['managementView']>>['tasks'][number]>();
      for(const row of [...rows.rows,...granted.rows]){if(typeof row.title!=='string')throw new DomainError('CONFLICT','Permission task title exceeds its bounded review');
        selected.set(String(row.id),{id:z.uuid().parse(row.id),title:row.title,state:z.enum(['submitted','working','input-required','auth-required','completed','failed','canceled','rejected','paused']).parse(row.state),requestRevision:z.coerce.number().int().nonnegative().safe().parse(row.request_revision),continuation:undefined});}
      if(ids.some(id=>!selected.has(id)))throw new SecurityError('POLICY_CHANGED');
      const sources:StoredSource[]=[];for(const installation of installations){const parent=all.find((grant):grant is AgentGrant=>grant.kind==='agent_access'&&grant.installationId===installation.id&&grant.status==='active'&&this.deadline(grant.expiresAt,ctx)>Date.now());if(parent)sources.push(...await this.sources(ctx,installation.id,parent));}
      const types=[...new Set(['ServiceRequest',...TASK_PROJECTION_TYPES,...profiles.flatMap(profile=>profile.outputTypes)])],recoveryCandidates:Awaited<ReturnType<MemberPermissionCoordinatorPort['managementView']>>['recoveryCandidates']=[],tasks:Awaited<ReturnType<MemberPermissionCoordinatorPort['managementView']>>['tasks']=[];
      for(const job of selected.values()){const authority=await this.latestAuthority(ctx,job.id);tasks.push({...job,continuation:job.state==='paused'&&authority?.authorityOrigin==='agent_submission'?{installationId:authority.installationId,grant:authority.dataGrant}:undefined});}
      for(const row of rows.rows.slice(0,50))for(const operation of await this.preview(ctx,String(row.id)))recoveryCandidates.push({...operation,taskId:String(row.id)});
      return {installations,grants,profiles,policyRevision:ctx.revision,recoveries:await this.recoveryList(ctx),recoveryCandidates,sources,objects:await this.candidates(ctx),
        fields:types.map(type=>({type,name:ctx.model.object(type).name,fields:Object.entries({...ctx.model.properties(type),...projectionFields(type)}).filter(([field])=>reviewedFieldPolicy(ctx.model,type,field)!=='internal_only').map(([field,definition])=>({field,description:definition.description,sensitive:reviewedFieldPolicy(ctx.model,type,field)==='task_sensitive'}))})),
        operationDescriptions:Object.fromEntries([...new Set(profiles.flatMap(profile=>profile.operations))].map(action=>[action,action==='recover_original'?'查询已经提交操作的状态':ctx.model.action(action).description])),tasks};
    });
  }
}
