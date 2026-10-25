import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { digest } from './delegation.js';
import { DomainError } from './domain.js';
import { monitoringSchema, sourceIdentitySchema, sourceSampleSchema, watchPolicySchema,
  type MonitoringContract, type ObservationWatch, type ObservationRead, type SourceIdentity, type SourceSample,
  type SituationChange, type SituationSummary, type WatchSelection, type WatchPolicy, type WatchHealth } from '../ontology/situation.js';

const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const sourceKey = (source: SourceIdentity) => digest(sourceIdentitySchema.parse(source));
const semantic = (sample: SourceSample) => digest(sample.data);
const eventDigest = (sample: SourceSample) => digest({ data: sample.data, providerVersion: sample.providerVersion, occurredAt: sample.occurredAt, effectiveAt: sample.effectiveAt });
const noticeSchema = z.strictObject({ eventId: z.string().min(1).max(500), contentDigest: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(['provider_hint', 'user_asserted']), payloadRef: z.string().min(1).max(1000).optional(), note: z.string().min(1).max(2000).optional() });
interface ContractState { requestRevision: number; contract: MonitoringContract; digest: string; queries: number; activeMs: number; revision: number; revoked: boolean }
interface SourceState { revision: number; sample: SourceSample; conflicted: boolean }
export interface SituationStoreHooks {
  active(owner: string, jobId: string, requestRevision: number): boolean;
  wake(owner: string, jobId: string): void;
}

/** Private inbox and scheduler data share the task database and its transactions.
 * Notices are hints, never facts. Only a bound Worker's validated read can apply a sample. */
export class SituationStore {
  constructor(private db: DatabaseSync, private hooks: SituationStoreHooks, readonly now: () => number = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS observation_contracts (owner TEXT NOT NULL,job_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,job_id));
      CREATE TABLE IF NOT EXISTS observation_watches (owner TEXT NOT NULL,id TEXT NOT NULL,job_id TEXT NOT NULL,source_key TEXT NOT NULL,status TEXT NOT NULL,next_at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,id));
      CREATE INDEX IF NOT EXISTS watches_task ON observation_watches(owner,job_id,status,next_at);
      CREATE INDEX IF NOT EXISTS watches_source ON observation_watches(owner,source_key);
      CREATE TABLE IF NOT EXISTS source_notices (sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,owner TEXT NOT NULL,source_key TEXT NOT NULL,event_id TEXT NOT NULL,content_digest TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(owner,source_key,event_id,content_digest));
      CREATE TABLE IF NOT EXISTS source_states (owner TEXT NOT NULL,source_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,source_key));
      CREATE TABLE IF NOT EXISTS source_samples (owner TEXT NOT NULL,source_key TEXT NOT NULL,event_id TEXT NOT NULL,semantic_digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,source_key,event_id,semantic_digest));
      CREATE TABLE IF NOT EXISTS observation_reads (id TEXT PRIMARY KEY,owner TEXT NOT NULL,job_id TEXT NOT NULL,watch_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS situation_changes (owner TEXT NOT NULL,job_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,job_id,revision));
    `);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('SAVEPOINT situation_update');
    try { const result = fn(); this.db.exec('RELEASE situation_update'); return result; }
    catch (error) { this.db.exec('ROLLBACK TO situation_update; RELEASE situation_update'); throw error; }
  }
  private contract(owner: string, jobId: string): ContractState | undefined {
    const row = this.db.prepare('SELECT body FROM observation_contracts WHERE owner=? AND job_id=?').get(owner, jobId);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  private saveContract(owner: string, jobId: string, state: ContractState): void {
    this.db.prepare('INSERT INTO observation_contracts VALUES(?,?,?) ON CONFLICT(owner,job_id) DO UPDATE SET body=excluded.body').run(owner, jobId, JSON.stringify(state));
  }
  establish(owner: string, jobId: string, requestRevision: number, raw: MonitoringContract): void {
    this.transaction(() => {
      const contract = monitoringSchema.parse(raw), end = Date.parse(contract.until);
      if (end <= this.now() || end > this.now() + 30 * 86400000) fail('Monitoring needs a future horizon of at most 30 days');
      const previous = this.contract(owner, jobId);
      if (previous?.requestRevision === requestRevision) {
        if (previous.digest !== digest(contract) || previous.revoked) fail('Monitoring contract changed or was revoked');
        return;
      }
      if (previous) {
        this.stop(owner, jobId, 'revoked', 'Request revision changed');
        for (const watch of this.watches(owner, jobId)) { watch.superseded = true; this.save(watch); }
      }
      this.saveContract(owner, jobId, { requestRevision, contract, digest: digest(contract), queries: previous?.queries ?? 0, activeMs: previous?.activeMs ?? 0, revision: (previous?.revision ?? 0) + 1, revoked: false });
    });
  }
  watch(owner: string, id: string): ObservationWatch {
    const row = this.db.prepare('SELECT body FROM observation_watches WHERE owner=? AND id=?').get(owner, id);
    if (!row) throw new DomainError('NOT_FOUND', 'Observation watch not found');
    return JSON.parse(String(row.body));
  }
  readAttempt(owner: string, id: string): ObservationRead & { status: string } {
    const row = this.db.prepare('SELECT body FROM observation_reads WHERE owner=? AND id=?').get(owner, id);
    if (!row) throw new DomainError('NOT_FOUND', 'Owned observation attempt not found');
    return JSON.parse(String(row.body));
  }
  wakeRead(owner: string, id: string): void {
    this.transaction(() => { const watch = this.watch(owner, id); if (watch.status !== 'active' || watch.superseded) return; watch.nextAt = this.now(); this.save(watch); this.hooks.wake(owner, watch.jobId); });
  }
  watches(owner: string, jobId: string): ObservationWatch[] {
    return this.db.prepare('SELECT body FROM observation_watches WHERE owner=? AND job_id=? ORDER BY id').all(owner, jobId).map(row => JSON.parse(String(row.body)) as ObservationWatch);
  }
  private save(watch: ObservationWatch): void {
    this.db.prepare('INSERT INTO observation_watches VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET status=excluded.status,next_at=excluded.next_at,body=excluded.body')
      .run(watch.owner, watch.id, watch.jobId, sourceKey(watch.selection.source), watch.status, watch.nextAt, JSON.stringify(watch));
  }
  private source(owner: string, key: string): SourceState | undefined {
    const row = this.db.prepare('SELECT body FROM source_states WHERE owner=? AND source_key=?').get(owner, key);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  private sequence(owner: string, key: string): number {
    return Number(this.db.prepare('SELECT max(sequence) AS n FROM source_notices WHERE owner=? AND source_key=?').get(owner, key)?.n ?? 0);
  }
  private changed(watch: ObservationWatch, reason: SituationChange['reason'], fields = watch.selection.fields, sample?: SourceSample): void {
    const state = this.contract(watch.owner, watch.jobId)!;
    state.revision++;
    const change: SituationChange = { revision: state.revision, at: new Date(this.now()).toISOString(), watchId: watch.id, componentId: watch.selection.componentId,
      reason, fields, evidenceRefs: sample?.evidenceRefs ?? [], ...(sample ? { object: sample.object } : {}) };
    this.saveContract(watch.owner, watch.jobId, state);
    this.db.prepare('INSERT INTO situation_changes VALUES(?,?,?,?)').run(watch.owner, watch.jobId, change.revision, JSON.stringify(change));
    if (this.hooks.active(watch.owner, watch.jobId, watch.requestRevision)) this.hooks.wake(watch.owner, watch.jobId);
  }
  start(owner: string, jobId: string, requestRevision: number, selection: WatchSelection, rawPolicy: WatchPolicy, initial: SourceSample): ObservationWatch {
    return this.transaction(() => {
      const state = this.contract(owner, jobId) ?? fail('An explicit monitoring contract is required');
      if (state.revoked || state.requestRevision !== requestRevision || Date.parse(state.contract.until) <= this.now() || !this.hooks.active(owner, jobId, requestRevision)) fail('Monitoring authority is no longer active');
      const policy = watchPolicySchema.parse(rawPolicy), sample = this.checkedSample(initial, selection.source);
      if (!selection.fields.length || selection.fields.length > 40 || new Set(selection.fields).size !== selection.fields.length || selection.fields.some(field => !Object.hasOwn(sample.data, field))) fail('Watch fields must be explicitly mapped source fields');
      if (selection.generation < 1 || !selection.modelRunId || !selection.planId || Buffer.byteLength(JSON.stringify(selection)) > 24000) fail('Invalid model-selected observation binding');
      const id = digest({ owner, jobId, component: selection.componentId, source: selection.source });
      const row = this.db.prepare('SELECT body FROM observation_watches WHERE owner=? AND id=?').get(owner, id);
      const old: ObservationWatch | undefined = row ? JSON.parse(String(row.body)) : undefined;
      if (!old && this.watches(owner, jobId).filter(watch => !watch.superseded && ['active', 'paused'].includes(watch.status)).length >= 16) fail('The bounded task observation limit is 16 source bindings');
      if (old?.status === 'revoked' && old.requestRevision === requestRevision) fail('A revoked watch cannot be silently restarted');
      const watch: ObservationWatch = { id, owner, jobId, requestRevision, contract: state.contract, contractDigest: state.digest, selection: structuredClone(selection), policy,
        revision: (old?.revision ?? 0) + 1, status: 'active', health: 'fresh', createdAt: old?.createdAt ?? new Date(this.now()).toISOString(),
        nextAt: Math.min(this.now() + policy.intervalMs, Date.parse(state.contract.until), Date.parse(this.validUntil(sample, policy))), queries: old?.queries ?? 0, failedReads: 0,
        lastObservedAt: sample.observedAt, validUntil: this.validUntil(sample, policy), sample, semanticRevision: old?.semanticRevision ?? 1,
        lastNoticeSequence: this.sequence(owner, sourceKey(selection.source)) };
      this.save(watch);
      // Starting a watch does not promote an older observation over current facts.
      const current = this.source(owner, sourceKey(selection.source));
      if (!current) {
        this.db.prepare('INSERT INTO source_states VALUES(?,?,?)').run(owner, sourceKey(selection.source), JSON.stringify({ revision: 1, sample, conflicted: false } satisfies SourceState));
        this.db.prepare('INSERT OR IGNORE INTO source_samples VALUES(?,?,?,?,?)').run(owner, sourceKey(selection.source), sample.eventId, eventDigest(sample), JSON.stringify(sample));
      }
      else if (semantic(current.sample) !== semantic(sample) || current.conflicted) {
        // A new generation can have a newer independent observation than this
        // shared cache. Re-read under a source fence before choosing either
        // value; do not invalidate its already verified result merely because
        // the previous generation left an older cache entry.
        watch.health = 'stale'; watch.nextAt = this.now(); this.save(watch);
      }
      return watch;
    });
  }
  private checkedSample(raw: SourceSample, identity: SourceIdentity): SourceSample {
    const sample = sourceSampleSchema.parse(raw);
    if (digest(sample.source) !== digest(identity) || sample.evidenceLevel === 'user_asserted') fail('A source read must match its owned binding and cannot promote a user statement');
    if (!sample.authoritativeRead || Date.parse(sample.observedAt) > this.now() || Date.parse(sample.expiresAt) <= this.now() || Date.parse(sample.expiresAt) <= Date.parse(sample.observedAt)) fail('Observation lacks a current independent source read');
    const data = JSON.stringify(sample.data);
    if (Buffer.byteLength(data) > 24000 || JSON.stringify(JSON.parse(data)) !== data) fail('Source data exceeds the bounded JSON contract');
    return sample;
  }
  private validUntil(sample: SourceSample, policy: WatchPolicy): string {
    return new Date(Math.min(Date.parse(sample.expiresAt), Date.parse(sample.observedAt) + policy.maxAgeMs)).toISOString();
  }
  /** Called by an authenticated source adapter or an authenticated PA. No fact is accepted here. */
  receive(owner: string, identity: SourceIdentity, raw: z.infer<typeof noticeSchema>): { id: string; duplicate: boolean; conflict: boolean } {
    return this.transaction(() => {
      const notice = noticeSchema.parse(raw), key = sourceKey(identity);
      const watches = this.db.prepare('SELECT body FROM observation_watches WHERE owner=? AND source_key=?').all(owner, key).map(row => JSON.parse(String(row.body)) as ObservationWatch);
      if (!watches.length) throw new DomainError('NOT_FOUND', 'No owned observation binding for this source');
      const previous = this.db.prepare('SELECT id,content_digest FROM source_notices WHERE owner=? AND source_key=? AND event_id=?').all(owner, key, notice.eventId);
      const duplicate = previous.find(row => row.content_digest === notice.contentDigest);
      if (duplicate) return { id: String(duplicate.id), duplicate: true, conflict: previous.length > 1 };
      const id = randomUUID(), conflict = previous.length > 0;
      this.db.prepare('INSERT INTO source_notices(id,owner,source_key,event_id,content_digest,body) VALUES(?,?,?,?,?,?)').run(id, owner, key, notice.eventId, notice.contentDigest,
        JSON.stringify({ ...notice, id, receivedAt: new Date(this.now()).toISOString(), conflict }));
      for (const watch of watches) if (watch.status === 'active' && this.hooks.active(owner, watch.jobId, watch.requestRevision)) {
        watch.nextAt = this.now(); this.save(watch); this.hooks.wake(owner, watch.jobId);
      }
      return { id, duplicate: false, conflict };
    });
  }
  pending(owner: string, jobId: string): boolean {
    return this.watches(owner, jobId).some(watch => watch.status === 'active' && this.sequence(owner, sourceKey(watch.selection.source)) > watch.lastNoticeSequence);
  }
  expire(owner: string, jobId: string): void {
    this.transaction(() => {
      for (const watch of this.watches(owner, jobId)) if (watch.status === 'active' && watch.health === 'fresh' && watch.validUntil && Date.parse(watch.validUntil) <= this.now()) {
        watch.health = 'stale'; watch.reason = 'The selected source observation expired'; watch.nextAt = this.now(); this.save(watch); this.changed(watch, 'stale');
      }
    });
  }
  due(owner: string, jobId: string): ObservationWatch[] {
    return this.watches(owner, jobId).filter(watch => watch.status === 'active' && watch.nextAt <= this.now()).sort((a, b) => a.nextAt - b.nextAt || a.id.localeCompare(b.id));
  }
  beginRead(owner: string, id: string, claimToken: string): ObservationRead {
    return this.transaction(() => {
      const watch = this.watch(owner, id), contract = this.contract(owner, watch.jobId)!;
      if (watch.status !== 'active' || contract.revoked || !this.hooks.active(owner, watch.jobId, watch.requestRevision)) fail('Observation authority ended before source dispatch');
      if (Date.parse(watch.contract.until) + 1_800_000 < this.now()) fail('Final observation grace period ended');
      if (watch.pendingRead) return watch.pendingRead;
      if (contract.queries >= contract.contract.maxQueries) fail('Cumulative observation query budget exhausted');
      contract.queries++; watch.queries++; this.saveContract(owner, watch.jobId, contract); this.save(watch);
      const read: ObservationRead = { id: randomUUID(), owner, jobId: watch.jobId, watchId: id, watchRevision: watch.revision,
        sourceRevision: this.source(owner, sourceKey(watch.selection.source))?.revision ?? 0,
        noticeSequence: this.sequence(owner, sourceKey(watch.selection.source)), startedAt: new Date(this.now()).toISOString(), claimToken };
      this.db.prepare('INSERT INTO observation_reads VALUES(?,?,?,?,?)').run(read.id, owner, watch.jobId, id, JSON.stringify({ ...read, status: 'started' }));
      return read;
    });
  }
  deferRead(read: ObservationRead, retryAfterMs: number, operatorRequired = false, paRequired = false): void {
    this.transaction(() => {
      const watch = this.watch(read.owner, read.watchId);
      this.saveRead(read, 'pending');
      if (watch.status !== 'active' || watch.revision !== read.watchRevision) return;
      // Waiting for a factual PA answer does not itself contradict still-fresh
      // facts. Expose the waiting health without causing needless replanning.
      const changed = operatorRequired && watch.health !== 'operator_required';
      watch.pendingRead = read; watch.nextAt = this.now() + Math.max(100, Math.min(60_000, retryAfterMs));
      if (operatorRequired) { watch.health = 'operator_required'; watch.reason = 'The configured source needs an online browser operator'; }
      if (paRequired) { watch.health = 'pa_required'; watch.reason = 'Waiting for the requesting PA to answer a factual question; no connection or action authority is requested'; }
      this.save(watch); if (changed) this.changed(watch, 'unavailable');
    });
  }
  private saveRead(read: ObservationRead, status: string, detail?: unknown): void {
    const row = this.db.prepare('SELECT body FROM observation_reads WHERE owner=? AND id=? AND watch_id=?').get(read.owner, read.id, read.watchId) ?? fail('Observation has no owned read attempt');
    const old = JSON.parse(String(row.body));
    if (old.claimToken !== read.claimToken || old.startedAt !== read.startedAt) fail('Observation read identity changed');
    this.db.prepare('UPDATE observation_reads SET body=? WHERE owner=? AND id=?').run(JSON.stringify({ ...read, status, finishedAt: new Date(this.now()).toISOString(), detail }), read.owner, read.id);
  }
  recordLateRead(read: ObservationRead, detail: { resultDigest?: string; evidenceRefs?: string[]; sample?: SourceSample; reason?: string }): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT body FROM observation_reads WHERE owner=? AND id=?').get(read.owner, read.id);
      if (row && ['applied', 'conflicted', 'stale', 'late', 'superseded'].includes(JSON.parse(String(row.body)).status)) return;
      this.saveRead(read, 'late', detail);
    });
  }
  finishRead(read: ObservationRead, raw: SourceSample, active: () => boolean, project: () => void = () => {}): { applied: boolean; changed: boolean; conflicted?: boolean } {
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT body FROM observation_reads WHERE owner=? AND id=?').get(read.owner, read.id);
      const status = previous ? JSON.parse(String(previous.body)).status : undefined;
      const watch = this.watch(read.owner, read.watchId);
      const recoveringPendingRead = status === 'late' && watch.pendingRead?.id === read.id && watch.revision === read.watchRevision && watch.status === 'active' && active();
      if (['applied', 'conflicted', 'stale', 'late', 'superseded', 'failed', 'revoked'].includes(status) && !recoveringPendingRead) return { applied: false, changed: false };
      const sample = this.checkedSample(raw, watch.selection.source), key = sourceKey(sample.source);
      delete watch.pendingRead;
      this.saveRead(read, 'received', sample);
      if (!active() || watch.revision !== read.watchRevision || watch.status !== 'active' || !this.hooks.active(watch.owner, watch.jobId, watch.requestRevision) || this.contract(watch.owner, watch.jobId)!.revoked) { this.saveRead(read, 'late', sample); return { applied: false, changed: false }; }
      // A notice arriving during the read requires another current read. Never
      // acknowledge it using a response which started before that notice.
      if (read.noticeSequence !== this.sequence(watch.owner, key)) { watch.nextAt = this.now(); this.save(watch); this.saveRead(read, 'superseded', sample); return { applied: false, changed: false }; }
      const old = this.source(watch.owner, key), hash = semantic(sample);
      const duplicates = this.db.prepare('SELECT semantic_digest FROM source_samples WHERE owner=? AND source_key=? AND event_id=?').all(watch.owner, key, sample.eventId);
      const versionConflict = old?.sample.providerVersion !== undefined && sample.providerVersion === old.sample.providerVersion && semantic(old.sample) !== hash;
      const payloadHash = eventDigest(sample), eventConflict = duplicates.some(row => row.semantic_digest !== payloadHash);
      this.db.prepare('INSERT OR IGNORE INTO source_samples VALUES(?,?,?,?,?)').run(watch.owner, key, sample.eventId, payloadHash, JSON.stringify(sample));
      if (versionConflict || eventConflict) {
        if (old) this.db.prepare('UPDATE source_states SET body=? WHERE owner=? AND source_key=?').run(JSON.stringify({ ...old, conflicted: true }), watch.owner, key);
        if (watch.health !== 'conflicted') { watch.health = 'conflicted'; this.changed(watch, 'conflicted', watch.selection.fields, sample); }
        watch.reason = 'Conflicting evidence for the same source event or version'; watch.lastNoticeSequence = read.noticeSequence;
        watch.nextAt = this.now() + watch.policy.intervalMs; this.save(watch); this.saveRead(read, 'conflicted', sample);
        return { applied: false, changed: false, conflicted: true };
      }
      const stale = old?.sample.providerVersion !== undefined && (sample.providerVersion === undefined || sample.providerVersion < old.sample.providerVersion)
        || sample.providerVersion === undefined && old && old.revision !== read.sourceRevision;
      if (stale || old?.conflicted && sample.providerVersion !== undefined && sample.providerVersion <= (old.sample.providerVersion ?? -1)) {
        watch.nextAt = this.now() + watch.policy.intervalMs; this.save(watch); this.saveRead(read, 'stale', sample); return { applied: false, changed: false };
      }
      const fields = [...new Set([...Object.keys(watch.sample?.data ?? {}), ...Object.keys(sample.data)])].filter(field => digest(watch.sample?.data[field] ?? null) !== digest(sample.data[field] ?? null));
      const relevant = fields.filter(field => watch.selection.fields.includes(field));
      const changed = relevant.length > 0, restored = watch.health !== 'fresh' && (watch.health !== 'pa_required' || !watch.validUntil || Date.parse(watch.validUntil) <= this.now());
      // The bound program projection and the source/watch update share this
      // savepoint and the caller's task claim transaction.
      project();
      const next: SourceState = { revision: (old?.revision ?? 0) + (!old || semantic(old.sample) !== hash ? 1 : 0), sample, conflicted: false };
      this.db.prepare('INSERT INTO source_states VALUES(?,?,?) ON CONFLICT(owner,source_key) DO UPDATE SET body=excluded.body').run(watch.owner, key, JSON.stringify(next));
      watch.sample = sample; watch.semanticRevision = next.revision; watch.lastObservedAt = sample.observedAt; watch.validUntil = this.validUntil(sample, watch.policy);
      watch.health = 'fresh'; delete watch.reason; watch.failedReads = 0; watch.lastNoticeSequence = read.noticeSequence;
      watch.nextAt = Math.min(this.now() + watch.policy.intervalMs, Date.parse(watch.validUntil), Date.parse(watch.contract.until));
      if (Date.parse(read.startedAt) >= Date.parse(watch.contract.until)) watch.status = 'ended';
      this.save(watch); this.saveRead(read, 'applied', { sample, changed });
      if (changed || restored) this.changed(watch, changed ? 'changed' : 'restored', changed ? relevant : watch.selection.fields, sample);
      // Other tasks on the same owned source must independently read/project
      // their binding; waking them never copies a private task observation.
      if (!old || semantic(old.sample) !== hash) for (const row of this.db.prepare("SELECT body FROM observation_watches WHERE owner=? AND source_key=? AND status='active' AND id<>?").all(watch.owner, key, watch.id)) {
        const other = JSON.parse(String(row.body)) as ObservationWatch;
        if (this.hooks.active(other.owner, other.jobId, other.requestRevision)) { other.nextAt = this.now(); this.save(other); this.hooks.wake(other.owner, other.jobId); }
      }
      return { applied: true, changed };
    });
  }
  failRead(read: ObservationRead, reason: string, health: Extract<WatchHealth, 'unavailable' | 'operator_required'> = 'unavailable'): void {
    this.transaction(() => {
      const previous = this.db.prepare('SELECT body FROM observation_reads WHERE owner=? AND id=?').get(read.owner, read.id);
      if (!previous || JSON.parse(String(previous.body)).status !== 'late') this.saveRead(read, 'failed', { reason });
      const watch = this.watch(read.owner, read.watchId);
      if (watch.revision !== read.watchRevision || watch.status !== 'active' || !this.hooks.active(watch.owner, watch.jobId, watch.requestRevision)) return;
      delete watch.pendingRead; watch.failedReads++; const transition = watch.health !== health; watch.health = health; watch.reason = reason.slice(0, 500);
      watch.nextAt = Math.min(this.now() + Math.min(3_600_000, watch.policy.intervalMs * 2 ** Math.min(watch.failedReads, 8)), Math.max(this.now() + 100, Date.parse(watch.contract.until)));
      if (watch.failedReads >= 3) watch.status = 'paused';
      this.save(watch); if (transition) this.changed(watch, 'unavailable');
    });
  }
  pause(owner: string, id: string, reason: string, budget = false): void {
    this.transaction(() => { const watch = this.watch(owner, id); if (watch.status !== 'active') return; watch.status = 'paused'; watch.reason = reason; this.save(watch); this.changed(watch, budget ? 'budget' : 'unavailable'); });
  }
  revoke(owner: string, id: string): void {
    this.transaction(() => {
      const watch = this.watch(owner, id); if (watch.status === 'revoked') return;
      watch.status = 'revoked'; watch.revision++; watch.reason = 'Observation permission revoked by the task owner'; this.save(watch); this.changed(watch, 'revoked');
    });
  }
  resume(owner: string, id: string): void {
    this.transaction(() => {
      const watch = this.watch(owner, id), contract = this.contract(owner, watch.jobId)!;
      if (!['paused', 'revoked'].includes(watch.status) || watch.superseded || contract.revoked || !this.hooks.active(owner, watch.jobId, watch.requestRevision)) fail('Only the current owned paused observation can be resumed');
      if (Date.parse(contract.contract.until) <= this.now() || contract.queries >= contract.contract.maxQueries) fail('The original observation horizon or cumulative budget ended; a new explicit delegation is required');
      if (watch.pendingRead) this.saveRead(watch.pendingRead, 'revoked');
      delete watch.pendingRead; watch.status = 'active'; watch.health = 'stale'; watch.failedReads = 0; watch.revision++; watch.nextAt = this.now();
      watch.reason = 'Explicitly resumed; current source read required'; this.save(watch); this.changed(watch, 'stale');
    });
  }
  stopComponent(owner: string, jobId: string, componentId: string, generation: number): void {
    this.transaction(() => {
      for (const watch of this.watches(owner, jobId)) if (watch.selection.componentId === componentId && watch.selection.generation === generation && watch.status === 'active') {
        watch.status = 'ended'; watch.superseded = true; watch.revision++; watch.reason = 'Component generation superseded; select a current observation binding'; this.save(watch);
      }
    });
  }
  stop(owner: string, jobId: string, status: 'ended' | 'revoked', reason: string): void {
    this.transaction(() => {
      const contract = this.contract(owner, jobId); if (!contract) return;
      if (status === 'revoked') { contract.revoked = true; this.saveContract(owner, jobId, contract); }
      for (const watch of this.watches(owner, jobId)) if (watch.status === 'active' || watch.status === 'paused') {
        watch.status = status; watch.revision++; watch.reason = reason; this.save(watch);
        if (status === 'revoked') this.changed(watch, 'revoked');
      }
    });
  }
  revision(owner: string, jobId: string): number { return this.contract(owner, jobId)?.revision ?? 0; }
  assertCurrent(owner: string, jobId: string, revision: number): void {
    const contract = this.contract(owner, jobId);
    if (contract?.revoked || this.revision(owner, jobId) !== revision || this.pending(owner, jobId)) fail('Source changes require current observation before dispatch or acceptance');
    if (this.watches(owner, jobId).some(w => !w.superseded && w.status !== 'revoked' && (w.health !== 'fresh' || !w.validUntil || Date.parse(w.validUntil) <= this.now()))) fail('A monitored source is unavailable, conflicted or stale');
  }
  recordActiveTime(owner: string, jobId: string, milliseconds: number): void {
    this.transaction(() => { const state = this.contract(owner, jobId); if (!state) return; state.activeMs += Math.max(0, Math.ceil(milliseconds)); this.saveContract(owner, jobId, state); });
  }
  changes(owner: string, jobId: string, since = 0): SituationChange[] {
    return this.db.prepare('SELECT body FROM situation_changes WHERE owner=? AND job_id=? AND revision>? ORDER BY revision LIMIT 128').all(owner, jobId, since).map(row => JSON.parse(String(row.body)) as SituationChange);
  }
  nextAt(owner: string, jobId: string): number | undefined {
    const active = this.watches(owner, jobId).filter(watch => watch.status === 'active');
    return active.length ? Math.min(...active.map(watch => Math.min(watch.nextAt, watch.health === 'fresh' ? Date.parse(watch.validUntil!) : Infinity))) : undefined;
  }
  summary(owner: string, jobId: string): SituationSummary | undefined {
    const contract = this.contract(owner, jobId); if (!contract) return;
    const watches = this.watches(owner, jobId).filter(w => !w.superseded);
    const progress = watches.map(w => ({ id: w.id, componentId: w.selection.componentId, status: w.status, health: w.health === 'fresh' && w.validUntil && Date.parse(w.validUntil) <= this.now() ? 'stale' as const : w.health,
      pendingChange: w.status === 'active' && this.sequence(owner, sourceKey(w.selection.source)) > w.lastNoticeSequence,
      overdue: w.status === 'active' && this.now() > w.nextAt + Math.max(1000, Math.min(w.policy.intervalMs, 60_000)), lastObservedAt: w.lastObservedAt, validUntil: w.validUntil, nextAt: new Date(w.nextAt).toISOString(), reason: w.reason }));
    return { revision: contract.revision, status: contract.revoked || watches.some(w => w.status === 'paused' || w.status === 'revoked') ? 'needs_human' : Date.parse(contract.contract.until) <= this.now() && watches.every(w => w.status !== 'active') ? 'ended' : 'observing',
      effective: !contract.revoked && progress.length > 0 && progress.every(w => w.status === 'active' && w.health === 'fresh' && !w.overdue && !w.pendingChange),
      until: contract.contract.until, queries: contract.queries, maxQueries: contract.contract.maxQueries, activeMs: contract.activeMs,
      watches: progress,
      changes: this.changes(owner, jobId, Math.max(0, contract.revision - 16)) };
  }
}
