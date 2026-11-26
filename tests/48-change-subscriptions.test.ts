import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Access, setGrants } from '../packages/runtime/access.js';
import { ChangeSubscriptions, type ChangeWake } from '../packages/runtime/change-subscriptions.js';
import { latestCommit } from '../packages/runtime/change-feed.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';

const route = (id: string) => ({ type: 'Route', id });
const place = (id: string) => ({ type: 'Place', id });
const placeFields = (id: string) => ({ id, name: id, city: 'Shanghai', address: 'A', coordinates: { lat: 31, lng: 121 }, coordinateSystem: 'GCJ02',
  sourceBinding: 'test', observedAt: new Date().toISOString() });

/** The wakes delivered to a conversation so far, in delivery order. */
async function wakes(f: Awaited<ReturnType<typeof fixture>>, subscription: string) {
  const { rows } = await f.db.query<{ message: string }>(`SELECT message FROM ${f.db.schema}.task_inbox_events WHERE owner=$1 AND request_id LIKE $2
    ORDER BY received_at, position`, [principal.owner, `subscription:${subscription}:%`]);
  return rows.map(row => JSON.parse(row.message) as ChangeWake);
}
/** Scans until no subscription is due, waiting out the once-a-second limit. */
async function drain(subscriptions: ChangeSubscriptions, f: Awaited<ReturnType<typeof fixture>>) {
  await f.db.query(`UPDATE ${f.db.schema}.change_subscriptions SET last_scan=NULL`);
  while (await subscriptions.scanOne()) await f.db.query(`UPDATE ${f.db.schema}.change_subscriptions SET last_scan=NULL WHERE position<(SELECT coalesce(max(commit_seq),0) FROM ${f.db.schema}.change_commits)`);
}

test('a subscriber is woken once for the commits that touch its footprint, and not for others', async () => {
  const f = await fixture();
  try {
    const graph = new Objects(f.db, f.model, f.access);
    await graph.create(route('r1'), { id: 'r1', name: 'first' });
    const subscriptions = new ChangeSubscriptions(f.db, f.tasks);
    const subscribed = await subscriptions.subscribe(f.access, f.model, { requestId: 'routes', conversationId: 'watch-routes', types: ['Route'], links: ['RouteOrigin'] });
    assert.equal(subscribed.position, await latestCommit(f.db, principal.owner, f.db.pool), 'a subscription starts at the latest commit');
    // Commits outside the footprint only advance the position.
    await graph.create(place('p1'), placeFields('p1'));
    await drain(subscriptions, f);
    assert.deepEqual(await wakes(f, subscribed.id), []);
    const [row] = (await f.db.query<{ position: string }>(`SELECT position::text FROM ${f.db.schema}.change_subscriptions WHERE id=$1`, [subscribed.id])).rows;
    assert.equal(row!.position, await latestCommit(f.db, principal.owner, f.db.pool));
    // An edit of a watched type and a link of a watched link type wake the subscriber with their window.
    const before = row!.position;
    await graph.edit(route('r1'), (await graph.read(route('r1'))).revision, { name: 'renamed' });
    await graph.link({ type: 'RouteOrigin', from: route('r1'), to: place('p1') });
    await drain(subscriptions, f);
    const delivered = await wakes(f, subscribed.id);
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0], { event: 'ontology_changes', subscription: subscribed.id,
      commits: { after: before, through: await latestCommit(f.db, principal.owner, f.db.pool) }, types: ['Route'], links: ['RouteOrigin'] });
    // Scanning again delivers nothing new; subscribing again with the same request is the same subscription.
    await drain(subscriptions, f);
    assert.equal((await wakes(f, subscribed.id)).length, 1);
    assert.equal((await subscriptions.subscribe(f.access, f.model, { requestId: 'routes', conversationId: 'watch-routes', types: ['Route'], links: ['RouteOrigin'] })).id, subscribed.id);
    await assert.rejects(subscriptions.subscribe(f.access, f.model, { requestId: 'routes', conversationId: 'watch-routes', types: ['Place'] }), /different subscription/);
    // A query's footprint adds what its derived properties read; a cancelled subscription is not woken.
    const byQuery = await subscriptions.subscribe(f.access, f.model, { requestId: 'query', conversationId: 'watch-query', query: { type: 'Route' } });
    assert(byQuery.footprint.types.includes('Route'));
    await subscriptions.cancel(f.access, subscribed.id);
    await graph.edit(route('r1'), (await graph.read(route('r1'))).revision, { name: 'renamed again' });
    await drain(subscriptions, f);
    assert.equal((await wakes(f, subscribed.id)).length, 1);
    assert.equal((await wakes(f, byQuery.id)).length, 1);
    assert.deepEqual((await subscriptions.list(f.access)).map(item => item.id), [byQuery.id]);
  } finally { await f.close(); }
});

test('concurrent dispatchers deliver contiguous commit windows, none twice and none missed', async () => {
  const f = await fixture();
  try {
    const graph = new Objects(f.db, f.model, f.access);
    await graph.create(route('hot'), { id: 'hot', name: 'v0' });
    const subscriptions = new ChangeSubscriptions(f.db, f.tasks), other = new ChangeSubscriptions(f.db, f.tasks);
    const subscribed = await subscriptions.subscribe(f.access, f.model, { requestId: 'hot', conversationId: 'watch-hot', types: ['Route'] });
    let writing = true;
    const writes = (async () => {
      for (let i = 1; i <= 60; i++) await graph.edit(route('hot'), (await graph.read(route('hot'))).revision, { name: 'v' + i });
      writing = false;
    })();
    const dispatch = async (dispatcher: ChangeSubscriptions) => {
      while (writing) {
        await f.db.query(`UPDATE ${f.db.schema}.change_subscriptions SET last_scan=NULL`);
        await dispatcher.scanOne();
      }
    };
    await Promise.all([writes, dispatch(subscriptions), dispatch(other)]);
    await drain(subscriptions, f);
    const windows = (await wakes(f, subscribed.id)).map(wake => wake.commits).sort((a, b) => Number(BigInt(a.after) - BigInt(b.after)));
    assert(windows.length > 1, `the writes spread over ${windows.length} wakes`);
    assert.equal(windows[0]!.after, subscribed.position);
    for (let i = 1; i < windows.length; i++) assert.equal(windows[i]!.after, windows[i - 1]!.through, 'each window starts where the last ended');
    assert.equal(windows.at(-1)!.through, await latestCommit(f.db, principal.owner, f.db.pool));
  } finally { await f.close(); }
});

test('subscribing requires reading every watched type and submitting tasks', async () => {
  const f = await fixture();
  try {
    const subscriptions = new ChangeSubscriptions(f.db, f.tasks);
    await setGrants(f.db, 'reader-without-routes', [{ resource: 'Eigos', permission: 'view_definition' }]);
    const limited = await Access.load(f.db, { owner: 'reader-without-routes', scopes: ['tasks:write'] });
    await assert.rejects(subscriptions.subscribe(limited, f.model, { requestId: 'x', conversationId: 'c', types: ['Route'] }), /Permission/);
    const noTasks = await Access.load(f.db, { owner: principal.owner, scopes: ['ontology:read'] });
    await assert.rejects(subscriptions.subscribe(noTasks, f.model, { requestId: 'y', conversationId: 'c', types: ['Route'] }), /tasks:write/);
  } finally { await f.close(); }
});
