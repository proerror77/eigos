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
    CREATE INDEX IF NOT EXISTS edit_history_object ON ${db.schema}.edit_history(owner,type,id,sequence);`);
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
async function stored(graph: Objects, ref: ObjectRef): Promise<Properties | null> {
  const row = (await graph.db.query(`SELECT properties FROM ${graph.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`,key(graph,ref),graph.client)).rows[0];
  return row?.properties ?? null;
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
async function append(graph: Objects, ref: ObjectRef, operation: string, before: Properties | null, after: Properties | null, source: string | null) {
  if (digest(before) === digest(after)) return;
  await graph.db.query(`INSERT INTO ${graph.db.schema}.edit_history(projection,owner,type,id,release,operation,source,before_values,after_values,actor)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[...key(graph,ref),graph.model.release,operation,source,before,after,graph.access.principal.owner],graph.client);
}

/** Called after the live mutation, in the same transaction. Scenario deltas are journaled when merged. */
export async function recordObjectEdit(graph: Objects, ref: ObjectRef, before: Properties | null, after: Properties | null, changedFields?: Properties, kind: 'create' | 'edit' | 'delete' = 'edit') {
  if (graph.model.scenario || digest(before) === digest(after)) return;
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

/** Persists a source baseline and resolves it with user edits. The caller writes the returned object value. */
export async function resolveSourceEdit(graph: Objects, ref: ObjectRef, incoming: Properties | null, source = 'default', observedAt?: string): Promise<Properties | null> {
  requireTransaction(graph);
  if (graph.model.scenario) throw new Conflict('Source ingestion requires the live projection');
  const before = await stored(graph,ref);
  const candidateTime = observedAt ?? (typeof incoming?.observedAt === 'string' ? incoming.observedAt : new Date().toISOString());
  const observed = z.iso.datetime({offset:true}).parse(candidateTime);
  const prior = (await graph.db.query(`SELECT properties,observed_at FROM ${graph.db.schema}.source_values WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4 AND source=$5`,[...key(graph,ref),source],graph.client)).rows[0];
  if (prior && new Date(prior.observed_at).getTime() > Date.parse(observed)) return before;
  if (prior && new Date(prior.observed_at).getTime() === Date.parse(observed) && digest(prior.properties) !== digest(incoming)) throw new Conflict('One source timestamp contains conflicting object data');
  await graph.db.query(`INSERT INTO ${graph.db.schema}.source_values(projection,owner,type,id,source,properties,observed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(projection,owner,type,id,source) DO UPDATE SET properties=excluded.properties,observed_at=excluded.observed_at`,[...key(graph,ref),source,incoming,observed],graph.client);
  const edits = await state(graph,ref);
  let resolved: Properties | null = null;
  if (!edits.deleted) {
    const rows = (await graph.db.query(`SELECT properties,observed_at,source FROM ${graph.db.schema}.source_values WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4 ORDER BY observed_at,source`,key(graph,ref),graph.client)).rows;
    const times = new Map<string,number>();
    for (const row of rows) {
      if (row.properties === null) continue;
      resolved ??= {};
      for (const [field, value] of Object.entries(row.properties)) {
        resolved[field] = value;
        times.set(field,new Date(row.observed_at).getTime());
      }
    }
    if (edits.created) resolved ??= {};
    const policy = (await graph.db.query(`SELECT policy FROM ${graph.db.schema}.edit_policies WHERE ontology=$1 AND type=$2`,[graph.model.document.id,ref.type],graph.client)).rows[0]?.policy ?? 'user_wins';
    if (resolved) for (const [field, edit] of Object.entries(edits.overrides)) {
      if (policy === 'user_wins' || !times.has(field) || Date.parse(edit.at) > times.get(field)!) resolved[field] = edit.value;
    }
  }
  if (resolved) resolved = graph.model.parseObject(ref,resolved);
  await append(graph,ref,'source',before,resolved,source);
  return resolved;
}

export class EditHistory {
  constructor(private readonly db: Database) {}
  async read(graph: Objects, ref: ObjectRef, after = '0', limit = 100) {
    z.string().regex(/^\d+$/).parse(after); z.number().int().min(1).max(100).parse(limit);
    // Current object visibility governs historical data too. Deleted instances cannot be loaded through this endpoint.
    await graph.read(ref);
    const rows = (await this.db.query(`SELECT sequence::text,operation,source,before_values,after_values,actor,happened_at,release
      FROM ${this.db.schema}.edit_history WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4 AND sequence>$5::bigint ORDER BY sequence LIMIT $6`,[...key(graph,ref),after,limit+1],graph.client)).rows;
    const mask = (properties: Properties | null) => properties && Object.fromEntries(Object.entries(properties).map(([field,value]) => [field,graph.access.property(graph.model,ref.type,field) ? value : null]));
    const items = rows.slice(0,limit).map(row => ({ sequence: row.sequence, operation: row.operation, source: row.source, before: mask(row.before_values), after: mask(row.after_values), actor: row.actor, at: row.happened_at, release: row.release }));
    await graph.access.refresh(graph.client);
    return { items, cursor: rows.length > limit ? items.at(-1)!.sequence : undefined };
  }
}

/** A replacement publication carries conflict baselines and overlays forward with the resolved objects. */
export async function copyEditState(db: Database, from: string, to: string, client: Sql) {
  for (const table of ['source_values','object_edits'] as const) {
    const columns = table === 'source_values' ? 'owner,type,id,source,properties,observed_at' : 'owner,type,id,overrides,deleted,created';
    await db.query(`INSERT INTO ${db.schema}.${table}(projection,${columns}) SELECT $2,${columns} FROM ${db.schema}.${table} WHERE projection=$1 ON CONFLICT DO NOTHING`,[from,to],client);
  }
}
