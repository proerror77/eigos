import {digest} from '../core/delegation.js';
import type {AgentActionPlan} from '../ontology/agent-actions.js';
import {SecurityError,type SecurityStore} from './store.js';

/** A queued source operation was already durably dispatched by a Worker. Before
 * an operator starts its external step, recheck that exact task authority and
 * plan against current grants. This grants no graph/model/ordinary Worker scope. */
export function assertQueuedSourceAuthority(security:SecurityStore,owner:string,taskId:string,plan:AgentActionPlan,action:string,component?:{programRef:AgentActionPlan['programRef'];programDigest:string}) {
  const authority=security.workAuthority(owner,taskId),policy=security.policies;
  if(!authority)throw new SecurityError('ACCESS_REVOKED');
  const grant=security.listGrants(owner).find(g=>g.kind==='task_data' && g.id===authority.dataGrant.id && g.revision===authority.dataGrant.revision && g.status==='active');
  if(grant?.kind!=='task_data')throw new SecurityError('ACCESS_REVOKED');
  const expected=digest({installation:authority.installationId,epoch:authority.authEpoch,grant:{id:authority.dataGrant.id,revision:authority.dataGrant.revision},policyRevision:policy.revision(),operation:'task.process'});
  if(plan.ontologyPlanning.accessDigest!==expected)throw new SecurityError('POLICY_CHANGED');
  for(const permission of ['resource.view','action.execute'])if(!policy.resourceAllowedFor(authority.memberId,authority.installationId,'actionType',action,permission))throw new SecurityError('AUTHORIZATION_REQUIRED');
  for(const target of [plan,...(component?[component]:[])]) {
    const source=policy.sources(owner,authority.installationId).find(s=>s.programId===target.programRef.id && s.programDigest===target.programDigest && s.operations.includes(action));
    if(!source || !grant.outputs.some(o=>o.programId===source.programId && o.programDigest===source.programDigest && o.sourceBindingId===source.bindingId))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
  }
}
