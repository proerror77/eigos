import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from './domain.js';
import type { RunEvidence } from '../capabilities/executor.js';

type ModelUsage = { id: string; runtime: string; startedAt: string; completedAt?: string; model?: string; usage?: Record<string, number>; usageReported: boolean; claimTokenDigest?: string };
const cleanUsage = (value: RunEvidence['usage']) => value ? Object.fromEntries(Object.entries(value).filter(([key, n]) => /^[a-z_]{1,80}$/.test(key) && Number.isSafeInteger(n) && n >= 0)) : undefined;

export function initializeMemberUsage(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS member_model_usage (run_id TEXT PRIMARY KEY, owner TEXT NOT NULL, job_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS member_model_usage_owner ON member_model_usage(owner,job_id);
    CREATE TABLE IF NOT EXISTS member_usage_migrations (id TEXT PRIMARY KEY);`);
  if (db.prepare('SELECT 1 FROM member_usage_migrations WHERE id=?').get('reported-runs@1')) return;
  for (const row of db.prepare('SELECT owner,id,body FROM jobs').all()) {
    const job = JSON.parse(String(row.body));
    for (const run of Array.isArray(job.runs) ? job.runs : []) {
      if (typeof run?.id === 'string' && typeof run.runtime === 'string' && typeof run.startedAt === 'string') recordModelResponse(db, String(row.owner), String(row.id), run);
    }
  }
  db.prepare('INSERT INTO member_usage_migrations VALUES(?)').run('reported-runs@1');
}

function existing(db: DatabaseSync, owner: string, jobId: string, id: string) {
  const row = db.prepare('SELECT owner,job_id,state,body FROM member_model_usage WHERE run_id=?').get(id);
  if (row && (row.owner !== owner || row.job_id !== jobId)) throw new DomainError('CONFLICT', 'Model usage receipt belongs to another execution');
  return row;
}
export function beginModelUsage(db: DatabaseSync, owner: string, jobId: string, id: string, runtime: string, startedAt: string, claimTokenDigest: string) {
  if (existing(db, owner, jobId, id)) throw new DomainError('CONFLICT', 'A model attempt cannot be dispatched twice');
  const value: ModelUsage = { id, runtime, startedAt, claimTokenDigest, usageReported: false };
  db.prepare('INSERT INTO member_model_usage VALUES(?,?,?,?,?)').run(id, owner, jobId, 'running', JSON.stringify(value));
}
export function finishModelUsage(db: DatabaseSync, owner: string, jobId: string, id: string, evidence: RunEvidence | undefined, outcome: 'completed' | 'failed' | 'interrupted') {
  const row = existing(db, owner, jobId, id); if (!row) throw new DomainError('CONFLICT', 'Model attempt was not recorded before dispatch');
  const old: ModelUsage = JSON.parse(String(row.body)), usage = cleanUsage(evidence?.usage);
  // Late receipts improve accounting only; they never advance a task or lease.
  const value: ModelUsage = { ...old, completedAt: evidence?.completedAt ?? new Date().toISOString(), model: evidence?.model, usage, usageReported: !!usage && Object.keys(usage).length > 0 };
  db.prepare('UPDATE member_model_usage SET state=?,body=? WHERE run_id=? AND owner=?').run(outcome, JSON.stringify(value), id, owner);
}
export function recordModelResponse(db: DatabaseSync, owner: string, jobId: string, evidence: RunEvidence) {
  const usage = cleanUsage(evidence.usage), value: ModelUsage = { id: evidence.id, runtime: evidence.runtime, startedAt: evidence.startedAt, completedAt: evidence.completedAt, model: evidence.model, usage, usageReported: !!usage && Object.keys(usage).length > 0 };
  const row = existing(db, owner, jobId, evidence.id);
  if (row) {
    const old: ModelUsage = JSON.parse(String(row.body));
    if (old.runtime !== value.runtime || old.model !== value.model || old.startedAt !== value.startedAt || old.completedAt !== value.completedAt
      || JSON.stringify(Object.entries(old.usage ?? {}).sort()) !== JSON.stringify(Object.entries(usage ?? {}).sort())) throw new DomainError('CONFLICT', 'Model usage receipt changed after recording');
    return;
  }
  db.prepare('INSERT INTO member_model_usage VALUES(?,?,?,?,?)').run(evidence.id, owner, jobId, 'completed', JSON.stringify(value));
}
export function markModelUsageUnknown(db: DatabaseSync, owner: string, jobId: string, claimTokenDigest: string) {
  db.prepare("UPDATE member_model_usage SET state='unknown' WHERE owner=? AND job_id=? AND state='running' AND json_extract(body,'$.claimTokenDigest')=?").run(owner, jobId, claimTokenDigest);
}
export function memberUsage(db: DatabaseSync, owner: string) {
  const grouped = db.prepare('SELECT state,count(*) AS n FROM member_model_usage WHERE owner=? GROUP BY state').all(owner);
  const states = Object.fromEntries(grouped.map(row => [String(row.state), Number(row.n)]));
  const reported = db.prepare("SELECT u.key AS unit,sum(u.value) AS total FROM member_model_usage m,json_each(m.body,'$.usage') u WHERE m.owner=? GROUP BY u.key").all(owner);
  const unreported = Number(db.prepare("SELECT count(*) AS n FROM member_model_usage WHERE owner=? AND json_extract(body,'$.usageReported')=0").get(owner)!.n);
  const actions = db.prepare("SELECT json_extract(i.body,'$.effect') AS effect,json_extract(a.body,'$.kind') AS kind,count(*) AS n FROM action_attempts a JOIN action_intents i ON i.id=a.intent_id AND i.owner=a.owner WHERE a.owner=? GROUP BY effect,kind").all(owner);
  const open = Number(db.prepare("SELECT count(*) AS n FROM jobs WHERE owner=? AND state IN ('submitted','working','paused','input-required','auth-required')").get(owner)!.n);
  return { scope: 'current_member', accounting: 'recorded_lifetime', limitsEnforced: false, remaining: null, resetsAt: null, taskSafetyBudgetsApply: true,
    models: { attempts: grouped.reduce((n, row) => n + Number(row.n), 0), states, reportedUsage: Object.fromEntries(reported.map(row => [String(row.unit), Number(row.total)])), attemptsWithoutReportedUsage: unreported },
    actions: { attempts: actions.reduce((n, row) => n + Number(row.n), 0), byEffectAndKind: actions.map(row => ({ effect: String(row.effect), kind: String(row.kind), attempts: Number(row.n) })) },
    openTasks: open, usageCoverage: 'EIGOS Worker attempts and provider-reported model usage. Unreported usage is unknown; external PA model usage is not included.' } as const;
}
export type MemberUsage = ReturnType<typeof memberUsage>;
