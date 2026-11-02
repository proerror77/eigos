import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {DomainError,type Job,type Principal} from '../core/domain.js';
import type {WorkClaim} from '../core/store.js';
import {digest} from '../core/delegation.js';
import {scheduleTaskRecovery} from '../core/task-recovery.js';
import type {ActionIntent} from '../ontology/actions.js';
import {BACKEND_VERSION} from '../ontology/execution.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {SecurityError} from '../security/errors.js';
import type {PostgresDatabase} from './database.js';
import {postgresBusinessSchema,postgresBusinessAuthorityDigest,postgresConstrainReadDeadline} from './runtime-transaction.js';
import {postgresClaimActive,postgresWorkReference} from './work-claim.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import {PostgresTaskStorage} from './task-storage.js';
import {postgresWorkerRequest} from './worker-input.js';
import {postgresPrepareWorkerSeal,postgresRecordWorkerOutputs} from './worker-output.js';
import {withPostgresWorkerEvidenceAuthorization,type PostgresTaskReadAuthorization} from './task-output.js';
import type {PostgresTaskReadAdmission} from './task-read-access.js';

class LostClaim extends Error{}
/** Durable queue shared by Mac Workers. Each method releases its transaction
 * before the caller can run a model or contact a provider. */
export class PostgresWorkerStore {
  constructor(private readonly db:Pick<PostgresDatabase,'run'|'renewClaim'|'inspectClaim'>,private readonly policy:string,private readonly kernel?:StagedKernelBuilder){
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
    if(!await postgresClaimActive(client,claim,this.policy))return false;
    const admission=await postgresWorkerAdmission(client,claim.owner,claim.job.id,this.policy);
    return admission.authority.id===claim.securityAuthorityId&&admission.authority.authEpoch===claim.securityEpoch&&admission.policyRevision===claim.securityPolicyRevision;
  });}
  renew(claim:WorkClaim,leaseMs:number){return this.db.renewClaim(claim,leaseMs,this.policy);}
  readRequest(claim:WorkClaim,modelChannel:string){
    const reference=postgresWorkReference(claim);
    return this.db.run(client=>postgresWorkerRequest(client,reference,this.policy,modelChannel,this.kernel,fence=>this.db.inspectClaim(fence,this.policy)));
  }
  /** Host-side tool reads/receipt bookkeeping only. The callback must not run
   * models/providers or mutate task, policy or claim state. */
  readEvidence<T>(claim:WorkClaim,modelChannel:string,action:(authorization:PostgresTaskReadAuthorization,admission:PostgresTaskReadAdmission,
    principal:Principal,client:Client)=>Promise<T>):Promise<T>{
    const reference=postgresWorkReference(claim);
    return this.db.run(client=>withPostgresWorkerEvidenceAuthorization(client,reference,this.policy,
      (auth,admission,principal)=>action(auth,admission,principal,client),this.kernel,modelChannel,fence=>this.db.inspectClaim(fence,this.policy)));
  }
  private async mutate(claim:WorkClaim,update:(job:Job)=>void,finish:boolean){
    const original=postgresWorkReference(claim);
    try{return await this.db.run(async client=>{
      if(!await postgresClaimActive(client,original,this.policy))return false;
      const before=await postgresWorkerAdmission(client,original.owner,original.job.id,this.policy),store=new PostgresTaskStorage(client,this.kernel);
      const seal=await postgresPrepareWorkerSeal(client,original,this.policy,this.kernel);
      const current=await store.get(original.owner,original.job.id),request=current.delegation!.request.revision,revision=current.revision;
      const result:unknown=update(current);if(result&&typeof result==='object'&&'then'in result)throw new Error('Worker mutation callback must not perform asynchronous work');
      if(current.id!==original.job.id||current.revision!==revision||current.delegation?.request.revision!==request)throw new DomainError('CONFLICT','Worker cannot revise the owner request');
      await store.save(original.owner,current);
      if(seal)await postgresRecordWorkerOutputs(client,original.owner,current,seal);
      const after=await postgresWorkerAdmission(client,original.owner,original.job.id,this.policy);
      if(digest(before)!==digest(after))throw new LostClaim();
      const q=`"${postgresBusinessSchema(client)}"`;
      const lease=await client.query(`SELECT c.expires_at FROM ${q}.work_claims c JOIN ${q}.runtime_work_claims r ON r.job_id=c.job_id AND r.token=c.token
        WHERE c.job_id=$1 AND c.token=$2 AND c.revision=$3 AND c.expires_at>$4 AND r.authority_digest=$5`,[original.job.id,original.token,revision??0,Date.now(),postgresBusinessAuthorityDigest(client)]);
      if(lease.rowCount!==1)throw new LostClaim();postgresConstrainReadDeadline(client,Number(lease.rows[0].expires_at));
      if(finish){await client.query(`DELETE FROM ${q}.runtime_work_claims WHERE job_id=$1 AND token=$2`,[original.job.id,original.token]);await client.query(`DELETE FROM ${q}.work_claims WHERE job_id=$1 AND token=$2`,[original.job.id,original.token]);}
      return true;
    });}catch(error){if(error instanceof LostClaim)return false;throw error;}
  }
  checkpoint(claim:WorkClaim,update:(job:Job)=>void){return this.mutate(claim,update,false);}
  finish(claim:WorkClaim,update:(job:Job)=>void){return this.mutate(claim,update,true);}
}
