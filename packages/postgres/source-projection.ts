import {DomainError} from '../core/domain.js';
import {postgresConsentDeadline,postgresConstrainConsent} from './consent.js';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {matchesAgentGrant} from '../core/agent-authorization.js';
import type {PlanGrant} from '../ontology/actions.js';
import type {Ref,ServiceRequest} from '../ontology/execution.js';
import {ontologyBatchSchema,ontologySourceSchema,type ObjectBatch,type ObjectSource,type ManagedObjectBatch} from '../ontology/object-store.js';
import type {ObjectRef} from '../ontology/model.js';
import type {GraphStorage,ProjectionMetadata} from '../ontology/graph-program.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {DidiAgentProgram} from '../capabilities/didi/program.js';
import {checkedRideEstimate} from '../ontology/ride-estimate-projection.js';
import {sourceEntityRef} from '../ontology/business-fact-projection.js';
import {objectEnvelope} from '../security/object-envelope.js';
import {reviewedFieldPolicy} from '../security/field-policy.js';
import {postgresTaskCurrentLabels} from './task-read-access.js';
import {verifyPostgresDidiSourceReceipt,type PostgresDidiTransport} from './didi-policy.js';
import {PostgresDidiAccount} from './didi-account.js';
import type {PostgresActionSemanticContext} from './action-authorization.js';
import type {AgentActionResult} from '../core/agent-program.js';
import type {ExecutionAttempt,ActionResult} from '../ontology/actions.js';
import {isPersonalAction} from '../ontology/personal-context.js';
import {taskDataGrantSchema,securityEnvelopeSchema} from '../security/contracts.js';
import {storedSourceSchema,type ObservationSource} from '../security/source-policy.js';
import {SecurityError,SecurityLineageLimitError} from '../security/errors.js';
import {combineEnvelopes,type SecurityEnvelope} from '../security/envelope.js';
import {submissionDigest} from '../security/submission-digest.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresConstrainReadDeadline,postgresRequireLeaseAtCommit} from './runtime-transaction.js';
import {postgresWorkReference,postgresClaimSnapshotMatches,type PostgresWorkReference} from './work-claim.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import {postgresWorkerRequest} from './worker-input.js';
import {withPostgresWorkerEvidenceAuthorization,withPostgresWorkerRequestAuthorization,withPostgresCallerEvidenceAuthorization} from './task-output.js';
import {withPostgresOntologyReleaseSnapshot} from './ontology-release.js';
import {withPostgresCallerActionGraph,assertPostgresCallerAction,postgresCallerActionAuthority} from './caller-action.js';
import {PostgresActionJournal} from './action-journal.js';
import {DynamicOntologyProgram} from '../capabilities/dynamic-ontology.js';
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
export type PostgresSourceProjectionGraph={ [K in SourceMethod]:(...args:Parameters<GraphStorage[K]>)=>Promise<Awaited<ReturnType<GraphStorage[K]>>> }&ProjectionMetadata&Pick<GraphStorage,'withGraphFunction'|'projectedRelationshipDigest'|'planning'>&{readonly request:ServiceRequest};
export type PostgresCallerSourceProjectionGraph=PostgresSourceProjectionGraph&Pick<GraphStorage,'managedObject'|'previewManaged'|'applyManaged'|'managedDispatchCheck'>;
type CallerDispatch={journal:PostgresActionJournal;intentId:string;attemptId:string;planId:string};
export interface PostgresDidiCanonicalDispatch {journal:PostgresActionJournal;program:DidiAgentProgram;account:PostgresDidiAccount;transport:PostgresDidiTransport;context:PostgresActionSemanticContext;attempt:ExecutionAttempt;observationId:string;response:AgentActionResult}


/** Explicit host-only caller mapper. The actual journal instance, immutable
 * template and persisted original dispatch are checked before selecting the
 * PA channel. A JSON mode flag cannot enter this path. */
export async function withPostgresCallerSourceProjection<T>(client:Client,input:PostgresWorkReference,options:Omit<PostgresSourceProjectionOptions,'modelChannel'>,
  dispatch:CallerDispatch,action:(graph:PostgresCallerSourceProjectionGraph)=>Promise<T>):Promise<T>{
  if(!(dispatch.journal instanceof PostgresActionJournal))throw new SecurityError('AUTHORIZATION_REQUIRED');
  await dispatch.journal.assertDispatchAllowed(input,dispatch.intentId,dispatch.attemptId);
  return sourceProjection(client,input,{...options,modelChannel:''},graph=>action(graph),undefined,dispatch);
}

/** Trusted mapper scope only. Model/provider I/O is forbidden in the callback.
 * Every read is admitted; every write binds the actual configured source and
 * inherited input restrictions. There is no raw/private read fallback. */
export async function withPostgresSourceProjection<T>(client:Client,input:PostgresWorkReference,options:PostgresSourceProjectionOptions,
  action:(graph:PostgresSourceProjectionGraph)=>Promise<T>,onInfluence?:(envelope:SecurityEnvelope)=>void):Promise<T>{
  return sourceProjection(client,input,options,action,onInfluence);
}
/** Only the actual original, confirmed DiDi projector can compare canonical
 * source entities. No normal initializer, model/caller reader or JSON flag can
 * acquire this port; all source/account/receipt checks remain current. */
export async function withPostgresDidiCanonicalSourceProjection<T>(client:Client,input:PostgresWorkReference,options:PostgresSourceProjectionOptions,dispatch:PostgresDidiCanonicalDispatch,action:(graph:PostgresSourceProjectionGraph)=>Promise<T>):Promise<T>{
  const claim=postgresWorkReference(input),ctx=dispatch.context;
  if(!(dispatch.journal instanceof PostgresActionJournal)||!(dispatch.program instanceof DidiAgentProgram)||!(dispatch.account instanceof PostgresDidiAccount)
    ||ctx.owner!==claim.owner||ctx.job.id!==claim.job.id||ctx.intent.id!==dispatch.attempt.intentId||ctx.step.intentId!==ctx.intent.id||ctx.step.effect!=='read'||!['SearchDidiPlaces','EstimateDidiRide'].includes(ctx.step.action)
    ||digest(dispatch.program.ref)!==digest(options.programRef)||dispatch.program.configurationDigest!==options.configurationDigest||options.action!==ctx.step.action)throw new SecurityError('AUTHORIZATION_REQUIRED');
  await dispatch.journal.assertDispatchAllowed(claim,ctx.intent.id,dispatch.attempt.id);await dispatch.account.assert(client,claim,ctx.job,options.policyDigest);
  const rows=await client.query(`SELECT attempt_id,digest,applied,CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM "${postgresBusinessSchema(client)}".action_observations WHERE owner=$1 AND intent_id=$2 AND id=$3 LIMIT 2`,[claim.owner,ctx.intent.id,dispatch.observationId]);
  if(rows.rowCount!==1||rows.rows[0].attempt_id!==dispatch.attempt.id||Number(rows.rows[0].applied)!==0||typeof rows.rows[0].body!=='string')throw new SecurityError('AUTHORIZATION_REQUIRED');
  const result=JSON.parse(rows.rows[0].body) as ActionResult;if(digest(result)!==rows.rows[0].digest||result.kind!=='confirmed'||digest(result.output?.source)!==digest(dispatch.response.value))throw new SecurityError('POLICY_CHANGED');
  checkedRideEstimate(dispatch.response.value);await verifyPostgresDidiSourceReceipt(client,claim,ctx,dispatch.attempt,dispatch.response,result,dispatch.transport);
  return sourceProjection(client,claim,options,action,undefined,undefined,dispatch);
}
async function sourceProjection<T>(client:Client,input:PostgresWorkReference,options:PostgresSourceProjectionOptions,
  action:(graph:PostgresCallerSourceProjectionGraph)=>Promise<T>,onInfluence?:((envelope:SecurityEnvelope)=>void),caller?:CallerDispatch,canonical?:PostgresDidiCanonicalDispatch):Promise<T>{
  const schema=postgresBusinessSchema(client),token=postgresBusinessToken(client),q=`"${schema}"`,claim=postgresWorkReference(input);
  if(claim.recovery||claim.job.state!=='working')throw new SecurityError('ACCESS_REVOKED');
  options={...options,programRef:{...options.programRef}};
  if(!/^[a-f0-9]{64}$/.test(options.policyDigest)||!/^[a-f0-9]{64}$/.test(options.configurationDigest)||!caller&&!options.modelChannel||!options.programRef.id||!options.programRef.version||typeof options.inspectClaim!=='function')throw new Error('Explicit source projection authority is required');
  const configured=structuredClone({programRef:options.programRef,configurationDigest:options.configurationDigest,sourceBindingId:options.sourceBindingId,action:options.action});
  const callerGraph=<R>(callback:Parameters<typeof withPostgresCallerActionGraph<R>>[4])=>withPostgresCallerActionGraph(client,{claim,inspectClaim:options.inspectClaim},claim.job.id,options,callback);
  const request=caller?await callerGraph(async(_graph,program,job)=>{
    assertPostgresCallerAction(program,job,claim.owner);const plan=job.delegation!.agent!.plans.find(plan=>plan.id===caller.planId),step=plan?.steps[0];
    if(!plan||plan.steps.length!==1||step?.intentId!==caller.intentId||step.action!==configured.action||digest(program.ref)!==digest(configured.programRef)||program.configurationDigest!==configured.configurationDigest)throw new SecurityError('POLICY_CHANGED');
    return structuredClone(job.delegation!.request);
  }):await postgresWorkerRequest(client,claim,options.policyDigest,options.modelChannel,options.builder,options.inspectClaim);
  const authorize:typeof withPostgresWorkerEvidenceAuthorization=caller?(client,claim,policy,action,builder,_modelChannel,inspect)=>withPostgresCallerEvidenceAuthorization(client,claim,policy,action,builder,inspect):withPostgresWorkerEvidenceAuthorization;
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
        &&(!configured.action||value.operations.includes(configured.action))&&value.parentGrant.id===admission.parent.id&&value.parentGrant.revision===admission.parent.revision&&postgresConsentDeadline(value.expiresAt,options.policyDigest)>Date.now());
    if(choices.length!==1)throw new SecurityError('SOURCE_NOT_AUTHORIZED');const selected=choices[0]!;
    if(reserved.has(selected.bindingId)||!admission.parent.capabilityIds.includes(selected.programId)||!admission.parent.sourceBindingIds.includes(selected.bindingId))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    postgresConstrainConsent(client,selected.expiresAt,options.policyDigest);
    if(configured.action)await authorize(client,claim,options.policyDigest,async(_auth,_scope,principal)=>{
      for(const permission of ['resource.view','action.execute'] as const){const until=await postgresTaskResourcePermissionValidUntil(client,principal,request.id,options.policyDigest,'actionType',configured.action!,permission,options.builder);
        if(until<=Date.now())throw new SecurityError('AUTHORIZATION_REQUIRED');postgresConstrainReadDeadline(client,until);}
    },options.builder,options.modelChannel,options.inspectClaim);
    return {admission,selected};
  };
  await source();const job=await new PostgresTaskStorage(client,options.builder).get(claim.owner,claim.job.id),release=job.delegation?.ontologyRelease;
  if(!release||release.ontologyId!=='eigos.business'||request.revision!==job.delegation?.request.revision)throw new SecurityError('POLICY_CHANGED');
  const metadata=await PostgresProjectionGraph.create(client,claim.owner,release,options.builder,{readOnly:true});
  const canonicalRestrictions=new Map<string,SecurityEnvelope>();
  const evidence=async()=>{
    const history=await postgresTaskReadHistory(client,claim.owner,claim.job.id,request.revision);
    if(!history.length)throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const envelope=combineEnvelopes([...history,...canonicalRestrictions.values()]);
    if(envelope.submission?.taskId!==request.id||envelope.submission.requestRevision!==request.revision||envelope.submission.contentDigest!==submissionDigest(request))throw new SecurityError('POLICY_CHANGED');
    return authorize(client,claim,options.policyDigest,auth=>auth.authorizeEvidence(envelope),options.builder,options.modelChannel,options.inspectClaim);
  };
  // Only this read-only graph command opts in. The scope closes before the
  // mapper can ingest, and source admission/write checks always stay fresh.
  const readAuthorize=caller?authorize:withPostgresWorkerRequestAuthorization;
  const read=<R>(operation:(graph:Parameters<Parameters<typeof withPostgresPlanningReadGraph>[6]>[0])=>Promise<R>)=>
    withPostgresOntologyReleaseSnapshot(client,()=>readAuthorize(client,claim,options.policyDigest,(auth,admission,principal)=>
      withPostgresPlanningReadGraph(client,principal,request.id,options.policyDigest,auth,admission,async graph=>{
        const result=await operation(graph),influence=graph.evidence();
        if(influence){const approved=await auth.authorizeEvidence(influence);await client.query(`INSERT INTO ${q}.security_reads(grant_id,digest,body) VALUES($1,$2,$3) ON CONFLICT(grant_id,digest) DO NOTHING`,[admission.grant.id,digest(approved),JSON.stringify(approved)]);
          onInfluence?.(structuredClone(approved));}
        return result;
      },options.builder),options.builder,options.modelChannel,options.inspectClaim));
  const permission=async(type:string)=>authorize(client,claim,options.policyDigest,async(_auth,_admission,principal)=>{
    const until=await postgresTaskResourceViewValidUntil(client,principal,request.id,options.policyDigest,'linkType',type,options.builder);
    if(until<=Date.now())throw new SecurityError('AUTHORIZATION_REQUIRED');postgresConstrainReadDeadline(client,until);
  },options.builder,options.modelChannel,options.inspectClaim);
  const requireObject=async(ref:ObjectRef)=>authorize(client,claim,options.policyDigest,async auth=>{
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
  const ingest=async(owner:string,input:ObjectBatch,provenanceInput:ObjectSource,managed?:ManagedObjectBatch)=>{
    active();if(owner!==claim.owner||++writes>200)throw new SecurityError('AUTHORIZATION_REQUIRED');
    const batch=ontologyBatchSchema.parse(structuredClone(input)),provenance=ontologySourceSchema.parse(structuredClone(provenanceInput));
    const initial=await source(),inherited=await evidence(),origin:ObservationSource={programId:initial.selected.programId,programDigest:initial.selected.programDigest,sourceBindingId:initial.selected.bindingId};
    if(managed)await authorize(client,claim,options.policyDigest,async(_auth,admission,principal)=>{
      const job=await new PostgresTaskStorage(client,options.builder).get(claim.owner,request.id);
      await postgresCallerActionAuthority(client,principal,admission,job,new DynamicOntologyProgram(metadata.model,metadata.releaseRef,claim.owner),options,managed);
    },options.builder,undefined,options.inspectClaim);
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
      const graph=await PostgresProjectionGraph.create(client,claim.owner,release,options.builder);if(managed)await graph.applyManaged(owner,managed,provenance);else await graph.ingest(owner,batch,provenance);
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
      const validateLinks=async(requireLink:(type:string)=>Promise<void>,requireEndpoint:(ref:ObjectRef)=>Promise<void>)=>{
        for(const edge of batch.links){await requireLink(edge.type);await requireEndpoint(edge.from);await requireEndpoint(edge.to);}
        for(const edge of batch.removeLinks){
          await requireLink(edge.type);await requireEndpoint(edge.from);
          const replacement=metadata.model.hasType('ObservedFact')&&metadata.model.linkWritePolicy(edge.type)==='source'&&initial.selected.outputTypes.includes(edge.to.type)
            &&batch.objects.some(object=>key(object.ref)===key(edge.from))&&batch.links.some(link=>link.type===edge.type&&key(link.from)===key(edge.from)&&batch.objects.some(object=>object.ref.type===edge.to.type&&key(object.ref)===key(link.to)));
          let sameSource=false;
          if(replacement){const previous=await client.query(`SELECT CASE WHEN octet_length(origin.body)<=8388608 THEN origin.body END AS body FROM ${q}.security_object_origins origin JOIN ${q}.ontology_objects object ON object.owner=origin.owner AND object.type=origin.type AND object.id=origin.object_id AND object.revision=origin.object_revision WHERE object.owner=$1 AND object.type=$2 AND object.id=$3 LIMIT 2`,[owner,edge.to.type,edge.to.id]);
            if(previous.rowCount){if(previous.rowCount!==1||typeof previous.rows[0].body!=='string')throw new SecurityError('POLICY_CHANGED');const value=JSON.parse(previous.rows[0].body);
              sameSource=value.programId===origin.programId&&(value.sourceBindingId===origin.sourceBindingId&&value.programDigest===origin.programDigest||initial.selected.readbackVersions?.some(version=>version.sourceBindingId===value.sourceBindingId&&version.programDigest===value.programDigest)===true);}}
          if(!sameSource)await requireEndpoint(edge.to);
        }
      };
      if(batch.links.length||batch.removeLinks.length){
        try{
          // All graph/binding/origin writes have finished. This entire pass is
          // read-only, so one actual authorization can validate shared lineage
          // once. Its caches close before current() or another graph command.
          await authorize(client,claim,options.policyDigest,async(auth,_admission,principal)=>{
            const linkTypes=new Set<string>(),endpoints=new Set<string>();
            await validateLinks(async type=>{
              if(linkTypes.has(type))return;
              const until=await postgresTaskResourceViewValidUntil(client,principal,request.id,options.policyDigest,'linkType',type,options.builder);
              if(until<=Date.now())throw new SecurityError('AUTHORIZATION_REQUIRED');postgresConstrainReadDeadline(client,until);linkTypes.add(type);
            },async ref=>{
              const id=key(ref);if(endpoints.has(id))return;
              if(!await auth.bindingMetadata(ref))throw new SecurityError('AUTHORIZATION_REQUIRED');endpoints.add(id);
            });
          },options.builder,options.modelChannel,options.inspectClaim);
        }catch(error){
          // A union of individually bounded ancestry can exceed one scope's
          // unchanged limit. The failed read-only scope is already closed;
          // replay only its reads with the original per-edge boundaries.
          if(!(error instanceof SecurityLineageLimitError))throw error;
          await validateLinks(permission,requireObject);
        }
      }
      await current();await client.query(`RELEASE SAVEPOINT ${name}`);
    }catch(error){await client.query(`ROLLBACK TO SAVEPOINT ${name}`);await client.query(`RELEASE SAVEPOINT ${name}`);throw error;}
  };
  const canonicalTypes=new Set(['Place','Provider','RideRoute','RideEstimate']);
  const expectedAbsences=new WeakSet<object>();
  const absent=():never=>{const error=new DomainError('NOT_FOUND','Original DiDi output has not been projected');expectedAbsences.add(error);throw error;};
  const storedPresence=async(owner:string,ref:ObjectRef)=>{
    const scoped=release.ontologyId!=='eigos.business',table=scoped?'ontology_scoped_objects':'ontology_objects';
    const rows=await client.query(`SELECT EXISTS(SELECT 1 FROM ${q}.${table} WHERE ${scoped?'ontology_id=$1 AND ':''}owner=$2 AND type=$3 AND id=$4) AS present,EXISTS(SELECT 1 FROM ${q}.ontology_tombstones WHERE ontology_id=$1 AND owner=$2 AND type=$3 AND id=$4) AS tombstoned`,[release.ontologyId,owner,ref.type,ref.id]);
    if(rows.rowCount!==1||typeof rows.rows[0].present!=='boolean'||typeof rows.rows[0].tombstoned!=='boolean')throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    return {present:rows.rows[0].present as boolean,tombstoned:rows.rows[0].tombstoned as boolean};
  };
  const canonicalSnapshot=canonical?checkedRideEstimate(canonical.response.value):undefined;
  const freshObservationRefs=new Set(canonicalSnapshot?[key({type:canonicalSnapshot.data.kind==='places'?'DidiPlaceObservation':'RideEstimateObservation',id:canonicalSnapshot.id}),key({type:'SourceReceipt',id:`didi:${canonicalSnapshot.id}`})]:[]);
  const sourceRead=async(...args:Parameters<GraphStorage['read']>)=>{
    const [owner,ref]=args;
    // Only the two immutable output identities from the already verified
    // original receipt may establish absence without a binding. Existing or
    // tombstoned objects retain the normal authorization/replay refusal.
    if(canonical&&owner===claim.owner&&freshObservationRefs.has(key(ref))){
      await source();await canonical.account.assert(client,claim,job,options.policyDigest);
      const exists=await storedPresence(owner,ref);if(!exists.present&&!exists.tombstoned)absent();
    }
    return read(graph=>graph.read(...args));
  };
  const canonicalRead=async(owner:string,ref:ObjectRef,budget:import('../ontology/object-store.js').ReadBudget={remaining:1000})=>{
    active();if(!canonical||caller||owner!==claim.owner||!canonicalTypes.has(ref.type)||metadata.model.objectWritePolicy(ref.type)!=='source')throw new SecurityError('AUTHORIZATION_REQUIRED');
    await canonical.account.assert(client,claim,job,options.policyDigest);const current=await source(),rule=current.admission.grant.outputs.find(value=>value.type===ref.type&&value.programId===current.selected.programId&&value.programDigest===current.selected.programDigest&&value.sourceBindingId===current.selected.bindingId),allowed=current.admission.parent.resources.find(value=>value.type===ref.type)?.fields??[];
    if(!rule||!current.selected.outputTypes.includes(ref.type)||!rule.fields.every(field=>allowed.includes(field)))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    await authorize(client,claim,options.policyDigest,async(_auth,_admission,principal)=>{const until=await postgresTaskResourceViewValidUntil(client,principal,request.id,options.policyDigest,'objectType',ref.type,options.builder);if(until<=Date.now())throw new SecurityError('AUTHORIZATION_REQUIRED');postgresConstrainReadDeadline(client,until);},options.builder,options.modelChannel,options.inspectClaim);
    const exists=await storedPresence(owner,ref);if(exists.tombstoned)throw new DomainError('CONFLICT','A deleted canonical source entity cannot be recreated');if(!exists.present)absent();
    const storage=await PostgresProjectionGraph.create(client,owner,release,options.builder,{readOnly:true});
    const view=await storage.readPrivate(owner,ref,budget);
    const origins=await client.query(`SELECT CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.security_object_origins WHERE owner=$1 AND type=$2 AND object_id=$3 AND object_revision=$4 LIMIT 2`,[owner,ref.type,ref.id,view.revision]);
    if(origins.rowCount!==1||typeof origins.rows[0].body!=='string'||!['provider','synthetic'].includes(view.source.kind))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    const origin=z.looseObject({programId:z.string(),programDigest:z.string(),sourceBindingId:z.string(),inputEnvelope:securityEnvelopeSchema}).parse(JSON.parse(origins.rows[0].body));
    const sameSource=origin.programId===current.selected.programId&&(origin.programDigest===current.selected.programDigest&&origin.sourceBindingId===current.selected.bindingId||current.selected.readbackVersions?.some(value=>value.programDigest===origin.programDigest&&value.sourceBindingId===origin.sourceBindingId));
    // The trusted mapper compares its own deterministic provider identity on
    // reobservation. Its fixed, verified endpoint is server metadata, never a
    // model-readable field or authority to read arbitrary private properties.
    const provider=canonicalSnapshot&&sourceEntityRef('Provider',`didi:${canonicalSnapshot.receipt.environment}:${canonicalSnapshot.receipt.bindingId}`,'didi-mcp');
    const providerIdentity=provider&&key(provider)===key(ref)&&Object.hasOwn(view.properties,'verifiedIdentityRefs');
    if(providerIdentity&&digest(view.properties.verifiedIdentityRefs)!==digest([canonicalSnapshot!.receipt.endpoint]))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    const fields=Object.keys(view.properties).filter(field=>!(providerIdentity&&field==='verifiedIdentityRefs'));
    if(!sameSource||origin.inputEnvelope.ownerKey!==owner||!origin.inputEnvelope.lineageComplete||fields.some(field=>!rule.fields.includes(field)||!allowed.includes(field)||reviewedFieldPolicy(metadata.model,ref.type,field)==='internal_only'))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    // This is a verified independent provider reobservation, not reuse of an
    // older task's input. Preserve current explicit object labels/restrictions
    // without copying that task's private submission/dependency values.
    const labels=await authorize(client,claim,options.policyDigest,(_auth,_admission,principal)=>postgresTaskCurrentLabels(client,principal,request.id,options.policyDigest,ref,view.revision,fields,options.builder),options.builder,options.modelChannel,options.inspectClaim);
    const restricted=objectEnvelope({owner,ref,revision:view.revision,fields,values:Object.fromEntries(fields.map(field=>[field,view.properties[field]])),channels:current.admission.grant.channels,labels,policy:field=>reviewedFieldPolicy(metadata.model,ref.type,field)});
    const {lineage:_lineage,submission:_submission,...restrictions}=restricted;canonicalRestrictions.set(key(ref),{...restrictions,lineage:[],lineageComplete:true});await evidence();active();return view;
  };
  const canonicalRelated=async(owner:string,ref:ObjectRef,link:string,budget:import('../ontology/object-store.js').ReadBudget)=>{
    if(!canonical||link!=='sourceReceipts'||!canonicalTypes.has(ref.type))throw new SecurityError('AUTHORIZATION_REQUIRED');await canonicalRead(owner,ref,budget);const current=await source();await permission(metadata.model.navigation(ref.type,link).link.id);
    if(!current.selected.outputTypes.includes('SourceReceipt')||!current.admission.grant.outputs.some(value=>value.type==='SourceReceipt'&&value.programId===current.selected.programId&&value.programDigest===current.selected.programDigest&&value.sourceBindingId===current.selected.bindingId))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    await authorize(client,claim,options.policyDigest,async(_auth,_admission,principal)=>{const until=await postgresTaskResourceViewValidUntil(client,principal,request.id,options.policyDigest,'objectType','SourceReceipt',options.builder);if(until<=Date.now())throw new SecurityError('AUTHORIZATION_REQUIRED');postgresConstrainReadDeadline(client,until);},options.builder,options.modelChannel,options.inspectClaim);
    const receiptRule=current.admission.grant.outputs.find(value=>value.type==='SourceReceipt'&&value.programId===current.selected.programId&&value.programDigest===current.selected.programDigest&&value.sourceBindingId===current.selected.bindingId),receiptFields=current.admission.parent.resources.find(value=>value.type==='SourceReceipt')?.fields??[],definition=metadata.model.object('SourceReceipt');
    if(!receiptRule||![definition.primaryKey,definition.titleKey,'observedAt'].every(field=>receiptFields.includes(field)&&receiptRule.fields.includes(field)))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    const storage=await PostgresProjectionGraph.create(client,owner,release,options.builder,{readOnly:true}),rows=await storage.related(owner,ref,link,budget);if(rows===undefined)throw new DomainError('CONFLICT','Canonical source evidence is incomplete');
    for(const receipt of rows){if(receipt.ref.type!=='SourceReceipt'||receipt.source.kind!=='provider'&&receipt.source.kind!=='synthetic')throw new SecurityError('SOURCE_NOT_AUTHORIZED');const origins=await client.query(`SELECT CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.security_object_origins WHERE owner=$1 AND type='SourceReceipt' AND object_id=$2 AND object_revision=$3 LIMIT 2`,[owner,receipt.ref.id,receipt.revision]);if(origins.rowCount!==1||typeof origins.rows[0].body!=='string')throw new SecurityError('SOURCE_NOT_AUTHORIZED');const origin=z.looseObject({programId:z.string(),programDigest:z.string(),sourceBindingId:z.string()}).parse(JSON.parse(origins.rows[0].body));if(origin.programId!==current.selected.programId||!(origin.programDigest===current.selected.programDigest&&origin.sourceBindingId===current.selected.bindingId||current.selected.readbackVersions?.some(value=>value.programDigest===origin.programDigest&&value.sourceBindingId===origin.sourceBindingId)))throw new SecurityError('SOURCE_NOT_AUTHORIZED');}
    return rows.map(row=>({...row,properties:{[definition.primaryKey]:row.properties[definition.primaryKey],[definition.titleKey]:row.properties[definition.titleKey],observedAt:z.iso.datetime({offset:true}).parse(row.properties.observedAt)}}));
  };
  const serial=<R>(operation:()=>Promise<R>):Promise<R>=>{
    try{active();if(++steps>1000)throw new SecurityError('OUTPUT_NOT_ALLOWED');}catch(error){return Promise.reject(error);}pending++;
    const next=queue.then(async()=>{active();try{const result=await operation();active();return result;}catch(error){if(!error||typeof error!=='object'||!expectedAbsences.has(error))failed=true;throw error;}}).finally(()=>{pending--;});
    queue=next.catch(()=>{});return next;
  };
  const dispatchCheck=async(owner:string,invocation:import('../ontology/graph-program.js').ManagedDispatchInvocation)=>{
    active();if(!caller||owner!==claim.owner||invocation.requestId!==request.id||invocation.planId!==caller.planId||invocation.intentId!==caller.intentId||invocation.attemptId!==caller.attemptId)throw new SecurityError('AUTHORIZATION_REQUIRED');
    await caller.journal.assertDispatchAllowed(claim,caller.intentId,caller.attemptId);active();await scope();active();
  };
  const driver:PostgresCallerSourceProjectionGraph=Object.freeze({model:metadata.model,now:metadata.now,releaseRef:metadata.releaseRef,security:true,request:freezeData(structuredClone(request)),
    read:(...args:Parameters<GraphStorage['read']>)=>serial(()=>{if(++reads>1000)throw new SecurityError('OUTPUT_NOT_ALLOWED');return sourceRead(...args);}),
    query:(...args:Parameters<GraphStorage['query']>)=>serial(()=>read(graph=>graph.query(...args))),related:(...args:Parameters<GraphStorage['related']>)=>serial(()=>canonical&&canonicalTypes.has(args[1].type)&&args[2]==='sourceReceipts'?canonicalRelated(...args):read(graph=>graph.related(...args))),relationshipDigest:(...args:Parameters<GraphStorage['relationshipDigest']>)=>serial(()=>read(graph=>graph.relationshipDigest(...args))),
    ingest:(...args:Parameters<GraphStorage['ingest']>)=>serial(()=>{if(caller)throw new SecurityError('AUTHORIZATION_REQUIRED');return ingest(...args);}),readPrivate:(...args:Parameters<GraphStorage['readPrivate']>)=>{if(!canonical)throw new SecurityError('AUTHORIZATION_REQUIRED');return serial(()=>canonicalRead(...args));},
    containsLinks:(...args:Parameters<GraphStorage['containsLinks']>)=>serial(()=>{if(!caller)throw new SecurityError('AUTHORIZATION_REQUIRED');return callerGraph(graph=>Promise.resolve(graph.containsLinks(...args)));}),
    evidencePropertiesDigest:()=>{throw new SecurityError('AUTHORIZATION_REQUIRED');},
    withGraphFunction:<R>(owner:string,id:string,action:(scope:GraphStorage)=>Promise<R>)=>serial(()=>{if(caller||configured.programRef.id!=='ride.estimate.query'||!['rideEstimateStatus','selectDidiPlace'].includes(id))throw new SecurityError('AUTHORIZATION_REQUIRED');return read(graph=>graph.withGraphFunction(owner,id,action));}),
    planning:{evaluate:(...args:Parameters<NonNullable<import('../ontology/graph-program.js').PlanningGraphStorage['evaluate']>>)=>serial(()=>read(graph=>graph.evaluate(...args)))},
    projectedRelationshipDigest:(owner:string,ref:ObjectRef,links:import('../ontology/object-store.js').LinkWrite[],remove:import('../ontology/object-store.js').LinkWrite[]=[])=>serial(async()=>{if(!canonical||owner!==claim.owner||!canonicalTypes.has(ref.type))throw new SecurityError('AUTHORIZATION_REQUIRED');try{await canonicalRead(owner,ref);}catch(error){if(!(error instanceof DomainError&&error.code==='NOT_FOUND'))throw error;}return(await PostgresProjectionGraph.create(client,owner,release,options.builder,{readOnly:true})).projectedRelationshipDigest(owner,ref,links,remove);}),
    tombstone:(...args:Parameters<GraphStorage['tombstone']>)=>serial(()=>{if(!caller)throw new SecurityError('AUTHORIZATION_REQUIRED');return callerGraph(graph=>Promise.resolve(graph.tombstone(...args)));}),
    ...(caller?{
      managedObject:(...args:Parameters<NonNullable<GraphStorage['managedObject']>>)=>serial(()=>callerGraph(graph=>Promise.resolve(graph.managedObject!(...args)))),
      previewManaged:(...args:Parameters<NonNullable<GraphStorage['previewManaged']>>)=>serial(()=>callerGraph(graph=>Promise.resolve(graph.previewManaged!(...args)))),
      managedDispatchCheck:(...args:Parameters<NonNullable<GraphStorage['managedDispatchCheck']>>)=>serial(()=>dispatchCheck(...args)),
      applyManaged:(owner:string,batch:ManagedObjectBatch,provenance:ObjectSource)=>serial(async()=>{
        await dispatchCheck(owner,{requestId:request.id,planId:caller.planId,intentId:caller.intentId,attemptId:caller.attemptId});
        if(provenance.kind!=='user'||provenance.id!==caller.intentId)throw new SecurityError('SOURCE_NOT_AUTHORIZED');
        // Validate the ordinary projection separately from managed create/delete
        // preconditions; applyManaged receives the complete original batch.
        await ingest(owner,{objects:batch.objects,links:batch.links,removeLinks:batch.removeLinks},provenance,batch);
      }),
    }:{}),
  });
  // Capture admitted original-request/history influence before the mapper can
  // change its own source projections. Later reads append their exact approved
  // snapshots; never reinterpret an older read as the new written revision.
  if(onInfluence)onInfluence(structuredClone(await evidence()));
  const frame=`source_frame_${randomUUID().replaceAll('-','')}`;await client.query(`SAVEPOINT ${frame}`);
  try{const result=await action(driver);if(pending){open=false;await queue;throw new Error('Source projection callback must await every storage operation');}await source();if(canonical)await canonical.account.assert(client,claim,job,options.policyDigest);await client.query(`RELEASE SAVEPOINT ${frame}`);return result;}
  catch(error){open=false;await queue;await client.query(`ROLLBACK TO SAVEPOINT ${frame}`);await client.query(`RELEASE SAVEPOINT ${frame}`);throw error;}
  finally{open=false;await queue;}
}
