import { z } from 'zod';
import { FunctionFailed, ResourceExhausted, requireScope, type Principal } from '../core/identity.js';
import { ontologyName } from '../ontology/schema.js';
import type { Access } from './access.js';
import type { Database } from './database.js';
import type { PublishedOntology } from './metadata.js';

export type FunctionInvocationMetrics = {
  fuelUsed?: number;
  hostMs?: number;
  callbacks: Record<string, { count: number; durationMs: number }>;
};

const afterId = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => BigInt(value) <= 9223372036854775807n, 'Invalid invocation cursor');
export const functionInvocationsQuery = z.strictObject({
  ontology: ontologyName.default('Eigos'),
  function: ontologyName,
  before: afterId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

type InvocationRow = {
  id: string; version: string | null; release: string; owner: string; started_at: Date;
  duration_ms: number; host_ms: number | null; fuel_used: number | null;
  callbacks: FunctionInvocationMetrics['callbacks']; error_code: string | null;
};

export async function initializeFunctionInvocations(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.function_invocations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner text NOT NULL, ontology text NOT NULL, function_name text NOT NULL, version text,
    release text NOT NULL REFERENCES ${db.schema}.releases(digest), started_at timestamptz NOT NULL,
    duration_ms integer NOT NULL, host_ms integer, fuel_used double precision,
    callbacks jsonb NOT NULL, error_code text
  );
  CREATE INDEX IF NOT EXISTS function_invocations_lookup ON ${db.schema}.function_invocations(owner,ontology,function_name,id DESC);
  CREATE INDEX IF NOT EXISTS function_invocations_age ON ${db.schema}.function_invocations(started_at);`);
}

function codeOf(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return 'aborted';
  if (error instanceof ResourceExhausted) return error.limit;
  if (error instanceof FunctionFailed && /^[a-zA-Z0-9_-]{1,100}$/.test(error.code)) return error.code;
  if (error instanceof Error && /^[a-zA-Z0-9_-]{1,100}$/.test(error.name)) return error.name;
  return 'failed';
}

export class FunctionInvocations {
  constructor(private readonly db: Database) {}

  async measure<T>(model: PublishedOntology, name: string, version: string | undefined, principal: Principal,
    signal: AbortSignal, run: (metrics: FunctionInvocationMetrics) => Promise<T>) {
    const start = performance.now(), startedAt = new Date();
    const metrics: FunctionInvocationMetrics = { callbacks: {} };
    let errorCode: string | null = null;
    try { return await run(metrics); }
    catch (error) { errorCode = codeOf(error, signal); throw error; }
    finally {
      // The measurement describes the Function call, including attempts that an Action later rolls back.
      // An asynchronous insert can obtain its own connection after the caller releases its transaction.
      void this.db.query(`INSERT INTO ${this.db.schema}.function_invocations
        (owner,ontology,function_name,version,release,started_at,duration_ms,host_ms,fuel_used,callbacks,error_code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
        principal.owner, model.document.id, name, version ?? null, model.release, startedAt,
        Math.round(performance.now() - start), metrics.hostMs ?? null, metrics.fuelUsed ?? null, metrics.callbacks, errorCode,
      ]).catch(() => { console.error('Could not record Function invocation'); });
    }
  }

  async list(access: Access, model: PublishedOntology, input: z.infer<typeof functionInvocationsQuery>) {
    requireScope(access.principal, 'ontology:read');
    access.require(model.document.id, 'view_definition', model.document.id);
    access.function(model, input.function);
    const rows = (await this.db.query<InvocationRow>(`SELECT id::text,version,release,owner,started_at,duration_ms,host_ms,
      fuel_used,callbacks,error_code FROM ${this.db.schema}.function_invocations
      WHERE owner=$1 AND ontology=$2 AND function_name=$3 AND ($4::bigint IS NULL OR id<$4::bigint)
        AND started_at>=now()-interval '30 days' ORDER BY function_invocations.id DESC LIMIT $5`,
    [access.principal.owner, model.document.id, input.function, input.before ?? null, input.limit + 1])).rows;
    await access.refresh();
    access.require(model.document.id, 'view_definition', model.document.id);
    access.function(model, input.function);
    const items = rows.slice(0, input.limit).map(row => ({
      id: row.id, function: input.function, version: row.version, release: row.release, owner: row.owner,
      startedAt: row.started_at, durationMs: row.duration_ms, hostMs: row.host_ms,
      fuelUsed: row.fuel_used, callbacks: row.callbacks, status: row.error_code === null ? 'returned' : 'failed', errorCode: row.error_code,
    }));
    return { items, ...(rows.length > items.length ? { cursor: items.at(-1)!.id } : {}) };
  }

  async prune() {
    return (await this.db.query(`DELETE FROM ${this.db.schema}.function_invocations WHERE started_at<now()-interval '30 days'`)).rowCount;
  }
}
