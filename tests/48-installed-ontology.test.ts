import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { Database } from '../packages/runtime/database.js';
import { loadInstallation } from '../packages/runtime/installation.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { Metadata } from '../packages/runtime/metadata.js';
import { Objects } from '../packages/runtime/objects.js';
import { Tasks } from '../packages/runtime/tasks.js';
import { ChangeSubscriptions } from '../packages/runtime/change-subscriptions.js';
import { ObservationInterests } from '../packages/runtime/observation-interests.js';
import { ScheduledActions, ScheduledActionRunner } from '../packages/runtime/scheduled-actions.js';
import { upgradePublicationStorage } from '../packages/runtime/upgrade.js';

test('installed Ontologies scope inbox identity, scheduled promotion, observations and subscription wakes', async () => {
  const url = process.env.EIGOS_TEST_DATABASE_URL!;
  assert.equal(new URL(url).hostname, '127.0.0.1');
  assert.equal(new URL(url).password, 'synthetic-only');
  const installation = await loadInstallation(resolve('tests/fixtures/installed-ontology/installation.json'));
  const db = new Database(url, 'eigos_record_' + randomUUID().replaceAll('-', ''));
  const principal = { owner: 'sender', clientId: 'original-pa', scopes: ['tasks:read', 'tasks:write', 'ontology:read', 'ontology:write'] };
  try {
    await db.initialize();
    const metadata = new Metadata(db, 'TestRecord'), runtime = installation.assemble(db);
    await setGrants(db, 'publisher', ['TestRecord','SecondFixture'].map(resource => ({ resource, permission: 'manage_definition' })));
    const publish = await Access.load(db, { owner: 'publisher', scopes: [] });
    const record = await metadata.publish(installation.model.document, runtime, publish);
    const fixture = await metadata.publish({ ...record.document, id: 'SecondFixture' }, runtime, publish);
    const grants = [...businessGrants(record), ...businessGrants(fixture)];
    await setGrants(db, principal.owner, grants);
    const access = await Access.load(db, principal);
    const tasks = new Tasks(db, metadata), message = { message: 'synthetic inquiry', requestId: 'same', conversationId: 'chat' };
    const first = await tasks.submit(principal, message);
    // Recreate the prior table constraints with a persisted inbox event in this test's private schema.
    await db.query(`DROP TRIGGER assign_task_ontology ON ${db.schema}.tasks;
      DROP FUNCTION ${db.schema}.assign_task_ontology();
      ALTER TABLE ${db.schema}.tasks DROP COLUMN ontology, ADD UNIQUE(owner,request_id);
      CREATE UNIQUE INDEX tasks_conversation_batch ON ${db.schema}.tasks(owner,conversation_id,conversation_batch) WHERE conversation_id IS NOT NULL;
      ALTER TABLE ${db.schema}.task_inbox_events DROP COLUMN ontology, ADD PRIMARY KEY(owner,request_id);`);
    await upgradePublicationStorage(db);
    const second = await tasks.submit(principal, message, { ontologyId: 'SecondFixture' });
    assert.notEqual(first.id, second.id);
    assert.equal(first.release, record.release); assert.equal(second.release, fixture.release);
    assert.equal((await tasks.submit(principal, message)).id, first.id);
    await assert.rejects(tasks.submit({ ...principal, clientId: 'other-pa' }, message), /another PA/);
    await tasks.cancel(principal, first.id); await tasks.cancel(principal, second.id);
    const ref = { type: 'TestRecord', id: 's1' };
    const graph = new Objects(db, fixture, access);
    await graph.create(ref, { id: ref.id, name: 'Synthetic', state: 'open' });
    const deadline = new Date(Date.now() + 600000).toISOString();
    const schedule = new ScheduledActions(db, metadata);
    // Promotion uses the database clock. Supply an already-due time from that same clock.
    const due = (await db.query<{ at: Date }>("SELECT now() - interval '1 second' AS at")).rows[0]!.at.toISOString();
    const job = { id: randomUUID(), action: 'CloseRecord', arguments: { record: ref }, runAt: due, deadline };
    await assert.rejects(schedule.enqueue(graph, { ...job, sourceTaskId: first.id }), /mismatch/);
    await schedule.enqueue(graph, { ...job, sourceTaskId: second.id });
    const current = await metadata.publish({ ...fixture.document, version: '2' }, runtime, publish);
    const observations = new ObservationInterests(db, metadata), subscriptions = new ChangeSubscriptions(db, tasks);
    const interest = await observations.start(access, current, { requestId: 'watch', object: ref, deadline,
      phases: [{ name: 'closure', process: 'TestRecordStateLog', complete: ['closed'], wait: { maxSilenceSeconds: 300 } }] });
    const sub = await subscriptions.subscribe(access, current, { requestId: 'watch', conversationId: 'updates', types: ['TestRecord'] });
    // A commit by this same owner to the same type in the other Ontology must not wake SecondFixture.
    await new Objects(db, record, access).create(ref, { id: ref.id, name: 'Other', state: 'open' });
    assert(await subscriptions.scanOne());
    assert.equal((await db.query(`SELECT id FROM ${db.schema}.tasks WHERE conversation_id='updates'`)).rowCount, 0);
    assert(await schedule.promoteOne()); assert.equal(await schedule.promoteOne(), false);
    const scheduled = (await tasks.claim('scheduled'))!;
    assert.equal(scheduled.release, current.release); assert.equal(scheduled.input.paClient, principal.clientId);
    const outcome = await new ScheduledActionRunner(db, metadata, tasks, runtime.actions).run(scheduled, AbortSignal.timeout(10000));
    await tasks.finish(scheduled, 'completed', outcome.value, undefined, outcome.permissions);
    await db.query(`UPDATE ${db.schema}.observation_interests SET next_scan=now() WHERE id=$1`, [interest.id]);
    assert(await observations.scanOne());
    assert.equal((await db.query(`SELECT state FROM ${db.schema}.observation_interests WHERE id=$1`, [interest.id])).rows[0]?.state, 'completed');
    await db.query(`UPDATE ${db.schema}.change_subscriptions SET last_scan=NULL WHERE id=$1`, [sub.id]);
    assert(await subscriptions.scanOne());
    const wake = (await db.query(`SELECT release,input FROM ${db.schema}.tasks WHERE conversation_id='updates'`)).rows;
    assert.equal(wake.length, 1); assert.equal(wake[0]!.release, current.release);
    assert.equal(wake[0]!.input.paClient, principal.clientId);
    const revoked = { ...job, id: randomUUID() };
    await schedule.enqueue(new Objects(db, current, access), revoked);
    await setGrants(db, principal.owner, []);
    assert(await schedule.promoteOne());
    assert.equal((await db.query(`SELECT state FROM ${db.schema}.scheduled_actions WHERE id=$1`, [revoked.id])).rows[0]?.state, 'blocked');
  } finally { await db.query('DROP SCHEMA IF EXISTS ' + db.schema + ' CASCADE'); await db.close(); }
});
