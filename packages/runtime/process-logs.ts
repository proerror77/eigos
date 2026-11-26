import { processLogTarget } from '../ontology/process-definition.js';
import type { Database, Sql } from './database.js';
import type { PublishedOntology } from './metadata.js';

type Tables = { prefix: string; objects: string; links: string };
type Target = NonNullable<ReturnType<typeof processLogTarget>>;
export type ProcessTransition = { sequence: string; objectId: string; recordedAt: Date };

function processReleases(db: Database, release: string) {
  return `process_releases AS (
    SELECT digest,prepared_from FROM ${db.schema}.releases WHERE digest=${release}
    UNION ALL SELECT r.digest,r.prepared_from FROM ${db.schema}.releases r JOIN process_releases p ON r.digest=p.prepared_from
  )`;
}

function stateChanged(property: string) {
  const before = `h.before_values->${property}`, after = `h.after_values->${property}`;
  return `${before} IS DISTINCT FROM ${after}
    AND (${before} IS NULL OR jsonb_typeof(${before}) IN('string','null'))
    AND (${after} IS NULL OR jsonb_typeof(${after}) IN('string','null'))`;
}

/**
 * The latest transition of a type, or of one object. Writes to one object are serialized by its object lock,
 * so its history sequence is also its commit order.
 */
export async function readProcessTransitions(
  db: Database, model: PublishedOntology, owner: string, target: Target, client: Sql, position: { latestFor?: string },
) {
  const values: unknown[] = [model.release, owner, target.objectType, target.property];
  let selection = 'ORDER BY h.sequence DESC LIMIT 1';
  if (position.latestFor !== undefined) {
    values.push(position.latestFor);
    selection = 'AND h.id=$5 ' + selection;
  }
  const result = await db.query<ProcessTransition>(`WITH RECURSIVE ${processReleases(db, '$1')}
    SELECT h.sequence::text AS sequence,h.id AS "objectId",h.happened_at AS "recordedAt"
    FROM ${db.schema}.edit_history h JOIN process_releases r ON r.digest=h.release
    WHERE h.owner=$2 AND h.type=$3 AND ${stateChanged('$4::text')} ${selection}`, values, client);
  return result.rows;
}

/**
 * A rule's place in the committed history of one owner: every transition in a commit before `commit`, and those of
 * `commit` up to history `sequence`, have been consumed. Commit 0 is the history written before the commit journal.
 */
export type ProcessPosition = { commit: string; sequence: string };
/** The in-commit sequence of a position whose commit has been read entirely. */
const wholeCommit = '9223372036854775807';

/** Where a new rule starts: after every committed transition, or after a history sequence when replaying. */
export async function processStart(db: Database, owner: string, target: Target, client: Sql,
  replayFrom?: string): Promise<ProcessPosition> {
  if (replayFrom === undefined) {
    // A commit this snapshot cannot see yet gets a larger number, so it is after the start.
    const { rows: [start] } = await db.query<{ commit: string }>(
      `SELECT coalesce(max(commit_seq),0)::text AS commit FROM ${db.schema}.change_commits WHERE owner=$1`, [owner], client);
    return { commit: start!.commit, sequence: wholeCommit };
  }
  // A point inside the earlier history replays the rest of it, then every commit. A later point replays from the first
  // commit holding a later history row of the type; commits after it are read whole, so a transition written before the
  // point but committed after that commit is delivered too.
  const { rows: [start] } = await db.query<{ commit: string }>(`SELECT CASE
      WHEN $3::bigint<(SELECT legacy_end FROM ${db.schema}.change_journal) THEN 0
      ELSE coalesce((SELECT min(c.commit_seq) FROM ${db.schema}.edit_history h
          JOIN ${db.schema}.change_commits c ON c.owner=h.owner AND c.xact=h.xact
          WHERE h.owner=$1 AND h.type=$2 AND h.sequence>$3::bigint),
        (SELECT max(commit_seq) FROM ${db.schema}.change_commits WHERE owner=$1),0) END::text AS commit`,
    [owner, target.objectType, replayFrom], client);
  return { commit: start!.commit, sequence: replayFrom };
}

/**
 * Committed transitions after a position, in commit order, and the position after them. Earlier history comes first, in
 * sequence order. A read never passes a commit it cannot see yet, so it needs no write lock. Each call examines at
 * most `window` commits, and the position moves past commits without matching transitions.
 */
export async function readCommittedTransitions(db: Database, model: PublishedOntology, owner: string, target: Target,
  client: Sql, position: ProcessPosition, limit: number, window = 500) {
  const transitions: (ProcessTransition & { commit: string })[] = [];
  let { commit, sequence } = position;
  const values = [model.release, owner, target.objectType, target.property];
  if (commit === '0') {
    const { rows } = await db.query<ProcessTransition & { commit: string }>(`WITH RECURSIVE ${processReleases(db, '$1')}
      SELECT '0' AS commit,h.sequence::text AS sequence,h.id AS "objectId",h.happened_at AS "recordedAt"
      FROM ${db.schema}.edit_history h JOIN process_releases r ON r.digest=h.release
      WHERE h.owner=$2 AND h.type=$3 AND ${stateChanged('$4::text')}
        AND h.sequence>$5::bigint AND h.sequence<=(SELECT legacy_end FROM ${db.schema}.change_journal)
      ORDER BY h.sequence LIMIT $6`, [...values, sequence, limit], client);
    transitions.push(...rows);
    if (rows.length) sequence = rows.at(-1)!.sequence;
    if (rows.length === limit) return { transitions, position: { commit, sequence } };
  }
  const budget = limit - transitions.length;
  const { rows } = await db.query<Partial<ProcessTransition & { commit: string }> & { windowEnd: string | null }>(
    `WITH RECURSIVE ${processReleases(db, '$1')}, commits AS (
      SELECT commit_seq,xact FROM ${db.schema}.change_commits WHERE owner=$2 AND commit_seq>=$5::bigint ORDER BY commit_seq LIMIT $8
    ) SELECT (SELECT max(commit_seq) FROM commits)::text AS "windowEnd",t.* FROM (SELECT 1) one LEFT JOIN LATERAL (
      SELECT c.commit_seq::text AS commit,h.sequence::text AS sequence,h.id AS "objectId",h.happened_at AS "recordedAt"
      -- Probe each commit's rows of the type, so the cost follows the window rather than the owner's whole history.
      -- The LIMIT keeps the planner from flattening the probe into a scan of that history.
      -- Every filter applies before that LIMIT, so a commit is never cut short by rows that do not count.
      FROM commits c CROSS JOIN LATERAL (
        SELECT h.sequence,h.id,h.happened_at FROM ${db.schema}.edit_history h
        WHERE h.xact=c.xact AND h.xact IS NOT NULL AND h.type=$3 AND h.owner=$2
          AND h.sequence>CASE WHEN c.commit_seq>$5::bigint THEN 0 ELSE $6::bigint END AND ${stateChanged('$4::text')}
          AND h.release IN (SELECT digest FROM process_releases)
        ORDER BY h.sequence LIMIT $7
      ) h
      ORDER BY c.commit_seq,h.sequence LIMIT $7
    ) t ON true`, [...values, commit, sequence, budget, window], client);
  const found = rows.filter(row => row.commit !== null) as (ProcessTransition & { commit: string })[];
  transitions.push(...found);
  const last = found.at(-1);
  if (last && found.length === budget) return { transitions, position: { commit: last.commit, sequence: last.sequence } };
  // Every matching transition up to the window end was returned; later ones are in later commits.
  const end = rows[0]?.windowEnd;
  return { transitions, position: end ? { commit: end, sequence: wholeCommit } : { commit, sequence } };
}

/** Extend the existing read view only when a query navigates process log types. */
export function processLogTables(db: Database, model: PublishedOntology, owner: string, values: unknown[], base: Tables, types: readonly string[],
  scope?: { before: string; ids: string }) {
  const logs = [...new Set(types)].flatMap(type => {
    const target = processLogTarget(model, type);
    return target ? [target] : [];
  });
  if (!logs.length) return base;
  const bind = (value: unknown) => { values.push(value); return '$' + values.length; };
  const config = bind(JSON.stringify(logs)), projection = bind(model.projection), actor = bind(owner), release = bind(model.release);
  const prefix = base.prefix ? base.prefix.replace(/^WITH /, 'WITH RECURSIVE ').trimEnd() + ', ' : 'WITH RECURSIVE ';
  return { objects: 'process_view_objects', links: 'process_view_links', prefix: `${prefix}
    ${processReleases(db, release)}, process_log_rows AS (
      SELECT ${projection}::text AS projection,h.owner,c.type,lpad(h.sequence::text,20,'0') AS id,1::bigint AS revision,
        c.link,c."objectType",h.id AS process_id,h.sequence,h.happened_at AS recorded_at,
        jsonb_build_object('id',lpad(h.sequence::text,20,'0'),'name',c."objectType"||'.'||c.property||' · '||h.sequence,
          'processId',h.id,'property',c.property,'oldState',h.before_values->c.property,'newState',h.after_values->c.property,
          'timestamp',coalesce(h.observed_at,h.happened_at),'recordedAt',h.happened_at,'sequence',h.sequence::text,
          'action',h.action,'requestId',h.request_id,'taskId',h.task_id,'source',h.source,'actor',h.actor,'release',h.release) AS properties
      FROM ${db.schema}.edit_history h JOIN process_releases r ON r.digest=h.release
      JOIN jsonb_to_recordset(${config}::jsonb) AS c(type text,"objectType" text,property text,link text) ON c."objectType"=h.type
      WHERE h.owner=${actor} AND ${stateChanged('c.property')}
        ${scope ? `AND h.happened_at < ${scope.before}::timestamptz
          AND (${scope.ids}::text[] IS NULL OR h.id=ANY(${scope.ids}::text[]))` : ''}
    ), process_view_objects AS (
      SELECT projection,owner,type,id,revision,properties FROM ${base.objects}
      UNION ALL SELECT projection,owner,type,id,revision,properties FROM process_log_rows
    ), process_view_links AS (
      SELECT projection,owner,type,from_type,from_id,to_type,to_id,single_from,single_to FROM ${base.links}
      UNION ALL SELECT projection,owner,link,type,id,"objectType",process_id,true,false FROM process_log_rows
    ) ` };
}
