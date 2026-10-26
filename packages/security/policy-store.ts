import {taskContextFields,TASK_CONTEXT_BINDING_VERSION} from './task-context-contract.js';
import {taskContextMembers} from './task-context.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DomainError,type Job } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { nameSchema, objectRefSchema, type ObjectRef } from '../ontology/model.js';
import type { ObjectBatch, ObjectSource, ObjectView } from '../ontology/object-store.js';
import { POLICY_VERSION, SECURITY_CONTRACT, resourceDefaults, resourceRefSchema, securityEnvelopeSchema,grantRefSchema } from './contracts.js';
import { SecurityError, type SecurityStore, type TaskDataGrant } from './store.js';
import { authorizationScope, withAuthorization,withInference,withIntegrity, type AuthorizationScope } from './context.js';
import { combineEnvelopes, requireChannel, type SecurityEnvelope, type Channel } from './envelope.js';
import { submissionDigest,accessDigest } from './model.js';
import type { ActionIntent, ExecutionAttempt } from '../ontology/actions.js';
import {projectionFields,projectedValue,integrityField,integrityFunctions,projectionContract,projectionInputs,projectionMarkings,responseOnlyProjection} from './projections.js';
import {matchesAgentGrant} from '../core/agent-authorization.js';
import type {PlanGrant} from '../ontology/actions.js';
import {actionSources} from './component-authority.js';
import {compatibleProjectedObject} from '../ontology/task-read-projection.js';
import {DefinitionStore} from '../ontology/definition-store.js';

const id = z.string().min(1).max(200), instant = z.iso.datetime({ offset: true });
const roleSchema = z.strictObject({ subjectKind: z.enum(['member', 'installation']), subjectId: z.uuid(),
  resource: z.union([resourceRefSchema, z.strictObject({ kind: z.literal('namespace'), id, version: id })]),
  role: z.enum(['Viewer', 'Editor', 'Owner']), executeActions: z.array(nameSchema).max(100).default([]),
  invokeFunctions: z.array(nameSchema).max(100).default([]), expiresAt: instant });
export const sourceAuthorizationSchema = z.strictObject({ installationId: z.uuid(), bindingId: id, programId: id,
  programDigest: z.string().regex(/^[a-f0-9]{64}$/), operations: z.array(id).min(1).max(100),
  outputTypes: z.array(nameSchema).min(1).max(200), expiresAt: instant });
const storedSourceSchema=sourceAuthorizationSchema.extend({parentGrant:grantRefSchema,
  // Operator-reviewed predecessor versions may explain existing observations.
  // They never authorize dispatch or enter newly provisioned task outputs.
  readbackVersions:z.array(z.strictObject({sourceBindingId:id,programDigest:z.string().regex(/^[a-f0-9]{64}$/)})).max(32).optional()});
const baseline = JSON.parse(readFileSync(new URL('./baseline.json', import.meta.url), 'utf8')) as {
  types: Record<string, { fingerprint: string; fields: Record<string, string> }>;
};
const refKey = (ref: ObjectRef) => JSON.stringify([ref.type, ref.id]);
export const TASK_PROJECTION_TYPES = ['GoalCoverage','OutcomeAssessment','ExecutionFeedback',...Object.keys(taskContextFields)];
export interface ObjectBinding { object: ObjectRef; revision: number; fields: string[]; sourceBindingId: string; envelope: SecurityEnvelope; inputEnvelope?: SecurityEnvelope }

/** Policy records share the task transaction. Only trusted administration calls
 * setRole; a member data grant never manufactures a platform resource role. */
export class SecurityPolicies {
  readonly definitionDigest:string;
  get model() { return this.security.model; }
  private roleCache=new WeakMap<AuthorizationScope,z.infer<typeof roleSchema>[]>();
  private labelCache=new WeakMap<AuthorizationScope,Map<string,{field:string;body:Record<string,unknown>}[]>>();
  constructor(private db: DatabaseSync, readonly security: SecurityStore,readOnly=false) {
    const existing=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='security_policy'").get();
    const definitions=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='security_policy_definitions'").get();
    const expected=digest({model:this.model.ref,fields:baseline.types,projection:projectionContract,taskContext:{version:TASK_CONTEXT_BINDING_VERSION,fields:taskContextFields,capabilityReader:'immutable-compatible-definition-v1'},roles:z.toJSONSchema(roleSchema),source:z.toJSONSchema(storedSourceSchema)});
    this.definitionDigest=expected;
    if(security.enabled && existing && (!definitions || db.prepare('SELECT digest FROM security_policy_definitions WHERE slot=1').get()?.digest!==expected)) throw new Error('Security policy contract changed or is missing; explicit migration is required');
    if(security.enabled && existing) {
      const revision=db.prepare('SELECT revision FROM security_policy WHERE slot=1').get()?.revision;
      if(!Number.isSafeInteger(revision) || Number(revision)<1)throw new Error('Security policy authority is missing; explicit recovery is required');
      for(const name of ['security_roles','security_sources','security_bindings','security_cursors','security_outputs','security_reads','security_artifacts','security_model_channels','security_recipients','security_object_origins','security_labels','security_recoveries','security_private_views']) {
        if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))throw new Error('Security policy table is missing; explicit recovery is required');
      }
    }
    if(readOnly)return;
    db.exec(`CREATE TABLE IF NOT EXISTS security_policy(slot INTEGER PRIMARY KEY CHECK(slot=1),revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO security_policy VALUES(1,1);
      CREATE TABLE IF NOT EXISTS security_roles(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_sources(owner TEXT NOT NULL,installation_id TEXT NOT NULL,binding_id TEXT NOT NULL,program_id TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(installation_id,binding_id,program_id));
      CREATE TABLE IF NOT EXISTS security_bindings(grant_id TEXT NOT NULL,owner TEXT NOT NULL,task_id TEXT NOT NULL,request_revision INTEGER NOT NULL,type TEXT NOT NULL,object_id TEXT NOT NULL,object_revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(grant_id,type,object_id));
      CREATE INDEX IF NOT EXISTS security_bindings_task ON security_bindings(owner,task_id,request_revision);
      CREATE TABLE IF NOT EXISTS security_cursors(id TEXT PRIMARY KEY,context TEXT NOT NULL,expires_at INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_outputs(owner TEXT NOT NULL,task_id TEXT NOT NULL,output_id TEXT NOT NULL,content_digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,task_id,output_id));
      CREATE TABLE IF NOT EXISTS security_reads(grant_id TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(grant_id,digest));
      CREATE TABLE IF NOT EXISTS security_artifacts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,task_id TEXT NOT NULL,name TEXT NOT NULL,media_type TEXT NOT NULL,content BLOB NOT NULL,content_digest TEXT NOT NULL,envelope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_model_channels(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_private_views(owner TEXT NOT NULL,type TEXT NOT NULL,object_id TEXT NOT NULL,field TEXT NOT NULL,content_digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,type,object_id,field));`);
    db.exec('CREATE TABLE IF NOT EXISTS security_policy_definitions(slot INTEGER PRIMARY KEY CHECK(slot=1),digest TEXT NOT NULL);');
    db.prepare('INSERT OR IGNORE INTO security_policy_definitions VALUES(1,?)').run(expected);
    db.exec(`CREATE TABLE IF NOT EXISTS security_recipients(installation_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_object_origins(owner TEXT NOT NULL,type TEXT NOT NULL,object_id TEXT NOT NULL,object_revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,type,object_id,object_revision));
      CREATE TABLE IF NOT EXISTS security_labels(owner TEXT NOT NULL,type TEXT NOT NULL,object_id TEXT NOT NULL,field TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,type,object_id,field));`);
  }
  revision() {
    try {
      const row=this.db.prepare('SELECT p.revision,d.digest FROM security_policy p JOIN security_policy_definitions d ON d.slot=p.slot WHERE p.slot=1').get();
      if(!row || !Number.isSafeInteger(row.revision) || Number(row.revision)<1 || this.security.enabled && row.digest!==this.definitionDigest)throw new Error('Missing policy authority');
      return Number(row.revision);
    }catch{throw new SecurityError('AUTHORITY_UNAVAILABLE');}
  }
  private change(expectedRevision: number) {
    if (this.db.prepare('UPDATE security_policy SET revision=revision+1 WHERE slot=1 AND revision=?').run(expectedRevision).changes !== 1) throw new SecurityError('POLICY_CHANGED');
  }
  setRole(input: unknown, expectedRevision: number) {
    const role = roleSchema.parse(input), r = role.resource;
    if (r.kind === 'namespace') { if (r.id !== this.model.ref.id || r.version !== this.model.ref.digest) throw new SecurityError('POLICY_CHANGED'); }
    else if (this.resourceVersion(r.kind, r.id) !== r.version) throw new SecurityError('POLICY_CHANGED');
    for (const action of role.executeActions) this.model.action(action);
    for (const fn of role.invokeFunctions) this.model.function(fn);
    if (Date.parse(role.expiresAt) <= this.security.now()) throw new SecurityError('ACCESS_REVOKED');
    return this.security.atomic(() => { this.change(expectedRevision); const id = digest([role.subjectKind, role.subjectId, r]); this.db.prepare('INSERT INTO security_roles VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id, role.subjectId, JSON.stringify(role)); return { id, revision: this.revision() }; });
  }
  revokeRole(id: string, expectedRevision: number) { this.security.atomic(() => { this.change(expectedRevision); this.db.prepare('DELETE FROM security_roles WHERE id=?').run(id); }); }
  reviewDefinition(input:unknown,expectedRevision:number) {
    const args=z.strictObject({installationId:z.uuid(),resource:resourceRefSchema,operation:z.enum(['edit','manage']),candidate:z.record(z.string(),z.unknown())}).parse(input);
    if(this.revision()!==expectedRevision || this.resourceVersion(args.resource.kind,args.resource.id)!==args.resource.version || args.candidate.id!==args.resource.id)throw new SecurityError('POLICY_CHANGED');
    const subject=this.security.requireSubject(args.installationId),permission=args.operation==='manage'?'resource.manage':'resource.edit';
    if(!this.resourceAllowedFor(subject.memberId,subject.installationId,args.resource.kind,args.resource.id,permission))throw new SecurityError('AUTHORIZATION_REQUIRED');
    const types=new Set<string>();
    if(args.resource.kind==='linkType') {
      const current=this.model.link(args.resource.id),next=z.object({from:z.object({type:nameSchema}),to:z.object({type:nameSchema})}).parse(args.candidate);
      [current.from.type,current.to.type,next.from.type,next.to.type].forEach(type=>types.add(type));
    }
    if(args.resource.kind==='actionType') {
      const current=this.model.action(args.resource.id),next=z.object({inputs:z.record(nameSchema,nameSchema),changes:z.array(z.string()).max(200)}).parse(args.candidate);
      [...Object.values(current.inputs),...current.changes.map(c=>c.split('.')[0]!),...Object.values(next.inputs),...next.changes.map(c=>c.split('.')[0]!)].forEach(type=>types.add(type));
    }
    for(const type of types)if(!this.resourceAllowedFor(subject.memberId,subject.installationId,this.model.isInterface(type)?'interface':'objectType',type,'resource.edit'))throw new SecurityError('AUTHORIZATION_REQUIRED');
    return {allowed:true,candidateDigest:digest(args.candidate),resource:args.resource,policyRevision:expectedRevision,published:false,declassificationAllowed:false};
  }
  resourceVersion(kind: string, id: string): string {
    if (kind === 'objectType') return this.model.object(id).version;
    if (kind === 'interface') return digest(this.model.describeType(id));
    if (kind === 'function') return this.model.function(id).version;
    return digest(kind === 'actionType' ? this.model.action(id) : this.model.link(id));
  }
  resourceAllowed(scope: AuthorizationScope, kind: string, id: string, permission = 'resource.view'): boolean {
    scope.assertCurrent();
    let roles=this.roleCache.get(scope);
    if(!roles){roles=this.roles(scope.actor.memberId,scope.actor.installationId);this.roleCache.set(scope,roles);}
    return this.roleAllows(roles,scope.actor.memberId,scope.actor.installationId,kind,id,permission);
  }
  resourceAllowedFor(memberId:string,installationId:string,kind:string,id:string,permission='resource.view'):boolean {
    return this.roleAllows(this.roles(memberId,installationId),memberId,installationId,kind,id,permission);
  }
  private roles(memberId:string,installationId:string){return this.db.prepare('SELECT body FROM security_roles WHERE subject_id IN (?,?)').all(memberId,installationId).map(row=>roleSchema.parse(JSON.parse(String(row.body))));}
  private roleAllows(roles:z.infer<typeof roleSchema>[],memberId:string,installationId:string,kind:string,id:string,permission:string) {
    let version: string; try { version = this.resourceVersion(kind, id); } catch { return false; }
    return roles.some(value => {
      const ref = value.resource;
      if (Date.parse(value.expiresAt) <= this.security.now() || (value.subjectKind === 'member' ? value.subjectId !== memberId : value.subjectId !== installationId)) return false;
      const matches = ref.kind === 'namespace' ? ref.id === this.model.ref.id && ref.version === this.model.ref.digest : ref.kind === kind && ref.id === id && ref.version === version;
      return matches && (permission === 'action.execute' ? value.executeActions.includes(id) : permission === 'function.invoke' ? value.invokeFunctions.includes(id) : (resourceDefaults[value.role] as readonly string[]).includes(permission));
    });
  }
  requireResource(scope: AuthorizationScope, kind: string, id: string, permission = 'resource.view') {
    if (!this.resourceAllowed(scope, kind, id, permission)) throw new SecurityError('AUTHORIZATION_REQUIRED');
  }
  scope(owner: string, requireTask = true): AuthorizationScope {
    const scope = authorizationScope();
    if (!scope || scope.actor.ownerKey !== owner || requireTask && !scope.grant) throw new SecurityError('AUTHORIZATION_REQUIRED');
    scope.assertCurrent(); return scope;
  }
  setSource(owner: string, input: unknown, expectedRevision: number) {
    const source = sourceAuthorizationSchema.parse(input), subject = this.security.requireSubject(source.installationId);
    const parent = this.security.agentGrant(source.installationId);
    if (subject.ownerKey !== owner || !parent.capabilityIds.includes(source.programId) || !parent.sourceBindingIds.includes(source.bindingId)
      || Date.parse(source.expiresAt) <= this.security.now() || Date.parse(source.expiresAt) > Date.parse(parent.expiresAt)) throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    for (const type of source.outputTypes) this.model.object(type);
    const row=this.db.prepare("SELECT state,body FROM security_sources WHERE owner=? AND installation_id=? AND binding_id=? AND program_id=?").get(owner,source.installationId,source.bindingId,source.programId);
    const prior=row?storedSourceSchema.parse(JSON.parse(String(row.body))):undefined;
    const readbackVersions=row?.state==='active' && prior?.programDigest===source.programDigest && prior.parentGrant.id===parent.id && prior.parentGrant.revision===parent.revision ? prior.readbackVersions : undefined;
    this.security.atomic(() => { this.change(expectedRevision); this.db.prepare("INSERT INTO security_sources VALUES(?,?,?,?,'active',?) ON CONFLICT(installation_id,binding_id,program_id) DO UPDATE SET state='active',body=excluded.body")
      .run(owner, source.installationId, source.bindingId, source.programId, JSON.stringify({...source,parentGrant:{id:parent.id,revision:parent.revision},...(readbackVersions?{readbackVersions}:{})})); });
  }
  sources(owner: string, installationId: string) {
    let parent;try{parent=this.security.agentGrant(installationId);}catch{return [];}
    if(parent.ownerKey!==owner) return [];
    return this.db.prepare("SELECT body FROM security_sources WHERE owner=? AND installation_id=? AND state='active'").all(owner, installationId)
      .map(row => storedSourceSchema.parse(JSON.parse(String(row.body)))).filter(s => Date.parse(s.expiresAt) > this.security.now() && s.parentGrant.id===parent.id && s.parentGrant.revision===parent.revision);
  }
  revokeSource(owner: string, installationId: string, bindingId: string, expectedRevision: number) {
    this.security.atomic(() => { this.change(expectedRevision);
      const bindings=new Set([bindingId]);
      for(const row of this.db.prepare('SELECT body FROM security_sources WHERE owner=? AND installation_id=? AND binding_id=?').all(owner,installationId,bindingId))
        for(const version of storedSourceSchema.parse(JSON.parse(String(row.body))).readbackVersions??[])bindings.add(version.sourceBindingId);
      this.db.prepare("UPDATE security_sources SET state='revoked' WHERE owner=? AND installation_id=? AND binding_id=?").run(owner, installationId, bindingId);
      for (const g of this.security.listGrants(owner)) if (g.kind === 'task_data' && g.installationId === installationId && g.status === 'active' && g.outputs.some(o => bindings.has(o.sourceBindingId))) this.security.revokeGrant(owner, g.id, g.revision);
    });
  }
  requireSource(scope: AuthorizationScope, programId: string, programDigest: string, operation?: string) {
    scope.assertCurrent();
    const source = this.sources(scope.actor.ownerKey, scope.actor.installationId).find(s => s.programId === programId && s.programDigest === programDigest && (!operation || s.operations.includes(operation)));
    if (!source || !scope.grant?.outputs.some(o => o.programId === programId && o.programDigest === programDigest && o.sourceBindingId === source.bindingId)) throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    return source;
  }
  requireDispatch(owner:string,intent:ActionIntent,kind:ExecutionAttempt['kind']) {
    const scope=this.scope(owner);
    if (scope.actor.actorKind!=='worker' || scope.grant?.taskId!==intent.jobId) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const row=this.db.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(owner,intent.jobId),job=row?JSON.parse(String(row.body)) as Job:undefined;
    const agent=job?.delegation?.agent;
    const plan=agent?.plans.find((p:{digest:string})=>p.digest===intent.planDigest),step=plan?.steps.find((s:{intentId:string})=>s.intentId===intent.id);
    if (!agent || !plan || !step || plan.programDigest!==agent.programDigest || step.effect!==intent.effect) throw new SecurityError('AUTHORIZATION_REQUIRED');
    this.requireResource(scope,'actionType',step.action); this.requireResource(scope,'actionType',step.action,'action.execute');
    for(const source of actionSources(agent,step.action,step.input,step))this.requireSource(scope,source.programRef.id,source.programDigest,step.action);
    if (!['dispatch','observe','reconcile','resume'].includes(kind)) throw new SecurityError('AUTHORIZATION_REQUIRED');
    return {plan,step};
  }
  checkAction(scope:AuthorizationScope,action:string):string {
    if(scope.actor.actorKind==='agent' && !scope.actor.tokenScopes.includes('tasks:write'))return 'AUTHORIZATION_REQUIRED';
    if(!this.resourceAllowed(scope,'actionType',action) || !this.resourceAllowed(scope,'actionType',action,'action.execute'))return 'AUTHORIZATION_REQUIRED';
    if(!scope.grant?.operations.includes('task.process'))return 'AUTHORIZATION_REQUIRED';
    const authority=this.security.workAuthority(scope.actor.ownerKey,scope.grant.taskId);
    if(!authority || authority.installationId!==scope.actor.installationId || authority.dataGrant.id!==scope.grant.id)return 'AUTHORIZATION_REQUIRED';
    const row=this.db.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(scope.actor.ownerKey,scope.grant.taskId),job=row?JSON.parse(String(row.body)) as Job:undefined;
    const agent=job?.delegation?.agent,plan=agent?.plans.find(p=>p.id===agent.pendingPlanId),step=plan?.steps.find(s=>s.action===action);
    if(!plan || !step)return 'PLAN_REQUIRED';
    if(plan.ontologyPlanning.accessDigest!==accessDigest())return 'POLICY_CHANGED';
    const intent=this.db.prepare('SELECT state FROM action_intents WHERE owner=? AND id=?').get(scope.actor.ownerKey,step.intentId);
    if(intent?.state!=='ready')return 'ORIGINAL_OPERATION_ONLY';
    try{for(const source of actionSources(agent!,action,step.input,step))this.requireSource(scope,source.programRef.id,source.programDigest,action);}catch{return 'SOURCE_NOT_AUTHORIZED';}
    const inspect=(value:unknown):boolean=>{
      if(!value || typeof value!=='object')return true;
      const ref=objectRefSchema.safeParse(value);return ref.success?!!this.binding(scope,ref.data):Object.values(value).every(inspect);
    };
    if(!inspect(step.input))return 'INSUFFICIENT_ACCESS';
    if(!['read','local'].includes(step.effect)) {
      const grants=this.db.prepare('SELECT body FROM plan_grants WHERE owner=? AND job_id=?').all(scope.actor.ownerKey,scope.grant.taskId);
      if(!grants.some(row=>matchesAgentGrant(JSON.parse(String(row.body)) as PlanGrant,plan,step,this.security.now())))return 'BUSINESS_AUTHORIZATION_REQUIRED';
    }
    return 'ALLOWED';
  }
  fieldPolicy(type: string, field: string) {
    const value = baseline.types[type];
    if (!value || value.fingerprint !== this.model.fingerprint(type)) return 'internal_only';
    if(Object.hasOwn(projectionFields(type),field)) return 'task_sensitive';
    if (!value.fields[field] || this.model.properties(type)[field]?.restricted) return 'internal_only';
    return value.fields[field]!;
  }
  fields(type:string) {return {...this.model.properties(type),...projectionFields(type)};}
  value(type:string,field:string,properties:Record<string,unknown>) {
    if(!responseOnlyProjection(type,field) || Object.hasOwn(properties,field))return projectedValue(type,field,properties);
    const scope=authorizationScope(),id=properties[this.model.object(type).primaryKey];if(!scope || typeof id!=='string')return;
    const row=this.db.prepare('SELECT content_digest,body FROM security_private_views WHERE owner=? AND type=? AND object_id=? AND field=?').get(scope.actor.ownerKey,type,id,field);
    if(!row)return;const body=JSON.parse(String(row.body));if(digest(body)!==row.content_digest)throw new SecurityError('POLICY_CHANGED');
    return projectionFields(type)[field]!.schema.parse(body);
  }
  storePrivateView(owner:string,ref:ObjectRef,field:string,input:unknown) {
    const scope=this.scope(owner);
    if(scope.actor.actorKind!=='worker' || !scope.projection || !responseOnlyProjection(ref.type,field))throw new SecurityError('AUTHORIZATION_REQUIRED');
    const binding=this.requireObject(owner,ref);if(!binding.fields.includes(field))return;
    const value=projectionFields(ref.type)[field]!.schema.parse(input),fingerprint=digest(value);
    const old=this.db.prepare('SELECT content_digest FROM security_private_views WHERE owner=? AND type=? AND object_id=? AND field=?').get(owner,ref.type,ref.id,field);
    if(old && old.content_digest!==fingerprint)throw new SecurityError('POLICY_CHANGED');
    this.db.prepare('INSERT OR IGNORE INTO security_private_views VALUES(?,?,?,?,?,?)').run(owner,ref.type,ref.id,field,fingerprint,JSON.stringify(value));
  }
  responseOnlyValue(owner:string,ref:ObjectRef,field:string) {
    const scope=this.scope(owner),binding=this.requireObject(owner,ref);
    if(scope.actor.actorKind!=='worker' || !responseOnlyProjection(ref.type,field) || !binding.fields.includes(field))throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const value=this.value(ref.type,field,{[this.model.object(ref.type).primaryKey]:ref.id});if(value===undefined)throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const envelope=combineEnvelopes([this.envelope(owner,ref,binding.revision,[field],{[field]:value},scope.grant!.channels),...(binding.inputEnvelope?[binding.inputEnvelope]:[])]);
    this.validateLineage(scope,envelope);this.capture(scope,envelope);return value;
  }
  integrityAllowed(type:string,field:string,allowed:string[]) {return integrityField(type,field,allowed);}
  envelope(owner: string, ref: ObjectRef, revision: number, fields: string[], properties: Record<string, unknown>, channels: Channel[]): SecurityEnvelope {
    const policies = fields.map(f => this.fieldPolicy(ref.type, f));
    const dependencies=fields.filter(f=>(ref.type!=='ServiceRequest' || !['progress','projectionState','currentAssessment','requestedOutcome'].includes(f)) && this.fieldPolicy(ref.type,f)!=='derived_from_inputs').sort();
    const result:SecurityEnvelope={ version: SECURITY_CONTRACT, ownerKey: owner, policyVersion: POLICY_VERSION, requiredMarkings: policies.includes('task_sensitive') ? ['member_private', 'personal_data'] : ['member_private'],
      classification: policies.includes('internal_only') ? 'internal' : policies.includes('task_sensitive') ? 'sensitive' : 'private', channels,
      lineage: [{ object: ref, revision, fields: dependencies, contentDigest: digest(Object.fromEntries(dependencies.map(f => [f, this.value(ref.type,f,properties)]))) }], lineageComplete: true };
    result.requiredMarkings=[...new Set([...result.requiredMarkings,...fields.flatMap(field=>projectionMarkings(ref.type,field))])];
    if(fields.some(field=>responseOnlyProjection(ref.type,field)))result.channels=result.channels.filter(channel=>channel!=='registered_model');
    const scope=authorizationScope(),key=JSON.stringify([owner,ref.type,ref.id]);
    let cache=scope?this.labelCache.get(scope):undefined;if(scope && !cache){cache=new Map();this.labelCache.set(scope,cache);}
    let records=cache?.get(key);
    if(!records){records=this.db.prepare('SELECT field,body FROM security_labels WHERE owner=? AND type=? AND object_id=?').all(owner,ref.type,ref.id).map(row=>({field:String(row.field),body:JSON.parse(String(row.body))}));cache?.set(key,records);}
    const policyFields=new Set([...fields,...fields.flatMap(field=>projectionInputs(ref.type,field))]);
    const labels=records.filter(row=>row.field==='*' || policyFields.has(row.field)).map(row=>({...result,...row.body} as SecurityEnvelope));
    return labels.length?combineEnvelopes([result,...labels]):result;
  }
  bind(grant: TaskDataGrant, ref: ObjectRef, fields: string[], sourceBindingId: string, inputEnvelope?:SecurityEnvelope) {
    const row = this.db.prepare('SELECT revision,body,definition_digest FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(grant.ownerKey, ref.type, ref.id);
    if (!row)throw new SecurityError('POLICY_CHANGED');
    const body=JSON.parse(String(row.body));
    if(row.definition_digest!==this.model.fingerprint(ref.type)) {
      // Capability descriptions are content-addressed and deliberately reused
      // across tasks. A current published reader may accept an unchanged older
      // writer, but this exception never applies to provider facts or assets.
      let sharedCapability=false;
      if(sourceBindingId==='task_context' && ref.type==='RegisteredCapability' && body.source?.kind==='task'
        && this.contextMembers(grant.ownerKey,grant.taskId,grant.requestRevision).has(refKey(ref))) {
        const jobRow=this.db.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(grant.ownerKey,grant.taskId);
        const job=jobRow?JSON.parse(String(jobRow.body)) as Job:undefined,reader=job?.delegation?.ontologyRelease;
        if(reader && job?.delegation?.request.revision===grant.requestRevision) {
          const release=new DefinitionStore(this.db,Date.now,{readOnly:true}).resolve(reader);
          sharedCapability=release.model.ref.digest===this.model.ref.digest && release.compatibleDefinition({kind:'object',id:ref.type,storedDigest:String(row.definition_digest),currentDigest:this.model.fingerprint(ref.type),properties:body.properties});
        }
      }
      if(!sharedCapability && (grant.operations.includes('task.process') || !compatibleProjectedObject(this.db,grant.ownerKey,grant.taskId,ref.type,String(row.definition_digest),body.properties,this.model.ref.digest)))throw new SecurityError('POLICY_CHANGED');
    }
    if (sourceBindingId==='member_asset') {
      const originRow=this.db.prepare('SELECT body FROM security_object_origins WHERE owner=? AND type=? AND object_id=? AND object_revision=?').get(grant.ownerKey,ref.type,ref.id,Number(row.revision));
      const origin=originRow?JSON.parse(String(originRow.body)) as {programId:string;programDigest:string;sourceBindingId:string;inputEnvelope?:SecurityEnvelope}:undefined;
      if (body.source.kind==='provider' && !origin) throw new SecurityError('SOURCE_NOT_AUTHORIZED');
      if (origin) {
        if (!this.sources(grant.ownerKey,grant.installationId).some(s=>s.bindingId===origin.sourceBindingId && s.programId===origin.programId && s.programDigest===origin.programDigest)) throw new SecurityError('SOURCE_NOT_AUTHORIZED');
        sourceBindingId=origin.sourceBindingId;
        inputEnvelope=origin.inputEnvelope;
      }
    }
    const safe = [...new Set(fields)].filter(f => this.fieldPolicy(ref.type, f) !== 'internal_only');
    const own=this.envelope(grant.ownerKey, ref, Number(row.revision), safe, JSON.parse(String(row.body)).properties, grant.channels);
    const binding: ObjectBinding = { object: ref, revision: Number(row.revision), fields: safe, sourceBindingId,
      envelope: inputEnvelope?combineEnvelopes([own,inputEnvelope]):own,...(inputEnvelope?{inputEnvelope}:{} ) };
    this.db.prepare('INSERT INTO security_bindings VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(grant_id,type,object_id) DO UPDATE SET object_revision=excluded.object_revision,body=excluded.body')
      .run(grant.id, grant.ownerKey, grant.taskId, grant.requestRevision, ref.type, ref.id, Number(row.revision), JSON.stringify(binding));
  }
  bindInputs(grant: TaskDataGrant) {
    for (const input of grant.inputs) this.bind(grant, input.object, input.fields, 'member_asset');
    const parent = this.security.agentGrant(grant.installationId), fields = parent.resources.find(r => r.type === 'ServiceRequest')?.fields ?? [];
    this.bind(grant, { type: 'ServiceRequest', id: grant.taskId }, fields, 'task_submission');
  }
  bindTaskProjection(owner: string, taskId: string) {
    for (const g of this.security.listGrants(owner)) if (g.kind === 'task_data' && g.taskId === taskId && g.status === 'active') {
      const row = this.db.prepare('SELECT body FROM jobs WHERE id=? AND owner=?').get(taskId, owner);
      if (row && JSON.parse(String(row.body)).delegation?.request.revision === g.requestRevision) {
        const job=JSON.parse(String(row.body)) as Job,parent=this.security.agentGrant(g.installationId);
        const fields = parent.resources.find(r => r.type === 'ServiceRequest')?.fields ?? [];
        this.bind(g, { type: 'ServiceRequest', id: taskId }, fields, 'task_submission');
        const root=this.db.prepare("SELECT body,revision FROM ontology_objects WHERE owner=? AND type='ServiceRequest' AND id=?").get(owner,taskId)!;
        const properties=JSON.parse(String(root.body)).properties;
        const bindingRef=job.delegation?.agent?.programRef??job.delegation?.plan?.bindingRef;
        const refs:ObjectRef[]=[...(job.delegation?.goalCoverage?[{type:'GoalCoverage',id:job.delegation.goalCoverage.digest}]:[]),
          ...(properties.currentAssessment?[objectRefSchema.parse(properties.currentAssessment)]:[]),
          ...(bindingRef?[{type:'ExecutionFeedback',id:digest({request:taskId,revision:g.requestRevision,bindingRef})}]:[])];
        const inherited=combineEnvelopes([this.envelope(owner,{type:'ServiceRequest',id:taskId},Number(root.revision),['originalGoal'],properties,g.channels),
          ...this.db.prepare("SELECT r.body FROM security_reads r JOIN security_grants issued ON issued.id=r.grant_id WHERE issued.owner=? AND issued.kind='task_data' AND json_extract(issued.body,'$.taskId')=? AND json_extract(issued.body,'$.requestRevision')=?").all(owner,taskId,g.requestRevision).map(row=>securityEnvelopeSchema.parse(JSON.parse(String(row.body))))]);
        for(const ref of this.contextMembers(owner,taskId,g.requestRevision).values()) {
          const fields=(parent.resources.find(r=>r.type===ref.type)?.fields??[]).filter(field=>taskContextFields[ref.type]!.includes(field));
          if(fields.length)this.bind(g,ref,fields,'task_context',inherited);
        }
        for(const ref of refs) {
          const resource=parent.resources.find(r=>r.type===ref.type);
          if(!resource || !TASK_PROJECTION_TYPES.includes(ref.type))continue;
          const object=this.db.prepare('SELECT body FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(owner,ref.type,ref.id);
          if(!object)continue;
          const body=JSON.parse(String(object.body));
          if(body.source.kind!=='task' || body.source.id!==taskId || body.properties.requestRevision!==g.requestRevision)throw new SecurityError('POLICY_CHANGED');
          this.bind(g,ref,resource.fields,'task_projection',inherited);
        }
      }
    }
  }
  /** A single synchronous read keeps repeated authority checks cheap. Local DB
   * writes and commits from another connection invalidate it immediately; time
   * bounds and a full exit check prevent a lease/consent expiry escaping it.
   * It never spans source calls, promises, dispatch or another model tool call. */
  readSnapshot<T>(action:()=>T):T {
    const scope=authorizationScope();if(!scope || scope.synchronousRead)return action();
    const stamp=()=>`${this.db.prepare('PRAGMA data_version').get()!.data_version}:${this.db.prepare('SELECT total_changes() AS n').get()!.n}`;
    scope.assertCurrent();let checked=stamp(),at=this.security.now(),active=true;const bindings=new Map<string,unknown>(),members=new Map<string,Map<string,ObjectRef>>();
    const validity=[this.security.agentGrant(scope.actor.installationId).expiresAt,scope.grant?.expiresAt,this.recipient(scope.actor.installationId)?.expiresAt,...this.sources(scope.actor.ownerKey,scope.actor.installationId).map(s=>s.expiresAt),...this.roles(scope.actor.memberId,scope.actor.installationId).map(r=>r.expiresAt)].filter((v):v is string=>!!v).map(Date.parse);
    const validUntil=Math.min(...validity);
    const current=()=>{if(!active)throw new SecurityError('AUTHORIZATION_REQUIRED');const next=stamp(),now=this.security.now();if(next!==checked || now>=validUntil || now<at){bindings.clear();members.clear();}if(next!==checked || now-at>=10 || now<at){scope.assertCurrent();checked=next;at=this.security.now();}};
    try {
      return withAuthorization({...scope,synchronousRead:true,readBindings:bindings,readTaskMembers:members,assertCurrent:current},()=>{
        const value=action();if(value && typeof value==='object' && 'then' in value)throw new Error('Authorization read must be synchronous');return value;
      });
    }finally{active=false;scope.assertCurrent();if(this.security.now()>=validUntil)throw new SecurityError('POLICY_CHANGED');}
  }
  private contextMembers(owner:string,taskId:string,revision:number) {
    const scope=authorizationScope();scope?.assertCurrent();
    const cache=scope?.readTaskMembers,key=JSON.stringify([owner,taskId,revision]),cached=cache?.get(key);
    if(cached)return cached;
    const members=taskContextMembers(this.db,owner,taskId,revision);cache?.set(key,members);return members;
  }
  binding(scope: AuthorizationScope, ref: ObjectRef, revision?: number): ObjectBinding | undefined {
    scope.assertCurrent();
    if(!scope.grant)return;
    if(scope.readBindings?.has(refKey(ref))) {
      const cached=scope.readBindings.get(refKey(ref)) as ObjectBinding | undefined;
      return cached && (revision===undefined || cached.revision===revision)?cached:undefined;
    }
    // One bounded read shares verified authority and dependency results. Recheck
    // at its end; never carry this memo across a tool call, write or async turn.
    const parent=this.security.agentGrant(scope.actor.installationId),clearance=this.recipient(scope.actor.installationId);
    const sources=this.sources(scope.actor.ownerKey,scope.actor.installationId),roles=this.roles(scope.actor.memberId,scope.actor.installationId);
    const checked=scope.readBindings as Map<string,ObjectBinding|undefined> | undefined ?? new Map<string,ObjectBinding|undefined>();
    const read=(ref:ObjectRef,revision?:number):ObjectBinding|undefined=>{
      const key=refKey(ref);
      if(checked.has(key)){const cached=checked.get(key);return cached && (revision===undefined || cached.revision===revision)?cached:undefined;}
      if(!this.roleAllows(roles,scope.actor.memberId,scope.actor.installationId,'objectType',ref.type,'resource.view'))return;
      const row=this.db.prepare('SELECT b.body FROM security_bindings b JOIN ontology_objects o ON o.owner=b.owner AND o.type=b.type AND o.id=b.object_id AND o.revision=b.object_revision WHERE b.grant_id=? AND b.type=? AND b.object_id=?').get(scope.grant!.id,ref.type,ref.id);
      if(!row)return;
      const binding=JSON.parse(String(row.body)) as ObjectBinding;
      if(revision!==undefined && binding.revision!==revision)return;
      const allowed=parent.resources.find(r=>r.type===ref.type)?.fields??[];
      binding.fields=binding.fields.filter(field=>{
        if(!allowed.includes(field) || this.fieldPolicy(ref.type,field)==='internal_only')return false;
        const restrictions=[this.envelope(scope.actor.ownerKey,ref,binding.revision,[field],{},scope.grant!.channels),...(binding.inputEnvelope?[binding.inputEnvelope]:[])];
        return restrictions.every(e=>this.qualified(e,clearance) && (scope.actor.actorKind!=='agent' || e.channels.includes('agent_response') && !!clearance?.channels.includes('agent_response')));
      });
      const definition=this.model.object(ref.type);
      if(!binding.fields.includes(definition.primaryKey) || !binding.fields.includes(definition.titleKey))return;
      if(binding.sourceBindingId==='task_projection') {
        const row=this.db.prepare('SELECT body FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(scope.actor.ownerKey,ref.type,ref.id);
        const body=row?JSON.parse(String(row.body)):undefined;
        if(!TASK_PROJECTION_TYPES.includes(ref.type) || body?.source.kind!=='task' || body.source.id!==scope.grant!.taskId || body.properties.requestRevision!==scope.grant!.requestRevision)return;
      } else if(binding.sourceBindingId==='task_context') {
        if(!this.contextMembers(scope.actor.ownerKey,scope.grant!.taskId,scope.grant!.requestRevision).has(refKey(ref)))return;
        const row=this.db.prepare('SELECT body FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(scope.actor.ownerKey,ref.type,ref.id),properties=row?JSON.parse(String(row.body)).properties:{};
        if(ref.type==='RegisteredActionType' && !this.resourceAllowed(scope,'actionType',String(properties.actionId)))return;
        if(ref.type==='RegisteredCapability' && !parent.capabilityIds.includes(properties.capabilityRef?.id))return;
        binding.fields=binding.fields.filter(field=>taskContextFields[ref.type]?.includes(field));
      } else if(!['task_submission','member_asset'].includes(binding.sourceBindingId)) {
        const row=this.db.prepare('SELECT body FROM security_object_origins WHERE owner=? AND type=? AND object_id=? AND object_revision=?').get(scope.actor.ownerKey,ref.type,ref.id,binding.revision);
        const origin=row?JSON.parse(String(row.body)) as {programId:string;programDigest:string;sourceBindingId:string}:undefined;
        if(!origin || origin.sourceBindingId!==binding.sourceBindingId || !sources.some(s=>s.programId===origin.programId && s.outputTypes.includes(ref.type)
          && (s.bindingId===origin.sourceBindingId && s.programDigest===origin.programDigest
            || s.readbackVersions?.some(version=>version.sourceBindingId===origin.sourceBindingId && version.programDigest===origin.programDigest))))return;
      }
      // Apply dependency visibility before filtering/counting rows. Otherwise a
      // WHERE miss could reveal a bit about data whose inputs were revoked.
      checked.set(key,binding);
      if(binding.inputEnvelope)for(const dependency of binding.inputEnvelope.lineage) {
        const input=read(dependency.object,dependency.object.type==='ServiceRequest' || taskContextFields[dependency.object.type]?undefined:dependency.revision);
        if(!input || !dependency.fields || dependency.fields.some(f=>!input.fields.includes(f))){checked.set(key,undefined);return;}
        const properties=this.lineageProperties(scope,dependency);
        if(digest(Object.fromEntries(dependency.fields.map(f=>[f,this.value(dependency.object.type,f,properties)])))!==dependency.contentDigest){checked.set(key,undefined);return;}
      }
      return binding;
    };
    const result=read(ref,revision);scope.assertCurrent();return result;
  }
  requireObject(owner: string, ref: ObjectRef, revision?: number) {
    const scope = this.scope(owner), value = this.binding(scope, ref, revision);
    if (!value) throw new DomainError('NOT_FOUND', 'Object is not available in this task');
    return value;
  }
  predicate(owner: string, alias: string, fields: string[] = []) {
    const scope = this.scope(owner),rows=this.db.prepare('SELECT type,object_id FROM security_bindings WHERE grant_id=? LIMIT 2001').all(scope.grant!.id);
    if(rows.length>2000) throw new DomainError('CONFLICT','Task object boundary exceeds the supported query budget');
    const refs=rows.flatMap(row=>{const b=this.binding(scope,{type:String(row.type),id:String(row.object_id)});return b && fields.every(f=>b.fields.includes(f))?[b.object]:[];});
    return {sql:` AND EXISTS(SELECT 1 FROM json_each(?) visible WHERE json_extract(visible.value,'$.type')=${alias}.type AND json_extract(visible.value,'$.id')=${alias}.id)`,params:[JSON.stringify(refs)]};
  }
  project(owner: string, value: ObjectView, selected?: string[]): ObjectView {
    const scope = this.scope(owner), binding = this.requireObject(owner, value.ref, value.revision), properties: Record<string, unknown> = {};
    for (const [field, content] of Object.entries(value.properties)) {
      if (!binding.fields.includes(field)) {
        if(scope.integrity && this.integrityAllowed(value.ref.type,field,binding.fields)) continue;
        if (selected?.includes(field) || scope.inference && this.fieldPolicy(value.ref.type,field)!=='internal_only') throw new SecurityError('INSUFFICIENT_ACCESS'); continue;
      }
      const inspect = (v: unknown): boolean => {
        if (!v || typeof v !== 'object') return true;
        const ref = objectRefSchema.safeParse(v); if (ref.success) return !!this.binding(scope, ref.data);
        return Object.values(v).every(inspect);
      };
      if (!inspect(content)) {
        // The current assessment is optional derived task metadata. A source
        // verifier only reading the request must not gain access to it or need
        // a broader grant. taskOutcomeStatus returns unknown when it is absent.
        if(value.ref.type==='ServiceRequest' && field==='currentAssessment' && !selected?.includes(field))continue;
        if (selected?.includes(field) || scope.inference) throw new SecurityError('INSUFFICIENT_ACCESS'); continue;
      }
      properties[field] = content;
    }
    const envelope = combineEnvelopes([this.envelope(owner, value.ref, value.revision, Object.keys(properties), properties, scope.grant!.channels),...(binding.inputEnvelope?[binding.inputEnvelope]:[])]);
    this.capture(scope,envelope);
    const technical=scope.integrity?Object.fromEntries(Object.entries(value.properties).filter(([field])=>this.integrityAllowed(value.ref.type,field,binding.fields))):{};
    return { ...value, properties:{...properties,...technical} };
  }
  visibleRevision(owner: string): number {
    const scope = this.scope(owner), rows = this.db.prepare('SELECT type,object_id,object_revision FROM security_bindings WHERE grant_id=? ORDER BY type,object_id').all(scope.grant!.id);
    return parseInt(digest([scope.policyRevision, scope.grant!.id, rows]).slice(0, 12), 16);
  }
  cursor(owner: string, query: string, token?: string, value?: ObjectRef): ObjectRef | string | undefined {
    const scope = this.scope(owner), context = digest([scope.actor.installationId, scope.actor.authEpoch, scope.grant!.id, scope.grant!.revision, scope.policyRevision, query, this.visibleRevision(owner)]);
    if (token) {
      const row = this.db.prepare('SELECT body FROM security_cursors WHERE id=? AND context=? AND expires_at>?').get(token, context, this.security.now());
      if (!row) throw new SecurityError('POLICY_CHANGED'); return objectRefSchema.parse(JSON.parse(String(row.body)));
    }
    if (!value) return;
    const id = randomUUID(); this.db.prepare('DELETE FROM security_cursors WHERE expires_at<=?').run(this.security.now());
    this.db.prepare('INSERT INTO security_cursors VALUES(?,?,?,?)').run(id, context, Math.min(this.security.now() + 300000, Date.parse(scope.grant!.expiresAt)), JSON.stringify(value)); return id;
  }
  recordProjection(owner: string, batch: ObjectBatch, _source: ObjectSource) {
    const scope = this.scope(owner), origin = scope.projection;
    if (scope.actor.actorKind !== 'worker' || !origin) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const source = this.requireSource(scope, origin.programId, origin.programDigest);
    const inputEnvelope=this.outputEnvelope(owner);
    for (const object of batch.objects) {
      const rule = scope.grant!.outputs.find(o => o.programId === origin.programId && o.programDigest === origin.programDigest && o.sourceBindingId === source.bindingId && o.type === object.ref.type);
      if (!rule || !source.outputTypes.includes(object.ref.type)) throw new SecurityError('SOURCE_NOT_AUTHORIZED');
      this.bind(scope.grant!, object.ref, rule.fields, source.bindingId,inputEnvelope);
      const revision=this.db.prepare('SELECT revision FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(owner,object.ref.type,object.ref.id)!.revision;
      this.db.prepare('INSERT OR IGNORE INTO security_object_origins VALUES(?,?,?,?,?)').run(owner,object.ref.type,object.ref.id,Number(revision),JSON.stringify({...origin,inputEnvelope}));
    }
    for (const edge of [...(batch.links ?? []), ...(batch.removeLinks ?? [])]) {
      this.requireResource(scope, 'linkType', edge.type);
      this.requireObject(owner, edge.from); this.requireObject(owner, edge.to);
    }
  }
  infer<T>(owner: string, functionId: string, action: () => T): T {
    const scope = this.scope(owner); this.requireResource(scope, 'function', functionId); this.requireResource(scope, 'function', functionId, 'function.invoke');
    return withInference(()=>integrityFunctions.has(functionId)?withIntegrity(action):action());
  }
  outputEnvelope(owner: string): SecurityEnvelope { const scope = this.scope(owner); return combineEnvelopes([...scope.lineage.values()]); }
  capture(scope:AuthorizationScope,envelope:SecurityEnvelope) {
    if (!scope.grant) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const key=digest(envelope);if(scope.lineage.has(key))return;scope.lineage.set(key,envelope);
    if (scope.actor.actorKind==='worker') this.db.prepare('INSERT OR IGNORE INTO security_reads VALUES(?,?,?)').run(scope.grant.id,key,JSON.stringify(envelope));
  }
  loadLineage(scope:AuthorizationScope) {
    if (!scope.grant) return;
    for (const row of this.db.prepare('SELECT digest,body FROM security_reads WHERE grant_id=?').all(scope.grant.id)) scope.lineage.set(String(row.digest),securityEnvelopeSchema.parse(JSON.parse(String(row.body))));
  }
  private lineageProperties(scope:AuthorizationScope,dependency:SecurityEnvelope['lineage'][number]) {
    const row=this.db.prepare('SELECT body,revision FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(scope.actor.ownerKey,dependency.object.type,dependency.object.id);
    if(!row)throw new SecurityError('OUTPUT_NOT_ALLOWED');
    if(dependency.object.type==='ServiceRequest' || Number(row.revision)===dependency.revision)return JSON.parse(String(row.body)).properties;
    // Only reviewed task-control records may use their immutable writer history.
    // A changed provider fact never gains this exception; current grants and
    // current field labels still apply before this historical hash is checked.
    if(!taskContextFields[dependency.object.type])throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const old=this.db.prepare('SELECT body,definition_digest FROM ontology_object_versions WHERE ontology_id=? AND owner=? AND type=? AND id=? AND revision=? AND deleted=0').get(this.model.ref.id,scope.actor.ownerKey,dependency.object.type,dependency.object.id,dependency.revision);
    if(!old || old.definition_digest!==this.model.fingerprint(dependency.object.type))throw new SecurityError('OUTPUT_NOT_ALLOWED');
    return JSON.parse(String(old.body)).properties;
  }
  validateLineage(scope:AuthorizationScope,envelope:SecurityEnvelope) {
    scope.assertCurrent();
    if (envelope.submission) {
      const row=this.db.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(scope.actor.ownerKey,envelope.submission.taskId);
      const request=row?JSON.parse(String(row.body)).delegation?.request:undefined;
      if (!request || scope.grant?.taskId!==envelope.submission.taskId || request.revision!==envelope.submission.requestRevision || submissionDigest(request)!==envelope.submission.contentDigest) throw new SecurityError('OUTPUT_NOT_ALLOWED');
    }
    for (const dependency of envelope.lineage) {
      const binding=this.binding(scope,dependency.object);
      if (!binding || !dependency.fields || dependency.fields.some(f=>!binding.fields.includes(f)) || dependency.object.type!=='ServiceRequest' && !taskContextFields[dependency.object.type] && binding.revision!==dependency.revision) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      const properties=this.lineageProperties(scope,dependency);
      if (digest(Object.fromEntries(dependency.fields.map(f=>[f,this.value(dependency.object.type,f,properties)])))!==dependency.contentDigest) throw new SecurityError('OUTPUT_NOT_ALLOWED');
    }
  }
  effectiveEnvelope(scope:AuthorizationScope,envelope:SecurityEnvelope):SecurityEnvelope {
    this.validateLineage(scope,envelope);
    const current=envelope.lineage.map(dependency=>{
      const row=this.db.prepare('SELECT body,revision FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(scope.actor.ownerKey,dependency.object.type,dependency.object.id)!;
      return this.envelope(scope.actor.ownerKey,dependency.object,Number(row.revision),dependency.fields!,JSON.parse(String(row.body)).properties,scope.grant!.channels);
    });
    // Re-evaluate current labels; a historical output label cannot undo an upgrade.
    return combineEnvelopes([envelope,...current]);
  }
  setRecipient(installationId:string,input:unknown,expectedRevision:number) {
    z.uuid().parse(installationId);this.security.requireSubject(installationId);
    const value=z.strictObject({classification:z.enum(['private','sensitive']),markings:securityEnvelopeSchema.shape.requiredMarkings,
      channels:securityEnvelopeSchema.shape.channels,expiresAt:instant}).parse(input);
    this.security.atomic(()=>{this.change(expectedRevision);this.db.prepare('INSERT INTO security_recipients VALUES(?,?) ON CONFLICT(installation_id) DO UPDATE SET body=excluded.body').run(installationId,JSON.stringify(value));});
  }
  private recipient(installationId:string) {
    const row=this.db.prepare('SELECT body FROM security_recipients WHERE installation_id=?').get(installationId);
    const value=row?JSON.parse(String(row.body)) as {classification:'private'|'sensitive';markings:SecurityEnvelope['requiredMarkings'];channels:Channel[];expiresAt:string}:undefined;
    return value && Date.parse(value.expiresAt)>this.security.now()?value:undefined;
  }
  private qualified(envelope:SecurityEnvelope,clearance:ReturnType<SecurityPolicies['recipient']>):boolean {
    const rank={private:0,sensitive:1,internal:2};
    return !!clearance && rank[envelope.classification]<=rank[clearance.classification] && envelope.requiredMarkings.every(m=>clearance.markings.includes(m));
  }
  /** Trusted policy management only. This operation can only add restrictions;
   * removing a marking or lowering a class has no ordinary API. */
  restrictObject(input:unknown,expectedRevision:number) {
    const args=z.strictObject({ownerKey:z.string().min(1),object:objectRefSchema,expectedObjectRevision:z.number().int().positive(),field:z.string().min(1).max(80).default('*'),
      classification:securityEnvelopeSchema.shape.classification,requiredMarkings:securityEnvelopeSchema.shape.requiredMarkings,channels:securityEnvelopeSchema.shape.channels}).parse(input);
    const row=this.db.prepare('SELECT revision FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(args.ownerKey,args.object.type,args.object.id);
    if(!row || row.revision!==args.expectedObjectRevision || args.field!=='*' && !Object.hasOwn(this.model.properties(args.object.type),args.field)) throw new SecurityError('POLICY_CHANGED');
    this.security.atomic(()=>{
      this.change(expectedRevision);
      const old=this.db.prepare('SELECT body FROM security_labels WHERE owner=? AND type=? AND object_id=? AND field=?').get(args.ownerKey,args.object.type,args.object.id,args.field);
      const floor={version:SECURITY_CONTRACT,ownerKey:args.ownerKey,policyVersion:POLICY_VERSION,lineage:[],lineageComplete:true};
      const value=combineEnvelopes([{...floor,classification:args.classification,requiredMarkings:args.requiredMarkings,channels:args.channels},...(old?[{...floor,...JSON.parse(String(old.body))} as SecurityEnvelope]:[])]);
      this.db.prepare('INSERT INTO security_labels VALUES(?,?,?,?,?) ON CONFLICT(owner,type,object_id,field) DO UPDATE SET body=excluded.body').run(args.ownerKey,args.object.type,args.object.id,args.field,
        JSON.stringify({classification:value.classification,requiredMarkings:value.requiredMarkings,channels:value.channels}));
    });
  }
  requireRecipient(scope:AuthorizationScope,envelope:SecurityEnvelope,channel:Channel) {
    const value=this.recipient(scope.actor.installationId);
    if(!value || Date.parse(value.expiresAt)<=this.security.now() || !value.channels.includes(channel) || !scope.grant?.channels.includes(channel)) throw new SecurityError('OUTPUT_NOT_ALLOWED');
    requireChannel(this.effectiveEnvelope(scope,envelope),channel,value);
  }
  recordOutput(owner: string, taskId: string, outputId: string, content: unknown, envelope: SecurityEnvelope) {
    const scope = this.scope(owner); if (scope.grant?.taskId !== taskId || scope.actor.actorKind !== 'worker') throw new SecurityError('OUTPUT_NOT_ALLOWED');
    scope.assertCurrent();
    const previous=this.db.prepare('SELECT body FROM security_outputs WHERE owner=? AND task_id=? AND output_id=?').get(owner,taskId,outputId);
    const old=previous?securityEnvelopeSchema.parse(JSON.parse(String(previous.body))):undefined;
    const combined=old && old.submission?.requestRevision===envelope.submission?.requestRevision?combineEnvelopes([old,envelope]):envelope;
    this.db.prepare('INSERT INTO security_outputs VALUES(?,?,?,?,?) ON CONFLICT(owner,task_id,output_id) DO UPDATE SET content_digest=excluded.content_digest,body=excluded.body')
      .run(owner, taskId, outputId, digest(content), JSON.stringify(securityEnvelopeSchema.parse(combined)));
  }
  output(owner: string, taskId: string, outputId: string, content: unknown): SecurityEnvelope | undefined {
    const scope = this.scope(owner); if (scope.grant?.taskId !== taskId) return;
    const row = this.db.prepare('SELECT body,content_digest FROM security_outputs WHERE owner=? AND task_id=? AND output_id=?').get(owner, taskId, outputId);
    if (!row || row.content_digest !== digest(content)) return;
    const envelope = securityEnvelopeSchema.parse(JSON.parse(String(row.body)));
    try { return this.effectiveEnvelope(scope,envelope); } catch {return;}
  }
  setModelChannel(id: string, input: unknown, expectedRevision: number) {
    const value = z.strictObject({ classification: z.enum(['private', 'sensitive']), markings: securityEnvelopeSchema.shape.requiredMarkings, expiresAt: instant }).parse(input);
    this.security.atomic(() => { this.change(expectedRevision); this.db.prepare('INSERT INTO security_model_channels VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id, JSON.stringify(value)); });
  }
  modelChannel(id: string) {
    const row = this.db.prepare('SELECT body FROM security_model_channels WHERE id=?').get(id);
    const value = row ? JSON.parse(String(row.body)) as { classification: 'private' | 'sensitive'; markings: SecurityEnvelope['requiredMarkings']; expiresAt: string } : undefined;
    if (!value || Date.parse(value.expiresAt) <= this.security.now()) throw new SecurityError('OUTPUT_NOT_ALLOWED'); return value;
  }
  /** Human controller selector: owned, grantable fields only. Resource roles
   * still apply; internal fields and labels never become a delegation option. */
  memberCandidates(owner:string,memberId:string) {
    const types=this.model.typeIds().filter(type=>!this.model.isInterface(type) && this.resourceAllowedFor(memberId,'','objectType',type));
    if(!types.length)return [];
    return this.db.prepare('SELECT type,id,revision,body FROM ontology_objects WHERE owner=? AND type IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC LIMIT 500').all(owner,JSON.stringify(types)).flatMap(row=>{
      try {
        const ref={type:String(row.type),id:String(row.id)},properties=JSON.parse(String(row.body)).properties as Record<string,unknown>;
        const fields=Object.keys(this.fields(ref.type)).filter(field=>{
          if(this.fieldPolicy(ref.type,field)==='internal_only')return false;
          const envelope=this.envelope(owner,ref,Number(row.revision),[field],properties,['member_ui']);
          return envelope.classification!=='internal' && envelope.channels.includes('member_ui');
        });
        const definition=this.model.object(ref.type);
        if(!fields.includes(definition.primaryKey) || !fields.includes(definition.titleKey))return [];
        return [{object:ref,objectRevision:Number(row.revision),title:String(properties[definition.titleKey]??ref.id).slice(0,200),fields}];
      }catch{return [];}
    }).slice(0,200);
  }
  createArtifact(owner:string,taskId:string,input:{name:string;mediaType:string;content:Uint8Array}) {
    const scope=this.scope(owner);
    if (scope.actor.actorKind!=='worker' || scope.grant?.taskId!==taskId || !scope.grant.operations.includes('artifact.export')) throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const name=z.string().min(1).max(160).regex(/^[^\u0000-\u001f/\\]+$/).parse(input.name);
    const mediaType=z.enum(['text/plain','text/markdown','text/csv','application/json','application/pdf']).parse(input.mediaType);
    if (!input.content.length || input.content.byteLength>5_000_000) throw new DomainError('INVALID_INPUT','Artifact size is outside the controlled download limit');
    const envelope=this.outputEnvelope(owner);this.validateLineage(scope,envelope);
    if (!envelope.channels.includes('controlled_download')) throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const id=randomUUID(),content=Buffer.from(input.content);
    this.db.prepare('INSERT INTO security_artifacts VALUES(?,?,?,?,?,?,?,?)').run(id,owner,taskId,name,mediaType,content,digest(content.toString('base64')),JSON.stringify(envelope));
    return {id,name,mediaType,size:content.length};
  }
  artifacts(owner:string,taskId:string) {
    const scope=this.scope(owner);
    if (scope.grant?.taskId!==taskId || !scope.grant.operations.includes('artifact.export') || !scope.grant.channels.includes('controlled_download')) return [];
    return this.db.prepare('SELECT id,name,media_type,length(content) AS size,envelope FROM security_artifacts WHERE owner=? AND task_id=?').all(owner,taskId).flatMap(row=>{
      try {const envelope=securityEnvelopeSchema.parse(JSON.parse(String(row.envelope)));this.requireRecipient(scope,envelope,'controlled_download');
        return [{id:String(row.id),name:String(row.name),mediaType:String(row.media_type),size:Number(row.size)}];} catch {return [];}
    });
  }
  download(owner:string,taskId:string,artifactId:string) {
    const scope=this.scope(owner),metadata=this.artifacts(owner,taskId).find(a=>a.id===artifactId);
    if (!metadata) throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const row=this.db.prepare('SELECT content,content_digest FROM security_artifacts WHERE owner=? AND task_id=? AND id=?').get(owner,taskId,artifactId)!;
    const content=Buffer.from(row.content as Uint8Array);if (digest(content.toString('base64'))!==row.content_digest) throw new SecurityError('POLICY_CHANGED');
    scope.assertCurrent();return {...metadata,content};
  }
}
