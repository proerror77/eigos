import { z } from 'zod';
import { Conflict, digest } from '../core/identity.js';
import type { ObjectRef } from '../ontology/schema.js';
import type { Database, Sql } from './database.js';
import type { Objects } from './objects.js';
import type { Access } from './access.js';
import type { PublishedOntology } from './metadata.js';

export const conflictPolicySchema = z.enum(['user_wins', 'latest_value']);
type Properties = Record<string, unknown>;
type Override = { value: unknown; at: string };
interface EditState { overrides: Record<string, Override>; deleted: boolean; created: boolean }

export async function initializeEditHistory(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.source_values (
    projection text NOT NULL, owner text NOT NULL, type text NOT NULL, id text NOT NULL,
    source text NOT NULL, properties jsonb, observed_at timestamptz NOT NULL,
    PRIMARY KEY(projection,owner,type,id,source));
    CREATE TABLE IF NOT EXISTS ${db.schema}.object_edits (
      projection text NOT NULL, owner text NOT NULL, type text NOT NULL, id text NOT NULL,
      overrides jsonb NOT NULL DEFAULT '{}', deleted boolean NOT NULL DEFAULT false,
      created boolean NOT NULL DEFAULT false, PRIMARY KEY(projection,owner,type,id));
    CREATE TABLE IF NOT EXISTS ${db.schema}.edit_policies (
      ontology text NOT NULL, type text NOT NULL, policy text NOT NULL CHECK(policy IN('user_wins','latest_value')),
      PRIMARY KEY(ontology,type));
    CREATE TABLE IF NOT EXISTS ${db.schema}.edit_history (
      sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, projection text NOT NULL, release text NOT NULL,
      owner text NOT NULL, type text NOT NULL, id text NOT NULL, operation text NOT NULL,
      source text, before_values jsonb, after_values jsonb, actor text NOT NULL,
      happened_at timestamptz NOT NULL DEFAULT clock_timestamp());
    ALTER TABLE ${db.schema}.edit_history ADD COLUMN IF NOT EXISTS action text;
    ALTER TABLE ${db.schema}.edit_history ADD COLUMN IF NOT EXISTS request_id text;
    ALTER TABLE ${db.schema}.edit_history ADD COLUMN IF NOT EXISTS task_id text;
    ALTER TABLE ${db.schema}.edit_history ADD COLUMN IF NOT EXISTS observed_at timestamptz;
    ALTER TABLE ${db.schema}.edit_history ADD COLUMN IF NOT EXISTS executor_kind text;
    ALTER TABLE ${db.schema}.edit_history ADD COLUMN IF NOT EXISTS executor_id text;
    CREATE INDEX IF NOT EXISTS edit_history_object ON ${db.schema}.edit_history(owner,type,id,sequence);
    CREATE INDEX IF NOT EXISTS edit_history_process_cursor ON ${db.schema}.edit_history(owner,type,sequence);`);
}

export async function setConflictPolicy(db: Database, access: Access, model: PublishedOntology, type: string, policy: unknown) {
  model.object(type);
  await access.refresh();
  access.require(model.document.id, 'manage_definition', model.document.id);
  await db.transaction(async client => {
    await access.refresh(client);
    await db.query(`INSERT INTO ${db.schema}.edit_policies(ontology,type,policy) VALUES($1,$2,$3)
      ON CONFLICT(ontology,type) DO UPDATE SET policy=excluded.policy`, [model.document.id,type,conflictPolicySchema.parse(policy)],client);
  });
  return { type, policy };
}

const key = (graph: Objects, ref: ObjectRef) => [graph.model.projection, graph.owner, ref.type, ref.id];
function requireTransaction(graph: Objects) {
  if (graph.client === graph.db.pool) throw new Conflict('Edit history must share the object transaction');
}
async function state(graph: Objects, ref: ObjectRef): Promise<EditState> {
  const row = (await graph.db.query(`SELECT overrides,deleted,created FROM ${graph.db.schema}.object_edits WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`,key(graph,ref),graph.client)).rows[0];
  return row ? { overrides: row.overrides, deleted: row.deleted, created: row.created } : { overrides: {}, deleted: false, created: false };
}
async function saveState(graph: Objects, ref: ObjectRef, value: EditState) {
  await graph.db.query(`INSERT INTO ${graph.db.schema}.object_edits(projection,owner,type,id,overrides,deleted,created)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(projection,owner,type,id) DO UPDATE
    SET overrides=excluded.overrides,deleted=excluded.deleted,created=excluded.created`,[...key(graph,ref),value.overrides,value.deleted,value.created],graph.client);
}
async function append(graph: Objects, ref: ObjectRef, operation: string, before: Properties | null, after: Properties | null, source: string | null, observedAt?: string) {
  if (operation === 'source' && digest(before) === digest(after)) return;
  await graph.db.query(`INSERT INTO ${graph.db.schema}.edit_history(projection,owner,type,id,release,operation,source,before_values,after_values,actor,action,request_id,task_id,observed_at,executor_kind,executor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[...key(graph,ref),graph.model.release,operation,source,before,after,graph.access.principal.owner,
    graph.change?.action??null,graph.change?.requestId??null,graph.change?.taskId??null,observedAt??null,
    graph.change?.executor?.kind??null,graph.change?.executor?.id??null],graph.client);
}

/** Called after the live mutation, in the same transaction. Scenario deltas are journaled when merged. */
export async function recordObjectEdit(graph: Objects, ref: ObjectRef, before: Properties | null, after: Properties | null, changedFields?: Properties, kind: 'create' | 'edit' | 'delete' = 'edit') {
  if (graph.model.scenario) return;
  requireTransaction(graph);
  const value = await state(graph,ref);
  const at = (await graph.db.query('SELECT clock_timestamp() AS at',[],graph.client)).rows[0]!.at.toISOString();
  if (before) await graph.db.query(`INSERT INTO ${graph.db.schema}.source_values(projection,owner,type,id,source,properties,observed_at)
    SELECT $1,$2,$3,$4,'__legacy__',$5,'-infinity'::timestamptz WHERE NOT EXISTS
    (SELECT 1 FROM ${graph.db.schema}.source_values WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4)
    ON CONFLICT DO NOTHING`,[...key(graph,ref),before],graph.client);
  if (kind === 'create') {
    value.overrides = {};
    value.created = true;
  }
  value.deleted = after === null;
  if (after) for (const [field, fieldValue] of Object.entries(changedFields ?? after)) value.overrides[field] = { value: fieldValue, at };
  await saveState(graph,ref,value);
  await append(graph,ref,kind,before,after,null);
}

/** One source observation of an object, with the stored value it may replace. */
export interface SourceObservation { ref: ObjectRef; incoming: Properties | null; before: Properties | null }
/** The value to store for an observed object. A stale observation leaves the stored value current. */
export interface ResolvedSource { value: Properties | null; current: boolean }
type Baseline = { source: string; properties: Properties | null; observed_at: unknown };

const objectKey = (ref: { type: string; id: string }) => JSON.stringify([ref.type, ref.id]);
const keyRows = (refs: readonly ObjectRef[]) => JSON.stringify(refs.map(({ type, id }) => ({ type, id })));

/**
 * Persists the source baselines of a batch and resolves each object with its user edits, in input order.
 * Each object needs the same decisions as a single observation; the statements are shared by the batch.
 * The caller writes the returned object values in the same transaction.
 */
export async function resolveSourceEdits(graph: Objects, observations: readonly SourceObservation[], source = 'default', observedAt?: string): Promise<ResolvedSource[]> {
  requireTransaction(graph);
  if (graph.model.scenario) throw new Conflict('Source ingestion requires the live projection');
  if (!observations.length) return [];
  const { db, model, client, change } = graph, scope = [model.projection, graph.owner];
  const matching = (alias: string) => `JOIN jsonb_to_recordset($3::jsonb) AS k(type text,id text) ON ${alias}.type=k.type AND ${alias}.id=k.id
    WHERE ${alias}.projection=$1 AND ${alias}.owner=$2`;
  const group = (rows: (Baseline & { type: string; id: string })[]) => {
    const grouped = new Map<string, Baseline[]>();
    for (const row of rows) grouped.set(objectKey(row), [...grouped.get(objectKey(row)) ?? [], row]);
    return grouped;
  };
  const keys = keyRows(observations.map(item => item.ref));
  const baselines = group((await db.query(`SELECT s.type,s.id,s.source,s.properties,s.observed_at FROM ${db.schema}.source_values s ${matching('s')}`,
    [...scope, keys], client)).rows as (Baseline & { type: string; id: string })[]);
  const edits = new Map((await db.query(`SELECT e.type,e.id,e.overrides,e.deleted,e.created FROM ${db.schema}.object_edits e ${matching('e')}`,
    [...scope, keys], client)).rows.map(row => [objectKey(row as { type: string; id: string }),
    { overrides: row.overrides, deleted: row.deleted, created: row.created } as EditState]));
  const now = new Date().toISOString();
  const plans = observations.map(item => {
    const key = objectKey(item.ref), rows = baselines.get(key) ?? [];
    const state = edits.get(key) ?? { overrides: {}, deleted: false, created: false };
    const candidateTime = observedAt ?? (typeof item.incoming?.observedAt === 'string' ? item.incoming.observedAt : now);
    const observed = z.iso.datetime({offset:true}).parse(candidateTime);
    let prior: Baseline | undefined = rows.find(row => row.source === source), legacy: Baseline | undefined;
    // An upgraded row has no source history yet. Retain its observed time before handling the first refresh or deletion.
    if (!prior && item.before && !state.created && rows.every(row => row.source === '__legacy__')) {
      const baseline = rows.find(row => row.source === '__legacy__')?.properties ?? item.before;
      const timestamp = z.iso.datetime({offset:true}).safeParse(baseline.observedAt);
      if (timestamp.success) prior = legacy = { source, properties: baseline, observed_at: timestamp.data };
    }
    const priorTime = prior && new Date(prior.observed_at as string).getTime();
    const stale = priorTime !== undefined && priorTime > Date.parse(observed);
    if (!stale && prior && priorTime === Date.parse(observed) && digest(prior.properties) !== digest(item.incoming))
      throw new Conflict('One source timestamp contains conflicting object data');
    return { item, key, observed, state, stale, legacy };
  });
  const current = plans.filter(plan => !plan.stale);
  const baselineRows = [
    ...current.map(plan => ({ ...plan.item.ref, properties: plan.item.incoming, observed_at: plan.observed })),
    // A stale observation keeps the stored value, but an upgraded row records the baseline it was compared with.
    ...plans.filter(plan => plan.stale && plan.legacy).map(plan => ({ ...plan.item.ref, ...plan.legacy! })),
  ].map(({ type, id, properties, observed_at }) => ({ type, id, properties, observed_at }));
  if (current.length) await db.query(`DELETE FROM ${db.schema}.source_values s USING jsonb_to_recordset($3::jsonb) AS k(type text,id text)
    WHERE s.projection=$1 AND s.owner=$2 AND s.type=k.type AND s.id=k.id AND s.source='__legacy__'`,
    [...scope, keyRows(current.map(plan => plan.item.ref))], client);
  if (baselineRows.length) await db.query(`INSERT INTO ${db.schema}.source_values(projection,owner,type,id,source,properties,observed_at)
    SELECT $1,$2,r.type,r.id,$3,r.properties,r.observed_at FROM jsonb_to_recordset($4::jsonb) AS r(type text,id text,properties jsonb,observed_at timestamptz)
    ON CONFLICT(projection,owner,type,id,source) DO UPDATE SET properties=excluded.properties,observed_at=excluded.observed_at`,
    [...scope, source, JSON.stringify(baselineRows)], client);
  const resolving = current.filter(plan => !plan.state.deleted);
  const merged = resolving.length ? group((await db.query(`SELECT s.type,s.id,s.properties,s.observed_at,s.source FROM ${db.schema}.source_values s ${matching('s')}
    ORDER BY s.type,s.id,s.observed_at,s.source`, [...scope, keyRows(resolving.map(plan => plan.item.ref))], client)).rows as (Baseline & { type: string; id: string })[]) : new Map<string, Baseline[]>();
  const types = [...new Set(resolving.map(plan => plan.item.ref.type))];
  const policies = new Map(types.length ? (await db.query(`SELECT type,policy FROM ${db.schema}.edit_policies WHERE ontology=$1 AND type=ANY($2::text[])`,
    [model.document.id, types], client)).rows.map(row => [String(row.type), String(row.policy)]) : []);
  const history: { position: number; type: string; id: string; before_values: Properties | null; after_values: Properties | null; observed_at: string }[] = [];
  const results = plans.map(({ item, key, observed, state, stale }): ResolvedSource => {
    if (stale) return { value: item.before, current: false };
    const { ref } = item, fields = model.object(ref.type).properties;
    let resolved: Properties | null = null;
    if (!state.deleted) {
      const times = new Map<string,number>();
      for (const row of merged.get(key) ?? []) {
        if (row.properties === null) continue;
        resolved ??= {};
        for (const [field, value] of Object.entries(row.properties)) {
          if(!fields[field])continue;
          resolved[field] = value;
          const timestamp=new Date(row.observed_at as string).getTime();
          times.set(field,Number.isFinite(timestamp)?timestamp:-Infinity);
        }
      }
      if (state.created) resolved ??= {};
      const policy = policies.get(ref.type) ?? 'user_wins';
      if (resolved) for (const [field, edit] of Object.entries(state.overrides)) {
        if(!fields[field])continue;
        if (policy === 'user_wins' || !times.has(field) || Date.parse(edit.at) > times.get(field)!) resolved[field] = edit.value;
      }
    }
    if (resolved) resolved = model.parseObject(ref,resolved);
    if (digest(item.before) !== digest(resolved))
      history.push({ position: history.length, type: ref.type, id: ref.id, before_values: item.before, after_values: resolved, observed_at: observed });
    return { value: resolved, current: true };
  });
  if (history.length) await db.query(`INSERT INTO ${db.schema}.edit_history(projection,owner,type,id,release,operation,source,before_values,after_values,actor,action,request_id,task_id,observed_at,executor_kind,executor_id)
    SELECT $1,$2,h.type,h.id,$3,'source',$4,h.before_values,h.after_values,$5,$6,$7,$8,h.observed_at,$9,$10
    FROM jsonb_to_recordset($11::jsonb) AS h(position integer,type text,id text,before_values jsonb,after_values jsonb,observed_at timestamptz) ORDER BY h.position`,
    [...scope, model.release, source, graph.access.principal.owner, change?.action ?? null, change?.requestId ?? null, change?.taskId ?? null,
      change?.executor?.kind ?? null, change?.executor?.id ?? null, JSON.stringify(history)], client);
  return results;
}

export class EditHistory {
  constructor(private readonly db: Database) {}
  async read(graph: Objects, ref: ObjectRef, after = '0', limit = 100) {
    z.string().regex(/^\d+$/).parse(after); z.number().int().min(1).max(100).parse(limit);
    // Current object visibility governs historical data too. Deleted instances cannot be loaded through this endpoint.
    await graph.read(ref);
    const rows = (await this.db.query(`SELECT h.sequence::text,h.operation,h.source,h.before_values,h.after_values,h.actor,h.happened_at,h.release,h.action,h.request_id,h.task_id,h.observed_at,h.executor_kind,h.executor_id
      FROM ${this.db.schema}.edit_history h JOIN ${this.db.schema}.releases r ON r.digest=h.release
      WHERE r.body->>'id'=$1 AND h.owner=$2 AND h.type=$3 AND h.id=$4 AND h.sequence>$5::bigint ORDER BY h.sequence LIMIT $6`,[graph.model.document.id,graph.owner,ref.type,ref.id,after,limit+1],graph.client)).rows;
    const mask = (properties: Properties | null) => properties && graph.maskSnapshot(ref,properties);
    const items = rows.slice(0,limit).map(row => ({ sequence: row.sequence, operation: row.operation, source: row.source, before: mask(row.before_values), after: mask(row.after_values), actor: row.actor, at: row.happened_at, release: row.release,
      action: row.action, requestId: row.request_id, taskId: row.task_id, observedAt: row.observed_at,
      executor: row.executor_kind && row.executor_id ? { kind: row.executor_kind, id: row.executor_id } : null }));
    await graph.access.refresh(graph.client);
    return { items, cursor: rows.length > limit ? items.at(-1)!.sequence : undefined };
  }
}

/** A replacement publication carries conflict baselines and overlays forward with the resolved objects. */
export async function copyEditState(db: Database, from: string, to: string, client: Sql, types?: readonly string[]) {
  if(from===to)throw new Conflict('A replacement projection must differ from its source');
  for (const table of ['source_values','object_edits'] as const) {
    const columns = table === 'source_values' ? 'owner,type,id,source,properties,observed_at' : 'owner,type,id,overrides,deleted,created';
    await db.query(`DELETE FROM ${db.schema}.${table} WHERE projection=$1`,[to],client);
    await db.query(`INSERT INTO ${db.schema}.${table}(projection,${columns}) SELECT $2,${columns} FROM ${db.schema}.${table} WHERE projection=$1 AND ($3::text[] IS NULL OR type=ANY($3::text[]))`,[from,to,types??null],client);
  }
}
