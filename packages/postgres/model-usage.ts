import type { Client } from 'pg';
import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import type { RunEvidence } from '../capabilities/executor.js';
import type { ModelUsageEvidence } from '../core/model-usage-context.js';
import { modelUsageStarted, modelUsageFinished, modelUsageReported, assertModelUsageResponse, type ModelUsage } from '../core/member-usage.js';
import { nativeModelTimingSchema } from '../capabilities/native-model-timing.js';
import { postgresBusinessSchema } from './runtime-transaction.js';
import type { PostgresWorkReference } from './work-claim.js';

const idSchema = z.string().min(1).max(200), timeSchema = z.iso.datetime({ offset: true });
const storedSchema = z.strictObject({ id: idSchema, runtime: z.string().min(1).max(200), startedAt: timeSchema, completedAt: timeSchema.optional(),
  model: z.string().max(1000).optional(), usage: z.record(z.string(), z.number()).optional(), usageReported: z.boolean(),
  claimTokenDigest: z.string().min(1).max(200).optional(), nativeTiming: nativeModelTimingSchema.optional() });
const identity = (value: Pick<ModelUsage, 'id' | 'runtime' | 'startedAt'>) => {
  idSchema.parse(value.id); z.string().min(1).max(200).parse(value.runtime); timeSchema.parse(value.startedAt);
};
async function existing(client: Client, owner: string, taskId: string, id: string) {
  idSchema.parse(id);
  const rows = await client.query(`SELECT owner,job_id,state,CASE WHEN octet_length(body)<=1048576 THEN body END AS body
    FROM "${postgresBusinessSchema(client)}".member_model_usage WHERE run_id=$1 LIMIT 2 FOR UPDATE`, [id]);
  if (rows.rowCount === 0) return;
  if (rows.rowCount !== 1 || rows.rows[0].owner !== owner || rows.rows[0].job_id !== taskId) throw new DomainError('CONFLICT', 'Model usage receipt belongs to another execution');
  if (typeof rows.rows[0].body !== 'string') throw new DomainError('CONFLICT', 'Model usage receipt exceeds its read bound');
  const value = storedSchema.parse(JSON.parse(rows.rows[0].body));
  if (value.id !== id) throw new DomainError('CONFLICT', 'Model usage receipt identity changed');
  return { value, state: String(rows.rows[0].state) };
}

/** The caller validates the current original claim before and at COMMIT. No
 * model may dispatch before this durable reservation is acknowledged. */
export async function postgresBeginModelUsage(client: Client, claim: PostgresWorkReference, id: string, runtime: string, startedAt: string) {
  identity({ id, runtime, startedAt });
  if (await existing(client, claim.owner, claim.job.id, id)) throw new DomainError('CONFLICT', 'A model attempt cannot be dispatched twice');
  const value = modelUsageStarted(id, runtime, startedAt, digest(claim.token));
  await client.query(`INSERT INTO "${postgresBusinessSchema(client)}".member_model_usage(run_id,owner,job_id,state,body) VALUES($1,$2,$3,'running',$4)`,
    [id, claim.owner, claim.job.id, JSON.stringify(value)]);
}

/** Late provider evidence updates accounting only. It cannot revive a claim,
 * change the task, mint an output seal or publish a business result. */
export async function postgresFinishModelUsage(client: Client, claim: PostgresWorkReference, id: string,
  evidence: ModelUsageEvidence | undefined, outcome: 'completed' | 'failed' | 'interrupted') {
  z.enum(['completed', 'failed', 'interrupted']).parse(outcome);
  const row = await existing(client, claim.owner, claim.job.id, id);
  if (!row) throw new DomainError('CONFLICT', 'Model attempt was not recorded before dispatch');
  if (row.value.claimTokenDigest && row.value.claimTokenDigest !== digest(claim.token)) throw new DomainError('CONFLICT', 'Model usage receipt belongs to another claim');
  if (evidence) {
    identity(evidence);
    if (evidence.id !== row.value.id || evidence.runtime !== row.value.runtime || evidence.startedAt !== row.value.startedAt) throw new DomainError('CONFLICT', 'Model usage receipt belongs to another execution');
    timeSchema.parse(evidence.completedAt);
  }
  const value = modelUsageFinished(row.value, evidence);
  if (Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new DomainError('CONFLICT', 'Model usage receipt exceeds its storage bound');
  const result = await client.query(`UPDATE "${postgresBusinessSchema(client)}".member_model_usage SET state=$1,body=$2 WHERE run_id=$3 AND owner=$4 AND job_id=$5`,
    [outcome, JSON.stringify(value), id, claim.owner, claim.job.id]);
  if (result.rowCount !== 1) throw new DomainError('CONFLICT', 'Model usage receipt changed');
}

/** Same provider receipt consistency as the synchronous Coordinator. This is
 * accounting only; current task mutation retains its independent claim fence. */
export async function postgresRecordModelResponse(client: Client, claim: PostgresWorkReference, evidence: RunEvidence) {
  identity(evidence); timeSchema.parse(evidence.completedAt);
  const value = modelUsageReported(evidence), row = await existing(client, claim.owner, claim.job.id, evidence.id);
  if (row) { assertModelUsageResponse(row.value, value); return; }
  if (Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new DomainError('CONFLICT', 'Model usage receipt exceeds its storage bound');
  await client.query(`INSERT INTO "${postgresBusinessSchema(client)}".member_model_usage(run_id,owner,job_id,state,body) VALUES($1,$2,$3,'completed',$4)`,
    [value.id, claim.owner, claim.job.id, JSON.stringify(value)]);
}
