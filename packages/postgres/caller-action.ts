import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import type {WorkClaim} from '../core/store.js';
import type {AgentActionResult} from '../core/agent-program.js';
import {templatePlanning} from '../ontology/planning-contract.js';
import {checkRequirements} from '../ontology/requirement-checks.js';
import {assessConditionsProgram,hardConditionsPass} from '../coordinator/conditions.js';
import {digest} from '../core/delegation.js';
import {DomainError,ownerKey,type Job,type Principal} from '../core/domain.js';
import {assertAgentDecisionOrigin,matchesAgentGrant} from '../core/agent-authorization.js';
import type {PlanGrant} from '../ontology/actions.js';
import {DynamicOntologyProgram} from '../capabilities/dynamic-ontology.js';
import {objectRefSchema,type ObjectRef} from '../ontology/model.js';
import {graphRead,runGraphProgramAsync,type GraphStorage,type ProjectionMetadata} from '../ontology/graph-program.js';
import {readOntologyRequestProgram} from '../ontology/execution-projection.js';
import {isPersonalAction} from '../ontology/personal-context.js';
import type {ManagedObjectBatch,LinkWrite,ObjectSource} from '../ontology/object-store.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {combineEnvelopes,type SecurityEnvelope} from '../security/envelope.js';
import {storedSourceSchema} from '../security/source-policy.js';
import {submissionDigest} from '../security/submission-digest.js';
import {SecurityError} from '../security/errors.js';
import {postgresConsentIndex} from './consent.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresConstrainReadDeadline,postgresBusinessAuthorityDigest,postgresRequireLeaseAtCommit} from './runtime-transaction.js';
import {postgresOntologyRelease} from './ontology-release.js';
import {postgresTaskResourcePermissionValidUntil,type PostgresTaskReadAdmission} from './task-read-access.js';
import {withPostgresTaskProcessAuthorization,withPostgresCallerEvidenceAuthorization,type PostgresTaskReadAuthorization} from './task-output.js';
import {withPostgresPlanningReadGraph,postgresPlanningAccessDigest} from './planning-read-graph.js';
import {PostgresProjectionGraph} from './projection-graph.js';
import {PostgresTaskStorage} from './task-storage.js';
import {postgresWorkReference,postgresClaimSnapshotMatches,type PostgresWorkReference} from './work-claim.js';
import type {PostgresDatabase} from './database.js';
import {PostgresActionJournal} from './action-journal.js';
import {createPostgresCallerActionAuthorization} from './action-authorization.js';
import {withPostgresCallerSourceProjection} from './source-projection.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import {postgresPrepareWorkerSeal,postgresRecordWorkerOutputs} from './worker-output.js';
import {postgresRecordClaimRelease} from './claim-release.js';

type CallerActor={principal:Principal}|{claim:PostgresWorkReference;inspectClaim:(claim:PostgresWorkReference)=>Promise<{validUntil:number}|undefined>};
export interface PostgresCallerActionGraph extends GraphStorage,ProjectionMetadata {accessDigest():Promise<string>;evidence():SecurityEnvelope|undefined}
export interface PostgresCallerActionOptions {policyDigest:string;builder?:StagedKernelBuilder}
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
function deny(reason:ConstructorParameters<typeof SecurityError>[0]='AUTHORIZATION_REQUIRED'):never{throw new SecurityError(reason);}

/** Exact persisted caller envelope, under the actual release implementation.
 * A caller template cannot be used to select a provider/model program. */
export function assertPostgresCallerAction(program:DynamicOntologyProgram,job:Job,owner:string){
  const d=job.delegation,envelope=d?.callerAction,state=d?.agent;
  if(!d||!envelope||!isPersonalAction(envelope.action)||!same(envelope.ontologyRelease,d.ontologyRelease)||!same(envelope.programRef,program.ref)
    ||envelope.ownerDigest!==digest(owner)||envelope.inputDigest!==digest(envelope.input)||!d.request.messages.some(message=>message.id===envelope.requestId)
    ||!program.permitted(owner))deny('POLICY_CHANGED');
  if(state){
    const completed=job.state==='completed'&&d.acceptance?.accepted&&d.outcome?.status==='satisfied'&&d.outcome.requestRevision===d.request.revision?state.callerCompletion:undefined;
    const plan=state.plans.find(value=>state.pendingPlanId?value.id===state.pendingPlanId:completed?.planDigest===value.digest);
    if(state.composition||state.programDigest!==program.configurationDigest||!same(state.programRef,program.ref)||!plan?.callerDecision)deny('POLICY_CHANGED');
    assertAgentDecisionOrigin(program,job,owner,plan);
  }
}

/** Shared real role/source/output admission for preparation and execution.
 * It neither creates a plan grant nor admits any business mutation. */
export async function postgresCallerActionAuthority(client:Client,principal:Principal,admission:PostgresTaskReadAdmission,
  job:Job,program:DynamicOntologyProgram,options:PostgresCallerActionOptions,batch?:ManagedObjectBatch){
  const envelope=job.delegation?.callerAction??deny(),q=`"${postgresBusinessSchema(client)}"`,now=Date.now();
  assertPostgresCallerAction(program,job,ownerKey(principal));
  if(admission.grant.taskId!==job.id||admission.grant.requestRevision!==job.delegation!.request.revision||!admission.grant.operations.includes('task.process')
    ||!admission.parent.capabilityIds.includes(program.ref.id))deny();
  let validUntil=admission.validUntil;
  for(const permission of ['resource.view','action.execute'] as const){
    const until=await postgresTaskResourcePermissionValidUntil(client,principal,job.id,options.policyDigest,'actionType',envelope.action,permission,options.builder);
    if(until<=Date.now())deny();validUntil=Math.min(validUntil,until);
  }
  const rows=await client.query(`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.security_sources WHERE owner=$1 AND installation_id=$2 AND state='active' LIMIT 257`,[ownerKey(principal),admission.actor.installationId]);
  if(rows.rows.length>256||rows.rows.some(row=>typeof row.body!=='string'))deny('SOURCE_NOT_AUTHORIZED');
  const choices=rows.rows.map(row=>{const source=storedSourceSchema.parse(JSON.parse(row.body));
    if(source.bindingId!==row.binding_id||source.programId!==row.program_id||source.installationId!==admission.actor.installationId)deny('SOURCE_NOT_AUTHORIZED');return source;
  }).filter(source=>source.programId===program.ref.id&&source.programDigest===program.configurationDigest&&source.operations.includes(envelope.action)
    &&source.parentGrant.id===admission.parent.id&&source.parentGrant.revision===admission.parent.revision
    &&admission.parent.sourceBindingIds.includes(source.bindingId)&&postgresConsentIndex(source.expiresAt,options.policyDigest)>now);
  if(choices.length!==1)deny('SOURCE_NOT_AUTHORIZED');const source=choices[0]!;
  validUntil=Math.min(validUntil,postgresConsentIndex(source.expiresAt,options.policyDigest));
  for(const type of new Set([...(batch?.objects??[]).map(object=>object.ref.type),...(batch?.tombstones??[]).map(target=>target.ref.type)])){
    const until=await postgresTaskResourcePermissionValidUntil(client,principal,job.id,options.policyDigest,'objectType',type,'resource.view',options.builder);
    if(until<=Date.now())deny();validUntil=Math.min(validUntil,until);
  }
  for(const object of batch?.objects??[]){
    const rule=admission.grant.outputs.find(rule=>rule.programId===source.programId&&rule.programDigest===source.programDigest&&rule.sourceBindingId===source.bindingId&&rule.type===object.ref.type);
    const fields=Object.keys(object.properties);
    if(!rule||!source.outputTypes.includes(object.ref.type)||fields.some(field=>!rule.fields.includes(field)||!admission.parent.resources.some(resource=>resource.type===object.ref.type&&resource.fields.includes(field))))deny('SOURCE_NOT_AUTHORIZED');
  }
  for(const target of batch?.tombstones??[])if(!admission.grant.outputs.some(rule=>rule.programId===source.programId&&rule.programDigest===source.programDigest&&rule.sourceBindingId===source.bindingId&&rule.type===target.ref.type))deny('SOURCE_NOT_AUTHORIZED');
  if(validUntil<=Date.now())deny('ACCESS_REVOKED');postgresConstrainReadDeadline(client,validUntil);
  return {source,validUntil};
}

/** Preparation/validation driver. Each logical read opens and closes a real
 * authorization snapshot. Rollback-only preview runs between those scopes;
 * no authorization row/value cache survives a tentative graph write. */
export async function withPostgresCallerActionGraph<T>(client:Client,actor:CallerActor,taskId:string,options:PostgresCallerActionOptions,
  action:(graph:PostgresCallerActionGraph,program:DynamicOntologyProgram,job:Job)=>Promise<T>):Promise<T>{
  const token=postgresBusinessToken(client),owner='principal'in actor?ownerKey(actor.principal):actor.claim.owner,q=`"${postgresBusinessSchema(client)}"`;
  const current=await new PostgresTaskStorage(client,options.builder).get(owner,taskId),pin=current.delegation?.ontologyRelease;
  if(!pin)deny('POLICY_CHANGED');const release=await postgresOntologyRelease(client,pin,options.builder),program=new DynamicOntologyProgram(release.model,release.ref,owner);
  assertPostgresCallerAction(program,current,owner);
  let open=true,serial=false;const influences=new Map<string,SecurityEnvelope>();
  const active=(selected=owner)=>{if(!open||selected!==owner||postgresBusinessToken(client)!==token)deny();};
  const authorize=<R>(callback:(auth:PostgresTaskReadAuthorization,admission:PostgresTaskReadAdmission,principal:Principal)=>Promise<R>)=>{
    active();return 'principal'in actor?withPostgresTaskProcessAuthorization(client,actor.principal,taskId,options.policyDigest,(auth,admission)=>callback(auth,admission,actor.principal),options.builder)
      :withPostgresCallerEvidenceAuthorization(client,actor.claim,options.policyDigest,callback,options.builder,actor.inspectClaim);
  };
  const read=<R>(operation:(graph:Parameters<Parameters<typeof withPostgresPlanningReadGraph>[6]>[0])=>Promise<R>)=>authorize(async(auth,admission,principal)=>{
    await postgresCallerActionAuthority(client,principal,admission,current,program,options);
    return withPostgresPlanningReadGraph(client,principal,taskId,options.policyDigest,auth,admission,async graph=>{
      const result=await operation(graph),evidence=graph.evidence();
      if(evidence){const admitted=await auth.authorizeEvidence(evidence);influences.set(digest(admitted),admitted);
        await client.query(`INSERT INTO ${q}.security_reads(grant_id,digest,body) VALUES($1,$2,$3) ON CONFLICT(grant_id,digest) DO NOTHING`,[admission.grant.id,digest(admitted),JSON.stringify(admitted)]);}
      active();return result;
    },options.builder);
  });
  const links=async(edges:readonly LinkWrite[])=>authorize(async(auth,admission,principal)=>{
    for(const edge of edges){
      const until=await postgresTaskResourcePermissionValidUntil(client,principal,taskId,options.policyDigest,'linkType',edge.type,'resource.view',options.builder);
      if(until<=Date.now())deny();postgresConstrainReadDeadline(client,until);
      for(const ref of [edge.from,edge.to]){const definition=release.model.object(ref.type),evidence=(await auth.readObject(ref,[...new Set([definition.primaryKey,definition.titleKey])])).envelope;influences.set(digest(evidence),evidence);await client.query(`INSERT INTO ${q}.security_reads(grant_id,digest,body) VALUES($1,$2,$3) ON CONFLICT(grant_id,digest) DO NOTHING`,[admission.grant.id,digest(evidence),JSON.stringify(evidence)]);}
    }
  });
  const storage:PostgresCallerActionGraph={model:release.model,releaseRef:release.ref,now:Date.now,security:true,
    read:(selected,ref,budget)=>{active(selected);return read(graph=>graph.read(selected,ref,budget));},
    query:(selected,query,budget,scope)=>{active(selected);return read(graph=>graph.query(selected,query,budget,scope));},
    related:(selected,ref,link,budget)=>{active(selected);return read(graph=>graph.related(selected,ref,link,budget));},
    relationshipDigest:(selected,ref,budget)=>{active(selected);return read(graph=>graph.relationshipDigest(selected,ref,budget));},
    async managedObject(selected,input){active(selected);const ref=objectRefSchema.parse(input);
      if(release.model.objectWritePolicy(ref.type)!=='managed')deny();
      await authorize(async(_auth,_admission,principal)=>{const until=await postgresTaskResourcePermissionValidUntil(client,principal,taskId,options.policyDigest,'objectType',ref.type,'resource.view',options.builder);if(until<=Date.now())deny();postgresConstrainReadDeadline(client,until);});
      const exists=await client.query(`SELECT 1 FROM ${q}.ontology_objects WHERE owner=$1 AND type=$2 AND id=$3 LIMIT 1`,[owner,ref.type,ref.id]);
      if(!exists.rowCount)return undefined;return read(graph=>graph.read(owner,ref));
    },
    async tombstone(selected,ref){active(selected);await authorize(async(_auth,_admission,principal)=>{const until=await postgresTaskResourcePermissionValidUntil(client,principal,taskId,options.policyDigest,'objectType',ref.type,'resource.view',options.builder);if(until<=Date.now())deny();postgresConstrainReadDeadline(client,until);});return read(graph=>graph.tombstone(selected,ref));},
    async containsLinks(selected,edges){active(selected);await links(edges);return (await PostgresProjectionGraph.create(client,owner,pin,options.builder,{readOnly:true})).containsLinks(owner,[...edges]);},
    async previewManaged(selected,batch,source){
      active(selected);if(serial)throw new DomainError('CONFLICT','Caller preview cannot run concurrently');serial=true;
      try{
        await authorize(async(auth,admission,principal)=>{
          await postgresCallerActionAuthority(client,principal,admission,current,program,options,batch);
          for(const object of batch.objects)if(!(batch.creates??[]).some(ref=>same(ref,object.ref)))await auth.readObject(object.ref);
          for(const edge of [...(batch.links??[]),...(batch.removeLinks??[])]){
            const until=await postgresTaskResourcePermissionValidUntil(client,principal,taskId,options.policyDigest,'linkType',edge.type,'resource.view',options.builder);if(until<=Date.now())deny();postgresConstrainReadDeadline(client,until);
            for(const ref of [edge.from,edge.to])if(!(batch.creates??[]).some(created=>same(created,ref)))await auth.readObject(ref);
          }
        });
        const graph=await PostgresProjectionGraph.create(client,owner,pin,options.builder);await graph.previewManaged(owner,batch,source);
        await authorize(async(_auth,admission,principal)=>{await postgresCallerActionAuthority(client,principal,admission,current,program,options,batch);});active();
      }finally{serial=false;}
    },
    ingest(){deny();},readPrivate(){deny();},evidencePropertiesDigest(){deny();},applyManaged(){deny();},managedDispatchCheck(){deny();},
    async accessDigest(){return authorize(async(_auth,admission)=>postgresPlanningAccessDigest(admission,'task.process'));},
    evidence(){active();return influences.size?combineEnvelopes([...influences.values()]):undefined;},
  };
  // Seal the original submitted request under its actual recipient. This is
  // read influence, never a business output or a model receipt.
  await authorize(async(auth,admission)=>{
    const root=await auth.readTaskRoot(),envelope=combineEnvelopes([root.envelope,{...root.envelope,classification:'sensitive',requiredMarkings:['member_private','personal_data']}]);
    envelope.submission={taskId,requestRevision:current.delegation!.request.revision,contentDigest:submissionDigest(current.delegation!.request)};
    const admitted=await auth.authorizeEvidence(envelope);influences.set(digest(admitted),admitted);
    await client.query(`INSERT INTO ${q}.security_reads(grant_id,digest,body) VALUES($1,$2,$3) ON CONFLICT(grant_id,digest) DO NOTHING`,[admission.grant.id,digest(admitted),JSON.stringify(admitted)]);
  });
  try{return await action(Object.freeze(storage),program,current);}finally{open=false;influences.clear();}
}

/** Actual registered declarative semantics for the journal. These programs
 * have no executor and accept no synthetic ALLOWED/verifier callback. */
export function createPostgresCallerActionPolicy(program:DynamicOntologyProgram):import('./action-authorization.js').PostgresActionProgramPolicy{
  function* context(value:import('./action-authorization.js').PostgresActionSemanticContext):import('../ontology/graph-program.js').GraphProgram<Parameters<DynamicOntologyProgram['authorityProgram']>[0]>{
    const {job,plan,step,intent}=value,state=job.delegation?.agent;
    assertPostgresCallerAction(program,job,value.owner);
    if(!state||!plan.callerDecision||state.composition||plan.steps.length!==1||step.effect!=='object_write'||!isPersonalAction(step.action)
      ||step.inputRefs.length||step.acceptedInputs?.length||step.additionalEffects?.length||step.cost||step.privateDigest!==undefined&&step.privateDigest!==digest({})
      ||intent.privateDigest!==digest({})||!same(value.input,step.input)||!same(plan.scope,state.scope))deny('POLICY_CHANGED');
    const request=yield* readOntologyRequestProgram(value.graph,value.owner,job.id);
    if(request.revision!==job.delegation!.request.revision||request.id!==job.id||state.requestRevision!==request.revision)deny('POLICY_CHANGED');
    const ctx={graph:value.graph,owner:value.owner,request,state,intents:[...value.intents]};
    if(digest((yield* graphRead(value.owner,state.scope)).properties)!==plan.scopeDigest)deny('POLICY_CHANGED');
    yield* program.assertContextProgram(ctx);return ctx;
  }
  return {program,
    validate:function*(value){
      const ctx=yield* context(value);yield* program.validatePlanningProgram(ctx,value.step.action,value.input,value.plan.ontologyPlanning);
      const authority=yield* program.authorityProgram(ctx,value.step.action,value.input);
      if(!same(authority.objectWrite,value.step.objectWrite)||value.validUntil<=value.graph.now())deny('POLICY_CHANGED');
      return {privateDigest:digest({}),validUntil:value.validUntil,authority};
    },
    verifyObservation:function*(value,attempt,response){
      const ctx=yield* context(value);
      if(attempt.kind!=='dispatch'||attempt.intentId!==value.intent.id||attempt.planDigest!==value.plan.digest||attempt.requestRevision!==(value.job.revision??0)
        ||attempt.inputDigest!==digest(value.input)||response.runEvidence||response.pending||response.paPayment||response.observation||response.waitUntil)deny('SOURCE_NOT_AUTHORIZED');
      const expected=yield* program.invokeProgram({...ctx,planId:value.plan.id,intentId:value.intent.id,attemptId:attempt.id,callerRequestId:value.plan.callerDecision!.requestId,operationKey:value.intent.businessOperationKey},value.step.action,value.input,new AbortController().signal);
      if(!same(expected,response))deny('SOURCE_NOT_AUTHORIZED');
    },
  };
}

interface CallerExecutionOptions extends PostgresCallerActionOptions {database:Pick<PostgresDatabase,'run'|'inspectClaim'>;maxTaskMs?:number}
/** One original caller frontier. It performs no model/provider I/O and never
 * replays an interrupted dispatch. The journal owns acceptance, then a fresh
 * readback transaction owns completion of that same task. */
export class PostgresCallerActionExecution {
  private readonly maximum:number;
  constructor(private readonly options:CallerExecutionOptions){this.maximum=options.maxTaskMs??86400000;if(!Number.isSafeInteger(this.maximum)||this.maximum<1||this.maximum>86400000)throw new Error('Invalid original caller deadline');}
  private inspect=(claim:PostgresWorkReference)=>this.options.database.inspectClaim(claim,this.options.policyDigest);
  private async journal(client:Client,claim:PostgresWorkReference,proof?:{attemptId:string;response:AgentActionResult}){
    const job=await new PostgresTaskStorage(client,this.options.builder).get(claim.owner,claim.job.id),pin=job.delegation?.ontologyRelease;if(!pin)deny('POLICY_CHANGED');
    const release=await postgresOntologyRelease(client,pin,this.options.builder),program=new DynamicOntologyProgram(release.model,release.ref,claim.owner);assertPostgresCallerAction(program,job,claim.owner);
    const options={policyDigest:this.options.policyDigest,inspectClaim:this.inspect,builder:this.options.builder,maxTaskMs:this.maximum,programs:[createPostgresCallerActionPolicy(program)],...(proof?{observation:proof}:{})};
    return {journal:new PostgresActionJournal(client,{...options,authorize:createPostgresCallerActionAuthorization(client,options)}),program,job};
  }
  private select(job:Job){
    const state=job.delegation?.agent,plan=state?.plans.find(value=>value.id===state.pendingPlanId),step=plan?.steps[0];
    if(job.state!=='working'||!state||!plan?.callerDecision||plan.steps.length!==1||!step||step.effect!=='object_write'||!isPersonalAction(step.action))throw new DomainError('CONFLICT','No original caller frontier');
    return {state,plan,step};
  }
  async run(input:WorkClaim,signal:AbortSignal):Promise<void>{
    signal.throwIfAborted();const claim=postgresWorkReference(input);
    const prepared=await this.options.database.run(async client=>{
      const {journal,job}=await this.journal(client,claim),{plan,step}=this.select(job),intent=await journal.intent(claim.owner,step.intentId);
      if(intent.state==='effect_confirmed')return undefined;
      if(intent.state!=='ready')throw new SecurityError('AUTHORITY_UNAVAILABLE','The original dispatched caller operation requires reconciliation; automatic replay is prohibited');
      const q=`"${postgresBusinessSchema(client)}"`,rows=await client.query(`SELECT id,CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.plan_grants WHERE owner=$1 AND job_id=$2 LIMIT 257`,[claim.owner,job.id]);
      if(rows.rows.length>256||rows.rows.some(row=>typeof row.body!=='string'))deny();
      const grant=rows.rows.map(row=>{const grant=JSON.parse(row.body) as PlanGrant;if(grant.id!==row.id||grant.owner!==claim.owner||grant.jobId!==job.id)deny('POLICY_CHANGED');return grant;}).find(grant=>matchesAgentGrant(grant,plan,step));
      if(!grant)deny();
      const attempt=await journal.startAttempt(claim,intent.id,'dispatch',digest(step.input),undefined,undefined,grant.id);signal.throwIfAborted();
      const response=await withPostgresCallerActionGraph(client,{claim,inspectClaim:this.inspect},job.id,this.options,async(graph,program,current)=>{
        const state=current.delegation!.agent!,request=await runGraphProgramAsync(graph,readOntologyRequestProgram(graph,claim.owner,job.id));
        return runGraphProgramAsync(graph,program.invokeProgram({graph,owner:claim.owner,request,state,intents:await new PostgresTaskStorage(client,this.options.builder).intents(claim.owner,job.id),planId:plan.id,intentId:intent.id,attemptId:attempt.id,callerRequestId:plan.callerDecision!.requestId,operationKey:intent.businessOperationKey},step.action,step.input,signal));
      });
      signal.throwIfAborted();return {response,attempt,intentId:intent.id,planId:plan.id,action:step.action,input:structuredClone(step.input)};
    });
    if(prepared){
      signal.throwIfAborted();const receipt=await this.options.database.run(async client=>{
        const {journal}=await this.journal(client,claim);return journal.recordObservation(claim.owner,prepared.intentId,prepared.attempt.id,{kind:'confirmed',eventId:prepared.attempt.id,sourceVersion:prepared.attempt.ordinal,output:{source:prepared.response.value},evidenceRefs:prepared.response.evidenceRefs});
      });
      signal.throwIfAborted();await this.options.database.run(async client=>{
        const {journal,program}=await this.journal(client,claim,{attemptId:prepared.attempt.id,response:prepared.response});
        await journal.commitObservation(prepared.intentId,receipt.id,true,{claim,apply:async(job,intent)=>{
          signal.throwIfAborted();await withPostgresCallerSourceProjection(client,claim,{policyDigest:this.options.policyDigest,programRef:program.ref,configurationDigest:program.configurationDigest,action:prepared.action,inspectClaim:this.inspect,builder:this.options.builder},
            {journal,planId:prepared.planId,intentId:intent.id,attemptId:prepared.attempt.id},async graph=>{
              const request=await runGraphProgramAsync(graph,readOntologyRequestProgram(graph,claim.owner,job.id)),state=job.delegation!.agent!;
              const object=await runGraphProgramAsync(graph,program.projectProgram({graph,owner:claim.owner,request,state,intents:await new PostgresTaskStorage(client,this.options.builder).intents(claim.owner,job.id),planId:prepared.planId,intentId:intent.id,attemptId:prepared.attempt.id,callerRequestId:job.delegation!.callerAction!.requestId,operationKey:intent.businessOperationKey},prepared.action,prepared.input,prepared.response));
              intent.acceptedOutput={object};if(!state.observations.some(value=>same(value,object)))state.observations.push(object);
              job.updatedAt=new Date().toISOString();job.delegation!.nextAt=0;job.delegation!.events.push({at:job.updatedAt,event:'agent_observation_projected',evidence:digest(object)});signal.throwIfAborted();
            });
        }});
      });
    }
    signal.throwIfAborted();await this.complete(claim,signal);
  }
  private async complete(claim:PostgresWorkReference,signal:AbortSignal){
    await this.options.database.run(async client=>{
      signal.throwIfAborted();if(!await this.inspect(claim)||!await postgresClaimSnapshotMatches(client,claim,this.options.policyDigest))deny('ACCESS_REVOKED');
      const store=new PostgresTaskStorage(client,this.options.builder),job=await store.get(claim.owner,claim.job.id),{state,plan}=this.select(job),intents=await store.intents(claim.owner,job.id),q=`"${postgresBusinessSchema(client)}"`;
      const deadline=Date.parse(job.createdAt)+this.maximum;if(!Number.isSafeInteger(deadline)||deadline<=Date.now())deny('ACCESS_REVOKED');postgresConstrainReadDeadline(client,deadline);
      const evaluated=await withPostgresCallerActionGraph(client,{claim,inspectClaim:this.inspect},job.id,this.options,async(graph,program)=>{
        assertAgentDecisionOrigin(program,job,claim.owner,plan);if(plan.steps.some(step=>intents.find(intent=>intent.id===step.intentId)?.state!=='effect_confirmed'))throw new DomainError('CONFLICT','Caller mutation has no confirmed original outcome');
        const request=await runGraphProgramAsync(graph,readOntologyRequestProgram(graph,claim.owner,job.id)),reads=templatePlanning(request,graph.model.ref,await graph.accessDigest()),proposal={intentIds:plan.steps.map(step=>step.intentId)},ctx={graph,owner:claim.owner,request,state,intents};
        const delivery=await runGraphProgramAsync(graph,program.completeProgram(ctx,proposal,reads)),capability=program.capability(),requirements=[...request.requirements,...(request.successCriteria??[])];
        const checks=checkRequirements({...request,requirements},delivery.facts,delivery.evidenceRefs,[...capability.predicates.map(predicate=>predicate.id),...(capability.outcomePredicates??[])],capability.locationSemantics);
        if(requirements.some(requirement=>requirement.strength==='hard'&&!checks.some(check=>check.requirementId===requirement.id&&check.result==='pass')))throw new DomainError('CONFLICT','A requested managed result remains unverified');
        const conditions=await runGraphProgramAsync(graph,assessConditionsProgram(graph,claim.owner,request,delivery.conditionSubject,'result'));
        if(!hardConditionsPass(conditions,'result'))throw new DomainError('CONFLICT','A required managed result remains unknown');
        return {delivery,checks,conditions,reads,proposal};
      });
      const seal=await postgresPrepareWorkerSeal(client,claim,this.options.policyDigest,this.options.builder,this.inspect);if(!seal)deny('OUTPUT_NOT_ALLOWED');
      const d=job.delegation!,at=new Date().toISOString();job.artifact=evaluated.delivery.artifact;job.state='completed';job.updatedAt=at;d.phase='accepted';d.conditionChecks=evaluated.conditions;delete state.pendingPlanId;
      state.callerCompletion={requestId:plan.callerDecision!.requestId,planDigest:plan.digest,intentIds:evaluated.proposal.intentIds,ontologyPlanning:evaluated.reads};
      d.acceptance={accepted:true,reason:'The authenticated caller action committed under its exact grant and independent managed-object readback passed',at,checks:evaluated.checks,evidenceRefs:evaluated.delivery.evidenceRefs};
      d.outcome={requestId:job.id,requestRevision:d.request.revision,status:'satisfied',assessedAt:at,reason:d.acceptance.reason,evidenceRefs:evaluated.delivery.evidenceRefs,evidenceLevel:evaluated.delivery.evidenceLevel??'unverified',criterionResults:[
        ...evaluated.checks.map(check=>({requirementId:check.requirementId,status:check.result==='pass'?'satisfied' as const:check.result==='fail'?'unsatisfied' as const:'unknown' as const,evidenceRefs:check.evidenceRefs})),
        ...evaluated.conditions.map(check=>({requirementId:check.conditionId,status:check.result==='pass'?'satisfied' as const:check.result==='fail'?'unsatisfied' as const:'unknown' as const,evidenceRefs:check.evidenceRefs.map(ref=>JSON.stringify(ref))})),
        {requirementId:'caller_action_contract',status:'satisfied',evidenceRefs:[plan.callerDecision!.envelopeDigest]},{requirementId:'independent_managed_readback',status:'satisfied',evidenceRefs:evaluated.delivery.evidenceRefs}]};
      d.events.push({at,event:'caller_managed_action_verified',evidence:plan.digest});job.messages.push({id:randomUUID(),role:'agent',text:evaluated.delivery.artifact.data.deliverable,at});signal.throwIfAborted();
      await store.save(claim.owner,job);await postgresRecordWorkerOutputs(client,claim.owner,job,seal);
      const headers=await client.query(`SELECT 1 FROM ${q}.work_claims c JOIN ${q}.runtime_work_claims r ON r.job_id=c.job_id AND r.token=c.token WHERE c.job_id=$1 AND c.token=$2 AND c.revision=$3 AND r.authority_digest=$4`,[job.id,claim.token,claim.job.revision??0,postgresBusinessAuthorityDigest(client)]);
      const current=await postgresWorkerAdmission(client,claim.owner,job.id,this.options.policyDigest);
      if(headers.rowCount!==1||current.authority.id!==claim.securityAuthorityId||current.authority.authEpoch!==claim.securityEpoch||current.policyRevision!==claim.securityPolicyRevision||!await this.inspect(claim))deny('ACCESS_REVOKED');
      postgresRequireLeaseAtCommit(client,digest(claim),()=>this.inspect(claim));signal.throwIfAborted();
      await postgresRecordClaimRelease(client,claim.owner,job.id,claim.token);await client.query(`DELETE FROM ${q}.runtime_work_claims WHERE job_id=$1 AND token=$2`,[job.id,claim.token]);signal.throwIfAborted();
    });
  }
}
