import { Conflict, digest } from '../core/identity.js';
import type { Database, Sql } from './database.js';
import type { Bindings, PublishedOntology } from './metadata.js';

export type ReleaseCheck = { name: string; passed: boolean };

export async function initializeReleaseEvaluation(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.release_evaluation_policy(
    ontology text PRIMARY KEY, required_policy text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ${db.schema}.release_evaluation_receipts(
    release text PRIMARY KEY REFERENCES ${db.schema}.releases(digest),
    base text REFERENCES ${db.schema}.releases(digest), runtime text NOT NULL, binding_digest text NOT NULL,
    projection_fingerprint text NOT NULL, policy text NOT NULL, checks jsonb NOT NULL,
    checked_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`);
}

export async function requireReleaseEvaluation(db: Database, client: Sql, model: PublishedOntology,
  bindings: Bindings, base: string | null, projectionFingerprint: string) {
  const { rows: [policy] } = await db.query<{ required_policy: string }>(
    `SELECT required_policy FROM ${db.schema}.release_evaluation_policy WHERE ontology=$1`,
    [model.document.id], client);
  if (!policy) return;
  if (model.runtimeId !== db.runtimeId || !bindings.evaluateRelease)
    throw new Conflict('Release evaluation is required on the candidate runtime');
  const report = bindings.evaluateRelease(model);
  if (report.policy !== policy.required_policy || !report.checks.length ||
      new Set(report.checks.map(check => check.name)).size !== report.checks.length) {
    throw new Conflict('Release evaluation policy is unavailable');
  }
  const failures = report.checks.filter(check => check.passed !== true);
  if (failures.length) throw new Conflict('Release evaluation failed: ' + failures.map(check => check.name).join(', '));
  await db.query(`INSERT INTO ${db.schema}.release_evaluation_receipts
    (release,base,runtime,binding_digest,projection_fingerprint,policy,checks)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [model.release, base, model.runtimeId, digest(model.bindings), projectionFingerprint,
      report.policy, JSON.stringify(report.checks)], client);
}
