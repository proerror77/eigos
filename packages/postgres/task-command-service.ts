import {ownerKey,submitSchema,replySchema,versionedReplySchema,resumeTaskSchema,taskIdSchema,DomainError,type Principal,type Job} from '../core/domain.js';
import {runReplyProgramAsync,replyTransition,assertReplyTaskContext} from '../core/reply-program.js';
import {assertTechnicalResume,assertTechnicalResumeState,applyTechnicalResume} from '../core/technical-resume.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import {digest} from '../core/delegation.js';
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
}

/** Async task commands. This class owns no model, provider or polling loop. */
export class PostgresTaskCommandService extends PostgresTaskReadService {
  private commandStopping=false;
  constructor(private readonly db:Pick<PostgresDatabase,'run'>,private readonly policy:string,private readonly kernel?:StagedKernelBuilder,
    private readonly options:PostgresTaskCommandOptions={}){super(db,policy,kernel);}
  private async view(client:Client,p:Principal,job:Job):Promise<TaskView>{
    const admission=await postgresTaskReceiptGrant(client,p,job.id,this.policy);postgresConstrainReadDeadline(client,admission.validUntil);
    if(p.scopes.includes('tasks:read')&&admission.grant.operations.includes('task.result.read'))return postgresTaskView(client,p,job.id,this.policy,this.kernel);
    return {view:'eigos.task.v2',id:job.id,contextId:job.contextId,service:job.service,state:job.state,revision:job.revision,authorityId:job.authorityId,
      goal:'',messages:[],createdAt:job.createdAt,updatedAt:job.updatedAt,outputStatus:'receipt_only'};
  }
  async submit(principal:Principal,input:unknown,contextId?:string):Promise<Job>{
    const p=structuredClone(principal),args=submitSchema.parse(input);if(contextId)taskIdSchema.parse(contextId);
    if(args.service==='eigos.aftersales')throw new DomainError('FORBIDDEN','After-sales commands require the original operation adapter');
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
  override async close(){this.commandStopping=true;await super.close();}
}
