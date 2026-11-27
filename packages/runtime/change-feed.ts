import type { Ontology } from '../ontology/model.js';
import type { DerivedExpression, ObjectRef } from '../ontology/schema.js';
import type { Database, Sql } from './database.js';
import { queryFields } from './objects.js';

/**
 * Commit-ordered reads of an owner's committed changes for consumers that keep their own position.
 *
 * A position is a commit number of `change_commits`. An owner's commits are numbered in the order they become visible,
 * so a consumer that has read every commit up to N has seen everything the owner committed before N; a commit
 * still in progress is numbered later. Each read is bounded by a window of commits, and the caller stores the
 * returned end as its next position in the same transaction as the work it did.
 */

/** The owner's last numbered commit visible to this transaction, `'0'` when none. */
export async function latestCommit(db: Database, owner: string, client: Sql) {
  const { rows: [row] } = await db.query(`SELECT coalesce(max(commit_seq),0)::text AS commit FROM ${db.schema}.change_commits WHERE owner=$1`,
    [owner], client);
  return String(row!.commit);
}

/** What a consumer's answer depends on: changes outside it cannot change the answer. */
export type ChangeFootprint = {
  /** Object types whose committed edits can change the answer. */
  types: string[];
  /** Link types whose committed link or unlink changes can change the answer. */
  links: string[];
  /** True when only an object's own stored properties decide its answer, so a change can affect only the changed object. */
  local: boolean;
};

type FootprintQuery = Parameters<typeof queryFields>[0] & { type: string; from?: { object: ObjectRef; link: string; as?: string } };

/**
 * The footprint of an object-set query and optional watched relationship paths. Derived properties add the links and
 * object types their expressions navigate. Interface queries and relationship sources are never local.
 */
export function queryFootprint(model: Ontology, query: FootprintQuery, watches: readonly { path: readonly string[] }[] = []): ChangeFootprint {
  const types = new Set<string>(), links = new Set<string>();
  const roots = model.concreteTypes(query.type), view = query.type;
  let local = roots.length === 1 && roots[0] === view && !query.from;
  const expanded = new Set<string>();
  const property = (type: string, name: string) => {
    const key = type + '.' + name;
    if (expanded.has(key)) return;
    expanded.add(key);
    const derived = model.object(type).properties[name]?.derived;
    if (derived) expression(type, derived);
  };
  const expression = (type: string, node: DerivedExpression): void => {
    if (node.op === 'literal') return;
    if (node.op === 'property' || node.op === 'timeseries') return property(type, node.property.split('.')[0]!);
    if (node.op === 'linked') {
      let target = type;
      for (const step of node.path) {
        const navigation = model.navigation(target, step.link, step.as ?? target);
        links.add(navigation.link);
        target = navigation.target;
        types.add(target);
      }
      if (node.property) property(target, node.property.split('.')[0]!);
      return;
    }
    expression(type, node.left);
    expression(type, node.right);
  };
  for (const type of roots) types.add(type);
  for (const field of queryFields(query)) {
    const name = field.split('.')[0]!;
    for (const type of roots) {
      const actual = type === view ? name : model.propertyName(type, view, name);
      if (actual === undefined) continue;
      if (model.object(type).properties[actual]?.derived) local = false;
      property(type, actual);
    }
  }
  if (query.from) {
    const navigation = model.navigation(query.from.object.type, query.from.link, query.from.as ?? query.from.object.type);
    links.add(navigation.link);
  }
  for (const watch of watches) {
    if (watch.path.length) local = false;
    for (const root of roots) {
      let target = root;
      for (const step of watch.path) {
        const navigation = model.navigation(target, step);
        links.add(navigation.link);
        target = navigation.target;
        types.add(target);
      }
    }
  }
  return { types: [...types].sort(), links: [...links].sort(), local };
}

/** The commits after `after` and through `through` that one read covers, in commit order. */
const window = (db: Database) => `SELECT commit_seq,xact FROM ${db.schema}.change_commits
  WHERE owner=$1 AND commit_seq>$2::bigint AND commit_seq<=$3::bigint ORDER BY commit_seq LIMIT $4`;

/**
 * The distinct objects of `types` that commits after `after` (through `through`, at most `commits` commits) edited.
 * `refs` is undefined when more than `objects` objects changed; the caller then re-evaluates from the full state.
 * `end` is the last commit read, or `through` when the window reached it.
 */
export async function changedObjects(db: Database, owner: string, projection: string, types: readonly string[], client: Sql,
  after: string, through: string, limits: { commits?: number; objects?: number } = {}) {
  const commits = limits.commits ?? 500, objects = limits.objects ?? 1000;
  // The LIMIT inside the per-commit probe keeps the planner on the edit_history_commit index instead of
  // flattening the probe into a scan of the whole history table.
  const { rows } = await db.query(`WITH commits AS (${window(db)})
    SELECT (SELECT max(commit_seq) FROM commits)::text AS "windowEnd", (SELECT count(*) FROM commits)::int AS "commitCount", changed.type, changed.id
    FROM (SELECT 1) one LEFT JOIN LATERAL (
      SELECT DISTINCT h.type, h.id FROM commits c CROSS JOIN LATERAL (
        SELECT h.type, h.id FROM ${db.schema}.edit_history h
        WHERE h.xact=c.xact AND h.xact IS NOT NULL AND h.owner=$1 AND h.type=ANY($5::text[]) AND h.projection=$6 LIMIT 100000) h
      LIMIT $7) changed ON true`, [owner, after, through, commits, types, projection, objects + 1], client);
  const end = rows[0]!.commitCount < commits ? through : String(rows[0]!.windowEnd ?? through);
  const changed: ObjectRef[] = rows.filter(row => row.type !== null).map(row => ({ type: String(row.type), id: String(row.id) }));
  return { refs: changed.length > objects ? undefined : changed, end };
}

/**
 * Whether commits after `after` (through `through`, at most `commits` commits) changed anything in `footprint`.
 * `end` is the last commit read, or `through` when the window reached it.
 */
export async function footprintChanged(db: Database, owner: string, footprint: ChangeFootprint, client: Sql,
  after: string, through: string, commits = 500) {
  const { rows: [row] } = await db.query(`WITH commits AS (${window(db)})
    SELECT (SELECT max(commit_seq) FROM commits)::text AS "windowEnd", (SELECT count(*) FROM commits)::int AS "commitCount",
      EXISTS (SELECT 1 FROM commits c WHERE
        EXISTS (SELECT 1 FROM ${db.schema}.edit_history h WHERE h.xact=c.xact AND h.xact IS NOT NULL AND h.owner=$1 AND h.type=ANY($5::text[]) LIMIT 1)
        OR EXISTS (SELECT 1 FROM ${db.schema}.link_history l WHERE l.xact=c.xact AND l.owner=$1 AND l.type=ANY($6::text[]) LIMIT 1)) AS changed`,
    [owner, after, through, commits, footprint.types, footprint.links], client);
  return { changed: Boolean(row!.changed), end: row!.commitCount < commits ? through : String(row!.windowEnd ?? through) };
}

/**
 * What commits after `after` (through `through`, at most `commits` commits) changed in `footprint`: its object types
 * that were edited and its link types that were linked or unlinked. `end` is the last commit read, or `through` when the
 * window reached it.
 */
export async function footprintChanges(db: Database, owner: string, footprint: ChangeFootprint, client: Sql,
  after: string, through: string, ontology: string, commits = 500) {
  const { rows: [row] } = await db.query<{ windowEnd: string | null; commitCount: number; types: string[]; links: string[] }>(`WITH commits AS (${window(db)})
    SELECT (SELECT max(commit_seq) FROM commits)::text AS "windowEnd", (SELECT count(*) FROM commits)::int AS "commitCount",
      ARRAY(SELECT DISTINCT h.type FROM commits c JOIN ${db.schema}.edit_history h ON h.xact=c.xact AND h.owner=$1
        JOIN ${db.schema}.releases r ON r.digest=h.release AND r.body->>'id'=$7
        WHERE h.xact IS NOT NULL AND h.type=ANY($5::text[]) ORDER BY 1) AS types,
      ARRAY(SELECT DISTINCT l.type FROM commits c JOIN ${db.schema}.link_history l ON l.xact=c.xact AND l.owner=$1
        JOIN ${db.schema}.releases r ON r.digest=l.release AND r.body->>'id'=$7
        WHERE l.type=ANY($6::text[]) ORDER BY 1) AS links`,
    [owner, after, through, commits, footprint.types, footprint.links, ontology], client);
  return { types: row!.types, links: row!.links, end: row!.commitCount < commits ? through : String(row!.windowEnd ?? through) };
}
