import {randomUUID} from 'node:crypto';
import {digest} from '../core/delegation.js';
import {DomainError,type Job} from '../core/domain.js';
import type {ActionIntent} from '../ontology/actions.js';
import {BACKEND_VERSION} from '../ontology/execution.js';
import {assertGoalCoverage} from '../ontology/goal-coverage.js';
import {isPersonalAction} from '../ontology/personal-context.js';
import type {PostgresReadProgramRegistry} from './didi-registry.js';
import {postgresGoalProgram} from './goal-contexts.js';
import {DIDI_PROGRAM_REF} from '../capabilities/didi/program.js';
import {didiShortPathRequest,didiShortPathInput,didiShortPathGoal} from './didi-short-path.js';

export type PostgresWorkerLane='model'|'execution';
export type PostgresWorkerSlots=Readonly<Record<PostgresWorkerLane,number>>;
export interface PostgresWorkerCapacity {
  readonly slots:PostgresWorkerSlots;
  readonly perOwner:PostgresWorkerSlots;
}
/** Shared bounds across hosts. Local Harness model concurrency is separately
 * one; ready host/provider work does not consume that local model slot. */
export const defaultPostgresWorkerCapacity:PostgresWorkerCapacity=Object.freeze({
  slots:Object.freeze({model:2,execution:2}),perOwner:Object.freeze({model:2,execution:1}),
});
export const postgresWorkerLanes:readonly PostgresWorkerLane[]=Object.freeze(['execution','model']);
const prefix='eigos-worker-v1:';
const tagged=/^eigos-worker-v1:(model|execution):([a-f0-9]{64}):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export function postgresWorkerCapacity(input:PostgresWorkerCapacity=defaultPostgresWorkerCapacity):PostgresWorkerCapacity{
  for(const lane of postgresWorkerLanes){
    if(!Number.isSafeInteger(input.slots[lane])||input.slots[lane]<1||input.slots[lane]>8
      ||!Number.isSafeInteger(input.perOwner[lane])||input.perOwner[lane]<1||input.perOwner[lane]>input.slots[lane])
      throw new Error('Invalid PostgreSQL Worker capacity');
  }
  return Object.freeze({slots:Object.freeze({...input.slots}),perOwner:Object.freeze({...input.perOwner})});
}
export function postgresWorkerCapacityDigest(capacity:PostgresWorkerCapacity){return digest({version:1,capacity});}
export function postgresWorkerClaimToken(lane:PostgresWorkerLane,capacity:PostgresWorkerCapacity){
  return `${prefix}${lane}:${postgresWorkerCapacityDigest(capacity)}:${randomUUID()}`;
}
/** The token remains opaque to lease/receipt consumers. Its reservation never
 * follows mutable job phases. Historical untagged claims retain model weight;
 * an unknown/malformed version is a configuration refusal, never spare space. */
export function postgresWorkerReservation(token:string):{lane:PostgresWorkerLane;contract?:string}{
  const match=tagged.exec(token);
  if(match)return {lane:match[1] as PostgresWorkerLane,contract:match[2]!};
  if(token.startsWith('eigos-worker-'))throw new DomainError('CONFLICT','Unrecognized PostgreSQL Worker capacity reservation');
  return {lane:'model'};
}
export function postgresWorkerOccupancy(rows:readonly {owner:string;token:string}[],recoveries:number,capacity:PostgresWorkerCapacity){
  if(!Number.isSafeInteger(recoveries)||recoveries<0)throw new DomainError('CONFLICT','Invalid active Worker recovery count');
  const contract=postgresWorkerCapacityDigest(capacity),active={model:0,execution:0},owners=new Map<string,{model:number;execution:number}>();
  for(const row of rows){
    const reservation=postgresWorkerReservation(row.token);
    if(reservation.contract&&reservation.contract!==contract)throw new DomainError('CONFLICT','Active PostgreSQL Workers use another capacity contract');
    active[reservation.lane]++;
    const owner=owners.get(row.owner)??{model:0,execution:0};owner[reservation.lane]++;owners.set(row.owner,owner);
  }
  const total=rows.length+recoveries,maximum=capacity.slots.model+capacity.slots.execution;
  return {active,owners,total,available:(lane:PostgresWorkerLane,owner?:string)=>total<maximum&&active[lane]<capacity.slots[lane]
    &&(owner===undefined||(owners.get(owner)?.[lane]??0)<capacity.perOwner[lane])};
}

/** Only installed, exact next-phase contracts can avoid a model reservation.
 * This is scheduling, not authority: the coordinator and journal still recheck
 * every original binding, grant, lease, source and observation before dispatch. */
export function postgresWorkerLane(job:Job,intents:readonly ActionIntent[],registry:PostgresReadProgramRegistry):PostgresWorkerLane{
  const d=job.delegation,state=d?.agent;
  if(!d||d.backendVersion!==BACKEND_VERSION||!['submitted','working'].includes(job.state)||d.recoveryPending||d.plan||d.suspendedAgent)return 'model';
  const plan=state?.plans.find(value=>value.id===state.pendingPlanId);
  if(d.callerAction){
    return plan?.callerDecision&&plan.steps.length===1&&plan.steps[0]!.effect==='object_write'
      &&plan.steps[0]!.action===d.callerAction.action&&isPersonalAction(d.callerAction.action)?'execution':'model';
  }
  let fixedReadOnly=false;
  if(d.didiEstimate){
    // This closed host workflow supplies its own fixed goal proof. It is not
    // inferred from a read effect or absence of the ordinary model coverage.
    const entry=registry.entries.find(value=>value.kind==='didi'&&value.didi&&digest(value.program.ref)===digest(DIDI_PROGRAM_REF));
    if(!entry)return 'model';
    try{
      const request=didiShortPathRequest(job);
      if(request.mode==='natural'&&!d.didiEstimate.interpretation)return 'model';
      didiShortPathInput(job);
      if(state&&(!state.composition||digest(state.composition.goal)!==digest(didiShortPathGoal(job,entry.program.capability()))
        ||state.plans.length>2||state.composition.contexts.length>1))return 'model';
      if(!state||!state.pendingPlanId)return 'execution';
      fixedReadOnly=true;
    }catch{return 'model';}
  }else{
    if(!state||!plan||!d.goalCoverage||d.goalCoverage.requestDigest!==digest(d.request))return 'model';
    try{assertGoalCoverage(job,postgresGoalProgram(job).capability());}catch{return 'model';}
  }
  if(!plan)return 'model';
  for(const step of plan.steps){
    const intent=intents.find(value=>value.id===step.intentId&&value.planDigest===plan.digest&&value.jobId===job.id);
    if(!intent)return 'model';
    if(intent.state==='effect_confirmed')continue;
    if(intent.state!=='ready'&&!fixedReadOnly)return 'model';
    const entry=registry.find(step.binding?.programRef??plan.programRef,step.binding?.configurationDigest??plan.programDigest);
    // ComposeDocument is a local effect that invokes a model. Neither "local"
    // nor a caller-supplied read effect is a model-free execution contract.
    if(entry?.kind!=='didi'||!entry.didi||step.effect!=='read'||step.additionalEffects?.length
      ||!['SearchDidiPlaces','EstimateDidiRide'].includes(step.action)||!entry.program.actionIds.includes(step.action))return 'model';
  }
  return 'execution';
}
