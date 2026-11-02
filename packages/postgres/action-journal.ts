import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {DomainError,type Job} from '../core/domain.js';
import {digest} from '../core/delegation.js';
import type {ActionIntent,ActionResult,ExecutionAttempt,PlanGrant} from '../ontology/actions.js';
import {moneySchema} from '../ontology/execution.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {SecurityError} from '../security/errors.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresBusinessAuthorityDigest,postgresConstrainReadDeadline,postgresRequireLeaseAtCommit} from './runtime-transaction.js';
import {postgresClaimSnapshotMatches,postgresWorkReference,type PostgresWorkReference} from './work-claim.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import {PostgresTaskStorage} from './task-storage.js';
import {postgresPrepareWorkerSeal,postgresRecordWorkerOutputs} from './worker-output.js';
import {postgresRecordClaimRelease} from './claim-release.js';

type JournalOperation = 'create'|'dispatch'|'observe'|'reconcile'|'resume'|'budget'|'accept';
/** New operations cannot arrive with invented execution or acceptance state. */
export function assertFreshPostgresActionIntent(intent:ActionIntent):void{
  const initial=new Set(['id','owner','jobId','stepId','businessOperationKey','planDigest','bindingRef','inputDigest','privateDigest','privateData','effect','additionalEffects','state','nextAt','createdAt']);
  if(intent.state!=='ready'||intent.nextAt!==0||Object.keys(intent).some(key=>!initial.has(key)))throw new SecurityError('POLICY_CHANGED','A new action must be ready without a manufactured result or attempt');
  if(intent.privateDigest!==digest(intent.privateData))throw new SecurityError('POLICY_CHANGED','The actual private input differs from its original digest');
}

export interface PostgresActionJournalOptions {
  policyDigest:string;
  inspectClaim:(claim:PostgresWorkReference)=>Promise<{validUntil:number}|undefined>;
  /** Trusted, storage-only policy port. It must check the current sealed plan,
   * binding, effect and exact durable grant (and verify an acceptance result).
   * A Worker claim alone is deliberately insufficient. Never run provider or
   * model work here, or extend a permission deadline during this check. */
  authorize:(input:{operation:JournalOperation;claim:PostgresWorkReference;job:Job;intent:ActionIntent;grant?:PlanGrant;attempt?:ExecutionAttempt;result?:ActionResult;verified?:boolean})=>Promise<{validUntil:number}>;
  builder?:StagedKernelBuilder;
}
export interface PostgresPreparedObservation {id:string;applied:false}
export interface PostgresObservationAcceptance {
  claim:PostgresWorkReference;
  /** Run the actual validated mapper/projection acceptance against this same
   * transaction. Do not perform external I/O. Job and intent changes are saved
   * by the journal only after this callback succeeds. */
  apply:(job:Job,intent:ActionIntent)=>Promise<void>;
}

/** Transaction-local journal, not a SecurityStore or an executor. All callers
 * must use the shared business transaction. A dispatch is durable before any
 * external I/O, and is never automatically retried. Prepared receipts are audit
 * evidence; only commitObservation can mark one applied. */
export class PostgresActionJournal {
  private readonly schema:string;
  private readonly token:object;
  private readonly store:PostgresTaskStorage;
  constructor(private readonly client:Client,private readonly options:PostgresActionJournalOptions){
    this.schema=postgresBusinessSchema(client);this.token=postgresBusinessToken(client);
    if(!/^[a-f0-9]{64}$/.test(options.policyDigest)||typeof options.authorize!=='function'||typeof options.inspectClaim!=='function')throw new Error('Explicit action policy and lease inspection are required');
    this.store=new PostgresTaskStorage(client,options.builder);
  }
  private async query(sql:string,values:unknown[]=[]){
    if(postgresBusinessToken(this.client)!==this.token)throw new SecurityError('AUTHORIZATION_REQUIRED');
    const result=await this.client.query(sql,values);
    if(postgresBusinessToken(this.client)!==this.token)throw new SecurityError('AUTHORIZATION_REQUIRED');
    return result;
  }
  private async atomic<T>(action:()=>Promise<T>):Promise<T>{
    const name=`journal_${randomUUID().replaceAll('-','')}`;await this.query(`SAVEPOINT ${name}`);
    try{const result=await action();await this.query(`RELEASE SAVEPOINT ${name}`);return result;}
    catch(error){await this.query(`ROLLBACK TO SAVEPOINT ${name}`);await this.query(`RELEASE SAVEPOINT ${name}`);throw error;}
  }
  private async json(value:unknown):Promise<string>{
    const body=JSON.stringify(value);
    if(typeof body!=='string'||Buffer.byteLength(body)>8388608)throw new DomainError('INVALID_INPUT','Journal JSON exceeds its runtime bound');
    if((await this.query(`SELECT "${this.schema}".eigos_try_jsonb($1::text) IS NOT NULL AS valid`,[body])).rows[0]?.valid!==true)throw new DomainError('INVALID_INPUT','Journal JSON is not representable in PostgreSQL');
    return body;
  }
  private async fence(claim:PostgresWorkReference):Promise<void>{
    if(!await postgresClaimSnapshotMatches(this.client,claim,this.options.policyDigest)||!await this.options.inspectClaim(claim))throw new SecurityError('ACCESS_REVOKED');
    await postgresWorkerAdmission(this.client,claim.owner,claim.job.id,this.options.policyDigest);
    postgresRequireLeaseAtCommit(this.client,digest(claim),()=>this.options.inspectClaim(claim));
  }
  private async commitFence(claim:PostgresWorkReference):Promise<void>{
    // Acceptance may finish the Job. Preserve its exact claim/revision without
    // requiring the newly saved terminal Job to remain in the working state.
    const q=`"${this.schema}"`,headers=await this.query(`SELECT 1 FROM ${q}.work_claims c JOIN ${q}.runtime_work_claims r ON r.job_id=c.job_id AND r.token=c.token
      WHERE c.job_id=$1 AND c.token=$2 AND c.revision=$3 AND r.authority_digest=$4`,[claim.job.id,claim.token,claim.job.revision??0,postgresBusinessAuthorityDigest(this.client)]);
    const job=await this.store.get(claim.owner,claim.job.id),scope=await postgresWorkerAdmission(this.client,claim.owner,claim.job.id,this.options.policyDigest);
    if(headers.rowCount!==1||(job.revision??0)!==(claim.job.revision??0)||job.delegation?.request.revision!==claim.job.delegation?.request.revision
      ||scope.authority.id!==claim.securityAuthorityId||scope.authority.authEpoch!==claim.securityEpoch||scope.policyRevision!==claim.securityPolicyRevision||!await this.options.inspectClaim(claim))throw new SecurityError('ACCESS_REVOKED');
    postgresRequireLeaseAtCommit(this.client,digest(claim),()=>this.options.inspectClaim(claim));
  }
  private async authorize(operation:JournalOperation,claim:PostgresWorkReference,intent:ActionIntent,extra:{grant?:PlanGrant;attempt?:ExecutionAttempt;result?:ActionResult;verified?:boolean}={}):Promise<Job>{
    if(claim.owner!==intent.owner||claim.job.id!==intent.jobId)throw new DomainError('FORBIDDEN','Action belongs to another task');
    await this.fence(claim);const job=await this.store.get(claim.owner,claim.job.id);
    const permit=await this.options.authorize(structuredClone({operation,claim,job,intent,...extra}));
    postgresConstrainReadDeadline(this.client,permit.validUntil);await this.fence(claim);return job;
  }
  async intent(owner:string,id:string):Promise<ActionIntent>{
    const rows=await this.query(`SELECT id,job_id,business_key,state,
      CASE WHEN octet_length(body)<=8388608 THEN body END AS body,
      CASE WHEN octet_length(private_data)<=8388608 THEN private_data END AS private_data
      FROM "${this.schema}".action_intents WHERE owner=$1 AND id=$2 LIMIT 2`,[owner,id]);
    if(!rows.rowCount)throw new DomainError('NOT_FOUND','Action intent not found');
    const row=rows.rows[0];if(rows.rowCount!==1||typeof row.body!=='string'||typeof row.private_data!=='string')throw new DomainError('CONFLICT','Stored intent exceeds its safe read bound');
    const intent=JSON.parse(row.body) as ActionIntent;
    if(intent.id!==id||intent.owner!==owner||intent.jobId!==row.job_id||intent.businessOperationKey!==row.business_key)throw new DomainError('CONFLICT','Stored intent identity is invalid');
    await this.store.get(owner,intent.jobId);return {...intent,state:row.state,privateData:JSON.parse(row.private_data)};
  }
  async intentByBusinessKey(owner:string,businessKey:string):Promise<ActionIntent|undefined>{
    const rows=await this.query(`SELECT id FROM "${this.schema}".action_intents WHERE owner=$1 AND business_key=$2 LIMIT 2`,[owner,businessKey]);
    if(rows.rows.length>1)throw new DomainError('CONFLICT','Business operation identity is ambiguous');
    return rows.rowCount?this.intent(owner,String(rows.rows[0].id)):undefined;
  }
  async createIntent(input:PostgresWorkReference,supplied:ActionIntent):Promise<string>{
    const claim=postgresWorkReference(input),intent=structuredClone(supplied);assertFreshPostgresActionIntent(intent);
    return this.atomic(async()=>{
      const job=await this.authorize('create',claim,intent),previous=await this.intentByBusinessKey(claim.owner,intent.businessOperationKey),q=`"${this.schema}"`;
      if(previous){
        if(previous.jobId!==intent.jobId||!['local','read'].includes(previous.effect)||!['local','read'].includes(intent.effect)||!['rejected','effect_confirmed','needs_review'].includes(previous.state))throw new DomainError('CONFLICT','Business operation already exists; reconcile its original intent');
        await this.query(`INSERT INTO ${q}.action_intent_versions(intent_id,owner,plan_digest,body) VALUES($1,$2,$3,$4) ON CONFLICT(intent_id,plan_digest) DO NOTHING`,[previous.id,claim.owner,previous.planDigest,await this.json(previous)]);
        intent.id=previous.id;
      }
      const {privateData,...body}=intent,text=await this.json(body),secret=await this.json(privateData??null);
      if(previous)await this.query(`UPDATE ${q}.action_intents SET state=$1,private_data=$2,body=$3 WHERE owner=$4 AND id=$5`,[intent.state,secret,text,claim.owner,intent.id]);
      else await this.query(`INSERT INTO ${q}.action_intents(id,owner,job_id,business_key,state,private_data,body) VALUES($1,$2,$3,$4,$5,$6,$7)`,[intent.id,claim.owner,intent.jobId,intent.businessOperationKey,intent.state,secret,text]);
      await this.store.save(claim.owner,job);await this.fence(claim);return intent.id;
    });
  }
  async attempts(owner:string,intentId:string):Promise<ExecutionAttempt[]>{
    await this.intent(owner,intentId);
    const rows=await this.query(`SELECT id,CASE WHEN octet_length(body)<=8388608 AND sum(octet_length(body)) OVER()<=33554432 THEN body END AS body
      FROM "${this.schema}".action_attempts WHERE owner=$1 AND intent_id=$2 ORDER BY __eigos_rowid LIMIT 2001`,[owner,intentId]);
    if(rows.rows.length>2000||rows.rows.some(row=>typeof row.body!=='string'))throw new DomainError('CONFLICT','Action attempts exceed their safe read bound');
    return rows.rows.map(row=>{const attempt=JSON.parse(row.body) as ExecutionAttempt;
      if(attempt.id!==row.id||attempt.intentId!==intentId||!Number.isSafeInteger(attempt.ordinal)||attempt.ordinal<1)throw new DomainError('CONFLICT','Stored attempt identity is invalid');return attempt;});
  }
  async startAttempt(input:PostgresWorkReference,intentId:string,kind:ExecutionAttempt['kind'],inputDigest:string,requestKey?:string,submission?:ExecutionAttempt['submission'],authorizationId?:string,budget?:{grant:PlanGrant;amount:{minor:string;currency:string}}):Promise<ExecutionAttempt>{
    const claim=postgresWorkReference(input),captured=structuredClone({submission,budget});
    return this.atomic(async()=>{
      const intent=await this.intent(claim.owner,intentId);
      if(kind==='dispatch'){
        if(intent.state!=='ready')throw new DomainError('CONFLICT','Started action must be reconciled; automatic replay is prohibited');
        if(captured.budget)await this.reserveBudget(claim,intentId,captured.budget.grant,captured.budget.amount);
      }else if(intent.state==='ready'||intent.state==='canceled_before_dispatch')throw new DomainError('CONFLICT','Action has not been dispatched');
      const attempts=await this.attempts(claim.owner,intentId);
      const attempt:ExecutionAttempt={id:randomUUID(),intentId,kind,requestKey:requestKey??(kind==='dispatch'?intent.businessOperationKey:randomUUID()),startedAt:new Date().toISOString(),
        claimToken:claim.token,requestRevision:claim.job.revision??0,inputDigest,planDigest:intent.planDigest,ordinal:attempts.length+1,
        ...(captured.submission?{submission:captured.submission}:{}),...(authorizationId?{authorizationId}:{})};
      await this.authorize(kind,claim,intent,{attempt,...(captured.budget?{grant:captured.budget.grant}:{})});
      if(kind==='dispatch')intent.state='dispatching';
      await this.query(`INSERT INTO "${this.schema}".action_attempts(id,owner,intent_id,body) VALUES($1,$2,$3,$4)`,[attempt.id,claim.owner,intentId,await this.json(attempt)]);
      await this.store.saveIntent(claim.owner,intent);await this.fence(claim);return attempt;
    });
  }
  async reserveBudget(input:PostgresWorkReference,intentId:string,supplied:PlanGrant,amountInput:{minor:string;currency:string}):Promise<void>{
    const claim=postgresWorkReference(input),grant=structuredClone(supplied),amount=moneySchema.parse(amountInput);
    return this.atomic(async()=>{
      if(grant.kind==='object_write'||grant.kind==='external_draft')throw new DomainError('FORBIDDEN','Nonfinancial authority has no financial budget');
      moneySchema.parse(grant.maxAmount);const intent=await this.intent(claim.owner,intentId),job=await this.authorize('budget',claim,intent,{grant}),composed=!!job.delegation?.agent?.composition,q=`"${this.schema}"`;
      if(grant.owner!==claim.owner||grant.jobId!==intent.jobId||grant.planDigest!==intent.planDigest||grant.revoked||!Number.isFinite(Date.parse(grant.expiresAt))||Date.parse(grant.expiresAt)<=Date.now()
        ||!grant.bindingRefs.some(ref=>digest(ref)===digest(intent.bindingRef))||amount.currency!==grant.maxAmount.currency||BigInt(amount.minor)>BigInt(grant.maxAmount.minor))throw new DomainError('FORBIDDEN','Exact action budget exceeds its current grant');
      postgresConstrainReadDeadline(this.client,Date.parse(grant.expiresAt));
      const durable=await this.query(`SELECT CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.plan_grants WHERE id=$1 AND owner=$2 AND job_id=$3 LIMIT 2`,[grant.id,claim.owner,intent.jobId]);
      if(durable.rowCount!==1||typeof durable.rows[0].body!=='string'||digest(JSON.parse(durable.rows[0].body))!==digest(grant))throw new DomainError('FORBIDDEN','The current durable action grant is missing or changed');
      const plan=composed?job.delegation!.agent!.plans.find(plan=>plan.digest===intent.planDigest):undefined,step=plan?.steps.find(step=>step.intentId===intentId);
      if(composed&&(!step?.binding||digest(step.cost&&{minor:step.cost.minor,currency:step.cost.currency})!==digest(amount)||digest(step.budgetImpact??null)!==digest(grant.budgetImpact??null)))throw new DomainError('CONFLICT','Budget reservation differs from the sealed action');
      const exposure=moneySchema.parse(step?.budgetImpact?.amount??amount),role=step?.budgetImpact?.role??'service_total';
      const keyFor=(role:string,key:string)=>digest({owner:claim.owner,requestId:intent.jobId,program:step!.binding!.programRef,configuration:step!.binding!.configurationDigest,role,key});
      const economicKey=composed?keyFor(role,step!.budgetImpact?.key??intent.businessOperationKey):undefined;
      const additional=composed?(step!.budgetImpact?.additional??[]).map(value=>({key:keyFor(value.role,value.key),...moneySchema.parse(value.amount),role:value.role})):[];
      if(new Set([economicKey,...additional.map(value=>value.key)]).size!==additional.length+1)throw new DomainError('CONFLICT','One operation repeats an economic obligation');
      const previous=(await this.query(`SELECT * FROM ${q}.budget_reservations WHERE intent_id=$1`,[intentId])).rows[0];
      if(previous){
        if(previous.owner!==claim.owner||previous.grant_id!==grant.id||previous.minor!==exposure.minor||previous.currency!==exposure.currency||(previous.economic_key??undefined)!==economicKey||(previous.role??null)!==(composed?role:null)||digest(JSON.parse(previous.additional_impacts??'[]'))!==digest(additional)||previous.state==='released')throw new DomainError('CONFLICT','Original budget reservation cannot be reinterpreted or reopened');return;
      }
      const rows=(await this.query(`SELECT b.intent_id,b.minor,b.currency,b.economic_key,b.role,b.additional_impacts FROM ${q}.budget_reservations b JOIN ${q}.action_intents i ON i.id=b.intent_id AND i.owner=b.owner
        WHERE b.owner=$1 AND i.job_id=$2 AND b.state IN('held','consumed') LIMIT 2001`,[claim.owner,intent.jobId])).rows;
      if(rows.length>2000)throw new DomainError('CONFLICT','Task budget exceeds its safe read bound');
      if(composed){
        const proposed=[...rows.map(row=>({key:String(row.economic_key??row.intent_id),minor:String(row.minor),currency:String(row.currency),role:String(row.role??'service_total')})),
          {key:economicKey!,...exposure,role},...additional,...rows.flatMap(row=>JSON.parse(String(row.additional_impacts??'[]')) as {key:string;minor:string;currency:string;role:string}[])];
        const groups=new Map<string,typeof proposed[number]>();
        for(const row of proposed){moneySchema.parse({minor:row.minor,currency:row.currency});const prior=groups.get(row.key);
          if(prior&&(prior.currency!==row.currency||prior.role!==row.role))throw new DomainError('CONFLICT','Economic commitment currency or role changed');
          if(!prior||BigInt(row.minor)>BigInt(prior.minor))groups.set(row.key,row);}
        for(const requirement of [...job.delegation!.request.requirements,...(job.delegation!.request.successCriteria??[])])if(requirement.kind==='budget'&&requirement.strength==='hard'){
          const selected=[...groups.values()].filter(row=>row.role===(requirement.role??'service_total'));
          if(selected.some(row=>row.currency!==requirement.expected.currency&&BigInt(row.minor)!==0n)||selected.reduce((sum,row)=>sum+BigInt(row.minor),0n)>BigInt(requirement.expected.minor))throw new DomainError('FORBIDDEN','Cumulative task commitments exceed the fixed task budget');
        }
      }else if(rows.some(row=>row.currency!==amount.currency)||rows.reduce((sum,row)=>sum+BigInt(String(row.minor)),0n)+BigInt(amount.minor)>BigInt(grant.maxAmount.minor))throw new DomainError('FORBIDDEN','Cumulative action budget exceeds the grant');
      await this.query(`INSERT INTO ${q}.budget_reservations(intent_id,owner,grant_id,minor,currency,state,economic_key,role,additional_impacts) VALUES($1,$2,$3,$4,$5,'held',$6,$7,$8)`,[intentId,claim.owner,grant.id,exposure.minor,exposure.currency,economicKey??null,composed?role:null,additional.length?await this.json(additional):null]);
      await this.fence(claim);
    });
  }
  /** Persist provider receipt without advancing task, mapper or intent state.
   * This is safe after a lost lease. The exact original attempt is mandatory. */
  async recordObservation(owner:string,intentId:string,attemptId:string,supplied:ActionResult):Promise<PostgresPreparedObservation>{
    const result=structuredClone(supplied);
    return this.atomic(async()=>{
      await this.intent(owner,intentId);const attempt=(await this.attempts(owner,intentId)).find(attempt=>attempt.id===attemptId);
      if(!attempt)throw new DomainError('FORBIDDEN','Observation has no owned attempt');
      if(!result.eventId||result.eventId.length>2000||!Number.isSafeInteger(result.sourceVersion)||result.sourceVersion<0)throw new DomainError('INVALID_INPUT','Observation requires a stable event and source version');
      const body=await this.json(result),hash=digest(result),q=`"${this.schema}"`;
      const existing=(await this.query(`SELECT id,digest FROM ${q}.action_observations WHERE owner=$1 AND intent_id=$2 AND event_id=$3`,[owner,intentId,result.eventId])).rows[0];
      if(existing&&existing.digest===hash)return {id:String(existing.id),applied:false};
      const event=existing?`${result.eventId}:conflict:${hash}`:result.eventId;
      const prior=existing?(await this.query(`SELECT id FROM ${q}.action_observations WHERE owner=$1 AND intent_id=$2 AND event_id=$3`,[owner,intentId,event])).rows[0]:undefined;
      if(prior)return {id:String(prior.id),applied:false};
      const id=randomUUID();await this.query(`INSERT INTO ${q}.action_observations(id,owner,intent_id,event_id,attempt_id,received_at,digest,applied,body) VALUES($1,$2,$3,$4,$5,$6,$7,0,$8)`,[id,owner,intentId,event,attemptId,new Date().toISOString(),hash,body]);
      return {id,applied:false};
    });
  }
  async commitObservation(intentId:string,id:string,verified:boolean,acceptance:PostgresObservationAcceptance):Promise<{id:string;applied:boolean}>{
    const claim=postgresWorkReference(acceptance.claim);
    return this.atomic(async()=>{
      const intent=await this.intent(claim.owner,intentId),q=`"${this.schema}"`;
      const rows=await this.query(`SELECT attempt_id,event_id,digest,applied,CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.action_observations WHERE owner=$1 AND intent_id=$2 AND id=$3 LIMIT 2`,[claim.owner,intentId,id]);
      if(rows.rowCount!==1||typeof rows.rows[0].body!=='string')throw new DomainError('NOT_FOUND','Observation not found');
      const row=rows.rows[0],result=JSON.parse(row.body) as ActionResult,attempt=(await this.attempts(claim.owner,intentId)).find(attempt=>attempt.id===row.attempt_id);
      if(!attempt||attempt.claimToken!==claim.token||attempt.requestRevision!==(claim.job.revision??0)||intent.jobId!==claim.job.id)throw new SecurityError('ACCESS_REVOKED');
      const job=await this.authorize('accept',claim,intent,{result,verified,attempt});
      if(Number(row.applied)===1)return {id,applied:false};
      if(digest(result)!==row.digest)throw new DomainError('CONFLICT','Stored observation digest is invalid');
      const comparable=(value:ActionResult)=>digest({kind:value.kind,remoteRef:value.remoteRef,output:value.output,business:value.business,delivery:value.delivery});
      const stale=attempt.planDigest!==intent.planDigest||result.kind==='unknown'&&(intent.lastAppliedAttemptOrdinal??0)>attempt.ordinal||result.kind!=='unknown'&&intent.latestVersion!==undefined&&result.sourceVersion<intent.latestVersion;
      const conflict=row.event_id!==result.eventId||!stale&&intent.latestVersion===result.sourceVersion&&intent.lastVerifiedResult&&result.kind!=='unknown'&&comparable(intent.lastVerifiedResult)!==comparable(result);
      if(stale)return {id,applied:false};
      if(conflict||!verified&&result.kind!=='unknown'){
        intent.state='needs_review';await this.store.saveIntent(claim.owner,intent);await this.fence(claim);return {id,applied:false};
      }
      if(result.kind!=='unknown')intent.latestVersion=result.sourceVersion;
      if(verified&&result.kind!=='unknown'){intent.lastVerifiedResult=result;intent.needsObservation=false;}
      intent.lastAppliedAttemptOrdinal=Math.max(intent.lastAppliedAttemptOrdinal??0,attempt.ordinal);intent.latestObservationId=id;intent.lastResult=result;
      if(verified&&result.kind!=='unknown'&&result.business)intent.businessSnapshot={value:result.business,sourceVersion:result.sourceVersion,evidenceRefs:result.evidenceRefs};
      if(verified&&result.remoteRef)intent.remoteRef=result.remoteRef;
      intent.state=result.kind==='confirmed'?'effect_confirmed':result.kind==='rejected'?'rejected':result.kind==='unknown'?'effect_unknown':result.kind==='not_found'?'needs_review':'awaiting_remote';
      intent.nextAt=Date.now()+Math.min(60000,Math.max(100,result.retryAfterMs??1000));
      if(verified&&result.kind==='confirmed'){intent.acceptedOutput=result.output??(result.remoteRef?{remoteRef:result.remoteRef}:{});if(result.delivery)intent.delivery=result.delivery;}
      intent.failedQueries=result.kind==='unknown'?(intent.failedQueries??0)+1:0;if(intent.failedQueries>=3)intent.state='needs_review';
      const jobIdentity=(value:Job)=>digest({id:value.id,contextId:value.contextId,service:value.service,goal:value.goal,revision:value.revision,request:value.delegation?.request});
      const identity=jobIdentity(job);
      const intentIdentity=(value:ActionIntent)=>digest({id:value.id,owner:value.owner,jobId:value.jobId,stepId:value.stepId,key:value.businessOperationKey,plan:value.planDigest,
        binding:value.bindingRef,input:value.inputDigest,dispatchInput:value.dispatchInput,private:value.privateDigest,privateData:value.privateData,effect:value.effect,additional:value.additionalEffects,created:value.createdAt});
      const originalIntent=intentIdentity(intent);
      await acceptance.apply(job,intent);
      if(identity!==jobIdentity(job)||intentIdentity(intent)!==originalIntent)throw new DomainError('CONFLICT','Observation cannot revise its original task or action');
      const seal=await postgresPrepareWorkerSeal(this.client,claim,this.options.policyDigest,this.options.builder,this.options.inspectClaim);
      await this.fence(claim);
      if(verified&&result.kind==='confirmed'&&(intent.effect==='payment'||intent.additionalEffects?.includes('payment')))await this.query(`UPDATE ${q}.budget_reservations SET state='consumed' WHERE owner=$1 AND intent_id=$2`,[claim.owner,intentId]);
      if(verified&&result.kind==='rejected')await this.query(`UPDATE ${q}.budget_reservations SET state='released' WHERE owner=$1 AND intent_id=$2 AND state='held'`,[claim.owner,intentId]);
      // Mark before projection so its ledger sees the accepted receipt. A later
      // mapper, projection, save, or final lease failure rolls the whole unit back.
      await this.query(`UPDATE ${q}.action_observations SET applied=1 WHERE owner=$1 AND intent_id=$2 AND id=$3 AND applied=0`,[claim.owner,intentId,id]);
      await this.store.saveIntent(claim.owner,intent);await this.store.save(claim.owner,job);
      if(seal)await postgresRecordWorkerOutputs(this.client,claim.owner,job,seal);
      await this.commitFence(claim);
      if(!['submitted','working'].includes(job.state)){
        await postgresRecordClaimRelease(this.client,claim.owner,job.id,claim.token);
        await this.query(`DELETE FROM ${q}.runtime_work_claims WHERE job_id=$1 AND token=$2`,[job.id,claim.token]);
      }
      return {id,applied:true};
    });
  }
}
