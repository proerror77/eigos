import { AsyncLocalStorage } from 'node:async_hooks';
import type { Client } from 'pg';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError,type Principal } from '../core/domain.js';
import type { WorkClaim } from '../core/store.js';
import type { ActionDiscoveryPage, ActionDiscoveryQuery } from '../core/action-bindings.js';
import type { ExecutablePlanningSession } from '../coordinator/native-planning-session.js';
import { PlanningSessionState, modelSessionKey, type PlanningMetadata, type PlanningSessionOptions } from '../coordinator/planning-program.js';
import { runGraphProgramAsync, type GraphStorage, type ProjectionMetadata } from '../ontology/graph-program.js';
import { readOntologyRequestProgram } from '../ontology/execution-projection.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import type { ServiceRequest, ResolvedCandidate } from '../ontology/execution.js';
import type { PlanningReadReceipt } from '../ontology/planning-contract.js';
import type { StagedKernelBuilder } from '../ontology/seed-definition.js';
import { authorizedDefinitionCatalogue, describeDefinitionCatalogue } from '../security/definition-view.js';
import { securityEnvelopeSchema } from '../security/contracts.js';
import { SecurityError } from '../security/errors.js';
import type { SecurityEnvelope } from '../security/envelope.js';
import { submissionDigest } from '../security/submission-digest.js';
import { withPostgresPlanningReadGraph, postgresPlanningAccessDigest } from './planning-read-graph.js';
import { withPostgresTaskDefinitionAccess } from './ontology-metadata.js';
import { postgresBusinessSchema,postgresBusinessToken } from './runtime-transaction.js';
import type { PostgresTaskReadAuthorization } from './task-output.js';
import type { PostgresTaskReadAdmission } from './task-read-access.js';
import { postgresWorkReference, type PostgresWorkReference } from './work-claim.js';
import type { PostgresWorkerStore } from './worker-store.js';

type ReadGraph = Parameters<Parameters<typeof withPostgresPlanningReadGraph>[6]>[0];
type PlanningStore = Pick<PostgresWorkerStore, 'readRequest' | 'readEvidence'>;
/** Host callback capability only. Never part of a tool's portable arguments,
 * response, or model context. It expires with this exact checked read scope. */
export interface PostgresPlanningDiscoveryContext {
  readonly client:Client;readonly claim:PostgresWorkReference;readonly principal:Principal;
  readonly authorization:PostgresTaskReadAuthorization;readonly admission:PostgresTaskReadAdmission;
  readonly policyDigest:string;readonly modelChannel:string;
  assertActive():void;
}
const discoveryScopes=new WeakMap<object,{client:Client;token:object;open:()=>boolean;active:()=>void}>();
/** Reject structural lookalikes as well as closed/reused real capabilities. */
export function assertPostgresPlanningDiscoveryContext(scope:PostgresPlanningDiscoveryContext):void{
  const current=discoveryScopes.get(scope);
  if(!current||!current.open())throw new SecurityError('AUTHORIZATION_REQUIRED');
  current.active();if(postgresBusinessToken(current.client)!==current.token)throw new SecurityError('AUTHORIZATION_REQUIRED');
}
interface Options extends PlanningSessionOptions {
  candidates?: ResolvedCandidate[]; boundRefs?: ObjectRef[]; readScope?: 'owner' | 'request'; signal?: AbortSignal; builder?: StagedKernelBuilder;
  discoverActions?: (graph: GraphStorage & ProjectionMetadata, owner: string, request: ServiceRequest, input: ActionDiscoveryQuery, context:PostgresPlanningDiscoveryContext) => Promise<ActionDiscoveryPage>;
}
const refKey = (ref: ObjectRef) => JSON.stringify([ref.type, ref.id]);
const snapshotSchema = z.strictObject({ ref: objectRefSchema, revision: z.number().int().positive().safe(), propertiesDigest: z.string().regex(/^[a-f0-9]{64}$/), linksDigest: z.string().regex(/^[a-f0-9]{64}$/) });
const receiptSchema = z.looseObject({ id: z.uuid(), at: z.iso.datetime({ offset: true }), tool: z.string().min(1).max(80),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/), outputDigest: z.string().regex(/^[a-f0-9]{64}$/), datasetRevision: z.number().int().nonnegative().safe(),
  status: z.enum(['ok', 'rejected']), origin: z.enum(['model', 'worker_context']).optional(), outputBytes: z.number().int().nonnegative().max(600000).optional(),
  objects: z.array(snapshotSchema).max(150), deliveredObjects: z.array(snapshotSchema).max(150).optional(), instructionRefs: z.array(objectRefSchema).max(2000).optional(),
  accessDigest: z.string().regex(/^[a-f0-9]{64}$/), securityEnvelope: securityEnvelopeSchema.optional() });
function freeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

/** Receipt-only bookkeeping on the existing checked read transaction. It does
 * not advance the Job fence, reproject the task, or grant execution authority. */
async function recordRead(client: Client, claim: PostgresWorkReference, admission: PostgresTaskReadAdmission,
  auth: PostgresTaskReadAuthorization, input: PlanningReadReceipt, influence: SecurityEnvelope | undefined) {
  const receipt = structuredClone(input); receiptSchema.parse(receipt);
  if (receipt.accessDigest !== postgresPlanningAccessDigest(admission) || admission.actor.actorKind !== 'worker'
    || admission.actor.taskId !== claim.job.id || admission.grant.taskId !== claim.job.id
    || digest(receipt.securityEnvelope ?? null) !== digest(influence ?? null)) throw new SecurityError('POLICY_CHANGED');
  if (Buffer.byteLength(JSON.stringify(receipt)) > 1048576) throw new DomainError('CONFLICT', 'Planning receipt exceeds its storage bound');
  const q = `"${postgresBusinessSchema(client)}"`;
  if (influence) {
    const approved = await auth.authorizeEvidence(influence);
    await client.query(`INSERT INTO ${q}.security_reads(grant_id,digest,body) VALUES($1,$2,$3) ON CONFLICT(grant_id,digest) DO NOTHING`,
      [admission.grant.id, digest(approved), JSON.stringify(approved)]);
  }
  const result = await client.query(`WITH candidate AS MATERIALIZED (
    SELECT j.id,j.owner,j.body AS original,${q}.eigos_try_jsonb(j.body) AS value FROM ${q}.jobs j
    WHERE j.owner=$1 AND j.id=$2 AND octet_length(j.body)<=8388608),
    checked AS MATERIALIZED (SELECT *,CASE WHEN jsonb_typeof(value->'delegation')='object'
      AND (value#>'{delegation,ontologyReads}' IS NULL OR value#>'{delegation,ontologyReads}'='null'::jsonb OR jsonb_typeof(value#>'{delegation,ontologyReads}')='array')
      THEN COALESCE(NULLIF(value#>'{delegation,ontologyReads}','null'::jsonb),'[]'::jsonb) END AS reads,
      CASE WHEN value->'revision' IS NULL OR value->'revision'='null'::jsonb THEN 0
        WHEN jsonb_typeof(value->'revision')='number' AND octet_length(value->>'revision')<=64 THEN (value->>'revision')::numeric END AS revision FROM candidate),
    appended AS MATERIALIZED (SELECT *,jsonb_set(value,'{delegation,ontologyReads}',reads||$4::jsonb)::text AS body FROM checked
      WHERE revision=$3 AND reads IS NOT NULL AND jsonb_array_length(reads)<2000 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(reads) item WHERE item->>'id'=$5))
    UPDATE ${q}.jobs j SET body=a.body FROM appended a WHERE j.id=a.id AND j.owner=a.owner AND j.body=a.original
      AND octet_length(a.body)<=8388608 RETURNING j.id`, [claim.owner, claim.job.id, claim.job.revision ?? 0, JSON.stringify([receipt]), receipt.id]);
  if (result.rowCount !== 1) throw new DomainError('CONFLICT', 'Planning receipt no longer matches the current bounded task');
}

/** Bind only the checked reader. The private projection graph and client never
 * enter the portable planning program or the model-facing MCP transport. */
function storage(graph: ReadGraph, hooks: NonNullable<GraphStorage['planning']> = {}): GraphStorage {
  return { read: (...args) => graph.read(...args), query: (...args) => graph.query(...args), related: (...args) => graph.related(...args),
    relationshipDigest: (...args) => graph.relationshipDigest(...args), tombstone: (...args) => graph.tombstone(...args),
    readPrivate: () => graph.readPrivate(), containsLinks: () => graph.containsLinks(), evidencePropertiesDigest: () => graph.evidencePropertiesDigest(),
    ingest: () => graph.ingest(), planning: { ...graph.planning, ...hooks } };
}

/** One real PostgreSQL-backed model decision. RPCs serialize local state, but
 * each SQL snapshot closes before a model/provider can run. State is adopted
 * only after the fenced read and its durable receipt commit successfully. */
export class PostgresNativePlanningSession implements ExecutablePlanningSession {
  readonly asynchronous = true;
  readonly graph: ProjectionMetadata & { readonly security: true };
  readonly request: ServiceRequest;
  private readonly state: PlanningSessionState;
  private readonly scope = new AsyncLocalStorage<PostgresNativePlanningSession>();
  private queue: Promise<unknown> = Promise.resolve();
  private operations: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(private readonly store: PlanningStore, private readonly claim: PostgresWorkReference,
    private readonly policy: string, private readonly channel: string, graph: ProjectionMetadata, request: ServiceRequest,
    private readonly bounds: ObjectRef[], private readonly options: Options, private readonly key: string) {
    this.graph = Object.freeze({ model: graph.model, now: graph.now, releaseRef: graph.releaseRef, security: true });
    this.request = freeze(structuredClone(request));
    this.state = new PlanningSessionState(this.graph, claim.owner, this.request, options.candidates, () => this.active(), options.readScope ?? 'request', bounds, options);
  }
  static async create(store: PlanningStore, input: WorkClaim, policy: string, channel: string, options: Options = {}) {
    const claim = postgresWorkReference(input); z.string().min(1).max(200).parse(channel); options.signal?.throwIfAborted();
    if (options.actionCatalog && !options.discoverActions) throw new Error('PostgreSQL action catalog requires its checked discovery adapter');
    const authorized = await store.readRequest(claim, channel);
    const initial = await store.readEvidence(claim, channel, (auth, admission, principal, client) =>
      withPostgresPlanningReadGraph(client, principal, claim.job.id, policy, auth, admission, async graph => {
        options.signal?.throwIfAborted();
        const request = options.taskContext ? await runGraphProgramAsync(graph, readOntologyRequestProgram(graph, claim.owner, claim.job.id)) : authorized;
        if (submissionDigest(request) !== submissionDigest(authorized)) throw new SecurityError('POLICY_CHANGED');
        const bounds = [...new Map([...(options.boundRefs ?? []), ...admission.grant.inputs.map(value => value.object)].map(ref => [refKey(ref), ref])).values()];
        if (bounds.length > 2000) throw new DomainError('CONFLICT', 'Planning navigation exceeds the task object boundary');
        const influence = await graph.authorize();
        if (influence) await client.query(`INSERT INTO "${postgresBusinessSchema(client)}".security_reads(grant_id,digest,body) VALUES($1,$2,$3) ON CONFLICT(grant_id,digest) DO NOTHING`,
          [admission.grant.id, digest(influence), JSON.stringify(influence)]);
        return { model: graph.model, now: graph.now, releaseRef: graph.releaseRef, request, bounds,
          key: modelSessionKey(claim.owner, request, graph.model.ref, postgresPlanningAccessDigest(admission)) };
      }, options.builder));
    return new PostgresNativePlanningSession(store, claim, policy, channel, initial, initial.request, initial.bounds, options, initial.key);
  }
  private active() { this.options.signal?.throwIfAborted(); if (this.closed) throw new DomainError('CONFLICT', 'Planning session is closed'); }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    this.active(); if (this.scope.getStore() === this) return action();
    const execute = () => this.scope.run(this, async () => { this.active(); return action(); });
    const pending = this.queue.then(execute, execute); this.queue = pending.then(() => undefined, () => undefined); return pending;
  }
  private operation<T>(action: () => Promise<T>): Promise<T> {
    const execute = async () => { this.active(); return action(); };
    const pending = this.operations.then(execute, execute); this.operations = pending.then(() => undefined, () => undefined); return pending;
  }
  private rpc<T>(action: (next: PlanningSessionState, graph: ReadGraph, driver: GraphStorage) => Promise<T>, navigation = false): Promise<T> {
    return this.serial(() => this.operation(async () => {
      const committed = await this.store.readEvidence(this.claim, this.channel, (auth, admission, principal, client) =>
        withPostgresPlanningReadGraph(client, principal, this.request.id, this.policy, auth, admission, graph =>
          withPostgresTaskDefinitionAccess(client, principal, this.request.id, this.policy, async (access, selected) => {
            this.active(); if (digest(selected.ref) !== digest(this.graph.model.ref)) throw new SecurityError('POLICY_CHANGED');
            await auth.readTaskRoot();
            const allowed = new Set<string>();
            if (navigation) for (const ref of this.bounds) {
              try { const definition = graph.model.object(ref.type); await auth.readObject(ref, [definition.primaryKey, definition.titleKey]); allowed.add(refKey(ref)); }
              catch (error) { if (!(error instanceof SecurityError && ['AUTHORIZATION_REQUIRED','INSUFFICIENT_ACCESS','OUTPUT_NOT_ALLOWED'].includes(error.reason) || error instanceof DomainError && error.code === 'NOT_FOUND')) throw error; }
            }
            const meta: PlanningMetadata = { model: graph.model, now: graph.now, releaseRef: graph.releaseRef, security: true,
              authorization: { accessDigest: () => postgresPlanningAccessDigest(admission),
                definitions: () => authorizedDefinitionCatalogue(access, selected), describe: input => describeDefinitionCatalogue(access, input, selected),
                binding: ref => allowed.has(refKey(ref)), requireResource: (kind, id) => { if (!access.resourceAllowed(kind, id)) throw new SecurityError('AUTHORIZATION_REQUIRED'); },
                receipt: () => { const envelope = graph.evidence(); return { accessDigest: postgresPlanningAccessDigest(admission), ...(envelope ? { securityEnvelope: envelope } : {}) }; } } };
            const token=postgresBusinessToken(client);let discoveryOpen=true;
            const discovery:PostgresPlanningDiscoveryContext=Object.freeze({client,claim:postgresWorkReference(this.claim),principal:freeze(structuredClone(principal)),authorization:auth,admission:freeze(structuredClone(admission)),policyDigest:this.policy,modelChannel:this.channel,
              assertActive:()=>assertPostgresPlanningDiscoveryContext(discovery)});
            discoveryScopes.set(discovery,{client,token,open:()=>discoveryOpen,active:()=>this.active()});
            const next = this.state.fork(meta), driver = storage(graph, {
              recordRead: receipt => recordRead(client, this.claim, admission, auth, receipt, graph.evidence()),
              ...(this.options.discoverActions ? { discoverActions: (owner, request, input) => this.options.discoverActions!(graph, owner, request, input,discovery) } : {}),
            });
            try{const value = await action(next, graph, driver); this.active(); return { value, next };}
            finally{discoveryOpen=false;discoveryScopes.delete(discovery);}
          }, this.options.builder), this.options.builder));
      this.active(); this.state.adopt(committed.next); return committed.value;
    }));
  }
  usesTaskContext() { return this.state.usesTaskContext(); }
  requiresFinalResponse() { return this.state.requiresFinalResponse(); }
  receipts() { return this.state.receipts(); }
  lastReceipt() { return this.state.lastReceipt(); }
  readBudget() { return this.state.readBudget(); }
  retrievedRefs() { return this.state.retrievedRefs(); }
  modelSessionKey() { return this.key; }
  catalog() { return this.rpc(async next => next.catalog(), true); }
  call(tool: string, input: unknown, options?: { origin: 'worker_context'; maxOutputBytes: number }) {
    return this.rpc((next, _graph, driver) => runGraphProgramAsync(driver, next.callProgram(tool, input, options)));
  }
  /** Fixed host steps share one checked snapshot and commit their receipts
   * together. This callback only receives the existing planning reads. */
  readWorkerContext<T>(action: (read: (tool: string, input: unknown) => Promise<unknown>) => Promise<T>) {
    return this.rpc(async (next, graph, driver) => {
      let open = true, reading = false;
      const read = async (tool: string, input: unknown) => {
        this.active();
        if (!open || reading) throw new SecurityError('AUTHORIZATION_REQUIRED');
        reading = true;
        try {
          const value = await runGraphProgramAsync(driver, next.callProgram(tool, input, { origin: 'worker_context', maxOutputBytes: 150000 }));
          if (next.lastReceipt()?.status !== 'ok') throw new DomainError('CONFLICT', 'A required Worker Ontology read is unavailable');
          // recordRead already authorized and persisted this exact influence.
          // The next receipt must carry its own reads, even in this snapshot.
          graph.clearEvidence();
          return value;
        } finally { reading = false; }
      };
      try {
        const value = await action(read);
        if (reading) throw new SecurityError('AUTHORIZATION_REQUIRED');
        open = false;
        await runGraphProgramAsync(driver, next.acceptReceiptsProgram(next.receipts().map(receipt => receipt.id)));
        const reads = await runGraphProgramAsync(driver, next.finishProgram());
        return { value, reads };
      } finally { open = false; }
    });
  }
  acceptReceipts(ids: string[]) { return this.rpc((next, _graph, driver) => runGraphProgramAsync(driver, next.acceptReceiptsProgram(ids))); }
  finish(candidate?: ResolvedCandidate) { return this.rpc((next, _graph, driver) => runGraphProgramAsync(driver, next.finishProgram(candidate))); }
  authorizeModel(channel?: string) {
    return this.serial(() => this.operation(async () => {
      if (channel !== undefined && channel !== this.channel) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      const current = await this.store.readRequest(this.claim, this.channel); this.active();
      if (submissionDigest(current) !== submissionDigest(this.request)) throw new SecurityError('POLICY_CHANGED');
    }));
  }
  runNativeRead<T>(action: () => Promise<T>): Promise<T> { return this.serial(action); }
  prepareContext(options: { actions?: string[]; refs?: ObjectRef[]; includeDefinitions?: boolean; includeLinkedFacts?: boolean } = {}) {
    return this.serial(() => {
      const denied = (): never => { throw new Error('Initial context must dispatch a separately checked planning read'); };
      return runGraphProgramAsync({ read: denied, readPrivate: denied, query: denied, related: denied, relationshipDigest: denied,
        containsLinks: denied, evidencePropertiesDigest: denied, ingest: denied, tombstone: denied,
        planning: { call: (tool, input, limits) => this.call(tool, input, limits) } }, this.state.prepareContextProgram(options));
    });
  }
  hostEvidenceSession() { return new PostgresNativePlanningSession(this.store, this.claim, this.policy, this.channel, this.graph, this.request, this.bounds,
    { ...this.options, taskContext: undefined, priorReads: undefined }, this.key); }
  close() { this.closed = true; }
}
