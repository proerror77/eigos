import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import type { ObjectData, ObjectRef } from '../ontology/schema.js';
import type { Objects, Query } from './objects.js';
import type { Database, Sql } from './database.js';
import type { PublishedOntology } from './metadata.js';
import { viewTables } from './scenario-store.js';

export const scenarioMetadataType = 'OntologyScenario';

function asObject(row: Record<string, any>): ObjectData {
  return {
    ref: { type: scenarioMetadataType, id: String(row.id) },
    revision: Number(row.revision),
    properties: {
      id: String(row.id),
      name: String(row.name),
      owner: String(row.owner),
      state: String(row.state),
      release: String(row.release),
      revision: Number(row.revision),
      expiresAt: new Date(row.expires_at).toISOString(),
      kind: String(row.kind),
      description: String(row.description),
    },
  };
}

/** The shared metadata has a local FK target for each explicitly authorized identity. */
export async function syncScenarioMetadata(db: Database, model: PublishedOntology, id: string, client: Sql) {
  if (!model.objects.has(scenarioMetadataType)) return;
  const row = (
    await db.query(
      `SELECT * FROM ${db.schema}.scenarios WHERE id=$1 AND release=$2`,
      [id, model.release],
      client,
    )
  ).rows[0];
  if (!row || row.kind !== 'persisted') return;
  const object = asObject(row),
    properties = model.parseObject(object.ref, object.properties);
  const readers = [...new Set([String(row.owner), ...(row.readers as string[])])].sort();
  await db.query(
    `SELECT owner FROM ${db.schema}.objects WHERE projection=$1 AND type=$2 AND id=$3 FOR UPDATE`,
    [model.projection, scenarioMetadataType, id],
    client,
  );
  await db.query(
    `DELETE FROM ${db.schema}.links WHERE projection=$1 AND owner<>ALL($4::text[])
    AND ((from_type=$2 AND from_id=$3) OR (to_type=$2 AND to_id=$3))`,
    [model.projection, scenarioMetadataType, id, readers],
    client,
  );
  await db.query(
    `DELETE FROM ${db.schema}.objects WHERE projection=$1 AND type=$2 AND id=$3 AND owner<>ALL($4::text[])`,
    [model.projection, scenarioMetadataType, id, readers],
    client,
  );
  await db.query(
    `INSERT INTO ${db.schema}.objects(projection,owner,type,id,revision,properties)
    SELECT $1,recipient,$2,$3,$4,$5 FROM unnest($6::text[]) recipient
    ON CONFLICT(projection,owner,type,id) DO UPDATE SET revision=excluded.revision,properties=excluded.properties`,
    [model.projection, scenarioMetadataType, id, object.revision, properties, readers],
    client,
  );
}

export async function removeScenarioMetadata(db: Database, ids: string[], client: Sql) {
  if (!ids.length) return;
  await db.query(
    `SELECT owner FROM ${db.schema}.objects WHERE type=$1 AND id=ANY($2::text[]) FOR UPDATE`,
    [scenarioMetadataType, ids],
    client,
  );
  await db.query(
    `DELETE FROM ${db.schema}.links WHERE (from_type=$1 AND from_id=ANY($2::text[])) OR (to_type=$1 AND to_id=ANY($2::text[]))`,
    [scenarioMetadataType, ids],
    client,
  );
  await db.query(
    `DELETE FROM ${db.schema}.objects WHERE type=$1 AND id=ANY($2::text[])`,
    [scenarioMetadataType, ids],
    client,
  );
}
export async function scenarioMetadataRead(graph: Objects, ref: ObjectRef): Promise<ObjectData> {
  z.uuid().parse(ref.id);
  graph.access.read(graph.model, scenarioMetadataType);
  const row = (
    await graph.db.query(
      `SELECT * FROM ${graph.db.schema}.scenarios WHERE id=$1 AND release=$2 AND kind='persisted'
    AND expires_at>now() AND (owner=$3 OR readers ? $3)`,
      [ref.id, graph.model.release, graph.owner],
      graph.client,
    )
  ).rows[0];
  if (!row) throw new NotFound('Scenario metadata is unavailable');
  const object = asObject(row),
    properties = graph.maskSnapshot(object.ref, object.properties);
  if (!properties) throw new NotFound('Scenario metadata is unavailable');
  return { ...object, properties };
}
export async function scenarioMetadataQuery(graph: Objects, input: Query) {
  graph.access.read(graph.model, scenarioMetadataType);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(input.limit ?? 50);
  const fingerprint = digest({
    owner: graph.owner,
    release: graph.model.release,
    scenario: graph.model.scenario,
    from: input.from,
    where: input.where ?? {},
    select: input.select,
  });
  const cursor = input.cursor
    ? z
        .strictObject({ query: z.literal(fingerprint), id: z.uuid() })
        .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString())).id
    : null;
  const values: unknown[] = [graph.model.release, graph.owner, cursor];
  const clauses = [
    `s.release=$1`,
    `s.kind='persisted'`,
    `s.expires_at>now()`,
    `(s.owner=$2 OR s.readers ? $2)`,
    `($3::uuid IS NULL OR s.id>$3)`,
  ];
  let prefix = '';
  if (input.from) {
    const navigation = graph.model.navigation(input.from.object.type, input.from.link, input.from.as);
    if (navigation.target !== scenarioMetadataType)
      throw new Conflict('The relationship does not target Scenario metadata');
    await graph.read(input.from.object);
    graph.access.definition(graph.model, 'link', navigation.link);
    if (input.from.as) graph.access.definition(graph.model, 'interface', input.from.as);
    values.push(graph.model.projection, navigation.link, input.from.object.type, input.from.object.id);
    const source = navigation.forward ? 'from' : 'to',
      target = navigation.forward ? 'to' : 'from';
    const tables = viewTables(graph.db, graph.model, graph.owner, values);
    prefix = tables.prefix;
    clauses.push(`EXISTS(SELECT 1 FROM ${tables.links} link WHERE link.projection=$4 AND link.owner=$2 AND link.type=$5
      AND link.${source}_type=$6 AND link.${source}_id=$7 AND link.${target}_type='OntologyScenario' AND link.${target}_id=s.id::text)`);
  }
  const items: ObjectData[] = [];
  let after = cursor;
  let more = false;
  do {
    values[2] = after;
    const rows = (
      await graph.db.query(
        `${prefix}SELECT s.* FROM ${graph.db.schema}.scenarios s WHERE ${clauses.join(' AND ')} ORDER BY s.id LIMIT 101`,
        values,
        graph.client,
      )
    ).rows;
    more = rows.length > 100;
    for (const row of rows.slice(0, 100)) {
      after = String(row.id);
      const object = asObject(row),
        visible = graph.maskSnapshot(object.ref, object.properties);
      if (!visible) continue;
      for (const field of Object.keys(input.where ?? {}))
        graph.model.propertyName(scenarioMetadataType, scenarioMetadataType, field);
      if (
        !Object.entries(input.where ?? {}).every(
          ([key, value]) => digest(visible[key] ?? null) === digest(value),
        )
      )
        continue;
      const properties = input.select
        ? Object.fromEntries(
            input.select.map((field) => {
              graph.model.propertyName(scenarioMetadataType, scenarioMetadataType, field);
              return [field, visible[field]];
            }),
          )
        : visible;
      items.push({ ...object, properties });
      if (items.length === limit) {
        const hasRemaining = rows.some((item) => String(item.id) > after!) || more;
        return {
          items,
          cursor: hasRemaining
            ? Buffer.from(JSON.stringify({ query: fingerprint, id: after })).toString('base64url')
            : undefined,
        };
      }
    }
  } while (more);
  return { items, cursor: undefined };
}
