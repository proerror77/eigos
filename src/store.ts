import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DomainError, type Job, type JobState } from './domain.js';

export interface ListFilter {
  limit: number;
  offset: number;
  contextId?: string;
  state?: JobState;
  updatedAfter?: string;
}

export class JobStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, context_id TEXT NOT NULL,
        state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner, created_at, id);
      CREATE TABLE IF NOT EXISTS requests (
        owner TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, response TEXT NOT NULL,
        PRIMARY KEY (owner, operation, request_id)
      );
    `);
  }

  close(): void { this.db.close(); }

  // An interrupted model call cannot be assumed safe to replay or completed.
  interruptWorking(): void {
    const rows = this.db.prepare("SELECT owner, body FROM jobs WHERE state='working'").all();
    for (const row of rows) {
      const job = JSON.parse(String(row.body)) as Job;
      job.state = 'failed'; job.error = 'Executor interrupted by server restart; submit a new task to retry.';
      job.updatedAt = new Date().toISOString();
      this.save(String(row.owner), job);
    }
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT fingerprint, response FROM requests WHERE owner=? AND operation=? AND request_id=?')
        .get(owner, operation, requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new DomainError('CONFLICT', 'Request ID was already used with different input');
        this.db.exec('COMMIT');
        return JSON.parse(String(previous.response)) as Job;
      }
      const result = action();
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)').run(owner, operation, requestId, fingerprint, JSON.stringify(result));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
