import type { Client } from 'pg';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError, ownerKey, type Principal } from '../core/domain.js';
import type { GraphStorage, ProjectionMetadata } from '../ontology/graph-program.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import { isVirtualRef } from '../ontology/network-model.js';
import { IncompleteRelationshipRead, type ObjectQuery, type ReadBudget } from '../ontology/object-store.js';
import type { PipelineFactChange } from '../ontology/pipeline/facts.js';
import type { StagedKernelBuilder } from '../ontology/seed-definition.js';
import { combineEnvelopes, type SecurityEnvelope } from '../security/envelope.js';
import { SecurityError } from '../security/errors.js';
import { secureQuerySchema } from '../security/view-contracts.js';
import { postgresEvaluateAuthorizedFunction } from './ontology-functions.js';
import { postgresQueryAuthorizedObjects, PostgresPlanningReadRows, type PostgresOntologyCursor } from './ontology-read-query.js';
import { PostgresProjectionGraph } from './projection-graph.js';
import { postgresBusinessSchema, postgresConstrainReadDeadline } from './runtime-transaction.js';
import { postgresTaskReadOntology, postgresTaskResourceViewValidUntil, type PostgresTaskReadAdmission } from './task-read-access.js';
import type { PostgresTaskReadAuthorization } from './task-output.js';

const hidden = (error: unknown) => error instanceof DomainError && error.code === 'NOT_FOUND'
  || error instanceof SecurityError && ['AUTHORIZATION_REQUIRED', 'INSUFFICIENT_ACCESS', 'OUTPUT_NOT_ALLOWED'].includes(error.reason);
const changeSchema = z.strictObject({ id: z.string().min(1).max(200), componentId: z.string().min(1).max(200),
  object: objectRefSchema, reason: z.enum(['changed', 'conflicted', 'stale', 'restored']), fields: z.array(z.string().min(1).max(200)).max(200),
  semanticRevision: z.number().int().positive().safe(), at: z.iso.datetime({ offset: true }) });

/** Same scope fingerprint used by the synchronous secured model reader. */
export function postgresPlanningAccessDigest(admission:PostgresTaskReadAdmission,operation?:'task.process'){
  return digest({installation:admission.actor.installationId,epoch:admission.actor.authEpoch,
    grant:{id:admission.grant.id,revision:admission.grant.revision},policyRevision:admission.policyRevision,
    operation:operation??(admission.actor.actorKind==='worker'?'task.process':'task.query')});
}

/** Host-only reader for the shared planning programs. It has no business write,
 * private proof or provider operations, and expires with its admitted callback. */
class PlanningReadGraph implements GraphStorage, ProjectionMetadata {
  readonly security = true;
  readonly now = Date.now;
  readonly model;
  readonly releaseRef;
  readonly planning;
  private open = true;
  private readonly owner: string;
  private readonly cursors = new Map<string, PostgresOntologyCursor>();
  private readonly inputs = new Map<string, SecurityEnvelope>();
  private readonly readRows: PostgresPlanningReadRows;
  constructor(private readonly client: Client, private readonly principal: Principal, private readonly taskId: string,
    private readonly policy: string, private readonly auth: PostgresTaskReadAuthorization, private readonly admission: PostgresTaskReadAdmission,
    private readonly storage: PostgresProjectionGraph, private readonly builder?: StagedKernelBuilder,private readonly functionScope?:{id:string;authorization:import('./task-output.js').PostgresFunctionReadAuthorization}) {
    this.owner = ownerKey(principal); this.model = storage.model; this.releaseRef = storage.releaseRef;
    this.readRows = new PostgresPlanningReadRows(client);
    this.planning = { revision: (owner: string) => this.revision(owner),
      evaluate: (owner: string, input: unknown, budget?: ReadBudget) => this.evaluate(owner, input, budget),
      virtualMembership: (owner: string, request: { id: string; revision: number }, ref: ObjectRef) => {
        this.active(owner); if (request.id !== taskId || request.revision !== admission.grant.requestRevision || isVirtualRef(ref)) throw new SecurityError('AUTHORIZATION_REQUIRED');
        return undefined;
      }, pipelineChanges: (owner: string, id: string, revision: number) => this.pipelineChanges(owner, id, revision) };
  }
  close() { this.open = false; this.cursors.clear(); this.readRows.close(); }
  private active(owner = this.owner) { if (!this.open || owner !== this.owner) throw new SecurityError('AUTHORIZATION_REQUIRED'); }
  private charge(budget: ReadBudget) { if (--budget.remaining < 0) throw new DomainError('CONFLICT', 'Ontology read work budget exhausted; narrow the query'); }
  private capture = (input: SecurityEnvelope) => { this.active(); this.inputs.set(digest(input), structuredClone(input)); };
  evidence() { this.active(); return this.inputs.size ? combineEnvelopes([...this.inputs.values()]) : undefined; }
  clearEvidence() { this.active(); this.inputs.clear(); }
  async authorize() { this.active(); const evidence = this.evidence(); if (!evidence) return undefined; const result = await this.auth.authorizeEvidence(evidence); this.active(); return result; }
  async read(owner: string, ref: ObjectRef, budget: ReadBudget = { remaining: 1000 }) {
    this.active(owner); this.charge(budget); objectRefSchema.parse(ref);
    // Absence may satisfy an optional projection. A present but forbidden row
    // must retain its authorization error rather than becoming empty context.
    const exists = await this.readRows.read(this.client, ['exists', owner, ref], async () =>
      (await this.client.query(`SELECT 1 FROM "${postgresBusinessSchema(this.client)}".ontology_objects WHERE owner=$1 AND type=$2 AND id=$3 LIMIT 1`, [owner, ref.type, ref.id])).rows);
    if (!exists.length) throw new DomainError('NOT_FOUND', 'Ontology object is unavailable');
    const result = await this.auth.readObject(ref); this.capture(result.envelope); return result.object;
  }
  async query(owner: string, query: ObjectQuery, budget: ReadBudget = { remaining: 1000 }, readScope?: string) {
    this.active(owner);
    const result = await postgresQueryAuthorizedObjects(this.client, this.principal, secureQuerySchema.parse({ version: 2, taskId: this.taskId,
      expectedRequestRevision: this.admission.grant.requestRevision, query }), this.policy, this.auth, this.builder,
    { budget, readScope, cursors: this.cursors, graph: this.storage, readRows: this.readRows, onRead: this.capture,
      derive: (id, object, nextBudget) => postgresEvaluateAuthorizedFunction(this.client, this.principal, this.taskId,
        this.admission.grant.requestRevision, { function: id, object }, this.policy, this.auth, this.builder,
        { graph: this.storage, budget: nextBudget, accessErrors: 'throw' }) });
    this.active(); return result.query;
  }
  async related(owner: string, ref: ObjectRef, link: string, budget: ReadBudget) {
    const result = await this.query(owner, { from: ref, link, limit: 50 }, budget);
    if (result.page.hasMore) throw new IncompleteRelationshipRead();
    const navigation = this.model.navigation(ref.type, link), side = navigation.direction === 'forward' ? 'from' : 'to';
    const count = await this.client.query(`SELECT count(*) AS n FROM "${postgresBusinessSchema(this.client)}".ontology_links
      WHERE owner=$1 AND type=$2 AND ${side}_type=$3 AND ${side}_id=$4`, [owner, navigation.link.id, ref.type, ref.id]);
    const total = Number(count.rows[0]?.n);
    if (!Number.isSafeInteger(total) || total < 0) throw new DomainError('CONFLICT', 'Invalid relationship count');
    if (total !== result.items.length) throw new IncompleteRelationshipRead();
    this.active(); return result.items;
  }
  async relationshipDigest(owner: string, ref: ObjectRef, budget: ReadBudget) {
    this.active(owner); await this.read(owner, ref, budget);
    const result = await this.storage.relationshipDigestVisible(owner, ref, budget, async link => {
      const until = await postgresTaskResourceViewValidUntil(this.client, this.principal, this.taskId, this.policy, 'linkType', link.type, this.builder);
      if (until <= Date.now()) return false;
      postgresConstrainReadDeadline(this.client, until);
      try { const definition = this.model.object(link.to.type); this.charge(budget);
        const value = await this.auth.readObject(link.to, [definition.primaryKey, definition.titleKey]); this.capture(value.envelope); return true; } catch (error) { if (hidden(error)) return false; throw error; }
    });
    this.active(); return result;
  }
  async evaluate(owner: string, input: unknown, budget: ReadBudget = { remaining: 1000 }) {
    this.active(owner);
    const result = await postgresEvaluateAuthorizedFunction(this.client, this.principal, this.taskId, this.admission.grant.requestRevision,
      input, this.policy, this.auth, this.builder, { graph: this.storage, budget });
    this.capture(result.envelope);
    return { ...result.computation, functionRef: result.functionRef, model: { id: this.model.ref.id, version: 'authorized.v2',
      digest: digest({ functionRef: result.functionRef, access: postgresPlanningAccessDigest(this.admission) }) } };
  }
  private async revision(owner: string) {
    this.active(owner);
    const rows = await this.client.query(`SELECT type,object_id,object_revision FROM "${postgresBusinessSchema(this.client)}".security_bindings
      WHERE grant_id=$1 ORDER BY type COLLATE "C",object_id COLLATE "C" LIMIT 2001`, [this.admission.grant.id]);
    if (rows.rows.length > 2000) throw new DomainError('CONFLICT', 'Task object boundary exceeds the planning budget');
    const bindings = rows.rows.map(row => ({ type: row.type, object_id: row.object_id, object_revision: z.number().int().positive().safe().parse(Number(row.object_revision)) }));
    this.active(); return parseInt(digest([this.admission.policyRevision, this.admission.grant.id, bindings]).slice(0, 12), 16);
  }
  async tombstone(owner: string, ref: ObjectRef) {
    this.active(owner);
    if (this.model.objectWritePolicy(ref.type) !== 'managed') throw new DomainError('FORBIDDEN', 'Protected object tombstones are unavailable');
    const result = await this.storage.tombstone(owner, ref); this.active(); return result;
  }
  private async pipelineChanges(owner: string, taskId: string, revision: number): Promise<PipelineFactChange[]> {
    this.active(owner);
    if (taskId !== this.taskId || revision !== this.admission.grant.requestRevision) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const q = `"${postgresBusinessSchema(this.client)}"`;
    const rows = await this.client.query(`SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.ontology_pipeline_fact_changes
      WHERE __eigos_rowid IN(SELECT max(__eigos_rowid) FROM ${q}.ontology_pipeline_fact_changes WHERE owner=$1 AND job_id=$2 AND request_revision=$3
        GROUP BY ${q}.eigos_try_jsonb(body)->>'componentId',${q}.eigos_try_jsonb(body)#>>'{object,type}',${q}.eigos_try_jsonb(body)#>>'{object,id}')
      ORDER BY __eigos_rowid DESC LIMIT 101`, [owner, taskId, revision]);
    if (rows.rows.length > 100 || rows.rows.some(row => row.body === null)) throw new DomainError('CONFLICT', 'Task fact changes exceed the bounded context limit');
    const result: PipelineFactChange[] = [];
    for (const row of rows.rows) {
      const change = changeSchema.parse(JSON.parse(String(row.body)));
      try {
        const fields: string[] = [];
        for (const field of change.fields) {
          const property = this.model.properties(change.object.type)[field];
          if (!property || property.restricted || property.derived) continue;
          const value = await this.auth.readObject(change.object, [field]);
          // Retain a guard for a removed value as well as a present one. Current
          // field labels/roles are rechecked before this notice can be delivered.
          const guard = structuredClone(value.envelope);
          guard.lineage.push({ object: change.object, revision: value.object.revision, fields: [field], contentDigest: digest({ [field]: value.object.properties[field] }) });
          const approved = await this.auth.authorizeEvidence(guard); this.capture(approved); fields.push(field);
        }
        if (fields.length) result.push({ ...change, fields });
      } catch (error) { if (!(error instanceof DomainError || error instanceof SecurityError)) throw error; }
    }
    this.active(); return result;
  }
  async withGraphFunction<T>(owner:string,id:string,action:(scope:GraphStorage)=>Promise<T>):Promise<T>{
    this.active(owner);this.model.function(id);return this.auth.withFunction(id,async scoped=>{
      const graph=new PlanningReadGraph(this.client,this.principal,this.taskId,this.policy,scoped,this.admission,this.storage,this.builder,{id,authorization:scoped});
      try{const value=await action(graph),influence=await graph.authorize();if(influence)this.capture(influence);this.active();return value;}finally{graph.close();}
    });
  }
  readPrivate(owner?:string,ref?:ObjectRef,budget:ReadBudget={remaining:1000}){
    this.active();const frame=this.functionScope;if(owner===undefined||ref===undefined||!frame||!['rideEstimateStatus','selectDidiPlace'].includes(frame.id)||!['RideEstimateTask','DidiPlaceObservation','RideEstimateObservation'].includes(ref.type))throw new SecurityError('AUTHORIZATION_REQUIRED');
    this.active(owner);this.charge(budget);return (async()=>{const visible=await frame.authorization.readObject(ref);this.capture(visible.envelope);const result=await frame.authorization.readPrivate(ref);this.active();return result;})();
  }
  evidencePropertiesDigest(): never { throw new SecurityError('AUTHORIZATION_REQUIRED'); }
  containsLinks(): never { throw new SecurityError('AUTHORIZATION_REQUIRED'); }
  ingest(): never { throw new SecurityError('AUTHORIZATION_REQUIRED'); }
}

/** Use only inside an existing checked Worker/Agent read callback. No model or
 * provider work belongs here; the returned graph cannot be retained for reuse. */
export async function withPostgresPlanningReadGraph<T>(client: Client, principal: Principal, taskId: string, policy: string,
  auth: PostgresTaskReadAuthorization, admission: PostgresTaskReadAdmission,
  action: (graph: PlanningReadGraph) => Promise<T>, builder?: StagedKernelBuilder): Promise<T> {
  const ontology = await postgresTaskReadOntology(client, principal, taskId, policy, builder);
  const storage = await PostgresProjectionGraph.create(client, ownerKey(principal), ontology.ref, builder, { readOnly: true });
  const graph = new PlanningReadGraph(client, structuredClone(principal), taskId, policy, auth, admission, storage, builder);
  try { const result = await action(graph); await graph.authorize(); return result; }
  finally { graph.close(); }
}
