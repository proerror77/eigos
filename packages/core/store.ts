import { projectCapabilityCatalog } from '../ontology/capability-catalog.js';
import { personalSourceAdmitted, sourceOwner, type PersonalSource } from './personal-source.js';
import { didiSourceOwner, type DidiMemberConnection } from './didi-source.js';
import { initializeMemberSources, MemberSourceVault } from './member-source.js';
import { businessTransaction, assertBusinessTransaction } from './transaction.js';
import { NetworkStore } from '../network/store.js';
import { createTaskNetworkOntologyReader } from '../ontology/network-read.js';
import type { ExecutionCatalog } from './catalog.js';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError, type Job, type JobState } from './domain.js';
import { BACKEND_VERSION, moneySchema } from '../ontology/execution.js';
import type { ActionIntent, ActionResult, ExecutionAttempt, PlanGrant, AfterSalesCase } from '../ontology/actions.js';
import { digest } from './delegation.js';
import { OntologyObjectStore } from '../ontology/object-store.js';
import { projectTask } from '../ontology/task-projection.js';
import { scheduleTaskRecovery } from './task-recovery.js';
import { initializeMemberUsage, beginModelUsage, finishModelUsage, recordModelResponse, markModelUsageUnknown, memberUsage } from './member-usage.js';
import type { RunEvidence } from '../capabilities/executor.js';
import { projectBusinessChain } from '../ontology/business-chain-projection.js';
import { projectExecution, type ExecutionLedger } from '../ontology/execution-projection.js';
import { DefinitionStore, currentKernelImplementation } from '../ontology/definition-store.js';
import { PipelineFactStore } from '../ontology/pipeline/facts.js';
import { assertPipelineReady, type PipelineObservation } from '../ontology/pipeline/contracts.js';
import { actionSources } from '../security/component-authority.js';
import type { OntologyReleaseRef } from '../ontology/definition-contracts.js';
import { businessModelV9 } from '../ontology/business-model.js';
import { migrateIntegratedOntology } from '../ontology/integration-migration.js';
import { SecurityStore, SecurityLineageLimitError, type SecurityMode } from '../security/store.js';
import { authorizationScope } from '../security/context.js';
import {agentDispatchGrant} from './agent-authorization.js';
import { storedRuntimeAuthority, runtimeAuthorityMatches, runtimeAuthorityDigest, claimAuthorityCurrent, type RuntimeAuthority } from './runtime-authority.js';
import { initializeTaskReadProjections, projectedTaskReadRelease } from '../ontology/task-read-projection.js';
import { synchronizeTaskOutcome } from './task-outcome.js';

export interface ListFilter {
  limit: number;
  offset: number;
  contextId?: string;
  state?: JobState;
  updatedAfter?: string;
}

export interface WorkClaim { owner: string; job: Job; token: string; recovery?: boolean; securityAuthorityId?: string; securityEpoch?: number; securityPolicyRevision?: number; modelContextKey?: string }
// Throwing through the shared transaction is essential: returning false from
// inside it would commit a dispatch marker whose lease expired during the save.
const lostClaimFence = Symbol('lost-claim-fence');

/** An unavailable immutable definition is a runtime repair condition. Never
 * replace it with the currently active model to make an old task executable. */
export class OntologyReleaseUnavailable extends DomainError {
  constructor() { super('CONFLICT', 'The task\'s pinned ontology release is unavailable; restore that exact release before resuming'); }
}

function equivalentFingerprint(a: string, b: string): boolean {
  if (a === b) return true;
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, normalize(v)])) : value;
  try { return JSON.stringify(normalize(JSON.parse(a))) === JSON.stringify(normalize(JSON.parse(b))); }
  catch { return false; }
}

export class JobStore {
  private db: DatabaseSync;
  private ontologyCatalog?: ExecutionCatalog;
  readonly definitions: DefinitionStore;
  readonly pipelineFacts: PipelineFactStore;
  private readonly baseOntology: OntologyObjectStore;
  private readonly ontologyViews = new Map<string, OntologyObjectStore>();
  readonly databasePath: string;

  private securitySequence = 0;
  private transactionDepth = 0;
  readonly security: SecurityStore;
  private readonly projectionBase: OntologyObjectStore;
  readonly authority?: RuntimeAuthority;

  constructor(path: string, options: { securityMode?: SecurityMode; securityNow?: () => number; authority?: RuntimeAuthority } = {}) {
    this.databasePath = path === ':memory:' ? path : resolve(path);
    if (path !== ':memory:') { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); closeSync(openSync(path, 'a', 0o600)); }
    this.db = new DatabaseSync(path);
    this.authority = options.authority;
    try {
      if (this.authority && resolve(path) !== resolve(this.authority.databasePath)) throw new Error('The runtime authority names a different business database');
      if (this.authority ? !runtimeAuthorityMatches(this.db, this.authority) : !!storedRuntimeAuthority(this.db)) throw new Error('Explicit matching runtime authority is required for this business database');
    } catch (error) { this.db.close(); throw error; }
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, context_id TEXT NOT NULL,
          state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner, created_at, id);
        CREATE INDEX IF NOT EXISTS jobs_worker_ready ON jobs(
          json_extract(body,'$.service'), json_extract(body,'$.delegation.backendVersion'),
          COALESCE(json_extract(body,'$.executionMode'),'worker'),
          COALESCE(json_extract(body,'$.delegation.nextAt'),0), created_at,id
        ) WHERE state IN ('working','submitted') OR (state IN ('canceled','failed','rejected','completed','auth-required') AND json_extract(body,'$.delegation.recoveryPending')=1);
        CREATE TABLE IF NOT EXISTS work_claims (
          job_id TEXT PRIMARY KEY, token TEXT NOT NULL, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS requests (
          owner TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL, response TEXT NOT NULL,
          PRIMARY KEY (owner, operation, request_id)
        );
        CREATE TABLE IF NOT EXISTS action_intents (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, job_id TEXT NOT NULL, business_key TEXT NOT NULL,
          state TEXT NOT NULL, private_data TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,business_key)
        );
        CREATE INDEX IF NOT EXISTS action_jobs ON action_intents(owner,job_id);
        CREATE TABLE IF NOT EXISTS action_attempts (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, intent_id TEXT NOT NULL, body TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS action_intent_versions (intent_id TEXT NOT NULL, owner TEXT NOT NULL, plan_digest TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(intent_id,plan_digest));
        CREATE TABLE IF NOT EXISTS action_observations (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, intent_id TEXT NOT NULL, event_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL, received_at TEXT NOT NULL, digest TEXT NOT NULL, applied INTEGER NOT NULL, body TEXT NOT NULL,
          UNIQUE(owner,intent_id,event_id)
        );
        CREATE TABLE IF NOT EXISTS plan_grants (id TEXT PRIMARY KEY, owner TEXT NOT NULL, job_id TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS budget_reservations (
          intent_id TEXT PRIMARY KEY, owner TEXT NOT NULL, grant_id TEXT NOT NULL, minor TEXT NOT NULL,
          currency TEXT NOT NULL, state TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS aftersales_cases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, original_job_id TEXT NOT NULL, remedy_job_id TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS outcome_feedback (job_id TEXT PRIMARY KEY, owner TEXT NOT NULL, binding_key TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS capability_claims (id TEXT PRIMARY KEY, owner TEXT NOT NULL, binding_key TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS capability_verifications (id TEXT PRIMARY KEY, owner TEXT NOT NULL, binding_key TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS capability_change_proposals (id TEXT PRIMARY KEY, owner TEXT NOT NULL, binding_key TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS personal_source_binding (slot TEXT PRIMARY KEY, connection_id TEXT NOT NULL, owner TEXT NOT NULL, member_id TEXT NOT NULL, configuration_digest TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS member_didi_source_admissions (configuration_digest TEXT PRIMARY KEY, connection_id TEXT NOT NULL, owner TEXT NOT NULL, member_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','revoked')));
        CREATE TABLE IF NOT EXISTS preparation_contexts (owner TEXT NOT NULL, job_id TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner,job_id,key));
      `);
      const budgetColumns = new Set(this.db.prepare('PRAGMA table_info(budget_reservations)').all().map(row => String(row.name)));
      if (!budgetColumns.has('economic_key')) this.db.exec('ALTER TABLE budget_reservations ADD COLUMN economic_key TEXT');
      if (!budgetColumns.has('role')) this.db.exec('ALTER TABLE budget_reservations ADD COLUMN role TEXT');
      if (!budgetColumns.has('additional_impacts')) this.db.exec('ALTER TABLE budget_reservations ADD COLUMN additional_impacts TEXT');
      initializeMemberUsage(this.db);
      initializeTaskReadProjections(this.db);
    });
    try {
      const reviewedModel = currentKernelImplementation();
      this.security = this.transaction(() => new SecurityStore(this.db, options.securityMode, options.securityNow, false, reviewedModel));
    // Run the explicitly supported historical migrations once before the
    // persistent definition registry becomes the authority for every view.
    this.definitions = new DefinitionStore(this.db, options.securityNow ?? Date.now);
    const legacyModel = this.definitions.legacyImplementation();
    this.projectionBase = new OntologyObjectStore(this.db, legacyModel, options.securityNow ?? Date.now, undefined, { skipLegacyMigration: true });
    this.baseOntology = this.security.enabled ? new OntologyObjectStore(this.db, legacyModel, options.securityNow ?? Date.now, undefined, { skipLegacyMigration: true, security: this.security.policies }, false) : this.projectionBase;
    if (!this.definitions.hasBaseline()) migrateIntegratedOntology(this.db, businessModelV9, legacyModel);
    this.definitions.bootstrap();
    this.pipelineFacts = this.transaction(() => new PipelineFactStore(this.db, {
      active: (owner, jobId, revision) => !!this.db.prepare("SELECT 1 FROM jobs WHERE owner=? AND id=? AND state IN ('working','submitted','input-required','auth-required','paused') AND json_extract(body,'$.delegation.request.revision')=?").get(owner, jobId, revision),
      // Only enqueue owned task work. Cross-task source records are never copied
      // into a model session or projected under another task's authority.
      changed: (owner, jobId, revision) => { this.db.prepare("UPDATE jobs SET body=json_set(body,'$.delegation.nextAt',0) WHERE owner=? AND id=? AND state IN ('working','submitted') AND json_extract(body,'$.delegation.request.revision')=?").run(owner, jobId, revision); },
    }, options.securityNow ?? Date.now));
    this.security.relayReads.setPipelineGuard((owner, request, plan, intent) => {
      const job = this.get(owner, request.context.requestId), graph = this.ontologyForJob(owner, job);
      const agent = job.delegation?.agent, step = plan.steps.find(value => value.intentId === intent.id);
      if (!agent || !step) throw new DomainError('FORBIDDEN', 'The source read has no current action plan');
      const binding = actionSources(agent, step.action, step.input, step).find(value => value.programRef.id === request.context.programId && value.programDigest === request.context.programDigest);
      if (!binding) throw new DomainError('FORBIDDEN', 'The source read differs from the task action binding');
      assertPipelineReady(graph.pipelineStatus(owner, binding.programRef, binding.programDigest, request.context.action));
      const resolvedInputs = job.delegation?.agent?.inputResolutions?.filter(value => value.planId === plan.id && value.intentId === intent.id && value.inputDigest === request.context.actionInputDigest) ?? [];
      this.pipelineFacts.assertSnapshots(owner, graph, [...plan.ontologyPlanning.objects, ...resolvedInputs.flatMap(value => value.ontologyPlanning.objects)]);
    });
    this.baseOntology.setReadOverlayFactory((owner, requestId) => {
      const source = this.db.prepare("SELECT 1 FROM preparation_contexts WHERE owner=? AND job_id=? AND key='network-inquiry-source@1'").get(owner, requestId);
      return source ? createTaskNetworkOntologyReader(this, owner, requestId, this.ontologyCatalog) : undefined;
    });
    initializeMemberSources(this.db);
    } catch(error) { this.db.close(); throw error; }
  }
  /** Unbound discovery follows the current default release. Task execution
   * must use ontologyForJob, including projections and historical readback. */
  get ontology(): OntologyObjectStore { return this.ontologyForRelease(this.definitions.active().ref); }
  authorityCurrent(): boolean {
    try { return this.authority ? runtimeAuthorityMatches(this.db, this.authority) : !storedRuntimeAuthority(this.db); }
    catch { return false; }
  }
  assertRuntimeAuthority(): void { if (!this.authorityCurrent()) throw new DomainError('CONFLICT', 'Runtime authority changed; restart with the current reviewed configuration'); }
  ontologyForRelease(ref: OntologyReleaseRef): OntologyObjectStore {
    let release: ReturnType<DefinitionStore['resolve']>;
    try { release = this.definitions.resolve(ref); }
    catch { throw new OntologyReleaseUnavailable(); }
    const key = digest(ref);
    let graph = this.ontologyViews.get(key);
    if (graph) {
      this.ontologyViews.delete(key);
      this.ontologyViews.set(key, graph);
    } else {
      graph = this.baseOntology.forModel(release.model, { ontologyId: ref.ontologyId, releaseRef: ref,
        pipelineStatus: (owner, program, configuration, action) => this.definitions.pipeline.status(owner, release.document, release.model, program, configuration, action),
        pipelineChanges: (owner, jobId, revision) => this.pipelineFacts.changes(owner, jobId, revision),
        ...(release.compatibleDefinition ? { compatibleDefinition: release.compatibleDefinition } : {}) });
      this.ontologyViews.set(key, graph);
      if (this.ontologyViews.size > 16) this.ontologyViews.delete(this.ontologyViews.keys().next().value!);
    }
    return graph;
  }
  /** Trusted connector ingress only; no public command accepts source facts. */
  ingestPipelineObservation(owner: string, releaseRef: OntologyReleaseRef, serviceId: string, mappingId: string, sample: PipelineObservation, expectedRevision: number) {
    return this.transaction(() => {
      this.definitions.assertAccess(owner, releaseRef.ontologyId);
      const release = this.definitions.resolve(releaseRef), ref = release.document.pipeline?.find(value => value.serviceId === serviceId);
      if (!ref) throw new DomainError('NOT_FOUND', 'Source mapping is not published in this release');
      const active = this.definitions.active(releaseRef.ontologyId).document.pipeline?.find(value => value.serviceId === serviceId);
      if (active?.intakeDigest !== ref.intakeDigest) throw new DomainError('CONFLICT', 'Only the active mapping may update current source facts; historical task evidence stays pinned');
      const issues = this.definitions.pipeline.validateIntake(releaseRef.ontologyId, ref, release.model);
      if (issues.length) throw new DomainError('CONFLICT', 'Source mapping validation is not current');
      const intake = this.definitions.pipeline.intake(releaseRef.ontologyId, ref);
      return this.pipelineFacts.apply(owner, this.ontologyForRelease(releaseRef), intake, ref.intakeDigest, mappingId, sample, expectedRevision);
    });
  }
  ontologyReleaseForJob(owner: string, jobOrId: Job | string): OntologyReleaseRef {
    const job = typeof jobOrId === 'string' ? this.get(owner, jobOrId) : jobOrId;
    if (job.delegation?.backendVersion !== BACKEND_VERSION) throw new DomainError('CONFLICT', 'Historical backend tasks have no current executable ontology context');
    if (this.authority && job.authorityId !== this.authority.id && this.db.prepare('SELECT 1 FROM jobs WHERE owner=? AND id=?').get(owner,job.id))
      throw new DomainError('CONFLICT', 'Historical runtime authority tasks are read-only');
    // Absence is an explicit compatibility rule for pre-registry v16 records.
    // It must never mean "whatever release is active now" or rewrite receipts.
    return structuredClone(job.delegation.ontologyRelease ?? this.definitions.legacy().ref);
  }
  ontologyForJob(owner: string, jobOrId: Job | string): OntologyObjectStore {
    const job = typeof jobOrId === 'string' ? this.get(owner, jobOrId) : jobOrId;
    const ref = this.ontologyReleaseForJob(owner, job), graph = this.ontologyForRelease(ref), validation = job.delegation?.pipelineValidation;
    if (!validation) return graph;
    if (validation.ownerDigest !== digest(owner) || validation.requestRevision !== job.delegation!.request.revision || digest(validation.release) !== digest(ref)) throw new DomainError('FORBIDDEN', 'Validation authority changed with the task revision');
    const release = this.definitions.resolve(ref);
    return graph.forModel(graph.model, { ontologyId: ref.ontologyId, releaseRef: ref, compatibleDefinition: release.compatibleDefinition,
      pipelineChanges: (reader, id, revision) => this.pipelineFacts.changes(reader, id, revision),
      pipelineStatus: (reader, program, configuration, action) => {
        const current = this.get(owner, job.id);
        if (digest(current.delegation?.pipelineValidation) !== digest(validation) || current.delegation?.request.revision !== validation.requestRevision) throw new DomainError('FORBIDDEN', 'Validation task scope changed');
        return this.definitions.pipeline.validationStatus(reader, release.document, release.model, validation, program, configuration, action);
      },
    });
  }
  /** Historical readback may resolve an explicit immutable release without
   * making the task executable by the current Worker. Unpinned historical
   * tasks retain the existing refusal instead of following the active model. */
  ontologyReadReleaseForJob(owner: string, jobOrId: Job | string): OntologyReleaseRef {
    const job = typeof jobOrId === 'string' ? this.get(owner, jobOrId) : jobOrId;
    const projection = projectedTaskReadRelease(this.db, owner, job);
    if (projection) return projection;
    return job.delegation?.ontologyRelease ? structuredClone(job.delegation.ontologyRelease) : this.ontologyReleaseForJob(owner, job);
  }
  ontologyForTaskRead(owner: string, jobOrId: Job | string): OntologyObjectStore {
    return this.ontologyForRelease(this.ontologyReadReleaseForJob(owner, jobOrId));
  }
  private projectionForJob(owner: string, job: Job): OntologyObjectStore {
    if (!this.security.enabled) return this.ontologyForJob(owner, job);
    const ref = this.ontologyReleaseForJob(owner, job), release = this.definitions.resolve(ref);
    return this.projectionBase.forModel(release.model, { ontologyId: ref.ontologyId, releaseRef: ref, ...(release.compatibleDefinition ? { compatibleDefinition: release.compatibleDefinition } : {}) });
  }
  withExecutionIntegrity<T>(owner:string,taskId:string,read:(graph:OntologyObjectStore)=>T):T {
    const job=this.get(owner,taskId),scope=this.security.enabled?this.security.policies.scope(owner):undefined;
    if(scope && (scope.actor.actorKind!=='worker' || scope.operation!=='task.process' || scope.grant?.taskId!==taskId || scope.grant.requestRevision!==job.delegation?.request.revision))throw new DomainError('FORBIDDEN','Current worker task authority is required for execution integrity');
    scope?.assertCurrent();
    const previous=Number(this.db.prepare('PRAGMA query_only').get()!.query_only);this.db.exec('PRAGMA query_only=ON');
    try {const result=read(this.projectionForJob(owner,job));if(result && typeof result==='object' && 'then' in result)throw new DomainError('FORBIDDEN','Execution integrity reads must be synchronous');scope?.assertCurrent();return result;}
    finally {this.db.exec(`PRAGMA query_only=${previous}`);}
  }
  projectCapabilities(owner:string,taskId:string,summaries:ReturnType<ExecutionCatalog['summaries']>) {
    const job=this.get(owner,taskId);
    if(this.security.enabled){const scope=this.security.policies.scope(owner);if(scope.actor.actorKind!=='worker' || scope.grant?.taskId!==taskId || scope.grant.requestRevision!==job.delegation?.request.revision)throw new DomainError('FORBIDDEN','Current task authority is required for capability projection');}
    projectCapabilityCatalog(this.projectionForJob(owner,job),owner,taskId,summaries);
    if(this.security.enabled)this.security.policies.bindTaskProjection(owner,taskId);
  }
  setOntologyCatalog(catalog: ExecutionCatalog): void { catalog.secureWith(this.security); this.ontologyCatalog = catalog; }

  memberSources(keyPath: string, readerDirectory: string): MemberSourceVault { return new MemberSourceVault(this.db, keyPath, readerDirectory, Date.now, true); }

  createNetworkStore(now?: () => number): NetworkStore { return new NetworkStore(this.db, now); }
  createNetworkReadStore(): NetworkStore { return new NetworkStore(this.db, undefined, false); }

  // Gateway calls this only after validating the enrolled member and acquiring its network lease.
  admitPersonalSource(c?: PersonalSource, configurationDigest?: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM personal_source_binding WHERE slot='meituan-paotui'").run();
      if (c && configurationDigest) this.db.prepare('INSERT INTO personal_source_binding VALUES(?,?,?,?,?)').run('meituan-paotui', c.connectionId, sourceOwner(c), c.memberId, configurationDigest);
    });
  }
  personalSourceAdmitted(c: PersonalSource, configurationDigest: string): boolean { return personalSourceAdmitted(this.db, c, configurationDigest); }
  admitMemberDidiSource(record?: DidiMemberConnection, configurationDigest?: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE member_didi_source_admissions SET state='revoked' WHERE configuration_digest<>?").run(configurationDigest ?? '');
      if (record && configurationDigest) this.db.prepare("INSERT OR IGNORE INTO member_didi_source_admissions VALUES(?,?,?,?,'active')")
        .run(configurationDigest, record.connectionId, didiSourceOwner(record), record.memberId);
    });
  }
  memberDidiSourceAdmitted(record: DidiMemberConnection, configurationDigest: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM member_didi_source_admissions WHERE configuration_digest=? AND connection_id=? AND owner=? AND member_id=? AND state='active'")
      .get(configurationDigest, record.connectionId, didiSourceOwner(record), record.memberId);
  }
  revokeMemberDidiSource(memberId: string): void {
    this.db.prepare("UPDATE member_didi_source_admissions SET state='revoked' WHERE member_id=?").run(memberId);
  }
  close(): void { this.db.close(); }
  memberUsage(owner: string) { return memberUsage(this.db, owner); }
  beginModelUsage(claim: WorkClaim, id: string, runtime: string, startedAt: string) {
    this.transaction(() => { if (!this.active(claim, Date.now())) throw new DomainError('CONFLICT', 'Model dispatch lease is no longer active'); beginModelUsage(this.db, claim.owner, claim.job.id, id, runtime, startedAt, digest(claim.token)); });
  }
  finishModelUsage(claim: WorkClaim, id: string, evidence: RunEvidence | undefined, outcome: 'completed' | 'failed' | 'interrupted') {
    this.transaction(() => finishModelUsage(this.db, claim.owner, claim.job.id, id, evidence, outcome));
  }
  recordModelUsage(owner: string, jobId: string, evidence: RunEvidence) { this.assertOwnedJob(owner, jobId); recordModelResponse(this.db, owner, jobId, evidence); }

  /** The execution graph and durable ledger share this transaction; neither is
   * a second executor. Fenced Agent reads keep late receipts audit-only; fixed
   * business effects can update ledger truth without advancing the task. */
  private projectExecution(owner: string, job: Job): void {
    if (job.service !== 'eigos.delegate' || job.delegation?.backendVersion !== BACKEND_VERSION) return;
    const graph = this.projectionForJob(owner, job);
    if (job.service === 'eigos.delegate' && job.delegation?.backendVersion === BACKEND_VERSION && job.state === 'completed'
      && graph.read(owner, { type: 'ServiceRequest', id: job.id }).properties.projectionState === 'invalid_source') {
      // Keep the canonical completed record available for diagnosis. An invalid
      // imported result cannot reconstruct missing candidate evidence, execution
      // history or permissions, nor replace an earlier valid projected history.
      // Fresh dispatch still requires its complete sealed execution graph.
      return;
    }
    const current = this.intents(owner, job.id);
    const archived = this.db.prepare(`SELECT v.body FROM action_intent_versions v
      JOIN action_intents i ON i.id=v.intent_id AND i.owner=v.owner WHERE v.owner=? AND i.job_id=?`).all(owner, job.id).map(row => JSON.parse(String(row.body)) as ActionIntent);
    const attempts = this.db.prepare(`SELECT a.body FROM action_attempts a JOIN action_intents i ON i.id=a.intent_id AND i.owner=a.owner
      WHERE a.owner=? AND i.job_id=? ORDER BY a.rowid`).all(owner, job.id).map(row => JSON.parse(String(row.body)) as ExecutionAttempt);
    const observations: ExecutionLedger['observations'] = this.db.prepare(`SELECT o.* FROM action_observations o
      JOIN action_intents i ON i.id=o.intent_id AND i.owner=o.owner WHERE o.owner=? AND i.job_id=? ORDER BY o.rowid`).all(owner, job.id).map(row => {
      const result = JSON.parse(String(row.body)) as ActionResult;
      // recordObservation only applies non-unknown results after verification.
      // A later accepted observation does not revoke this historical fact.
      // Unapplied/unknown rows do not prove either verification or rejection.
      return { id: String(row.id), intentId: String(row.intent_id), attemptId: String(row.attempt_id), receivedAt: String(row.received_at), digest: String(row.digest), applied: row.applied === 1,
        verified: row.applied === 1 && result.kind !== 'unknown' ? true : undefined, result };
    });
    const ledger = { intents: [...archived, ...current], attempts, observations };
    projectExecution(graph, owner, job, ledger);
    const cases = this.db.prepare('SELECT body FROM aftersales_cases WHERE owner=? AND (original_job_id=? OR remedy_job_id=?)').all(owner, job.id, job.id).map(row => JSON.parse(String(row.body)) as AfterSalesCase);
    projectBusinessChain(graph, owner, job, { ...ledger, grants: this.grants(owner, job.id), cases });
  }
  private executionMutation<T>(action: () => T): T {
    this.db.exec('SAVEPOINT execution_ontology');
    try { const result = action(); this.db.exec('RELEASE execution_ontology'); return result; }
    catch (error) { this.db.exec('ROLLBACK TO execution_ontology; RELEASE execution_ontology'); throw error; }
  }

  preparationContext<T>(owner: string, jobId: string, key: string): T | undefined {
    this.assertOwnedJob(owner, jobId);
    const row = this.db.prepare('SELECT body FROM preparation_contexts WHERE owner=? AND job_id=? AND key=?').get(owner, jobId, key);
    return row ? JSON.parse(String(row.body)) as T : undefined;
  }
  hasPreparationContext(owner: string, jobId: string, prefix: string): boolean {
    this.assertOwnedJob(owner, jobId);
    return !!this.db.prepare('SELECT 1 FROM preparation_contexts WHERE owner=? AND job_id=? AND substr(key,1,length(?))=? LIMIT 1').get(owner, jobId, prefix, prefix);
  }
  savePreparationContext(owner: string, jobId: string, key: string, value: unknown): void {
    const job = this.get(owner, jobId);
    if (job.service !== 'eigos.delegate' || job.delegation?.backendVersion !== BACKEND_VERSION || !['working', 'submitted'].includes(job.state)) throw new DomainError('CONFLICT', 'Preparation task is no longer active');
    const body = JSON.stringify(value);
    if (body.length > 200000) throw new DomainError('INVALID_INPUT', 'Preparation context limit exceeded');
    this.db.prepare('INSERT INTO preparation_contexts VALUES(?,?,?,?) ON CONFLICT(owner,job_id,key) DO UPDATE SET body=excluded.body').run(owner, jobId, key, body);
  }

  // Called inside the same fenced checkpoint that saves the fixed plan.
  createIntent(owner: string, intent: ActionIntent): string {
    return this.executionMutation(() => {
    this.assertOwnedJob(owner, intent.jobId);
    if (intent.owner !== owner) throw new DomainError('FORBIDDEN', 'Action owner mismatch');
    const previous = this.db.prepare('SELECT id FROM action_intents WHERE owner=? AND business_key=?').get(owner, intent.businessOperationKey);
    if (previous) {
      const old = this.intent(owner, String(previous.id));
      if (old.jobId !== intent.jobId || !['local', 'read'].includes(old.effect) || !['local', 'read'].includes(intent.effect) || !['rejected', 'effect_confirmed', 'needs_review'].includes(old.state)) throw new DomainError('CONFLICT', 'Business operation already exists; reconcile its original intent');
      this.db.prepare('INSERT OR IGNORE INTO action_intent_versions VALUES(?,?,?,?)').run(old.id, owner, old.planDigest, JSON.stringify(old));
      const { privateData, ...body } = { ...intent, id: old.id };
      this.db.prepare('UPDATE action_intents SET state=?,private_data=?,body=? WHERE owner=? AND id=?').run(intent.state, JSON.stringify(privateData ?? null), JSON.stringify(body), owner, old.id);
      this.projectExecution(owner, this.get(owner, intent.jobId));
      return old.id;
    }
    const { privateData, ...body } = intent;
    this.db.prepare('INSERT INTO action_intents VALUES(?,?,?,?,?,?,?)').run(intent.id, owner, intent.jobId, intent.businessOperationKey, intent.state, JSON.stringify(privateData ?? null), JSON.stringify(body));
    this.projectExecution(owner, this.get(owner, intent.jobId));
    return intent.id;
    });
  }
  intent(owner: string, id: string): ActionIntent {
    const row = this.db.prepare('SELECT * FROM action_intents WHERE owner=? AND id=?').get(owner, id);
    if (!row) throw new DomainError('NOT_FOUND', 'Action intent not found');
    return { ...JSON.parse(String(row.body)), state: String(row.state), privateData: JSON.parse(String(row.private_data)) } as ActionIntent;
  }
  intentByBusinessKey(owner: string, businessKey: string): ActionIntent | undefined {
    const row = this.db.prepare('SELECT id FROM action_intents WHERE owner=? AND business_key=?').get(owner, businessKey);
    return row ? this.intent(owner, String(row.id)) : undefined;
  }
  intents(owner: string, jobId: string): ActionIntent[] {
    this.assertOwnedJob(owner, jobId);
    return this.db.prepare('SELECT id FROM action_intents WHERE owner=? AND job_id=? ORDER BY id').all(owner, jobId).map(r => this.intent(owner, String(r.id)));
  }
  saveIntent(owner: string, intent: ActionIntent): void {
    this.executionMutation(() => {
    const current = this.intent(owner, intent.id);
    if (intent.owner !== owner || intent.businessOperationKey !== current.businessOperationKey || intent.planDigest !== current.planDigest) throw new DomainError('CONFLICT', 'Action identity changed');
    const { privateData, ...body } = intent;
    this.db.prepare('UPDATE action_intents SET state=?,body=? WHERE owner=? AND id=?').run(intent.state, JSON.stringify(body), owner, intent.id);
    this.projectExecution(owner, this.get(owner, intent.jobId));
    });
  }
  dispatchIntent(owner: string, id: string, claim?: WorkClaim): void {
    this.executionMutation(() => {
      if (this.security.enabled && (!claim || claim.owner !== owner || !this.active(claim, Date.now()) || this.intent(owner, id).jobId !== claim.job.id)) throw new DomainError('FORBIDDEN', 'Current task authority and claim are required for dispatch');
      if (this.security.enabled) {
        const intent=this.intent(owner,id),{plan,step}=this.security.policies.requireDispatch(owner,intent,'dispatch');
        if(!['read','local'].includes(step.effect)) {
          const permit=agentDispatchGrant(this,owner,intent.jobId,plan,step);
          if(!permit || step.cost && !this.db.prepare("SELECT 1 FROM budget_reservations WHERE owner=? AND intent_id=? AND grant_id=? AND minor=? AND currency=? AND state='held'").get(owner,intent.id,permit.id,step.cost.minor,step.cost.currency)) throw new DomainError('FORBIDDEN','Exact business permit and held budget are required');
        }
      }
    const result = this.db.prepare("UPDATE action_intents SET state='dispatching' WHERE owner=? AND id=? AND state='ready'").run(owner, id);
    if (Number(result.changes) !== 1) throw new DomainError('CONFLICT', 'Started action must be reconciled; automatic replay is prohibited');
    this.projectExecution(owner, this.get(owner, this.intent(owner, id).jobId));
    });
  }
  startAttempt(claim: WorkClaim, intentId: string, kind: ExecutionAttempt['kind'], inputDigest: string, requestKey?: string, submission?: ExecutionAttempt['submission'], authorizationId?: string): ExecutionAttempt {
    return this.executionMutation(() => {
    const intent = this.intent(claim.owner, intentId);
    if (intent.jobId !== claim.job.id) throw new DomainError('FORBIDDEN', 'Attempt belongs to another task');
    if (this.security.enabled && !this.active(claim, Date.now())) throw new DomainError('FORBIDDEN', 'Task authority or claim is no longer active');
    if (this.security.enabled && kind !== 'dispatch') this.security.policies.requireDispatch(claim.owner,intent,kind);
    if (kind === 'dispatch') this.dispatchIntent(claim.owner, intentId, claim);
    else if (intent.state === 'ready' || intent.state === 'canceled_before_dispatch') throw new DomainError('CONFLICT', 'Action has not been dispatched');
    const attempt: ExecutionAttempt = { id: randomUUID(), intentId, kind, requestKey: requestKey ?? (kind === 'dispatch' ? intent.businessOperationKey : randomUUID()), startedAt: new Date().toISOString(), claimToken: claim.token, requestRevision: claim.job.revision ?? 0, inputDigest, planDigest: intent.planDigest, ordinal: this.attempts(claim.owner, intentId).length + 1, ...(submission ? { submission: structuredClone(submission) } : {}), ...(authorizationId ? { authorizationId } : {}) };
    this.db.prepare('INSERT INTO action_attempts VALUES(?,?,?,?)').run(attempt.id, claim.owner, intentId, JSON.stringify(attempt));
    this.projectExecution(claim.owner, this.get(claim.owner, intent.jobId));
    return attempt;
    });
  }
  attempts(owner: string, intentId: string): ExecutionAttempt[] {
    this.intent(owner, intentId);
    return this.db.prepare('SELECT body FROM action_attempts WHERE owner=? AND intent_id=? ORDER BY rowid').all(owner, intentId).map(r => JSON.parse(String(r.body)));
  }
  recordObservation(owner: string, intentId: string, attemptId: string, result: ActionResult, verified: boolean,
    fence?: { claim: WorkClaim; apply: (job: Job, intent: ActionIntent) => void }): { id: string; applied: boolean } {
    try { return this.transaction(() => {
      const intent = this.intent(owner, intentId);
      const attemptRow = this.db.prepare('SELECT body FROM action_attempts WHERE owner=? AND id=? AND intent_id=?').get(owner, attemptId, intentId);
      if (!attemptRow) throw new DomainError('FORBIDDEN', 'Observation has no owned attempt');
      const attempt = JSON.parse(String(attemptRow.body)) as ExecutionAttempt;
      if (!result.eventId || !Number.isSafeInteger(result.sourceVersion) || result.sourceVersion < 0) throw new DomainError('INVALID_INPUT', 'Observation requires a stable event and source version');
      const hash = digest(result);
      const duplicate = this.db.prepare('SELECT id,digest FROM action_observations WHERE owner=? AND intent_id=? AND event_id=?').get(owner, intentId, result.eventId);
      // Agent observations and graph projection commit together under the original
      // lease. Late responses are audit evidence only, including duplicate events.
      if (fence && (fence.claim.owner !== owner || fence.claim.job.id !== intent.jobId || attempt.claimToken !== fence.claim.token || !this.active(fence.claim, Date.now()))) {
        if (duplicate) return { id: String(duplicate.id), applied: false };
        const id = randomUUID();
        this.db.prepare('INSERT INTO action_observations VALUES(?,?,?,?,?,?,?,?,?)').run(id, owner, intentId, result.eventId, attemptId, new Date().toISOString(), hash, 0, JSON.stringify(result));
        this.projectExecution(owner, this.get(owner, intent.jobId));
        return { id, applied: false };
      }
      if (duplicate) {
        if (fence) return { id: String(duplicate.id), applied: false };
        if (duplicate.digest !== hash) {
          if (attempt.planDigest === intent.planDigest) { intent.state = 'needs_review'; this.saveIntent(owner, intent); }
          const event = `${result.eventId}:conflict:${hash}`; const previous = this.db.prepare('SELECT id FROM action_observations WHERE owner=? AND intent_id=? AND event_id=?').get(owner, intentId, event);
          const id = previous ? String(previous.id) : randomUUID();
          if (!previous) this.db.prepare('INSERT INTO action_observations VALUES(?,?,?,?,?,?,?,?,?)').run(id, owner, intentId, event, attemptId, new Date().toISOString(), hash, 0, JSON.stringify(result));
          this.projectExecution(owner, this.get(owner, intent.jobId));
          return { id, applied: false };
        }
        if (verified && result.kind !== 'unknown' && attempt.planDigest === intent.planDigest && intent.state !== 'needs_review' && (intent.latestVersion === undefined || result.sourceVersion >= intent.latestVersion) && attempt.ordinal >= (intent.lastAppliedAttemptOrdinal ?? 0)) {
          intent.failedQueries = 0; intent.needsObservation = false; intent.lastAppliedAttemptOrdinal = attempt.ordinal; intent.lastVerifiedResult = result; intent.lastResult = result;
          intent.state = result.kind === 'confirmed' ? 'effect_confirmed' : result.kind === 'rejected' ? 'rejected' : result.kind === 'not_found' ? 'needs_review' : 'awaiting_remote';
          intent.nextAt = Date.now() + Math.min(60000, Math.max(100, result.retryAfterMs ?? 1000));
          this.saveIntent(owner, intent);
        }
        return { id: String(duplicate.id), applied: false };
      }
      const comparable = (r: ActionResult) => digest({ kind: r.kind, remoteRef: r.remoteRef, output: r.output, business: r.business, delivery: r.delivery });
      const stale = attempt.planDigest !== intent.planDigest || result.kind === 'unknown' && (intent.lastAppliedAttemptOrdinal ?? 0) > attempt.ordinal || result.kind !== 'unknown' && intent.latestVersion !== undefined && result.sourceVersion < intent.latestVersion;
      const conflict = !stale && intent.latestVersion === result.sourceVersion && intent.lastVerifiedResult && result.kind !== 'unknown' && comparable(intent.lastVerifiedResult) !== comparable(result);
      const applied = !stale && !conflict && (verified || result.kind === 'unknown');
      const id = randomUUID();
      this.db.prepare('INSERT INTO action_observations VALUES(?,?,?,?,?,?,?,?,?)').run(id, owner, intentId, result.eventId, attemptId, new Date().toISOString(), hash, applied ? 1 : 0, JSON.stringify(result));
      if (!stale && (conflict || (!verified && result.kind !== 'unknown'))) intent.state = 'needs_review';
      else if (applied) {
        if (result.kind !== 'unknown') intent.latestVersion = result.sourceVersion;
        if (verified && result.kind !== 'unknown') { intent.lastVerifiedResult = result; intent.needsObservation = false; }
        intent.lastAppliedAttemptOrdinal = Math.max(intent.lastAppliedAttemptOrdinal ?? 0, attempt.ordinal); intent.latestObservationId = id; intent.lastResult = result;
        if (verified && result.kind !== 'unknown' && result.business) intent.businessSnapshot = { value: result.business, sourceVersion: result.sourceVersion, evidenceRefs: result.evidenceRefs };
        if (verified && result.remoteRef) intent.remoteRef = result.remoteRef;
        intent.state = result.kind === 'confirmed' ? 'effect_confirmed' : result.kind === 'rejected' ? 'rejected' : result.kind === 'unknown' ? 'effect_unknown' : result.kind === 'not_found' ? 'needs_review' : 'awaiting_remote';
        intent.nextAt = Date.now() + Math.min(60000, Math.max(100, result.retryAfterMs ?? 1000));
        if (verified && result.kind === 'confirmed') { intent.acceptedOutput = result.output ?? (result.remoteRef ? { remoteRef: result.remoteRef } : {}); if (result.delivery) intent.delivery = result.delivery; }
        if (result.kind === 'unknown') intent.failedQueries = (intent.failedQueries ?? 0) + 1; else intent.failedQueries = 0;
        if ((intent.failedQueries ?? 0) >= 3) intent.state = 'needs_review';
        if (verified && result.kind === 'confirmed' && (intent.effect === 'payment' || intent.additionalEffects?.includes('payment'))) this.db.prepare("UPDATE budget_reservations SET state='consumed' WHERE owner=? AND intent_id=?").run(owner, intentId);
        if (verified && result.kind === 'rejected') this.db.prepare("UPDATE budget_reservations SET state='released' WHERE owner=? AND intent_id=? AND state='held'").run(owner, intentId);
      }
      if (applied && fence) {
        const job = this.get(owner, intent.jobId); fence.apply(job, intent);
        this.saveIntent(owner, intent); this.save(owner, job);
      } else this.saveIntent(owner, intent);
      if (fence && !this.leaseOwned(fence.claim, Date.now())) throw lostClaimFence;
      return { id, applied: !!applied };
    }); } catch (error) {
      if (error !== lostClaimFence || !fence) throw error;
      // The provider has already replied. Roll back its attempted task/graph
      // application, then retain the exact receipt as audit-only evidence.
      return this.transaction(() => {
        const intent = this.intent(owner, intentId);
        if (!this.db.prepare('SELECT 1 FROM action_attempts WHERE owner=? AND id=? AND intent_id=?').get(owner, attemptId, intentId)) throw new DomainError('FORBIDDEN', 'Observation has no owned attempt');
        const existing = this.db.prepare('SELECT id FROM action_observations WHERE owner=? AND intent_id=? AND event_id=?').get(owner, intentId, result.eventId);
        if (existing) return { id: String(existing.id), applied: false };
        const id = randomUUID();
        this.db.prepare('INSERT INTO action_observations VALUES(?,?,?,?,?,?,?,?,?)').run(id, owner, intentId, result.eventId, attemptId, new Date().toISOString(), digest(result), 0, JSON.stringify(result));
        this.projectExecution(owner, this.get(owner, intent.jobId));
        return { id, applied: false };
      });
    }
  }
  observations(owner: string, intentId: string): unknown[] {
    this.intent(owner, intentId);
    return this.db.prepare('SELECT body FROM action_observations WHERE owner=? AND intent_id=? ORDER BY received_at,id').all(owner, intentId).map(r => JSON.parse(String(r.body)));
  }
  grant(owner: string, grant: PlanGrant): void {
    if (grant.owner !== owner) throw new DomainError('FORBIDDEN', 'Grant owner mismatch'); this.assertOwnedJob(owner, grant.jobId);
    this.executionMutation(() => {
      this.db.prepare('INSERT INTO plan_grants VALUES(?,?,?,?)').run(grant.id, owner, grant.jobId, JSON.stringify(grant));
      this.projectExecution(owner, this.get(owner, grant.jobId));
    });
  }
  grants(owner: string, jobId: string): PlanGrant[] { this.assertOwnedJob(owner, jobId); return this.db.prepare('SELECT body FROM plan_grants WHERE owner=? AND job_id=?').all(owner, jobId).map(r => JSON.parse(String(r.body))); }
  revokeGrants(owner: string, jobId: string): void {
    this.executionMutation(() => {
    for (const grant of this.grants(owner, jobId)) this.db.prepare('UPDATE plan_grants SET body=? WHERE owner=? AND id=?').run(JSON.stringify({ ...grant, revoked: true, revokedAt: grant.revokedAt ?? new Date().toISOString() }), owner, grant.id);
    this.projectExecution(owner, this.get(owner, jobId));
    });
  }
  reserveBudget(owner: string, intentId: string, grant: PlanGrant, amountInput: { minor: string; currency: string }): void {
    this.executionMutation(() => {
      if (grant.kind === 'object_write' || grant.kind === 'external_draft') throw new DomainError('FORBIDDEN', 'Nonfinancial authority has no financial budget');
      const amount = moneySchema.parse({ minor: amountInput.minor, currency: amountInput.currency }); moneySchema.parse(grant.maxAmount);
      const intent = this.intent(owner, intentId), job = this.get(owner, intent.jobId), composed = !!job.delegation?.agent?.composition;
      if (grant.owner !== owner || grant.jobId !== intent.jobId || grant.planDigest !== intent.planDigest || grant.revoked || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()
        || !grant.bindingRefs.some(ref => digest(ref) === digest(intent.bindingRef)) || amount.currency !== grant.maxAmount.currency || BigInt(amount.minor) > BigInt(grant.maxAmount.minor)) throw new DomainError('FORBIDDEN', 'Exact action budget exceeds its current grant');
      if (composed && !this.grants(owner, intent.jobId).some(current => current.id === grant.id && digest(current) === digest(grant))) throw new DomainError('FORBIDDEN', 'The current durable action grant is missing or changed');
      const plan = composed ? job.delegation!.agent!.plans.find(plan => plan.digest === intent.planDigest) : undefined;
      const step = plan?.steps.find(step => step.intentId === intentId);
      if (composed && (!step?.binding || digest(step.cost && { minor: step.cost.minor, currency: step.cost.currency }) !== digest(amount)
        || digest(step.budgetImpact ?? null) !== digest(grant.budgetImpact ?? null))) throw new DomainError('CONFLICT', 'Budget reservation differs from the sealed action');
      const exposure = step?.budgetImpact?.amount ?? amount, role = step?.budgetImpact?.role ?? 'service_total';
      moneySchema.parse(exposure);
      const keyFor = (role: string, key: string) => digest({ owner, requestId: intent.jobId, program: step!.binding!.programRef, configuration: step!.binding!.configurationDigest, role, key });
      const economicKey = composed ? keyFor(role, step!.budgetImpact?.key ?? intent.businessOperationKey) : undefined;
      const additional = composed ? (step!.budgetImpact?.additional ?? []).map(value => ({ key: keyFor(value.role, value.key), ...moneySchema.parse(value.amount), role: value.role })) : [];
      if (new Set([economicKey, ...additional.map(value => value.key)]).size !== additional.length + 1) throw new DomainError('CONFLICT', 'One operation repeats an economic obligation');
      const previous = this.db.prepare('SELECT * FROM budget_reservations WHERE intent_id=?').get(intentId);
      if (previous) {
        if (previous.owner !== owner || previous.minor !== exposure.minor || previous.currency !== exposure.currency || (previous.economic_key ?? undefined) !== economicKey || digest(JSON.parse(String(previous.additional_impacts ?? '[]'))) !== digest(additional) || previous.state === 'released') throw new DomainError('CONFLICT', 'Original budget reservation cannot be reinterpreted or reopened');
        return;
      }
      const rows = this.db.prepare("SELECT b.intent_id,b.minor,b.currency,b.economic_key,b.role,b.additional_impacts FROM budget_reservations b JOIN action_intents i ON i.id=b.intent_id WHERE b.owner=? AND i.job_id=? AND b.state IN ('held','consumed')").all(owner, intent.jobId);
      if (composed) {
        const proposed = [...rows.map(row => ({ key: String(row.economic_key ?? row.intent_id), minor: String(row.minor), currency: String(row.currency), role: String(row.role ?? 'service_total') })),
          { key: economicKey!, ...exposure, role }, ...additional,
          ...rows.flatMap(row => JSON.parse(String(row.additional_impacts ?? '[]')) as { key: string; minor: string; currency: string; role: string }[])];
        const groups = new Map<string, typeof proposed[number]>();
        for (const row of proposed) {
          const prior = groups.get(row.key);
          if (prior && (prior.currency !== row.currency || prior.role !== row.role)) throw new DomainError('CONFLICT', 'Economic commitment currency or role changed');
          if (!prior || BigInt(row.minor) > BigInt(prior.minor)) groups.set(row.key, row);
        }
        for (const requirement of [...job.delegation!.request.requirements, ...(job.delegation!.request.successCriteria ?? [])]) if (requirement.kind === 'budget' && requirement.strength === 'hard') {
          const selected = [...groups.values()].filter(row => row.role === (requirement.role ?? 'service_total'));
          if (selected.some(row => row.currency !== requirement.expected.currency && BigInt(row.minor) !== 0n)
            || selected.reduce((total, row) => total + BigInt(row.minor), 0n) > BigInt(requirement.expected.minor)) throw new DomainError('FORBIDDEN', 'Cumulative task commitments exceed the fixed task budget');
        }
      } else if (rows.some(row => row.currency !== amount.currency) || rows.reduce((total, row) => total + BigInt(String(row.minor)), 0n) + BigInt(amount.minor) > BigInt(grant.maxAmount.minor)) throw new DomainError('FORBIDDEN', 'Cumulative action budget exceeds the grant');
      this.db.prepare('INSERT INTO budget_reservations(intent_id,owner,grant_id,minor,currency,state,economic_key,role,additional_impacts) VALUES(?,?,?,?,?,?,?,?,?)').run(intentId, owner, grant.id, exposure.minor, exposure.currency, 'held', economicKey ?? null, composed ? role : null, additional.length ? JSON.stringify(additional) : null);
    });
  }
  budget(owner: string, jobId: string) {
    this.assertOwnedJob(owner, jobId);
    return this.db.prepare('SELECT b.minor,b.currency,b.state,b.intent_id,b.role,b.additional_impacts FROM budget_reservations b JOIN action_intents i ON i.id=b.intent_id WHERE b.owner=? AND i.job_id=?').all(owner, jobId).map(row => ({ minor: row.minor, currency: row.currency, state: row.state, intent_id: row.intent_id, ...(row.role ? { role: String(row.role) } : {}), ...(row.additional_impacts ? { additionalImpacts: JSON.parse(String(row.additional_impacts)) as { key: string; minor: string; currency: string; role: string }[] } : {}) }));
  }
  cancelActions(owner: string, jobId: string): boolean {
    let pending = false;
    for (const intent of this.intents(owner, jobId)) {
      if (intent.state === 'ready') intent.state = 'canceled_before_dispatch';
      else if (['read', 'local'].includes(intent.effect) && ['dispatching', 'awaiting_remote', 'effect_unknown'].includes(intent.state)) { intent.state = 'canceled_after_dispatch'; intent.needsObservation = false; this.saveIntent(owner, intent); continue; }
      if (intent.state === 'dispatching') intent.state = 'effect_unknown';
      if (['effect_unknown', 'awaiting_remote'].includes(intent.state)) { pending = true; intent.nextAt = Date.now(); }
      this.saveIntent(owner, intent);
    }
    return pending;
  }
  createAfterSales(owner: string, value: AfterSalesCase): void {
    this.assertOwnedJob(owner, value.originalJobId); this.assertOwnedJob(owner, value.remedyJobId);
    this.db.prepare('INSERT INTO aftersales_cases VALUES(?,?,?,?,?)').run(value.id, owner, value.originalJobId, value.remedyJobId, JSON.stringify(value));
  }
  afterSales(owner: string, originalJobId: string): AfterSalesCase[] { this.assertOwnedJob(owner, originalJobId); return this.db.prepare('SELECT body FROM aftersales_cases WHERE owner=? AND original_job_id=?').all(owner, originalJobId).map(r => JSON.parse(String(r.body))); }
  afterSalesCase(owner: string, caseId: string): AfterSalesCase {
    const row = this.db.prepare('SELECT body FROM aftersales_cases WHERE owner=? AND id=?').get(owner, caseId);
    if (!row) throw new DomainError('NOT_FOUND', 'After-sales case not found');
    return JSON.parse(String(row.body)) as AfterSalesCase;
  }
  updateAfterSales(owner: string, caseId: string, state: AfterSalesCase['state']): void {
    const row = this.db.prepare('SELECT body FROM aftersales_cases WHERE owner=? AND id=?').get(owner, caseId); if (!row) throw new DomainError('NOT_FOUND', 'After-sales case not found');
    const value = JSON.parse(String(row.body)) as AfterSalesCase;
    this.db.prepare('UPDATE aftersales_cases SET body=? WHERE owner=? AND id=?').run(JSON.stringify({ ...value, state, updatedAt: new Date().toISOString() }), owner, caseId);
  }
  recordFeedback(owner: string, job: Job, evidenceLevel: string, verification = true): void {
    const d = job.delegation;
    if (d?.agent) {
      const agent = d.agent, outcome = d.outcome;
      const endpoint = agent.input.target ?? agent.input.completionTarget ?? agent.input.mode;
      const row = { capabilityRef: agent.programRef, bindingRef: agent.programRef, bindingDefinitionDigest: agent.programDigest,
        goalKind: typeof endpoint === 'string' ? `${agent.programRef.id}:${endpoint}` : agent.programRef.id, outcome: outcome?.status ?? 'unknown', taskState: job.state, evidenceLevel: outcome?.evidenceLevel ?? 'unverified',
        criterionResults: outcome?.criterionResults ?? [], observedAt: outcome?.assessedAt ?? job.updatedAt };
      const key = digest(agent.programRef);
      this.db.prepare('INSERT INTO outcome_feedback VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET binding_key=excluded.binding_key,body=excluded.body WHERE outcome_feedback.owner=excluded.owner').run(job.id, owner, key, JSON.stringify(row));
      for (const [componentId, component] of Object.entries(agent.components ?? {})) {
        const endpoint = component.input?.target ?? component.input?.completionTarget ?? component.input?.mode;
        const item = { capabilityRef: component.programRef, bindingRef: component.programRef, bindingDefinitionDigest: component.programDigest,
          rootTaskId: job.id, requestRevision: d.request.revision, componentId, scope: 'component_only', parentState: job.state,
          goalKind: typeof endpoint === 'string' ? `${component.programRef.id}:${endpoint}` : component.programRef.id,
          outcome: component.result ? 'satisfied' : 'unknown', taskState: component.result ? 'completed' : job.state,
          evidenceLevel: component.result?.delivery.evidenceLevel ?? 'unverified', criterionResults: [], observedAt: component.result?.at ?? row.observedAt };
        this.db.prepare('INSERT INTO outcome_feedback VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET body=excluded.body WHERE outcome_feedback.owner=excluded.owner')
          .run(`${job.id}:${d.request.revision}:${componentId}`, owner, digest(component.programRef), JSON.stringify(item));
      }
      const native = agent.composition;
      const assessment = native?.assessment;
      const currentAssessment = assessment && assessment.goalDigest === native?.goal.digest && native.goal.requestId === job.id && native.goal.requestRevision === d.request.revision ? assessment : undefined;
      for (const component of native?.contexts ?? []) {
        if (component.requestRevision !== d.request.revision) continue;
        const assessed = currentAssessment?.components.find(item => item.contextId === component.id);
        const delivery = assessed?.status === 'verified' && assessed.delivery?.evidenceRefs.length ? assessed.delivery : undefined;
        const endpoint = component.input.target ?? component.input.completionTarget ?? component.input.mode;
        const item = { capabilityRef: component.programRef, bindingRef: component.programRef, bindingDefinitionDigest: component.programDigest,
          rootTaskId: job.id, requestRevision: component.requestRevision, componentId: component.id, contextDigest: component.digest,
          scope: 'component_only', parentTaskState: job.state,
          goalKind: typeof endpoint === 'string' ? `${component.programRef.id}:${endpoint}` : component.programRef.id,
          outcome: delivery ? 'satisfied' : 'unknown', taskState: delivery ? 'completed' : job.state,
          evidenceLevel: delivery?.evidenceLevel ?? 'unverified', evidenceRefs: delivery ? [...delivery.evidenceRefs] : [], criterionResults: [],
          observedAt: currentAssessment?.at ?? row.observedAt, availabilityProof: false, automaticPromotion: false };
        this.db.prepare('INSERT INTO outcome_feedback VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET binding_key=excluded.binding_key,body=excluded.body WHERE outcome_feedback.owner=excluded.owner')
          .run(`${job.id}:${component.requestRevision}:context:${component.digest}`, owner, digest(component.programRef), JSON.stringify(item));
      }
      if (!verification || !['completed', 'failed', 'rejected', 'canceled'].includes(job.state)) return;
      const claim = { id: digest({ owner, program: agent.programRef, configuration: agent.programDigest }), capabilityRef: agent.programRef, bindingRef: agent.programRef, publisherId: 'configured-agent-program', sourceRevision: agent.programDigest, sourceRef: 'configured-versioned-definition', observedAt: row.observedAt };
      const verified = { id: digest({ owner, jobId: job.id, revision: d.request.revision, state: job.state, outcome }), claimId: claim.id, sourceRevision: agent.programDigest,
        actionTypeRefs: [...new Map(agent.plans.flatMap(p => p.steps.map(s => [s.action, { id: s.action, definitionDigest: s.definitionDigest }] as const))).values()],
        level: row.evidenceLevel, result: job.state === 'completed' && outcome?.status === 'satisfied' ? 'passed' : outcome?.status === 'unsatisfied' ? 'failed' : 'inconclusive',
        scope: { capabilityRef: agent.programRef, requestId: job.id, requestRevision: d.request.revision, configurationDigest: agent.programDigest, executionEnvironment: d.request.executionEnvironment ?? 'live', observedAt: row.observedAt },
        evidenceRefs: outcome?.evidenceRefs ?? [], verifiedAt: row.observedAt, availabilityProof: false };
      this.db.prepare('INSERT OR IGNORE INTO capability_claims VALUES(?,?,?,?)').run(claim.id, owner, key, JSON.stringify(claim));
      this.db.prepare('INSERT OR IGNORE INTO capability_verifications VALUES(?,?,?,?)').run(verified.id, owner, key, JSON.stringify(verified));
      return;
    }
    if (!d?.plan) return;
    const row = { capabilityRef: d.plan.capabilityRef, bindingRef: d.plan.bindingRef, bindingDefinitionDigest: d.plan.bindingDigests.find(p => p.ref.id === d.plan!.bindingRef.id && p.ref.version === d.plan!.bindingRef.version)?.digest,
      goalKind: d.request.outcome ?? d.plan.completionTarget, outcome: ['working', 'submitted', 'auth-required', 'input-required', 'canceled'].includes(job.state) ? 'unknown' : d.outcome?.status ?? 'unknown', taskState: job.state, evidenceLevel, criterionResults: d.outcome?.criterionResults ?? [], observedAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO outcome_feedback VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET binding_key=excluded.binding_key,body=excluded.body WHERE outcome_feedback.owner=excluded.owner').run(job.id, owner, digest(d.plan.bindingRef), JSON.stringify(row));
    if (!verification) return;
    const selected = d.resolution?.candidates.find(c => c.id === d.plan!.candidateId);
    const sourceRevision = selected?.offer?.sourceRevision ?? d.plan.digest;
    const claim = { id: digest({ owner, binding: d.plan.bindingRef, sourceRevision }), capabilityRef: d.plan.capabilityRef, bindingRef: d.plan.bindingRef, publisherId: selected?.binding.channelId ?? 'configured-binding', sourceRevision,
      sourceRef: selected?.binding.discovery?.sourceId ?? 'configured-versioned-definition', observedAt: row.observedAt };
    const verified = { id: digest({ owner, jobId: job.id, at: row.observedAt }), claimId: claim.id, sourceRevision, actionTypeRefs: d.plan.steps.map(s => s.actionTypeRef), level: evidenceLevel,
      result: job.state === 'completed' && row.outcome === 'satisfied' ? 'passed' : row.outcome === 'unsatisfied' ? 'failed' : 'inconclusive',
      scope: { capabilityRef: d.plan.capabilityRef, requestId: job.id, requestRevision: d.request.revision, executionEnvironment: d.request.executionEnvironment ?? 'live', requirements: d.request.requirements.map(r => ({ kind: r.kind, expected: r.expected })), observedAt: row.observedAt },
      evidenceRefs: d.outcome?.evidenceRefs ?? [], verifiedAt: row.observedAt, availabilityProof: false };
    const key = digest(d.plan.bindingRef);
    this.db.prepare('INSERT OR IGNORE INTO capability_claims VALUES(?,?,?,?)').run(claim.id, owner, key, JSON.stringify(claim));
    this.db.prepare('INSERT OR IGNORE INTO capability_verifications VALUES(?,?,?,?)').run(verified.id, owner, key, JSON.stringify(verified));
    if (verified.result !== 'passed') {
      const proposal = { id: digest({ owner, verificationId: verified.id }), kind: 'inspect_binding', bindingRef: d.plan.bindingRef, sourceRevision, evidenceRefs: verified.evidenceRefs, status: 'proposed', publishable: false, reason: d.outcome?.reason ?? 'Business outcome unresolved', createdAt: row.observedAt };
      this.db.prepare('INSERT OR IGNORE INTO capability_change_proposals VALUES(?,?,?,?)').run(proposal.id, owner, key, JSON.stringify(proposal));
    }
  }
  resultFeedback(owner: string, jobId: string): unknown {
    this.assertOwnedJob(owner, jobId);
    const row = this.db.prepare('SELECT body FROM outcome_feedback WHERE owner=? AND job_id=?').get(owner, jobId);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  providerFeedback(owner: string, bindingRef: { id: string; version: string }): unknown[] {
    return this.db.prepare('SELECT body FROM outcome_feedback WHERE owner=? AND binding_key=?').all(owner, digest(bindingRef)).map(r => JSON.parse(String(r.body)));
  }
  providerEvidenceView(owner: string, bindingRef: { id: string; version: string }, definitionDigest?: string) {
    const all = this.providerFeedback(owner, bindingRef) as { bindingDefinitionDigest?: string; goalKind: string; outcome: string; taskState: string; evidenceLevel: string; observedAt: string }[];
    const rows = definitionDigest ? all.filter(r => r.bindingDefinitionDigest === definitionDigest) : all;
    const outcomes: Record<string, number> = {}, levels: Record<string, number> = {}, states: Record<string, number> = {}, goals: Record<string, number> = {};
    for (const row of rows) { outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1; levels[row.evidenceLevel] = (levels[row.evidenceLevel] ?? 0) + 1; states[row.taskState] = (states[row.taskState] ?? 0) + 1; goals[row.goalKind] = (goals[row.goalKind] ?? 0) + 1; }
    return { scope: 'Task outcomes for this owner and exact binding version; unresolved tasks remain in the denominator', definitionDigest: definitionDigest ?? null, sampleCount: rows.length, outcomeCounts: outcomes, taskStateCounts: states, evidenceLevelCounts: levels, goalKindCounts: goals,
      firstObservedAt: rows.map(r => r.observedAt).sort()[0] ?? null, lastObservedAt: rows.map(r => r.observedAt).sort().at(-1) ?? null, includesUnknownAndCanceled: true, availabilityProof: false, automaticPromotion: false };
  }
  capabilityFacts(owner: string, bindingRef: { id: string; version: string }) {
    const query = (table: 'capability_claims' | 'capability_verifications' | 'capability_change_proposals') => this.db.prepare(`SELECT body FROM ${table} WHERE owner=? AND binding_key=? ORDER BY rowid DESC LIMIT 50`).all(owner, digest(bindingRef)).map(r => JSON.parse(String(r.body)));
    return { claims: query('capability_claims'), verifications: query('capability_verifications'), changeProposals: query('capability_change_proposals'), summary: this.providerEvidenceView(owner, bindingRef) };
  }

  transaction<T>(action: () => T): T {
    if (this.security?.enabled && (this.transactionDepth || this.security.inTransaction)) { this.transactionDepth++; try { return this.security.atomic(action); } finally { this.transactionDepth--; } }
    return businessTransaction(this.db, () => { this.transactionDepth++; try { return action(); } finally { this.transactionDepth--; } });
  }

  // Only claimed attempts are interrupted. Unclaimed durable work remains queued.
  // Expired calls are never automatically replayed: their external outcome is unknown.
  private parkUnavailableOntology(owner: string, job: Job, now: number): boolean {
    try { this.ontologyForJob(owner, job); return false; }
    catch (error) {
      if (!(error instanceof OntologyReleaseUnavailable)) throw error;
      scheduleTaskRecovery(job, 'validation_stalled', error.message, { now, automatic: false, operation: 'ontology_release' });
      // No graph can be safely projected under a missing contract. Persist only
      // the canonical technical pause, retaining every original pin and fact.
      this.db.prepare('UPDATE jobs SET state=?,updated_at=?,body=? WHERE owner=? AND id=?')
        .run(job.state, job.updatedAt, JSON.stringify(job), owner, job.id);
      return true;
    }
  }
  private saveRecoveredWork(owner: string, job: Job, now: number): boolean {
    try { this.save(owner, job); return true; }
    catch (error) {
      if (!(error instanceof SecurityLineageLimitError)) throw error;
      const previous = { state: job.state, phase: job.delegation!.phase, question: job.question, error: job.error };
      scheduleTaskRecovery(job, 'validation_stalled', '当前任务暂时无法完成安全核验。原任务与证据已保留，修复运行环境后可继续。', { now, automatic: false, operation: 'security_lineage_capacity' });
      if (!['working', 'submitted'].includes(previous.state)) {
        job.state = previous.state; job.delegation!.phase = previous.phase;
        job.question = previous.question; job.error = previous.error;
        delete job.delegation!.recoveryPending;
      }
      // The failed projection rolled back its savepoint. Persist only the
      // technical pause; keep all evidence and deny output until repaired.
      this.db.prepare('UPDATE jobs SET state=?,updated_at=?,body=? WHERE owner=? AND id=?')
        .run(job.state, job.updatedAt, JSON.stringify(job), owner, job.id);
      return false;
    }
  }
  private expireClaims(now: number): void {
    const rows = this.db.prepare(`SELECT j.owner,j.body,c.revision,c.token AS claim_token FROM work_claims c
      JOIN jobs j ON j.id=c.job_id WHERE c.expires_at<=?`).all(now);
    for (const row of rows) {
      const job = JSON.parse(String(row.body)) as Job;
      markModelUsageUnknown(this.db, String(row.owner), job.id, digest(String(row.claim_token)));
      if (job.service !== 'eigos.delegate' || job.delegation?.backendVersion !== BACKEND_VERSION) continue;
      if (this.parkUnavailableOntology(String(row.owner), job, now)) continue;
      if ((job.delegation?.plan || job.delegation?.agent) && (job.revision ?? 0) === Number(row.revision)) {
        const owner = String(row.owner); const intents = this.intents(owner, job.id);
        for (const intent of intents) if (intent.state === 'dispatching') { intent.state = 'effect_unknown'; intent.nextAt = now; this.saveIntent(owner, intent); }
        if (job.state === 'working') job.delegation.nextAt = now;
        else if (intents.some(i => ['dispatching', 'awaiting_remote', 'effect_unknown'].includes(i.state))) job.delegation.recoveryPending = true;
        job.updatedAt = new Date(now).toISOString(); this.saveRecoveredWork(owner, job, now); continue;
      }
      if (job.state !== 'working' || (job.revision ?? 0) !== Number(row.revision)) continue;
      scheduleTaskRecovery(job, 'worker_interrupted', '运行进程中断，已保留原任务，恢复后继续处理。', { now });
      this.saveRecoveredWork(String(row.owner), job, now);
    }
    this.db.prepare('DELETE FROM work_claims WHERE expires_at<=?').run(now);
  }

  claim(services: string[], leaseMs: number, now?: number): WorkClaim | undefined {
    return this.transaction(() => {
      if (!this.authorityCurrent()) return;
      const at = now ?? Date.now();
      this.expireClaims(at);
      if (!services.length) return;
      // Keep the existing two-call budget across all Workers sharing this database.
      const active=Number(this.db.prepare('SELECT count(*) AS n FROM work_claims').get()!.n)
        +(this.security.enabled?Number(this.db.prepare("SELECT count(*) AS n FROM security_recoveries WHERE state='running' AND lease_until>?").get(at)!.n):0);
      if (active >= 2) return;
      const query = this.db.prepare(`SELECT owner,body FROM jobs WHERE (state IN ('working','submitted') OR (state IN ('canceled','failed','rejected','completed','auth-required') AND json_extract(body,'$.delegation.recoveryPending')=1))
        AND COALESCE(json_extract(body,'$.executionMode'), 'worker')=?
        AND json_extract(body,'$.service') IN (${services.map(() => '?').join(',')})
        AND json_extract(body,'$.service')='eigos.delegate' AND json_extract(body,'$.delegation.backendVersion')=?
        AND COALESCE(json_extract(body,'$.delegation.nextAt'),0)<=?
        AND id NOT IN (SELECT job_id FROM work_claims)
        ${this.authority ? "AND json_extract(body,'$.authorityId')=:runtimeAuthority" : ''}
        ${this.security.enabled ? this.security.workPredicate : ''} ORDER BY created_at,id LIMIT 1`);
      const named = { ...(this.security.enabled ? { securityNow:at,securityDefinition:this.security.policies.definitionDigest } : {}), ...(this.authority ? { runtimeAuthority:this.authority.id } : {}) };
      const values = [this.security.enabled ? 'worker-security-v2' : 'worker',...services,BACKEND_VERSION,at];
      const row = Object.keys(named).length ? query.get(named,...values) : query.get(...values);
      if (!row) return;
      const job = JSON.parse(String(row.body)) as Job;
      if (this.parkUnavailableOntology(String(row.owner), job, at)) return;
      if (job.state === 'submitted') {
        job.state = 'working'; job.updatedAt = new Date(now ?? Date.now()).toISOString();
        if (!this.saveRecoveredWork(String(row.owner), job, at)) return;
      }
      const token = randomUUID();
      const claimedAt = now ?? Date.now();
      this.db.prepare('INSERT INTO work_claims VALUES(?,?,?,?)').run(job.id, token, job.revision ?? 0, claimedAt + leaseMs);
      if (this.authority) {
        this.db.prepare('DELETE FROM runtime_work_claims WHERE NOT EXISTS (SELECT 1 FROM work_claims c WHERE c.job_id=runtime_work_claims.job_id AND c.token=runtime_work_claims.token)').run();
        this.db.prepare('INSERT INTO runtime_work_claims VALUES(?,?,?)').run(job.id, token, runtimeAuthorityDigest(this.authority));
      }
      const authority = this.security.workAuthority(String(row.owner), job.id, at);
      return { owner: String(row.owner), job, token, ...(authority ? { securityAuthorityId: authority.id, securityEpoch: authority.authEpoch, securityPolicyRevision: this.security.policies.revision() } : {}), ...(job.state !== 'working' ? { recovery: true } : {}) };
    });
  }

  renew(claim: WorkClaim, leaseMs: number, now?: number): boolean {
    return this.transaction(() => {
      const at = now ?? Date.now();
      if (!this.active(claim, at)) return false;
      const renewedAt = now ?? Date.now();
      return this.db.prepare('UPDATE work_claims SET expires_at=? WHERE job_id=? AND token=? AND expires_at>?').run(renewedAt + leaseMs, claim.job.id, claim.token, renewedAt).changes === 1;
    });
  }

  private leaseOwned(claim: WorkClaim, now: number): boolean {
    if (!this.authorityCurrent() || !claimAuthorityCurrent(this.db, claim.job.id, claim.token)) return false;
    const lease = this.db.prepare('SELECT token,expires_at,revision FROM work_claims WHERE job_id=?').get(claim.job.id);
    return lease?.token === claim.token && Number(lease.expires_at) > now && Number(lease.revision) === (claim.job.revision ?? 0);
  }
  private active(claim: WorkClaim, now: number): boolean {
    if (!this.leaseOwned(claim, now)) return false;
    const current = this.taskFence(claim.owner, claim.job.id);
    if (this.security.enabled) {
      const authority = this.security.workAuthority(claim.owner, claim.job.id, now);
      if (!authority || authority.id !== claim.securityAuthorityId || authority.authEpoch !== claim.securityEpoch || claim.securityPolicyRevision!==this.security.policies.revision()) return false;
    }
    return (claim.recovery ? current.state === claim.job.state && current.recoveryPending === true : current.state === 'working')
      && (current.requestRevision ?? 0) === (claim.job.delegation?.request?.revision ?? 0)
      && (current.revision ?? 0) === (claim.job.revision ?? 0);
  }
  claimActive(claim: WorkClaim): boolean { return this.active(claim, Date.now()); }

  finish(claim: WorkClaim, update: (job: Job) => void, now?: number): boolean {
    try { return this.transaction(() => {
      const at = now ?? Date.now();
      if (!this.active(claim, at)) return false;
      const job = this.get(claim.owner, claim.job.id);
      update(job); this.save(claim.owner, job);
      // The callback may intentionally complete/pause/revise the task. The
      // initial active check plus SQLite's write transaction fences that state;
      // the token and wall-clock deadline must still hold at commit.
      if (!this.leaseOwned(claim, now ?? Date.now())) throw lostClaimFence;
      this.db.prepare('DELETE FROM work_claims WHERE job_id=? AND token=?').run(job.id, claim.token);
      return true;
    }); } catch (error) { if (error === lostClaimFence) return false; throw error; }
  }

  checkpoint(claim: WorkClaim, update: (job: Job) => void): boolean {
    try { return this.transaction(() => {
      if (!this.active(claim, Date.now())) return false;
      const job = this.get(claim.owner, claim.job.id);
      update(job); this.save(claim.owner, job);
      if (!this.leaseOwned(claim, Date.now())) throw lostClaimFence;
      return true;
    }); } catch (error) { if (error === lostClaimFence) return false; throw error; }
  }

  release(claim: WorkClaim): void {
    this.db.prepare('DELETE FROM work_claims WHERE job_id=? AND token=?').run(claim.job.id, claim.token);
  }

  private ownedTaskRow(owner: string, id: string, columns: string, fence = false) {
    const sql=fence ? `WITH source AS MATERIALIZED (SELECT body,typeof(body) body_type,json_valid(body) valid FROM jobs WHERE owner=? AND id=?), owned AS MATERIALIZED (SELECT body_type,valid,CASE WHEN body_type='text' AND valid THEN jsonb(body) END parsed FROM source) SELECT ${columns} FROM owned` : `SELECT ${columns} FROM jobs WHERE owner=? AND id=?`;
    const row=this.db.prepare(sql).get(owner,id);
    if(!row)throw new DomainError('NOT_FOUND','Task not found');
    return row;
  }
  /** Fresh ownership check without materializing an unrelated multi-megabyte
   * execution history. Corrupt stored JSON still fails closed. */
  private assertOwnedJob(owner: string, id: string): void {
    const row=this.ownedTaskRow(owner,id,"typeof(body) AS body_type,json_valid(body) AS valid");
    if(row.body_type!=='text' || row.valid!==1)throw new SyntaxError('Stored task JSON is invalid');
  }
  private taskFence(owner: string, id: string): Pick<Job,'state'|'revision'> & {requestRevision:unknown;recoveryPending:unknown} {
    const row=this.ownedTaskRow(owner,id,`body_type,valid,
      json_extract(parsed,'$.state','$.revision','$.delegation.request.revision','$.delegation.recoveryPending') AS fence,
      (SELECT count(*)>count(DISTINCT key) FROM json_each(parsed) WHERE key IN ('state','revision','delegation'))
      OR CASE WHEN json_type(parsed,'$.delegation')='object' THEN (SELECT count(*)>count(DISTINCT key) FROM json_each(jsonb_extract(parsed,'$.delegation')) WHERE key IN ('request','recoveryPending')) ELSE 0 END
      OR CASE WHEN json_type(parsed,'$.delegation.request')='object' THEN (SELECT count(*)>count(DISTINCT key) FROM json_each(jsonb_extract(parsed,'$.delegation.request')) WHERE key='revision') ELSE 0 END AS ambiguous`,true);
    if(row.body_type!=='text' || row.valid!==1)throw new SyntaxError('Stored task JSON is invalid');
    // SQLite paths choose the first duplicate key; JSON.parse chooses the last.
    // Preserve the original full-reader semantics for noncanonical legacy rows.
    if(row.ambiguous){const job=this.get(owner,id);return {state:job.state,revision:job.revision,requestRevision:job.delegation?.request?.revision,recoveryPending:job.delegation?.recoveryPending};}
    const [state,revision,requestRevision,recoveryPending]=JSON.parse(String(row.fence));
    return {state,revision,requestRevision,recoveryPending};
  }
  get(owner: string, id: string): Job {
    const row = this.ownedTaskRow(owner,id,'body');
    return JSON.parse(String(row.body)) as Job;
  }

  hasContext(owner: string, contextId: string): boolean {
    if (this.security.enabled) {
      const scope=this.security.policies.scope(owner,false);
      return this.security.listGrants(owner).some(g=>g.kind==='task_data' && g.installationId===scope.actor.installationId && g.status==='active'
        && this.get(owner,g.taskId).contextId===contextId && !!this.security.taskGrant(scope.actor,g.taskId));
    }
    return !!this.db.prepare('SELECT 1 FROM jobs WHERE owner = ? AND context_id = ? LIMIT 1').get(owner, contextId);
  }

  hasRequest(owner: string, operation: string, requestId: string): boolean {
    if (this.security.enabled) operation = `${this.security.policies.scope(owner,false).actor.installationId}:${operation}`;
    return !!this.db.prepare('SELECT 1 FROM requests WHERE owner=? AND operation=? AND request_id=?').get(owner, operation, requestId);
  }
  hasActiveClaim(taskId:string):boolean { return !!this.db.prepare('SELECT 1 FROM work_claims WHERE job_id=? AND expires_at>?').get(taskId,this.security.now()); }

  save(owner: string, job: Job): void {
    this.assertRuntimeAuthority();
    // The old Worker queue selector must not claim a foundation task even if an
    // operator accidentally starts an old binary against this new database.
    if (this.security.enabled) job.executionMode = 'worker-security-v2';
    this.db.exec('SAVEPOINT task_and_ontology');
    try {
      const previous = this.db.prepare('SELECT owner,body FROM jobs WHERE id=?').get(job.id);
      if (this.authority && !previous && job.delegation?.backendVersion === BACKEND_VERSION) job.authorityId = this.authority.id;
      if (this.authority && job.authorityId !== undefined && job.authorityId !== this.authority.id) throw new DomainError('CONFLICT', 'Task belongs to another runtime authority');
      if (previous) {
        if (previous.owner !== owner) throw new DomainError('FORBIDDEN', 'Task owner mismatch');
        const original = JSON.parse(String(previous.body)) as Job;
        if (original.authorityId !== job.authorityId) throw new DomainError('CONFLICT', 'Task authority is immutable');
        if (digest(original.delegation?.ontologyRelease ?? null) !== digest(job.delegation?.ontologyRelease ?? null)) throw new DomainError('CONFLICT', 'A task\'s ontology release is immutable');
        if (digest(original.delegation?.callerAction ?? null) !== digest(job.delegation?.callerAction ?? null)) throw new DomainError('CONFLICT', 'Authenticated caller action evidence is immutable');
      }
      synchronizeTaskOutcome(job);
      const saved = this.db.prepare(`INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at, body=excluded.body
      WHERE jobs.owner=excluded.owner`).run(
      job.id, owner, job.contextId, job.state, job.createdAt, job.updatedAt, JSON.stringify(job),
      );
      if (!saved.changes) throw new DomainError('FORBIDDEN', 'Task owner mismatch');
      if (job.service === 'eigos.delegate' && job.delegation?.backendVersion === BACKEND_VERSION) projectTask(this.projectionForJob(owner, job), owner, job);
      this.projectExecution(owner, job);
      if (this.security.enabled) this.security.policies.bindTaskProjection(owner, job.id);
      const scope=authorizationScope();
      if (this.security.enabled && scope?.actor.actorKind==='worker' && scope.grant?.taskId===job.id && scope.lineage.size) {
        const envelope=this.security.policies.outputEnvelope(owner);
        this.security.policies.validateLineage(scope,envelope);
        if (job.question) this.security.policies.recordOutput(owner,job.id,'question',job.question,envelope);
        if (job.artifact) this.security.policies.recordOutput(owner,job.id,'artifact',job.artifact,envelope);
        if(job.delegation?.authorizationRequest) this.security.policies.recordOutput(owner,job.id,'authorization',job.delegation.authorizationRequest,envelope);
        if(job.delegation?.agent?.paPayment) this.security.policies.recordOutput(owner,job.id,'payment',job.delegation.agent.paPayment.request,envelope);
      }
      if (job.delegation?.backendVersion === BACKEND_VERSION && job.delegation.agent) this.recordFeedback(owner, job, job.delegation.outcome?.evidenceLevel ?? 'unverified');
      this.db.exec('RELEASE task_and_ontology');
    } catch (error) { this.db.exec('ROLLBACK TO task_and_ontology; RELEASE task_and_ontology'); throw error; }
  }

  list(owner: string, filter: ListFilter, taskIds?: string[]): { jobs: Job[]; total: number } {
    const clauses = ['owner = ?'];
    const args: string[] = [owner];
    if (taskIds) { clauses.push('id IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(taskIds)); }
    if (filter.contextId) { clauses.push('context_id = ?'); args.push(filter.contextId); }
    if (filter.state) { clauses.push('state = ?'); args.push(filter.state); }
    if (filter.updatedAfter) { clauses.push('updated_at >= ?'); args.push(filter.updatedAfter); }
    const where = clauses.join(' AND ');
    const total = Number(this.db.prepare(`SELECT count(*) AS total FROM jobs WHERE ${where}`).get(...args)?.total ?? 0);
    const rows = this.db.prepare(`SELECT body FROM jobs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, filter.limit, filter.offset);
    return { jobs: rows.map(row => JSON.parse(String(row.body)) as Job), total };
  }

  assertTransaction(): void {
    if (this.security?.enabled && this.transactionDepth > 0) return;
    assertBusinessTransaction(this.db);
  }
  sharesNetworkStore(store: NetworkStore): boolean { return store.usesConnection(this.db); }
  hasClaim(owner: string, jobId: string): boolean {
    this.assertOwnedJob(owner, jobId); return !!this.db.prepare('SELECT 1 FROM work_claims WHERE job_id=?').get(jobId);
  }
  bindInquiryContext(owner: string, jobId: string, value: unknown): void {
    this.assertTransaction(); this.assertOwnedJob(owner, jobId);
    this.db.prepare('INSERT INTO preparation_contexts VALUES(?,?,?,?)').run(owner, jobId, 'network-inquiry-source@1', JSON.stringify(value));
  }

  // All mutations are synchronous inside one transaction, including the retry receipt.
  once(owner: string, operation: string, requestId: string, fingerprint: string, action: () => Job): Job {
    return this.transaction(() => this.onceInTransaction(owner, operation, requestId, fingerprint, action));
  }
  onceInTransaction(owner: string, operation: string, requestId: string, fingerprint: string, action: () => Job): Job {
    this.assertTransaction();
    if (this.security.enabled) operation = `${this.security.policies.scope(owner,false).actor.installationId}:${operation}`;
    const previous = this.db.prepare('SELECT fingerprint, response FROM requests WHERE owner=? AND operation=? AND request_id=?')
      .get(owner, operation, requestId);
    if (previous) {
      if (!equivalentFingerprint(String(previous.fingerprint), fingerprint)) throw new DomainError('CONFLICT', 'Request ID was already used with different input');
      const response = JSON.parse(String(previous.response));
      return this.security.enabled ? this.get(owner, String(response.taskId)) : response as Job;
    }
    const result = action();
    this.db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)').run(owner, operation, requestId, fingerprint, JSON.stringify(this.security.enabled ? {taskId:result.id} : result));
    return result;
  }
}
