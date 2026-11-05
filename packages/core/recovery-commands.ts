import {DomainError,type Job} from './domain.js';
import {BACKEND_VERSION} from '../ontology/execution.js';
import type {ActionIntent} from '../ontology/actions.js';
import {verifyPAPaymentRequest} from './pa-payment.js';

export interface RecoveryStorage {
  intents(owner:string,taskId:string):ActionIntent[];
  saveIntent(owner:string,intent:ActionIntent):void;
  revokeGrants(owner:string,taskId:string):void;
  saveTask(owner:string,job:Job):void;
}
type Operation={ [K in keyof RecoveryStorage]:{method:K;args:Parameters<RecoveryStorage[K]>} }[keyof RecoveryStorage];
export type RecoveryProgram<T>=Generator<Operation,T,unknown>;
export type AsyncRecoveryStorage={ [K in keyof RecoveryStorage]:(...args:Parameters<RecoveryStorage[K]>)=>ReturnType<RecoveryStorage[K]>|Promise<ReturnType<RecoveryStorage[K]>> };
export interface RecoveryResult {job:Job;legacyView?:true}
function* intents(...args:Parameters<RecoveryStorage['intents']>):RecoveryProgram<ActionIntent[]>{return(yield{method:'intents',args}) as ActionIntent[];}
function* saveIntent(...args:Parameters<RecoveryStorage['saveIntent']>):RecoveryProgram<void>{yield{method:'saveIntent',args};}
function* revokeGrants(...args:Parameters<RecoveryStorage['revokeGrants']>):RecoveryProgram<void>{yield{method:'revokeGrants',args};}
function* saveTask(...args:Parameters<RecoveryStorage['saveTask']>):RecoveryProgram<void>{yield{method:'saveTask',args};}
function perform(port:AsyncRecoveryStorage,step:Operation):unknown{
  switch(step.method){
    case 'intents':return port.intents(...step.args);case 'saveIntent':return port.saveIntent(...step.args);
    case 'revokeGrants':return port.revokeGrants(...step.args);case 'saveTask':return port.saveTask(...step.args);
  }
}
export function runRecoveryProgram<T>(port:RecoveryStorage,program:RecoveryProgram<T>):T{
  let step=program.next();while(!step.done){let value;
    try{value=perform(port,step.value);if(value&&(typeof value==='object'||typeof value==='function')&&'then'in value&&typeof value.then==='function')throw new Error('Synchronous task recovery received asynchronous storage');}
    catch(error){step=program.throw(error);continue;}step=program.next(value);
  }return step.value;
}
export async function runRecoveryProgramAsync<T>(port:AsyncRecoveryStorage,program:RecoveryProgram<T>):Promise<T>{
  let step=program.next();while(!step.done){let value;
    try{value=await perform(port,step.value);}catch(error){step=program.throw(error);continue;}step=program.next(value);
  }return step.value;
}

/** Pure original-task transitions. The caller owns admission, idempotency and
 * the transaction. Scheduling readback never dispatches or replays an effect,
 * releases a budget reservation, issues a grant, or extends its deadline. */
export function* reconcileTransition(job:Job,owner:string,requestId:string,options:{foundation:boolean}):RecoveryProgram<RecoveryResult>{
  if(job.delegation?.backendVersion===BACKEND_VERSION&&job.delegation.agent?.paPayment){
    const payment=verifyPAPaymentRequest(job,owner);
    if(options.foundation&&payment.request.version!=='2')throw new DomainError('FORBIDDEN','This payment handoff needs a reviewed foundation projection');
    if(job.state==='completed'||job.state==='working'||job.state==='submitted')return {job,legacyView:true};
    const terminal=['canceled','failed','rejected'].includes(job.state);
    payment.recoveryAttempts=0;payment.readbackSequence++;payment.status=terminal?'withdrawn':'reported';
    job.delegation.manualReconciliation=requestId;job.delegation.nextAt=0;job.delegation.recoveryPending=terminal;
    if(!terminal){job.state='submitted';job.delegation.phase='planning';delete job.question;}
    job.revision=(job.revision??0)+1;job.updatedAt=new Date().toISOString();
    yield* saveTask(owner,job);return {job,legacyView:true};
  }
  if(job.delegation?.backendVersion===BACKEND_VERSION&&job.delegation.agent){
    const pending=(yield* intents(owner,job.id)).filter(i=>!['read','local'].includes(i.effect)&&['needs_review','effect_unknown','awaiting_remote','dispatching'].includes(i.state));
    if(!pending.length)return {job};
    for(const intent of pending){intent.state='effect_unknown';intent.failedQueries=0;intent.nextAt=0;yield* saveIntent(owner,intent);}
    job.delegation.manualReconciliation=requestId;job.delegation.nextAt=0;
    const terminal=['canceled','failed','completed','auth-required'].includes(job.state);
    job.delegation.recoveryPending=terminal;job.revision=(job.revision??0)+1;
    if(!terminal){job.state='working';delete job.question;}
    job.updatedAt=new Date().toISOString();yield* saveTask(owner,job);return {job};
  }
  if(job.delegation?.backendVersion!==BACKEND_VERSION||!job.delegation.plan)throw new DomainError('CONFLICT','No current business operation to reconcile');
  let pending=false;
  for(const intent of yield* intents(owner,job.id)){
    if(['needs_review','effect_unknown','awaiting_remote','dispatching'].includes(intent.state)){
      pending=true;intent.state='effect_unknown';intent.failedQueries=0;intent.nextAt=Date.now();yield* saveIntent(owner,intent);
    }else if(intent.state==='effect_confirmed'&&intent.remoteRef&&!['read','local'].includes(intent.effect)){
      pending=true;intent.needsObservation=true;intent.nextAt=Date.now();yield* saveIntent(owner,intent);
    }
  }
  if(!pending)return {job};
  job.delegation.manualReconciliation=requestId;
  const terminal=['canceled','failed','completed','auth-required'].includes(job.state);
  job.delegation.recoveryPending=terminal;job.delegation.nextAt=0;job.revision=(job.revision??0)+1;
  if(!terminal){job.state='working';delete job.question;}job.updatedAt=new Date().toISOString();yield* saveTask(owner,job);return {job};
}

export function* revokeAuthorizationTransition(job:Job,owner:string,requestId:string):RecoveryProgram<RecoveryResult>{
  const d=job.delegation,simulationPlan=d?.agent?.plans.find(plan=>plan.id===d.agent?.pendingPlanId&&plan.quote);
  if(d?.backendVersion===BACKEND_VERSION&&simulationPlan&&!['completed','failed','canceled'].includes(job.state)){
    delete d.approval;job.revision=(job.revision??0)+1;d.nextAt=0;
    job.state='auth-required';d.phase='awaiting_authorization';job.updatedAt=new Date().toISOString();
    d.events.push({at:job.updatedAt,event:'authorization_revoked',evidence:simulationPlan.digest});yield* saveTask(owner,job);return {job};
  }
  if(d?.backendVersion===BACKEND_VERSION&&d.agent&&d.authorizationRequest&&!['completed','failed','canceled'].includes(job.state)){
    yield* revokeGrants(owner,job.id);
    const current=yield* intents(owner,job.id),pendingWrite=current.some(i=>!['read','local'].includes(i.effect)&&['ready','dispatching','awaiting_remote','effect_unknown','needs_review'].includes(i.state));
    if(!pendingWrite){job.updatedAt=new Date().toISOString();d.events.push({at:job.updatedAt,event:'agent_authority_revoked_readback_continues',evidence:requestId});yield* saveTask(owner,job);return {job};}
    job.revision=(job.revision??0)+1;
    for(const intent of current)if(intent.state==='dispatching'&&!['read','local'].includes(intent.effect)){intent.state='effect_unknown';intent.nextAt=0;yield* saveIntent(owner,intent);}
    d.recoveryPending=current.some(i=>!['read','local'].includes(i.effect)&&['dispatching','awaiting_remote','effect_unknown'].includes(i.state));d.nextAt=0;
    job.state='auth-required';d.phase='awaiting_authorization';job.updatedAt=new Date().toISOString();yield* saveTask(owner,job);return {job};
  }
  if(d?.backendVersion!==BACKEND_VERSION||!d.plan||(!d.authorizationRequest&&!d.plan.quote)||['completed','failed','canceled'].includes(job.state))throw new DomainError('CONFLICT','No open plan authorization to revoke');
  yield* revokeGrants(owner,job.id);delete d.approval;job.revision=(job.revision??0)+1;
  d.recoveryPending=(yield* intents(owner,job.id)).some(i=>['dispatching','awaiting_remote','effect_unknown'].includes(i.state));d.nextAt=0;
  job.state='auth-required';d.phase='awaiting_authorization';job.updatedAt=new Date().toISOString();
  d.events.push({at:job.updatedAt,event:'authorization_revoked',evidence:d.plan.digest});yield* saveTask(owner,job);return {job};
}
