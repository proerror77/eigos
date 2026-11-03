import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {DomainError} from '../core/domain.js';
import {objectRefSchema,type ObjectRef} from '../ontology/model.js';
import {runGraphProgramAsync,type GraphStorage} from '../ontology/graph-program.js';
import {assertPipelineSnapshotsProgram,type FactState} from '../ontology/pipeline/facts.js';
import {assertPipelineReady} from '../ontology/pipeline/contracts.js';
import {didiToolInputs} from '../capabilities/didi/contracts.js';
import {SOURCE_RELAY_PROTOCOL,sourceReadRequestSchema,sourceReadResponseSchema,type SourceReadRequest,type SourceReadResponse} from '../agent-transport/service-contracts.js';
import {agentIdSchema} from '../relay/contracts.js';
import {accessContextSchema} from '../security/contracts.js';
import {storedSourceSchema} from '../security/source-policy.js';
import {actionSources} from '../security/component-authority.js';
import {SecurityError} from '../security/errors.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import type {PostgresDatabase} from './database.js';
import {PostgresTaskRelayAuthority,type PostgresTaskRelayAuthorityOptions} from './task-relay-authority.js';
import {PostgresTaskStorage} from './task-storage.js';
import {PostgresProjectionGraph} from './projection-graph.js';
import {PostgresDefinitionStore} from './definition-store.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresBusinessAuthorityDigest,postgresConstrainReadDeadline} from './runtime-transaction.js';
import {postgresWorkReference,type PostgresWorkReference} from './work-claim.js';
import {withPostgresWorkerReadSnapshot,postgresTaskResourcePermissionValidUntil} from './task-read-access.js';
import {withPostgresWorkerEvidenceAuthorization} from './task-output.js';
import {postgresConsentIndex} from './consent.js';
import {PostgresDidiAccount} from './didi-account.js';

export type PostgresRelayReadAuthorityOptions=Omit<PostgresTaskRelayAuthorityOptions,'database'>&{database:Pick<PostgresDatabase,'run'|'inspectClaim'>;builder?:StagedKernelBuilder;didiAccount?:PostgresDidiAccount};
type ReadRow={id:string;retry_key:string;peer_id:string;actor:string;policy_revision:unknown;request:string;state:string;connection_id:string|null;result:string|null;has_result:boolean;expires_at:unknown};
const same=(a:unknown,b:unknown)=>a===undefined?b===undefined:b!==undefined&&digest(a)===digest(b);
const intentSchema=z.looseObject({id:z.string().min(1),owner:z.string().min(1),jobId:z.string().min(1),planDigest:z.string().regex(/^[a-f0-9]{64}$/),effect:z.string().min(1),dispatchInput:z.record(z.string(),z.unknown()).optional()});
const attemptSchema=z.looseObject({id:z.string().min(1),intentId:z.string().min(1),kind:z.string().min(1),claimToken:z.string().min(1),requestRevision:z.number().int().nonnegative().safe(),inputDigest:z.string().regex(/^[a-f0-9]{64}$/),planDigest:z.string().regex(/^[a-f0-9]{64}$/)});
const factSchema=z.looseObject({sourceKey:z.string(),object:objectRefSchema,revision:z.number().int().positive().safe(),semanticRevision:z.number().int().positive().safe(),semanticDigest:z.string(),properties:z.record(z.string(),z.unknown()),conflicted:z.boolean(),intakeDigest:z.string(),mappingId:z.string(),release:z.looseObject({ontologyId:z.string(),releaseId:z.string(),digest:z.string()}),observedAt:z.iso.datetime({offset:true}),expiresAt:z.iso.datetime({offset:true}),evidenceRefs:z.array(z.string()),sourceId:z.string(),sourceRevision:z.string(),sourceDigest:z.string(),evidenceLevel:z.string(),relationshipDigest:z.string().optional(),relationshipTypes:z.array(z.string()).max(200).optional()});
/** Exact original dispatch transport, in the primary business database. The
 * adapter grants no action, runs no model/provider, and never creates a claim. */
export class PostgresRelayReadAuthority {
  private readonly authority:PostgresTaskRelayAuthority;
  constructor(private readonly options:PostgresRelayReadAuthorityOptions){
    if(options.didiAccount!==undefined&&!(options.didiAccount instanceof PostgresDidiAccount))throw new Error('The current DiDi account authority must be an actual PostgreSQL account');
    this.authority=new PostgresTaskRelayAuthority(options);
  }
  get didiAccount(){return this.options.didiAccount;}
  private inspect=(claim:PostgresWorkReference)=>this.options.database.inspectClaim(claim,this.options.policyDigest);
  private async row(client:Client,id:string):Promise<ReadRow>{
    const q=`"${postgresBusinessSchema(client)}"`,rows=await client.query<ReadRow>(`SELECT id,retry_key,peer_id,policy_revision,state,connection_id,expires_at,result IS NOT NULL AS has_result,CASE WHEN octet_length(actor)<=65536 THEN actor END AS actor,CASE WHEN octet_length(request)<=1048576 THEN request END AS request,CASE WHEN octet_length(result)<=8388608 THEN result END AS result FROM ${q}.security_relay_reads WHERE id=$1 LIMIT 2`,[z.uuid().parse(id)]);
    if(rows.rowCount!==1||typeof rows.rows[0]?.actor!=='string'||typeof rows.rows[0]?.request!=='string'||rows.rows[0].has_result&&rows.rows[0].result===null)throw new SecurityError('AUTHORIZATION_REQUIRED');return rows.rows[0];
  }
  private async claim(client:Client,row:ReadRow){
    const actor=accessContextSchema.parse(JSON.parse(row.actor));if(actor.actorKind!=='worker')throw new SecurityError('AUTHORIZATION_REQUIRED');
    const q=`"${postgresBusinessSchema(client)}"`,job=await new PostgresTaskStorage(client,this.options.builder).get(actor.ownerKey,actor.taskId);
    const rows=await client.query(`SELECT c.token FROM ${q}.work_claims c JOIN ${q}.runtime_work_claims r ON r.job_id=c.job_id AND r.token=c.token WHERE c.job_id=$1 AND c.revision=$2 AND r.authority_digest=$3 LIMIT 2`,[job.id,job.revision??0,postgresBusinessAuthorityDigest(client)]);
    if(rows.rowCount!==1||typeof rows.rows[0]?.token!=='string'||digest(rows.rows[0].token)!==actor.claimRef)throw new SecurityError('ACCESS_REVOKED');
    return postgresWorkReference({owner:actor.ownerKey,token:rows.rows[0].token,job,securityAuthorityId:actor.authorityRef.id,securityEpoch:actor.authEpoch,securityPolicyRevision:Number(row.policy_revision)});
  }
  private async assert(client:Client,row:ReadRow,original?:PostgresWorkReference):Promise<SourceReadRequest>{
    const request=sourceReadRequestSchema.parse(JSON.parse(row.request)),actor=accessContextSchema.parse(JSON.parse(row.actor)),now=Date.now(),token=postgresBusinessToken(client),q=`"${postgresBusinessSchema(client)}"`;
    await this.authority.assertCurrent(client,request.authorityId);
    if(row.id!==request.callId||Number(row.expires_at)!==request.expiresAt||request.gatewayOrigin!==this.options.gatewayOrigin||request.expiresAt<=now||row.state==='revoked')throw new SecurityError('ACCESS_REVOKED');
    const {protocol:_protocol,kind:_kind,callId:_callId,expiresAt:_expires,...selectedInput}=request;
    if(row.retry_key!==digest([row.peer_id,selectedInput])||!same(didiToolInputs[request.tool].parse(request.input),request.input))throw new SecurityError('POLICY_CHANGED');
    if(row.state==='completed'&&row.result===null)throw new SecurityError('POLICY_CHANGED');
    if(!['queued','dispatched','completed'].includes(row.state)||actor.actorKind!=='worker'||actor.taskId!==request.context.requestId||actor.requestRevision!==request.context.requestRevision)throw new SecurityError('AUTHORIZATION_REQUIRED');
    const claim=original?postgresWorkReference(original):await this.claim(client,row);
    if(claim.owner!==actor.ownerKey||claim.job.id!==actor.taskId||digest(claim.token)!==actor.claimRef)throw new SecurityError('ACCESS_REVOKED');
    return withPostgresWorkerEvidenceAuthorization(client,claim,this.options.policyDigest,async(auth,admission,principal)=>{
      const {checkedAt:_old,...stable}=actor,{checkedAt:_fresh,...current}=admission.actor;
      if(!same(stable,current)||admission.policyRevision!==Number(row.policy_revision))throw new SecurityError('POLICY_CHANGED');
      const job=await new PostgresTaskStorage(client,this.options.builder).get(claim.owner,claim.job.id),state=job.delegation?.agent,plan=state?.plans.find(value=>value.id===request.context.planId);
      await this.options.didiAccount?.assert(client,claim,job,this.options.policyDigest);
      const intentRows=await client.query(`SELECT state,CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.action_intents WHERE owner=$1 AND job_id=$2 AND id=$3 AND state='dispatching' LIMIT 2`,[claim.owner,job.id,request.context.intentId]);
      const attemptRows=await client.query(`SELECT CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.action_attempts WHERE owner=$1 AND intent_id=$2 AND id=$3 LIMIT 2`,[claim.owner,request.context.intentId,request.context.attemptId]);
      if(!state||!plan||intentRows.rowCount!==1||typeof intentRows.rows[0]?.body!=='string'||attemptRows.rowCount!==1||typeof attemptRows.rows[0]?.body!=='string')throw new SecurityError('ACCESS_REVOKED');
      const intent=intentSchema.parse(JSON.parse(intentRows.rows[0].body)),attempt=attemptSchema.parse(JSON.parse(attemptRows.rows[0].body)),step=plan.steps.find(value=>value.intentId===intent.id),{digest:expected,...body}=plan;
      if(!step||intent.id!==request.context.intentId||intent.owner!==claim.owner||intent.jobId!==job.id||intent.planDigest!==plan.digest||plan.programDigest!==state.programDigest||digest(body)!==expected||step.effect!==intent.effect
        ||intent.effect!=='read'||step.effect!=='read'||step.action!==request.context.action||plan.modelRunId!==request.context.modelRunId||plan.requestId!==job.id||plan.requestRevision!==actor.requestRevision
        ||attempt.id!==request.context.attemptId||attempt.intentId!==intent.id||attempt.kind!=='dispatch'||attempt.claimToken!==claim.token||attempt.requestRevision!==(job.revision??0)||attempt.planDigest!==plan.digest||attempt.inputDigest!==request.context.actionInputDigest
        ||!intent.dispatchInput||digest(intent.dispatchInput)!==request.context.actionInputDigest)throw new SecurityError('AUTHORIZATION_REQUIRED');
      const needed=actionSources(state,step.action,step.input,step),binding=needed.find(value=>value.programRef.id===request.context.programId&&value.programDigest===request.context.programDigest);
      if(!binding)throw new SecurityError('SOURCE_NOT_AUTHORIZED');
      for(const permission of ['resource.view','action.execute']as const){const until=await postgresTaskResourcePermissionValidUntil(client,principal,job.id,this.options.policyDigest,'actionType',step.action,permission,this.options.builder);if(until<=Date.now())throw new SecurityError('AUTHORIZATION_REQUIRED');postgresConstrainReadDeadline(client,until);}
      const sources=await client.query(`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.security_sources WHERE owner=$1 AND installation_id=$2 AND state='active' LIMIT 257`,[claim.owner,admission.actor.installationId]);
      if(sources.rows.length>256||sources.rows.some(row=>typeof row.body!=='string'))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
      const stored=sources.rows.map(row=>{const value=storedSourceSchema.parse(JSON.parse(row.body));if(value.bindingId!==row.binding_id||value.programId!==row.program_id||value.installationId!==admission.actor.installationId)throw new SecurityError('SOURCE_NOT_AUTHORIZED');return value;});
      for(const need of needed){const source=stored.find(value=>value.programId===need.programRef.id&&value.programDigest===need.programDigest&&value.operations.includes(step.action)&&value.parentGrant.id===admission.parent.id&&value.parentGrant.revision===admission.parent.revision&&admission.parent.sourceBindingIds.includes(value.bindingId)&&admission.parent.capabilityIds.includes(value.programId)&&postgresConsentIndex(value.expiresAt,this.options.policyDigest)>Date.now());if(!source)throw new SecurityError('SOURCE_NOT_AUTHORIZED');postgresConstrainReadDeadline(client,postgresConsentIndex(source.expiresAt,this.options.policyDigest));}
      const definitions=new PostgresDefinitionStore(client,{builder:this.options.builder}),release=await definitions.resolve(job.delegation!.ontologyRelease!);
      const status=job.delegation!.pipelineValidation?await definitions.pipeline.validationStatus(claim.owner,release.document,release.model,job.delegation!.pipelineValidation,binding.programRef,binding.programDigest,step.action):await definitions.pipeline.status(claim.owner,release.document,release.model,binding.programRef,binding.programDigest,step.action);
      try{assertPipelineReady(status);}catch(error){if(error instanceof DomainError){const denied=new SecurityError('SOURCE_NOT_AUTHORIZED');Object.defineProperty(denied,'cause',{value:error});throw denied;}throw error;}
      if(status.verificationIds.length){const rows=await client.query(`SELECT CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.ontology_pipeline_verifications WHERE ontology_id=$1 AND id=ANY($2::text[])`,[release.ref.ontologyId,status.verificationIds]);if(rows.rowCount!==new Set(status.verificationIds).size||rows.rows.some(row=>typeof row.body!=='string'))throw new SecurityError('SOURCE_NOT_AUTHORIZED');for(const row of rows.rows){const until=Date.parse(JSON.parse(row.body).expiresAt);if(!Number.isSafeInteger(until)||until<=Date.now())throw new SecurityError('SOURCE_NOT_AUTHORIZED');postgresConstrainReadDeadline(client,until);}}
      // Fixed internal proof only: no private body leaves this method. Every
      // snapshot is already part of the original immutable dispatch evidence.
      const resolutions=state.inputResolutions?.filter(value=>value.planId===plan.id&&value.intentId===intent.id&&value.inputDigest===request.context.actionInputDigest)??[],snapshots=[...plan.ontologyPlanning.objects,...resolutions.flatMap(value=>value.ontologyPlanning.objects)];
      const graph=await PostgresProjectionGraph.create(client,claim.owner,release.ref,this.options.builder,{readOnly:true}),facts=new Map<string,FactState|undefined>();
      const key=(ref:ObjectRef)=>JSON.stringify([ref.type,ref.id]);if(snapshots.length>1000)throw new SecurityError('INSUFFICIENT_ACCESS');
      let bytes=0;
      for(const snapshot of snapshots.filter(value=>value.ref.id.startsWith('pipeline:'))){
        const name=key(snapshot.ref);if(facts.has(name))continue;
        const rows=await client.query(`SELECT source_key,CASE WHEN octet_length(body)<=1048576 THEN body END AS body FROM ${q}.ontology_pipeline_facts WHERE owner=$1 AND ontology_id=$2 AND object_type=$3 AND object_id=$4 LIMIT 2`,[claim.owner,release.ref.ontologyId,snapshot.ref.type,snapshot.ref.id]);
        if(!rows.rowCount){facts.set(name,undefined);continue;}
        if(rows.rowCount!==1||typeof rows.rows[0]?.body!=='string'||(bytes+=Buffer.byteLength(rows.rows[0].body))>8388608)throw new SecurityError('INSUFFICIENT_ACCESS');
        const state=factSchema.parse(JSON.parse(rows.rows[0].body));if(state.sourceKey!==rows.rows[0].source_key||!same(state.object,snapshot.ref)||state.release.ontologyId!==release.ref.ontologyId)throw new SecurityError('POLICY_CHANGED');
        facts.set(name,state);const until=Date.parse(state.expiresAt);if(!Number.isSafeInteger(until)||until<=Date.now()||state.conflicted)throw new SecurityError('SOURCE_NOT_AUTHORIZED');postgresConstrainReadDeadline(client,until);
      }
      let integrity=false;
      const bound=async(owner:string,ref:ObjectRef)=>{if(owner!==claim.owner||!facts.has(key(ref))||!await auth.bindingMetadata(ref))throw new SecurityError('INSUFFICIENT_ACCESS');};
      const proof:GraphStorage={
        async read(owner,ref,budget){await bound(owner,ref);return graph.read(owner,ref,budget);},
        async evidencePropertiesDigest(owner,ref,budget){if(!integrity)throw new SecurityError('AUTHORIZATION_REQUIRED');await bound(owner,ref);return graph.evidencePropertiesDigest(owner,ref,budget);},
        async related(owner,ref,link,budget){if(!integrity)throw new SecurityError('AUTHORIZATION_REQUIRED');await bound(owner,ref);const type=graph.model.navigation(ref.type,link).link.id,until=await postgresTaskResourcePermissionValidUntil(client,principal,job.id,thisOptions.policyDigest,'linkType',type,'resource.view',thisOptions.builder);if(until<=Date.now())throw new SecurityError('INSUFFICIENT_ACCESS');postgresConstrainReadDeadline(client,until);return graph.related(owner,ref,link,budget);},
        async relationshipDigest(owner,ref,budget){await bound(owner,ref);return graph.relationshipDigestVisible(owner,ref,budget,async edge=>{const until=await postgresTaskResourcePermissionValidUntil(client,principal,job.id,thisOptions.policyDigest,'linkType',edge.type,'resource.view',thisOptions.builder);if(until<=Date.now()||!await auth.bindingMetadata(edge.to))return false;postgresConstrainReadDeadline(client,until);return true;});},
        async withGraphIntegrity(action){const previous=integrity;integrity=true;try{return await action();}finally{integrity=previous;}},
        readPrivate(){throw new SecurityError('AUTHORIZATION_REQUIRED');},query(){throw new SecurityError('AUTHORIZATION_REQUIRED');},containsLinks(){throw new SecurityError('AUTHORIZATION_REQUIRED');},ingest(){throw new SecurityError('AUTHORIZATION_REQUIRED');},tombstone(){throw new SecurityError('AUTHORIZATION_REQUIRED');},
      };
      const thisOptions=this.options;
      try{await runGraphProgramAsync(proof,assertPipelineSnapshotsProgram(graph,claim.owner,snapshots,function*(ref){const state=facts.get(key(ref));return state?{...state,health:state.conflicted?'conflicted':Date.parse(state.expiresAt)<=Date.now()?'stale':'fresh'}:undefined;}));}catch(error){if(error instanceof DomainError){const denied=new SecurityError('SOURCE_NOT_AUTHORIZED');Object.defineProperty(denied,'cause',{value:error});throw denied;}throw error;}
      await this.options.didiAccount?.assert(client,claim,job,this.options.policyDigest);
      postgresConstrainReadDeadline(client,Math.min(request.expiresAt,admission.validUntil));if(postgresBusinessToken(client)!==token||request.expiresAt<=Date.now())throw new SecurityError('ACCESS_REVOKED');return request;
    },this.options.builder,undefined,this.inspect);
  }
  async create(input:PostgresWorkReference,peerId:string,value:Omit<SourceReadRequest,'protocol'|'kind'|'callId'|'expiresAt'>):Promise<SourceReadRequest>{
    const claim=postgresWorkReference(input),peer=agentIdSchema.parse(peerId),captured=structuredClone(value),retry=digest([peer,captured]);
    return this.options.database.run(async client=>{
      const q=`"${postgresBusinessSchema(client)}"`;let actor:unknown,policyRevision=0,expiresAt=0;
      await withPostgresWorkerReadSnapshot(client,claim,this.options.policyDigest,async(_p,admission)=>{actor=admission.actor;policyRevision=admission.policyRevision;expiresAt=Math.min(Date.now()+120000,postgresConsentIndex(admission.grant.expiresAt,this.options.policyDigest));},this.inspect);
      const request=sourceReadRequestSchema.parse({...captured,protocol:SOURCE_RELAY_PROTOCOL,kind:'source.read',callId:randomUUID(),expiresAt});
      if(!same(didiToolInputs[request.tool].parse(request.input),request.input))throw new SecurityError('AUTHORIZATION_REQUIRED');
      const existing=await client.query(`SELECT id FROM ${q}.security_relay_reads WHERE retry_key=$1 LIMIT 2`,[retry]);if(existing.rows.length>1)throw new SecurityError('POLICY_CHANGED');if(existing.rowCount)return this.assert(client,await this.row(client,String(existing.rows[0].id)),claim);
      const row:ReadRow={id:request.callId,retry_key:retry,peer_id:peer,actor:JSON.stringify(actor),policy_revision:policyRevision,request:JSON.stringify(request),state:'queued',connection_id:null,result:null,has_result:false,expires_at:request.expiresAt};await this.assert(client,row,claim);
      await client.query(`INSERT INTO ${q}.security_relay_reads(id,retry_key,peer_id,actor,policy_revision,request,state,connection_id,result,expires_at) VALUES($1,$2,$3,$4,$5,$6,'queued',NULL,NULL,$7)`,[row.id,retry,peer,row.actor,policyRevision,row.request,request.expiresAt]);return request;
    });
  }
  async pending(){
    const rows=await this.options.database.run(async client=>{await this.authority.assertCurrent(client);return(await client.query(`SELECT id FROM "${postgresBusinessSchema(client)}".security_relay_reads WHERE state='queued' ORDER BY __eigos_rowid LIMIT 20`)).rows;});
    const result:{peerId:string;request:SourceReadRequest}[]=[];
    for(const item of rows){const id=String(item.id);try{
      const value=await this.options.database.run(async client=>{const row=await this.row(client,id);if(row.state!=='queued')return undefined;return {peerId:row.peer_id,request:await this.assert(client,row)};});
      if(value)result.push(value);
    }catch(error){if(!(error instanceof SecurityError))throw error;await this.revoke(id);}}
    return result;
  }
  async authorize(id:string,peerId?:string){return this.options.database.run(async client=>{const row=await this.row(client,id);if(peerId!==undefined&&row.peer_id!==peerId)throw new SecurityError('AUTHORIZATION_REQUIRED');return this.assert(client,row);});}
  async authorizeProof(id:string,peerId:string,proof:{jti:string;expiresAt:number}){return this.options.database.run(async client=>{const row=await this.row(client,id);if(row.peer_id!==peerId)throw new SecurityError('AUTHORIZATION_REQUIRED');const request=await this.assert(client,row);await this.authority.consumeProofInTransaction(client,proof);return request;});}
  async peer(id:string){return this.options.database.run(async client=>agentIdSchema.parse((await this.row(client,id)).peer_id));}
  async route(id:string,connectionId:string){return this.delivery(id,connectionId,false);}
  async dispatched(id:string,connectionId:string){return this.delivery(id,connectionId,true);}
  private async delivery(id:string,connectionId:string,sent:boolean){const connection=z.uuid().parse(connectionId);await this.options.database.run(async client=>{const row=await this.row(client,id);await this.assert(client,row);if(row.connection_id&&row.connection_id!==connection)throw new SecurityError('ACCESS_REVOKED');await client.query(`UPDATE "${postgresBusinessSchema(client)}".security_relay_reads SET connection_id=$1,state=CASE WHEN $2 AND state='queued' THEN 'dispatched' ELSE state END WHERE id=$3`,[connection,sent,id]);});}
  async accept(peerId:string,connectionId:string,input:unknown){const result=sourceReadResponseSchema.parse(input);await this.options.database.run(async client=>{const row=await this.row(client,result.callId),request=await this.assert(client,row);if(row.peer_id!==peerId||row.connection_id!==connectionId||result.requestDigest!==digest(request)||result.authorityId!==request.authorityId)throw new SecurityError('AUTHORIZATION_REQUIRED');if(row.result!==null&&!same(JSON.parse(row.result),result))throw new SecurityError('POLICY_CHANGED');await client.query(`UPDATE "${postgresBusinessSchema(client)}".security_relay_reads SET state='completed',result=$1 WHERE id=$2`,[JSON.stringify(result),row.id]);});}
  async ready(claim:PostgresWorkReference,id:string){return this.options.database.run(async client=>{const row=await this.row(client,id);await this.assert(client,row,claim);return row.result!==null;});}
  async result(claim:PostgresWorkReference,id:string):Promise<SourceReadResponse|undefined>{return this.options.database.run(async client=>{const row=await this.row(client,id);await this.assert(client,row,claim);return row.result!==null?sourceReadResponseSchema.parse(JSON.parse(row.result)):undefined;});}
  async revoke(id:string){await this.options.database.run(client=>client.query(`UPDATE "${postgresBusinessSchema(client)}".security_relay_reads SET state='revoked' WHERE id=$1 AND state<>'completed'`,[z.uuid().parse(id)]).then(()=>{}));}
}
