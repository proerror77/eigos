import {ownerKey,submitSchema,taskIdSchema,DomainError,type Principal,type Job} from '../core/domain.js';
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
import {BACKEND_VERSION} from '../ontology/execution.js';

/** Async task commands. This class owns no model, provider or polling loop. */
export class PostgresTaskCommandService extends PostgresTaskReadService {
  private commandStopping=false;
  constructor(private readonly db:Pick<PostgresDatabase,'run'>,private readonly policy:string,private readonly kernel?:StagedKernelBuilder){super(db,policy,kernel);}
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
  override async close(){this.commandStopping=true;await super.close();}
}
