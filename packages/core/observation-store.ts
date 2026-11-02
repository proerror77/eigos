import type { DatabaseSync } from 'node:sqlite';
import { digest } from './delegation.js';
import { DomainError } from './domain.js';
import { assertBusinessTransaction } from './transaction.js';
import { randomUUID } from 'node:crypto';
import type { Principal } from './domain.js';
import type { ObservationRuntimeState, ObservationTarget, ObservationReadTicket } from '../ontology/observation-runtime.js';
import type { Ref } from '../ontology/execution.js';
import type { PipelineObservation } from '../ontology/pipeline/contracts.js';
import { prepareObservationSchema, type ObservationContract, type ObservationPins, type PrepareObservation, type ObservationContractView } from '../ontology/observation-contract.js';

function conflict(): never { throw new DomainError('CONFLICT', 'Observation contract integrity or revision changed'); }
/** Contract/control metadata in the single business DB. No source fact copy,
 * polling, model invocation, execution grant or scheduling claim is installed. */
export class ObservationContractStore {
  constructor(private db: DatabaseSync, readonly now: () => number) {
    db.exec(`CREATE TABLE IF NOT EXISTS observation_contracts (
      owner TEXT NOT NULL, task_id TEXT NOT NULL, original_task_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, until_ms INTEGER NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(owner,task_id));
      CREATE INDEX IF NOT EXISTS observation_original_task ON observation_contracts(owner,original_task_id);
      CREATE INDEX IF NOT EXISTS observation_contract_horizon ON observation_contracts(owner,status,until_ms);
      CREATE TABLE IF NOT EXISTS observation_contract_events (owner TEXT NOT NULL,task_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,task_id,revision));`);
    db.exec(`CREATE TABLE IF NOT EXISTS observation_runtime(owner TEXT NOT NULL,task_id TEXT NOT NULL,id TEXT NOT NULL,state TEXT NOT NULL,next_at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,task_id));
      CREATE INDEX IF NOT EXISTS observation_due ON observation_runtime(state,next_at,owner,task_id);
      CREATE TABLE IF NOT EXISTS observation_reads(owner TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,id));
      CREATE INDEX IF NOT EXISTS observation_read_task ON observation_reads(owner,task_id,status);
      CREATE TABLE IF NOT EXISTS observation_inbox(owner TEXT NOT NULL,read_id TEXT NOT NULL,task_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,read_id));
      CREATE TABLE IF NOT EXISTS observation_receipts(owner TEXT NOT NULL,read_id TEXT NOT NULL,task_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,read_id));
      CREATE TABLE IF NOT EXISTS observation_late_results(owner TEXT NOT NULL,read_id TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,read_id,digest));
      CREATE TABLE IF NOT EXISTS observation_hints(owner TEXT NOT NULL,task_id TEXT NOT NULL,event_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(owner,task_id,event_id));`);
    for (const operation of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS observation_contract_event_${operation.toLowerCase()} BEFORE ${operation} ON observation_contract_events BEGIN SELECT RAISE(ABORT,'Observation contract audit is immutable'); END`);
    for (const operation of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS observation_receipt_${operation.toLowerCase()} BEFORE ${operation} ON observation_receipts BEGIN SELECT RAISE(ABORT,'Observation receipt is immutable'); END`);
    for (const operation of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS observation_late_result_${operation.toLowerCase()} BEFORE ${operation} ON observation_late_results BEGIN SELECT RAISE(ABORT,'Late observation audit is immutable'); END`);
  }
  get(owner: string, id: string): ObservationContract {
    const row = this.db.prepare('SELECT body,revision,status,until_ms FROM observation_contracts WHERE owner=? AND task_id=?').get(owner, id);
    if (!row) throw new DomainError('NOT_FOUND', 'Observation contract is unavailable');
    let value: ObservationContract;
    try { value = JSON.parse(String(row.body)); } catch { return conflict(); }
    if (!value || typeof value !== 'object' || value.version !== '1' || value.owner !== owner || value.id !== id || value.revision !== row.revision || value.status !== row.status
      || !['configured', 'revoked'].includes(value.status) || value.revocationRevision !== (value.status === 'revoked' ? 1 : 0)
      || value.revision !== value.revocationRevision + 1 || !prepareObservationSchema.safeParse(value.declaration).success
      || Date.parse(value.declaration.until) !== row.until_ms || value.digest !== digest({ declaration: value.declaration, pins: value.pins })) conflict();
    return value;
  }
  create(owner: string, id: string, declaration: PrepareObservation, pins: ObservationPins): ObservationContract {
    assertBusinessTransaction(this.db);
    declaration = prepareObservationSchema.parse(declaration);
    const now = this.now(), start = Date.parse(declaration.startsAt), end = Date.parse(declaration.until);
    if (end <= now || end > now + 86400000 || start < now - 60000 || end > Date.parse(pins.expiresAt)) throw new DomainError('CONFLICT', 'The declared observation window exceeds current authority or the 24-hour horizon');
    if (Number(this.db.prepare("SELECT count(*) AS n FROM observation_contracts WHERE owner=? AND status='configured' AND until_ms>?").get(owner, now)!.n) >= 100) throw new DomainError('CONFLICT', 'Observation contract capacity reached');
    const value: ObservationContract = { version: '1', id, owner, revision: 1, revocationRevision: 0, status: 'configured', createdAt: new Date(now).toISOString(),
      declaration, pins, digest: digest({ declaration, pins }), usage: { reads: 0, modelTurns: 0, activeMs: 0, costMinor: '0' } };
    this.db.prepare('INSERT INTO observation_contracts VALUES(?,?,?,?,?,?,?)').run(owner, id, declaration.originalTaskId, value.revision, value.status, end, JSON.stringify(value));
    this.event(value, 'configured'); return value;
  }
  revoke(owner: string, id: string, expectedRevision: number): ObservationContract {
    assertBusinessTransaction(this.db);
    const value = this.get(owner, id);
    if (value.revision !== expectedRevision) conflict();
    if (value.status === 'revoked') return value;
    value.status = 'revoked'; value.revision++; value.revocationRevision++; value.revokedAt = new Date(this.now()).toISOString();
    const result = this.db.prepare('UPDATE observation_contracts SET revision=?,status=?,body=? WHERE owner=? AND task_id=? AND revision=?')
      .run(value.revision, value.status, JSON.stringify(value), owner, id, expectedRevision);
    if (result.changes !== 1) conflict();
    this.event(value, 'revoked');
    this.pause(owner, id, 'owner_revoked', 'revoked'); return value;
  }
  private event(value: ObservationContract, kind: string) {
    this.db.prepare('INSERT INTO observation_contract_events VALUES(?,?,?,?)').run(value.owner, value.id, value.revision,
      JSON.stringify({ kind, at: new Date(this.now()).toISOString(), digest: value.digest, revocationRevision: value.revocationRevision }));
  }
  runtime(owner: string, taskId: string): ObservationRuntimeState | undefined {
    const row = this.db.prepare('SELECT body FROM observation_runtime WHERE owner=? AND task_id=?').get(owner, taskId);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  saveRuntime(value: ObservationRuntimeState): void {
    assertBusinessTransaction(this.db);
    this.db.prepare('INSERT INTO observation_runtime VALUES(?,?,?,?,?,?) ON CONFLICT(owner,task_id) DO UPDATE SET state=excluded.state,next_at=excluded.next_at,body=excluded.body')
      .run(value.owner, value.taskId, value.id, value.state, value.nextAt, JSON.stringify(value));
  }
  activate(owner: string, taskId: string, principal: Principal, adapter: Ref, target: ObservationTarget, bindingDigest: string): ObservationRuntimeState {
    assertBusinessTransaction(this.db);
    const contract = this.get(owner, taskId), old = this.runtime(owner, taskId);
    if (contract.status !== 'configured' || Date.parse(contract.declaration.until) <= this.now()) conflict();
    if (old && old.bindingDigest !== bindingDigest) throw new DomainError('CONFLICT', 'A source binding cannot be silently replaced');
    if (old?.state === 'active') return old;
    if (contract.usage.reads >= contract.declaration.lifetimeBudget.maxReads || contract.usage.activeMs >= contract.declaration.lifetimeBudget.maxActiveMs) throw new DomainError('CONFLICT', 'Original observation budget is exhausted');
    const value: ObservationRuntimeState = { id: old?.id ?? randomUUID(), owner, taskId, generation: (old?.generation ?? 0) + 1, state: 'active', principal, adapter, target,
      bindingDigest, activatedAt: new Date(this.now()).toISOString(), nextAt: Math.max(this.now(), Date.parse(contract.declaration.startsAt)), health: 'pending',
      hintSequence: old?.hintSequence ?? 0, consumedHints: old?.consumedHints ?? 0, targetVerified: false };
    this.saveRuntime(value); return value;
  }
  active(limit = 100): ObservationRuntimeState[] {
    return this.db.prepare("SELECT o.body FROM observation_runtime o WHERE o.state='active' AND o.next_at<=? AND NOT EXISTS(SELECT 1 FROM work_claims c WHERE c.job_id=o.task_id AND c.expires_at>?) ORDER BY o.next_at,o.task_id LIMIT ?")
      .all(this.now(), this.now(), limit).map(row => JSON.parse(String(row.body)));
  }
  pause(owner: string, taskId: string, reason: string, state: ObservationRuntimeState['state'] = 'paused'): void {
    assertBusinessTransaction(this.db); const value = this.runtime(owner, taskId); if (!value) return;
    value.state = state; value.health = reason === 'source_conflict' ? 'conflicted' : 'unavailable'; value.reason = reason; this.saveRuntime(value);
    if (state === 'revoked' || state === 'ended') {
      for (let n = 0; n < 1000; n++) {
        const pending = this.queued(owner, taskId); if (!pending) break;
        this.receipt(pending.ticket, { kind: 'late', resultDigest: digest(pending.sample) });
      }
      if (this.queued(owner, taskId)) throw new DomainError('CONFLICT', 'Observation inbox exceeds its lifetime bound');
    }
  }
  hint(owner: string, taskId: string, eventId: string, contentDigest: string): void {
    assertBusinessTransaction(this.db); const value = this.runtime(owner, taskId);
    if (!value || value.state !== 'active') throw new DomainError('CONFLICT', 'Observation is not active');
    const old = this.db.prepare('SELECT digest FROM observation_hints WHERE owner=? AND task_id=? AND event_id=?').get(owner, taskId, eventId);
    if (old) { if (old.digest !== contentDigest) throw new DomainError('CONFLICT', 'Conflicting notification identity'); return; }
    if (Number(this.db.prepare('SELECT count(*) AS n FROM observation_hints WHERE owner=? AND task_id=?').get(owner, taskId)!.n) >= 1000) throw new DomainError('CONFLICT', 'Observation notification capacity reached');
    this.db.prepare('INSERT INTO observation_hints VALUES(?,?,?,?)').run(owner, taskId, eventId, contentDigest);
    value.hintSequence++; value.nextAt = this.now(); value.health = 'stale'; this.saveRuntime(value);
  }
  begin(owner: string, taskId: string, leaseToken: string, sourceRevision: number, cost: { minor: string; currency: string }): ObservationReadTicket {
    assertBusinessTransaction(this.db);
    const contract = this.get(owner, taskId), runtime = this.runtime(owner, taskId), d = contract.declaration;
    if (!runtime || runtime.state !== 'active' || contract.status !== 'configured' || Date.parse(d.until) <= this.now()) conflict();
    if (contract.usage.reads + 1 > d.lifetimeBudget.maxReads || contract.usage.activeMs + d.perReadBudget.timeoutMs > d.lifetimeBudget.maxActiveMs
      || cost.currency !== d.lifetimeBudget.maxCost.currency || BigInt(contract.usage.costMinor) + BigInt(cost.minor) > BigInt(d.lifetimeBudget.maxCost.minor)) throw new DomainError('CONFLICT', 'Observation lifetime budget is exhausted');
    // Debit the declared maximum before I/O. Crashes, timeouts and late replies
    // retain this conservative charge; restarts never reset lifetime counters.
    contract.usage.reads++; contract.usage.activeMs += d.perReadBudget.timeoutMs; contract.usage.costMinor = String(BigInt(contract.usage.costMinor) + BigInt(cost.minor));
    this.db.prepare('UPDATE observation_contracts SET body=? WHERE owner=? AND task_id=?').run(JSON.stringify(contract), owner, taskId);
    const ticket: ObservationReadTicket = { id: randomUUID(), owner, taskId, runtimeId: runtime.id, generation: runtime.generation, contractRevision: contract.revision,
      leaseDigest: digest(leaseToken), sourceRevision, hintSequence: runtime.hintSequence, startedAt: new Date(this.now()).toISOString(), reservedMs: d.perReadBudget.timeoutMs, costMinor: cost.minor };
    this.db.prepare('INSERT INTO observation_reads VALUES(?,?,?, ?,?)').run(owner, ticket.id, taskId, 'running', JSON.stringify(ticket));
    runtime.health = 'pending'; this.saveRuntime(runtime); return ticket;
  }
  enqueue(ticket: ObservationReadTicket, sample: PipelineObservation): void {
    assertBusinessTransaction(this.db);
    const body = JSON.stringify({ ticket, sample }), old = this.db.prepare('SELECT body FROM observation_inbox WHERE owner=? AND read_id=?').get(ticket.owner, ticket.id);
    if (old) { if (old.body !== body) conflict(); return; }
    this.db.prepare('INSERT INTO observation_inbox VALUES(?,?,?,?)').run(ticket.owner, ticket.id, ticket.taskId, body);
    this.db.prepare("UPDATE observation_reads SET status='queued' WHERE owner=? AND id=?").run(ticket.owner, ticket.id);
  }
  queued(owner: string, taskId: string): { ticket: ObservationReadTicket; sample: PipelineObservation } | undefined {
    const row = this.db.prepare('SELECT i.body FROM observation_inbox i JOIN observation_reads r ON r.owner=i.owner AND r.id=i.read_id WHERE i.owner=? AND i.task_id=? AND r.status=\'queued\' ORDER BY i.rowid LIMIT 1').get(owner, taskId);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  abandonRunning(owner: string, taskId: string): void {
    assertBusinessTransaction(this.db);
    const rows = this.db.prepare("SELECT body FROM observation_reads WHERE owner=? AND task_id=? AND status='running' LIMIT 1001").all(owner, taskId);
    if (rows.length > 1000) conflict();
    for (const row of rows) this.receipt(JSON.parse(String(row.body)), { kind: 'interrupted' });
  }
  receipt(ticket: ObservationReadTicket, result: { kind: string; resultDigest?: string; semanticRevision?: number }): void {
    assertBusinessTransaction(this.db);
    const inserted = this.db.prepare('INSERT OR IGNORE INTO observation_receipts VALUES(?,?,?,?)').run(ticket.owner, ticket.id, ticket.taskId, JSON.stringify({ ...result, at: new Date(this.now()).toISOString(), generation: ticket.generation }));
    if (inserted.changes) this.db.prepare('UPDATE observation_reads SET status=? WHERE owner=? AND id=?').run(result.kind, ticket.owner, ticket.id);
    if (result.kind === 'late' && result.resultDigest) this.db.prepare('INSERT OR IGNORE INTO observation_late_results VALUES(?,?,?,?)').run(ticket.owner, ticket.id, result.resultDigest, JSON.stringify({ at: new Date(this.now()).toISOString(), generation: ticket.generation }));
  }
  view(owner: string, id: string, sourcePermission: ObservationContractView['sourcePermission']): ObservationContractView {
    const value = this.get(owner, id), d = value.declaration, runtime = this.runtime(owner, id);
    const installed = !!runtime, fresh = runtime?.state === 'active' && runtime.health === 'fresh' && !!runtime.validUntil && Date.parse(runtime.validUntil) > this.now()
      && runtime.nextAt + Math.min(d.perReadBudget.timeoutMs, d.maxStalenessMs) > this.now()
      && runtime.hintSequence === runtime.consumedHints && sourcePermission === 'current' && value.status === 'configured' && Date.parse(d.until) > this.now();
    return { id, revision: value.revision, revocationRevision: value.revocationRevision,
      status: value.status === 'revoked' ? 'revoked' : Date.parse(d.until) <= this.now() ? 'expired' : 'configured',
      monitoring: !!fresh, targetIdentity: runtime?.targetVerified ? 'verified' : 'unverified', activation: installed ? 'observer_installed' : 'observer_not_installed', sourcePermission,
      ...(runtime ? { runtime: { state: runtime.state, health: fresh ? 'fresh' as const : runtime.health === 'fresh' ? 'stale' as const : runtime.health, ...(runtime.reason ? { reason: runtime.reason } : {}), ...(runtime.lastObservedAt ? { lastObservedAt: runtime.lastObservedAt } : {}), pendingChanges: runtime.hintSequence - runtime.consumedHints } } : {}),
      startsAt: d.startsAt, until: d.until, nextDueAt: value.status === 'configured' && Date.parse(d.until) > this.now() ? runtime?.state === 'active' ? new Date(runtime.nextAt).toISOString() : installed ? null : d.startsAt : null,
      maxStalenessMs: d.maxStalenessMs, strategy: structuredClone(d.strategy), perReadBudget: structuredClone(d.perReadBudget),
      lifetimeBudget: structuredClone(d.lifetimeBudget), usage: { ...value.usage } };
  }
}
