import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError, type Job, type JobState } from './domain.js';
import { BACKEND_VERSION } from '../ontology/execution.js';
import type { ActionIntent, ActionResult, ExecutionAttempt, PlanGrant, AfterSalesCase } from '../ontology/actions.js';
import { digest } from './delegation.js';
import { OntologyObjectStore } from '../ontology/object-store.js';
import { projectTask } from '../ontology/task-projection.js';
import { synchronizeTaskOutcome } from './task-outcome.js';

export interface ListFilter {
  limit: number;
  offset: number;
  contextId?: string;
  state?: JobState;
  updatedAfter?: string;
}

export interface WorkClaim { owner: string; job: Job; token: string; recovery?: boolean }

function equivalentFingerprint(a: string, b: string): boolean {
  if (a === b) return true;
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, normalize(v)])) : value;
  try { return JSON.stringify(normalize(JSON.parse(a))) === JSON.stringify(normalize(JSON.parse(b))); }
  catch { return false; }
}

export class JobStore {
  private db: DatabaseSync;
  readonly ontology: OntologyObjectStore;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, context_id TEXT NOT NULL,
          state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner, created_at, id);
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
        CREATE TABLE IF NOT EXISTS preparation_contexts (owner TEXT NOT NULL, job_id TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner,job_id,key));
      `);
    });
    this.ontology = new OntologyObjectStore(this.db);
  }

  close(): void { this.db.close(); }

  preparationContext<T>(owner: string, jobId: string, key: string): T | undefined {
    this.get(owner, jobId);
    const row = this.db.prepare('SELECT body FROM preparation_contexts WHERE owner=? AND job_id=? AND key=?').get(owner, jobId, key);
    return row ? JSON.parse(String(row.body)) as T : undefined;
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
    this.get(owner, intent.jobId);
    if (intent.owner !== owner) throw new DomainError('FORBIDDEN', 'Action owner mismatch');
    const previous = this.db.prepare('SELECT id FROM action_intents WHERE owner=? AND business_key=?').get(owner, intent.businessOperationKey);
    if (previous) {
      const old = this.intent(owner, String(previous.id));
      if (old.jobId !== intent.jobId || !['local', 'read'].includes(old.effect) || !['local', 'read'].includes(intent.effect) || !['rejected', 'effect_confirmed', 'needs_review'].includes(old.state)) throw new DomainError('CONFLICT', 'Business operation already exists; reconcile its original intent');
      this.db.prepare('INSERT OR IGNORE INTO action_intent_versions VALUES(?,?,?,?)').run(old.id, owner, old.planDigest, JSON.stringify(old));
      const { privateData, ...body } = { ...intent, id: old.id };
      this.db.prepare('UPDATE action_intents SET state=?,private_data=?,body=? WHERE owner=? AND id=?').run(intent.state, JSON.stringify(privateData ?? null), JSON.stringify(body), owner, old.id);
      return old.id;
    }
    const { privateData, ...body } = intent;
    this.db.prepare('INSERT INTO action_intents VALUES(?,?,?,?,?,?,?)').run(intent.id, owner, intent.jobId, intent.businessOperationKey, intent.state, JSON.stringify(privateData ?? null), JSON.stringify(body));
    return intent.id;
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
    this.get(owner, jobId);
    return this.db.prepare('SELECT id FROM action_intents WHERE owner=? AND job_id=? ORDER BY id').all(owner, jobId).map(r => this.intent(owner, String(r.id)));
  }
  saveIntent(owner: string, intent: ActionIntent): void {
    const current = this.intent(owner, intent.id);
    if (intent.owner !== owner || intent.businessOperationKey !== current.businessOperationKey || intent.planDigest !== current.planDigest) throw new DomainError('CONFLICT', 'Action identity changed');
    const { privateData, ...body } = intent;
    this.db.prepare('UPDATE action_intents SET state=?,body=? WHERE owner=? AND id=?').run(intent.state, JSON.stringify(body), owner, intent.id);
  }
  dispatchIntent(owner: string, id: string): void {
    const result = this.db.prepare("UPDATE action_intents SET state='dispatching' WHERE owner=? AND id=? AND state='ready'").run(owner, id);
    if (Number(result.changes) !== 1) throw new DomainError('CONFLICT', 'Started action must be reconciled; automatic replay is prohibited');
  }
  startAttempt(claim: WorkClaim, intentId: string, kind: ExecutionAttempt['kind'], inputDigest: string, requestKey?: string): ExecutionAttempt {
    const intent = this.intent(claim.owner, intentId);
    if (intent.jobId !== claim.job.id) throw new DomainError('FORBIDDEN', 'Attempt belongs to another task');
    if (kind === 'dispatch') this.dispatchIntent(claim.owner, intentId);
    else if (intent.state === 'ready' || intent.state === 'canceled_before_dispatch') throw new DomainError('CONFLICT', 'Action has not been dispatched');
    const attempt: ExecutionAttempt = { id: randomUUID(), intentId, kind, requestKey: requestKey ?? (kind === 'dispatch' ? intent.businessOperationKey : randomUUID()), startedAt: new Date().toISOString(), claimToken: claim.token, requestRevision: claim.job.revision ?? 0, inputDigest, planDigest: intent.planDigest, ordinal: this.attempts(claim.owner, intentId).length + 1 };
    this.db.prepare('INSERT INTO action_attempts VALUES(?,?,?,?)').run(attempt.id, claim.owner, intentId, JSON.stringify(attempt));
    return attempt;
  }
  attempts(owner: string, intentId: string): ExecutionAttempt[] {
    this.intent(owner, intentId);
    return this.db.prepare('SELECT body FROM action_attempts WHERE owner=? AND intent_id=? ORDER BY rowid').all(owner, intentId).map(r => JSON.parse(String(r.body)));
  }
  recordObservation(owner: string, intentId: string, attemptId: string, result: ActionResult, verified: boolean,
    fence?: { claim: WorkClaim; apply: (job: Job, intent: ActionIntent) => void }): { id: string; applied: boolean } {
    return this.transaction(() => {
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
        return { id, applied: false };
      }
      if (duplicate) {
        if (fence) return { id: String(duplicate.id), applied: false };
        if (duplicate.digest !== hash) {
          if (attempt.planDigest === intent.planDigest) { intent.state = 'needs_review'; this.saveIntent(owner, intent); }
          const event = `${result.eventId}:conflict:${hash}`; const previous = this.db.prepare('SELECT id FROM action_observations WHERE owner=? AND intent_id=? AND event_id=?').get(owner, intentId, event);
          const id = previous ? String(previous.id) : randomUUID();
          if (!previous) this.db.prepare('INSERT INTO action_observations VALUES(?,?,?,?,?,?,?,?,?)').run(id, owner, intentId, event, attemptId, new Date().toISOString(), hash, 0, JSON.stringify(result));
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
      return { id, applied: !!applied };
    });
  }
  observations(owner: string, intentId: string): unknown[] {
    this.intent(owner, intentId);
    return this.db.prepare('SELECT body FROM action_observations WHERE owner=? AND intent_id=? ORDER BY received_at,id').all(owner, intentId).map(r => JSON.parse(String(r.body)));
  }
  grant(owner: string, grant: PlanGrant): void {
    if (grant.owner !== owner) throw new DomainError('FORBIDDEN', 'Grant owner mismatch'); this.get(owner, grant.jobId);
    this.db.prepare('INSERT INTO plan_grants VALUES(?,?,?,?)').run(grant.id, owner, grant.jobId, JSON.stringify(grant));
  }
  grants(owner: string, jobId: string): PlanGrant[] { this.get(owner, jobId); return this.db.prepare('SELECT body FROM plan_grants WHERE owner=? AND job_id=?').all(owner, jobId).map(r => JSON.parse(String(r.body))); }
  revokeGrants(owner: string, jobId: string): void {
    for (const grant of this.grants(owner, jobId)) this.db.prepare('UPDATE plan_grants SET body=? WHERE owner=? AND id=?').run(JSON.stringify({ ...grant, revoked: true }), owner, grant.id);
  }
  reserveBudget(owner: string, intentId: string, grant: PlanGrant, amount: { minor: string; currency: string }): void {
    this.intent(owner, intentId);
    if (this.db.prepare('SELECT 1 FROM budget_reservations WHERE intent_id=?').get(intentId)) return;
    const rows = this.db.prepare("SELECT b.minor,b.currency FROM budget_reservations b JOIN action_intents i ON i.id=b.intent_id WHERE b.owner=? AND i.job_id=? AND b.state IN ('held','consumed')").all(owner, grant.jobId);
    if (amount.currency !== grant.maxAmount.currency || rows.some(r => r.currency !== amount.currency) || rows.reduce((n, r) => n + BigInt(String(r.minor)), 0n) + BigInt(amount.minor) > BigInt(grant.maxAmount.minor)) throw new DomainError('FORBIDDEN', 'Cumulative action budget exceeds the grant');
    this.db.prepare('INSERT INTO budget_reservations VALUES(?,?,?,?,?,?)').run(intentId, owner, grant.id, amount.minor, amount.currency, 'held');
  }
  budget(owner: string, jobId: string) {
    this.get(owner, jobId);
    return this.db.prepare('SELECT b.minor,b.currency,b.state,b.intent_id FROM budget_reservations b JOIN action_intents i ON i.id=b.intent_id WHERE b.owner=? AND i.job_id=?').all(owner, jobId);
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
    this.get(owner, value.originalJobId); this.get(owner, value.remedyJobId);
    this.db.prepare('INSERT INTO aftersales_cases VALUES(?,?,?,?,?)').run(value.id, owner, value.originalJobId, value.remedyJobId, JSON.stringify(value));
  }
  afterSales(owner: string, originalJobId: string): AfterSalesCase[] { this.get(owner, originalJobId); return this.db.prepare('SELECT body FROM aftersales_cases WHERE owner=? AND original_job_id=?').all(owner, originalJobId).map(r => JSON.parse(String(r.body))); }
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
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  // Only claimed attempts are interrupted. Unclaimed durable work remains queued.
  // Expired calls are never automatically replayed: their external outcome is unknown.
  private expireClaims(now: number): void {
    const rows = this.db.prepare(`SELECT j.owner,j.body,c.revision FROM work_claims c
      JOIN jobs j ON j.id=c.job_id WHERE c.expires_at<=?`).all(now);
    for (const row of rows) {
      const job = JSON.parse(String(row.body)) as Job;
      if (job.service !== 'eigos.delegate' || job.delegation?.backendVersion !== BACKEND_VERSION) continue;
      if ((job.delegation?.plan || job.delegation?.agent) && (job.revision ?? 0) === Number(row.revision)) {
        const owner = String(row.owner); const intents = this.intents(owner, job.id);
        for (const intent of intents) if (intent.state === 'dispatching') { intent.state = 'effect_unknown'; intent.nextAt = now; this.saveIntent(owner, intent); }
        if (job.state === 'working') job.delegation.nextAt = now;
        else if (intents.some(i => ['dispatching', 'awaiting_remote', 'effect_unknown'].includes(i.state))) job.delegation.recoveryPending = true;
        job.updatedAt = new Date(now).toISOString(); this.save(owner, job); continue;
      }
      if (job.state !== 'working' || (job.revision ?? 0) !== Number(row.revision)) continue;
      job.state = 'failed'; job.error = 'Worker lease expired; execution outcome is unknown. Inspect evidence before submitting a new task.';
      job.updatedAt = new Date(now).toISOString(); this.save(String(row.owner), job);
    }
    this.db.prepare('DELETE FROM work_claims WHERE expires_at<=?').run(now);
  }

  claim(services: string[], leaseMs: number, now?: number): WorkClaim | undefined {
    return this.transaction(() => {
      const at = now ?? Date.now();
      this.expireClaims(at);
      if (!services.length) return;
      // Keep the existing two-call budget across all Workers sharing this database.
      if (Number(this.db.prepare('SELECT count(*) AS n FROM work_claims').get()!.n) >= 2) return;
      const row = this.db.prepare(`SELECT owner,body FROM jobs WHERE (state IN ('working','submitted') OR (state IN ('canceled','failed','rejected','completed','auth-required') AND json_extract(body,'$.delegation.recoveryPending')=1))
        AND COALESCE(json_extract(body,'$.executionMode'), 'worker')='worker'
        AND json_extract(body,'$.service') IN (${services.map(() => '?').join(',')})
        AND json_extract(body,'$.service')='eigos.delegate' AND json_extract(body,'$.delegation.backendVersion')=?
        AND COALESCE(json_extract(body,'$.delegation.nextAt'),0)<=?
        AND id NOT IN (SELECT job_id FROM work_claims) ORDER BY created_at,id LIMIT 1`).get(...services, BACKEND_VERSION, at);
      if (!row) return;
      const job = JSON.parse(String(row.body)) as Job;
      if (job.state === 'submitted') { job.state = 'working'; job.updatedAt = new Date(at).toISOString(); this.save(String(row.owner), job); }
      const token = randomUUID();
      this.db.prepare('INSERT INTO work_claims VALUES(?,?,?,?)').run(job.id, token, job.revision ?? 0, at + leaseMs);
      return { owner: String(row.owner), job, token, ...(job.state !== 'working' ? { recovery: true } : {}) };
    });
  }

  renew(claim: WorkClaim, leaseMs: number, now?: number): boolean {
    return this.transaction(() => {
      const at = now ?? Date.now();
      if (!this.active(claim, at)) return false;
      this.db.prepare('UPDATE work_claims SET expires_at=? WHERE job_id=? AND token=?').run(at + leaseMs, claim.job.id, claim.token);
      return true;
    });
  }

  private active(claim: WorkClaim, now: number): boolean {
    const lease = this.db.prepare('SELECT token,expires_at FROM work_claims WHERE job_id=?').get(claim.job.id);
    const current = this.get(claim.owner, claim.job.id);
    return lease?.token === claim.token && Number(lease.expires_at) > now && (claim.recovery ? current.state === claim.job.state && current.delegation?.recoveryPending === true : current.state === 'working')
      && (current.revision ?? 0) === (claim.job.revision ?? 0);
  }
  claimActive(claim: WorkClaim): boolean { return this.active(claim, Date.now()); }

  finish(claim: WorkClaim, update: (job: Job) => void, now?: number): boolean {
    return this.transaction(() => {
      const at = now ?? Date.now();
      if (!this.active(claim, at)) return false;
      const job = this.get(claim.owner, claim.job.id);
      update(job); this.save(claim.owner, job);
      this.db.prepare('DELETE FROM work_claims WHERE job_id=? AND token=?').run(job.id, claim.token);
      return true;
    });
  }

  checkpoint(claim: WorkClaim, update: (job: Job) => void): boolean {
    return this.transaction(() => {
      if (!this.active(claim, Date.now())) return false;
      const job = this.get(claim.owner, claim.job.id);
      update(job); this.save(claim.owner, job); return true;
    });
  }

  release(claim: WorkClaim): void {
    this.db.prepare('DELETE FROM work_claims WHERE job_id=? AND token=?').run(claim.job.id, claim.token);
  }

  get(owner: string, id: string): Job {
    const row = this.db.prepare('SELECT body FROM jobs WHERE owner = ? AND id = ?').get(owner, id);
    if (!row) throw new DomainError('NOT_FOUND', 'Task not found');
    return JSON.parse(String(row.body)) as Job;
  }

  hasContext(owner: string, contextId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM jobs WHERE owner = ? AND context_id = ? LIMIT 1').get(owner, contextId);
  }

  hasRequest(owner: string, operation: string, requestId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM requests WHERE owner=? AND operation=? AND request_id=?').get(owner, operation, requestId);
  }

  save(owner: string, job: Job): void {
    this.db.exec('SAVEPOINT task_and_ontology');
    try {
      synchronizeTaskOutcome(job);
      const saved = this.db.prepare(`INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at, body=excluded.body
      WHERE jobs.owner=excluded.owner`).run(
      job.id, owner, job.contextId, job.state, job.createdAt, job.updatedAt, JSON.stringify(job),
      );
      if (!saved.changes) throw new DomainError('FORBIDDEN', 'Task owner mismatch');
      projectTask(this.ontology, owner, job);
      if (job.delegation?.backendVersion === BACKEND_VERSION && job.delegation.agent) this.recordFeedback(owner, job, job.delegation.outcome?.evidenceLevel ?? 'unverified');
      this.db.exec('RELEASE task_and_ontology');
    } catch (error) { this.db.exec('ROLLBACK TO task_and_ontology; RELEASE task_and_ontology'); throw error; }
  }

  list(owner: string, filter: ListFilter): { jobs: Job[]; total: number } {
    const clauses = ['owner = ?'];
    const args: string[] = [owner];
    if (filter.contextId) { clauses.push('context_id = ?'); args.push(filter.contextId); }
    if (filter.state) { clauses.push('state = ?'); args.push(filter.state); }
    if (filter.updatedAfter) { clauses.push('updated_at >= ?'); args.push(filter.updatedAfter); }
    const where = clauses.join(' AND ');
    const total = Number(this.db.prepare(`SELECT count(*) AS total FROM jobs WHERE ${where}`).get(...args)?.total ?? 0);
    const rows = this.db.prepare(`SELECT body FROM jobs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, filter.limit, filter.offset);
    return { jobs: rows.map(row => JSON.parse(String(row.body)) as Job), total };
  }

  // All mutations are synchronous inside one transaction, including the retry receipt.
  once(owner: string, operation: string, requestId: string, fingerprint: string, action: () => Job): Job {
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT fingerprint, response FROM requests WHERE owner=? AND operation=? AND request_id=?')
        .get(owner, operation, requestId);
      if (previous) {
        if (!equivalentFingerprint(String(previous.fingerprint), fingerprint)) throw new DomainError('CONFLICT', 'Request ID was already used with different input');
        return JSON.parse(String(previous.response)) as Job;
      }
      const result = action();
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)').run(owner, operation, requestId, fingerprint, JSON.stringify(result));
      return result;
    });
  }
}
