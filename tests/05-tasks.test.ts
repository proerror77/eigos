import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal, route, document } from './fixture.js';
import { Database } from '../packages/runtime/database.js';
import { Metadata } from '../packages/runtime/metadata.js';
import { Ontology } from '../packages/ontology/model.js';
import { Objects } from '../packages/runtime/objects.js';
import { Access, setGrants, businessGrants } from '../packages/runtime/access.js';
import { upgradePublicationStorage } from '../packages/runtime/upgrade.js';
import { Tasks } from '../packages/runtime/tasks.js';

test('concurrent submissions retain one task and cancellation fences late results', async () => {
  const f = await fixture();
  try {
    const input = { requestId: 'same-request', message: '只询价', route };
    const [a, b] = await Promise.all([f.tasks.submit(principal, input), f.tasks.submit(principal, input)]);
    assert.equal(a.id, b.id);
    await assert.rejects(f.tasks.submit(principal, { ...input, message: 'different' }), /already used/);
    const [first, second] = await Promise.all([f.tasks.claim(), f.tasks.claim()]);
    assert.equal([first, second].filter(Boolean).length, 1);
    const claim = first ?? second; assert(claim);
    await f.tasks.cancel(principal, claim.id);
    await assert.rejects(f.tasks.finish(claim, 'completed', { fabricated: true }), /canceled/);
    assert.equal((await f.tasks.get(principal, claim.id)).state, 'canceled');
    await assert.rejects(f.tasks.get({ ...principal, owner: 'other' }, claim.id));
  } finally { await f.close(); }
});


test('the existing PostgreSQL data upgrades in place with old definitions and task results retained', async () => {
  const db = new Database(process.env.EIGOS_TEST_DATABASE_URL!, 'eigos_upgrade_' + Date.now()), model = new Ontology(document), s = db.schema;
  try {
    await db.query(`CREATE SCHEMA ${s};
      CREATE TABLE ${s}.releases(digest text PRIMARY KEY,body jsonb NOT NULL,created_at timestamptz DEFAULT now());
      CREATE TABLE ${s}.ontology(id text PRIMARY KEY,release text NOT NULL REFERENCES ${s}.releases(digest));
      CREATE TABLE ${s}.objects(owner text,type text,id text,revision bigint DEFAULT 1,properties jsonb,PRIMARY KEY(owner,type,id));
      CREATE TABLE ${s}.links(owner text,type text,from_type text,from_id text,to_type text,to_id text,single_from boolean,single_to boolean,PRIMARY KEY(owner,type,from_type,from_id,to_type,to_id),FOREIGN KEY(owner,from_type,from_id) REFERENCES ${s}.objects(owner,type,id),FOREIGN KEY(owner,to_type,to_id) REFERENCES ${s}.objects(owner,type,id));
      CREATE TABLE ${s}.tasks(id uuid PRIMARY KEY,owner text,request_id text,input_digest text,input jsonb,release text,scopes jsonb,state text,token uuid,lease_until timestamptz,result jsonb,error text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());`);
    await db.query(`INSERT INTO ${s}.releases(digest,body) VALUES($1,$2)`, [model.digest, model.document]);
    await db.query(`INSERT INTO ${s}.ontology VALUES('Eigos',$1)`, [model.digest]);
    await db.query(`INSERT INTO ${s}.objects(owner,type,id,properties) VALUES($1,'Route','kept',$2)`, [principal.owner, { id: 'kept', name: 'Original data' }]);
    await db.query(`INSERT INTO ${s}.tasks(id,owner,release,state,result) VALUES('00000000-0000-4000-8000-000000000001',$1,$2,'completed','{"kept":true}')`, [principal.owner, model.digest]);
    await upgradePublicationStorage(db); await upgradePublicationStorage(db);
    await setGrants(db, principal.owner, businessGrants(model));
    const access = await Access.load(db, principal), historical = await new Metadata(db).get(model.digest);
    assert.equal(historical.runtimeId, 'legacy-readonly');
    assert.equal((await new Objects(db, historical, access).read({ type: 'Route', id: 'kept' })).properties.name, 'Original data');
    const task = (await db.query(`SELECT result,result_permissions FROM ${s}.tasks`)).rows[0]!;
    assert.deepEqual(task.result, { kept: true }); assert(task.result_permissions.length > 0);
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${s}.objects`)).rows[0]!.n, 1);
  } finally { await db.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`); await db.close(); }
});

test('owners take turns at the task queue, and each runs at most its share of slots', async () => {
  const f = await fixture();
  try {
    const tasks = new Tasks(f.db, f.metadata, 2);
    const other = { ...principal, owner: 'queue-other-owner' };
    await setGrants(f.db, other.owner, businessGrants(f.model));
    const submit = (as: typeof principal, requestId: string) => tasks.submit(as, { requestId, message: '只询价', route });
    for (let index = 0; index < 4; index++) await submit(principal, 'backlog-' + index);
    await submit(other, 'other-owner-task');
    const next = async () => (await tasks.claim())?.request_id;
    // The other owner's task came last but goes second: owners take turns.
    assert.deepEqual([await next(), await next(), await next()], ['backlog-0', 'other-owner-task', 'backlog-1']);
    // The first owner now runs two tasks, its share, so its backlog waits even with slots free.
    assert.equal(await next(), undefined);
    await f.db.query(`UPDATE ${f.db.schema}.tasks SET state='completed' WHERE request_id='backlog-0'`);
    assert.equal(await next(), 'backlog-2');
    // A lease that expired frees its slot as well.
    await f.db.query(`UPDATE ${f.db.schema}.tasks SET lease_until=now()-interval '1 second' WHERE request_id='backlog-1'`);
    assert.deepEqual([await next(), await next()], ['backlog-1', undefined]);
  } finally { await f.close(); }
});
