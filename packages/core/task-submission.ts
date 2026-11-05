import {randomUUID} from 'node:crypto';
import type {Job,Principal,SubmitInput} from './domain.js';
import type {OntologyReleaseRef} from '../ontology/definition-contracts.js';
import {BACKEND_VERSION} from '../ontology/execution.js';
import {initialExecutionBudget} from './execution-budget.js';
import {submissionInstructions} from './request-instructions.js';
import {mergePersonalContext} from '../ontology/personal-context.js';
import {addLocationContext} from './location-context.js';

/** One construction contract for both persistence adapters. No storage,
 * authorization, model call or business execution occurs in this function. */
export function createSubmittedTask(p:Principal,args:Exclude<SubmitInput,{service:'eigos.aftersales'}>,ontologyRelease:OntologyReleaseRef,
  contextId?:string,now=new Date().toISOString()):Job{
  const job:Job={id:randomUUID(),contextId:contextId||randomUUID(),service:args.service,goal:args.goal,deliverable:args.deliverable,
    state:'submitted',revision:1,runs:[],executionMode:'worker',messages:[{id:args.requestId,role:'user',text:args.goal,at:now}],createdAt:now,updatedAt:now};
  job.delegation={backendVersion:BACKEND_VERSION,ontologyRelease,ontologyReadScope:p.scopes.includes('tasks:read')?'owner':'request',
    request:{id:job.id,revision:1,originalGoal:args.goal,executionEnvironment:args.executionEnvironment??'live',
      ...(args.capabilityRef?{capabilityRef:args.capabilityRef}:{}),requestedDeliverable:job.deliverable,
      messages:submissionInstructions(job.id,{id:args.requestId,text:args.goal,receivedAt:now},job.deliverable),
      requirements:(args.requirements??[]).map(requirement=>({...requirement,provenance:{source:'pa',interpretation:'structured',messageId:args.requestId,receivedAt:now}}))},
    executionBudget:initialExecutionBudget(now,args.executionBudget),phase:'grounding',events:[{at:now,event:'delegation_received'}]};
  if(args.personalContext)job.delegation.request.personalContext=mergePersonalContext(args.personalContext);
  if(args.locationContext){addLocationContext(job.delegation.request,args.locationContext,args.requestId,now);job.delegation.events.push({at:now,event:'location_context_recorded'});}
  return job;
}
