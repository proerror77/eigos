import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {DomainError,type Job,type Principal} from '../core/domain.js';
import type {WorkClaim} from '../core/store.js';
import {digest} from '../core/delegation.js';
import {remainingModelTurns} from '../core/execution-budget.js';
import {scheduleTaskRecovery} from '../core/task-recovery.js';
import type {ActionIntent} from '../ontology/actions.js';
import {BACKEND_VERSION} from '../ontology/execution.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {SecurityError} from '../security/errors.js';
import type {PostgresDatabase} from './database.js';
import {postgresBusinessSchema,postgresBusinessAuthorityDigest,postgresConstrainReadDeadline,postgresRequireLeaseAtCommit} from './runtime-transaction.js';
import {postgresClaimSnapshotMatches,postgresWorkReference,type PostgresWorkReference} from './work-claim.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import {PostgresTaskStorage} from './task-storage.js';
import {postgresWorkerRequest} from './worker-input.js';
import {postgresPrepareWorkerSeal,postgresRecordWorkerOutputs} from './worker-output.js';
import {withPostgresWorkerEvidenceAuthorization,type PostgresTaskReadAuthorization} from './task-output.js';
import type {PostgresTaskReadAdmission} from './task-read-access.js';
import {postgresBeginModelUsage,postgresFinishModelUsage,postgresRecordModelResponse} from './model-usage.js';
import type {ModelUsageEvidence} from '../core/model-usage-context.js';
import type {RunEvidence} from '../capabilities/executor.js';
import {postgresRecordClaimRelease} from './claim-release.js';
import {runGraphProgramAsync,type GraphProgram,type ProjectionMetadata} from '../ontology/graph-program.js';
import type {ServiceRequest} from '../ontology/execution.js';
import {withPostgresSourceProjection,type PostgresSourceProjectionOptions} from './source-projection.js';
import {combineEnvelopes,type SecurityEnvelope} from '../security/envelope.js';
import {postgresProjectCapabilityCatalog,type PostgresCapabilityCatalogEntry} from './capability-catalog.js';

export interface PostgresWorkerProjectionContext {
  readonly graph:ProjectionMetadata;
  readonly request:ServiceRequest;
  readonly job:Job;
  readonly intents:readonly ActionIntent[];
}

class LostClaim extends Error{}
/** Durable queue shared by Mac Workers. Each method releases its transaction
 * before the caller can run a model or contact a provider. */
export class PostgresWorkerStore {
  constructor(private readonly db:Pick<PostgresDatabase,'run'|'renewClaim'|'inspectClaim'|'cleanupReleasedClaims'>&Partial<Pick<PostgresDatabase,'workAvailable'>>,private readonly policy:string,private readonly kernel?:StagedKernelBuilder){
    if(!/^[a-f0-9]{64}$/.test(policy))throw new Error('Invalid PostgreSQL Worker policy');
  }
  private async expire(client:Client){
    const q=`"${postgresBusinessSchema(client)}"`,now=Date.now(),store=new PostgresTaskStorage(client,this.kernel);
    const rows=await client.query(`SELECT j.id,j.owner,c.token,c.revision FROM ${q}.work_claims c JOIN ${q}.jobs j ON j.id=c.job_id WHERE c.expires_at<=$1 ORDER BY c.job_id LIMIT 257`,[now]);
    if(rows.rows.length>256)throw new DomainError('CONFLICT','Expired Worker claims exceed the recovery batch bound');
    for(const row of rows.rows){
      const owner=String(row.owner),job=await store.get(owner,String(row.id));
      await client.query(`UPDATE ${q}.member_model_usage SET state='unknown' WHERE owner=$1 AND job_id=$2 AND state='running'
        AND ${q}.eigos_try_jsonb(body)->>'claimTokenDigest'=$3`,[owner,job.id,digest(String(row.token))]);
      if(job.service==='eigos.delegate'&&job.delegation?.backendVersion===BACKEND_VERSION&&(job.revision??0)===Number(row.revision)){
        const intents=await client.query(`SELECT id,state,CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.action_intents WHERE owner=$1 AND job_id=$2 ORDER BY id LIMIT 2001`,[owner,job.id]);
        if(intents.rows.length>2000||intents.rows.some(row=>row.body===null))throw new DomainError('CONFLICT','Task intent recovery exceeds its safe bound');
        for(const item of intents.rows)if(item.state==='dispatching'){
          const intent=JSON.parse(String(item.body)) as ActionIntent;intent.state='effect_unknown';intent.nextAt=now;
          await client.query(`UPDATE ${q}.action_intents SET state=$1,body=$2 WHERE owner=$3 AND id=$4 AND state='dispatching'`,[intent.state,JSON.stringify(intent),owner,item.id]);
        }
        if(job.delegation.plan||job.delegation.agent){
          if(job.state==='working')job.delegation.nextAt=now;
          else if(intents.rows.some(item=>['dispatching','awaiting_remote','effect_unknown'].includes(String(item.state))))job.delegation.recoveryPending=true;
          job.updatedAt=new Date(now).toISOString();await store.save(owner,job);
        }else if(job.state==='working'){
          scheduleTaskRecovery(job,'worker_interrupted','运行进程中断，已保留原任务，恢复后继续处理。',{now});await store.save(owner,job);
        }
      }
      await client.query(`DELETE FROM ${q}.runtime_work_claims WHERE job_id=$1 AND token=$2`,[job.id,row.token]);
      await client.query(`DELETE FROM ${q}.work_claims WHERE job_id=$1 AND token=$2 AND expires_at<=$3`,[job.id,row.token,now]);
    }
  }
  async claim(services:string[],leaseMs:number):Promise<WorkClaim|undefined>{
    if(!Number.isSafeInteger(leaseMs)||leaseMs<100||leaseMs>300000)throw new Error('Invalid Worker lease');
    if(!services.includes('eigos.delegate'))return;
    if(this.db.workAvailable&&!await this.db.workAvailable())return;
    await this.db.cleanupReleasedClaims();
    return this.db.run(async client=>{
      await this.expire(client);const q=`"${postgresBusinessSchema(client)}"`,now=Date.now();
      const count=await client.query(`SELECT(SELECT count(*) FROM ${q}.work_claims)+(SELECT count(*) FROM ${q}.security_recoveries WHERE state='running' AND lease_until>$1) AS n`,[now]);
      const active=Number(count.rows[0]?.n);if(!Number.isSafeInteger(active)||active<0)throw new DomainError('CONFLICT','Invalid active Worker count');
      if(active>=2)return;
      const manager=await client.query(`SELECT 1 FROM ${q}.security_manager m JOIN ${q}.security_settings settings ON settings.slot=m.slot
        JOIN ${q}.security_policy p ON p.slot=m.slot JOIN ${q}.security_policy_definitions definition ON definition.slot=p.slot
        WHERE m.slot=1 AND m.expires_at>$1 AND settings.version=2 AND settings.mode='foundation' AND p.revision BETWEEN 1 AND 9007199254740991 AND definition.digest=$2`,[now,this.policy]);
      if(manager.rowCount!==1)return;
      const rows=await client.query(`SELECT j.id,j.owner FROM ${q}.jobs j CROSS JOIN ${q}.eigos_lock_runtime_authority() a
        CROSS JOIN LATERAL(SELECT ${q}.eigos_try_jsonb(j.body) AS value OFFSET 0) body
        WHERE(j.state IN('working','submitted') OR(j.state IN('canceled','failed','rejected','completed','auth-required') AND body.value#>'{delegation,recoveryPending}'='true'::jsonb))
          AND body.value->>'executionMode'='worker-security-v2' AND body.value->>'service'='eigos.delegate'
          AND body.value#>>'{delegation,backendVersion}'=$1 AND body.value->>'authorityId'=a.id
          AND COALESCE(CASE WHEN jsonb_typeof(body.value#>'{delegation,nextAt}')='number' THEN(body.value#>>'{delegation,nextAt}')::numeric END,0)<=$2
          AND EXISTS(SELECT 1 FROM ${q}.security_task_authorities permission
            JOIN ${q}.security_subjects subject ON subject.installation_id=permission.installation_id AND subject.owner=permission.owner AND subject.member_id=permission.member_id
            JOIN ${q}.security_grants parent ON parent.id=permission.agent_grant_id AND parent.kind='agent_access' AND parent.owner=permission.owner AND parent.installation_id=permission.installation_id
            JOIN ${q}.security_grants data ON data.id=permission.data_grant_id AND data.kind='task_data' AND data.owner=permission.owner AND data.installation_id=permission.installation_id
            WHERE permission.task_id=j.id AND permission.owner=j.owner AND permission.state='active' AND subject.state='active' AND parent.state='active' AND data.state='active'
              AND permission.auth_epoch=subject.epoch AND permission.agent_grant_revision=parent.revision AND permission.data_grant_revision=data.revision
              AND data.parent_id=parent.id AND data.parent_revision=parent.revision AND ${q}.eigos_try_jsonb(data.body)->>'purpose'='delegated_task'
              AND ${q}.eigos_try_jsonb(data.body)->'operations' @> '["task.process"]'::jsonb
              AND permission.request_revision=CASE WHEN jsonb_typeof(body.value#>'{delegation,request,revision}')='number' THEN(body.value#>>'{delegation,request,revision}')::numeric END
              AND permission.expires_at>$2 AND subject.valid_until>$2 AND parent.expires_at>$2 AND data.expires_at>$2
              AND NOT EXISTS(SELECT 1 FROM ${q}.security_fences fence WHERE fence.owner=permission.owner AND fence.state<>'cleared'
                AND((fence.kind='member' AND fence.target_id=permission.member_id) OR(fence.kind='connection' AND fence.target_id=subject.client_id) OR(fence.kind='installation' AND fence.target_id=permission.installation_id))))
          AND NOT EXISTS(SELECT 1 FROM ${q}.work_claims c WHERE c.job_id=j.id) ORDER BY j.created_at,j.id LIMIT 65`,[BACKEND_VERSION,now]);
      const store=new PostgresTaskStorage(client,this.kernel);
      for(const row of rows.rows.slice(0,64)){
        let admission;try{admission=await postgresWorkerAdmission(client,String(row.owner),String(row.id),this.policy);}
        catch(error){if(error instanceof SecurityError)continue;throw error;}
        let job=await store.get(String(row.owner),String(row.id));
        if(job.state==='submitted'){job.state='working';job.updatedAt=new Date().toISOString();job=await store.save(String(row.owner),job);}
        const token=randomUUID(),at=Date.now();
        await client.query(`INSERT INTO ${q}.work_claims(job_id,token,revision,expires_at) VALUES($1,$2,$3,$4)`,[job.id,token,job.revision??0,at+leaseMs]);
        await client.query(`INSERT INTO ${q}.runtime_work_claims(job_id,token,authority_digest) VALUES($1,$2,$3)`,[job.id,token,postgresBusinessAuthorityDigest(client)]);
        const fresh=await postgresWorkerAdmission(client,String(row.owner),job.id,this.policy);
        if(digest(admission)!==digest(fresh))throw new SecurityError('POLICY_CHANGED');
        return {owner:String(row.owner),job,token,recovery:job.state!=='working'&&job.delegation?.recoveryPending===true,securityAuthorityId:admission.authority.id,
          securityEpoch:admission.authority.authEpoch,securityPolicyRevision:admission.policyRevision};
      }
    });
  }
  async active(input:WorkClaim){const claim=postgresWorkReference(input);return this.db.run(async client=>{
    if(!await this.db.inspectClaim(claim,this.policy)||!await postgresClaimSnapshotMatches(client,claim,this.policy))return false;
    const admission=await postgresWorkerAdmission(client,claim.owner,claim.job.id,this.policy);
    if(admission.authority.id!==claim.securityAuthorityId||admission.authority.authEpoch!==claim.securityEpoch||admission.policyRevision!==claim.securityPolicyRevision)return false;
    postgresConstrainReadDeadline(client,admission.validUntil);postgresRequireLeaseAtCommit(client,digest(claim),()=>this.db.inspectClaim(claim,this.policy));
    return true;
  });}
  renew(claim:WorkClaim,leaseMs:number){return this.db.renewClaim(claim,leaseMs,this.policy);}
  /** Real host registry metadata, never an arbitrary MCP-provided catalogue.
   * The helper owns current admission, reserved bindings and atomic rollback. */
  catalogue(claim:WorkClaim,entries:readonly PostgresCapabilityCatalogEntry[],modelChannel:string){
    return this.db.run(client=>postgresProjectCapabilityCatalog(client,claim,entries,{policyDigest:this.policy,modelChannel,
      inspectClaim:fence=>this.db.inspectClaim(fence,this.policy),builder:this.kernel}));
  }
  readRequest(claim:PostgresWorkReference,modelChannel:string){
    const reference=postgresWorkReference(claim);
    return this.db.run(client=>postgresWorkerRequest(client,reference,this.policy,modelChannel,this.kernel,fence=>this.db.inspectClaim(fence,this.policy)));
  }
  /** Host-side tool reads/receipt bookkeeping only. The callback must not run
   * models/providers or mutate task, policy or claim state. */
  readEvidence<T>(claim:PostgresWorkReference,modelChannel:string,action:(authorization:PostgresTaskReadAuthorization,admission:PostgresTaskReadAdmission,
    principal:Principal,client:Client)=>Promise<T>):Promise<T>{
    const reference=postgresWorkReference(claim);
    return this.db.run(client=>withPostgresWorkerEvidenceAuthorization(client,reference,this.policy,
      (auth,admission,principal)=>action(auth,admission,principal,client),this.kernel,modelChannel,fence=>this.db.inspectClaim(fence,this.policy)));
  }
  private withUsageClaim<T>(input:PostgresWorkReference,action:(client:Client,claim:PostgresWorkReference)=>Promise<T>):Promise<T>{
    const claim=postgresWorkReference(input);
    return this.db.run(async client=>{
      if(!await postgresClaimSnapshotMatches(client,claim,this.policy)||!await this.db.inspectClaim(claim,this.policy))throw new DomainError('CONFLICT','Model dispatch lease is no longer active');
      const before=await postgresWorkerAdmission(client,claim.owner,claim.job.id,this.policy);
      const result=await action(client,claim);
      if(!await postgresClaimSnapshotMatches(client,claim,this.policy)||digest(before)!==digest(await postgresWorkerAdmission(client,claim.owner,claim.job.id,this.policy)))throw new SecurityError('POLICY_CHANGED');
      postgresConstrainReadDeadline(client,before.validUntil);postgresRequireLeaseAtCommit(client,digest(claim),()=>this.db.inspectClaim(claim,this.policy));
      return result;
    });
  }
  beginModelUsage(claim:PostgresWorkReference,id:string,runtime:string,startedAt:string){
    return this.withUsageClaim(claim,(client,reference)=>postgresBeginModelUsage(client,reference,id,runtime,startedAt));
  }
  finishModelUsage(claim:PostgresWorkReference,id:string,evidence:ModelUsageEvidence|undefined,outcome:'completed'|'failed'|'interrupted'){
    const reference=postgresWorkReference(claim),captured=evidence===undefined?undefined:structuredClone(evidence);
    return this.db.run(client=>postgresFinishModelUsage(client,reference,id,captured,outcome));
  }
  recordModelUsage(claim:PostgresWorkReference,evidence:RunEvidence){
    const captured=structuredClone(evidence);return this.withUsageClaim(claim,(client,reference)=>postgresRecordModelResponse(client,reference,captured));
  }
  recordRun(claim:WorkClaim,evidence:RunEvidence,event:string){
    const captured=structuredClone(evidence);
    if(!event||event.length>80)throw new Error('Invalid model evidence event');
    const stored={...captured,purpose:event==='request_interpreted'?'grounding' as const:event==='goal_coverage_reviewed'?'goal_coverage' as const:'planning' as const};
    return this.mutateCurrent(claim,async job=>{
      if(!remainingModelTurns(job))throw new DomainError('CONFLICT','Maximum reasoning turns reached');
      job.runs=[...(job.runs??[]),stored];
      job.updatedAt=new Date().toISOString();job.delegation!.events.push({at:job.updatedAt,event,evidence:captured.id});
    },false,captured,undefined,stored);
  }
  /** Preserve the real action executor's purpose and original receipt. A
   * document run is not a new planning/grounding decision or business result. */
  recordActionRun(claim:WorkClaim,evidence:RunEvidence&{purpose:'document'}){
    const captured=structuredClone(evidence);
    if(captured.purpose!=='document')throw new Error('Unsupported action model evidence purpose');
    return this.mutate(claim,job=>{
      const previous=job.runs?.find(run=>run.id===captured.id);
      if(previous){if(digest(previous)!==digest(captured))throw new DomainError('CONFLICT','Original action model evidence changed');return;}
      if(!remainingModelTurns(job))throw new DomainError('CONFLICT','Maximum reasoning turns reached');
      job.runs=[...(job.runs??[]),captured];job.updatedAt=new Date().toISOString();
      job.delegation!.events.push({at:job.updatedAt,event:'agent_action_model_completed',evidence:captured.id});
    },false,captured);
  }
  private mutate(claim:WorkClaim,update:(job:Job)=>void,finish:boolean,modelEvidence?:RunEvidence){
    return this.mutateCurrent(claim,async current=>{
      const result:unknown=update(current);
      if(result&&typeof result==='object'&&'then'in result)throw new Error('Worker mutation callback must not perform asynchronous work');
    },finish,modelEvidence);
  }
  private async mutateCurrent(claim:WorkClaim,update:(job:Job,client:Client)=>Promise<void>,finish:boolean,modelEvidence?:RunEvidence,additionalInfluence?:()=>SecurityEnvelope|undefined,existingRun?:RunEvidence){
    const original=postgresWorkReference(claim);
    try{const committed=await this.db.run(async client=>{
      if(!await this.db.inspectClaim(original,this.policy)||!await postgresClaimSnapshotMatches(client,original,this.policy))return false;
      const before=await postgresWorkerAdmission(client,original.owner,original.job.id,this.policy),store=new PostgresTaskStorage(client,this.kernel);
      const current=await store.get(original.owner,original.job.id),request=current.delegation!.request.revision,revision=current.revision;
      if(modelEvidence)await postgresRecordModelResponse(client,original,modelEvidence);
      const previous=existingRun&&current.runs?.find(run=>run.id===existingRun.id);
      if(previous&&digest(previous)!==digest(existingRun))throw new DomainError('CONFLICT','Original model evidence changed');
      if(previous&&(finish||additionalInfluence))throw new Error('Evidence idempotency cannot skip a task or source transition');
      // A known identical receipt changes no task/output. Keep accounting and
      // every current claim/authority/commit fence, without rewriting all graph
      // projections or minting another output seal for that same response.
      if(!previous){
        const seal=await postgresPrepareWorkerSeal(client,original,this.policy,this.kernel,fence=>this.db.inspectClaim(fence,this.policy));
        await update(current,client);
        if(current.id!==original.job.id||current.revision!==revision||current.delegation?.request.revision!==request)throw new DomainError('CONFLICT','Worker cannot revise the owner request');
        const added=additionalInfluence?.(),outputSeal=added?(seal?combineEnvelopes([seal,added]):added):seal;
        await store.save(original.owner,current);
        if(outputSeal)await postgresRecordWorkerOutputs(client,original.owner,current,outputSeal);
      }
      const after=await postgresWorkerAdmission(client,original.owner,original.job.id,this.policy);
      if(digest(before)!==digest(after))throw new LostClaim();
      const q=`"${postgresBusinessSchema(client)}"`;
      const headers=await client.query(`SELECT 1 FROM ${q}.work_claims c JOIN ${q}.runtime_work_claims r ON r.job_id=c.job_id AND r.token=c.token
        WHERE c.job_id=$1 AND c.token=$2 AND c.revision=$3 AND r.authority_digest=$4`,[original.job.id,original.token,revision??0,postgresBusinessAuthorityDigest(client)]);
      const lease=await this.db.inspectClaim(original,this.policy);
      if(headers.rowCount!==1||!lease)throw new LostClaim();postgresRequireLeaseAtCommit(client,digest(original),()=>this.db.inspectClaim(original,this.policy));
      if(finish){await postgresRecordClaimRelease(client,original.owner,original.job.id,original.token);await client.query(`DELETE FROM ${q}.runtime_work_claims WHERE job_id=$1 AND token=$2`,[original.job.id,original.token]);}
      return true;
    });
      if(committed&&finish){try{await this.db.cleanupReleasedClaims();}catch{console.error('Committed Worker result retained; claim cleanup deferred to the next poll');}}
      return committed;
    }catch(error){if(error instanceof LostClaim)return false;throw error;}
  }
  checkpoint(claim:WorkClaim,update:(job:Job)=>void){return this.mutate(claim,update,false);}
  finish(claim:WorkClaim,update:(job:Job)=>void){return this.mutate(claim,update,true);}
  /** Host-owned graph command for real source initialization, mapping and
   * completion. The typed driver admits reads and source writes; its program
   * cannot receive a raw client or a synchronous store. Execute the model or
   * provider before this command, never inside the program. Job/graph/binding
   * writes and output seals share the original claim's fenced commit. */
  async project<T>(claim:WorkClaim,options:Omit<PostgresSourceProjectionOptions,'policyDigest'|'inspectClaim'|'builder'>,
    prepare:(context:PostgresWorkerProjectionContext)=>GraphProgram<T>,finish=false):Promise<{applied:false}|{applied:true;value:T}>{
    const configured=structuredClone(options);let value:T,influence:SecurityEnvelope|undefined;
    const applied=await this.mutateCurrent(claim,async(job,client)=>{
      const intents=await new PostgresTaskStorage(client,this.kernel).intents(claim.owner,job.id);
      await withPostgresSourceProjection(client,claim,{...configured,policyDigest:this.policy,builder:this.kernel,inspectClaim:fence=>this.db.inspectClaim(fence,this.policy)},async graph=>{
        const program=prepare({job,intents,request:structuredClone(graph.request),graph:{model:graph.model,now:graph.now,releaseRef:graph.releaseRef,security:true}});
        if(!program||typeof program.next!=='function'||typeof program.throw!=='function')throw new Error('Worker projection requires a synchronous graph program');
        value=await runGraphProgramAsync(graph,program);
      },approved=>{influence=influence?combineEnvelopes([influence,approved]):approved;});
    },finish,undefined,()=>influence);
    return applied?{applied:true,value:value!}:{applied:false};
  }
}
