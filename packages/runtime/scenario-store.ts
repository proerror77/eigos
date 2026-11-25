import { Conflict, NotFound, digest } from '../core/identity.js';
import type { ObjectRef, LinkData } from '../ontology/schema.js';
import { Database, type Sql } from './database.js';
import type { PublishedOntology } from './metadata.js';
import { syncScenarioMetadata } from './scenario-metadata.js';
import { processLogTables } from './process-logs.js';
import { persistActionEvidence } from './decision-evidence.js';
import type { Objects } from './objects.js';

export type ScenarioMutation =
  | { op: 'create' | 'edit'; ref: ObjectRef; fields: string[]; values: Record<string, unknown> }
  | { op: 'delete'; ref: ObjectRef }
  | { op: 'link' | 'unlink'; edge: LinkData };

type ObjectCapture = { op: 'create' | 'edit' | 'delete'; journal?: ScenarioMutation[] };

/** Shared by live and scenario edits, including source ingestion and scenario merge. */
export async function lockEdits(db: Database, model: PublishedOntology, owner: string, client: Sql) {
  // A SERIALIZABLE Action commit shares the owner lock; every other writer and process scans take it exclusively.
  const owners = db.sharesEditLocks(client) ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  await db.acquireEditLocks(client, async () => {
    await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [db.lockKey('publication', model.document.id)], client);
    await db.query(`SELECT ${owners}(hashtextextended($1,0))`, [db.lockKey('objects', model.release, owner)], client);
  });
  if(model.evaluation){
    if(model.evaluation.client!==client)throw new Conflict('Candidate evaluation must remain in its original transaction');
    const ready=await db.query(`SELECT 1 FROM ${db.schema}.ontology o JOIN ${db.schema}.releases r ON r.digest=$3
      WHERE o.id=$1 AND o.release=$2 AND r.prepared_from=o.release AND r.state='prepared' AND r.body->>'id'=o.id`,
      [model.document.id,model.evaluation.base,model.release],client);
    if(!ready.rowCount)throw new Conflict('Prepare the candidate against the current publication before evaluation');
    return;
  }
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

/** Changed links shadow competing live single-valued links in the view. Merge checks the live links separately. */
export function viewTables(db: Database, model: PublishedOntology, owner: string, values: unknown[], types: readonly string[] = [], inline = false) {
  if (!model.scenario) return processLogTables(db,model,owner,values,{ prefix: '', objects: `${db.schema}.objects`, links: `${db.schema}.links` },types);
  values.push(model.scenario, model.projection, owner);
  const scenario = '$' + (values.length - 2), projection = '$' + (values.length - 1), actor = '$' + values.length;
  const inlineView = inline ? 'NOT MATERIALIZED ' : '';
  return processLogTables(db,model,owner,values,{ objects: 'view_objects', links: 'view_links', prefix: `WITH view_objects AS ${inlineView}(
    SELECT o.projection,o.owner,o.type,o.id,o.revision,o.properties FROM ${db.schema}.objects o WHERE o.projection=${projection} AND o.owner=${actor}
      AND NOT EXISTS(SELECT 1 FROM ${db.schema}.scenario_objects d WHERE d.scenario_id=${scenario} AND d.owner=o.owner AND d.type=o.type AND d.id=o.id)
    UNION ALL SELECT ${projection}::text AS projection,d.owner,d.type,d.id,d.revision,d.properties FROM ${db.schema}.scenario_objects d
      WHERE d.scenario_id=${scenario} AND d.owner=${actor} AND d.properties IS NOT NULL
  ), link_deltas AS (
    SELECT d.* FROM ${db.schema}.scenario_links d
    WHERE d.scenario_id=${scenario} AND d.owner=${actor} AND (NOT d.removed) IS DISTINCT FROM d.base_present
  ), view_links AS ${inlineView}(
    SELECT l.projection,l.owner,l.type,l.from_type,l.from_id,l.to_type,l.to_id,l.single_from,l.single_to FROM ${db.schema}.links l WHERE l.projection=${projection} AND l.owner=${actor}
      AND NOT EXISTS(
        SELECT 1 FROM link_deltas d
        WHERE d.type=l.type AND (
          (d.from_type,d.from_id,d.to_type,d.to_id)=(l.from_type,l.from_id,l.to_type,l.to_id)
          OR (NOT d.removed AND (
            (l.single_from AND (d.from_type,d.from_id)=(l.from_type,l.from_id))
            OR (l.single_to AND (d.to_type,d.to_id)=(l.to_type,l.to_id))
          ))
        )
      )
    UNION ALL SELECT ${projection}::text AS projection,d.owner,d.type,d.from_type,d.from_id,d.to_type,d.to_id,d.single_from,d.single_to
      FROM link_deltas d WHERE NOT d.removed
  ) ` },types);
}

export async function stageObject(db: Database, model: PublishedOntology, owner: string, ref: ObjectRef, revision: number, properties: Record<string, unknown> | null, client: Sql, editedFields: readonly string[] = [], capture?: ObjectCapture) {
  const original = (await db.query(`SELECT revision,properties FROM ${db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [model.projection, owner, ref.type, ref.id], client)).rows[0];
  const links = await objectLinks(db,model,owner,ref,client);
  await db.query(`INSERT INTO ${db.schema}.scenario_objects AS staged(scenario_id,owner,type,id,base_revision,base_properties,base_links,revision,properties,edited_fields)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(scenario_id,owner,type,id) DO UPDATE
    SET revision=excluded.revision,properties=excluded.properties,
      edited_fields=(SELECT coalesce(jsonb_agg(DISTINCT field),'[]') FROM jsonb_array_elements(coalesce(staged.edited_fields,'[]') || excluded.edited_fields) field)`,
  [model.scenario, owner, ref.type, ref.id, original?.revision ?? null, original?.properties ?? null, JSON.stringify(links), revision, properties, JSON.stringify(editedFields)], client);
  if (capture?.journal) {
    if (capture.op === 'delete') capture.journal.push({ op: 'delete', ref: { ...ref } });
    else capture.journal.push({
      op: capture.op, ref: { ...ref }, fields: [...editedFields],
      values: structuredClone(Object.fromEntries(editedFields.map(field => [field, properties![field]]))),
    });
  }
  await bumpScenario(db, model, owner, client);
}
export async function objectLinks(db: Database, model: PublishedOntology, owner: string, ref: ObjectRef, client: Sql) {
  // Each side uses its endpoint index; UNION keeps a self-link once, as the single OR condition did.
  const { rows } = await db.query(`SELECT type,from_type,from_id,to_type,to_id FROM ${db.schema}.links
      WHERE projection=$1 AND owner=$2 AND from_type=$3 AND from_id=$4
    UNION SELECT type,from_type,from_id,to_type,to_id FROM ${db.schema}.links
      WHERE projection=$1 AND owner=$2 AND to_type=$3 AND to_id=$4
    ORDER BY type,from_type,from_id,to_type,to_id LIMIT 10001`, [model.projection, owner, ref.type, ref.id], client);
  if (rows.length > 10000) throw new Conflict('Object relationships exceed the complete snapshot limit');
  return rows;
}

export async function stageLink(db: Database, model: PublishedOntology, owner: string, edge: LinkData, removed: boolean, client: Sql, journal?: ScenarioMutation[]) {
  const definition = model.links.get(edge.type)!;
  const args = [model.projection, owner, edge.type, edge.from.type, edge.from.id, edge.to.type, edge.to.id];
  const present = (await db.query(`SELECT 1 FROM ${db.schema}.links WHERE projection=$1 AND owner=$2 AND type=$3 AND from_type=$4 AND from_id=$5 AND to_type=$6 AND to_id=$7`, args, client)).rowCount! > 0;
  await db.query(`INSERT INTO ${db.schema}.scenario_links(scenario_id,owner,type,from_type,from_id,to_type,to_id,single_from,single_to,base_present,removed)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(scenario_id,owner,type,from_type,from_id,to_type,to_id) DO UPDATE SET removed=excluded.removed`,
  [model.scenario, ...args.slice(1), definition.from.cardinality === 'one', definition.to.cardinality === 'one', present, removed], client);
  journal?.push({ op: removed ? 'unlink' : 'link', edge: structuredClone(edge) });
  await bumpScenario(db, model, owner, client);
}
export async function bumpScenario(db: Database, model: PublishedOntology, owner: string, client: Sql, recordedStep = false) {
  const { rows } = await db.query<{revision: string}>(`UPDATE ${db.schema}.scenarios SET revision=revision+1,journal_steps=journal_steps+$3 WHERE id=$1 AND owner=$2 RETURNING revision`, [model.scenario, owner, Number(recordedStep)], client);
  if (!rows[0]) throw new NotFound('Scenario is unavailable');
  await syncScenarioMetadata(db,model,model.scenario!,client);
  return rows[0].revision;
}

export async function recordScenarioAction(
  graph: Objects, action: string, input: Record<string, unknown>, result: ObjectRef, requestId: string,
) {
  const { db, model, owner, client, change } = graph;
  if (!model.scenario || client === db.pool || !change?.scenarioEdits)
    throw new Conflict('Scenario Action needs its transactional edit journal');
  await graph.lockWrites();
  const revision = await bumpScenario(db, model, owner, client, true);
  const fingerprint = digest({ release: model.release, action, input });
  await db.query(`INSERT INTO ${db.schema}.scenario_actions(
      scenario_id,owner,request_id,digest,action,result,requirements,input,executor_kind,executor_id,task_id,step_revision,edits)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [model.scenario, owner, requestId, fingerprint, action, result, JSON.stringify(graph.access.requirements()), input,
      change.executor?.kind ?? null, change.executor?.id ?? null, change.taskId ?? null, revision, JSON.stringify(change.scenarioEdits)], client);
  await persistActionEvidence(graph);
}
