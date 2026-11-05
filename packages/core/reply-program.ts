import {DomainError,type Job,type ReplyInput} from './domain.js';
import {DELEGATE} from './delegation.js';
import {submissionDigest} from '../security/submission-digest.js';
import {BACKEND_VERSION} from '../ontology/execution.js';
import type {ActionIntent} from '../ontology/actions.js';
import type {Ref,ServiceRequest} from '../ontology/execution.js';
import type {PersonalContextInput} from '../ontology/personal-context.js';
import {mergePersonalContext} from '../ontology/personal-context.js';
import {addLocationContext,prepareLocationContext} from './location-context.js';
import {continueExecutionBudget,remainingModelTurns,pauseExecutionBudget,MIN_REASONING_TURNS} from './execution-budget.js';

export interface ReplyStorage {
  intents(owner:string,taskId:string):ActionIntent[];
  intent(owner:string,intentId:string):ActionIntent;
  saveIntent(owner:string,intent:ActionIntent):void;
  cancelActions(owner:string,taskId:string):boolean;
  saveTask(owner:string,job:Job):void;
  personal(owner:string,job:Job,input:PersonalContextInput):void;
  prepare(owner:string,job:Job,program:Ref,request:ServiceRequest):ServiceRequest;
}
type Operation={ [K in keyof ReplyStorage]:{method:K;args:Parameters<ReplyStorage[K]>} }[keyof ReplyStorage];
export type ReplyProgram<T>=Generator<Operation,T,unknown>;
export type AsyncReplyStorage={ [K in keyof ReplyStorage]:(...args:Parameters<ReplyStorage[K]>)=>ReturnType<ReplyStorage[K]>|Promise<ReturnType<ReplyStorage[K]>> };
function* replyIntents(...args:Parameters<ReplyStorage['intents']>):ReplyProgram<ActionIntent[]>{return(yield{method:'intents',args}) as ActionIntent[];}
function* replyIntent(...args:Parameters<ReplyStorage['intent']>):ReplyProgram<ActionIntent>{return(yield{method:'intent',args}) as ActionIntent;}
function* replySaveIntent(...args:Parameters<ReplyStorage['saveIntent']>):ReplyProgram<void>{yield{method:'saveIntent',args};}
function* replyCancel(...args:Parameters<ReplyStorage['cancelActions']>):ReplyProgram<boolean>{return(yield{method:'cancelActions',args}) as boolean;}
function* replySave(...args:Parameters<ReplyStorage['saveTask']>):ReplyProgram<void>{yield{method:'saveTask',args};}
function* replyPersonal(...args:Parameters<ReplyStorage['personal']>):ReplyProgram<void>{yield{method:'personal',args};}
function* replyPrepare(...args:Parameters<ReplyStorage['prepare']>):ReplyProgram<ServiceRequest>{
  const expected=submissionDigest(args[3]),result=(yield{method:'prepare',args}) as ServiceRequest;
  if(submissionDigest(result)!==expected)throw new DomainError('CONFLICT','Task preparation changed its original submitted request');
  return result;
}

export function assertReplyTaskContext(job:Job,contextId?:string):void{
  if(job.delegation?.observationContract)throw new DomainError('CONFLICT','An immutable observation contract cannot become an execution task through replies or amendments');
  if(job.service!==DELEGATE)throw new DomainError('CONFLICT','Historical prototype tasks are read-only in the ontology backend');
  if(job.delegation?.backendVersion!==BACKEND_VERSION)throw new DomainError('CONFLICT','Historical backend tasks are read-only; restore their original runtime');
  if(contextId&&job.contextId!==contextId)throw new DomainError('INVALID_INPUT','Context does not match task');
}
function perform(port:AsyncReplyStorage,step:Operation):unknown{
  switch(step.method){
    case 'intents':return port.intents(...step.args);case 'intent':return port.intent(...step.args);
    case 'saveIntent':return port.saveIntent(...step.args);case 'cancelActions':return port.cancelActions(...step.args);
    case 'saveTask':return port.saveTask(...step.args);case 'personal':return port.personal(...step.args);case 'prepare':return port.prepare(...step.args);
  }
}
export function runReplyProgram<T>(port:ReplyStorage,program:ReplyProgram<T>):T{
  let step=program.next();while(!step.done){let value;
    try{value=perform(port,step.value);if(value&&(typeof value==='object'||typeof value==='function')&&'then'in value&&typeof value.then==='function')throw new Error('Synchronous task reply received asynchronous storage');}
    catch(error){step=program.throw(error);continue;}step=program.next(value);
  }return step.value;
}
export async function runReplyProgramAsync<T>(port:AsyncReplyStorage,program:ReplyProgram<T>):Promise<T>{
  let step=program.next();while(!step.done){let value;
    try{value=await perform(port,step.value);}catch(error){step=program.throw(error);continue;}step=program.next(value);
  }return step.value;
}

/** One transition implementation for SQLite and PostgreSQL. Effects run once
 * inside the caller's task/permission/idempotency transaction; no model or
 * provider call belongs to the storage port. */
export function* replyTransition(job:Job,owner:string,args:ReplyInput,
  options:{foundation:boolean;canRead:boolean;amendment:boolean;expected?:{revision:number;updatedAt:string}}):ReplyProgram<Job>{
  // The browser's displayed question must still be current under the write lock.
  if (options.expected && (job.revision !== options.expected.revision || job.updatedAt !== options.expected.updatedAt)) throw new DomainError('CONFLICT', 'Task changed; refresh before replying');
  if (args.expectedRevision !== undefined && job.revision !== args.expectedRevision) throw new DomainError('CONFLICT', 'This reply belongs to an older task question or revision');
  if (job.delegation?.agent?.paPayment) throw new DomainError('CONFLICT', 'Use select_payment_route, report_payment_result or reconcile_task for the original PA payment; text is not payment evidence');
  if ((args.locationContext || args.personalContext) && (job.delegation?.plan || (yield* replyIntents(owner, job.id)).some(intent => !['read', 'local'].includes(intent.effect)))) throw new DomainError('CONFLICT', 'An address correction cannot change a fixed business operation; reconcile its original operation first');
  if (job.delegation) job.delegation.ontologyReadScope = options.canRead ? 'owner' : 'request';
  const keepSourceWait = options.amendment && job.state === 'auth-required' && !!job.delegation?.sourceAuthorization;
  if (options.amendment) {
    if (/^(?:请|帮我)?(?:继续|重试|恢复|再试一次|resume|retry|continue)[。.!！\s]*$/iu.test(args.answer.trim())) throw new DomainError('INVALID_INPUT', 'Technical continuation uses resume_task and must not become a new business confirmation');
    if (!['submitted', 'working', 'input-required', 'paused', 'auth-required'].includes(job.state) || job.state === 'auth-required' && !keepSourceWait || job.delegation?.plan
      || (yield* replyIntents(owner, job.id)).some(i => !['read', 'local'].includes(i.effect))) throw new DomainError('CONFLICT', 'Only an open read-only task may accept a versioned correction; fixed business operations retain their reconciliation boundary');
  } else {
    if (job.service === DELEGATE && job.state === 'auth-required') throw new DomainError('CONFLICT', 'Use the task authorization endpoint to approve the plan; cancel the task to decline');
    if (job.state !== 'input-required') throw new DomainError('CONFLICT', 'Task is not waiting for input');
  }
  job.updatedAt = new Date().toISOString();
  job.messages.push({ id: args.requestId, role: 'user', text: args.answer, at: job.updatedAt });
  if (job.service === DELEGATE) {
    if (job.delegation!.plan) {
      if (args.requirements?.length) throw new DomainError('CONFLICT', 'Fixed business requirements cannot be changed while an original action requires reconciliation');
      const d = job.delegation!;
      if (d.pendingActionInput) {
        d.actionReply = { intentId: d.pendingActionInput.intentId, messageId: args.requestId, answer: args.answer };
        const waiting = (yield* replyIntent(owner, d.pendingActionInput.intentId)); waiting.nextAt = Date.now(); (yield* replySaveIntent(owner, waiting));
      }
      else for (const intent of (yield* replyIntents(owner, job.id))) if (intent.state === 'needs_review' || intent.state === 'effect_unknown') { intent.state = 'effect_unknown'; intent.failedQueries = 0; intent.nextAt = Date.now(); (yield* replySaveIntent(owner, intent)); }
      d.nextAt = 0; d.phase = 'executing'; job.state = 'working'; job.revision = (job.revision ?? 0) + 1; delete job.question;
      continueExecutionBudget(job, 'input', args.executionBudget);
      (yield* replySave(owner, job)); return job;
    }
    const request = job.delegation!.request;
    const previousProgram = job.delegation!.agent?.programRef ?? job.delegation!.suspendedAgent?.programRef;
    delete job.delegation!.suspendedAgent;
    if (job.delegation!.agent) {
      const intents = (yield* replyIntents(owner, job.id));
      const fixedEffect = intents.some(i => (['order', 'payment', 'reserve', 'object_write'].includes(i.effect) || ['effect_unknown', 'awaiting_remote', 'dispatching', 'needs_review'].includes(i.state) && !['read', 'local'].includes(i.effect)) && !['ready', 'canceled_before_dispatch', 'rejected'].includes(i.state));
      if (fixedEffect) {
        if (args.requirements?.length) throw new DomainError('CONFLICT', 'An original business operation is fixed or uncertain; reconcile it before creating changed requirements');
        request.messages.push({ id: args.requestId, text: args.answer, receivedAt: job.updatedAt });
        for (const intent of intents) if (!['read', 'local'].includes(intent.effect) && ['needs_review', 'effect_unknown'].includes(intent.state)) { intent.state = 'effect_unknown'; intent.failedQueries = 0; intent.nextAt = 0; (yield* replySaveIntent(owner, intent)); }
        job.delegation!.nextAt = 0; job.delegation!.phase = 'executing'; job.state = 'working'; job.revision = (job.revision ?? 0) + 1; delete job.question;
        (yield* replySave(owner, job)); return job;
      }
      (yield* replyCancel(owner, job.id));
      job.delegation!.agentHistory = [...(job.delegation!.agentHistory ?? []), job.delegation!.agent!];
      delete job.delegation!.agent;
    }
    request.revision++; request.messages.push({ id: args.requestId, text: args.answer, receivedAt: job.updatedAt });
    if (args.personalContext) {
      request.personalContext = mergePersonalContext(args.personalContext, request.personalContext);
      if (!options.foundation) (yield* replyPersonal(owner,job,args.personalContext));
    }
    if (args.locationContext) addLocationContext(request, args.locationContext, args.requestId, job.updatedAt);
    else prepareLocationContext(request);
    for (const r of args.requirements ?? []) {
      const previous = request.requirements.findIndex(x => x.id === r.id);
      const next = { ...r, provenance: { source: 'pa' as const, interpretation: 'structured' as const, messageId: args.requestId, receivedAt: job.updatedAt } };
      if (previous < 0) request.requirements.push(next); else { request.supersededRequirements = [...(request.supersededRequirements ?? []), request.requirements[previous]!]; request.requirements[previous] = next; }
    }
    if (request.requirements.length > 40) throw new DomainError('INVALID_INPUT', 'Too many task requirements');
    if (previousProgram) job.delegation!.request = (yield* replyPrepare(owner,job,previousProgram,request));
    job.state = 'submitted'; job.executionMode = 'worker'; job.revision = (job.revision ?? 0) + 1; delete job.question; job.delegation!.phase = 'grounding';
    continueExecutionBudget(job, 'input', args.executionBudget);
    if (remainingModelTurns(job) < MIN_REASONING_TURNS) pauseExecutionBudget(job, 'modelTurns', 'task');
    if (job.delegation!.recovery) { job.delegation!.recoveryHistory = [...(job.delegation!.recoveryHistory ?? []), job.delegation!.recovery!]; delete job.delegation!.recovery; }
    if (keepSourceWait) { job.state = 'auth-required'; job.delegation!.phase = 'awaiting_authorization'; }
  }
  (yield* replySave(owner, job));
  return job;
}
