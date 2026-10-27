import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError, type Job } from '../../core/domain.js';
import { assertBusinessTransaction, businessTransaction } from '../../core/transaction.js';
import type { ActionIntent } from '../actions.js';
import type { OntologyDocument, OntologyReleaseRef } from '../definition-contracts.js';
import type { OntologyModel } from '../model.js';
import { actionEffects } from '../composition-contract.js';
import { BACKEND_VERSION } from '../execution.js';
import { mapPipelineFields } from './mapping.js';
import { parsePipelineIntake, pipelineMappingDigest, verificationCoversAction, type PipelineIntake, type PipelineStatus, type PipelineVerification, type PipelineValidationScope } from './contracts.js';

const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
type IntakeRef = NonNullable<OntologyDocument['pipeline']>[number];
const instant = z.iso.datetime({ offset: true });

/** Intake and evidence history share the definition registry's transaction.
 * Published references live in the immutable OntologyDocument, not a second
 * active-version pointer. No method here grants authority or installs code. */
export class PipelineStore {
  constructor(private readonly db: DatabaseSync, readonly now: () => number = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ontology_pipeline_intakes (ontology_id TEXT NOT NULL,digest TEXT NOT NULL,service_id TEXT NOT NULL,actor TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(ontology_id,digest));
      CREATE TABLE IF NOT EXISTS ontology_pipeline_verifications (id TEXT PRIMARY KEY,ontology_id TEXT NOT NULL,intake_digest TEXT NOT NULL,owner TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS pipeline_verification_lookup ON ontology_pipeline_verifications(ontology_id,intake_digest,owner);
      CREATE INDEX IF NOT EXISTS pipeline_verification_task ON ontology_pipeline_verifications(owner,json_extract(body,'$.taskId'));
      CREATE TABLE IF NOT EXISTS ontology_pipeline_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,ontology_id TEXT NOT NULL,actor TEXT NOT NULL,service_id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS pipeline_event_lookup ON ontology_pipeline_events(ontology_id,service_id,sequence);
      CREATE TABLE IF NOT EXISTS ontology_pipeline_uses (owner TEXT NOT NULL,job_id TEXT NOT NULL,intent_id TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,job_id,intent_id,digest));
    `);
    for (const table of ['ontology_pipeline_intakes', 'ontology_pipeline_verifications', 'ontology_pipeline_events', 'ontology_pipeline_uses']) {
      for (const operation of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Pipeline history is immutable'); END`);
    }
  }
  private atomic<T>(fn: () => T): T {
    let owned = false;
    try { assertBusinessTransaction(this.db); owned = true; }
    catch (error) { if (!(error instanceof DomainError && error.code === 'CONFLICT')) throw error; }
    return owned ? fn() : businessTransaction(this.db, fn);
  }
  put(ontologyId: string, actor: string, raw: unknown): IntakeRef {
    assertBusinessTransaction(this.db);
    const intake = parsePipelineIntake(raw), hash = digest(intake);
    if (Date.parse(intake.source.observedAt) > this.now()) fail('Source material cannot be observed in the future');
    this.db.prepare('INSERT OR IGNORE INTO ontology_pipeline_intakes VALUES(?,?,?,?,?,?)').run(ontologyId, hash, intake.serviceId, actor, JSON.stringify(intake), new Date(this.now()).toISOString());
    return { serviceId: intake.serviceId, intakeDigest: hash };
  }
  intake(ontologyId: string, ref: IntakeRef): PipelineIntake {
    const row = this.db.prepare('SELECT body FROM ontology_pipeline_intakes WHERE ontology_id=? AND digest=? AND service_id=?').get(ontologyId, ref.intakeDigest, ref.serviceId);
    if (!row) throw new DomainError('NOT_FOUND', 'Published service intake is unavailable');
    const intake = parsePipelineIntake(JSON.parse(String(row.body)));
    if (digest(intake) !== ref.intakeDigest) fail('Service intake digest changed');
    return intake;
  }
  contract(model: OntologyModel, intake: PipelineIntake): string {
    return digest({ actions: intake.actions.map(action => ({ id: action.actionId, definition: model.action(action.actionId) })),
      types: [...new Set([...intake.mappings.map(mapping => mapping.objectType), ...intake.vocabulary.map(term => term.objectType)])].sort().map(type => ({ type, fingerprint: model.fingerprint(type) })) });
  }
  private check(model: OntologyModel, intake: PipelineIntake): string[] {
    const issues: string[] = [];
    try {
      this.contract(model, intake);
      for (const entry of intake.actions) {
        const action = model.action(entry.actionId), effects = actionEffects(action);
        if (digest(action) !== entry.definitionDigest) issues.push(`Action ${entry.actionId} differs from the pinned definition`);
        if (entry.requiredEvidence !== 'definition_only' && action.operation && action.operation.environment !== 'local'
          && (action.operation.environment === 'sandbox') !== (intake.environment === 'sandbox')) issues.push(`Action ${entry.actionId} has a different execution environment`);
        if (entry.requiredEvidence === 'live_readonly' && effects.some(effect => !['read', 'local'].includes(effect))) issues.push(`Read-only evidence cannot enable ${entry.actionId}`);
        if (effects.some(effect => !['read', 'local', 'object_write'].includes(effect)) && entry.requiredEvidence !== 'definition_only' && !entry.readbackActionId) issues.push(`Business action ${entry.actionId} needs an independent readback action`);
        if (entry.readbackActionId && (entry.readbackActionId === entry.actionId || actionEffects(model.action(entry.readbackActionId)).some(effect => effect !== 'read'))) issues.push(`Invalid independent readback for ${entry.actionId}`);
        if (entry.requiredEvidence !== 'definition_only' && entry.readbackActionId && intake.actions.find(action => action.actionId === entry.readbackActionId)?.requiredEvidence === 'definition_only') issues.push(`Readback for ${entry.actionId} must also be eligible for execution`);
      }
      for (const mapping of intake.mappings) {
        const type = model.object(mapping.objectType);
        if (mapping.fields.some(field => field.to[0] === type.primaryKey || !type.properties[field.to[0]!])) issues.push(`Mapping ${mapping.id} targets an unknown field or source identity`);
        const cases = intake.fixtures.filter(fixture => fixture.mappingId === mapping.id);
        if (!cases.length) issues.push(`Mapping ${mapping.id} has no synthetic contract examples`);
        for (const fixture of cases) {
          const mapped = mapPipelineFields(mapping, fixture.input);
          if (digest(mapped) !== digest(fixture.expected)) issues.push(`Mapping ${mapping.id} differs from its expected contract`);
          model.parseProperties(mapping.objectType, { ...mapped, [type.primaryKey]: 'pipeline:contract-test' });
        }
      }
    } catch (error) { issues.push(error instanceof Error ? error.message : 'Invalid pipeline contract'); }
    return issues;
  }
  validate(ontologyId: string, actor: string, ref: IntakeRef, model: OntologyModel, expiresAt: string) {
    return this.atomic(() => {
      const intake = this.intake(ontologyId, ref), issues = this.check(model, intake);
      if (issues.length) return { valid: false as const, issues };
      this.checkExpiry(expiresAt, this.now());
      const verification: PipelineVerification = { id: randomUUID(), intakeDigest: ref.intakeDigest, mappingDigest: pipelineMappingDigest(intake), contractDigest: this.contract(model, intake),
        kind: 'mapping_test', level: 'synthetic', actionIds: [], evidenceRefs: intake.fixtures.map(fixture => `fixture:${digest(fixture)}`),
        verifiedAt: new Date(this.now()).toISOString(), expiresAt, availabilityProof: false, authorizationProof: false };
      this.saveVerification(ontologyId, actor, verification);
      return { valid: true as const, issues, verification };
    });
  }
  private checkExpiry(expiresAt: string, verifiedAt: number): void {
    instant.parse(expiresAt);
    if (!Number.isFinite(verifiedAt) || verifiedAt > this.now() || Date.parse(expiresAt) <= this.now() || Date.parse(expiresAt) > verifiedAt + 86400000) fail('Verification expiry must be future and within 24 hours of the actual verification');
  }
  private saveVerification(ontologyId: string, owner: string, verification: PipelineVerification): void {
    this.db.prepare('INSERT INTO ontology_pipeline_verifications VALUES(?,?,?,?,?)').run(verification.id, ontologyId, verification.intakeDigest, owner, JSON.stringify(verification));
  }
  /** Only a server-loaded, independently accepted task may supply operation
   * evidence. HTTP/MCP clients provide the task ID, never this evidence body. */
  verifyTask(ontologyId: string, owner: string, ref: IntakeRef, model: OntologyModel, job: Job, intent: (id: string) => ActionIntent, expiresAt: string): PipelineVerification {
    return this.atomic(() => {
      const intake = this.intake(ontologyId, ref), d = job.delegation, state = d?.agent, outcome = d?.outcome;
      const issues = this.check(model, intake); if (issues.length) fail(issues.join('; '));
      if (d?.backendVersion !== BACKEND_VERSION || job.state !== 'completed' || d.acceptance?.accepted !== true || outcome?.status !== 'satisfied' || !outcome.evidenceRefs.length || !state || state.composition || state.components
        || digest(state.programRef) !== digest(intake.programRef) || state.programDigest !== intake.configurationDigest) fail('Verification needs a completed independent task for this exact program and configuration');
      if (intake.environment === 'sandbox' ? d!.request.executionEnvironment !== 'sandbox' : d!.request.executionEnvironment === 'sandbox') fail('Verification task environment does not match the intake');
      const verifiedAt = outcome!.assessedAt;
      if (d!.pipelineValidation && (d!.pipelineValidation.mappingDigest !== pipelineMappingDigest(intake) || d!.pipelineValidation.requestRevision !== d!.request.revision
        || d!.pipelineValidation.ownerDigest !== digest(owner) || Date.parse(verifiedAt) > Date.parse(d!.pipelineValidation.expiresAt))) fail('Validation task belongs to another mapping, revision or time window');
      if (Date.parse(intake.source.observedAt) > Date.parse(verifiedAt)) fail('Execution predates the intake source contract');
      const anchored = this.db.prepare("SELECT 1 FROM ontology_pipeline_verifications WHERE owner=? AND ontology_id=? AND json_extract(body,'$.taskId')=? AND json_extract(body,'$.mappingDigest')<>? LIMIT 1")
        .get(owner, ontologyId, job.id, pipelineMappingDigest(intake));
      if (anchored) fail('This task already verified a different source or mapping; obtain new execution evidence');
      this.checkExpiry(expiresAt, Date.parse(verifiedAt));
      const actionEvidence: NonNullable<PipelineVerification['actionEvidence']> = {};
      for (const entry of intake.actions) {
        const matched = state!.plans.filter(plan => plan.requestRevision === d!.request.revision).flatMap(plan => plan.steps.filter(step => step.action === entry.actionId && step.definitionDigest === entry.definitionDigest).map(step => ({ plan, step }))).at(-1);
        if (!matched) continue;
        const actual = intent(matched.step.intentId), result = actual.lastVerifiedResult;
        if (actual.jobId !== job.id || actual.owner !== owner || actual.state !== 'effect_confirmed' || result?.kind !== 'confirmed' || !result.evidenceRefs.length || actual.planDigest !== matched.plan.digest) continue;
        const source = result.output?.source as { evidenceLevel?: unknown; evidenceKind?: unknown; observedAt?: unknown;
          receipt?: { evidenceKind?: unknown; receivedAt?: unknown; observedAt?: unknown } } | undefined;
        // Accepted programs use either a direct level (participant sources), a
        // direct kind (DiDi), or a receipt kind (Meituan). Conflicting signals
        // are not evidence, and a task-wide live label never fills a gap.
        const levels = [source?.evidenceLevel, source?.evidenceKind, source?.receipt?.evidenceKind]
          .filter(value => value !== undefined).map(value => value === 'fixture' ? 'synthetic' : value === 'provider_mock' ? 'provider_test' : value);
        const level = levels.length ? levels.every(value => value === levels[0]) ? levels[0] : undefined
          : intake.environment === 'sandbox' && outcome!.evidenceLevel === 'synthetic' ? 'synthetic'
          : intake.environment === 'local' && outcome!.evidenceLevel === 'local_test' ? 'local_test' : undefined;
        if (typeof level !== 'string' || !['synthetic', 'local_test', 'live_readonly', 'live_operation', 'live_fulfillment'].includes(level)) continue;
        if (intake.environment === 'live' ? !level.startsWith('live_') : intake.environment === 'sandbox' ? level !== 'synthetic' : !['local_test', 'synthetic'].includes(level)) continue;
        const observations = [source?.receipt?.observedAt, source?.receipt?.receivedAt, source?.observedAt].filter((value): value is string => typeof value === 'string');
        observations.forEach(value => instant.parse(value));
        const observedAt = observations.length ? new Date(Math.min(...observations.map(value => Date.parse(value)))).toISOString() : actual.createdAt;
        instant.parse(observedAt); this.checkExpiry(expiresAt, Date.parse(observedAt));
        actionEvidence[entry.actionId] = { level, evidenceRefs: [...result.evidenceRefs], observedAt };
      }
      const actionIds = Object.keys(actionEvidence);
      if (!actionIds.length) fail('Task contains no verified matching action');
      const level = outcome!.evidenceLevel ?? 'unverified';
      if (!['synthetic', 'local_test', 'live_readonly', 'live_operation', 'live_fulfillment'].includes(level)) fail('Task evidence has no admissible execution validation level');
      if (intake.environment === 'live' ? !level.startsWith('live_') : !['synthetic', 'local_test'].includes(level)) fail('Synthetic and live verification cannot be substituted');
      const verification: PipelineVerification = { id: digest({ ontologyId, owner, intake: ref.intakeDigest, task: job.id, outcome, actionIds, expiresAt }), intakeDigest: ref.intakeDigest,
        mappingDigest: pipelineMappingDigest(intake), contractDigest: this.contract(model, intake), kind: 'task_evidence', level, actionIds, actionEvidence,
        evidenceRefs: [...outcome!.evidenceRefs], taskId: job.id, verifiedAt, expiresAt, availabilityProof: false, authorizationProof: false };
      if (!this.db.prepare('SELECT 1 FROM ontology_pipeline_verifications WHERE id=?').get(verification.id)) this.saveVerification(ontologyId, owner, verification);
      return verification;
    });
  }
  private verifications(ontologyId: string, ref: IntakeRef, kind: PipelineVerification['kind'], owner = ''): PipelineVerification[] {
    // Each evidence kind has its own bound. New owner-scoped task proofs must
    // never evict the definition-level mapping validation from the read set.
    return this.db.prepare(`SELECT body FROM ontology_pipeline_verifications WHERE ontology_id=? AND intake_digest=?
      AND json_extract(body,'$.kind')=? AND (?='mapping_test' OR owner=?) ORDER BY rowid DESC LIMIT 200`).all(ontologyId, ref.intakeDigest, kind, kind, owner).map(row => JSON.parse(String(row.body)));
  }
  private intakeIssues(ontologyId: string, ref: IntakeRef, intake: PipelineIntake, model: OntologyModel): string[] {
    const errors = this.check(model, intake);
    if (!this.sourceMatches(ontologyId, intake)) errors.push('Latest observed source contract differs from this intake');
    const contract = this.contract(model, intake);
    if (!this.verifications(ontologyId, ref, 'mapping_test').some(value => value.contractDigest === contract && Date.parse(value.expiresAt) > this.now() && !this.revoked(ontologyId, intake.serviceId, value.id))) errors.push('Current intake needs a fresh mapping validation');
    return errors;
  }
  validateIntake(ontologyId: string, ref: IntakeRef, model: OntologyModel): { code: string; message: string }[] {
    try {
      return this.intakeIssues(ontologyId, ref, this.intake(ontologyId, ref), model).map(message => ({ code: 'pipeline_validation_required', message: `${ref.serviceId}: ${message}` }));
    } catch (error) { return [{ code: 'pipeline_invalid', message: error instanceof Error ? error.message : 'Invalid intake' }]; }
  }
  validateDocument(document: OntologyDocument, model: OntologyModel): { code: string; message: string }[] {
    const issues: { code: string; message: string }[] = [], keys = new Set<string>(), services = new Set<string>();
    for (const ref of document.pipeline ?? []) {
      try {
        if (services.has(ref.serviceId)) fail('Duplicate service intake'); services.add(ref.serviceId);
        const intake = this.intake(document.id, ref), errors = this.intakeIssues(document.id, ref, intake, model);
        for (const action of intake.actions) {
          const key = digest({ program: intake.programRef, configuration: intake.configurationDigest, action: action.actionId });
          if (keys.has(key)) errors.push('Two intakes claim the same exact executable binding'); keys.add(key);
        }
        issues.push(...errors.map(message => ({ code: 'pipeline_validation_required', message: `${ref.serviceId}: ${message}` })));
      } catch (error) { issues.push({ code: 'pipeline_invalid', message: error instanceof Error ? error.message : 'Invalid intake' }); }
    }
    return issues;
  }
  event(ontologyId: string, actor: string, serviceId: string, change: { kind: 'source_changed'; sourceDigest: string } | { kind: 'verification_revoked'; verificationId: string }) {
    return this.atomic(() => {
      const body = { ...change, at: new Date(this.now()).toISOString() };
      if (change.kind === 'verification_revoked') {
        const row = this.db.prepare('SELECT intake_digest FROM ontology_pipeline_verifications WHERE ontology_id=? AND id=?').get(ontologyId, change.verificationId);
        if (!row) throw new DomainError('NOT_FOUND', 'Verification is not available');
        this.intake(ontologyId, { serviceId, intakeDigest: String(row.intake_digest) });
      } else z.string().regex(/^[a-f0-9]{64}$/).parse(change.sourceDigest);
      this.db.prepare('INSERT INTO ontology_pipeline_events(ontology_id,actor,service_id,kind,body) VALUES(?,?,?,?,?)').run(ontologyId, actor, serviceId, change.kind, JSON.stringify(body));
      return body;
    });
  }
  private revoked(ontologyId: string, serviceId: string, verificationId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM ontology_pipeline_events WHERE ontology_id=? AND service_id=? AND kind='verification_revoked' AND json_extract(body,'$.verificationId')=?").get(ontologyId, serviceId, verificationId);
  }
  private sourceMatches(ontologyId: string, intake: PipelineIntake): boolean {
    const source = this.db.prepare("SELECT body FROM ontology_pipeline_events WHERE ontology_id=? AND service_id=? AND kind='source_changed' ORDER BY sequence DESC LIMIT 1").get(ontologyId, intake.serviceId);
    return !source || JSON.parse(String(source.body)).sourceDigest === intake.source.digest;
  }
  status(owner: string, document: OntologyDocument, model: OntologyModel, programRef: { id: string; version: string }, configurationDigest: string, actionId: string): PipelineStatus {
    const base = { authorization: 'per_action_required' as const, availabilityProof: false as const, verificationIds: [] as string[] };
    const candidates = (document.pipeline ?? []).map(ref => ({ ref, intake: this.intake(document.id, ref) })).filter(({ intake }) => intake.programRef.id === programRef.id && intake.actions.some(action => action.actionId === actionId));
    if (!candidates.length) return { ...base, status: 'unmanaged', reason: 'This historical/configured binding has not entered the intake pipeline' };
    const selected = candidates.find(({ intake }) => digest(intake.programRef) === digest(programRef) && intake.configurationDigest === configurationDigest);
    if (!selected) return { ...base, status: 'contract_changed', reason: 'Program or connection configuration needs a matching validated intake' };
    const { ref, intake } = selected, detail = { ...base, serviceId: ref.serviceId, intakeDigest: ref.intakeDigest, mappingDigest: pipelineMappingDigest(intake), conditions: intake.conditions,
      terms: [...new Set(intake.vocabulary.flatMap(value => [value.term, ...value.aliases]))].slice(0, 50) };
    const entry = intake.actions.find(action => action.actionId === actionId)!;
    if (entry.requiredEvidence === 'definition_only') return { ...detail, status: 'definition_only', reason: 'This claim is published for modeling only' };
    if (!this.sourceMatches(document.id, intake)) return { ...detail, status: 'source_changed', reason: 'Source contract changed; revalidate and publish its new mapping' };
    let contract: string;
    try { contract = this.contract(model, intake); if (digest(model.action(actionId)) !== entry.definitionDigest) fail('Changed definition'); }
    catch { return { ...detail, status: 'contract_changed', reason: 'Published action or mapped object contract changed' }; }
    const all = [...this.verifications(document.id, ref, 'mapping_test'), ...this.verifications(document.id, ref, 'task_evidence', owner)].filter(value => value.contractDigest === contract),
      fresh = all.filter(value => Date.parse(value.expiresAt) > this.now() && !this.revoked(document.id, intake.serviceId, value.id));
    const structure = fresh.find(value => value.kind === 'mapping_test');
    const proof = fresh.find(value => verificationCoversAction(entry, intake.actions, value));
    if (structure && proof) return { ...detail, status: 'verified', verificationIds: [structure.id, proof.id], reason: 'Exact contract and owner-scoped execution evidence match; current availability and authorization still require checks' };
    const revoked = all.some(value => this.revoked(document.id, intake.serviceId, value.id));
    return { ...detail, status: revoked ? 'revoked' : all.some(value => Date.parse(value.expiresAt) <= this.now()) ? 'expired' : 'verification_required', reason: 'Fresh mapping and matching action/readback evidence are required for this owner' };
  }
  validationStatus(owner: string, document: OntologyDocument, model: OntologyModel, scope: PipelineValidationScope, programRef: { id: string; version: string }, configurationDigest: string, actionId: string): PipelineStatus {
    const closed: PipelineStatus = { status: 'definition_only', reason: 'This action is outside the bounded operator validation task', verificationIds: [], authorization: 'per_action_required', availabilityProof: false };
    if (scope.ownerDigest !== digest(owner) || Date.parse(scope.expiresAt) <= this.now()) return closed;
    const ref = document.pipeline?.find(ref => ref.serviceId === scope.serviceId && ref.intakeDigest === scope.intakeDigest);
    if (!ref) return closed;
    const intake = this.intake(document.id, ref);
    if (pipelineMappingDigest(intake) !== scope.mappingDigest || !this.sourceMatches(document.id, intake)) return closed;
    // Goal bookkeeping is local host work, not a provider validation exception.
    if ((programRef.id === 'eigos.goal' || programRef.id.startsWith('services.compose.')) && actionEffects(model.action(actionId)).every(effect => effect === 'local')) return { ...closed, status: 'unmanaged', reason: 'Local goal bookkeeping' };
    if (digest(programRef) !== digest(intake.programRef) || configurationDigest !== intake.configurationDigest
      || !intake.actions.some(action => action.actionId === actionId && action.definitionDigest === digest(model.action(actionId)))) return closed;
    const contract = this.contract(model, intake), structural = this.verifications(document.id, ref, 'mapping_test').find(value => value.kind === 'mapping_test'
      && value.contractDigest === contract && Date.parse(value.expiresAt) > this.now() && !this.revoked(document.id, intake.serviceId, value.id));
    if (!structural) return closed;
    return { ...closed, status: 'validation_only', serviceId: ref.serviceId, intakeDigest: ref.intakeDigest, mappingDigest: scope.mappingDigest,
      conditions: intake.conditions, verificationIds: [structural.id], reason: 'Operator-scoped validation only; the normal source, goal and exact effect grants remain required' };
  }
  recordUse(owner: string, jobId: string, intentId: string, release: OntologyReleaseRef, status: PipelineStatus): void {
    assertBusinessTransaction(this.db);
    if (status.status === 'unmanaged') return;
    if (!['verified', 'validation_only'].includes(status.status)) fail(status.reason);
    const body = { release, ...status, at: new Date(this.now()).toISOString() }, key = digest({ release, ...status });
    this.db.prepare('INSERT OR IGNORE INTO ontology_pipeline_uses VALUES(?,?,?,?,?)').run(owner, jobId, intentId, key, JSON.stringify(body));
  }
  uses(owner: string, jobId: string) {
    return this.db.prepare('SELECT intent_id,body FROM ontology_pipeline_uses WHERE owner=? AND job_id=? ORDER BY rowid LIMIT 100').all(owner, jobId).map(row => ({ intentId: String(row.intent_id), ...JSON.parse(String(row.body)) }));
  }
}
