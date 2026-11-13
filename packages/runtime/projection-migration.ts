import { Conflict, digest } from '../core/identity.js';
import type { Ontology } from '../ontology/model.js';
import type { ObjectRef } from '../ontology/schema.js';
import type { Database, Sql } from './database.js';
import type { ProjectionTransform } from './metadata.js';

type Properties = Record<string, unknown>;
type Override = { value: unknown; at: string };
type Overrides = Record<string, Override>;
interface Source { source: string; properties: Properties | null; observed_at: Date | number }
interface EditState { overrides: Overrides; deleted: boolean; created: boolean }

function resolve(sources: Source[], edits: EditState, policy: string): Properties | null {
  if (edits.deleted) return null;
  let result: Properties | null = null;
  const times = new Map<string, number>();
  for (const source of sources) {
    if (!source.properties) continue;
    result ??= {};
    const time = source.observed_at instanceof Date ? source.observed_at.getTime() : source.observed_at;
    for (const [name, value] of Object.entries(source.properties)) {
      result[name] = value;
      times.set(name, time);
    }
  }
  if (edits.created) result ??= {};
  if (result) for (const [name, edit] of Object.entries(edits.overrides)) {
    if (policy === 'user_wins' || !times.has(name) || Date.parse(edit.at) > times.get(name)!) result[name] = edit.value;
  }
  return result;
}

/** Migrate the reconstructable source/edit layers, then verify they reproduce the prepared object. */
export async function migrateProjectionState(db: Database, from: string, to: string, model: Ontology, transform: ProjectionTransform, client: Sql) {
  const identities = (await db.query(`SELECT owner,type,id FROM ${db.schema}.objects WHERE projection=$1
    UNION SELECT owner,type,id FROM ${db.schema}.source_values WHERE projection=$1
    UNION SELECT owner,type,id FROM ${db.schema}.object_edits WHERE projection=$1`, [to], client)).rows;
  for (const identity of identities) {
    const ref: ObjectRef = { type: identity.type, id: identity.id };
    const key = [to, identity.owner, ref.type, ref.id];
    const fields = model.object(ref.type).properties;
    const apply = (properties: Properties) => {
      const value = transform(ref, structuredClone(properties));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Conflict('Projection transformation must return object properties');
      return Object.fromEntries(Object.entries(value).filter(([name]) => fields[name]));
    };
    const sourceRows = (await db.query(`SELECT source,properties,observed_at FROM ${db.schema}.source_values
      WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4 ORDER BY observed_at,source`, key, client)).rows as Source[];
    const editRow = (await db.query(`SELECT overrides,deleted,created FROM ${db.schema}.object_edits
      WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, key, client)).rows[0] as EditState | undefined;
    const edits: EditState = editRow ?? { overrides: {}, deleted: false, created: false };
    const target = (await db.query(`SELECT properties FROM ${db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, key, client)).rows[0]?.properties as Properties | undefined;
    const sourceObject = (await db.query(`SELECT properties FROM ${db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [from, ...key.slice(1)], client)).rows[0]?.properties as Properties | undefined;
    const migratedSources = sourceRows.map(source => ({ ...source, properties: source.properties && apply(source.properties) }));
    const migratedOverrides: Overrides = {};
    const baseline = resolve(sourceRows, { overrides: {}, deleted: false, created: edits.created }, 'user_wins') ?? {};
    const allEdits = { ...baseline, ...Object.fromEntries(Object.entries(edits.overrides).map(([name, edit]) => [name, edit.value])) };
    const transformedEdits = Object.keys(edits.overrides).length ? apply(allEdits) : {};
    for (const [name, edit] of Object.entries(edits.overrides)) {
      // Same-name mappings retain explicit same-value edits and their original ordering timestamps.
      if (fields[name] && Object.hasOwn(transformedEdits, name)) migratedOverrides[name] = { value: transformedEdits[name], at: edit.at };
      const without = { ...allEdits };
      if (Object.hasOwn(baseline, name)) without[name] = baseline[name]; else delete without[name];
      // Created objects can lack required inputs when one field is removed. Newly produced fields
      // are assigned below from their complete creation state.
      if (edits.created && !Object.hasOwn(baseline, name)) continue;
      const transformedWithout = apply(without);
      for (const [mappedName, value] of Object.entries(transformedEdits)) {
        if (digest({ value }) === digest({ value: transformedWithout[mappedName] })) continue;
        const previous = migratedOverrides[mappedName];
        if (!previous || Date.parse(previous.at) < Date.parse(edit.at)) migratedOverrides[mappedName] = { value, at: edit.at };
      }
      if (!fields[name] && digest(transformedWithout) === digest(transformedEdits)) throw new Conflict('Projection transformation cannot infer the target of an explicit edit; provide a compatible state migration');
    }
    if (edits.created && Object.keys(edits.overrides).length) {
      const creationTime = Object.values(edits.overrides).map(edit => edit.at).sort((left, right) => Date.parse(left) - Date.parse(right))[0]!;
      for (const [name, value] of Object.entries(transformedEdits)) migratedOverrides[name] ??= { value, at: creationTime };
    }
    // Pre-history objects have no layers. Preserve their migrated state as the legacy source baseline.
    if (!sourceRows.length && !editRow && sourceObject && target) migratedSources.push({ source: '__legacy__', properties: target, observed_at: -Infinity });
    const migratedEdits = { ...edits, overrides: migratedOverrides };
    const policy = (await db.query(`SELECT policy FROM ${db.schema}.edit_policies WHERE ontology=$1 AND type=$2`, [model.document.id, ref.type], client)).rows[0]?.policy ?? 'user_wins';
    const resolved = resolve(migratedSources, migratedEdits, policy);
    if (digest(resolved) !== digest(target ?? null)) throw new Conflict('Transformed source and edit state does not reconstruct the candidate object');
    for (const source of migratedSources) {
      const at = source.observed_at === -Infinity ? '-infinity' : source.observed_at;
      await db.query(`INSERT INTO ${db.schema}.source_values(projection,owner,type,id,source,properties,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(projection,owner,type,id,source) DO UPDATE SET properties=excluded.properties`, [...key, source.source, source.properties, at], client);
    }
    if (editRow) await db.query(`UPDATE ${db.schema}.object_edits SET overrides=$5 WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [...key, migratedOverrides], client);
  }
}
