import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical, Conflict, digest, NotFound } from '../core/identity.js';
import { propertyPathSchema } from '../ontology/property-path.js';
import { objectRefSchema, type ObjectData, type ObjectRef } from '../ontology/schema.js';
import { Access, PermissionDenied } from './access.js';
import { Database, type Sql } from './database.js';
import { PublishedOntology } from './metadata.js';
import { nestedValue } from './query-filter.js';
import { Objects, querySchema } from './objects.js';

const setQuerySchema = querySchema.omit({ limit: true, cursor: true, select: true });
export type SetExpression =
  | { op: 'query'; query: z.input<typeof setQuerySchema> }
  | { op: 'refs'; objects: ObjectRef[] }
  | { op: 'union' | 'intersection'; sets: SetExpression[] }
  | { op: 'difference'; left: SetExpression; right: SetExpression }
  | { op: 'traverse'; set: SetExpression; path: { link: string; as?: string }[] }
  | { op: 'saved'; id: string };
const expression: z.ZodType<SetExpression> = z.lazy(() => z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('query'), query: setQuerySchema }),
  z.strictObject({ op: z.literal('refs'), objects: z.array(objectRefSchema).max(10000) }),
  z.strictObject({ op: z.literal('union'), sets: z.array(expression).min(2).max(20) }),
  z.strictObject({ op: z.literal('intersection'), sets: z.array(expression).min(2).max(20) }),
  z.strictObject({ op: z.literal('difference'), left: expression, right: expression }),
  z.strictObject({ op: z.literal('traverse'), set: expression, path: z.array(z.strictObject({ link: z.string().min(1).max(80), as: z.string().min(1).max(80).optional() })).min(1).max(8) }),
  z.strictObject({ op: z.literal('saved'), id: z.uuid() }),
]));

// Check depth before recursive parsing, including programmatic callers outside HTTP body limits.
function boundedExpression(input: unknown): boolean {
  const pending = [{ value: input, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 25000 || depth > 40) return false;
    if (Array.isArray(value)) pending.push(...value.map(value => ({ value, depth: depth + 1 })));
    else if (value && typeof value === 'object') pending.push(...Object.values(value).map(value => ({ value, depth: depth + 1 })));
  }
  return true;
}
export const setExpressionSchema = z.unknown().refine(boundedExpression, 'Object set expression is too large or deeply nested').pipe(expression);
export const evaluateSetSchema = z.strictObject({ set: setExpressionSchema, view: z.string().optional(), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().optional() });
const metricSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('count'), property: propertyPathSchema.optional() }),
  z.strictObject({ op: z.enum(['sum', 'min', 'max', 'avg']), property: propertyPathSchema }),
]);
export const aggregateSetSchema = z.strictObject({ set: setExpressionSchema, view: z.string().optional(), groupBy: z.array(propertyPathSchema).max(5).default([]), metrics: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), metricSchema).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 20) });
export const evaluateSetViewSchema = evaluateSetSchema.extend({ scenarioId: z.uuid().optional() });
export const aggregateSetViewSchema = aggregateSetSchema.extend({ scenarioId: z.uuid().optional() });
export const saveSetSchema = z.strictObject({ id: z.uuid().optional(), revision: z.number().int().positive().optional(), requestId: z.string().min(1).max(128), name: z.string().min(1).max(200), mode: z.enum(['static', 'dynamic']), set: setExpressionSchema, readers: z.array(z.string().min(1).max(200)).max(100).default([]) }).refine(value => Boolean(value.id) === Boolean(value.revision), 'Updating a set requires its ID and revision');
export const listSetsSchema = z.strictObject({ cursor: z.uuid().optional(), limit: z.number().int().min(1).max(100).default(50) });

export async function initializeObjectSets(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.object_sets (
    id uuid PRIMARY KEY, ontology text NOT NULL, owner text NOT NULL, request_id text NOT NULL,
    name text NOT NULL, mode text NOT NULL CHECK(mode IN('static','dynamic')), expression jsonb NOT NULL,
    readers jsonb NOT NULL DEFAULT '[]', revision bigint NOT NULL DEFAULT 1, input_digest text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(ontology,owner,request_id));
    CREATE INDEX IF NOT EXISTS object_sets_owner ON ${db.schema}.object_sets(ontology,owner,id);
    CREATE INDEX IF NOT EXISTS object_sets_readers ON ${db.schema}.object_sets USING gin(readers);`);
}

type SavedRow = { id: string; ontology: string; owner: string; name: string; mode: 'static' | 'dynamic'; expression: SetExpression; readers: string[]; revision: string | number; input_digest: string };
const refKey = (ref: ObjectRef) => canonical(ref);
const sorted = (objects: ObjectData[]) => objects.sort((a, b) => Buffer.compare(Buffer.from(refKey(a.ref)), Buffer.from(refKey(b.ref))));

/** Object sets reuse the live object's authorization and Scenario view for every evaluation. */
export class ObjectSets {
  constructor(private readonly db: Database, private readonly maximumObjects = 10000) {
    if (!Number.isInteger(maximumObjects) || maximumObjects < 1 || maximumObjects > 10000) throw new Error('Object set maximum must be between 1 and 10000');
  }
  private async snapshot<T>(access: Access, action: (client: Sql) => Promise<T>, saveAgainst?: PublishedOntology): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.db.transaction(async client => {
          await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', [], client);
          if (saveAgainst) {
            // Lock before the first read so a save sees any publication that made it wait.
            await this.db.query(`LOCK TABLE ${this.db.schema}.object_sets IN ROW EXCLUSIVE MODE`, [], client);
            const active = await this.db.query(`SELECT release FROM ${this.db.schema}.ontology WHERE id=$1`, [saveAgainst.document.id], client);
            if (active.rows[0]?.release !== saveAgainst.release) throw new Conflict('Object set publication changed; retry against the active Ontology');
          }
          await access.refresh(client);
          return action(client);
        });
        await access.refresh();
        return result;
      } catch (error) {
        const databaseError = error as { code?: string; constraint?: string };
        const raced = databaseError.code === '40001' || databaseError.code === '23505' && databaseError.constraint === 'object_sets_ontology_owner_request_id_key';
        if (!raced || attempt === 2) throw error;
      }
    }
  }
  private async saved(access: Access, model: PublishedOntology, id: string, client: Sql): Promise<SavedRow> {
    access.require(model.document.id, 'view_definition', model.document.id);
    const result = await this.db.query(`SELECT * FROM ${this.db.schema}.object_sets WHERE id=$1 AND ontology=$2 AND (owner=$3 OR readers ? $3)`, [z.uuid().parse(id), model.document.id, access.principal.owner], client);
    if (!result.rows[0]) throw new NotFound('Object set is unavailable');
    return result.rows[0] as SavedRow;
  }
  private metadata(row: SavedRow, owner: string) {
    return { id: row.id, name: row.name, mode: row.mode, revision: Number(row.revision), owned: row.owner === owner,
      ...(row.owner === owner ? { set: row.expression, readers: row.readers } : {}) };
  }
  private async resolve(access: Access, model: PublishedOntology, set: SetExpression, client: Sql, rootId?: string) {
    const objects = new Objects(this.db, model, access, client), loaded = new Map<string, ObjectData>();
    let operations = 0;
    const count = () => { if (++operations > 25000) throw new Conflict('Object set evaluation exceeds the operation limit'); };
    const bounded = (items: Map<string, ObjectData>) => {
      if (items.size > this.maximumObjects) throw new Conflict('Object set exceeds the complete evaluation limit');
      return items;
    };
    const read = async (ref: ObjectRef) => {
      const key = refKey(ref);
      if (loaded.has(key)) return loaded.get(key)!;
      count();
      const object = await objects.read(ref); loaded.set(key, object); return object;
    };
    const visit = async (node: SetExpression, savedIds: Set<string>, depth = 0): Promise<Map<string, ObjectData>> => {
      count();
      if (depth > 16) throw new Conflict('Object set composition exceeds the depth limit');
      const result = new Map<string, ObjectData>();
      const add = (object: ObjectData) => { result.set(refKey(object.ref), object); bounded(result); };
      switch (node.op) {
        case 'query': {
          let cursor: string | undefined;
          do {
            count();
            const page = await objects.query({ ...node.query, limit: 100, cursor });
            for (const object of page.items) {
              if (node.query.type === object.ref.type) loaded.set(refKey(object.ref), object);
              add(await read(object.ref));
            }
            cursor = page.cursor;
          } while (cursor);
          return result;
        }
        case 'refs':
          for (const ref of node.objects) {
            if (!model.objects.has(ref.type)) continue;
            try { add(await read(ref)); }
            catch (error) { if (!(error instanceof NotFound) && !(error instanceof PermissionDenied)) throw error; }
          }
          return result;
        case 'saved': {
          if (savedIds.has(node.id)) throw new Conflict('Object set references form a cycle');
          const saved = await this.saved(access, model, node.id, client);
          return visit(setExpressionSchema.parse(saved.expression), new Set([...savedIds, node.id]), depth + 1);
        }
        case 'traverse': {
          let current = await visit(node.set, savedIds, depth + 1);
          for (const step of node.path) {
            const next = new Map<string, ObjectData>();
            for (const object of current.values()) {
              const navigation = model.navigation(object.ref.type, step.link, step.as);
              let cursor: string | undefined;
              do {
                count();
                const page = await objects.query({ type: navigation.target, from: { object: object.ref, link: step.link, as: step.as }, limit: 100, cursor });
                for (const target of page.items) { next.set(refKey(target.ref), target); loaded.set(refKey(target.ref), target); bounded(next); }
                cursor = page.cursor;
              } while (cursor);
            }
            current = next;
          }
          return current;
        }
        case 'union':
          for (const child of node.sets) for (const object of (await visit(child, savedIds, depth + 1)).values()) add(object);
          return result;
        case 'intersection': {
          const first = await visit(node.sets[0]!, savedIds, depth + 1);
          for (const child of node.sets.slice(1)) {
            const other = await visit(child, savedIds, depth + 1);
            for (const key of first.keys()) if (!other.has(key)) first.delete(key);
          }
          return first;
        }
        case 'difference': {
          const left = await visit(node.left, savedIds, depth + 1), right = await visit(node.right, savedIds, depth + 1);
          for (const key of right.keys()) left.delete(key);
          return left;
        }
      }
    };
    return sorted([...(await visit(set, new Set(rootId ? [rootId] : []))).values()]);
  }
  private project(model: PublishedOntology, object: ObjectData, view?: string): ObjectData {
    if (!view || view === object.ref.type) return object;
    if (!model.implements(object.ref.type, view)) throw new Conflict('The requested view is incompatible with an object in this set');
    const properties = model.interfaces.get(view)?.properties;
    if (!properties) throw new Conflict('Use an Object Type or Interface view');
    return { ...object, properties: Object.fromEntries(Object.keys(properties).map(name => {
      const local = model.propertyName(object.ref.type, view, name);
      return [name, local ? object.properties[local] ?? null : null];
    })) };
  }
  async evaluate(access: Access, model: PublishedOntology, raw: unknown) {
    const input = evaluateSetSchema.parse(raw);
    return this.snapshot(access, async client => {
      if (input.view) access.definition(model, model.interfaces.has(input.view) ? 'interface' : 'object', input.view);
      const all = (await this.resolve(access, model, input.set, client)).map(object => this.project(model, object, input.view));
      const identity = digest({ owner: access.principal.owner, release: model.release, scenario: model.scenario, set: input.set, view: input.view, objects: all });
      const offset = input.cursor ? z.strictObject({ identity: z.literal(identity), offset: z.number().int().nonnegative().max(all.length) }).parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString())).offset : 0;
      const end = offset + input.limit;
      return { items: all.slice(offset, end), total: all.length, cursor: end < all.length ? Buffer.from(JSON.stringify({ identity, offset: end })).toString('base64url') : undefined };
    });
  }
  async aggregate(access: Access, model: PublishedOntology, raw: unknown) {
    const input = aggregateSetSchema.parse(raw);
    return this.snapshot(access, async client => {
      if (input.view) access.definition(model, model.interfaces.has(input.view) ? 'interface' : 'object', input.view);
      const all = (await this.resolve(access, model, input.set, client)).map(object => this.project(model, object, input.view));
      const fields = new Set([...input.groupBy, ...Object.values(input.metrics).flatMap(metric => metric.property ? [metric.property] : [])]);
      const types = new Set(input.view ? [input.view] : all.map(object => object.ref.type));
      if (!types.size && input.set.op === 'query') types.add(input.set.query.type);
      for (const type of types) for (const field of fields) model.propertyPath(type, field);
      const groups = new Map<string, { keys: Record<string, unknown>; objects: ObjectData[] }>();
      if (!input.groupBy.length) groups.set('all', { keys: {}, objects: [] });
      const field = (object: ObjectData, name: string) => nestedValue(object.properties, name);
      for (const object of all) {
        const keys = Object.fromEntries(input.groupBy.map(name => [name, field(object, name)])), key = canonical(keys);
        const group = input.groupBy.length ? groups.get(key) ?? { keys, objects: [] } : groups.get('all')!;
        group.objects.push(object);
        if (input.groupBy.length) groups.set(key, group);
      }
      const items = [...groups.values()].map(group => {
        const metrics = Object.fromEntries(Object.entries(input.metrics).map(([name, metric]) => {
          const values = metric.property ? group.objects.map(object => field(object, metric.property!)).filter(value => value !== null) : group.objects;
          if (metric.op === 'count') return [name, values.length];
          if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Conflict('Numeric aggregation requires finite numeric properties');
          const numbers = values as number[];
          let value: number | null = null;
          if (numbers.length) {
            if (metric.op === 'min') value = Math.min(...numbers);
            else if (metric.op === 'max') value = Math.max(...numbers);
            else { value = numbers.reduce((sum, item) => sum + item, 0); if (metric.op === 'avg') value /= numbers.length; }
            if (!Number.isFinite(value)) throw new Conflict('Numeric aggregation overflow');
          }
          return [name, value];
        }));
        return { group: group.keys, metrics };
      });
      return { count: all.length, items };
    });
  }
  async save(access: Access, model: PublishedOntology, raw: unknown) {
    const input = saveSetSchema.parse(raw), owner = access.principal.owner;
    if (model.scenario) throw new Conflict('Save object sets against the live Ontology');
    access.require(model.document.id, 'view_definition', model.document.id);
    const fingerprint = digest(input);
    return this.snapshot(access, async client => {
      // Serializes create retries and optimistic updates without holding a data edit lock.
      await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [canonical(['object-set', model.document.id, owner, input.id ?? input.requestId])], client);
      if (input.id) {
        const existing = await this.saved(access, model, input.id, client);
        if (existing.owner !== owner) throw new PermissionDenied('Only the owner can edit this object set');
        if (existing.input_digest === fingerprint) return this.metadata(existing, owner);
        if (Number(existing.revision) !== input.revision) throw new Conflict('Object set revision changed');
      } else {
        const prior = await this.db.query(`SELECT * FROM ${this.db.schema}.object_sets WHERE ontology=$1 AND owner=$2 AND request_id=$3`, [model.document.id, owner, input.requestId], client);
        if (prior.rows[0]) {
          if (prior.rows[0].input_digest !== fingerprint) throw new Conflict('Object set request ID has different input');
          return this.metadata(prior.rows[0] as SavedRow, owner);
        }
      }
      const objects = await this.resolve(access, model, input.set, client, input.id);
      const stored: SetExpression = input.mode === 'static' ? { op: 'refs', objects: objects.map(object => object.ref) } : input.set;
      const result = input.id
        ? await this.db.query(`UPDATE ${this.db.schema}.object_sets SET name=$3,mode=$4,expression=$5,readers=$6,revision=revision+1,input_digest=$7,updated_at=now() WHERE id=$1 AND owner=$2 AND revision=$8 RETURNING *`, [input.id, owner, input.name, input.mode, JSON.stringify(stored), JSON.stringify([...new Set(input.readers)]), fingerprint, input.revision], client)
        : await this.db.query(`INSERT INTO ${this.db.schema}.object_sets(id,ontology,owner,request_id,name,mode,expression,readers,input_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [randomUUID(), model.document.id, owner, input.requestId, input.name, input.mode, JSON.stringify(stored), JSON.stringify([...new Set(input.readers)]), fingerprint], client);
      if (!result.rows[0]) throw new Conflict('Object set revision changed');
      return this.metadata(result.rows[0] as SavedRow, owner);
    }, model);
  }
  async get(access: Access, model: PublishedOntology, id: string) {
    return this.snapshot(access, async client => this.metadata(await this.saved(access, model, id, client), access.principal.owner));
  }
  async list(access: Access, model: PublishedOntology, raw: unknown = {}) {
    const input = listSetsSchema.parse(raw);
    access.require(model.document.id, 'view_definition', model.document.id);
    return this.snapshot(access, async client => {
      const result = await this.db.query(`SELECT * FROM ${this.db.schema}.object_sets WHERE ontology=$1 AND (owner=$2 OR readers ? $2) AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`, [model.document.id, access.principal.owner, input.cursor ?? null, input.limit + 1], client);
      const rows = result.rows.slice(0, input.limit) as SavedRow[];
      return { items: rows.map(row => this.metadata(row, access.principal.owner)), cursor: result.rows.length > input.limit ? rows.at(-1)!.id : undefined };
    });
  }
  async remove(access: Access, model: PublishedOntology, id: string, revision: number) {
    z.number().int().positive().parse(revision);
    return this.snapshot(access, async client => {
      const row = await this.saved(access, model, id, client);
      if (row.owner !== access.principal.owner) throw new PermissionDenied('Only the owner can delete this object set');
      const result = await this.db.query(`DELETE FROM ${this.db.schema}.object_sets WHERE id=$1 AND owner=$2 AND revision=$3`, [row.id, row.owner, revision], client);
      if (!result.rowCount) throw new Conflict('Object set revision changed');
      return { id: row.id, deleted: true };
    });
  }
}
