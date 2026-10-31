import { personalInputFields } from '../ontology/personal-context.js';
import { randomUUID } from 'node:crypto';
import { DomainError, ownerKey, requireScope, type Job, type Principal } from '../core/domain.js';
import type { JobStore, ListFilter } from '../core/store.js';
import { POLICY_VERSION, SECURITY_CONTRACT, securityDefaults } from './contracts.js';
import { SecurityError, type TaskDataGrant } from './store.js';
import { withAuthorization,authorizationScope } from './context.js';
import {z} from 'zod';
import {objectRefSchema,type ObjectRef} from '../ontology/model.js';
import {projectionFields} from './projections.js';
import {SOURCE_AUTHORIZATION_MESSAGE,SOURCE_AUTHORIZATION_RENEWED_MESSAGE} from '../core/task-recovery.js';

const evidenceMetadata=z.object({securityEvidenceRefs:z.array(objectRefSchema).max(20).optional()});
const goalResult=z.object({version:z.literal('1'),goalDigest:z.string().regex(/^[a-f0-9]{64}$/),components:z.array(z.object({
  contextId:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),status:z.enum(['verified','unverified']),artifact:z.unknown().optional(),
})).max(16)});
const componentArtifact=z.object({data:z.object({execution:z.literal('completed'),result:evidenceMetadata.optional()})});
const partialGoalResult=z.object({version:z.literal('1'),goalDigest:z.string().regex(/^[a-f0-9]{64}$/),accepted:z.literal(false),
  observedResults:z.array(z.object({object:objectRefSchema,currentObjectUnavailable:z.boolean().optional()})).max(12)});

/** Read only reviewed reference slots from the sealed delivery. Child payloads
 * are never public data; every extracted ref still passes the current graph ACL. */
function deliveryEvidence(artifact:NonNullable<Job['artifact']>):ObjectRef[]|undefined {
  const metadata=evidenceMetadata.safeParse(artifact.data.result??{});
  if(!metadata.success)return;
  const refs=[...(metadata.data.securityEvidenceRefs??[])];
  if(artifact.name==='goal-result.json') {
    const result=goalResult.safeParse(artifact.data.result);if(!result.success)return;
    for(const component of result.data.components) {
      if(component.status!=='verified')continue;
      const child=componentArtifact.safeParse(component.artifact);if(!child.success)return;
      refs.push(...(child.data.data.result?.securityEvidenceRefs??[]));
    }
  } else if(artifact.name==='partial-goal-result.json') {
    const result=partialGoalResult.safeParse(artifact.data.result);if(!result.success)return;
    refs.push(...result.data.observedResults.filter(item=>!item.currentObjectUnavailable).map(item=>item.object));
  }
  const unique=[...new Map(refs.map(ref=>[JSON.stringify(ref),ref])).values()];
  return unique.length<=20?unique:undefined;
}

/** Strict construction, never a spread of Job/delegation/RunEvidence. */
export interface TaskView extends Pick<Job, 'id' | 'contextId' | 'service' | 'state' | 'goal' | 'messages' | 'createdAt' | 'updatedAt'> {
  authorityId?: string;
  revision?: number; view: 'eigos.task.v2'; question?: string; artifact?: Job['artifact']; error?: string; accepted?:true;
  outputStatus: 'available' | 'restricted' | 'receipt_only';
  attachments?: {id:string;name:string;mediaType:string;size:number}[];
  authorization?: NonNullable<Job['delegation']>['authorizationRequest'];
  recovery?: {code:'SOURCE_NOT_AUTHORIZED'|'SOURCE_AUTHORIZATION_RENEWED';message:string;nextAction:'review_source_authorization'|'resume_original_task';reviewPath:'/members/permissions'};
  payment?: {request:Pick<import('../core/pa-payment.js').PAPaymentRequest,'id'|'version'|'taskId'|'requestRevision'|'createdAt'|'terms'|'digest'>;status:import('../core/pa-payment.js').PAPaymentState['status'];selection?:import('../core/pa-payment.js').PAPaymentSelection};
}

export class TaskSecurity {
  constructor(private store: JobStore) {}
  private provision(p: Principal, job: Job, previous?: TaskDataGrant, replacePersonalInputs = false) {
    const security = this.store.security, actor = security.agentContext(p), parent = security.agentGrant(actor.installationId), at = new Date(security.now()).toISOString();
    if (!job.delegation) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const oldGrants = security.listGrants(actor.ownerKey).filter(g => g.kind === 'task_data' && g.taskId === job.id);
    if (!previous && oldGrants.length) { security.taskGrant(actor, job.id); return; }
    const personalInputs = security.withAgent(p, undefined, 'task.process', () => security.policies.personalBindings(actor.ownerKey, job));
    if (personalInputs.length) requireScope(p, 'tasks:read');
    if (previous) security.revokeGrant(actor.ownerKey, previous.id, previous.revision);
    const sourceRules = security.policies.sources(actor.ownerKey, actor.installationId).flatMap(s => s.outputTypes.flatMap(type => {
      const resource = parent.resources.find(r => r.type === type);
      return resource ? [{ programId: s.programId, programDigest: s.programDigest, sourceBindingId: s.bindingId, type, fields: resource.fields }] : [];
    }));
    const grant = security.issueTaskGrant({ version: SECURITY_CONTRACT, id: randomUUID(), revision: 1, kind: 'task_data', status: 'active',
      ownerKey: actor.ownerKey, memberId: actor.memberId, approvedByMemberId: actor.memberId, installationId: actor.installationId,
      parentGrant: { id: parent.id, revision: parent.revision }, issuedAt: at, expiresAt: new Date(Math.min(Date.parse(parent.expiresAt),
        previous ? Date.parse(previous.expiresAt) : Date.parse(at) + securityDefaults.taskGrantMaxSeconds * 1000,
        job.delegation.pipelineValidation ? Date.parse(job.delegation.pipelineValidation.expiresAt) : Infinity)).toISOString(),
      taskId: job.id, requestRevision: job.delegation.request.revision, purpose: previous?.purpose ?? 'delegated_task',
      operations: previous ? [...new Set([...previous.operations, ...(replacePersonalInputs && personalInputs.length ? ['member_asset.read' as const] : [])])] : ['task.process', ...(personalInputs.length ? ['member_asset.read'] : []), ...(p.scopes.includes('tasks:read') ? ['task.query','task.result.read',...(parent.channels.includes('controlled_download')?['artifact.export']:[])] : [])],
      inputs: replacePersonalInputs ? personalInputs : previous?.inputs ?? personalInputs, outputs: previous?.outputs ?? sourceRules, channels: previous?.channels ?? parent.channels });
    security.attachTaskAuthority({ version: SECURITY_CONTRACT, id: randomUUID(), revision: 1, ownerKey: actor.ownerKey, memberId: actor.memberId, installationId: actor.installationId,
      taskId: job.id, requestRevision: grant.requestRevision, agentGrant: grant.parentGrant, dataGrant: { id: grant.id, revision: grant.revision },
      submittedScopes: [...new Set(p.scopes)], authEpoch: actor.authEpoch, policyVersion: POLICY_VERSION, issuedAt: at, expiresAt: grant.expiresAt });
  }
  submit(p: Principal, action: () => Job, assertPrepared?: (job: Job) => void): TaskView {
    requireScope(p,'tasks:write');
    return this.store.security.withAgent(p, undefined, 'task.process', () => this.store.transaction(() => {
      const job = action(); this.provision(p, job);
      // Server-side metadata checks can require the newly issued task scope.
      // Failure rolls back the task, grant and idempotency record together.
      if (assertPrepared) this.store.security.withAgent(p, job.id, 'task.process', () => assertPrepared(job));
      return this.project(p, this.store.get(ownerKey(p),job.id));
    }));
  }
  mutate(p: Principal, taskId: string, action: () => Job, personalRefresh?: (job: Job) => void): TaskView {
    requireScope(p,'tasks:write');
    const security = this.store.security, actor = security.agentContext(p), scope = security.scope(actor, taskId, 'task.process');
    return withAuthorization(scope, () => this.store.transaction(() => {
      scope.assertCurrent();
      const result = action(), job = this.store.get(actor.ownerKey,result.id);
      if (job.id !== taskId) this.provision(p,job);
      else if (job.delegation?.request.revision !== scope.grant!.requestRevision) {
        this.provision(p, job, scope.grant, !!personalRefresh);
        if (personalRefresh) security.withAgent(p, job.id, 'task.process', () => personalRefresh(job));
      }
      else scope.assertCurrent();
      return this.project(p,this.store.get(actor.ownerKey, job.id));
    }));
  }
  resume(p:Principal,taskId:string,action:()=>Job):TaskView {
    return this.mutate(p,taskId,()=>{
      const scope=authorizationScope()!,authority=this.store.security.workAuthority(scope.actor.ownerKey,taskId);
      if(!authority || authority.installationId!==scope.actor.installationId || authority.dataGrant.id!==scope.grant!.id
        || authority.dataGrant.revision!==scope.grant!.revision)throw new SecurityError('AUTHORIZATION_REQUIRED');
      // The request revision is unchanged, so mutate keeps the exact grant and
      // authority, including their fixed expiration. This issues no permission.
      return action();
    });
  }
  assertTask(p:Principal,taskId:string) {return this.store.security.taskGrant(this.store.security.agentContext(p),taskId);}
  get(p: Principal, taskId: string) { requireScope(p,'tasks:read');this.assertTask(p,taskId);return this.project(p,this.store.get(ownerKey(p),taskId),true); }
  download(p:Principal,taskId:string,artifactId:string) {
    requireScope(p,'tasks:read');
    return this.store.security.withAgent(p,taskId,'task.result.read',scope=>this.store.security.policies.readSnapshot(()=>this.store.security.policies.download(scope.actor.ownerKey,taskId,artifactId)));
  }
  list(p: Principal, filter: ListFilter) {
    requireScope(p,'tasks:read'); const security=this.store.security, actor=security.agentContext(p),policyRevision=security.policies.revision();
    const taskIds = security.listGrants(actor.ownerKey).flatMap(g => {
      if (g.kind !== 'task_data' || g.installationId !== actor.installationId || g.status !== 'active' || !g.operations.includes('task.result.read')) return [];
      try {
        return security.withAgent(p,g.taskId,'task.result.read',()=>security.policies.readSnapshot(()=>{
          const scope=authorizationScope()!;
          const root=security.policies.binding(scope,{type:'ServiceRequest',id:g.taskId});if(!root)return [];
          security.policies.requireRecipient(scope,root.envelope,'agent_response');return [g.taskId];
        }));
      } catch (error) {if(error instanceof SecurityError && ['AUTHORITY_UNAVAILABLE','POLICY_CHANGED'].includes(error.reason))throw error;return [];}
    });
    const result=this.store.list(actor.ownerKey,filter,taskIds);
    const jobs=result.jobs.map(job=>this.project(p,job,true));
    security.agentContext(p);for(const id of taskIds)security.taskGrant(actor,id);
    if(security.policies.revision()!==policyRevision)throw new SecurityError('POLICY_CHANGED');
    return {jobs,total:result.total};
  }
  project(p: Principal, job: Job, requireRead = false): TaskView {
    const security=this.store.security,actor=security.agentContext(p),grant=security.taskGrant(actor,job.id);
    const base:TaskView={view:'eigos.task.v2',revision:job.revision,id:job.id,contextId:job.contextId,service:job.service,state:job.state,...(this.store.authority?{authorityId:this.store.authority.id}:{}),
      goal:'',messages:[],createdAt:job.createdAt,updatedAt:job.updatedAt,outputStatus:'receipt_only'};
    const canRead=p.scopes.includes('tasks:read') && grant.operations.includes('task.result.read');
    if (!canRead) { if (requireRead) throw new SecurityError('AUTHORIZATION_REQUIRED'); return base; }
    return security.withAgent(p,job.id,'task.result.read',()=>security.policies.readSnapshot(()=>{
      const scope=authorizationScope()!;
      const graph=this.store.ontologyForTaskRead(actor.ownerKey,job);
      if (!grant.channels.includes('agent_response')) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      const root=security.policies.binding(scope,{type:'ServiceRequest',id:job.id});
      if (!root) throw new SecurityError('AUTHORIZATION_REQUIRED');
      security.policies.requireRecipient(scope,root.envelope,'agent_response');
      base.outputStatus='available';
      if(job.state==='paused' && job.delegation?.recovery?.code==='source_authorization_required') {
        const renewed=job.delegation.recovery.state==='resolved';
        base.recovery={code:renewed?'SOURCE_AUTHORIZATION_RENEWED':'SOURCE_NOT_AUTHORIZED',message:renewed?SOURCE_AUTHORIZATION_RENEWED_MESSAGE:SOURCE_AUTHORIZATION_MESSAGE,
          nextAction:renewed?'resume_original_task':'review_source_authorization',reviewPath:'/members/permissions'};
      }
      if (root.fields.includes('originalGoal')) base.goal=String(graph.read(actor.ownerKey,{type:'ServiceRequest',id:job.id}).properties.originalGoal ?? '');
      const allowed=(id:string,content:unknown)=>{
        const envelope=security.policies.output(actor.ownerKey,job.id,id,content);
        if (!envelope) return false;
        try { security.policies.requireRecipient(scope,envelope,'agent_response'); return true; } catch {return false;}
      };
      if (job.question) {
        if (allowed('question',job.question)) {base.question=job.question;base.messages=[{id:`question-${job.id}`,role:'agent',text:job.question,at:job.updatedAt}];}
        else base.outputStatus='restricted';
      }
      if (job.artifact) {
        // Arbitrary result payloads and provider locators have no public contract.
        // Text deliverables are sealed and delivered through the same lineage check.
        const markdown=job.artifact.data.markdown;
        const refs=allowed('artifact',job.artifact)?deliveryEvidence(job.artifact):undefined;
        if (refs) {
          const observations=refs.map(ref=>{const object=graph.read(actor.ownerKey,ref);return {ref,revision:object.revision,properties:Object.fromEntries(Object.entries(object.properties).filter(([field])=>Object.hasOwn(projectionFields(ref.type),field) || Object.hasOwn(personalInputFields, ref.type) && (personalInputFields[ref.type as keyof typeof personalInputFields] as readonly string[]).includes(field)))};});
          if(observations.length)security.policies.requireRecipient(scope,security.policies.outputEnvelope(actor.ownerKey),'agent_response');
          base.artifact={id:job.artifact.id,name:job.artifact.name,data:{...(typeof markdown==='string'?{markdown}:{}),goal:job.artifact.data.goal,deliverable:job.artifact.data.deliverable,execution:job.artifact.data.execution,...(observations.length?{result:{observations}}:{})}};
          if(job.state==='completed' && job.delegation?.acceptance?.accepted)base.accepted=true;
        }
        else base.outputStatus='restricted';
      }
      if (job.error) base.error='Task did not produce an authorized deliverable; inspect its current state.';
      const approval=job.delegation?.authorizationRequest;
      if(job.state==='auth-required' && approval && (!approval.maxAmount || !approval.payeeIds || !['sandbox','live_free'].includes(approval.environment))) base.outputStatus='restricted';
      if(job.state==='auth-required' && approval && approval.maxAmount && approval.payeeIds && (approval.environment==='sandbox' || approval.environment==='live_free') && allowed('authorization',approval)) base.authorization={planDigest:approval.planDigest,effects:[...approval.effects],maxAmount:{minor:approval.maxAmount.minor,currency:approval.maxAmount.currency},payeeIds:[...approval.payeeIds],environment:approval.environment,realOperationsAllowed:approval.realOperationsAllowed};
      const payment=job.delegation?.agent?.paPayment;
      if(payment && payment.request.version !== '2') base.outputStatus='restricted';
      if(payment && payment.request.version === '2' && allowed('payment',payment.request)) {
        const binding=security.policies.binding(scope,{type:'PAPaymentRequest',id:payment.request.id});
        if(binding?.fields.includes('terms')) {
          const {id,version,taskId,requestRevision,createdAt,terms,digest}=payment.request;
          base.payment={request:{id,version,taskId,requestRevision,createdAt,terms:structuredClone(terms),digest},status:payment.status,...(payment.selection && 'wallet' in payment.selection ? {selection:structuredClone(payment.selection)} : {})};
        }
      }
      const attachments=security.policies.artifacts(actor.ownerKey,job.id);if (attachments.length) base.attachments=attachments;
      return base;
    }));
  }
}
