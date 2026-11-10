import {ownerKey,requireScope,submitSchema,replySchema,versionedReplySchema,resumeTaskSchema,remediationSchema,taskIdSchema,DomainError,type Principal,type Job} from '../core/domain.js';
import {z} from 'zod';
import {isPersonalAction,personalPreferenceKey,personalPreferenceRef,selfPersonRef} from '../ontology/personal-context.js';
import {ontologyIdSchema} from '../ontology/definition-contracts.js';
import {objectRefSchema} from '../ontology/model.js';
import {runGraphProgramAsync} from '../ontology/graph-program.js';
import {previewDeclarativeActionProgram} from '../ontology/declarative-actions.js';
import {templatePlanning} from '../ontology/planning-contract.js';
import {agentPlanAuthorization,assertAgentDecisionOrigin,createAgentObjectWriteGrant} from '../core/agent-authorization.js';
import {type ActionIntent,objectWriteScopeSchema} from '../ontology/actions.js';
import type {AgentActionPlan,AgentDecision,AgentExecutionState} from '../ontology/agent-actions.js';
import {initialExecutionBudget} from '../core/execution-budget.js';
import {withPostgresCallerActionGraph} from './caller-action.js';
import {postgresRecordWorkerOutputs} from './worker-output.js';
import {SecurityError} from '../security/errors.js';
import {paPaymentRouteSchema,paPaymentReportSchema,recordPAPaymentSelection,verifyPAPaymentRequest,paymentRouteQuestion,type PAPaymentState} from '../core/pa-payment.js';
import {withPostgresTaskProcessAuthorization} from './task-output.js';
import {postgresTaskReadHistory} from './task-lineage.js';
import {combineEnvelopes} from '../security/envelope.js';
import {submissionDigest} from '../security/submission-digest.js';
import {prepareObservationSchema} from '../ontology/observation-contract.js';
import {preparePostgresObservationContract,revokePostgresObservationContract,type PostgresObservationOptions} from './observation-contract.js';
import {runRecoveryProgramAsync,reconcileTransition,revokeAuthorizationTransition} from '../core/recovery-commands.js';
import {runReplyProgramAsync,replyTransition,assertReplyTaskContext} from '../core/reply-program.js';
import {assertTechnicalResume,assertTechnicalResumeState,applyTechnicalResume} from '../core/technical-resume.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import {digest,actionOperationKey} from '../core/delegation.js';
import {createSubmittedTask} from '../core/task-submission.js';
import {selectPersonalContextProgram} from '../core/personal-context.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import type {TaskView} from '../security/task-service.js';
import {PostgresTaskReadService} from './task-read-service.js';
import type {PostgresDatabase} from './database.js';
import {postgresBusinessSchema,postgresConstrainReadDeadline} from './runtime-transaction.js';
import {withPostgresAgentWrite,postgresTaskProcessingGrant,postgresTaskReceiptGrant} from './task-read-access.js';
import {postgresTaskView} from './task-view.js';
import {postgresOntologyReadContext} from './ontology-release.js';
import {PostgresTaskStorage} from './task-storage.js';
import {postgresProvisionTask} from './task-grants.js';
import {postgresPersonalInputs} from './task-personal.js';
import {PostgresProjectionGraph} from './projection-graph.js';
import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import {BACKEND_VERSION,type Ref,type ServiceRequest} from '../ontology/execution.js';

export interface PostgresTaskCommandOptions{
  /** Current configured program preparation only; no model/provider I/O. */
  prepareRequest?:(client:Client,owner:string,job:Job,program:Ref,request:ServiceRequest)=>ServiceRequest|Promise<ServiceRequest>;
  assertProgram?:(client:Client,owner:string,job:Job,program:Ref)=>void|Promise<void>;
  allowSandboxActions?:boolean;
  /** Exact configured original-source semantic ports. They do no provider or
   * model I/O and must retain the original operation/readback identity. A
   * missing port never schedules an unexecutable substitute task. */
  validatePaymentRoute?:(client:Client,principal:Principal,job:Job,payment:PAPaymentState)=>Promise<void>;
  assertPaymentReadback?:(client:Client,principal:Principal,job:Job,payment:PAPaymentState)=>Promise<void>;
  prepareRemediation?:(client:Client,principal:Principal,original:Job,input:ReturnType<typeof remediationSchema.parse>)=>Promise<Job>;
  resolveObservationProgram?:PostgresObservationOptions['resolveProgram'];
}

/** Async task commands. This class owns no model, provider or polling loop. */
export class PostgresTaskCommandService extends PostgresTaskReadService {
  private commandStopping=false;
  constructor(private readonly db:Pick<PostgresDatabase,'run'|'read'>,private readonly policy:string,private readonly kernel?:StagedKernelBuilder,
    private readonly options:PostgresTaskCommandOptions={}){super(db,policy,kernel);}
  private async view(client:Client,p:Principal,job:Job):Promise<TaskView>{
    const admission=await postgresTaskReceiptGrant(client,p,job.id,this.policy);postgresConstrainReadDeadline(client,admission.validUntil);
    if(p.scopes.includes('tasks:read')&&admission.grant.operations.includes('task.result.read'))return postgresTaskView(client,p,job.id,this.policy,this.kernel);
    return {view:'eigos.task.v2',id:job.id,contextId:job.contextId,service:job.service,state:job.state,revision:job.revision,authorityId:job.authorityId,
      goal:'',messages:[],createdAt:job.createdAt,updatedAt:job.updatedAt,outputStatus:'receipt_only'};
  }
  private processSeal(client:Client,p:Principal,job:Job){
    return withPostgresTaskProcessAuthorization(client,p,job.id,this.policy,async(auth)=>{
      const root=await auth.readTaskRoot(),history=await postgresTaskReadHistory(client,ownerKey(p),job.id,job.delegation!.request.revision),envelope=combineEnvelopes([root.envelope,...history]);
      envelope.submission={taskId:job.id,requestRevision:job.delegation!.request.revision,contentDigest:submissionDigest(job.delegation!.request)};
      return auth.authorizeEvidence(envelope);
    },this.kernel);
  }
  /** Authenticated caller selection creates only an authorization preview.
   * No claim, execution permit or completed observation exists at this point. */
  async prepareOntologyAction(principal:Principal,input:unknown):Promise<Job>{
    const p=structuredClone(principal);requireScope(p,'tasks:write');requireScope(p,'ontology:read');
    const action=z.object({action:z.string()}).passthrough().parse(input).action;
    if(!isPersonalAction(action))throw new DomainError('FORBIDDEN','Foundation caller-managed preparation is limited to reviewed personal actions');
    const args=z.strictObject({ontologyId:ontologyIdSchema.default('eigos.business'),action:z.string().min(1).max(80),input:z.record(z.string(),z.unknown()),requestId:z.string().min(1).max(128)}).parse(input);
    if(Buffer.byteLength(JSON.stringify(args.input))>16000)throw new DomainError('INVALID_INPUT','Managed action input exceeds its bounded request size');
    if(this.commandStopping)throw new DomainError('CONFLICT','Gateway is shutting down');
    return this.db.run(client=>withPostgresAgentWrite(client,p,this.policy,async admission=>{
      const owner=ownerKey(p),store=new PostgresTaskStorage(client,this.kernel),q=`"${postgresBusinessSchema(client)}"`;
      const job=await store.once(owner,admission.actor.installationId,'ontology_action_prepare',args.requestId,JSON.stringify(args),async()=>{
        const release=await postgresOntologyReadContext(client,owner,{ontologyId:args.ontologyId},p.scopes.includes('ontology:admin'),this.kernel);
        const selected=structuredClone(args.input),key=args.action==='BindSelfPerson'?undefined:personalPreferenceKey.parse(selected.key);
        const derived=args.action==='BindSelfPerson'?{personId:selfPersonRef(owner).id}:{person:selfPersonRef(owner),...(args.action==='CreatePersonalPreference'?{preferenceId:personalPreferenceRef(owner,key!).id}:{preference:personalPreferenceRef(owner,key!)})};
        for(const [name,value]of Object.entries(derived)){if(Object.hasOwn(selected,name)&&digest(selected[name])!==digest(value))throw new DomainError('FORBIDDEN','Personal action cannot select another service subject');selected[name]=value;}
        const at=new Date().toISOString(),id=randomUUID(),goal=`执行已发布的数据动作 ${args.action}`,programRef={id:`ontology.managed.${release.ref.ontologyId}`,version:release.ref.digest};
        const callerAction={version:'1' as const,requestId:args.requestId,ownerDigest:digest(owner),ontologyRelease:release.ref,programRef,action:args.action,input:selected,inputDigest:digest(selected)};
        let created=await store.save(owner,{id,contextId:randomUUID(),service:'eigos.delegate',goal,state:'auth-required',revision:1,executionMode:'worker',runs:[],
          messages:[{id:args.requestId,role:'user',text:goal,at}],createdAt:at,updatedAt:at,
          delegation:{backendVersion:BACKEND_VERSION,ontologyRelease:release.ref,callerAction,ontologyReadScope:'request',request:{id,revision:1,originalGoal:goal,executionEnvironment:'live',requirements:[],messages:[{id:args.requestId,text:goal,receivedAt:at}]},
            executionBudget:initialExecutionBudget(at),phase:'awaiting_authorization',events:[{at,event:'caller_managed_action_requested',evidence:digest(callerAction)}]}});
        const inputs=args.action==='BindSelfPerson'?[]:await postgresPersonalInputs(client,p,created,this.policy,this.kernel);
        await postgresProvisionTask(client,p,created,this.policy,inputs,{builder:this.kernel});
        const prepared=await withPostgresCallerActionGraph(client,{principal:p},id,{policyDigest:this.policy,builder:this.kernel},async(graph,program)=>{
          const parsed=program.schema(args.action).parse(selected);if(digest(parsed)!==digest(selected))throw new DomainError('INVALID_INPUT','Action inputs cannot be silently normalized');
          const definition=program.definition(graph,args.action),objects=Object.keys(definition.inputs).map(name=>objectRefSchema.parse(selected[name]));
          const initialized=await runGraphProgramAsync(graph,program.initializeProgram(graph,owner,created.delegation!.request,{actionIds:[args.action],objects}));
          const state:AgentExecutionState={version:'1',programRef:program.ref,programDigest:program.configurationDigest,...initialized,requestRevision:1,plans:[],observations:[],feedback:[]};
          const ctx={graph,owner,request:created.delegation!.request,state,intents:[]};
          const authority=await runGraphProgramAsync(graph,program.authorityProgram(ctx,args.action,selected));
          if(!authority.objectWrite)throw new DomainError('FORBIDDEN','Declarative action did not produce an exact nonfinancial scope');
          const intentId=randomUUID(),decision:AgentDecision={kind:'execute',requestRevision:1,message:'Authenticated caller selected this exact published managed action and arguments',steps:[{id:'managedAction',action:args.action,argumentsJson:JSON.stringify(selected),dependsOn:[],inputRefs:[]}],completionJson:''};
          const body:Omit<AgentActionPlan,'digest'>={id:randomUUID(),version:'2',sequence:1,requestId:id,requestRevision:1,programRef:program.ref,programDigest:program.configurationDigest,
            scope:state.scope,scopeDigest:digest((await graph.read(owner,state.scope)).properties),callerDecision:{requestId:args.requestId,envelopeDigest:digest(callerAction),decision},reasoning:decision.message,createdAt:at,
            steps:[{...decision.steps[0]!,definitionDigest:digest(definition),input:structuredClone(selected),intentId,operationKey:actionOperationKey(owner,id,`caller:${args.requestId}`),effect:'object_write',objectWrite:authority.objectWrite}],
            ontologyPlanning:templatePlanning(created.delegation!.request,graph.model.ref,await graph.accessDigest())};
          const plan:AgentActionPlan={...body,digest:digest(body)};state.plans=[plan];state.pendingPlanId=plan.id;created.delegation!.agent=state;
          assertAgentDecisionOrigin(program,created,owner,plan);
          const step=plan.steps[0]!,intent:ActionIntent={id:intentId,owner,jobId:id,stepId:step.id,businessOperationKey:step.operationKey,planDigest:plan.digest,bindingRef:program.ref,inputDigest:digest({input:step.input,inputRefs:[]}),privateDigest:digest({}),privateData:{},effect:'object_write',state:'ready',nextAt:0,createdAt:at};
          return {plan,intent,evidence:graph.evidence()};
        });
        created.delegation!.authorizationRequest=agentPlanAuthorization(prepared.plan);created.question='数据变更已预览；请审查准确目标、字段及版本后授权提交。';
        created=await store.save(owner,created);
        const {privateData,...intentBody}=prepared.intent;
        const inserted=await client.query(`INSERT INTO ${q}.action_intents(id,owner,job_id,business_key,state,private_data,body) VALUES($1,$2,$3,$4,'ready',$5,$6) ON CONFLICT(owner,business_key) DO NOTHING RETURNING id`,
          [prepared.intent.id,owner,id,prepared.intent.businessOperationKey,JSON.stringify(privateData),JSON.stringify(intentBody)]);
        if(inserted.rowCount!==1)throw new DomainError('CONFLICT','Original caller operation already exists');
        created=await store.save(owner,created);if(prepared.evidence)await postgresRecordWorkerOutputs(client,owner,created,prepared.evidence);
        return created;
      });
      return this.view(client,p,job);
    }));
  }
  /** Current safe preview for the DefinitionService. It is recomputed through
   * the PA process/field/source/recipient boundary, never copied from raw JSON. */
  async callerActionPreview(principal:Principal,taskId:string){
    const p=structuredClone(principal),id=taskIdSchema.parse(taskId);
    return this.db.run(client=>withPostgresCallerActionGraph(client,{principal:p},id,{policyDigest:this.policy,builder:this.kernel},async(graph,program,job)=>{
      const state=job.delegation?.agent,plan=state?.plans.find(value=>state.pendingPlanId?value.id===state.pendingPlanId:job.state==='completed'&&state.callerCompletion?.planDigest===value.digest),step=plan?.steps[0];
      if(!['auth-required','completed'].includes(job.state)||!state||!plan||plan.steps.length!==1||!step?.objectWrite)throw new DomainError('CONFLICT','No current caller preview');
      assertAgentDecisionOrigin(program,job,ownerKey(p),plan);
      if(job.state==='completed'){
        const intents=await new PostgresTaskStorage(client,this.kernel).intents(ownerKey(p),id),completion=state.callerCompletion;
        if(!completion||!job.delegation!.acceptance?.accepted||job.delegation!.outcome?.status!=='satisfied'||job.delegation!.outcome.requestRevision!==job.delegation!.request.revision)throw new SecurityError('AUTHORITY_UNAVAILABLE','The original caller completion has no current verified readback');
        await runGraphProgramAsync(graph,program.completeProgram({graph,owner:ownerKey(p),request:job.delegation!.request,state,intents},{intentIds:completion.intentIds},templatePlanning(job.delegation!.request,graph.model.ref,await graph.accessDigest())));
        await this.processSeal(client,p,job);
        const result=intents.find(intent=>intent.id===step.intentId&&intent.state==='effect_confirmed')?.lastVerifiedResult?.output?.source;
        const preview=z.object({preview:z.object({digest:z.string(),scope:objectWriteScopeSchema,objects:z.array(z.unknown()),links:z.array(z.unknown()),result:objectRefSchema.optional()}).passthrough()}).parse(result).preview;
        if(preview.digest!==step.objectWrite.previewDigest||digest(preview.scope)!==digest(step.objectWrite))throw new DomainError('CONFLICT','Committed caller preview differs from its original exact scope');
        return {...preview,status:'committed' as const,planDigest:plan.digest};
      }
      const preview=await runGraphProgramAsync(graph,previewDeclarativeActionProgram(graph,ownerKey(p),step.action,step.input));
      if(digest(preview.scope)!==digest(step.objectWrite))throw new DomainError('CONFLICT','Managed targets changed after preparation');
      return {...preview,status:'prepared' as const,planDigest:plan.digest};
    }));
  }
  async authorize(principal:Principal,taskId:string,input:unknown,expectedContextId?:string):Promise<Job>{
    const p=structuredClone(principal),id=taskIdSchema.parse(taskId),owner=ownerKey(p);requireScope(p,'tasks:write');
    const selected=z.object({action:z.string(),requestId:z.string().min(1).max(128)}).passthrough().parse(input);
    if(selected.action==='approve_external_draft')throw new DomainError('FORBIDDEN','This operation needs a reviewed foundation authorization contract');
    if(selected.action!=='approve_object_write')throw new SecurityError('AUTHORITY_UNAVAILABLE','The original configured PostgreSQL authorization adapter is not installed');
    requireScope(p,'ontology:object_write');
    const permit=z.strictObject({action:z.literal('approve_object_write'),requestId:z.string().min(1).max(128),planDigest:z.string().regex(/^[a-f0-9]{64}$/),objectWrite:objectWriteScopeSchema,expiresAt:z.iso.datetime({offset:true}),environment:z.literal('managed')}).parse(input);
    return this.db.run(client=>withPostgresAgentWrite(client,p,this.policy,async admission=>{
      const before=await postgresTaskProcessingGrant(client,p,id,this.policy),store=new PostgresTaskStorage(client,this.kernel);
      const result=await store.once(owner,admission.actor.installationId,`authorize:${id}`,permit.requestId,JSON.stringify(permit),async()=>{
        const checked=await withPostgresCallerActionGraph(client,{principal:p},id,{policyDigest:this.policy,builder:this.kernel},async(graph,program,job)=>{
          if(expectedContextId&&job.contextId!==expectedContextId)throw new DomainError('NOT_FOUND','Task not found in this context');
          const d=job.delegation,state=d?.agent,plan=state?.plans.find(value=>value.id===state.pendingPlanId),step=plan?.steps[0];
          if(job.service!=='eigos.delegate'||d?.backendVersion!==BACKEND_VERSION||job.state!=='auth-required'||!state||!plan||plan.steps.length!==1||!step?.objectWrite)throw new DomainError('CONFLICT','No pending caller authorization');
          if(!isPersonalAction(step.action))throw new DomainError('FORBIDDEN','Foundation write approval is limited to reviewed personal actions');
          assertAgentDecisionOrigin(program,job,owner,plan);
          const {digest:expected,...body}=plan;
          if(digest(body)!==expected||plan.digest!==permit.planDigest||plan.requestId!==id||plan.requestRevision!==d.request.revision
            ||state.requestRevision!==d.request.revision||plan.ontologyPlanning.accessDigest!==await graph.accessDigest()
            ||digest(plan.ontologyPlanning)!==digest(templatePlanning(d.request,graph.model.ref,await graph.accessDigest()))
            ||plan.scopeDigest!==digest((await graph.read(owner,state.scope)).properties))throw new DomainError('CONFLICT','Pinned caller plan or original authority changed');
          const ctx={graph,owner,request:d.request,state,intents:await store.intents(owner,id)},authority=await runGraphProgramAsync(graph,program.authorityProgram(ctx,step.action,step.input));
          await runGraphProgramAsync(graph,program.validatePlanningProgram(ctx,step.action,step.input,plan.ontologyPlanning));
          if(step.effect!=='object_write'||step.definitionDigest!==digest(program.definition(graph,step.action))||step.cost||step.additionalEffects?.length||step.inputRefs.length||step.acceptedInputs?.length
            ||digest(authority.objectWrite)!==digest(step.objectWrite)||digest(step.objectWrite)!==digest(permit.objectWrite))throw new DomainError('CONFLICT','Managed write preview changed before approval');
          const intent=await store.intent(owner,step.intentId);
          if(intent.state!=='ready'||intent.planDigest!==plan.digest||intent.jobId!==id||intent.stepId!==step.id)throw new DomainError('CONFLICT','The original caller operation is no longer awaiting approval');
          return {job,grant:createAgentObjectWriteGrant(owner,id,plan,permit),evidence:graph.evidence()};
        });
        const q=`"${postgresBusinessSchema(client)}"`;
        await client.query(`INSERT INTO ${q}.plan_grants(id,owner,job_id,body) VALUES($1,$2,$3,$4)`,[checked.grant.id,owner,id,JSON.stringify(checked.grant)]);
        const job=checked.job,d=job.delegation!;d.phase='executing';d.nextAt=0;job.updatedAt=new Date().toISOString();job.state='submitted';job.revision=(job.revision??0)+1;delete job.question;
        d.events.push({at:job.updatedAt,event:'agent_plan_authorized',evidence:checked.grant.planDigest});
        const saved=await store.save(owner,job);if(checked.evidence)await postgresRecordWorkerOutputs(client,owner,saved,checked.evidence);return saved;
      });
      const after=await postgresTaskProcessingGrant(client,p,id,this.policy);if(digest(before)!==digest(after))throw new SecurityError('POLICY_CHANGED');
      return this.view(client,p,result);
    }));
  }
  async selectPaymentRoute(principal:Principal,input:unknown,contextId?:string):Promise<Job>{
    const p=structuredClone(principal),args=paPaymentRouteSchema.parse(input),owner=ownerKey(p);requireScope(p,'tasks:write');
    return this.db.run(client=>withPostgresAgentWrite(client,p,this.policy,async admission=>{
      await postgresTaskProcessingGrant(client,p,args.taskId,this.policy);const store=new PostgresTaskStorage(client,this.kernel);
      const selected=await store.once(owner,admission.actor.installationId,`pa-route:${args.taskId}`,args.requestId,JSON.stringify(args),async()=>{
        const job=await store.get(owner,args.taskId);
        if(job.service!=='eigos.delegate'||job.delegation?.backendVersion!==BACKEND_VERSION||job.state!=='input-required'||job.delegation.phase!=='awaiting_pa_payment')throw new DomainError('CONFLICT','Payment route selection requires the original waiting task');
        if(contextId&&job.contextId!==contextId)throw new DomainError('INVALID_INPUT','Context does not match task');
        const payment=verifyPAPaymentRequest(job,owner);
        if(payment.request.version!=='2')throw new DomainError('FORBIDDEN','This payment handoff needs a reviewed foundation projection');
        if(payment.request.id!==args.handoffId||payment.request.digest!==args.handoffDigest)throw new DomainError('CONFLICT','Payment route must reference the exact original handoff');
        if(!this.options.allowSandboxActions||job.delegation.request.executionEnvironment!=='sandbox')throw new DomainError('FORBIDDEN','The original payment source is no longer enabled with the same configuration');
        if(!this.options.validatePaymentRoute)throw new SecurityError('AUTHORITY_UNAVAILABLE','The original PostgreSQL payment-route semantic adapter is not installed');
        await this.options.validatePaymentRoute(client,p,structuredClone(job),structuredClone(payment));const seal=await this.processSeal(client,p,job),selection=recordPAPaymentSelection(payment,args);
        job.updatedAt=selection.selectedAt;job.question=paymentRouteQuestion(payment);job.messages.push({id:randomUUID(),role:'agent',text:job.question,at:job.updatedAt});
        job.delegation.events.push({at:job.updatedAt,event:'pa_payment_route_selected',evidence:selection.digest});job.revision=(job.revision??0)+1;
        const saved=await store.save(owner,job);await postgresRecordWorkerOutputs(client,owner,saved,seal);return saved;
      });await postgresTaskProcessingGrant(client,p,args.taskId,this.policy);return this.view(client,p,selected);
    }));
  }
  async reportPayment(principal:Principal,input:unknown,contextId?:string):Promise<Job>{
    const p=structuredClone(principal),args=paPaymentReportSchema.parse(input),owner=ownerKey(p);requireScope(p,'tasks:write');
    return this.db.run(client=>withPostgresAgentWrite(client,p,this.policy,async admission=>{
      await postgresTaskProcessingGrant(client,p,args.taskId,this.policy);const store=new PostgresTaskStorage(client,this.kernel);
      const result=await store.once(owner,admission.actor.installationId,`pa-payment:${args.taskId}`,args.requestId,JSON.stringify(args),async()=>{
        const job=await store.get(owner,args.taskId);
        if(job.service!=='eigos.delegate'||job.delegation?.backendVersion!==BACKEND_VERSION)throw new DomainError('CONFLICT','No current PA payment task');
        if(contextId&&job.contextId!==contextId)throw new DomainError('INVALID_INPUT','Context does not match task');
        const payment=verifyPAPaymentRequest(job,owner);
        if(payment.request.version!=='2')throw new DomainError('FORBIDDEN','This payment handoff needs a reviewed foundation projection');
        if(payment.request.id!==args.handoffId||payment.request.digest!==args.handoffDigest)throw new DomainError('CONFLICT','Payment notification must reference the exact original handoff');
        if(['working','submitted','auth-required'].includes(job.state))throw new DomainError('CONFLICT','Original provider readback is running; read the task and retry this same notification later');
        if(payment.reports.length>=20)throw new DomainError('CONFLICT','Payment notification bound reached; query the original task');
        if(job.state!=='completed'){
          if(!this.options.assertPaymentReadback)throw new SecurityError('AUTHORITY_UNAVAILABLE','The original PostgreSQL provider readback adapter is not installed');
          await this.options.assertPaymentReadback(client,p,structuredClone(job),structuredClone(payment));
        }
        job.updatedAt=new Date().toISOString();payment.reports.push({id:args.requestId,outcome:args.outcome,receivedAt:job.updatedAt});
        job.delegation.events.push({at:job.updatedAt,event:'pa_payment_notification_received_unverified',evidence:args.requestId});
        // A PA report is never evidence that money moved. A completed original
        // task records this notification without reopening or relabeling it.
        if(job.state==='completed')return store.save(owner,job);
        payment.recoveryAttempts=0;payment.readbackSequence++;const terminal=['canceled','failed','rejected'].includes(job.state);
        payment.status=terminal?'withdrawn':'reported';job.delegation.ontologyReadScope=p.scopes.includes('tasks:read')?'owner':'request';
        job.delegation.recoveryPending=terminal;job.delegation.nextAt=0;if(!terminal){job.state='submitted';job.delegation.phase='planning';delete job.question;}
        job.revision=(job.revision??0)+1;return store.save(owner,job);
      });await postgresTaskProcessingGrant(client,p,args.taskId,this.policy);return this.view(client,p,result);
    }));
  }
  async requestRemediation(principal:Principal,input:unknown):Promise<Job>{
    const p=structuredClone(principal),args=remediationSchema.parse(input),owner=ownerKey(p);requireScope(p,'tasks:write');
    if(this.commandStopping)throw new DomainError('CONFLICT','Gateway is shutting down');
    return this.db.run(client=>withPostgresAgentWrite(client,p,this.policy,async admission=>{
      await postgresTaskProcessingGrant(client,p,args.originalTaskId,this.policy);const store=new PostgresTaskStorage(client,this.kernel);
      const result=await store.once(owner,admission.actor.installationId,`aftersales:${args.originalTaskId}`,args.requestId,JSON.stringify(args),async()=>{
        const original=await store.get(owner,args.originalTaskId),d=original.delegation;
        if(d?.backendVersion!==BACKEND_VERSION||!d.plan&&!d.agent?.composition)throw new DomainError('CONFLICT','Original task has no current owned business plan');
        const intents=await store.intents(owner,original.id),operation=intents.find(intent=>intent.effect==='order'&&intent.remoteRef)??intents.find(intent=>intent.remoteRef);
        if(!operation?.remoteRef||intents.some(intent=>!['read','local'].includes(intent.effect)&&['dispatching','awaiting_remote','effect_unknown','needs_review'].includes(intent.state)))throw new DomainError('CONFLICT','Reconcile the original operation before requesting after-sales');
        if(args.action==='refund'&&!intents.some(intent=>intent.remoteRef===operation.remoteRef&&intent.businessSnapshot?.value.payment==='paid'))throw new DomainError('CONFLICT','No verified original paid amount; reconcile payment first');
        if(!this.options.allowSandboxActions||d.request.executionEnvironment!=='sandbox')throw new DomainError('FORBIDDEN','Only configured sandbox business remediation is enabled');
        if(!this.options.prepareRemediation)throw new SecurityError('AUTHORITY_UNAVAILABLE','The original PostgreSQL sandbox remediation executor is not installed');
        const prepared=await this.options.prepareRemediation(client,p,original,args);
        if(prepared.contextId!==original.contextId||prepared.delegation?.backendVersion!==BACKEND_VERSION||prepared.delegation.request.outcome!==args.action||!prepared.delegation.afterSalesCaseId)throw new DomainError('CONFLICT','Remediation differs from the original bounded business operation');
        return prepared;
      });return this.view(client,p,result);
    }));
  }
  async prepareObservationContract(principal:Principal,input:unknown,contextId?:string):Promise<Job>{
    const p=structuredClone(principal),args=prepareObservationSchema.parse(input),owner=ownerKey(p);requireScope(p,'tasks:write');requireScope(p,'tasks:read');
    if(this.commandStopping)throw new DomainError('CONFLICT','Gateway is shutting down');
    return this.db.run(client=>withPostgresAgentWrite(client,p,this.policy,async admission=>{
      const store=new PostgresTaskStorage(client,this.kernel),job=await store.once(owner,admission.actor.installationId,'prepare_observation_contract',args.requestId,digest({args,contextId,installationId:admission.actor.installationId}),async()=>{
        const created=await preparePostgresObservationContract(client,p,args,contextId,{policyDigest:this.policy,builder:this.kernel,resolveProgram:this.options.resolveObservationProgram});
        await postgresProvisionTask(client,p,created,this.policy,[],{builder:this.kernel});return created;
      });return this.view(client,p,job);
    }));
  }
  async submit(principal:Principal,input:unknown,contextId?:string):Promise<Job>{
    const p=structuredClone(principal),args=submitSchema.parse(input);if(contextId)taskIdSchema.parse(contextId);
    if(args.service==='eigos.aftersales'){
      if(contextId)await this.db.run(client=>withPostgresAgentWrite(client,p,this.policy,async()=>{
        await postgresTaskProcessingGrant(client,p,args.originalTaskId,this.policy);
        if((await new PostgresTaskStorage(client,this.kernel).get(ownerKey(p),args.originalTaskId)).contextId!==contextId)throw new DomainError('INVALID_INPUT','Context does not match original task');
      }));
      const {service:_service,...remedy}=args;return this.requestRemediation(p,remedy);
    }
    if(this.commandStopping)throw new DomainError('CONFLICT','Gateway is shutting down');
    return this.db.run(client=>withPostgresAgentWrite(client,p,this.policy,async admission=>{
      const store=new PostgresTaskStorage(client,this.kernel),owner=ownerKey(p),q=`"${postgresBusinessSchema(client)}"`;
      const job=await store.once(owner,admission.actor.installationId,'submit',args.requestId,JSON.stringify([args,contextId]),async()=>{
        if(contextId){
          const contexts=await client.query(`SELECT j.id FROM ${q}.jobs j JOIN ${q}.security_grants g ON g.owner=j.owner
            AND ${q}.eigos_try_jsonb(g.body)->>'taskId'=j.id WHERE j.owner=$1 AND j.context_id=$2 AND g.installation_id=$3
            AND g.kind='task_data' AND g.state='active' AND g.expires_at>$4 LIMIT 257`,[owner,contextId,admission.actor.installationId,Date.now()]);
          if(contexts.rows.length>256)throw new DomainError('CONFLICT','Context exceeds its bounded admission check');
          let allowed=false;for(const row of contexts.rows){await postgresTaskProcessingGrant(client,p,String(row.id),this.policy);allowed=true;}
          if(!allowed)throw new DomainError('NOT_FOUND','Context not found');
        }
        const release=await postgresOntologyReadContext(client,owner,{ontologyId:args.ontologyId??'eigos.business'},p.scopes.includes('ontology:admin'),this.kernel);
        let created=await store.save(owner,createSubmittedTask(p,args,release.ref,contextId));
        const inputs=await postgresPersonalInputs(client,p,created,this.policy,this.kernel);
        await postgresProvisionTask(client,p,created,this.policy,inputs,{builder:this.kernel});
        if(created.delegation!.request.personalContext){
          const graph=await PostgresProjectionGraph.create(client,owner,release.ref,this.kernel);
          await graph.run(metadata=>selectPersonalContextProgram(metadata,owner,created.delegation!.request,created.delegation!.request.personalContext!));
          created=await store.save(owner,created);
        }
        return created;
      });
      return this.view(client,p,job);
    }));
  }
  async cancel(principal:Principal,taskId:string):Promise<Job>{
    const p=structuredClone(principal),id=taskIdSchema.parse(taskId);
    return this.db.run(client=>withPostgresAgentWrite(client,p,this.policy,async admission=>{
      const before=await postgresTaskProcessingGrant(client,p,id,this.policy),store=new PostgresTaskStorage(client,this.kernel);
      const job=await store.once(ownerKey(p),admission.actor.installationId,`cancel:${id}`,id,id,async()=>{
        const current=await store.get(ownerKey(p),id);
        if(current.service!=='eigos.delegate'||current.delegation?.backendVersion!==BACKEND_VERSION)throw new DomainError('CONFLICT','Historical backend tasks are read-only');
        if(['completed','failed','rejected'].includes(current.state))throw new DomainError('CONFLICT','Terminal tasks cannot be canceled');
        if(current.delegation.observationContract){
          await revokePostgresObservationContract(client,ownerKey(p),current.id,current.delegation.observationContract.digest);
          current.revision=(current.revision??1)+1;current.delegation.events.push({at:new Date().toISOString(),event:'observation_contract_revoked',evidence:current.delegation.observationContract.digest});
        }
        current.state='canceled';
        if(current.delegation.plan||current.delegation.agent){current.delegation.recoveryPending=await store.cancelActions(ownerKey(p),id);current.delegation.nextAt=0;}
        const payment=current.delegation.agent?.paPayment;if(payment){payment.status='withdrawn';payment.recoveryAttempts=0;current.delegation.recoveryPending=true;}
        current.delegation.phase='canceled';delete current.question;current.updatedAt=new Date().toISOString();
        current.messages.push({id:randomUUID(),role:'agent',text:'Task canceled.',at:current.updatedAt});return store.save(ownerKey(p),current);
      });
      const after=await postgresTaskProcessingGrant(client,p,id,this.policy);
      if(before.grant.id!==after.grant.id||before.grant.revision!==after.grant.revision)throw new DomainError('CONFLICT','Task permission changed');
      return this.view(client,p,job);
    }));
  }
  async reply(principal:Principal,input:unknown,contextId?:string,expected?:{revision:number;updatedAt:string},amendment=false):Promise<Job>{
    const p=structuredClone(principal),args=replySchema.parse(input),owner=ownerKey(p);
    return this.db.run(client=>withPostgresAgentWrite(client,p,this.policy,async admission=>{
      const before=await postgresTaskProcessingGrant(client,p,args.taskId,this.policy),store=new PostgresTaskStorage(client,this.kernel);
      assertReplyTaskContext(await store.get(owner,args.taskId),contextId);
      const result=await store.once(owner,admission.actor.installationId,`${amendment?'amend':'reply'}:${args.taskId}`,args.requestId,JSON.stringify(args),async()=>{
        const current=await store.get(owner,args.taskId);
        await runReplyProgramAsync({
          intents:store.intents.bind(store),intent:store.intent.bind(store),saveIntent:store.saveIntent.bind(store),cancelActions:store.cancelActions.bind(store),
          saveTask:async(owner,job)=>{await store.save(owner,job);},
          personal:()=>{throw new DomainError('FORBIDDEN','Personal selection requires the current task grant');},
          prepare:(owner,job,program,request)=>{
            if(!this.options.prepareRequest)throw new DomainError('CONFLICT','This original task requires its configured runtime before it can continue');
            return this.options.prepareRequest(client,owner,job,program,request);
          },
        },replyTransition(current,owner,args,{foundation:true,canRead:p.scopes.includes('tasks:read'),amendment,expected}));
        let saved=await store.get(owner,args.taskId);
        if(saved.delegation!.request.revision!==before.grant.requestRevision){
          const inputs=await postgresPersonalInputs(client,p,saved,this.policy,this.kernel);
          await postgresProvisionTask(client,p,saved,this.policy,inputs,{previous:before.grant,replacePersonalInputs:!!args.personalContext,builder:this.kernel});
          if(args.personalContext){
            const graph=await PostgresProjectionGraph.create(client,owner,saved.delegation!.ontologyRelease!,this.kernel);
            await graph.run(metadata=>selectPersonalContextProgram(metadata,owner,saved.delegation!.request,args.personalContext!));
            saved=await store.save(owner,saved);
          }
        }
        return saved;
      });
      await postgresTaskProcessingGrant(client,p,args.taskId,this.policy);
      return this.view(client,p,result);
    }));
  }
  async amend(principal:Principal,input:unknown,contextId?:string):Promise<Job>{
    const args=versionedReplySchema.parse(input);
    if((!args.personalContext&&!args.locationContext)||args.requirements||args.executionBudget)throw new DomainError('FORBIDDEN','Foundation amendments are limited to an explicit personal or location context refresh');
    return this.reply(principal,args,contextId,undefined,true);
  }
  async resume(principal:Principal,input:unknown,contextId?:string):Promise<Job>{
    const p=structuredClone(principal),args=resumeTaskSchema.parse(input),owner=ownerKey(p);
    if(args.executionBudget)throw new DomainError('FORBIDDEN','Foundation recovery uses the current task budget');
    return this.db.run(client=>withPostgresAgentWrite(client,p,this.policy,async admission=>{
      const before=await postgresTaskProcessingGrant(client,p,args.taskId,this.policy),authority=await postgresWorkerAdmission(client,owner,args.taskId,this.policy);
      if(authority.authority.installationId!==admission.actor.installationId||authority.grant.id!==before.grant.id||authority.grant.revision!==before.grant.revision)throw new DomainError('FORBIDDEN','The original task authority is required');
      const store=new PostgresTaskStorage(client,this.kernel);
      const job=await store.once(owner,admission.actor.installationId,`technical_resume:${args.taskId}`,args.requestId,JSON.stringify(args),async()=>{
        const current=await store.get(owner,args.taskId);assertTechnicalResumeState(current,args,contextId);
        const intents=await store.intents(owner,args.taskId);
        const selected=assertTechnicalResume(current,args,intents,contextId,true);
        if(selected){if(!this.options.assertProgram)throw new DomainError('CONFLICT','This original task requires its configured runtime before it can continue');await this.options.assertProgram(client,owner,current,selected);}
        return store.save(owner,applyTechnicalResume(current,args,intents.length));
      });
      const after=await postgresTaskProcessingGrant(client,p,args.taskId,this.policy),currentAuthority=await postgresWorkerAdmission(client,owner,args.taskId,this.policy);
      if(digest(before.grant)!==digest(after.grant)||digest(authority.authority)!==digest(currentAuthority.authority))throw new DomainError('CONFLICT','Original task authority changed during recovery');
      return this.view(client,p,job);
    }));
  }
  async reconcile(principal:Principal,taskId:string,requestId:string):Promise<Job>{
    const p=structuredClone(principal),id=taskIdSchema.parse(taskId),owner=ownerKey(p);
    return this.db.run(client=>withPostgresAgentWrite(client,p,this.policy,async admission=>{
      const before=await postgresTaskProcessingGrant(client,p,id,this.policy),authority=await postgresWorkerAdmission(client,owner,id,this.policy);
      if(authority.authority.installationId!==admission.actor.installationId||authority.grant.id!==before.grant.id||authority.grant.revision!==before.grant.revision)throw new DomainError('FORBIDDEN','The original task authority is required');
      const store=new PostgresTaskStorage(client,this.kernel);
      const job=await store.once(owner,admission.actor.installationId,`reconcile:${id}`,requestId,id,async()=>{
        const result=await runRecoveryProgramAsync({intents:store.intents.bind(store),saveIntent:store.saveIntent.bind(store),revokeGrants:store.revokeGrants.bind(store),
          saveTask:async(owner,job)=>{await store.save(owner,job);}},reconcileTransition(await store.get(owner,id),owner,requestId,{foundation:true}));
        return result.job;
      });
      const after=await postgresTaskProcessingGrant(client,p,id,this.policy),currentAuthority=await postgresWorkerAdmission(client,owner,id,this.policy);
      if(digest(before.grant)!==digest(after.grant)||digest(authority.authority)!==digest(currentAuthority.authority))throw new DomainError('CONFLICT','Original task authority changed during recovery');
      return this.view(client,p,job);
    }));
  }
  async revokeAuthorization(principal:Principal,taskId:string,requestId:string):Promise<Job>{
    const p=structuredClone(principal),id=taskIdSchema.parse(taskId),owner=ownerKey(p);
    return this.db.run(client=>withPostgresAgentWrite(client,p,this.policy,async admission=>{
      const before=await postgresTaskProcessingGrant(client,p,id,this.policy),authority=await postgresWorkerAdmission(client,owner,id,this.policy);
      if(authority.authority.installationId!==admission.actor.installationId||authority.grant.id!==before.grant.id||authority.grant.revision!==before.grant.revision)throw new DomainError('FORBIDDEN','The original task authority is required');
      const store=new PostgresTaskStorage(client,this.kernel);
      const job=await store.once(owner,admission.actor.installationId,`revoke:${id}`,requestId,id,async()=>{
        const result=await runRecoveryProgramAsync({intents:store.intents.bind(store),saveIntent:store.saveIntent.bind(store),revokeGrants:store.revokeGrants.bind(store),
          saveTask:async(owner,job)=>{await store.save(owner,job);}},revokeAuthorizationTransition(await store.get(owner,id),owner,requestId));
        return result.job;
      });
      const after=await postgresTaskProcessingGrant(client,p,id,this.policy),currentAuthority=await postgresWorkerAdmission(client,owner,id,this.policy);
      if(digest(before.grant)!==digest(after.grant)||digest(authority.authority)!==digest(currentAuthority.authority))throw new DomainError('CONFLICT','Original task authority changed during recovery');
      return this.view(client,p,job);
    }));
  }
  override async close(){this.commandStopping=true;await super.close();}
}
