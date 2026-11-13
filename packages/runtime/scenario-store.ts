import { Conflict, NotFound } from '../core/identity.js';
import type { ObjectRef, LinkData } from '../ontology/schema.js';
import { Database, type Sql } from './database.js';
import type { PublishedOntology } from './metadata.js';
import { syncScenarioMetadata } from './scenario-metadata.js';

/** Shared by live and scenario edits, including source ingestion and scenario merge. */
export async function lockEdits(db: Database, model: PublishedOntology, owner: string, client: Sql) {
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', ['publication:' + model.document.id], client);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['objects', model.release, owner])], client);
  if ((await db.query(`SELECT release FROM ${db.schema}.ontology WHERE id=$1`, [model.document.id], client)).rows[0]?.release !== model.release) throw new Conflict('Historical and prepared projections are read-only');
}

export async function checkScenario(db: Database, model: PublishedOntology, owner: string, client: Sql = db.pool, lock = false) {
  if (!model.scenario) return;
  const row = (await db.query(`SELECT s.*,s.expires_at>now() AND (s.session_id IS NULL OR (session.closed_at IS NULL AND session.expires_at>now())) AS current
    FROM ${db.schema}.scenarios s LEFT JOIN ${db.schema}.scenario_sessions session ON session.id=s.session_id
    WHERE s.id=$1 AND s.owner=$2${lock ? ' FOR UPDATE OF s' : ''}`, [model.scenario, owner], client)).rows[0];
  if (!row) throw new NotFound('Scenario is unavailable');
  if (row.release !== model.release || row.state !== 'open' || !row.current) throw new Conflict('Scenario is closed, expired or belongs to another publication');
}

/** A scenario is a delta over current objects, never a historical data snapshot. */
export function viewTables(db: Database, model: PublishedOntology, owner: string, values: unknown[]) {
  if (!model.scenario) return { prefix: '', objects: `${db.schema}.objects`, links: `${db.schema}.links` };
  values.push(model.scenario, model.projection, owner);
  const scenario = '$' + (values.length - 2), projection = '$' + (values.length - 1), actor = '$' + values.length;
  return { objects: 'view_objects', links: 'view_links', prefix: `WITH view_objects AS (
    SELECT o.projection,o.owner,o.type,o.id,o.revision,o.properties FROM ${db.schema}.objects o WHERE o.projection=${projection} AND o.owner=${actor}
      AND NOT EXISTS(SELECT 1 FROM ${db.schema}.scenario_objects d WHERE d.scenario_id=${scenario} AND d.owner=o.owner AND d.type=o.type AND d.id=o.id)
    UNION ALL SELECT ${projection}::text AS projection,d.owner,d.type,d.id,d.revision,d.properties FROM ${db.schema}.scenario_objects d
      WHERE d.scenario_id=${scenario} AND d.owner=${actor} AND d.properties IS NOT NULL
  ), view_links AS (
    SELECT l.projection,l.owner,l.type,l.from_type,l.from_id,l.to_type,l.to_id,l.single_from,l.single_to FROM ${db.schema}.links l WHERE l.projection=${projection} AND l.owner=${actor}
      AND NOT EXISTS(SELECT 1 FROM ${db.schema}.scenario_links d WHERE d.scenario_id=${scenario} AND d.owner=l.owner AND d.type=l.type
        AND d.from_type=l.from_type AND d.from_id=l.from_id AND d.to_type=l.to_type AND d.to_id=l.to_id)
    UNION ALL SELECT ${projection}::text AS projection,d.owner,d.type,d.from_type,d.from_id,d.to_type,d.to_id,d.single_from,d.single_to
      FROM ${db.schema}.scenario_links d WHERE d.scenario_id=${scenario} AND d.owner=${actor} AND NOT d.removed
  ) ` };
}

export async function stageObject(db: Database, model: PublishedOntology, owner: string, ref: ObjectRef, revision: number, properties: Record<string, unknown> | null, client: Sql) {
  const original = (await db.query(`SELECT revision,properties FROM ${db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [model.projection, owner, ref.type, ref.id], client)).rows[0];
  const links = await objectLinks(db,model,owner,ref,client);
  await db.query(`INSERT INTO ${db.schema}.scenario_objects(scenario_id,owner,type,id,base_revision,base_properties,base_links,revision,properties)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(scenario_id,owner,type,id) DO UPDATE SET revision=excluded.revision,properties=excluded.properties`,
  [model.scenario, owner, ref.type, ref.id, original?.revision ?? null, original?.properties ?? null, JSON.stringify(links), revision, properties], client);
  await bumpScenario(db, model, owner, client);
}
export async function objectLinks(db: Database, model: PublishedOntology, owner: string, ref: ObjectRef, client: Sql) {
  return (await db.query(`SELECT type,from_type,from_id,to_type,to_id FROM ${db.schema}.links WHERE projection=$1 AND owner=$2 AND ((from_type=$3 AND from_id=$4) OR (to_type=$3 AND to_id=$4)) ORDER BY type,from_type,from_id,to_type,to_id`, [model.projection,owner,ref.type,ref.id],client)).rows;
}

export async function stageLink(db: Database, model: PublishedOntology, owner: string, edge: LinkData, removed: boolean, client: Sql) {
  const definition = model.links.get(edge.type)!;
  const args = [model.projection, owner, edge.type, edge.from.type, edge.from.id, edge.to.type, edge.to.id];
  const present = (await db.query(`SELECT 1 FROM ${db.schema}.links WHERE projection=$1 AND owner=$2 AND type=$3 AND from_type=$4 AND from_id=$5 AND to_type=$6 AND to_id=$7`, args, client)).rowCount! > 0;
  await db.query(`INSERT INTO ${db.schema}.scenario_links(scenario_id,owner,type,from_type,from_id,to_type,to_id,single_from,single_to,base_present,removed)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(scenario_id,owner,type,from_type,from_id,to_type,to_id) DO UPDATE SET removed=excluded.removed`,
  [model.scenario, ...args.slice(1), definition.from.cardinality === 'one', definition.to.cardinality === 'one', present, removed], client);
  await bumpScenario(db, model, owner, client);
}
export async function bumpScenario(db: Database, model: PublishedOntology, owner: string, client: Sql) {
  await db.query(`UPDATE ${db.schema}.scenarios SET revision=revision+1 WHERE id=$1 AND owner=$2`, [model.scenario, owner], client);
  await syncScenarioMetadata(db,model,model.scenario!,client);
}
