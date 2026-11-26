import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addProcessLogs } from '../packages/ontology/process-definition.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { ArchiveCodec, LogRetention, auditHistory } from '../packages/runtime/log-retention.js';
import { Objects } from '../packages/runtime/objects.js';
import { replayCheck } from '../packages/runtime/replay-check.js';
import { fixture, principal } from './fixture.js';

// The workflow step of this suite builds it: cargo build --manifest-path kernel/Cargo.toml --bin eigos-archive.
const binary = process.env.EIGOS_ARCHIVE_BIN;
const owner = principal.owner;

async function setup() {
  const f = await fixture();
  const definition = structuredClone(f.model.document);
  definition.objectTypes.find(type => type.apiName === 'Route')!.properties.state = {
    description: 'Synthetic route processing state', schema: { type: 'string', enum: ['open', 'done'] }, required: false,
  };
  addProcessLogs(definition, [{ type: 'Route', property: 'state' }]);
  const model = await f.metadata.publish(definition, f.capabilities, f.publisher);
  await setGrants(f.db, owner, businessGrants(model));
  const graph = new Objects(f.db, model, await Access.load(f.db, principal));
  const s = f.db.schema;
  const latest = async () => (await f.db.query<{ commit: string }>(`SELECT coalesce(max(commit_seq),0)::text AS commit FROM ${s}.change_commits WHERE owner=$1`, [owner])).rows[0]!.commit;
  /** Moves every commit after `after` to `at`, with its history, as if it had happened then. */
  const backdate = async (after: string, at: string) => {
    const xacts = (await f.db.query<{ xact: string }>(`SELECT xact::text FROM ${s}.change_commits WHERE owner=$1 AND commit_seq>$2::bigint`, [owner, after])).rows.map(row => row.xact);
    await f.db.query(`UPDATE ${s}.change_commits SET committed_at=$3 WHERE owner=$1 AND xact::text=ANY($2::text[])`, [owner, xacts, at]);
    for (const table of ['edit_history', 'link_history'])
      await f.db.query(`UPDATE ${s}.${table} SET happened_at=$3 WHERE owner=$1 AND xact::text=ANY($2::text[])`, [owner, xacts, at]);
  };
  return { ...f, model, graph, latest, backdate, s };
}

test('old commit log months move to Parquet behind every consumer, and history reads the same afterwards', { skip: !binary }, async () => {
  const f = await setup();
  const archive = await mkdtemp(join(tmpdir(), 'eigos-log-archive-'));
  try {
    const requested = new Date().toISOString();
    const request = (id: string) => ({ type: 'RideRequest', id }), route = { type: 'Route', id: 'january-route' };
    // January: a request edited twice, a route whose state a ProcessLog tracks, and a link between them.
    const start = await f.latest();
    await f.graph.create(request('january'), { id: 'january', name: 'January', status: 'quoted', requestedAt: requested });
    await f.graph.edit(request('january'), 1, { name: 'January, renamed' });
    await f.graph.create(route, { id: route.id, name: 'January route' });
    await f.graph.edit(route, 1, { state: 'open' });
    await f.graph.link({ type: 'RequestRoute', from: request('january'), to: route });
    await f.backdate(start, '2026-01-10T08:00:00Z');
    const february = await f.latest();
    await f.graph.create(request('february'), { id: 'february', name: 'February', status: 'quoted', requestedAt: requested });
    await f.backdate(february, '2026-02-10T08:00:00Z');
    const recent = await f.latest();
    await f.graph.edit(request('january'), 2, { name: 'January, recent' });
    const firstFebruary = (BigInt(february) + 1n).toString();

    const codec = new ArchiveCodec(binary!);
    const retention = new LogRetention(f.db, { days: 90, archive, codec, now: new Date('2026-06-01T00:00:00Z') });
    // A subscription that has read only up to the first January commit holds the whole month.
    await f.db.query(`INSERT INTO ${f.s}.change_subscriptions(id,owner,request_id,ontology,conversation_id,principal,footprint,position)
      VALUES('00000000-0000-4000-8000-000000000052',$1,'retention','Eigos','retention','{}','{}',$2::bigint)`, [owner, (BigInt(start) + 1n).toString()]);
    assert.deepEqual(await retention.plan(owner), []);
    await f.db.query(`UPDATE ${f.s}.change_subscriptions SET position=$1::bigint WHERE request_id='retention'`, [firstFebruary]);
    assert.deepEqual((await retention.plan(owner)).map(item => item.month), ['2026-01']);

    const read = () => f.db.withOwner(owner, () => auditHistory(f.db, archive, codec, 'edit_history', { owner, type: 'RideRequest', id: 'january' }));
    const links = () => f.db.withOwner(owner, () => auditHistory(f.db, archive, codec, 'link_history', { owner, type: 'RequestRoute' }));
    const before = { history: await read(), links: await links(), logs: (await f.graph.query({ type: 'RouteStateLog' })).items.length };
    assert.equal(before.history.length, 3);
    assert.equal(before.links.length, 1);
    assert.equal(before.logs, 1);
    const count = async (table: string, where = 'TRUE') =>
      Number((await f.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${f.s}.${table} WHERE owner=$1 AND ${where}`, [owner])).rows[0]!.n);
    const tables = async () => ({ edits: await count('edit_history'), links: await count('link_history'), commits: await count('change_commits') });
    const untouched = await tables();

    // A codec that fails leaves the tables, the manifest and the archive as they were.
    await assert.rejects(new LogRetention(f.db, { days: 90, archive, codec: new ArchiveCodec('/usr/bin/false'), now: new Date('2026-06-01T00:00:00Z') })
      .archiveMonth(owner, '2026-01'), /eigos-archive write failed/);
    assert.deepEqual(await tables(), untouched);
    assert.equal(await count('log_archives'), 0);
    assert.deepEqual(await readdir(archive, { recursive: true }).then(files => files.filter(file => file.endsWith('.parquet'))), []);

    const [january] = await retention.run({ owner });
    assert.equal(january?.month, '2026-01');
    // The request's two January edits and the link went; the route's history stays, because a ProcessLog tracks it.
    assert.equal(january!.rows.edit_history, 2);
    assert.equal(january!.rows.link_history, 1);
    assert.equal(await count('edit_history', `type='RideRequest' AND id='january'`), 1);
    assert.equal(await count('edit_history', `type='Route' AND id='january-route'`), 2);
    assert.equal(await count('link_history', `type='RequestRoute'`), 0);
    // A commit with a kept history row stays, and the archive holds exactly the commits that went.
    const after = await tables();
    assert.equal(untouched.commits - after.commits, january!.rows.change_commits);
    assert.equal(untouched.edits - after.edits, 2);
    const manifest = (await f.db.query<{ table_name: string; path: string; rows: string; sha256: string }>(
      `SELECT table_name,path,rows::text,sha256 FROM ${f.s}.log_archives WHERE owner=$1 AND month='2026-01' ORDER BY table_name`, [owner])).rows;
    assert.deepEqual(manifest.map(row => [row.table_name, Number(row.rows)]),
      [['change_commits', january!.rows.change_commits], ['edit_history', 2], ['link_history', 1]]);
    const ownerDirectory = createHash('sha256').update(owner).digest('hex').slice(0, 32);
    for (const row of manifest) {
      assert.equal(row.path, join(ownerDirectory, row.table_name, '2026-01.parquet'));
      assert.equal(createHash('sha256').update(await readFile(join(archive, row.path))).digest('hex'), row.sha256);
    }
    assert(!(await readdir(archive, { recursive: true })).some(file => file.includes('.partial')));

    // History reads the same across the tables and the archive; ProcessLog objects and the replay check are unaffected.
    assert.deepEqual(await read(), before.history);
    assert.deepEqual(await links(), before.links);
    assert.equal((await f.graph.query({ type: 'RouteStateLog' })).items.length, before.logs);
    assert.equal((await f.db.withOwner(owner, () => replayCheck(f.db, f.model.projection))).consistent, true);
    assert.equal(await f.latest() >= recent, true);

    // February waits for the subscription, then goes once it is cancelled; nothing is archived twice.
    assert.deepEqual(await retention.plan(owner), []);
    await f.db.query(`UPDATE ${f.s}.change_subscriptions SET cancelled_at=now() WHERE request_id='retention'`);
    assert.deepEqual((await retention.run({ owner })).map(item => [item.month, item.rows.edit_history]), [['2026-02', 1]]);
    assert.deepEqual(await retention.run({ owner }), []);
    assert.equal(await count('edit_history', `type='RideRequest' AND id='february'`), 0);
    assert.equal((await f.db.withOwner(owner, () => auditHistory(f.db, archive, codec, 'edit_history', { owner, type: 'RideRequest', id: 'february' }))).length, 1);
  } finally {
    await rm(archive, { recursive: true, force: true });
    await f.close();
  }
});
