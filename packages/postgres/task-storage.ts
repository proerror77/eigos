import type {Client} from 'pg';
import {DomainError,type Job} from '../core/domain.js';
import {digest} from '../core/delegation.js';
import {synchronizeTaskOutcome} from '../core/task-outcome.js';
import {BACKEND_VERSION} from '../ontology/execution.js';
import {projectTaskProgram} from '../ontology/task-projection.js';
import {projectExecutionProgram,type ExecutionLedger} from '../ontology/execution-projection.js';
import {projectBusinessChainProgram} from '../ontology/business-chain-projection.js';
import type {PlanGrant,AfterSalesCase,ActionIntent} from '../ontology/actions.js';
import {cancelTaskIntent} from '../core/task-intents.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {taskDataGrantSchema,agentAccessGrantSchema} from '../security/contracts.js';
import {SecurityError} from '../security/errors.js';
import {postgresBusinessSchema,postgresBusinessToken} from './runtime-transaction.js';
import {PostgresProjectionGraph} from './projection-graph.js';
import {PostgresTaskBindings} from './task-bindings.js';

/** Internal task persistence. Actor/claim admission belongs to the enclosing
 * command. Every task, graph, binding and operation receipt shares its commit. */
export class PostgresTaskStorage {
  private readonly schema:string;
  private readonly token:object;
  constructor(private readonly client:Client,private readonly builder?:StagedKernelBuilder,private readonly now:()=>number=Date.now){
    this.schema=postgresBusinessSchema(client);this.token=postgresBusinessToken(client);
  }
  private async query(text:string,values:unknown[]=[]){
    if(postgresBusinessToken(this.client)!==this.token)throw new SecurityError('AUTHORIZATION_REQUIRED');
    const result=await this.client.query(text,values);
    if(postgresBusinessToken(this.client)!==this.token)throw new SecurityError('AUTHORIZATION_REQUIRED');
    return result;
  }
  async get(owner:string,id:string):Promise<Job>{
    const rows=await this.query(`SELECT owner,state,context_id,CASE WHEN octet_length(body)<=50331648 THEN body END AS body
      FROM "${this.schema}".jobs WHERE id=$1 LIMIT 2`,[id]);
    if(!rows.rowCount||rows.rows[0]?.owner!==owner)throw new DomainError('NOT_FOUND','Task not found');
    if(rows.rowCount!==1||typeof rows.rows[0]?.body!=='string')throw new DomainError('CONFLICT','Stored task exceeds the supported runtime bound');
    const job=JSON.parse(rows.rows[0].body) as Job;
    if(job.id!==id||job.state!==rows.rows[0].state||job.contextId!==rows.rows[0].context_id)throw new DomainError('CONFLICT','Stored task identity is invalid');
    return job;
  }
  async once(owner:string,installationId:string,operation:string,requestId:string,fingerprint:string,action:()=>Promise<Job>):Promise<Job>{
    const scoped=`${installationId}:${operation}`;
    const rows=await this.query(`SELECT fingerprint,CASE WHEN octet_length(response)<=50331648 THEN response END AS response
      FROM "${this.schema}".requests WHERE owner=$1 AND operation=$2 AND request_id=$3 LIMIT 2`,[owner,scoped,requestId]);
    if(rows.rowCount){
      const row=rows.rows[0];if(rows.rowCount!==1||typeof row?.response!=='string')throw new DomainError('CONFLICT','Stored operation receipt is invalid');
      // Imported legacy JSON may differ in insignificant property order.
      let same=row.fingerprint===fingerprint;
      if(!same){try{same=digest(JSON.parse(String(row.fingerprint)))===digest(JSON.parse(fingerprint));}catch{/* non-JSON operation keys compare literally */}}
      if(!same)throw new DomainError('CONFLICT','Request ID was already used with different input');
      const response=JSON.parse(row.response),id=response.taskId??response.id;
      if(typeof id!=='string')throw new DomainError('CONFLICT','Stored operation receipt has no task');
      return this.get(owner,id);
    }
    const result=await action();
    await this.query(`INSERT INTO "${this.schema}".requests(owner,operation,request_id,fingerprint,response) VALUES($1,$2,$3,$4,$5)`,
      [owner,scoped,requestId,fingerprint,JSON.stringify({taskId:result.id})]);
    return result;
  }
  async intents(owner:string,taskId:string):Promise<ActionIntent[]>{
    await this.get(owner,taskId);
    const rows=await this.query(`SELECT id,state,business_key,CASE WHEN octet_length(body)<=8388608 AND sum(octet_length(body)) OVER()<=33554432 THEN body END AS body
      FROM "${this.schema}".action_intents WHERE owner=$1 AND job_id=$2 ORDER BY id LIMIT 2001`,[owner,taskId]);
    if(rows.rows.length>2000||rows.rows.some(row=>row.body===null))throw new DomainError('CONFLICT','Task intents exceed their safe read bound');
    return rows.rows.map(row=>{const intent=JSON.parse(String(row.body)) as ActionIntent;
      if(intent.owner!==owner||intent.jobId!==taskId||intent.id!==row.id||intent.businessOperationKey!==row.business_key)throw new DomainError('CONFLICT','Stored intent identity is invalid');
      return {...intent,state:String(row.state) as ActionIntent['state']};});
  }
  async cancelActions(owner:string,taskId:string):Promise<boolean>{
    let pending=false;
    for(const intent of await this.intents(owner,taskId)){
      pending=cancelTaskIntent(intent,Date.now())||pending;
      const {privateData:_private,...body}=intent;
      await this.query(`UPDATE "${this.schema}".action_intents SET state=$1,body=$2 WHERE owner=$3 AND job_id=$4 AND id=$5 AND business_key=$6`,
        [intent.state,JSON.stringify(body),owner,taskId,intent.id,intent.businessOperationKey]);
    }
    return pending;
  }
  private async ledger(owner:string,id:string):Promise<ExecutionLedger>{
    const q=`"${this.schema}"`,load=async(table:string,condition:string,order='')=>{
      const rows=await this.query(`SELECT CASE WHEN octet_length(v.body)<=8388608 AND sum(octet_length(v.body)) OVER()<=33554432 THEN v.body END AS body
        FROM ${q}.${table} v JOIN ${q}.action_intents i ON ${condition} WHERE v.owner=$1 AND i.job_id=$2 ${order} LIMIT 2001`,[owner,id]);
      if(rows.rows.length>2000||rows.rows.some(row=>row.body===null))throw new DomainError('CONFLICT','Task execution ledger exceeds its safe read bound');
      return rows.rows.map(row=>JSON.parse(String(row.body)));
    };
    const current=await load('action_intents','i.id=v.id AND i.owner=v.owner');
    const archived=await load('action_intent_versions','i.id=v.intent_id AND i.owner=v.owner');
    const attempts=await load('action_attempts','i.id=v.intent_id AND i.owner=v.owner','ORDER BY v.__eigos_rowid');
    const observations=await this.query(`SELECT v.id,v.intent_id,v.attempt_id,v.received_at,v.digest,v.applied,
      CASE WHEN octet_length(v.body)<=8388608 AND sum(octet_length(v.body)) OVER()<=33554432 THEN v.body END AS body
      FROM ${q}.action_observations v JOIN ${q}.action_intents i ON i.id=v.intent_id AND i.owner=v.owner
      WHERE v.owner=$1 AND i.job_id=$2 ORDER BY v.__eigos_rowid LIMIT 2001`,[owner,id]);
    if(observations.rows.length>2000||observations.rows.some(row=>row.body===null))throw new DomainError('CONFLICT','Task observations exceed their safe read bound');
    return {intents:[...archived,...current],attempts,observations:observations.rows.map(row=>{
      const result=JSON.parse(String(row.body));return {id:String(row.id),intentId:String(row.intent_id),attemptId:String(row.attempt_id),receivedAt:String(row.received_at),
        digest:String(row.digest),applied:Number(row.applied)===1,verified:Number(row.applied)===1&&result.kind!=='unknown'?true:undefined,result};
    })};
  }
  async save(owner:string,supplied:Job):Promise<Job>{
    const job=structuredClone(supplied),q=`"${this.schema}"`;
    const authority=await this.query(`SELECT id FROM ${q}.eigos_lock_runtime_authority()`);
    if(authority.rowCount!==1)throw new DomainError('CONFLICT','Runtime authority is unavailable');
    const previous=await this.query(`SELECT owner,CASE WHEN octet_length(body)<=50331648 THEN body END AS body FROM ${q}.jobs WHERE id=$1`,[job.id]);
    if(previous.rowCount){
      if(previous.rows[0]?.owner!==owner)throw new DomainError('FORBIDDEN','Task owner mismatch');
      if(typeof previous.rows[0]?.body!=='string')throw new DomainError('CONFLICT','Stored task exceeds its runtime bound');
      const old=JSON.parse(previous.rows[0].body) as Job;
      if(old.authorityId!==job.authorityId||digest(old.delegation?.ontologyRelease??null)!==digest(job.delegation?.ontologyRelease??null)
        ||digest(old.delegation?.callerAction??null)!==digest(job.delegation?.callerAction??null))throw new DomainError('CONFLICT','Task authority and pinned execution context are immutable');
    }else if(job.delegation?.backendVersion===BACKEND_VERSION)job.authorityId=String(authority.rows[0].id);
    if(job.authorityId!==authority.rows[0].id)throw new DomainError('CONFLICT','Task belongs to another runtime authority');
    job.executionMode='worker-security-v2';synchronizeTaskOutcome(job);
    if(Buffer.byteLength(JSON.stringify(job))>50331648)throw new DomainError('CONFLICT','Task exceeds its safe runtime bound');
    await this.query('SAVEPOINT eigos_task_save');
    try{
      await this.query(`INSERT INTO ${q}.jobs(id,owner,context_id,state,created_at,updated_at,body) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,body=excluded.body WHERE jobs.owner=excluded.owner`,
        [job.id,owner,job.contextId,job.state,job.createdAt,job.updatedAt,JSON.stringify(job)]);
      if(job.service!=='eigos.delegate'||job.delegation?.backendVersion!==BACKEND_VERSION||!job.delegation.ontologyRelease)throw new DomainError('CONFLICT','Task has no current pinned execution context');
      const graph=await PostgresProjectionGraph.create(this.client,owner,job.delegation.ontologyRelease,this.builder,{now:this.now});
      await graph.run(metadata=>projectTaskProgram(metadata,owner,job));
      const ledger=await this.ledger(owner,job.id);
      await graph.run(metadata=>projectExecutionProgram(metadata,owner,job,ledger));
      const loadRecords=async<T>(table:'plan_grants'|'aftersales_cases',where:string):Promise<T[]>=>{
        const rows=await this.query(`SELECT CASE WHEN octet_length(body)<=8388608 AND sum(octet_length(body)) OVER()<=8388608 THEN body END AS body
          FROM ${q}.${table} WHERE owner=$1 AND (${where}) LIMIT 2001`,[owner,job.id]);
        if(rows.rows.length>2000||rows.rows.some(row=>row.body===null))throw new DomainError('CONFLICT','Task business ledger exceeds its safe read bound');
        return rows.rows.map(row=>JSON.parse(String(row.body)) as T);
      };
      const grantsForPlan=await loadRecords<PlanGrant>('plan_grants','job_id=$2');
      const cases=await loadRecords<AfterSalesCase>('aftersales_cases','original_job_id=$2 OR remedy_job_id=$2');
      await graph.run(metadata=>projectBusinessChainProgram(metadata,owner,job,{...ledger,grants:grantsForPlan,cases}));
      const grants=await this.query(`SELECT d.revision,d.state,CASE WHEN octet_length(d.body)<=1048576 THEN d.body END AS body,
        g.revision AS parent_revision,g.state AS parent_state,CASE WHEN octet_length(g.body)<=1048576 THEN g.body END AS parent_body
        FROM ${q}.security_grants d JOIN ${q}.security_grants g ON g.id=d.parent_id AND g.revision=d.parent_revision
        WHERE d.owner=$1 AND d.kind='task_data' AND d.state='active' AND ${q}.eigos_try_jsonb(d.body)->>'taskId'=$2 LIMIT 257`,[owner,job.id]);
      if(grants.rows.length>256||grants.rows.some(row=>row.body===null||row.parent_body===null))throw new SecurityError('POLICY_CHANGED');
      const bindings=new PostgresTaskBindings(this.client,this.builder);
      for(const row of grants.rows){
        const grant=taskDataGrantSchema.parse({...JSON.parse(String(row.body)),revision:Number(row.revision),status:row.state});
        if(grant.requestRevision!==job.delegation.request.revision)continue;
        const parent=agentAccessGrantSchema.parse({...JSON.parse(String(row.parent_body)),revision:Number(row.parent_revision),status:row.parent_state});
        if(grant.ownerKey!==owner||grant.taskId!==job.id||parent.ownerKey!==owner||parent.id!==grant.parentGrant.id||parent.installationId!==grant.installationId)throw new SecurityError('POLICY_CHANGED');
        await bindings.project(grant,parent,job);
      }
      await this.query('RELEASE SAVEPOINT eigos_task_save');return job;
    }catch(error){await this.query('ROLLBACK TO SAVEPOINT eigos_task_save');await this.query('RELEASE SAVEPOINT eigos_task_save');throw error;}
  }
}
