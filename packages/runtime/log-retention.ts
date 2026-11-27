import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Ontology } from '../ontology/model.js';
import { processLogTarget } from '../ontology/process-definition.js';
import type { Database, Sql } from './database.js';

/**
 * Commit log retention (platform plan, "提交日志保留"; the user chose 90 days on 2026-11-27). Rows of `edit_history`,
 * `link_history` and `change_commits` older than the retention are archived to Parquet, one file per owner, table and
 * month, and deleted once the archive reads back identical. The archive stays queryable through `eigos-archive read`.
 *
 * Kept in the tables whatever their age:
 * - history rows of object types a ProcessLog tracks in any active or retired release: those rows are the ProcessLog
 *   objects, which Machinery analyzes up to 366 days back;
 * - commits after the cutoff, or not yet consumed by a change subscription, an open Scenario's sync, or an object rule;
 * - a commit that still has a kept history row.
 *
 * It runs as a maintenance command with a role that owns the tables; the runtime roles cannot delete history.
 */

export const archiveTables = ['edit_history', 'link_history', 'change_commits'] as const;
export type ArchiveTable = typeof archiveTables[number];
export type ArchivedRow = Record<string, string | null>;
export type ArchiveFilter = Partial<Record<'owner' | 'type' | 'id' | 'fromType' | 'fromId' | 'toType' | 'toId' | 'requestId' | 'taskId'
  | 'after' | 'from' | 'to' | 'limit', string>>;

const maxCommit = '9223372036854775807';
const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** The archive's columns as text, in its column order, selected from a table aliased `h` with its commit `c`. */
const selections: Record<ArchiveTable, string> = {
  edit_history: `h.sequence::text AS sequence,h.projection,h.release,h.owner,h.type,h.id,h.operation,h.source,
    h.before_values::text AS before_values,h.after_values::text AS after_values,h.actor,${utc('h.happened_at')} AS happened_at,
    h.action,h.request_id,h.task_id,${utc('h.observed_at')} AS observed_at,h.executor_kind,h.executor_id,h.xact::text AS xact,
    c.commit_seq::text AS commit_seq`,
  link_history: `h.sequence::text AS sequence,h.projection,h.release,h.owner,h.type,h.from_type,h.from_id,h.to_type,h.to_id,h.operation,
    h.source,h.actor,h.action,h.request_id,h.task_id,h.executor_kind,h.executor_id,${utc('h.happened_at')} AS happened_at,
    h.xact::text AS xact,c.commit_seq::text AS commit_seq`,
  change_commits: `h.owner,h.xact::text AS xact,h.commit_seq::text AS commit_seq,${utc('h.committed_at')} AS committed_at`,
};
const keyOf: Record<ArchiveTable, string> = { edit_history: 'sequence', link_history: 'sequence', change_commits: 'commit_seq' };
/** A digest of rows in archive order that depends on neither how they were stored nor the order of their keys. */
export const contentDigest = (rows: ArchivedRow[]) => {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(JSON.stringify(Object.keys(row).sort().map(key => [key, row[key]])) + '\n');
  return hash.digest('hex');
};
const ownerKey = (owner: string) => createHash('sha256').update(owner).digest('hex').slice(0, 32);
const monthStart = (month: string) => `${month}-01T00:00:00Z`;
const nextMonth = (month: string) => {
  const [year, value] = month.split('-').map(Number) as [number, number];
  return value === 12 ? `${year + 1}-01` : `${year}-${String(value + 1).padStart(2, '0')}`;
};

/** Spawns the `eigos-archive` codec of the kernel crate. */
export class ArchiveCodec {
  constructor(readonly binary: string) {}

  /** Writes rows in archive order to a new Parquet file and returns how many it wrote. */
  async write(table: ArchiveTable, file: string, rows: ArchivedRow[]) {
    const output = await this.run(['write', table, file], rows.map(row => JSON.stringify(row) + '\n'));
    return (JSON.parse(output.trim()) as { rows: number }).rows;
  }

  /** The rows of the files that match the filter, in history or commit order. */
  async read(table: ArchiveTable, filter: ArchiveFilter, files: string[]): Promise<ArchivedRow[]> {
    if (!files.length) return [];
    const output = await this.run(['read', table, JSON.stringify(filter), ...files], []);
    return output.split('\n').filter(Boolean).map(line => JSON.parse(line) as ArchivedRow);
  }

  private run(args: string[], input: string[]) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [], err: Buffer[] = [];
      child.stdout.on('data', chunk => out.push(chunk));
      child.stderr.on('data', chunk => err.push(chunk));
      child.once('error', reject);
      const pipe = pipeline(Readable.from(input), child.stdin).catch((error: unknown) => ({ error }));
      child.once('close', async code => {
        // A codec that exits early can also close its input pipe. Keep the codec's error and let the caller roll back.
        if (code !== 0) return reject(new Error(`eigos-archive ${args[0]} failed: ${Buffer.concat(err).toString().trim()}`));
        const failure = await pipe;
        if (failure) return reject(failure.error);
        resolve(Buffer.concat(out).toString());
      });
    });
  }
}

/** The archive this process reads, from EIGOS_LOG_ARCHIVE_DIR and EIGOS_ARCHIVE_BIN, if both are set. */
export function configuredArchive(): { dir: string; codec: ArchiveCodec } | undefined {
  const dir = process.env.EIGOS_LOG_ARCHIVE_DIR, binary = process.env.EIGOS_ARCHIVE_BIN;
  return dir && binary ? { dir, codec: new ArchiveCodec(binary) } : undefined;
}

export async function initializeLogArchives(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.log_archives (
    owner text NOT NULL, month text NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
    table_name text NOT NULL CHECK (table_name IN ('edit_history','link_history','change_commits')),
    path text NOT NULL, rows bigint NOT NULL, sha256 text NOT NULL, content text NOT NULL,
    first_key bigint NOT NULL, last_key bigint NOT NULL, archived_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, month, table_name))`);
}

export type RetentionOptions = { days: number; archive: string; codec: ArchiveCodec; now?: Date };
export type ArchivedMonth = { owner: string; month: string; boundary: string; rows: Record<ArchiveTable, number> };

export class LogRetention {
  constructor(private readonly db: Database, private readonly options: RetentionOptions) {
    if (!Number.isInteger(options.days) || options.days < 1) throw new Error('Retention needs a positive number of days');
  }

  private retained?: Promise<string[]>;
  private get cutoff() { return new Date((this.options.now ?? new Date()).getTime() - this.options.days * 86400000); }
  /** The start of the cutoff's month: only months before it are complete before the cutoff. */
  private get cutoffMonth() { return monthStart(this.cutoff.toISOString().slice(0, 7)); }

  /** Object types a ProcessLog tracks in any active or retired release: their history is ProcessLog data. */
  async retainedTypes(client?: Sql) {
    return this.retained ??= (async () => {
      const rows = (await this.db.query<{ body: unknown }>(`SELECT DISTINCT body FROM ${this.db.schema}.releases
        WHERE state IN ('active','retired')`, [], client)).rows;
      const types = new Set<string>();
      for (const { body } of rows) {
        const model = new Ontology(body, { published: true });
        for (const type of model.resolvedDocument.objectTypes) {
          const target = processLogTarget(model, type.apiName);
          if (target) types.add(target.objectType);
        }
      }
      return [...types].sort();
    })();
  }

  /**
   * The first commit of the owner that must stay: the first after the cutoff, or the earliest position a change
   * subscription, an open Scenario's sync or an enabled object rule still reads after. Commits before it may go.
   */
  async boundary(owner: string, client?: Sql) {
    const s = this.db.schema;
    const { rows: [row] } = await this.db.query<{ boundary: string }>(`SELECT least(
        coalesce((SELECT min(commit_seq) FROM ${s}.change_commits WHERE owner=$1 AND committed_at>=$2),
          (SELECT coalesce(max(commit_seq),0)+1 FROM ${s}.change_commits WHERE owner=$1)),
        coalesce((SELECT min(position) FROM ${s}.change_subscriptions WHERE owner=$1 AND cancelled_at IS NULL),$3::bigint),
        coalesce((SELECT min(sync_position) FROM ${s}.scenarios WHERE owner=$1 AND kind='persisted' AND state='open'
          AND sync_position IS NOT NULL),$3::bigint),
        coalesce((SELECT min(CASE WHEN process_cursor IS NOT NULL THEN process_commit ELSE match_commit END) FROM ${s}.object_rules
          WHERE owner=$1 AND enabled AND NOT (body ? 'machineryReview')
            AND (process_cursor IS NOT NULL OR match_commit IS NOT NULL)),$3::bigint))::text AS boundary`,
      [owner, this.cutoff, maxCommit], client);
    return row!.boundary;
  }

  /**
   * Months of each owner that can be archived, oldest first: they end before the cutoff, all their commits lie before
   * the owner's boundary, and they are not archived yet. History from before the commit journal counts by its time.
   */
  async plan(owner?: string) {
    const s = this.db.schema, before = this.cutoffMonth;
    const owners = owner ? [owner] : (await this.db.query<{ owner: string }>(`SELECT owner FROM ${s}.change_commits WHERE committed_at<$1
      UNION SELECT owner FROM ${s}.edit_history WHERE xact IS NULL AND happened_at<$1 ORDER BY owner`, [before])).rows.map(row => row.owner);
    const months: { owner: string; month: string; boundary: string }[] = [];
    for (const candidate of owners) {
      const boundary = await this.boundary(candidate);
      const rows = (await this.db.query<{ month: string; blocked: boolean }>(`WITH activity AS (
          SELECT to_char(committed_at AT TIME ZONE 'UTC','YYYY-MM') AS month, commit_seq>=$3::bigint AS blocked
            FROM ${s}.change_commits WHERE owner=$1 AND committed_at<$2
          UNION ALL SELECT to_char(happened_at AT TIME ZONE 'UTC','YYYY-MM'), $3::bigint=0
            FROM ${s}.edit_history WHERE owner=$1 AND xact IS NULL AND happened_at<$2)
        SELECT month, bool_or(blocked) AS blocked FROM activity a
        WHERE NOT EXISTS (SELECT 1 FROM ${s}.log_archives l WHERE l.owner=$1 AND l.month=a.month)
        GROUP BY month ORDER BY month`, [candidate, before, boundary])).rows;
      // A month after a blocked one waits too, so that the archive never has a gap before kept history.
      for (const row of rows) { if (row.blocked) break; months.push({ owner: candidate, month: row.month, boundary }); }
    }
    return months;
  }

  /** Archives one owner's month, deletes what it archived, and returns how many rows of each table moved. */
  async archiveMonth(owner: string, month: string): Promise<ArchivedMonth | undefined> {
    const s = this.db.schema, { codec, archive } = this.options;
    const written: string[] = [];
    try {
      return await this.db.transaction(async client => {
        await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', [], client);
        // The history tables isolate owners; a maintenance role that owns them still reads one owner at a time here.
        await this.db.setOwner(client, owner);
        const boundary = await this.boundary(owner, client);
        const [start, end] = [monthStart(month), monthStart(nextMonth(month))];
        if (new Date(end) > new Date(this.cutoffMonth)) return undefined;
        const { rows: [window] } = await this.db.query<{ blocked: boolean; legacy: string }>(`SELECT
            EXISTS (SELECT 1 FROM ${s}.change_commits WHERE owner=$1 AND committed_at>=$2 AND committed_at<$3 AND commit_seq>=$4::bigint) AS blocked,
            (SELECT legacy_end::text FROM ${s}.change_journal) AS legacy`, [owner, start, end, boundary], client);
        if (window!.blocked) return undefined;
        const retained = await this.retainedTypes(client);
        const values = [owner, start, end, boundary, retained];
        // The month's commits, and its history rows except those a ProcessLog tracks.
        const commitsOfMonth = `SELECT xact FROM ${s}.change_commits WHERE owner=$1 AND committed_at>=$2 AND committed_at<$3 AND commit_seq<$4::bigint`;
        const queries: Record<ArchiveTable, string> = {
          edit_history: `SELECT ${selections.edit_history} FROM ${s}.edit_history h
            LEFT JOIN ${s}.change_commits c ON c.owner=h.owner AND c.xact=h.xact
            WHERE h.owner=$1 AND h.type<>ALL($5::text[]) AND (h.xact IN (${commitsOfMonth})
              OR (h.xact IS NULL AND $4::bigint>0 AND h.happened_at>=$2 AND h.happened_at<$3))
            ORDER BY h.sequence`,
          link_history: `SELECT ${selections.link_history} FROM ${s}.link_history h
            JOIN ${s}.change_commits c ON c.owner=h.owner AND c.xact=h.xact
            WHERE h.owner=$1 AND h.xact IN (${commitsOfMonth}) ORDER BY h.sequence`,
          // A commit goes only when no kept history row refers to it.
          change_commits: `SELECT ${selections.change_commits} FROM ${s}.change_commits h
            WHERE h.owner=$1 AND h.committed_at>=$2 AND h.committed_at<$3 AND h.commit_seq<$4::bigint
              AND NOT EXISTS (SELECT 1 FROM ${s}.edit_history e WHERE e.owner=h.owner AND e.xact=h.xact AND e.type=ANY($5::text[]))
            ORDER BY h.commit_seq`,
        };
        const rows = {} as Record<ArchiveTable, ArchivedRow[]>;
        // Each statement takes only the parameters it refers to.
        for (const table of archiveTables)
          rows[table] = (await this.db.query<ArchivedRow>(queries[table], table === 'link_history' ? values.slice(0, 4) : values, client)).rows;
        if (archiveTables.every(table => !rows[table].length)) return undefined;
        const counts = {} as Record<ArchiveTable, number>;
        for (const table of archiveTables) {
          counts[table] = rows[table].length;
          if (!rows[table].length) continue;
          const relative = join(ownerKey(owner), table, `${month}.parquet`), file = join(archive, relative);
          const partial = join(dirname(file), `${month}.${randomUUID()}.partial.parquet`);
          await mkdir(dirname(file), { recursive: true, mode: 0o700 });
          written.push(partial);
          if (await codec.write(table, partial, rows[table]) !== rows[table].length) throw new Error(`The ${table} archive lost rows`);
          // The archive must read back as exactly the rows it replaces.
          const back = await codec.read(table, {}, [partial]), content = contentDigest(rows[table]);
          if (back.length !== rows[table].length || contentDigest(back) !== content) throw new Error(`The ${table} archive does not read back`);
          const sha256 = await fileDigest(partial);
          await rename(partial, file);
          written.splice(written.indexOf(partial), 1, file);
          const keys = rows[table].map(row => row[keyOf[table]]!);
          await this.db.query(`INSERT INTO ${s}.log_archives(owner,month,table_name,path,rows,sha256,content,first_key,last_key)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9::bigint)`, [owner, month, table, relative, rows[table].length, sha256, content, keys[0], keys.at(-1)], client);
          const deleted = await this.db.query(`DELETE FROM ${s}.${table} WHERE owner=$1 AND ${keyOf[table]}=ANY($2::bigint[])`, [owner, keys], client);
          if (deleted.rowCount !== keys.length) throw new Error(`The ${table} rows changed while archiving`);
        }
        written.length = 0;
        return { owner, month, boundary, rows: counts };
      });
    } catch (error) {
      // A file of a month the manifest does not record is never read; removing it keeps the archive tidy.
      for (const file of written) await rm(file, { force: true });
      throw error;
    }
  }

  /** Archives every month that can be archived, at most `limit`. */
  async run(options: { owner?: string; limit?: number } = {}) {
    const done: ArchivedMonth[] = [];
    for (const { owner, month } of await this.plan(options.owner)) {
      if (options.limit !== undefined && done.length >= options.limit) break;
      const result = await this.archiveMonth(owner, month);
      if (result) done.push(result);
    }
    return done;
  }
}

async function fileDigest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * History of one owner across the tables and the archive, in order: what an audit reads. The archive holds rows the
 * tables no longer do, so the two never overlap.
 */
export async function auditHistory(db: Database, archive: string | undefined, codec: ArchiveCodec | undefined, table: 'edit_history' | 'link_history',
  filter: ArchiveFilter & { owner: string }) {
  const s = db.schema, values: unknown[] = [filter.owner];
  const where = ['h.owner=$1'];
  const add = (column: string, value: string | undefined, operator = '=') => {
    if (value === undefined) return;
    values.push(value);
    where.push(`${column}${operator}$${values.length}`);
  };
  add('h.type', filter.type);
  if (table === 'edit_history') add('h.id', filter.id);
  else { add('h.from_type', filter.fromType); add('h.from_id', filter.fromId); add('h.to_type', filter.toType); add('h.to_id', filter.toId); }
  add('h.request_id', filter.requestId);
  add('h.task_id', filter.taskId);
  add('h.happened_at', filter.from, '>=');
  add('h.happened_at', filter.to, '<');
  const live = (await db.query<ArchivedRow>(`SELECT ${selections[table]} FROM ${s}.${table} h
    LEFT JOIN ${s}.change_commits c ON c.owner=h.owner AND c.xact=h.xact WHERE ${where.join(' AND ')} ORDER BY h.sequence`, values)).rows;
  let archived: ArchivedRow[] = [];
  if (archive && codec) {
    const files = (await db.query<{ path: string }>(`SELECT path FROM ${s}.log_archives WHERE owner=$1 AND table_name=$2 ORDER BY month`,
      [filter.owner, table])).rows.map(row => join(archive, row.path));
    archived = await codec.read(table, filter, files);
  }
  return [...archived, ...live].sort((a, b) => Number(BigInt(a.sequence!) - BigInt(b.sequence!)));
}
