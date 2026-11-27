import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { test } from 'node:test';
import { fixture, principal, route, document } from './fixture.js';
import { Database } from '../packages/runtime/database.js';
import { Metadata } from '../packages/runtime/metadata.js';
import { Ontology } from '../packages/ontology/model.js';
import { Objects } from '../packages/runtime/objects.js';
import { Access, setGrants, businessGrants } from '../packages/runtime/access.js';
import { upgradePublicationStorage } from '../packages/runtime/upgrade.js';
import { Tasks } from '../packages/runtime/tasks.js';
import { ProviderBudgetExceeded, ProviderBudgets } from '../packages/runtime/provider-budgets.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { Worker } from '../apps/worker/worker.js';
import { OntologyAgent } from '../packages/runtime/agent.js';
import { harnessProvider } from '../packages/runtime/model-egress.js';

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

for (const { ownerSlots, concurrent, competingOwner } of [
  { ownerSlots: 2, concurrent: 4, competingOwner: true },
  { ownerSlots: 4, concurrent: 4, competingOwner: true },
  { ownerSlots: 8, concurrent: 8, competingOwner: false },
  { ownerSlots: 8, concurrent: 8, competingOwner: true },
]) {
  test(`${concurrent} concurrent claims make progress with a share of ${ownerSlots} and competing owner = ${competingOwner}`, async () => {
    const f = await fixture();
    const ownerLock = new pg.Client({ connectionString: process.env.EIGOS_TEST_DATABASE_URL });
    let claims: Promise<Awaited<ReturnType<Tasks['claim']>>[]> | undefined;
    try {
      const tasks = new Tasks(f.db, f.metadata, ownerSlots);
      const other = { ...principal, owner: 'contested-other-owner' };
      await ownerLock.connect();
      for (let index = 0; index < concurrent; index++)
        await tasks.submit(principal, { requestId: 'contended-' + index, message: '只询价', route });
      if (competingOwner) await tasks.submit(other, { requestId: 'contended-other', message: '只询价', route });
      const key = f.db.lockKey('task-owner-claim', principal.owner);
      await ownerLock.query('BEGIN');
      await ownerLock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      // Every claimant selects one of the first owner's rows before any can fill its share.
      claims = Promise.all(Array.from({ length: concurrent }, () => tasks.claim('interactive')));
      const deadline = Date.now() + 1000;
      let blocked: number;
      do {
        const result = await ownerLock.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype='advisory' AND NOT granted AND objsubid=1
            AND classid::bigint=((hashtextextended($1,0)>>32) & 4294967295)
            AND objid::bigint=(hashtextextended($1,0) & 4294967295)`, [key]);
        blocked = result.rows[0]!.n;
        if (blocked < concurrent) await delay(5);
      } while (blocked < concurrent && Date.now() < deadline);
      await ownerLock.query('COMMIT');
      assert.equal(blocked, concurrent);
      const claimed = (await claims).flatMap(task => task ? [task.owner] : []);
      const otherOwners = competingOwner ? [other.owner] : [];
      const expected = [...otherOwners, ...Array<string>(Math.min(ownerSlots, concurrent - otherOwners.length)).fill(principal.owner)];
      assert.deepEqual(claimed.sort(), expected.sort());
    } finally {
      await ownerLock.end();
      await claims?.catch(() => {});
      await f.close();
    }
  });
}

test('a provider call over its owner budget waits: the call is deferred and the Worker resumes the task later', async () => {
  const f = await fixture();
  try {
    const budgets = new ProviderBudgets(f.db, { Didi: { perMinute: 60, burst: 2 } });
    await budgets.take('budget-owner', 'Didi');
    await budgets.take('budget-owner', 'Didi');
    const exceeded = await budgets.take('budget-owner', 'Didi').then(() => undefined, (error: unknown) => error);
    assert(exceeded instanceof ProviderBudgetExceeded);
    assert(Date.parse(exceeded.until) > Date.now() && Date.parse(exceeded.until) <= Date.now() + 1500, exceeded.until);
    // Budgets are per owner and per provider; providers without a rate are not limited.
    await budgets.take('another-owner', 'Didi');
    for (let index = 0; index < 5; index++) await budgets.take('budget-owner', 'Amap');
    await f.db.query(`UPDATE ${f.db.schema}.provider_budgets SET refilled_at=refilled_at-interval '2 seconds' WHERE owner='budget-owner'`);
    await budgets.take('budget-owner', 'Didi');

    // A source Function takes a token from its caller's budget before it reads the provider.
    const document = structuredClone(f.model.document);
    const ping = { apiName: 'PingDidi', description: 'Read nothing from Didi, as a budget probe', version: '1', source: 'Didi',
      parameters: { type: 'object' }, returns: { type: 'boolean' } };
    document.functionTypes.push(ping);
    const configured = process.env.EIGOS_PROVIDER_RATES;
    process.env.EIGOS_PROVIDER_RATES = JSON.stringify({ Didi: { perMinute: 1, burst: 2 } });
    let capabilities;
    try {
      capabilities = createCapabilities(f.db, f.source, { functions: [{ definition: ping, implementationId: 'ping-didi-1', handler: async () => true }] });
    } finally {
      if (configured === undefined) delete process.env.EIGOS_PROVIDER_RATES; else process.env.EIGOS_PROVIDER_RATES = configured;
    }
    const model = await f.metadata.publish(document, capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const call = async () => capabilities.functions.invoke(model, 'PingDidi', {},
      { principal, objects: new Objects(f.db, model, await Access.load(f.db, principal)), signal: AbortSignal.timeout(30_000) });
    assert.equal(await call(), true);
    assert.equal(await call(), true);
    await assert.rejects(call(), ProviderBudgetExceeded);

    // A model tool may catch its sanitized error. The original budget error still defers the task in the Worker.
    const agent = new OntologyAgent(f.db, f.metadata, f.tasks, capabilities, {
      provider: harnessProvider,
      model: 'synthetic-budget-probe',
      async run(_prompt, tools) {
        await tools.get('complete_with_function')!.invoke({ function: 'PingDidi', input: {} }).catch(() => {});
      },
    });
    const task = await f.tasks.submit(principal, { requestId: 'over-budget', message: 'PingDidi' });
    const worker = new Worker(f.tasks, agent);
    assert.equal(await worker.runOne(), true);
    const row = (await f.db.query<{ state: string; available_at: Date }>(`SELECT state,available_at FROM ${f.db.schema}.tasks WHERE id=$1`, [task.id])).rows[0]!;
    assert.equal(row.state, 'submitted');
    assert(row.available_at.getTime() > Date.now());
    assert.equal(await worker.runOne(), false);
    await f.db.query(`UPDATE ${f.db.schema}.provider_budgets SET refilled_at=refilled_at-interval '2 minutes' WHERE owner=$1`, [principal.owner]);
    await f.db.query(`UPDATE ${f.db.schema}.tasks SET available_at=now() WHERE id=$1`, [task.id]);
    assert.equal(await worker.runOne(), true);
    assert.equal((await f.tasks.get(principal, task.id)).state, 'completed');
  } finally { await f.close(); }
});
