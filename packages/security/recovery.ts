import type {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {DomainError,type Job} from '../core/domain.js';
import type {ActionIntent,ExecutionAttempt} from '../ontology/actions.js';
import type {Ref} from '../ontology/execution.js';
import {SecurityError,type SecurityStore} from './store.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {withoutAuthorization} from './context.js';

/** A recovery observer receives only the original operation's locator. No
 * graph, model, current request text, execution permit, or dispatch callback. */
export interface OriginalOperation {
  owner:string; taskId:string; intentId:string; operationKey:string; remoteRef?:string;
  action:string; programRef:Ref; programDigest:string; originalDispatchAt:string;
}
export const recoveryObservationSchema=z.strictObject({operationKey:z.string().min(1).max(500),remoteRef:z.string().min(1).max(500).optional(),
  state:z.enum(['confirmed','rejected','unknown']),observedAt:z.iso.datetime({offset:true}),evidenceDigest:z.string().regex(/^[a-f0-9]{64}$/)});
export type RecoveryObservation=z.infer<typeof recoveryObservationSchema>;
interface RecoveryPermit extends OriginalOperation {
  id:string; memberId:string; installationId:string; parentGrant:{id:string;revision:number};authEpoch:number;sourceBindingId:string;
  policyRevision:number;expiresAt:number;issuedAt:number;
}
export interface RecoveryWork {permit:RecoveryPermit;token:string;attempt:ExecutionAttempt}
const contexts=new AsyncLocalStorage<{work:RecoveryWork;security:SecurityStore;assertCurrent:()=>void}>();
export function withRecovery<T>(work:RecoveryWork,security:SecurityStore,assertCurrent:()=>void,action:()=>T):T {
  return withoutAuthorization(()=>contexts.run({work,security,assertCurrent},action));
}
export function requireRecovery(operation:OriginalOperation,security?:SecurityStore) {
  const scope=contexts.getStore();
  if(!scope || !security?.enabled || scope.security!==security || ['owner','taskId','intentId','operationKey','remoteRef','action','programDigest','originalDispatchAt'].some(key=>operation[key as keyof OriginalOperation]!==scope.work.permit[key as keyof OriginalOperation])
    || digest(operation.programRef)!==digest(scope.work.permit.programRef)) throw new SecurityError('AUTHORIZATION_REQUIRED');
  scope.assertCurrent();
}
export function recoverySourceCredential(operation:OriginalOperation) {
  const scope=contexts.getStore();requireRecovery(operation,scope?.security);
  return {id:scope!.work.permit.id,token:scope!.work.token};
}

export class RecoveryStore {
  constructor(private db:DatabaseSync,private security:SecurityStore,readOnly=false) {
    if(readOnly)return;
    db.exec(`CREATE TABLE IF NOT EXISTS security_recoveries(id TEXT PRIMARY KEY,owner TEXT NOT NULL,task_id TEXT NOT NULL,intent_id TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,next_at INTEGER NOT NULL,token TEXT,lease_until INTEGER NOT NULL,body TEXT NOT NULL,result TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS security_active_recovery ON security_recoveries(intent_id) WHERE state IN ('pending','running');`);
  }
  private original(owner:string,intentId:string) {
    const row=this.db.prepare('SELECT body FROM action_intents WHERE owner=? AND id=?').get(owner,intentId);
    if(!row) throw new DomainError('NOT_FOUND','Original operation not found');
    const intent=JSON.parse(String(row.body)) as ActionIntent;
    const jobRow=this.db.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(owner,intent.jobId);
    const job=jobRow?JSON.parse(String(jobRow.body)) as Job:undefined;
    const states=[...(job?.delegation?.agent?[job.delegation.agent]:[]),...(job?.delegation?.agentHistory??[])];
    const plan=states.flatMap(s=>s.plans).find(p=>p.digest===intent.planDigest),step=plan?.steps.find(s=>s.intentId===intentId);
    const attempts=this.db.prepare('SELECT body FROM action_attempts WHERE owner=? AND intent_id=? ORDER BY rowid').all(owner,intentId).map(r=>JSON.parse(String(r.body)) as ExecutionAttempt);
    const dispatch=attempts.find(a=>a.kind==='dispatch');
    if(!plan || !step || !dispatch || !['effect_unknown','awaiting_remote','dispatching','needs_review'].includes(intent.state) || ['read','local'].includes(intent.effect)) throw new DomainError('CONFLICT','No unresolved dispatched business operation');
    const operation:OriginalOperation={owner,taskId:intent.jobId,intentId,operationKey:intent.businessOperationKey,...(intent.remoteRef?{remoteRef:intent.remoteRef}:{}),
      action:step.action,programRef:plan.programRef,programDigest:plan.programDigest,originalDispatchAt:dispatch.startedAt};
    return {operation,intent,attempts,digest:digest({operation,planDigest:intent.planDigest,state:intent.state})};
  }
  preview(owner:string,taskId:string) {
    return this.db.prepare('SELECT id FROM action_intents WHERE owner=? AND job_id=?').all(owner,taskId).flatMap(row=>{
      try {const value=this.original(owner,String(row.id));return [{intentId:value.operation.intentId,action:value.operation.action,effect:value.intent.effect,
        programId:value.operation.programRef.id,originalDispatchAt:value.operation.originalDispatchAt,expectedIntentDigest:value.digest,mode:'audit_only'}];} catch{return [];}
    });
  }
  approve(owner:string,memberId:string,input:unknown) {
    const args=z.strictObject({intentId:z.uuid(),installationId:z.uuid(),expectedIntentDigest:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.iso.datetime({offset:true})}).parse(input);
    return this.security.atomic(()=>{
      const original=this.original(owner,args.intentId),subject=this.security.requireSubject(args.installationId),parent=this.security.agentGrant(args.installationId);
      if(subject.ownerKey!==owner || subject.memberId!==memberId || original.digest!==args.expectedIntentDigest) throw new SecurityError('POLICY_CHANGED');
      const source=this.security.policies.sources(owner,args.installationId).find(s=>s.programId===original.operation.programRef.id && s.programDigest===original.operation.programDigest && s.operations.includes('recover_original'));
      const expiry=Date.parse(args.expiresAt);
      if(!source || !this.security.policies.resourceAllowedFor(memberId,subject.installationId,'actionType',original.operation.action)
        || !parent.sourceBindingIds.includes(source.bindingId) || !parent.capabilityIds.includes(source.programId) || expiry<=this.security.now()
        || expiry>Math.min(this.security.now()+3600000,Date.parse(parent.expiresAt),Date.parse(source.expiresAt))) throw new SecurityError('SOURCE_NOT_AUTHORIZED');
      const permit:RecoveryPermit={...original.operation,id:randomUUID(),memberId,installationId:subject.installationId,authEpoch:subject.epoch,
        parentGrant:{id:parent.id,revision:parent.revision},sourceBindingId:source.bindingId,policyRevision:this.security.policies.revision(),issuedAt:this.security.now(),expiresAt:expiry};
      this.db.prepare("INSERT INTO security_recoveries VALUES(?,?,?,?,'pending',0,0,NULL,0,?,NULL)").run(permit.id,owner,permit.taskId,permit.intentId,JSON.stringify(permit));
      return {id:permit.id,taskId:permit.taskId,intentId:permit.intentId,mode:'audit_only',expiresAt:args.expiresAt};
    });
  }
  private eligible(p:RecoveryPermit) {
    const subject=this.security.requireSubject(p.installationId,p.authEpoch),parent=this.security.agentGrant(p.installationId);
    if(subject.ownerKey!==p.owner || subject.memberId!==p.memberId || parent.id!==p.parentGrant.id || parent.revision!==p.parentGrant.revision
      || p.expiresAt<=this.security.now() || p.policyRevision!==this.security.policies.revision()
      || !this.security.policies.resourceAllowedFor(p.memberId,p.installationId,'actionType',p.action)
      || !this.security.policies.sources(p.owner,p.installationId).some(s=>s.bindingId===p.sourceBindingId && s.programId===p.programRef.id && s.programDigest===p.programDigest && s.operations.includes('recover_original'))) throw new SecurityError('SOURCE_NOT_AUTHORIZED');
  }
  claim():RecoveryWork|undefined {
    return this.security.atomic(()=>{
      const now=this.security.now();
      // Expired observers never replay a business dispatch. Retry only the same
      // bounded read, with a fixed maximum of three attempts.
      this.db.prepare("UPDATE security_recoveries SET state=CASE WHEN attempts<3 THEN 'pending' ELSE 'unknown' END,token=NULL,lease_until=0 WHERE state='running' AND lease_until<=?").run(now);
      const active=Number(this.db.prepare("SELECT (SELECT count(*) FROM work_claims WHERE expires_at>?)+(SELECT count(*) FROM security_recoveries WHERE state='running' AND lease_until>?) AS n").get(now,now)?.n??0);
      if(active>=2) return;
      const rows=this.db.prepare("SELECT body,attempts FROM security_recoveries WHERE state='pending' AND next_at<=? ORDER BY rowid LIMIT 20").all(now);
      for(const row of rows) {
        const permit=JSON.parse(String(row.body)) as RecoveryPermit;
        try{this.eligible(permit);this.original(permit.owner,permit.intentId);}catch{this.db.prepare("UPDATE security_recoveries SET state='unknown' WHERE id=?").run(permit.id);continue;}
        const original=this.original(permit.owner,permit.intentId),token=randomUUID();
        const attempt:ExecutionAttempt={id:randomUUID(),intentId:permit.intentId,kind:'reconcile',requestKey:randomUUID(),startedAt:new Date(now).toISOString(),claimToken:`recovery:${token}`,
          requestRevision:0,inputDigest:digest(permit.operationKey),planDigest:original.intent.planDigest,ordinal:original.attempts.length+1};
        this.db.prepare("UPDATE security_recoveries SET state='running',attempts=attempts+1,token=?,lease_until=? WHERE id=? AND state='pending'").run(token,now+15000,permit.id);
        this.db.prepare('INSERT INTO action_attempts VALUES(?,?,?,?)').run(attempt.id,permit.owner,permit.intentId,JSON.stringify(attempt));
        return {permit,token,attempt};
      }
    });
  }
  assertCurrent(work:Pick<RecoveryWork,'permit'|'token'>) {
    this.eligible(work.permit);
    if(!this.db.prepare("SELECT 1 FROM security_recoveries WHERE id=? AND token=? AND state='running' AND lease_until>?").get(work.permit.id,work.token,this.security.now())) throw new SecurityError('ACCESS_REVOKED');
  }
  authorizeSourceRead(input:unknown,operationKey:string):OriginalOperation {
    const {id,token}=z.strictObject({id:z.uuid(),token:z.uuid()}).parse(input);
    const row=this.db.prepare('SELECT body FROM security_recoveries WHERE id=?').get(id);
    if(!row)throw new SecurityError('AUTHORIZATION_REQUIRED');const permit=JSON.parse(String(row.body)) as RecoveryPermit;
    if(permit.operationKey!==operationKey)throw new SecurityError('AUTHORIZATION_REQUIRED');this.assertCurrent({permit,token});
    const {owner,taskId,intentId,remoteRef,action,programRef,programDigest,originalDispatchAt}=permit;
    return {owner,taskId,intentId,operationKey,remoteRef,action,programRef,programDigest,originalDispatchAt};
  }
  renew(work:RecoveryWork) {
    try{this.assertCurrent(work);return this.db.prepare("UPDATE security_recoveries SET lease_until=? WHERE id=? AND token=? AND state='running'").run(this.security.now()+15000,work.permit.id,work.token).changes===1;}catch{return false;}
  }
  finish(work:RecoveryWork,value?:RecoveryObservation) {
    this.security.atomic(()=>{
      const p=work.permit,row=this.db.prepare('SELECT state,token,attempts FROM security_recoveries WHERE id=?').get(p.id);
      if(!row || row.token!==work.token) return;
      let result:RecoveryObservation|undefined;
      try{result=recoveryObservationSchema.parse(value);if(result.operationKey!==p.operationKey || p.remoteRef && result.remoteRef!==p.remoteRef || Date.parse(result.observedAt)>this.security.now() || Date.parse(result.observedAt)<Date.parse(p.originalDispatchAt)) result=undefined;}catch{result=undefined;}
      const body={kind:result?.state==='confirmed'?'confirmed':result?.state==='rejected'?'rejected':'unknown',eventId:work.attempt.id,sourceVersion:work.attempt.ordinal,
        evidenceRefs:result?[result.evidenceDigest]:[],message:'Original-operation audit observation; no task projection or new dispatch'};
      this.db.prepare('INSERT OR IGNORE INTO action_observations VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),p.owner,p.intentId,work.attempt.id,work.attempt.id,new Date(this.security.now()).toISOString(),digest(body),0,JSON.stringify(body));
      let eligible=true;try{this.eligible(p);}catch{eligible=false;}
      const done=result && result.state!=='unknown';
      const state=done?'observed':eligible && Number(row.attempts)<3?'pending':'unknown';
      this.db.prepare('UPDATE security_recoveries SET state=?,next_at=?,token=NULL,lease_until=0,result=? WHERE id=? AND token=?').run(state,this.security.now()+1000*Number(row.attempts),JSON.stringify({state:result?.state??'unknown',auditOnly:true}),p.id,work.token);
    });
  }
  list(owner:string) {
    return this.db.prepare('SELECT id,task_id,intent_id,state,attempts,result FROM security_recoveries WHERE owner=? ORDER BY rowid DESC LIMIT 100').all(owner)
      .map(row=>({id:String(row.id),taskId:String(row.task_id),intentId:String(row.intent_id),state:String(row.state),attempts:Number(row.attempts),result:row.result?JSON.parse(String(row.result)):undefined,auditOnly:true}));
  }
}
