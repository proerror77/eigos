import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, ownerKey, type Principal } from '../core/domain.js';
import { MemberStore } from '../members/store.js';
import { accessContextSchema, agentAccessGrantSchema, POLICY_VERSION, SECURITY_CONTRACT, securityDefaults, type AccessContext } from './contracts.js';
import { SecurityError, SecurityStore, type Fence } from './store.js';
import type { JobStore } from '../core/store.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import { taskDataGrantSchema,grantRefSchema } from './contracts.js';
import {TASK_PROJECTION_TYPES} from './policy-store.js';

const grantFields = agentAccessGrantSchema.shape;
const writeContention=(error:unknown)=>error instanceof Error && 'code' in error && error.code==='ERR_SQLITE_ERROR'
  && 'errcode' in error && typeof error.errcode==='number' && Number.isInteger(error.errcode) && (error.errcode&255)===5;
export const agentGrantRequestSchema = z.strictObject({ installationId: grantFields.installationId, capabilityIds: grantFields.capabilityIds,
  resources: grantFields.resources, sourceBindingIds: grantFields.sourceBindingIds, channels: grantFields.channels, expiresAt: grantFields.expiresAt });

/** The sole online eligibility publisher. Administrative CLI processes may use
 * the same deny/restore methods, but cannot publish eligibility or issue grants
 * without acquiring the Gateway lease. No raw token reaches SecurityStore. */
export class AuthorizationCoordinator {
  private token?: string;
  private timer?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private unavailable?: () => void;
  constructor(readonly store: SecurityStore, private members: MemberStore, private jobs?: JobStore, private catalog?: ExecutionCatalog) {}
  get available() { return this.token !== undefined && this.store.managerCurrent(this.token); }
  onUnavailable(handler: () => void) { this.unavailable = handler; }
  start() {
    this.token = this.store.acquireManager();
    let retryInitial=false;
    try { this.refresh(); } catch (error) {
      if(writeContention(error) && this.token && this.store.managerCurrent(this.token))retryInitial=true;
      else { this.close(); throw error; }
    }
    let lastRefresh = this.store.now();
    const refresh=() => {
      clearTimeout(this.retry);this.retry=undefined;
      const delayMs = Math.max(0, this.store.now() - lastRefresh - securityDefaults.authorityProjectionRefreshSeconds * 1000);
      lastRefresh = this.store.now();
      try { this.refresh(); }
      catch (error) {
        // A current Gateway lease remains authoritative while another bounded
        // transaction holds the writer. Retry only before that same lease ends.
        if(writeContention(error) && this.token && this.store.managerCurrent(this.token)) {
          this.retry=setTimeout(refresh,500);this.retry.unref();return;
        }
        this.close();
        const cause = error instanceof Error ? error.cause : undefined;
        console.error('Authorization eligibility refresh stopped; new work fails closed', { delayMs, reason: cause instanceof SecurityError ? cause.reason : cause instanceof Error ? cause.name : 'unknown' });
        this.unavailable?.();
      }
    };
    this.timer = setInterval(refresh, securityDefaults.authorityProjectionRefreshSeconds * 1000);
    this.timer.unref();
    if(retryInitial){this.retry=setTimeout(refresh,500);this.retry.unref();}
  }
  close() {
    clearInterval(this.timer);clearTimeout(this.retry);const token=this.token;this.token=undefined;
    if(token)try{this.store.releaseManager(token);}catch(error){if(!writeContention(error))throw error;}
  }
  refresh() {
    try {
      if (!this.token || !this.store.renewManager(this.token)) throw new SecurityError('AUTHORITY_UNAVAILABLE');
      for (const old of this.store.subjects()) this.store.publishSubject(this.members.authorizationFacts(old.memberId, old.installationId), this.token);
    } catch (error) {
      if(writeContention(error) && this.token && this.store.managerCurrent(this.token))throw error;
      this.close(); const failure = new SecurityError('AUTHORITY_UNAVAILABLE'); failure.cause = error; throw failure;
    }
  }
  authenticate(principal: Principal, bearer: string): AccessContext {
    if (!this.token) throw new SecurityError('AUTHORITY_UNAVAILABLE');
    // Both checks are existing membership/installation mechanisms. A client_id
    // or installation id supplied in a JSON body is never evidence of identity.
    const registration = this.members.agents.authorize(principal, bearer);
    this.members.authorize(principal);
    const facts = this.members.authorizationFacts(registration.memberId!, registration.id);
    if (facts.ownerKey !== ownerKey(principal) || facts.clientId !== principal.clientId) throw new SecurityError('ACCESS_REVOKED');
    const subject = this.store.authenticateSubject(facts, this.token), grant = this.store.agentGrant(subject.installationId);
    return accessContextSchema.parse({ version: SECURITY_CONTRACT, actorKind: 'agent', ownerKey: subject.ownerKey,
      memberId: subject.memberId, installationId: subject.installationId, clientId: subject.clientId,
      tokenScopes: [...new Set(principal.scopes)], agentGrant: { id: grant.id, revision: grant.revision },
      authEpoch: subject.epoch, policyVersion: POLICY_VERSION, checkedAt: new Date(this.store.now()).toISOString() });
  }
  approveAgentGrant(memberId: string, input: unknown) {
    if (!this.token) throw new SecurityError('AUTHORITY_UNAVAILABLE');
    const args = agentGrantRequestSchema.parse(input), facts = this.members.authorizationFacts(memberId, args.installationId);
    if (!facts.active) throw new SecurityError('ACCESS_REVOKED');
    this.store.publishSubject(facts, this.token);
    for (const resource of args.resources) {
      this.store.model.object(resource.type);
      const definition = this.store.policies.fields(resource.type);
      for (const field of resource.fields) {
        if (!Object.hasOwn(definition, field)) throw new DomainError('INVALID_INPUT', 'Grant fields must be registered');
        if (definition[field]!.restricted || this.store.policies.fieldPolicy(resource.type,field)==='internal_only') throw new DomainError('FORBIDDEN', 'Grant cannot expose an internal or restricted property');
      }
    }
    return this.store.issueAgentGrant({ ...args, version: SECURITY_CONTRACT, id: randomUUID(), revision: 1,
      kind: 'agent_access', scope: 'task_only', ownerKey: facts.ownerKey, memberId,
      approvedByMemberId: memberId, issuedAt: new Date(this.store.now()).toISOString(), status: 'active' });
  }
  private owned(memberId: string) {
    const m = this.members.get(memberId); return ownerKey({ ...m, clientId: '', scopes: [] });
  }
  grants(memberId: string) {
    return this.store.listGrants(this.owned(memberId)).map(({ ownerKey: _owner, memberId: _member, approvedByMemberId: _approver, ...safe }) => safe);
  }
  revokeGrant(memberId: string, grantId: string, expectedRevision: number) { this.store.revokeGrant(this.owned(memberId), grantId, expectedRevision); }
  sourceProfiles(memberId:string) {return {revision:this.store.policies.revision(),profiles:this.catalog?.securityProfiles(this.owned(memberId)) ?? []};}
  managementView(memberId:string) {
    const owner=this.owned(memberId),installations=this.members.agents.list(memberId).map(a=>({id:a.id,name:a.displayName,revoked:a.revoked})),profiles=this.sourceProfiles(memberId).profiles;
    const types=[...new Set(['ServiceRequest',...TASK_PROJECTION_TYPES,...profiles.flatMap(p=>p.outputTypes)])];
    const grants=this.grants(memberId),jobs=this.jobs?.list(owner,{limit:50,offset:0}).jobs??[];
    const grantedTaskIds=[...new Set(grants.flatMap(grant=>grant.kind==='task_data'&&grant.status==='active'&&Date.parse(grant.expiresAt)>this.store.now()?[grant.taskId]:[]))];
    const grantedJobs=grantedTaskIds.length?this.jobs?.list(owner,{limit:grantedTaskIds.length,offset:0},grantedTaskIds).jobs??[]:[];
    const permissionJobs=[...new Map([...jobs,...grantedJobs].map(job=>[job.id,job])).values()];
    return {installations,grants,profiles,policyRevision:this.store.policies.revision(),recoveries:this.recoveries(memberId),recoveryCandidates:jobs.flatMap(job=>this.recoveryPreview(memberId,job.id).map(op=>({...op,taskId:job.id}))),
      sources:installations.flatMap(a=>this.store.policies.sources(owner,a.id)),objects:this.store.policies.memberCandidates(owner,memberId),
      fields:types.map(type=>({type,name:this.store.model.object(type).name,fields:Object.entries(this.store.policies.fields(type)).filter(([field])=>this.store.policies.fieldPolicy(type,field)!=='internal_only').map(([field,def])=>({field,description:def.description,sensitive:this.store.policies.fieldPolicy(type,field)==='task_sensitive'}))})),
      operationDescriptions:Object.fromEntries([...new Set(profiles.flatMap(profile=>profile.operations))].map(id=>[id,id==='recover_original'?'查询已经提交操作的状态':this.store.model.action(id).description])),
      tasks:permissionJobs.map(job=>({id:job.id,title:job.goal,state:job.state,requestRevision:job.delegation?.request.revision??0}))};
  }
  approveSource(memberId:string,input:unknown) {
    const args=z.strictObject({installationId:z.uuid(),bindingId:z.string().min(1),programId:z.string().min(1),operations:z.array(z.string()).min(1),outputTypes:z.array(z.string()).min(1),expiresAt:z.iso.datetime({offset:true}),expectedRevision:z.number().int().positive(),expectedAgentGrant:grantRefSchema}).parse(input);
    const facts=this.members.authorizationFacts(memberId,args.installationId);
    if (!facts.active) throw new SecurityError('ACCESS_REVOKED');
    const profile=this.catalog?.securityProfiles(facts.ownerKey).find(s=>s.programId===args.programId && s.bindingId===args.bindingId);
    if (!profile || !args.operations.every(o=>profile.operations.includes(o)) || !args.outputTypes.every(t=>profile.outputTypes.includes(t))) throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    const parent=this.store.agentGrant(args.installationId);
    if(parent.id!==args.expectedAgentGrant.id || parent.revision!==args.expectedAgentGrant.revision)throw new SecurityError('POLICY_CHANGED');
    const {expectedRevision,expectedAgentGrant:_expected,...source}=args;
    this.store.policies.setSource(facts.ownerKey,{...source,programDigest:profile.programDigest},expectedRevision);
  }
  revokeSource(memberId:string,input:unknown) {
    const args=z.strictObject({installationId:z.uuid(),bindingId:z.string().min(1),expectedRevision:z.number().int().positive()}).parse(input);
    this.members.authorizationFacts(memberId,args.installationId);
    this.store.policies.revokeSource(this.owned(memberId),args.installationId,args.bindingId,args.expectedRevision);
  }
  recoveryPreview(memberId:string,taskId:string) {return this.store.recoveries.preview(this.owned(memberId),z.uuid().parse(taskId));}
  recoveries(memberId:string) {return this.store.recoveries.list(this.owned(memberId));}
  approveRecovery(memberId:string,input:unknown) {return this.store.recoveries.approve(this.owned(memberId),memberId,input);}
  approveTaskGrant(memberId:string,input:unknown) {
    if (!this.jobs || !this.token) throw new SecurityError('AUTHORITY_UNAVAILABLE');
    const fields=taskDataGrantSchema.shape;
    const args=z.strictObject({taskId:z.uuid(),installationId:z.uuid(),expectedRequestRevision:z.number().int().positive(),
      replaces: z.strictObject({id:z.uuid(),revision:z.number().int().positive()}).optional(),expectedAgentGrant:grantRefSchema,takeover:z.boolean().default(false),
      inputs:fields.inputs,programIds:z.array(z.string().min(1)).max(100),purpose:fields.purpose,operations:fields.operations,channels:fields.channels,expiresAt:fields.expiresAt}).parse(input);
    const facts=this.members.authorizationFacts(memberId,args.installationId);
    if (!facts.active) throw new SecurityError('ACCESS_REVOKED');
    this.store.publishSubject(facts,this.token);
    return this.jobs.transaction(()=>{
      const job=this.jobs!.get(facts.ownerKey,args.taskId),request=job.delegation?.request;
      if (!request || request.revision!==args.expectedRequestRevision || this.jobs!.hasActiveClaim(job.id)) throw new DomainError('CONFLICT','Task is running or its request changed; review its current state');
      const grants=this.store.listGrants(facts.ownerKey).filter(g=>g.kind==='task_data' && g.taskId===job.id && g.status==='active');
      const current=grants.find(g=>g.installationId===args.installationId);
      if (current && (current.id!==args.replaces?.id || current.revision!==args.replaces.revision) || !current && args.replaces) throw new DomainError('CONFLICT','Task grant changed; review the current grant');
      if (args.operations.includes('task.process')) {
        if (!args.takeover) throw new DomainError('INVALID_INPUT','Continuing execution requires explicit takeover approval');
        if (this.jobs!.intents(facts.ownerKey,job.id).some(i=>!['read','local'].includes(i.effect) && this.jobs!.attempts(facts.ownerKey,i.id).length)) throw new DomainError('CONFLICT','An existing business operation requires its original recovery path');
      }
      const parent=this.store.agentGrant(args.installationId),at=new Date(this.store.now()).toISOString(),sources=this.store.policies.sources(facts.ownerKey,args.installationId);
      if(parent.id!==args.expectedAgentGrant.id || parent.revision!==args.expectedAgentGrant.revision)throw new SecurityError('POLICY_CHANGED');
      if (!args.programIds.every(id=>sources.some(s=>s.programId===id))) throw new SecurityError('SOURCE_NOT_AUTHORIZED');
      const outputs=sources.filter(s=>args.programIds.includes(s.programId)).flatMap(s=>s.outputTypes.flatMap(type=>{
        const r=parent.resources.find(r=>r.type===type);return r?[{programId:s.programId,programDigest:s.programDigest,sourceBindingId:s.bindingId,type,fields:r.fields}]:[];
      }));
      for (const g of grants) if (g.id===current?.id || args.takeover) this.store.revokeGrant(facts.ownerKey,g.id,g.revision);
      const grant=this.store.issueTaskGrant({version:SECURITY_CONTRACT,id:randomUUID(),revision:1,kind:'task_data',status:'active',
        ownerKey:facts.ownerKey,memberId,approvedByMemberId:memberId,installationId:args.installationId,parentGrant:{id:parent.id,revision:parent.revision},
        issuedAt:at,expiresAt:args.expiresAt,taskId:job.id,requestRevision:request.revision,inputs:args.inputs,outputs,purpose:args.purpose,operations:args.operations,channels:args.channels});
      if (args.takeover) {
        this.jobs!.cancelActions(facts.ownerKey,job.id);
        if (job.delegation!.agent) job.delegation!.agentHistory=[...(job.delegation!.agentHistory??[]),job.delegation!.agent];
        delete job.delegation!.agent;delete job.delegation!.plan;delete job.question;delete job.artifact;
        job.delegation!.phase='grounding';job.state='submitted';job.delegation!.nextAt=0;job.revision=(job.revision??0)+1;
        if(job.delegation!.recovery && job.delegation!.recovery.state!=='resolved') {
          job.delegation!.recovery.state='scheduled';job.delegation!.recovery.retryAt=at;job.delegation!.recovery.nextAction='wait_for_retry';
        }
        this.jobs!.save(facts.ownerKey,job);
        // A browser controller explicitly approves internal task processing and
        // selected existing assets. No bearer/token is copied into the worker.
        this.store.attachTaskAuthority({version:SECURITY_CONTRACT,id:randomUUID(),revision:1,ownerKey:facts.ownerKey,memberId,installationId:args.installationId,
          taskId:job.id,requestRevision:request.revision,agentGrant:grant.parentGrant,dataGrant:{id:grant.id,revision:grant.revision},submittedScopes:[],authorityOrigin:'member_controller',
          authEpoch:this.store.requireSubject(args.installationId).epoch,policyVersion:POLICY_VERSION,issuedAt:at,expiresAt:grant.expiresAt});
      }
      return grant;
    });
  }
  private coordinate(target: Pick<Fence, 'ownerKey' | 'kind' | 'targetId'>, change: () => void, restore = false) {
    const fence = this.store.deny(target);
    try { this.store.completeFence(fence, restore ? 'cleared' : 'applied', change); }
    catch { throw new SecurityError('REVOCATION_PENDING', 'Access remains denied; membership reconciliation is required'); }
  }
  setMemberStatus(memberId: string, status: 'active' | 'suspended') {
    const ownerKey = this.owned(memberId);
    if (status === 'active' && this.members.get(memberId).status === 'active' && !this.store.hasFence({ ownerKey, kind: 'member', targetId: memberId })) return this.members.get(memberId);
    this.coordinate({ ownerKey, kind: 'member', targetId: memberId }, () => { this.members.setStatus(memberId, status); }, status === 'active');
    return this.members.get(memberId);
  }
  setConnectionBlocked(memberId: string, connectionId: string, blocked: boolean) {
    const connection = this.members.connections(memberId).find(c => c.id === connectionId);
    if (!connection) throw new DomainError('NOT_FOUND', 'Connection not found');
    if (!blocked && !connection.blocked && !this.store.hasFence({ ownerKey: this.owned(memberId), kind: 'connection', targetId: connection.clientId })) return;
    this.coordinate({ ownerKey: this.owned(memberId), kind: 'connection', targetId: connection.clientId }, () => this.members.block(memberId, connectionId, blocked), !blocked);
  }
  revokeInstallation(memberId: string, installationId: string) {
    const registration = this.members.agents.lookup(installationId);
    if (!registration || registration.memberId !== memberId) throw new DomainError('NOT_FOUND', 'Installation not found');
    this.coordinate({ ownerKey: this.owned(memberId), kind: 'installation', targetId: installationId }, () => this.members.agents.revoke(memberId, installationId));
  }
}
