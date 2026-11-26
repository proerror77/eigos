import type { Database } from './database.js';

/** How one type's rows, or one link's edges, compare with the commit log of the projection. */
export type ReplayCount = {
  owner: string; name: string;
  /** Rows whose last committed write the tables hold: its values, or, after a deletion, no row. */
  matched: number;
  /** Rows that the tables hold with other values than the last committed write. */
  differs: number;
  /** Rows the last committed write created or changed, which the tables do not hold. */
  missing: number;
  /** Rows the last committed write deleted, which the tables still hold. */
  resurrected: number;
  /** Rows with no write in this projection's history: carried over when the projection was created. Not compared. */
  carried: number;
};
export type ReplayDifference = { kind: 'object' | 'link'; owner: string; name: string; id: string; problem: 'differs' | 'missing' | 'resurrected' };

/**
 * Funnel 05.5: whether the commit log explains the projection's rows. Replaying the projection's history in commit
 * order gives, for each object and edge it covers, the last committed write: an object's values after it (full
 * values, or none after a deletion), or whether an edge was linked or unlinked. That must be what the tables hold.
 * - Commit order is the owner's commit number; history from before the change journal has none and comes first, in
 *   sequence order, as consumers read it.
 * - Rows the projection's history does not cover were copied in when the projection was created by a publication, so
 *   they are counted as carried over and not compared. A row written outside the history after that, such as by direct
 *   SQL, is also counted there; `differs`, `missing` and `resurrected` find writes the history misrecords.
 * Read-only, from one REPEATABLE READ snapshot, so a commit in progress is either wholly seen or not at all. Under owner
 * isolation it sees the owners the connection may read.
 */
export async function replayCheck(db: Database, projection: string, examples = 20) {
  return db.transaction(async client => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', [], client);
    const s = db.schema;
    const objects = await db.query<{ owner: string; name: string; id: string; outcome: string }>(`
      WITH written AS (
        SELECT DISTINCT ON (h.owner, h.type, h.id) h.owner, h.type, h.id, h.after_values
        FROM ${s}.edit_history h LEFT JOIN ${s}.change_commits c ON c.owner=h.owner AND c.xact=h.xact
        WHERE h.projection=$1 AND (h.xact IS NULL OR c.commit_seq IS NOT NULL)
        ORDER BY h.owner, h.type, h.id, (c.commit_seq IS NOT NULL) DESC, c.commit_seq DESC, h.sequence DESC
      ), current AS (SELECT owner, type, id, properties FROM ${s}.objects WHERE projection=$1)
      SELECT coalesce(w.owner, o.owner) AS owner, coalesce(w.type, o.type) AS name, coalesce(w.id, o.id) AS id,
        CASE
          WHEN w.owner IS NULL THEN 'carried'
          WHEN w.after_values IS NULL THEN CASE WHEN o.owner IS NULL THEN 'matched' ELSE 'resurrected' END
          WHEN o.owner IS NULL THEN 'missing'
          WHEN o.properties = w.after_values THEN 'matched'
          ELSE 'differs'
        END AS outcome
      FROM written w FULL JOIN current o ON (o.owner, o.type, o.id)=(w.owner, w.type, w.id)`, [projection], client);
    const links = await db.query<{ owner: string; name: string; id: string; outcome: string }>(`
      WITH written AS (
        SELECT DISTINCT ON (h.owner, h.type, h.from_id, h.to_id) h.owner, h.type, h.from_id, h.to_id, h.operation
        FROM ${s}.link_history h LEFT JOIN ${s}.change_commits c ON c.owner=h.owner AND c.xact=h.xact
        WHERE h.projection=$1 AND (h.xact IS NULL OR c.commit_seq IS NOT NULL)
        ORDER BY h.owner, h.type, h.from_id, h.to_id, (c.commit_seq IS NOT NULL) DESC, c.commit_seq DESC, h.sequence DESC
      ), current AS (SELECT owner, type, from_id, to_id FROM ${s}.links WHERE projection=$1)
      SELECT coalesce(w.owner, l.owner) AS owner, coalesce(w.type, l.type) AS name,
        coalesce(w.from_id, l.from_id) || ' -> ' || coalesce(w.to_id, l.to_id) AS id,
        CASE
          WHEN w.owner IS NULL THEN 'carried'
          WHEN w.operation = 'unlink' THEN CASE WHEN l.owner IS NULL THEN 'matched' ELSE 'resurrected' END
          WHEN l.owner IS NULL THEN 'missing'
          ELSE 'matched'
        END AS outcome
      FROM written w FULL JOIN current l ON (l.owner, l.type, l.from_id, l.to_id)=(w.owner, w.type, w.from_id, w.to_id)`, [projection], client);
    const differences: ReplayDifference[] = [];
    const count = (kind: 'object' | 'link', rows: { owner: string; name: string; id: string; outcome: string }[]) => {
      const counts = new Map<string, ReplayCount>();
      for (const row of rows) {
        const key = JSON.stringify([row.owner, row.name]);
        const entry = counts.get(key) ?? { owner: row.owner, name: row.name, matched: 0, differs: 0, missing: 0, resurrected: 0, carried: 0 };
        entry[row.outcome as keyof Omit<ReplayCount, 'owner' | 'name'>]++;
        counts.set(key, entry);
        if (row.outcome !== 'matched' && row.outcome !== 'carried' && differences.length < examples)
          differences.push({ kind, owner: row.owner, name: row.name, id: row.id, problem: row.outcome as ReplayDifference['problem'] });
      }
      return [...counts.values()].sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));
    };
    const types = count('object', objects.rows), edges = count('link', links.rows);
    const problems = [...types, ...edges].reduce((sum, entry) => sum + entry.differs + entry.missing + entry.resurrected, 0);
    return { projection, consistent: problems === 0, problems, types, links: edges, differences };
  });
}
