import { postgresDescribeOntology } from './ontology-metadata.js';
import { postgresQueryOntology } from './ontology-query.js';
import { postgresEvaluateOntology } from './ontology-functions.js';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError, ownerKey, taskIdSchema, type Principal } from '../core/domain.js';
import type { ListFilter } from '../core/store.js';
import type { TaskServicePort } from '../core/task-service-port.js';
import { BACKEND_VERSION } from '../ontology/execution.js';
import type { StagedKernelBuilder } from '../ontology/seed-definition.js';
import { SecurityError } from '../security/errors.js';
import { PostgresDatabase } from './database.js';
import { postgresBusinessSchema } from './runtime-transaction.js';
import { withPostgresAgentRead } from './task-read-access.js';
import { withPostgresTaskReadAuthorization } from './task-output.js';
import { postgresTaskView } from './task-view.js';

/** Read side of the shared task service. Every poll opens a new fenced read;
 * long polling never holds a transaction or lends a previous read's authority. */
export class PostgresTaskReadService implements Pick<TaskServicePort,'get'|'getAfterWait'|'wait'|'list'|'describeOntology'|'queryOntology'|'evaluateOntology'> {
  private stopping=false;
  private readonly waitTimeoutMs:number;
  constructor(private readonly database:Pick<PostgresDatabase,'run'>,private readonly policyDigest:string,
    private readonly builder?:StagedKernelBuilder,options:{waitTimeoutMs?:number}={}) {
    if(!/^[a-f0-9]{64}$/.test(policyDigest))throw new Error('Invalid PostgreSQL task policy');
    this.waitTimeoutMs=options.waitTimeoutMs??300000;
    if(!Number.isSafeInteger(this.waitTimeoutMs) || this.waitTimeoutMs<1)throw new Error('Invalid blocking task wait');
  }
  async describeOntology(principal:Principal,input:unknown,context?:import('../core/tasks.js').OntologyReadContext) {
    if(context)throw new DomainError('FORBIDDEN','Use the task-scoped foundation read contract');
    const p=structuredClone(principal),args=structuredClone(input);
    return this.database.run(client=>postgresDescribeOntology(client,p,args,this.policyDigest,this.builder));
  }
  async queryOntology(principal:Principal,input:unknown,reader?:import('../ontology/network-read.js').NetworkOntologyReadAdapter,context?:import('../core/tasks.js').OntologyReadContext) {
    if(reader||context)throw new DomainError('FORBIDDEN','Use the task-scoped foundation read contract');
    const p=structuredClone(principal),args=structuredClone(input);
    return this.database.run(client=>postgresQueryOntology(client,p,args,this.policyDigest,this.builder));
  }
  async evaluateOntology(principal:Principal,input:unknown,reader?:import('../ontology/network-read.js').NetworkOntologyReadAdapter,context?:import('../core/tasks.js').OntologyReadContext) {
    if(reader||context)throw new DomainError('FORBIDDEN','Use the task-scoped foundation read contract');
    const p=structuredClone(principal),args=structuredClone(input);
    return this.database.run(client=>postgresEvaluateOntology(client,p,args,this.policyDigest,this.builder));
  }
  async get(principal:Principal,taskId:string) {
    const p=structuredClone(principal),id=taskIdSchema.parse(taskId);
    return this.database.run(client=>postgresTaskView(client,p,id,this.policyDigest,this.builder));
  }
  async getAfterWait(principal:Principal,taskId:string,waitMs=0) {
    if(!Number.isInteger(waitMs) || waitMs<0 || waitMs>30000)throw new DomainError('INVALID_INPUT','Task read wait must be between 0 and 30000 milliseconds');
    const p=structuredClone(principal),deadline=Date.now()+waitMs;
    let job=await this.get(p,taskId);
    while(!this.stopping && ['submitted','working'].includes(job.state) && Date.now()<deadline) {
      await delay(Math.min(250,Math.max(1,deadline-Date.now())));
      job=await this.get(p,taskId);
    }
    return job;
  }
  async wait(principal:Principal,taskId:string) {
    const p=structuredClone(principal),id=taskIdSchema.parse(taskId),deadline=Date.now()+this.waitTimeoutMs;
    const read=()=>this.database.run(async client=>{
      const job=await postgresTaskView(client,p,id,this.policyDigest,this.builder),q=`"${postgresBusinessSchema(client)}"`;
      const metadata=await client.query(`SELECT CASE WHEN octet_length(${q}.eigos_try_jsonb(body)#>>'{delegation,backendVersion}')<=128
        THEN ${q}.eigos_try_jsonb(body)#>>'{delegation,backendVersion}' END AS backend FROM ${q}.jobs WHERE owner=$1 AND id=$2`,[ownerKey(p),id]);
      return {job,currentBackend:metadata.rowCount===1 && metadata.rows[0].backend===BACKEND_VERSION};
    });
    let current=await read();
    while(current.currentBackend && ['submitted','working'].includes(current.job.state)) {
      if(this.stopping || Date.now()>=deadline)throw new Error('Blocking task wait interrupted; query the existing task or retry the same message with returnImmediately=true');
      await delay(50);current=await read();
    }
    return current.job;
  }
  async list(principal:Principal,filter:ListFilter) {
    const p=structuredClone(principal),owner=ownerKey(p);
    z.number().int().min(1).max(100).parse(filter.limit);z.number().int().min(0).max(1000000).parse(filter.offset);
    const updatedAfter=filter.updatedAfter?new Date(z.iso.datetime({offset:true}).parse(filter.updatedAfter)).toISOString():undefined;
    return this.database.run(client=>withPostgresAgentRead(client,p,this.policyDigest,async admission=>{
      const q=`"${postgresBusinessSchema(client)}"`;
      const grants=await client.query(`SELECT data.value->>'taskId' AS task_id FROM ${q}.security_grants g
        CROSS JOIN LATERAL (SELECT CASE WHEN octet_length(g.body)<=1048576 THEN ${q}.eigos_try_jsonb(g.body) END AS value OFFSET 0) data
        WHERE g.owner=$1 AND g.installation_id=$2 AND g.kind='task_data' AND g.state='active' AND g.expires_at>$3
          AND g.parent_id=$4 AND g.parent_revision=$5 AND jsonb_typeof(data.value->'taskId')='string'
          AND jsonb_typeof(data.value->'operations')='array' AND data.value->'operations' @> '["task.result.read"]'::jsonb LIMIT 2001`,
      [owner,admission.actor.installationId,Date.now(),admission.parent.id,admission.parent.revision]);
      if(grants.rows.length>2000)throw new DomainError('CONFLICT','Task boundary exceeds the supported query budget');
      const visible:string[]=[];
      for(const id of new Set(grants.rows.map(row=>taskIdSchema.parse(row.task_id)))) {
        try {
          await withPostgresTaskReadAuthorization(client,p,id,this.policyDigest,auth=>auth.readTaskRoot(),this.builder);
          visible.push(id);
        } catch(error) {
          if(error instanceof SecurityError && !['AUTHORITY_UNAVAILABLE','POLICY_CHANGED'].includes(error.reason))continue;
          if(error instanceof DomainError && error.code==='NOT_FOUND')continue;
          throw error;
        }
      }
      const values:unknown[]=[owner,visible],clauses=['owner=$1','id=ANY($2::text[])'];
      for(const [column,value] of [['context_id',filter.contextId],['state',filter.state],['updated_at',updatedAfter]] as const) {
        if(value){values.push(value);clauses.push(`${column}${column==='updated_at'?'>=':'='}$${values.length}`);}
      }
      const where=clauses.join(' AND '),total=Number((await client.query(`SELECT count(*) AS total FROM ${q}.jobs WHERE ${where}`,values)).rows[0].total);
      values.push(filter.limit,filter.offset);
      const page=await client.query(`SELECT id FROM ${q}.jobs WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $${values.length-1} OFFSET $${values.length}`,values);
      const jobs=[];
      for(const row of page.rows)jobs.push(await postgresTaskView(client,p,String(row.id),this.policyDigest,this.builder));
      // No cached page or total survives a changed installation/policy. The
      // outer read admission also checks again before the transaction returns.
      if(!Number.isSafeInteger(total) || total<0)throw new SecurityError('POLICY_CHANGED');
      return {jobs,total};
    }));
  }
  async close(){this.stopping=true;}
}
