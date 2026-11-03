import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {matchesAgentGrant} from '../core/agent-authorization.js';
import type {PlanGrant} from '../ontology/actions.js';
import type {Ref,ServiceRequest} from '../ontology/execution.js';
import {ontologyBatchSchema,ontologySourceSchema,type ObjectBatch,type ObjectSource} from '../ontology/object-store.js';
import type {ObjectRef} from '../ontology/model.js';
import type {GraphStorage,ProjectionMetadata} from '../ontology/graph-program.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {isPersonalAction} from '../ontology/personal-context.js';
import {taskDataGrantSchema,securityEnvelopeSchema} from '../security/contracts.js';
import {storedSourceSchema,type ObservationSource} from '../security/source-policy.js';
import {SecurityError} from '../security/errors.js';
import {combineEnvelopes,type SecurityEnvelope} from '../security/envelope.js';
import {submissionDigest} from '../security/submission-digest.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresConstrainReadDeadline,postgresRequireLeaseAtCommit} from './runtime-transaction.js';
import {postgresWorkReference,postgresClaimSnapshotMatches,type PostgresWorkReference} from './work-claim.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import {postgresWorkerRequest} from './worker-input.js';
import {withPostgresWorkerEvidenceAuthorization} from './task-output.js';
import {withPostgresPlanningReadGraph} from './planning-read-graph.js';
import {postgresTaskResourceViewValidUntil,postgresTaskResourcePermissionValidUntil} from './task-read-access.js';
import {postgresTaskReadHistory} from './task-lineage.js';
import {PostgresProjectionGraph} from './projection-graph.js';
import {PostgresTaskBindings} from './task-bindings.js';
import {PostgresTaskStorage} from './task-storage.js';

const reserved=new Set(['task_submission','task_context','task_projection','member_asset']);
const key=(ref:ObjectRef)=>JSON.stringify([ref.type,ref.id]);
function freezeData<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freezeData);Object.freeze(value);}return value;}
const brand:unique symbol=Symbol('checked-source-binding');
export interface PostgresSourceBindingPermit{readonly [brand]:true}
type BindingAuthority={client:Client;token:object;grant:z.infer<typeof taskDataGrantSchema>;ref:ObjectRef;revision:number;fingerprint:string;fields:string[];sourceBindingId:string;
  evidence:SecurityEnvelope;sourceObservation?:ObservationSource;assertCurrent:()=>Promise<void>};
const permits=new WeakMap<PostgresSourceBindingPermit,BindingAuthority>();
/** Internal binder boundary, not an authority constructor. The checked driver
 * never exposes permits to its callback or accepts one from request JSON. */
export async function consumePostgresSourceBindingPermit(client:Client,permit:PostgresSourceBindingPermit){
  const value=permits.get(permit);permits.delete(permit);
  if(!value||value.client!==client||value.token!==postgresBusinessToken(client))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
  await value.assertCurrent();return {...value,grant:structuredClone(value.grant),ref:{...value.ref},fields:[...value.fields],evidence:structuredClone(value.evidence)};
}
export interface PostgresSourceProjectionOptions{
  policyDigest:string;modelChannel:string;programRef:Ref;configurationDigest:string;sourceBindingId?:string;action?:string;
  inspectClaim:(claim:PostgresWorkReference)=>Promise<{validUntil:number}|undefined>;builder?:StagedKernelBuilder;
}
type SourceMethod='read'|'query'|'related'|'relationshipDigest'|'ingest'|'readPrivate'|'containsLinks'|'evidencePropertiesDigest'|'tombstone';
export type PostgresSourceProjectionGraph={ [K in SourceMethod]:(...args:Parameters<GraphStorage[K]>)=>Promise<Awaited<ReturnType<GraphStorage[K]>>> }&ProjectionMetadata&{readonly request:ServiceRequest};

/** Trusted mapper scope only. Model/provider I/O is forbidden in the callback.
 * Every read is admitted; every write binds the actual configured source and
 * inherited input restrictions. There is no raw/private read fallback. */
export async function withPostgresSourceProjection<T>(client:Client,input:PostgresWorkReference,options:PostgresSourceProjectionOptions,
  action:(graph:PostgresSourceProjectionGraph)=>Promise<T>):Promise<T>{
  const schema=postgresBusinessSchema(client),token=postgresBusinessToken(client),q=`"${schema}"`,claim=postgresWorkReference(input);
  if(claim.recovery||claim.job.state!=='working')throw new SecurityError('ACCESS_REVOKED');
  options={...options,programRef:{...options.programRef}};
  if(!/^[a-f0-9]{64}$/.test(options.policyDigest)||!/^[a-f0-9]{64}$/.test(options.configurationDigest)||!options.modelChannel||!options.programRef.id||!options.programRef.version||typeof options.inspectClaim!=='function')throw new Error('Explicit source projection authority is required');
  const configured=structuredClone({programRef:options.programRef,configurationDigest:options.configurationDigest,sourceBindingId:options.sourceBindingId,action:options.action});
  const request=await postgresWorkerRequest(client,claim,options.policyDigest,options.modelChannel,options.builder,options.inspectClaim);
  let open=true,failed=false,pending=0,queue:Promise<unknown>=Promise.resolve(),writes=0,reads=0,steps=0;
  const active=()=>{if(!open||failed||postgresBusinessToken(client)!==token)throw new SecurityError('AUTHORIZATION_REQUIRED');};
  const scope=async()=>{
    active();if(!await postgresClaimSnapshotMatches(client,claim,options.policyDigest))throw new SecurityError('ACCESS_REVOKED');
    const lease=await options.inspectClaim(claim);if(!lease||!Number.isSafeInteger(lease.validUntil)||lease.validUntil<=Date.now())throw new SecurityError('ACCESS_REVOKED');
    const admission=await postgresWorkerAdmission(client,claim.owner,claim.job.id,options.policyDigest);
    if(admission.authority.id!==claim.securityAuthorityId||admission.authority.authEpoch!==claim.securityEpoch||admission.policyRevision!==claim.securityPolicyRevision)throw new SecurityError('POLICY_CHANGED');
    postgresConstrainReadDeadline(client,admission.validUntil);postgresRequireLeaseAtCommit(client,digest(claim),()=>options.inspectClaim(claim));return admission;
  };
  const source=async()=>{
    const admission=await scope();
    const rows=await client.query(`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.security_sources WHERE owner=$1 AND installation_id=$2 AND state='active' ORDER BY __eigos_rowid LIMIT 257`,[claim.owner,admission.authority.installationId]);
    if(rows.rows.length>256||rows.rows.some(row=>typeof row.body!=='string'))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    const choices=rows.rows.map(row=>{const value=storedSourceSchema.parse(JSON.parse(row.body));if(value.bindingId!==row.binding_id||value.programId!==row.program_id||value.installationId!==admission.authority.installationId)throw new SecurityError('SOURCE_NOT_AUTHORIZED');return value;})
      .filter(value=>value.programId===configured.programRef.id&&value.programDigest===configured.configurationDigest&&(!configured.sourceBindingId||value.bindingId===configured.sourceBindingId)
        &&(!configured.action||value.operations.includes(configured.action))&&value.parentGrant.id===admission.parent.id&&value.parentGrant.revision===admission.parent.revision&&Date.parse(value.expiresAt)>Date.now());
    if(choices.length!==1)throw new SecurityError('SOURCE_NOT_AUTHORIZED');const selected=choices[0]!;
    if(reserved.has(selected.bindingId)||!admission.parent.capabilityIds.includes(selected.programId)||!admission.parent.sourceBindingIds.includes(selected.bindingId))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    postgresConstrainReadDeadline(client,Date.parse(selected.expiresAt));
    if(configured.action)await withPostgresWorkerEvidenceAuthorization(client,claim,options.policyDigest,async(_auth,_scope,principal)=>{
      for(const permission of ['resource.view','action.execute'] as const){const until=await postgresTaskResourcePermissionValidUntil(client,principal,request.id,options.policyDigest,'actionType',configured.action!,permission,options.builder);
        if(until<=Date.now())throw new SecurityError('AUTHORIZATION_REQUIRED');postgresConstrainReadDeadline(client,until);}
    },options.builder,options.modelChannel,options.inspectClaim);
    return {admission,selected};
  };
  await source();const job=await new PostgresTaskStorage(client,options.builder).get(claim.owner,claim.job.id),release=job.delegation?.ontologyRelease;
  if(!release||release.ontologyId!=='eigos.business'||request.revision!==job.delegation?.request.revision)throw new SecurityError('POLICY_CHANGED');
  const metadata=await PostgresProjectionGraph.create(client,claim.owner,release,options.builder,{readOnly:true});
  const evidence=async()=>{
    const history=await postgresTaskReadHistory(client,claim.owner,claim.job.id,request.revision);
    if(!history.length)throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const envelope=combineEnvelopes(history);
    if(envelope.submission?.taskId!==request.id||envelope.submission.requestRevision!==request.revision||envelope.submission.contentDigest!==submissionDigest(request))throw new SecurityError('POLICY_CHANGED');
    return withPostgresWorkerEvidenceAuthorization(client,claim,options.policyDigest,auth=>auth.authorizeEvidence(envelope),options.builder,options.modelChannel,options.inspectClaim);
  };
  const read=<R>(operation:(graph:Parameters<Parameters<typeof withPostgresPlanningReadGraph>[6]>[0])=>Promise<R>)=>
    withPostgresWorkerEvidenceAuthorization(client,claim,options.policyDigest,(auth,admission,principal)=>
      withPostgresPlanningReadGraph(client,principal,request.id,options.policyDigest,auth,admission,async graph=>{
        const result=await operation(graph),influence=graph.evidence();
        if(influence){const approved=await auth.authorizeEvidence(influence);await client.query(`INSERT INTO ${q}.security_reads(grant_id,digest,body) VALUES($1,$2,$3) ON CONFLICT(grant_id,digest) DO NOTHING`,[admission.grant.id,digest(approved),JSON.stringify(approved)]);}
        return result;
      },options.builder),options.builder,options.modelChannel,options.inspectClaim);
  const permission=async(type:string)=>withPostgresWorkerEvidenceAuthorization(client,claim,options.policyDigest,async(_auth,_admission,principal)=>{
    const until=await postgresTaskResourceViewValidUntil(client,principal,request.id,options.policyDigest,'linkType',type,options.builder);
    if(until<=Date.now())throw new SecurityError('AUTHORIZATION_REQUIRED');postgresConstrainReadDeadline(client,until);
  },options.builder,options.modelChannel,options.inspectClaim);
  const requireObject=async(ref:ObjectRef)=>withPostgresWorkerEvidenceAuthorization(client,claim,options.policyDigest,async auth=>{
    if(!await auth.bindingMetadata(ref))throw new SecurityError('AUTHORIZATION_REQUIRED');
  },options.builder,options.modelChannel,options.inspectClaim);
  const personalAsset=async(ref:ObjectRef,provenance:ObjectSource)=>{
    if(provenance.kind!=='user'||!['Person','PersonalPreference'].includes(ref.type))return false;
    const current=await new PostgresTaskStorage(client,options.builder).get(claim.owner,request.id);
    const plans=current.delegation?.agent?.plans??[],plan=plans.find(plan=>plan.steps.some(step=>step.intentId===provenance.id)),step=plan?.steps.find(step=>step.intentId===provenance.id);
    if(!plan||!step||!isPersonalAction(step.action)||step.effect!=='object_write'||!step.objectWrite?.targets.some(target=>key(target.ref)===key(ref)))return false;
    const {digest:expected,...body}=plan;
    if(digest(body)!==expected||plan.requestId!==request.id||plan.requestRevision!==request.revision||digest(step.objectWrite.ontologyRelease)!==digest(release)
      ||step.objectWrite.actionId!==step.action||step.objectWrite.actionDigest!==digest(metadata.model.action(step.action))||step.objectWrite.inputDigest!==digest(step.input))throw new SecurityError('POLICY_CHANGED');
    if(configured.action!==step.action||digest(step.binding?.programRef??plan.programRef)!==digest(configured.programRef)||(step.binding?.configurationDigest??plan.programDigest)!==configured.configurationDigest)throw new SecurityError('AUTHORIZATION_REQUIRED');
    const intent=await client.query(`SELECT state,CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.action_intents WHERE owner=$1 AND job_id=$2 AND id=$3 LIMIT 2`,[claim.owner,request.id,step.intentId]);
    if(intent.rowCount!==1||typeof intent.rows[0].body!=='string'||JSON.parse(intent.rows[0].body).planDigest!==plan.digest||!['dispatching','effect_confirmed'].includes(intent.rows[0].state))throw new SecurityError('AUTHORIZATION_REQUIRED');
    const attempts=await client.query(`SELECT 1 FROM ${q}.action_attempts WHERE owner=$1 AND intent_id=$2 AND ${q}.eigos_try_jsonb(body)->>'claimToken'=$3 AND ${q}.eigos_try_jsonb(body)->>'kind'='dispatch'
      AND ${q}.eigos_try_jsonb(body)->>'planDigest'=$4 AND ${q}.eigos_try_jsonb(body)->>'requestRevision'=$5 LIMIT 2`,[claim.owner,step.intentId,claim.token,plan.digest,String(claim.job.revision??0)]);
    if(!attempts.rowCount)throw new SecurityError('AUTHORIZATION_REQUIRED');
    const grants=await client.query(`SELECT CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.plan_grants WHERE owner=$1 AND job_id=$2 LIMIT 257`,[claim.owner,request.id]);
    if(grants.rows.length>256||!grants.rows.some(row=>typeof row.body==='string'&&matchesAgentGrant(JSON.parse(row.body) as PlanGrant,plan,step)))throw new SecurityError('AUTHORIZATION_REQUIRED');return true;
  };
  const ingest=async(owner:string,input:ObjectBatch,provenanceInput:ObjectSource)=>{
    active();if(owner!==claim.owner||++writes>200)throw new SecurityError('AUTHORIZATION_REQUIRED');
    const batch=ontologyBatchSchema.parse(structuredClone(input)),provenance=ontologySourceSchema.parse(structuredClone(provenanceInput));
    const initial=await source(),inherited=await evidence(),origin:ObservationSource={programId:initial.selected.programId,programDigest:initial.selected.programDigest,sourceBindingId:initial.selected.bindingId};
    const stamp=digest({parent:initial.admission.parent,grant:initial.admission.grant,source:initial.selected,policy:initial.admission.policyRevision});
    const current=async()=>{const next=await source();if(digest({parent:next.admission.parent,grant:next.admission.grant,source:next.selected,policy:next.admission.policyRevision})!==stamp)throw new SecurityError('POLICY_CHANGED');};
    for(const object of batch.objects){
      const rule=initial.admission.grant.outputs.find(rule=>rule.programId===origin.programId&&rule.programDigest===origin.programDigest&&rule.sourceBindingId===origin.sourceBindingId&&rule.type===object.ref.type);
      const allowed=initial.admission.parent.resources.find(resource=>resource.type===object.ref.type)?.fields??[];
      if(!rule||!initial.selected.outputTypes.includes(object.ref.type)||!rule.fields.every(field=>allowed.includes(field)))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
      if(object.observedFields?.some(field=>!Object.hasOwn(metadata.model.properties(object.ref.type),field)))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    }
    const name=`source_${randomUUID().replaceAll('-','')}`;await client.query(`SAVEPOINT ${name}`);
    try{
      const graph=await PostgresProjectionGraph.create(client,claim.owner,release,options.builder);await graph.ingest(owner,batch,provenance);
      const binder=new PostgresTaskBindings(client,options.builder);
      for(const object of batch.objects){
        const row=await client.query(`SELECT revision,definition_digest FROM ${q}.ontology_objects WHERE owner=$1 AND type=$2 AND id=$3 LIMIT 2`,[owner,object.ref.type,object.ref.id]);
        if(row.rowCount!==1)throw new SecurityError('POLICY_CHANGED');const revision=Number(row.rows[0].revision);
        const rule=initial.admission.grant.outputs.find(rule=>rule.programId===origin.programId&&rule.programDigest===origin.programDigest&&rule.sourceBindingId===origin.sourceBindingId&&rule.type===object.ref.type)!;
        const permit:PostgresSourceBindingPermit=Object.freeze({[brand]:true as const});
        permits.set(permit,{client,token,grant:initial.admission.grant,ref:object.ref,revision,fingerprint:String(row.rows[0].definition_digest),fields:object.observedFields?rule.fields.filter(field=>object.observedFields!.includes(field)):rule.fields,
          sourceBindingId:origin.sourceBindingId,evidence:inherited,...(metadata.model.hasType('ObservedFact')&&object.reuseIfUnchanged?{sourceObservation:origin}:{}),assertCurrent:current});
        await binder.bindSourceProjection(permit);
        const personal=await personalAsset(object.ref,provenance);
        const existing=await client.query(`SELECT CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.security_object_origins WHERE owner=$1 AND type=$2 AND object_id=$3 AND object_revision=$4 LIMIT 2`,[owner,object.ref.type,object.ref.id,revision]);
        if(existing.rowCount){if(existing.rowCount!==1||typeof existing.rows[0].body!=='string')throw new SecurityError('POLICY_CHANGED');
          const value=z.looseObject({programId:z.string().min(1),programDigest:z.string().regex(/^[a-f0-9]{64}$/),sourceBindingId:z.string().min(1),inputEnvelope:securityEnvelopeSchema,personalAsset:z.boolean().optional()}).parse(JSON.parse(existing.rows[0].body));
          if(value.inputEnvelope.ownerKey!==owner)throw new SecurityError('POLICY_CHANGED');
          if(!object.reuseIfUnchanged&&(value.programId!==origin.programId||value.programDigest!==origin.programDigest||value.sourceBindingId!==origin.sourceBindingId))throw new SecurityError('SOURCE_NOT_AUTHORIZED');}
        await client.query(`INSERT INTO ${q}.security_object_origins(owner,type,object_id,object_revision,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner,type,object_id,object_revision) DO NOTHING`,
          [owner,object.ref.type,object.ref.id,revision,JSON.stringify({...origin,inputEnvelope:inherited,...(personal?{personalAsset:true}:{})})]);
      }
      // Bind all new endpoints before checking links, exactly as the source
      // mapper does. A failed endpoint or role rolls back the entire batch.
      for(const edge of batch.links){await permission(edge.type);await requireObject(edge.from);await requireObject(edge.to);}
      for(const edge of batch.removeLinks){
        await permission(edge.type);await requireObject(edge.from);
        const replacement=metadata.model.hasType('ObservedFact')&&metadata.model.linkWritePolicy(edge.type)==='source'&&initial.selected.outputTypes.includes(edge.to.type)
          &&batch.objects.some(object=>key(object.ref)===key(edge.from))&&batch.links.some(link=>link.type===edge.type&&key(link.from)===key(edge.from)&&batch.objects.some(object=>object.ref.type===edge.to.type&&key(object.ref)===key(link.to)));
        let sameSource=false;
        if(replacement){const previous=await client.query(`SELECT CASE WHEN octet_length(origin.body)<=8388608 THEN origin.body END AS body FROM ${q}.security_object_origins origin JOIN ${q}.ontology_objects object ON object.owner=origin.owner AND object.type=origin.type AND object.id=origin.object_id AND object.revision=origin.object_revision WHERE object.owner=$1 AND object.type=$2 AND object.id=$3 LIMIT 2`,[owner,edge.to.type,edge.to.id]);
          if(previous.rowCount){if(previous.rowCount!==1||typeof previous.rows[0].body!=='string')throw new SecurityError('POLICY_CHANGED');const value=JSON.parse(previous.rows[0].body);
            sameSource=value.programId===origin.programId&&(value.sourceBindingId===origin.sourceBindingId&&value.programDigest===origin.programDigest||initial.selected.readbackVersions?.some(version=>version.sourceBindingId===value.sourceBindingId&&version.programDigest===value.programDigest)===true);}}
        if(!sameSource)await requireObject(edge.to);
      }
      await current();await client.query(`RELEASE SAVEPOINT ${name}`);
    }catch(error){await client.query(`ROLLBACK TO SAVEPOINT ${name}`);await client.query(`RELEASE SAVEPOINT ${name}`);throw error;}
  };
  const serial=<R>(operation:()=>Promise<R>):Promise<R>=>{
    try{active();if(++steps>1000)throw new SecurityError('OUTPUT_NOT_ALLOWED');}catch(error){return Promise.reject(error);}pending++;
    const next=queue.then(async()=>{active();try{const result=await operation();active();return result;}catch(error){failed=true;throw error;}}).finally(()=>{pending--;});
    queue=next.catch(()=>{});return next;
  };
  const driver:PostgresSourceProjectionGraph=Object.freeze({model:metadata.model,now:metadata.now,releaseRef:metadata.releaseRef,security:true,request:freezeData(structuredClone(request)),
    read:(...args:Parameters<GraphStorage['read']>)=>serial(()=>{if(++reads>1000)throw new SecurityError('OUTPUT_NOT_ALLOWED');return read(graph=>graph.read(...args));}),
    query:(...args:Parameters<GraphStorage['query']>)=>serial(()=>read(graph=>graph.query(...args))),related:(...args:Parameters<GraphStorage['related']>)=>serial(()=>read(graph=>graph.related(...args))),relationshipDigest:(...args:Parameters<GraphStorage['relationshipDigest']>)=>serial(()=>read(graph=>graph.relationshipDigest(...args))),
    ingest:(...args:Parameters<GraphStorage['ingest']>)=>serial(()=>ingest(...args)),readPrivate:()=>{throw new SecurityError('AUTHORIZATION_REQUIRED');},containsLinks:()=>{throw new SecurityError('AUTHORIZATION_REQUIRED');},evidencePropertiesDigest:()=>{throw new SecurityError('AUTHORIZATION_REQUIRED');},tombstone:()=>{throw new SecurityError('AUTHORIZATION_REQUIRED');}});
  const frame=`source_frame_${randomUUID().replaceAll('-','')}`;await client.query(`SAVEPOINT ${frame}`);
  try{const result=await action(driver);if(pending){open=false;await queue;throw new Error('Source projection callback must await every storage operation');}await source();await client.query(`RELEASE SAVEPOINT ${frame}`);return result;}
  catch(error){open=false;await queue;await client.query(`ROLLBACK TO SAVEPOINT ${frame}`);await client.query(`RELEASE SAVEPOINT ${frame}`);throw error;}
  finally{open=false;await queue;}
}
