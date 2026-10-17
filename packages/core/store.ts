import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError, type Job, type JobState } from './domain.js';
import { BACKEND_VERSION } from '../ontology/execution.js';

export interface LocalActionIntent {
  id: string; jobId: string; planDigest: string; state: 'ready' | 'dispatching' | 'observed'; privateData: unknown;
}

export interface ListFilter {
  limit: number;
  offset: number;
  contextId?: string;
  state?: JobState;
  updatedAfter?: string;
}

export interface WorkClaim { owner: string; job: Job; token: string }

function equivalentFingerprint(a: string, b: string): boolean {
  if (a === b) return true;
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, normalize(v)])) : value;
  try { return JSON.stringify(normalize(JSON.parse(a))) === JSON.stringify(normalize(JSON.parse(b))); }
  catch { return false; }
}

export class JobStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    this.transaction(() => {
      const legacy = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_claims'").get();
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pilot_ledger (key TEXT PRIMARY KEY, body TEXT NOT NULL);
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
        CREATE TABLE IF NOT EXISTS execution_intents (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, job_id TEXT NOT NULL, plan_digest TEXT NOT NULL,
          state TEXT NOT NULL, private_data TEXT NOT NULL, UNIQUE(owner,job_id)
        );
        CREATE TABLE IF NOT EXISTS execution_observations (
          id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, owner TEXT NOT NULL, observed_at TEXT NOT NULL, body TEXT NOT NULL
        );
      `);
      if (legacy) {
        const rows = this.db.prepare("SELECT owner,body FROM jobs WHERE state='working'").all();
        for (const row of rows) {
          const job = JSON.parse(String(row.body)) as Job;
          if (job.service === 'eigos.delegate' && job.delegation?.backendVersion !== BACKEND_VERSION) continue;
          if (job.service === 'data.quality.audit.simulated') continue;
          job.state = 'failed'; job.error = 'Legacy execution interrupted by Gateway/Worker migration; inspect external outcome before retrying.';
          job.updatedAt = new Date().toISOString(); this.save(String(row.owner), job);
        }
      }
    });
  }

  // Local simulation ledger only; no payment credentials or external calls.
  pilotRead<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT body FROM pilot_ledger WHERE key=?').get(key);
    return row ? JSON.parse(String(row.body)) as T : undefined;
  }
  pilotWrite(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO pilot_ledger VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(value));
  }
  pilotJobs(): { owner: string; job: Job }[] {
    return this.db.prepare("SELECT owner,body FROM jobs WHERE json_extract(body,'$.pilot') IS NOT NULL").all()
      .map(r => ({ owner: String(r.owner), job: JSON.parse(String(r.body)) as Job }));
  }
  close(): void { this.db.close(); }

  // Called inside the same fenced checkpoint that saves the fixed plan.
  createIntent(owner: string, intent: LocalActionIntent): void {
    this.db.prepare('INSERT INTO execution_intents VALUES(?,?,?,?,?,?)').run(intent.id, owner, intent.jobId, intent.planDigest, intent.state, JSON.stringify(intent.privateData ?? null));
  }
  intent(owner: string, id: string): LocalActionIntent {
    const row = this.db.prepare('SELECT * FROM execution_intents WHERE owner=? AND id=?').get(owner, id);
    if (!row) throw new DomainError('NOT_FOUND', 'Action intent not found');
    return { id, jobId: String(row.job_id), planDigest: String(row.plan_digest), state: String(row.state) as LocalActionIntent['state'], privateData: JSON.parse(String(row.private_data)) };
  }
  dispatchIntent(owner: string, id: string): void {
    const result = this.db.prepare("UPDATE execution_intents SET state='dispatching' WHERE owner=? AND id=? AND state='ready'").run(owner, id);
    if (Number(result.changes) !== 1) throw new DomainError('CONFLICT', 'Started action must be reconciled; automatic replay is prohibited');
  }
  observeIntent(owner: string, id: string, observation: unknown): string {
    const observationId = randomUUID();
    this.transaction(() => {
      this.intent(owner, id);
      this.db.prepare('INSERT INTO execution_observations VALUES(?,?,?,?,?)').run(observationId, id, owner, new Date().toISOString(), JSON.stringify(observation));
      this.db.prepare("UPDATE execution_intents SET state='observed' WHERE owner=? AND id=?").run(owner, id);
    });
    return observationId;
  }
  observations(owner: string, intentId: string): unknown[] {
    this.intent(owner, intentId);
    return this.db.prepare('SELECT body FROM execution_observations WHERE owner=? AND intent_id=? ORDER BY observed_at,id').all(owner, intentId).map(r => JSON.parse(String(r.body)));
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
      if (job.service === 'eigos.delegate' && job.delegation?.backendVersion !== BACKEND_VERSION) continue;
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
      const row = this.db.prepare(`SELECT owner,body FROM jobs WHERE state IN ('working','submitted')
        AND COALESCE(json_extract(body,'$.executionMode'), 'worker')='worker'
        AND json_extract(body,'$.service') IN (${services.map(() => '?').join(',')})
        AND (json_extract(body,'$.service')!='eigos.delegate' OR json_extract(body,'$.delegation.backendVersion')=?)
        AND id NOT IN (SELECT job_id FROM work_claims) ORDER BY created_at,id LIMIT 1`).get(...services, BACKEND_VERSION);
      if (!row) return;
      const job = JSON.parse(String(row.body)) as Job;
      if (job.state === 'submitted') { job.state = 'working'; job.updatedAt = new Date(at).toISOString(); this.save(String(row.owner), job); }
      const token = randomUUID();
      this.db.prepare('INSERT INTO work_claims VALUES(?,?,?,?)').run(job.id, token, job.revision ?? 0, at + leaseMs);
      return { owner: String(row.owner), job, token };
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
    return lease?.token === claim.token && Number(lease.expires_at) > now && current.state === 'working'
      && (current.revision ?? 0) === (claim.job.revision ?? 0);
  }

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
    this.db.prepare(`INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at, body=excluded.body
      WHERE jobs.owner=excluded.owner`).run(
      job.id, owner, job.contextId, job.state, job.createdAt, job.updatedAt, JSON.stringify(job),
    );
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
