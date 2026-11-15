import { z } from 'zod';
import { NotFound, requireScope } from '../core/identity.js';
import { objectRefSchema, type ObjectRef } from '../ontology/schema.js';
import { Access, PermissionDenied, resource, type Requirement } from './access.js';
import type { Database, Sql } from './database.js';
import type { Metadata, PublishedOntology } from './metadata.js';
import { Objects } from './objects.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().min(1).max(128);
const revision = z.number().int().positive();
const ownerId = z.string().min(1).max(200);
const events = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('source'), source: name, callId: sha256.optional(), receipt: objectRefSchema }),
  z.strictObject({ kind: z.literal('document'), ref: objectRefSchema, revision }),
  z.strictObject({ kind: z.literal('model'), state: z.enum(['started', 'completed', 'paused', 'failed', 'canceled']),
    model: name, attempt: name.optional(), durationMs: z.number().int().nonnegative().optional() }),
  z.strictObject({ kind: z.literal('egress'), state: z.enum(['allowed', 'blocked']), policyDigest: sha256,
    documentRefs: z.array(objectRefSchema).max(50).optional(), code: z.enum(['access_revoked', 'egress_policy_denied', 'invalid_context']).optional() }),
  z.strictObject({ kind: z.literal('proposal') }),
  z.strictObject({ kind: z.literal('approval'), revision, snapshot: sha256, reviewer: ownerId.optional() }),
  z.strictObject({ kind: z.literal('merge'), revision, approvalSnapshot: sha256.optional() }),
]);
export type TraceEvent = z.infer<typeof events>;

const traceAnchor = z.strictObject({
  owner: ownerId, release: name, projection: name,
  taskId: z.uuid().optional(), scenarioId: z.uuid().optional(), requestId: name.optional(),
}).refine(anchor => anchor.taskId || anchor.scenarioId || anchor.requestId, 'Trace needs a durable task, Scenario or Action identity');
export type TraceAnchor = z.infer<typeof traceAnchor>;

export const executionTraceSchema = z.strictObject({
  taskId: z.uuid().optional(), requestId: name.optional(),
  after: z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value => BigInt(value) <= 9223372036854775807n).default('0'),
  limit: z.number().int().min(1).max(100).default(50),
}).refine(input => Boolean(input.taskId) !== Boolean(input.requestId), 'Select exactly one task or Action');

export async function initializeExecutionTrace(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.execution_trace (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner text NOT NULL,
    release text NOT NULL REFERENCES ${db.schema}.releases(digest), projection text NOT NULL,
    task_id uuid, scenario_id uuid, request_id text, event jsonb NOT NULL,
    requirements jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (task_id IS NOT NULL OR scenario_id IS NOT NULL OR request_id IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS execution_trace_task ON ${db.schema}.execution_trace(owner,task_id,sequence) WHERE task_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS execution_trace_scenario ON ${db.schema}.execution_trace(owner,scenario_id,sequence) WHERE scenario_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS execution_trace_action ON ${db.schema}.execution_trace(owner,request_id,sequence) WHERE request_id IS NOT NULL;
  CREATE OR REPLACE FUNCTION ${db.schema}.reject_execution_trace_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Execution trace is append-only';
  END $$;
  CREATE OR REPLACE TRIGGER execution_trace_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON ${db.schema}.execution_trace
    FOR EACH STATEMENT EXECUTE FUNCTION ${db.schema}.reject_execution_trace_mutation();
  ALTER TABLE ${db.schema}.external_operations ADD COLUMN IF NOT EXISTS request_id text;
  ALTER TABLE ${db.schema}.external_operations ADD COLUMN IF NOT EXISTS task_id uuid;
  CREATE INDEX IF NOT EXISTS external_operations_action ON ${db.schema}.external_operations(owner,request_id) WHERE request_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS external_operations_task ON ${db.schema}.external_operations(owner,task_id) WHERE task_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS edit_history_action_trace ON ${db.schema}.edit_history(owner,request_id,sequence) WHERE request_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS edit_history_task_trace ON ${db.schema}.edit_history(owner,task_id,release,request_id) WHERE task_id IS NOT NULL;`);
}

/** Add causal evidence to the owning transaction without copying the operation's payload. */
export async function appendTrace(db: Database, anchor: TraceAnchor, data: TraceEvent, client?: Sql, requirements: readonly Requirement[] = []): Promise<void> {
  const origin = traceAnchor.parse(anchor), event = events.parse(data);
  if (event.kind === 'egress' && event.state === 'blocked' && event.documentRefs?.length) throw new Error('Blocked egress cannot record document identifiers');
  const write = (connection: Sql) => db.withTransactionOwner(connection, origin.owner, async () => {
    const recorded = await db.query(`INSERT INTO ${db.schema}.execution_trace(owner,release,projection,task_id,scenario_id,request_id,event,requirements)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8 FROM ${db.schema}.releases p WHERE p.digest=$2 AND p.projection=$3
      AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM ${db.schema}.tasks t WHERE t.owner=$1 AND t.id=$4 AND t.release=$2))
      AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM ${db.schema}.scenarios s WHERE s.owner=$1 AND s.id=$5 AND s.release=$2))`, [
      origin.owner, origin.release, origin.projection, origin.taskId ?? null, origin.scenarioId ?? null,
      origin.requestId ?? null, event, JSON.stringify(requirements),
    ], connection);
    if (!recorded.rowCount) throw new NotFound('Execution trace origin is unavailable');
  });
  if (client && client !== db.pool) await write(client);
  else await db.withOwner(origin.owner, () => db.transaction(write));
}

type TraceRow = {
  sequence: string; release: string; projection: string; task_id: string | null; scenario_id: string | null;
  request_id: string | null; occurred_at: Date; event: unknown; requirements: Requirement[];
};
type ActionRow = {
  request_id: string; action: string; release: string; projection: string; task_id: string | null;
  applied_at: Date; executor_kind: string | null; executor_id: string | null; changes: boolean;
};
type Root = { taskId: string | null; release: string; projection: string; state?: string };

export class ExecutionTrace {
  constructor(private readonly db: Database, private readonly metadata: Metadata) {}

  async read(access: Access, ontology: string, raw: unknown) {
    requireScope(access.principal, 'ontology:read');
    requireScope(access.principal, 'tasks:read');
    access.require(ontology, 'view_definition', ontology);
    const input = executionTraceSchema.parse(raw), { owner } = access.principal;
    return this.db.withOwner(owner, async () => {
      const root = await this.root(access, ontology, input);
      const db = this.db, schema = db.schema;
      const scenarios = (await db.query<{ scenario_id: string }>(`SELECT DISTINCT scenario_id FROM (
        SELECT scenario_id FROM ${schema}.execution_trace WHERE owner=$1 AND release=$2
          AND (task_id=$3 OR request_id=$4) AND scenario_id IS NOT NULL
        UNION ALL SELECT scenario_id FROM ${schema}.scenario_actions WHERE owner=$1 AND task_id=$3
      ) related ORDER BY scenario_id LIMIT 100`, [owner, root.release, root.taskId, input.requestId ?? null])).rows.map(row => row.scenario_id);
      const rows = (await db.query<TraceRow>(`SELECT sequence::text,release,projection,task_id,scenario_id,request_id,occurred_at,event,requirements
        FROM ${schema}.execution_trace WHERE owner=$1 AND release=$2 AND sequence>$6::bigint
          AND (task_id=$3 OR request_id=$4 OR scenario_id=ANY($5::uuid[]))
        ORDER BY sequence::bigint LIMIT $7`,
        [owner, root.release, root.taskId, input.requestId ?? null, scenarios, input.after, input.limit + 1])).rows;
      const model = await this.metadata.active(ontology);
      const visibleActions = await this.actions(access, ontology, root, input.requestId ?? null, scenarios);
      const actionIds = visibleActions.map(row => row.request_id);
      const visibleEvents = [];
      for (const row of rows.slice(0, input.limit)) {
        const parsed = events.safeParse(row.event);
        if (!parsed.success || !Array.isArray(row.requirements) || !await access.canReturn(row.requirements)) continue;
        const event = parsed.data;
        if (event.kind === 'merge' && (!row.request_id || !actionIds.includes(row.request_id))) continue;
        const refs = event.kind === 'document' ? [event.ref] : event.kind === 'source' ? [event.receipt]
          : event.kind === 'egress' ? event.documentRefs ?? [] : [];
        if (!await this.referencesVisible(access, model, refs)) continue;
        visibleEvents.push({ sequence: row.sequence, at: row.occurred_at, release: row.release, projection: row.projection,
          taskId: row.task_id, scenarioId: row.scenario_id,
          requestId: row.request_id && actionIds.includes(row.request_id) ? row.request_id : null, ...event });
      }
      const { effects, external } = await this.outcomes(access, root, actionIds);
      const history = (await db.query<{ request_id: string; sequence: string; type: string; id: string }>(`SELECT request_id,sequence::text,type,id
        FROM ${schema}.edit_history WHERE owner=$1 AND request_id=ANY($2::text[]) ORDER BY sequence::bigint LIMIT 100`,
        [owner, actionIds])).rows;
      const visibleHistory = [];
      for (const row of history)
        if (await this.referencesVisible(access, model, [row])) visibleHistory.push({ requestId: row.request_id, sequence: row.sequence });

      const sources = root.taskId ? (await db.query<{ name: string; state: string }>(`SELECT name,state FROM ${schema}.source_calls
        WHERE task_id=$1 AND name=ANY($2::text[]) ORDER BY name`, [root.taskId, visibleEvents.flatMap(event => event.kind === 'source' && event.callId ? [event.callId] : [])])).rows : [];
      if (!await access.canReturn(access.dataRequirements())) throw new PermissionDenied('Trace permissions changed');
      return {
        taskId: root.taskId, state: root.state, release: root.release, projection: root.projection,
        events: visibleEvents,
        actions: visibleActions.map(row => ({ requestId: row.request_id, taskId: row.task_id, action: row.action, release: row.release,
          projection: row.projection, executorKind: row.executor_kind, executorId: row.executor_id, appliedAt: row.applied_at, journaled: row.changes })),
        editHistory: visibleHistory,
        sourceCalls: sources.map(row => ({ callId: row.name, state: row.state })),
        effects, external,
        ...(rows.length > input.limit ? { next: rows[input.limit - 1]!.sequence } : {}),
      };
    });
  }

  private async root(access: Access, ontology: string, input: z.output<typeof executionTraceSchema>): Promise<Root> {
    const { db } = this, { owner } = access.principal;
    if (input.taskId) {
      const row = (await db.query<{ id: string; release: string; projection: string; state: string }>(`SELECT t.id,t.release,p.projection,t.state
        FROM ${db.schema}.tasks t JOIN ${db.schema}.releases p ON p.digest=t.release
        WHERE t.id=$1 AND t.owner=$2 AND p.body->>'id'=$3`, [input.taskId, owner, ontology])).rows[0];
      if (row) return { taskId: row.id, release: row.release, projection: row.projection, state: row.state };
    } else {
      const row = (await db.query<ActionRow>(`SELECT a.action,a.task_id,a.release,p.projection FROM ${db.schema}.actions a
        JOIN ${db.schema}.releases p ON p.digest=a.release WHERE a.owner=$1 AND a.request_id=$2 AND p.body->>'id'=$3`,
        [owner, input.requestId, ontology])).rows[0];
      if (row && access.allows({ ontology, permission: 'apply_action', resource: resource(ontology, 'action', row.action) }))
        return { taskId: row.task_id, release: row.release, projection: row.projection };
    }
    throw new NotFound('Execution trace is unavailable');
  }

  private async actions(access: Access, ontology: string, root: Root, requestId: string | null, scenarios: string[]) {
    const { db } = this, schema = db.schema;
    const rows = (await db.query<ActionRow>(`SELECT a.request_id,a.action,a.release,p.projection,a.task_id,a.applied_at,a.executor_kind,a.executor_id,
      EXISTS(SELECT 1 FROM ${schema}.action_changes j WHERE j.owner=a.owner AND j.request_id=a.request_id) AS changes
      FROM ${schema}.actions a JOIN ${schema}.releases p ON p.digest=a.release WHERE a.owner=$1 AND a.release=$2
        AND (a.task_id=$3 OR a.request_id=$4 OR EXISTS(SELECT 1 FROM ${schema}.edit_history h
          WHERE h.owner=a.owner AND h.release=a.release AND h.request_id=a.request_id AND h.task_id=$3::uuid::text)
          OR EXISTS(SELECT 1 FROM ${schema}.execution_trace trace
          WHERE trace.owner=a.owner AND trace.release=a.release AND trace.request_id=a.request_id AND trace.scenario_id=ANY($5::uuid[])
            AND trace.event->>'kind'='merge'))
      ORDER BY a.applied_at,a.request_id LIMIT 100`, [access.principal.owner, root.release, root.taskId, requestId, scenarios])).rows;
    return rows.filter(row => {
      const actionResource = resource(ontology, 'action', row.action);
      if (!access.allows({ ontology, permission: 'apply_action', resource: actionResource })) return false;
      access.require(ontology, 'apply_action', actionResource, true);
      return true;
    });
  }

  private async outcomes(access: Access, root: Root, requestIds: string[]) {
    const { db } = this, { owner } = access.principal;
    const rows = (await db.query<{ id: string; request_id: string; state: string; attempts: number; requirements: Requirement[] }>(
      `SELECT id,request_id,state,attempts,requirements FROM ${db.schema}.action_effects
        WHERE owner=$1 AND release=$2 AND request_id=ANY($3::text[]) ORDER BY id LIMIT 100`, [owner, root.release, requestIds])).rows;
    const effects = [];
    for (const row of rows)
      if (Array.isArray(row.requirements) && await access.canReturn(row.requirements))
        effects.push({ id: row.id, requestId: row.request_id, state: row.state, attempts: row.attempts });

    const receipts = (await db.query<{ operation_key: string; request_id: string | null; effect_id: string | null; state: string;
      created_at: Date; updated_at: Date; requirements: Requirement[] }>(`SELECT op.operation_key,coalesce(effect.request_id,op.request_id) AS request_id,
      effect.id AS effect_id,op.state,op.created_at,op.updated_at,op.requirements
      FROM ${db.schema}.external_operations op LEFT JOIN ${db.schema}.action_effects effect
        ON effect.owner=op.owner AND effect.id=op.operation_key AND effect.id=ANY($4::text[])
      WHERE op.owner=$1 AND (op.task_id=$2 OR op.request_id=ANY($3::text[]) OR effect.id IS NOT NULL)
        ORDER BY op.created_at,op.operation_key LIMIT 100`, [owner, root.taskId, requestIds, effects.map(row => row.id)])).rows;
    const external = [];
    for (const row of receipts)
      if (Array.isArray(row.requirements) && await access.canReturn(row.requirements))
        external.push({ receiptId: row.operation_key, requestId: row.request_id && requestIds.includes(row.request_id) ? row.request_id : null,
          effectId: row.effect_id, state: row.state, dispatchedAt: row.created_at, updatedAt: row.updated_at });
    return { effects, external };
  }

  private async referencesVisible(access: Access, model: PublishedOntology, refs: ObjectRef[]) {
    const graph = new Objects(this.db, model, access);
    for (const ref of refs) {
      if (!model.objects.has(ref.type) || !access.canRead(model, ref.type)) return false;
      try {
        const item = await graph.read({ type: ref.type, id: ref.id });
        if (item.properties[model.object(ref.type).primaryKey] !== ref.id) return false;
      } catch (error) {
        if (error instanceof PermissionDenied || error instanceof NotFound) return false;
        throw error;
      }
    }
    return true;
  }
}
