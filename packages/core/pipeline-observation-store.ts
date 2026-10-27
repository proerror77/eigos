import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from './domain.js';
import { digest } from './delegation.js';
import { assertBusinessTransaction } from './transaction.js';
import { observationBudgetSchema, type ObservationBudget, type ObservationContractState, type ObservationRead, type PipelineWatch, type ObservationSummary } from '../ontology/pipeline/observation.js';

const conflict = (message: string): never => { throw new DomainError('CONFLICT', message); };
/** Scheduling metadata only. Source values remain in PipelineFactStore and the
 * canonical ontology. Every mutation belongs to the existing task transaction. */
export class PipelineObservationStore {
  constructor(private readonly db: DatabaseSync, readonly now: () => number = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_observation_contracts (owner TEXT NOT NULL,task_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,task_id));
      CREATE TABLE IF NOT EXISTS pipeline_observation_watches (owner TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL,status TEXT NOT NULL,next_at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,id));
      CREATE INDEX IF NOT EXISTS pipeline_watch_due ON pipeline_observation_watches(owner,task_id,status,next_at);
      CREATE TABLE IF NOT EXISTS pipeline_observation_reads (id TEXT PRIMARY KEY,owner TEXT NOT NULL,task_id TEXT NOT NULL,watch_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pipeline_observation_receipts (id TEXT PRIMARY KEY,owner TEXT NOT NULL,task_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pipeline_observation_hints (owner TEXT NOT NULL,watch_id TEXT NOT NULL,event_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(owner,watch_id,event_id,digest));
    `);
    for (const operation of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS observation_receipt_immutable_${operation.toLowerCase()} BEFORE ${operation} ON pipeline_observation_receipts BEGIN SELECT RAISE(ABORT,'Observation receipts are immutable'); END`);
  }
  contract(owner: string, taskId: string): ObservationContractState | undefined {
    const row = this.db.prepare('SELECT body FROM pipeline_observation_contracts WHERE owner=? AND task_id=?').get(owner, taskId);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  private saveContract(owner: string, taskId: string, value: ObservationContractState): void {
    this.db.prepare('INSERT INTO pipeline_observation_contracts VALUES(?,?,?) ON CONFLICT(owner,task_id) DO UPDATE SET body=excluded.body').run(owner, taskId, JSON.stringify(value));
  }
  establish(owner: string, taskId: string, requestRevision: number, raw: ObservationBudget): void {
    assertBusinessTransaction(this.db);
    const budget = observationBudgetSchema.parse(raw), old = this.contract(owner, taskId);
    if (Date.parse(budget.until) <= this.now() || Date.parse(budget.until) > this.now() + 30 * 86400000) conflict('Observation requires a future horizon of at most thirty days');
    if (old) {
      if (old.requestRevision > requestRevision || digest(old.budget) !== digest(budget)) conflict('Observation authority retains its original lifetime budget');
      if (old.stoppedRevision === requestRevision) conflict('The owner stopped observation for this task revision');
      if (old.requestRevision !== requestRevision) {
        this.settle(owner, taskId, requestRevision); old.requestRevision = requestRevision; delete old.stoppedRevision;
        this.saveContract(owner, taskId, old);
      }
      return;
    }
    this.saveContract(owner, taskId, { budget, requestRevision, reads: 0, activeMs: 0, createdAt: new Date(this.now()).toISOString() });
  }
  watches(owner: string, taskId: string): PipelineWatch[] {
    return this.db.prepare('SELECT body FROM pipeline_observation_watches WHERE owner=? AND task_id=? ORDER BY rowid LIMIT 9').all(owner, taskId).map(row => JSON.parse(String(row.body)));
  }
  watch(owner: string, id: string): PipelineWatch {
    const row = this.db.prepare('SELECT body FROM pipeline_observation_watches WHERE owner=? AND id=?').get(owner, id);
    if (!row) throw new DomainError('NOT_FOUND', 'Observation watch is unavailable');
    return JSON.parse(String(row.body));
  }
  private save(watch: PipelineWatch): void {
    this.db.prepare('INSERT INTO pipeline_observation_watches VALUES(?,?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET status=excluded.status,next_at=excluded.next_at,body=excluded.body')
      .run(watch.owner, watch.id, watch.taskId, watch.status, watch.nextAt, JSON.stringify(watch));
  }
  start(value: Omit<PipelineWatch, 'id' | 'revision' | 'status' | 'health' | 'createdAt' | 'nextAt' | 'failedReads' | 'hintSequence' | 'consumedHintSequence'>): PipelineWatch {
    assertBusinessTransaction(this.db);
    const contract = this.contract(value.owner, value.taskId) ?? conflict('The PA has not delegated an observation budget');
    if (contract.requestRevision !== value.requestRevision || Date.parse(contract.budget.until) <= this.now()) conflict('Observation horizon or task revision changed');
    if (contract.stoppedRevision === value.requestRevision) conflict('The owner stopped observation for this task revision');
    const existing = this.watches(value.owner, value.taskId);
    const same = existing.find(watch => watch.status === 'active' && digest(watch.selection.object) === digest(value.selection.object) && watch.action === value.action);
    if (same && same.inputDigest === value.inputDigest && digest([...same.selection.fields].sort()) === digest([...value.selection.fields].sort()) && same.selection.intervalMs === value.selection.intervalMs) return same;
    if (existing.length >= 8) conflict('A task can retain at most eight observation watches');
    if (existing.some(watch => watch.status === 'active' && digest(watch.selection.object) === digest(value.selection.object) && watch.action === value.action)) conflict('This source fact already has an active watch');
    if (contract.reads >= contract.budget.maxReads || contract.activeMs >= contract.budget.maxActiveMs) conflict('The cumulative observation budget is exhausted');
    const watch: PipelineWatch = { ...structuredClone(value), id: randomUUID(), revision: 1, status: 'active', health: 'fresh', createdAt: new Date(this.now()).toISOString(),
      nextAt: Math.min(Math.max(this.now() + 1000, Math.min(this.now() + value.selection.intervalMs, Date.parse(value.validUntil ?? contract.budget.until))), Date.parse(contract.budget.until)), failedReads: 0, hintSequence: 0, consumedHintSequence: 0 };
    this.save(watch); return watch;
  }
  nextAt(owner: string, taskId: string): number | undefined {
    const active = this.watches(owner, taskId).filter(watch => watch.status === 'active');
    return active.length ? Math.min(...active.map(watch => watch.nextAt)) : undefined;
  }
  due(owner: string, taskId: string): PipelineWatch[] {
    return this.watches(owner, taskId).filter(watch => watch.status === 'active' && watch.nextAt <= this.now()).sort((a, b) => a.nextAt - b.nextAt || a.id.localeCompare(b.id));
  }
  sourceChanges(owner: string, taskId: string, changeDigest: string, acknowledged = false): void {
    assertBusinessTransaction(this.db);
    const contract = this.contract(owner, taskId); if (!contract) return;
    if (!acknowledged && contract.sourceChangesDigest === changeDigest) return;
    contract.sourceChangesDigest = changeDigest; contract.sourceChangesPending = !acknowledged;
    this.saveContract(owner, taskId, contract);
    if (!acknowledged) for (const watch of this.watches(owner, taskId)) if (watch.status === 'active') {
      watch.nextAt = Math.min(watch.nextAt, this.now()); this.save(watch);
    }
  }
  begin(owner: string, id: string, sourceRevision: number): ObservationRead {
    assertBusinessTransaction(this.db);
    const watch = this.watch(owner, id), contract = this.contract(owner, watch.taskId)!;
    if (watch.status !== 'active' || contract.requestRevision !== watch.requestRevision || Date.parse(contract.budget.until) <= this.now()) conflict('Observation permission ended');
    if (contract.reads >= contract.budget.maxReads || contract.activeMs >= contract.budget.maxActiveMs) conflict('The cumulative observation budget is exhausted');
    const reservedMs = Math.min(30000, contract.budget.maxActiveMs - contract.activeMs, Date.parse(contract.budget.until) - this.now());
    if (reservedMs < 1) conflict('Observation execution window ended');
    const pending = watch.pending ?? { id: randomUUID(), operationKey: digest({ owner, watch: watch.id, read: randomUUID() }), call: 0 };
    pending.call++; watch.pending = pending; watch.health = 'pending';
    const read: ObservationRead = { id: randomUUID(), operationId: pending.id, operationKey: pending.operationKey, watchId: id, watchRevision: watch.revision, owner, taskId: watch.taskId,
      requestRevision: watch.requestRevision, call: pending.call, sourceRevision, startedAt: new Date(this.now()).toISOString(), reservedMs, hintSequence: watch.hintSequence };
    contract.reads++; contract.activeMs += reservedMs;
    this.saveContract(owner, watch.taskId, contract); this.save(watch);
    this.db.prepare('INSERT INTO pipeline_observation_reads VALUES(?,?,?,?,?,?)').run(read.id, owner, watch.taskId, id, 'running', JSON.stringify(read));
    return read;
  }
  isCurrent(read: ObservationRead): boolean {
    const watch = this.watch(read.owner, read.watchId), contract = this.contract(read.owner, read.taskId);
    return watch.status === 'active' && watch.revision === read.watchRevision && watch.pending?.id === read.operationId && watch.pending.call === read.call
      && contract?.requestRevision === read.requestRevision && this.now() < Date.parse(contract.budget.until);
  }
  finish(read: ObservationRead, result: { kind: 'accepted'; observedAt: string; validUntil: string; valuesDigest: string; changed: boolean; conflicted?: boolean; evidenceRefs: string[] }
    | { kind: 'pending'; retryAfterMs: number } | { kind: 'failed'; reason: string } | { kind: 'late'; resultDigest?: string }): void {
    assertBusinessTransaction(this.db);
    const row = this.db.prepare('SELECT status FROM pipeline_observation_reads WHERE id=? AND owner=?').get(read.id, read.owner);
    if (!row || row.status !== 'running') return;
    const current = this.isCurrent(read), status = current ? result.kind : 'late';
    const body = { read, status, result: status === 'late' ? { kind: 'late', resultDigest: digest(result) } : result, finishedAt: new Date(this.now()).toISOString() };
    this.db.prepare('UPDATE pipeline_observation_reads SET status=? WHERE id=? AND status=?').run(status, read.id, 'running');
    this.db.prepare('INSERT INTO pipeline_observation_receipts VALUES(?,?,?,?)').run(read.id, read.owner, read.taskId, JSON.stringify(body));
    const contract = this.contract(read.owner, read.taskId)!;
    contract.activeMs += Math.max(0, this.now() - Date.parse(read.startedAt)) - read.reservedMs;
    this.saveContract(read.owner, read.taskId, contract);
    if (!current || result.kind === 'late') return;
    const watch = this.watch(read.owner, read.watchId);
    if (result.kind === 'pending') {
      watch.health = 'pending'; watch.nextAt = this.now() + Math.min(60000, Math.max(1000, result.retryAfterMs));
    } else if (result.kind === 'failed') {
      delete watch.pending; watch.failedReads++; watch.health = 'unavailable'; watch.reason = result.reason;
      watch.nextAt = this.now() + Math.min(3600000, watch.selection.intervalMs * 2 ** Math.min(watch.failedReads, 8));
      if (watch.failedReads >= 3) watch.status = 'paused';
    } else {
      delete watch.pending; watch.failedReads = 0; watch.health = result.conflicted ? 'conflicted' : 'fresh'; delete watch.reason;
      if (!watch.coverageGapAt && watch.validUntil && Date.parse(result.observedAt) > Date.parse(watch.validUntil)) watch.coverageGapAt = watch.validUntil;
      watch.lastObservedAt = result.observedAt; watch.validUntil = result.validUntil; watch.lastValuesDigest = result.valuesDigest;
      watch.consumedHintSequence = read.hintSequence;
      watch.nextAt = Math.max(this.now() + 1000, Math.min(this.now() + watch.selection.intervalMs, Date.parse(result.validUntil)));
      if (watch.hintSequence > read.hintSequence) watch.nextAt = Math.min(watch.nextAt, this.now() + 1000);
    }
    watch.nextAt = Math.min(watch.nextAt, Date.parse(contract.budget.until)); this.save(watch);
  }
  settle(owner: string, taskId: string, requestRevision: number, terminal = false): void {
    const contract = this.contract(owner, taskId); if (!contract) return;
    assertBusinessTransaction(this.db);
    for (const watch of this.watches(owner, taskId)) {
      if (watch.status !== 'active') continue;
      if (terminal || contract.requestRevision !== requestRevision) { watch.status = 'stopped'; watch.reason = 'task_ended_or_changed'; }
      else if (Date.parse(contract.budget.until) <= this.now()) {
        const covered = !watch.coverageGapAt && watch.health === 'fresh' && Date.parse(watch.validUntil ?? '') >= Date.parse(contract.budget.until);
        watch.status = covered ? 'ended' : 'paused'; watch.reason = covered ? 'observation_horizon_ended' : 'observation_horizon_unverified';
        if (!covered && Date.parse(watch.validUntil ?? '') < Date.parse(contract.budget.until)) watch.coverageGapAt ??= watch.validUntil;
      }
      else if (contract.reads >= contract.budget.maxReads || contract.activeMs >= contract.budget.maxActiveMs) {
        // The reservation authorizes this last in-flight call. A checkpoint
        // must not consume its own permission before it reaches the source.
        const running = watch.pending && this.db.prepare(`SELECT 1 FROM pipeline_observation_reads WHERE owner=? AND watch_id=? AND status='running'
          AND json_extract(body,'$.operationId')=? AND json_extract(body,'$.call')=?`).get(owner, watch.id, watch.pending.id, watch.pending.call);
        if (running) continue;
        watch.status = 'paused'; watch.reason = 'observation_budget_exhausted';
      }
      else continue;
      watch.revision++; this.save(watch);
    }
  }
  stop(owner: string, id: string): void {
    assertBusinessTransaction(this.db); const watch = this.watch(owner, id);
    if (watch.status === 'stopped') return;
    watch.status = 'stopped'; watch.revision++; watch.reason = 'observation_stopped'; this.save(watch);
  }
  stopTask(owner: string, taskId: string, requestRevision: number): void {
    assertBusinessTransaction(this.db);
    const contract = this.contract(owner, taskId) ?? conflict('No observation contract exists');
    for (const watch of this.watches(owner, taskId)) if (watch.status !== 'ended') this.stop(owner, watch.id);
    contract.stoppedRevision = requestRevision; this.saveContract(owner, taskId, contract);
  }
  resume(owner: string, id: string, requestRevision: number): void {
    assertBusinessTransaction(this.db);
    const watch = this.watch(owner, id), contract = this.contract(owner, watch.taskId)!;
    if (!['stopped', 'paused'].includes(watch.status) || watch.requestRevision !== requestRevision || contract.requestRevision !== requestRevision) conflict('Only the same observation revision can be explicitly resumed');
    if (Date.parse(contract.budget.until) <= this.now() || contract.reads >= contract.budget.maxReads || contract.activeMs >= contract.budget.maxActiveMs) conflict('The original observation horizon or cumulative budget is exhausted');
    delete contract.stoppedRevision; this.saveContract(owner, watch.taskId, contract);
    watch.status = 'active'; watch.revision++; watch.failedReads = 0; watch.health = 'stale'; watch.nextAt = this.now(); delete watch.reason;
    // Any former running reply is now late; an effect-free source read may be
    // repeated, but the lifetime counters and original source scope are kept.
    delete watch.pending; this.save(watch);
  }
  resumeContract(owner: string, taskId: string, requestRevision: number): void {
    assertBusinessTransaction(this.db);
    const contract = this.contract(owner, taskId) ?? conflict('No observation contract exists');
    if (contract.requestRevision > requestRevision || Date.parse(contract.budget.until) <= this.now() || contract.reads >= contract.budget.maxReads || contract.activeMs >= contract.budget.maxActiveMs) conflict('The original observation horizon or cumulative budget is exhausted');
    contract.requestRevision = requestRevision; delete contract.stoppedRevision; this.saveContract(owner, taskId, contract);
  }
  pause(owner: string, id: string, reason: string): void {
    assertBusinessTransaction(this.db); const watch = this.watch(owner, id);
    if (watch.status !== 'active') return;
    watch.status = 'paused'; watch.revision++; watch.reason = reason; watch.health = 'unavailable'; this.save(watch);
  }
  hint(owner: string, id: string, eventId: string, contentDigest: string): void {
    assertBusinessTransaction(this.db); const watch = this.watch(owner, id);
    if (watch.status !== 'active') conflict('Observation is not active');
    if (this.db.prepare('SELECT 1 FROM pipeline_observation_hints WHERE owner=? AND watch_id=? AND event_id=? AND digest=?').get(owner, id, eventId, contentDigest)) return;
    if (Number(this.db.prepare('SELECT count(*) AS n FROM pipeline_observation_hints WHERE owner=? AND watch_id=?').get(owner, id)!.n) >= 1000) conflict('Observation hint history exceeds its bound');
    const inserted = this.db.prepare('INSERT OR IGNORE INTO pipeline_observation_hints VALUES(?,?,?,?)').run(owner, id, eventId, contentDigest);
    if (!inserted.changes) return;
    watch.hintSequence++; watch.nextAt = Math.min(watch.nextAt, this.now() + 1000); this.save(watch);
  }
  summary(owner: string, taskId: string): ObservationSummary | undefined {
    const contract = this.contract(owner, taskId); if (!contract) return;
    return { until: contract.budget.until, reads: contract.reads, maxReads: contract.budget.maxReads, activeMs: contract.activeMs, maxActiveMs: contract.budget.maxActiveMs, ...(contract.stoppedRevision ? { stopped: true } : {}),
      watches: this.watches(owner, taskId).map(watch => ({ id: watch.id, status: watch.status, health: watch.health === 'fresh' && Date.parse(watch.validUntil ?? '') <= this.now() ? 'stale' : watch.health,
        nextAt: new Date(watch.nextAt).toISOString(), object: watch.selection.object, fields: watch.selection.fields, componentId: watch.componentId,
        lastObservedAt: watch.lastObservedAt, validUntil: watch.validUntil, coverageGapAt: watch.coverageGapAt, reason: watch.reason })) };
  }
}
