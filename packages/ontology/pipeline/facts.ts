import type { DatabaseSync } from 'node:sqlite';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import { assertBusinessTransaction } from '../../core/transaction.js';
import type { ObjectRef } from '../model.js';
import type { OntologyObjectStore } from '../object-store.js';
import type { OntologyReleaseRef } from '../definition-contracts.js';
import type { ObjectSnapshot } from '../planning-contract.js';
import type { PipelineIntake, PipelineObservation } from './contracts.js';
import { mapPipelineObservation } from './mapping.js';

interface FactState {
  sourceKey: string; object: ObjectRef; revision: number; semanticRevision: number; semanticDigest: string;
  properties: Record<string, unknown>; providerVersion?: number; conflicted: boolean;
  intakeDigest: string; mappingId: string; release: OntologyReleaseRef; observedAt: string; expiresAt: string; evidenceRefs: string[];
  sourceId: string; sourceRevision: string; sourceDigest: string; evidenceLevel: string;
}
export interface PipelineFactChange {
  id: string; componentId: string; object: ObjectRef; reason: 'changed' | 'conflicted' | 'stale' | 'restored';
  fields: string[]; semanticRevision: number; at: string;
}
interface Dependency { jobId: string; requestRevision: number; componentId: string; sourceKey: string; fields: string[]; values: Record<string, unknown>; valuesDigest: string }
const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const values = (properties: Record<string, unknown>, fields: string[]) => Object.fromEntries(fields.map(field => [field, properties[field] ?? null]));

/** Source ingestion metadata, not another object store or Guardian scheduler.
 * Canonical facts are committed to the existing graph in the same transaction.
 * Only trusted adapters call apply after verifying a source response. */
export class PipelineFactStore {
  constructor(private readonly db: DatabaseSync, private readonly hooks: {
    active(owner: string, jobId: string, requestRevision: number): boolean;
    changed(owner: string, jobId: string, requestRevision: number, change: PipelineFactChange): void;
  }, readonly now: () => number = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ontology_pipeline_facts (owner TEXT NOT NULL,ontology_id TEXT NOT NULL,source_key TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,ontology_id,source_key),UNIQUE(owner,ontology_id,object_type,object_id));
      CREATE TABLE IF NOT EXISTS ontology_pipeline_samples (owner TEXT NOT NULL,ontology_id TEXT NOT NULL,source_key TEXT NOT NULL,event_id TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,ontology_id,source_key,event_id,digest));
      CREATE TABLE IF NOT EXISTS ontology_pipeline_dependencies (owner TEXT NOT NULL,ontology_id TEXT NOT NULL,source_key TEXT NOT NULL,job_id TEXT NOT NULL,request_revision INTEGER NOT NULL,component_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,ontology_id,source_key,job_id,request_revision,component_id));
      CREATE INDEX IF NOT EXISTS pipeline_dependency_task ON ontology_pipeline_dependencies(owner,job_id,request_revision);
      CREATE TABLE IF NOT EXISTS ontology_pipeline_fact_changes (id TEXT PRIMARY KEY,owner TEXT NOT NULL,job_id TEXT NOT NULL,request_revision INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS pipeline_changes_task ON ontology_pipeline_fact_changes(owner,job_id,request_revision);
    `);
    for (const table of ['ontology_pipeline_samples', 'ontology_pipeline_fact_changes']) for (const operation of ['UPDATE', 'DELETE']) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Source observation history is immutable'); END`);
    }
  }
  current(owner: string, ontologyId: string, ref: ObjectRef): (FactState & { health: 'fresh' | 'stale' | 'conflicted' }) | undefined {
    const row = this.db.prepare('SELECT body FROM ontology_pipeline_facts WHERE owner=? AND ontology_id=? AND object_type=? AND object_id=?').get(owner, ontologyId, ref.type, ref.id);
    if (!row) return;
    const state: FactState = JSON.parse(String(row.body));
    return { ...state, health: state.conflicted ? 'conflicted' : Date.parse(state.expiresAt) <= this.now() ? 'stale' : 'fresh' };
  }
  private save(owner: string, ontologyId: string, state: FactState): void {
    this.db.prepare('INSERT INTO ontology_pipeline_facts VALUES(?,?,?,?,?,?) ON CONFLICT(owner,ontology_id,source_key) DO UPDATE SET body=excluded.body')
      .run(owner, ontologyId, state.sourceKey, state.object.type, state.object.id, JSON.stringify(state));
  }
  private changed(owner: string, ontologyId: string, state: FactState, reason: PipelineFactChange['reason']): void {
    const rows = this.db.prepare(`SELECT d.body FROM ontology_pipeline_dependencies d JOIN jobs j ON j.id=d.job_id AND j.owner=d.owner
      WHERE d.owner=? AND d.ontology_id=? AND d.source_key=? AND j.state IN ('working','submitted','input-required','auth-required','paused')
      AND json_extract(j.body,'$.delegation.request.revision')=d.request_revision LIMIT 1001`).all(owner, ontologyId, state.sourceKey);
    if (rows.length > 1000) fail('Source change fanout exceeds the bounded ingestion limit');
    for (const row of rows) {
      const dependency: Dependency = JSON.parse(String(row.body));
      if (!this.hooks.active(owner, dependency.jobId, dependency.requestRevision)) continue;
      const affected = dependency.fields.filter(field => digest(dependency.values[field] ?? null) !== digest(state.properties[field] ?? null));
      if (reason === 'changed' && (!affected.length || dependency.valuesDigest === digest(values(state.properties, dependency.fields)))) continue;
      const body = { componentId: dependency.componentId, object: state.object, reason, fields: reason === 'changed' ? affected : dependency.fields,
        semanticRevision: state.semanticRevision, at: new Date(this.now()).toISOString() };
      const id = digest({ owner, jobId: dependency.jobId, requestRevision: dependency.requestRevision, ...body, at: undefined, factRevision: state.revision });
      const change = { id, ...body };
      const inserted = this.db.prepare('INSERT OR IGNORE INTO ontology_pipeline_fact_changes VALUES(?,?,?,?,?)').run(id, owner, dependency.jobId, dependency.requestRevision, JSON.stringify(change));
      if (inserted.changes) this.hooks.changed(owner, dependency.jobId, dependency.requestRevision, change);
    }
  }
  apply(owner: string, graph: OntologyObjectStore, intake: PipelineIntake, intakeDigest: string, mappingId: string, raw: PipelineObservation, expectedRevision: number) {
    assertBusinessTransaction(this.db);
    if (!graph.releaseRef || digest(intake) !== intakeDigest) fail('A source update needs an exact published mapping');
    const mapping = intake.mappings.find(value => value.id === mappingId) ?? fail('Unknown published source mapping');
    const mapped = mapPipelineObservation(graph.model, owner, intake, mapping, raw, this.now()), sample = mapped.sample;
    const old = this.current(owner, graph.ontologyId, mapped.ref);
    const contentDigest = digest({ payload: sample.payload, sourceDigest: sample.sourceDigest, sourceRevision: sample.sourceRevision,
      providerVersion: sample.providerVersion, occurredAt: sample.occurredAt });
    const events = this.db.prepare('SELECT digest,body FROM ontology_pipeline_samples WHERE owner=? AND ontology_id=? AND source_key=? AND event_id=?')
      .all(owner, graph.ontologyId, mapped.sourceKey, sample.eventId);
    const repeated = events.find(row => row.digest === contentDigest);
    if (repeated) return { ...JSON.parse(String(repeated.body)).result, duplicate: true };
    const conflict = !!events.length || !!old && (sample.providerVersion !== undefined && old.providerVersion === sample.providerVersion && old.semanticDigest !== mapped.semanticDigest
      || sample.providerVersion === undefined && (!sample.independentRead || old.revision !== expectedRevision));
    const stale = !!old && (old.providerVersion !== undefined && (sample.providerVersion === undefined || sample.providerVersion < old.providerVersion)
      || old.conflicted && sample.providerVersion !== undefined && old.providerVersion !== undefined && sample.providerVersion <= old.providerVersion);
    if (!old && (expectedRevision !== 0 || sample.providerVersion === undefined && !sample.independentRead)) fail('An initial source fact needs native ordering or an independent read');
    let state: FactState, result: { object: ObjectRef; status: 'applied' | 'unchanged' | 'conflicted' | 'stale'; semanticRevision: number };
    if (old && (conflict || stale)) {
      const currentConflict = conflict && !(sample.providerVersion !== undefined && old.providerVersion !== undefined && sample.providerVersion < old.providerVersion);
      state = { ...old, revision: old.revision + 1, conflicted: old.conflicted || currentConflict };
      this.save(owner, graph.ontologyId, state);
      result = { object: old.object, status: currentConflict ? 'conflicted' : 'stale', semanticRevision: old.semanticRevision };
      if (currentConflict) this.changed(owner, graph.ontologyId, state, 'conflicted');
    } else {
      const changed = !old || old.semanticDigest !== mapped.semanticDigest;
      state = { sourceKey: mapped.sourceKey, object: mapped.ref, revision: (old?.revision ?? 0) + 1, semanticRevision: (old?.semanticRevision ?? 0) + (changed ? 1 : 0),
        semanticDigest: mapped.semanticDigest, properties: mapped.properties, providerVersion: sample.providerVersion, conflicted: false,
        intakeDigest, mappingId, release: graph.releaseRef!, observedAt: sample.observedAt, expiresAt: mapped.expiresAt, evidenceRefs: sample.evidenceRefs,
        sourceId: intake.source.id, sourceRevision: sample.sourceRevision, sourceDigest: sample.sourceDigest, evidenceLevel: sample.evidenceLevel };
      let prior;
      try { prior = graph.read(owner, mapped.ref); }
      catch (error) { if (!(error instanceof DomainError && error.code === 'NOT_FOUND')) throw error; }
      // Refreshing provenance without a semantic change must not invalidate an
      // already grounded plan by incrementing its canonical object revision.
      if (!prior || digest(prior.properties) !== digest(mapped.properties)) graph.ingest(owner, { objects: [{ ref: mapped.ref, properties: mapped.properties, ...(prior ? { expectedRevision: prior.revision } : {}) }], links: [] },
        { kind: sample.evidenceLevel === 'synthetic' ? 'synthetic' : 'provider', id: `pipeline:${digest({ intakeDigest, event: sample.eventId })}`, observedAt: sample.observedAt });
      this.save(owner, graph.ontologyId, state);
      result = { object: mapped.ref, status: changed ? 'applied' : 'unchanged', semanticRevision: state.semanticRevision };
      if (old) {
        if (changed) this.changed(owner, graph.ontologyId, state, 'changed');
        else if (old.health !== 'fresh') this.changed(owner, graph.ontologyId, state, 'restored');
      }
    }
    this.db.prepare('INSERT INTO ontology_pipeline_samples VALUES(?,?,?,?,?,?)').run(owner, graph.ontologyId, mapped.sourceKey, sample.eventId, contentDigest,
      JSON.stringify({ result, sample, mappingDigest: intakeDigest, release: graph.releaseRef, receivedAt: sample.receivedAt }));
    return { ...result, duplicate: false };
  }
  track(owner: string, ontologyId: string, jobId: string, requestRevision: number, componentId: string, object: ObjectRef, fields?: string[]): void {
    assertBusinessTransaction(this.db);
    if (!this.hooks.active(owner, jobId, requestRevision)) fail('Fact dependencies require the current active owned task');
    const state = this.current(owner, ontologyId, object); if (!state) return;
    if (state.health !== 'fresh') fail(`Source fact is ${state.health}; independently refresh it before use`);
    const selected = fields ?? Object.keys(state.properties);
    if (!selected.length || selected.length > 50 || selected.some(field => !Object.hasOwn(state.properties, field)) || componentId.length > 240) fail('Fact dependency fields must name bounded current properties');
    const existing = this.db.prepare('SELECT 1 FROM ontology_pipeline_dependencies WHERE owner=? AND job_id=? AND request_revision=? AND source_key=? AND component_id=?').get(owner, jobId, requestRevision, state.sourceKey, componentId);
    if (!existing && Number(this.db.prepare('SELECT count(*) AS n FROM ontology_pipeline_dependencies WHERE owner=? AND job_id=? AND request_revision=?').get(owner, jobId, requestRevision)!.n) >= 100) fail('Task fact dependencies exceed the bounded context limit');
    const body: Dependency = { jobId, requestRevision, componentId, sourceKey: state.sourceKey, fields: [...new Set(selected)].sort(), values: values(state.properties, selected), valuesDigest: digest(values(state.properties, selected)) };
    this.db.prepare('INSERT INTO ontology_pipeline_dependencies VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,ontology_id,source_key,job_id,request_revision,component_id) DO UPDATE SET body=excluded.body')
      .run(owner, ontologyId, state.sourceKey, jobId, requestRevision, componentId, JSON.stringify(body));
  }
  assertFresh(owner: string, ontologyId: string, refs: readonly ObjectRef[]): void {
    for (const ref of refs.filter(ref => ref.id.startsWith('pipeline:'))) {
      const state = this.current(owner, ontologyId, ref);
      if (state && state.health !== 'fresh') fail(`Source fact is ${state.health}; historical evidence cannot authorize current execution`);
    }
  }
  assertSnapshots(owner: string, ontologyId: string, snapshots: readonly ObjectSnapshot[]): void {
    this.assertFresh(owner, ontologyId, snapshots.map(value => value.ref));
    for (const snapshot of snapshots.filter(value => value.ref.id.startsWith('pipeline:'))) {
      const state = this.current(owner, ontologyId, snapshot.ref);
      if (state && state.semanticDigest !== snapshot.propertiesDigest) fail('Source fact changed after planning; refresh the affected inputs before dispatch');
    }
  }
  hasDependencies(owner: string, jobId: string, requestRevision: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM ontology_pipeline_dependencies WHERE owner=? AND job_id=? AND request_revision=? LIMIT 1').get(owner, jobId, requestRevision);
  }
  expireForTask(owner: string, jobId: string, requestRevision: number): void {
    assertBusinessTransaction(this.db);
    for (const row of this.db.prepare('SELECT ontology_id,source_key FROM ontology_pipeline_dependencies WHERE owner=? AND job_id=? AND request_revision=?').all(owner, jobId, requestRevision)) {
      const stateRow = this.db.prepare('SELECT body FROM ontology_pipeline_facts WHERE owner=? AND ontology_id=? AND source_key=?').get(owner, String(row.ontology_id), String(row.source_key));
      if (!stateRow) continue;
      const state: FactState = JSON.parse(String(stateRow.body));
      if (Date.parse(state.expiresAt) <= this.now()) this.changed(owner, String(row.ontology_id), state, 'stale');
    }
  }
  changes(owner: string, jobId: string, requestRevision: number): PipelineFactChange[] {
    // Current dependency notices are bounded; immutable event history remains
    // in the ledger. Each changed notice includes all fields differing from the
    // consumed snapshot, so a later change cannot hide an earlier affected field.
    const rows = this.db.prepare(`SELECT body FROM ontology_pipeline_fact_changes WHERE rowid IN (
      SELECT max(rowid) FROM ontology_pipeline_fact_changes WHERE owner=? AND job_id=? AND request_revision=?
      GROUP BY json_extract(body,'$.componentId'),json_extract(body,'$.object.type'),json_extract(body,'$.object.id')
    ) ORDER BY rowid DESC LIMIT 101`).all(owner, jobId, requestRevision);
    if (rows.length > 100) fail('Task fact changes exceed the bounded context limit');
    return rows.map(row => JSON.parse(String(row.body)));
  }
}
