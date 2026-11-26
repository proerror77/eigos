import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { dispatchAutomation } from '../apps/indexer/dispatch.js';
import { profileDatabase } from '../packages/core/database-profile.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { Actions } from '../packages/runtime/actions.js';
import { initializeActionUndo } from '../packages/runtime/action-journal.js';
import { Automation, initializeAutomation } from '../packages/runtime/automation.js';
import { changedObjects, footprintChanged, latestCommit, queryFootprint } from '../packages/runtime/change-feed.js';
import { Objects } from '../packages/runtime/objects.js';
import { initializeScenarioLifecycle } from '../packages/runtime/scenarios.js';
import { fixture, principal } from './fixture.js';

const route = (id: string) => ({ type: 'Route', id });

async function setup(customize?: (document: Awaited<ReturnType<typeof fixture>>['model']['document']) => void) {
  const f = await fixture();
  await initializeActionUndo(f.db); await initializeScenarioLifecycle(f.db); await initializeAutomation(f.db);
  const document = structuredClone(f.model.document);
  customize?.(document);
  document.actionTypes.push({ apiName: 'CopyRoute', description: 'Copy an authorized route name into a new Route',
    parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'], additionalProperties: false },
    objectParameters: {}, submissionCriteria: [], rules: [{ op: 'createObject', object: { type: 'Route', id: { parameter: 'id' } },
      properties: { id: { parameter: 'id' }, name: { parameter: 'name' } } }], result: { type: 'Route', id: { parameter: 'id' } } });
  const model = await f.metadata.publish(document, f.capabilities, f.publisher);
  await setGrants(f.db, principal.owner, businessGrants(model));
  const access = await Access.load(f.db, principal), objects = new Objects(f.db, model, access);
  const automation = new Automation(f.db, f.metadata, new Actions(f.db, f.capabilities.functions));
  const workflow = await automation.workflow(access, model, { name: 'Copy route', steps: [{ name: 'Copy', action: 'CopyRoute', input: { id: { property: 'name' }, name: { literal: 'Copied' } } }] });
  const state = async (rule: string) => (await f.db.query(`SELECT match_commit::text AS commit, match_reconciled_at AS reconciled,
      (SELECT coalesce(max(commit_seq),0)::text FROM ${f.db.schema}.change_commits WHERE owner=$2) AS latest
    FROM ${f.db.schema}.object_rules WHERE id=$1`, [rule, principal.owner])).rows[0]!;
  // Each scan makes the rule due first, measures the statements it ran, and reports whether it re-read the whole set.
  const scan = async (rule: string) => {
    await f.db.query(`UPDATE ${f.db.schema}.object_rules SET last_scan=NULL WHERE id=$1`, [rule]);
    const before = (await state(rule)).reconciled as Date | null;
    let statements = 0;
    await profileDatabase(async profile => { assert.equal(await automation.scanObjectRules(), true); statements = profile.statements; });
    const after = await state(rule);
    return { statements, full: before?.getTime() !== (after.reconciled as Date | null)?.getTime(), caughtUp: after.commit === after.latest };
  };
  const runs = async () => (await f.db.query(`SELECT object_ref->>'id' AS id FROM ${f.db.schema}.workflow_runs ORDER BY id`)).rows.map(row => String(row.id)).sort();
  const matched = async (rule: string, id: string) => (await f.db.query(`SELECT matched, generation::int FROM ${f.db.schema}.rule_matches
    WHERE rule_id=$1 AND type='Route' AND id=$2`, [rule, id])).rows[0] as { matched: boolean; generation: number } | undefined;
  return { ...f, model, access, objects, automation, workflow, scan, runs, matched };
}

test('an object-set rule re-evaluates only changed objects, and an idle scan reads only the journal', async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 30; i++) await f.objects.create(route('r' + i), { id: 'r' + i, name: i < 3 ? 'hot lane' : 'cold lane' });
    // The text filter is evaluated outside SQL, so the candidate path must restrict that evaluation as well.
    const rule = await f.automation.rule(f.access, f.model, { name: 'Hot routes', workflow: f.workflow.id,
      query: { type: 'Route', filter: { op: 'text', property: 'name', value: 'hot' } }, enabled: true });
    const first = await f.scan(rule.id);
    assert.equal(first.full, true);
    assert.deepEqual(await f.runs(), ['r0', 'r1', 'r2']);
    const idle = await f.scan(rule.id);
    assert.equal(idle.full, false);
    assert(idle.caughtUp);
    for (let i = 30; i < 120; i++) await f.objects.create(route('r' + i), { id: 'r' + i, name: 'cold lane' });
    const larger = await f.scan(rule.id);
    assert.equal(larger.full, false, 'new non-matching objects are re-evaluated as candidates, not by re-reading the set');
    const idleAgain = await f.scan(rule.id);
    assert.equal(idleAgain.statements, idle.statements, 'an idle scan costs the same however large the set is');
    const edit = async (id: string, name: string) => f.objects.edit(route(id), (await f.objects.read(route(id))).revision, { name });
    await edit('r10', 'hot lane');
    const entered = await f.scan(rule.id);
    assert.equal(entered.full, false);
    assert(entered.statements < first.statements + 10, `one changed object costs ${entered.statements} statements`);
    assert.deepEqual(await f.runs(), ['r0', 'r1', 'r10', 'r2']);
    await edit('r10', 'cold lane'); await f.scan(rule.id);
    assert.equal((await f.matched(rule.id, 'r10'))?.matched, false);
    await edit('r10', 'hot lane'); await f.scan(rule.id);
    assert.deepEqual(await f.matched(rule.id, 'r10'), { matched: true, generation: 2 });
    assert.equal((await f.runs()).filter(id => id === 'r10').length, 2, 'leaving and re-entering triggers again');
    await f.objects.remove(route('r0'), (await f.objects.read(route('r0'))).revision);
    await f.scan(rule.id);
    assert.equal((await f.matched(rule.id, 'r0'))?.matched, false);
    assert.equal((await f.runs()).length, 5);
  } finally { await f.close(); }
});

test('a rule over a relationship re-reads its set only after a change in its footprint', async () => {
  const f = await setup();
  try {
    const request = { type: 'RideRequest', id: 'request' }, other = { type: 'RideRequest', id: 'other' };
    const fields = (id: string) => ({ id, name: id, status: 'requested', requestedAt: new Date().toISOString() });
    await f.objects.create(request, fields('request'));
    await f.objects.create(route('linked'), { id: 'linked', name: 'Linked' });
    const edge = { type: 'RequestRoute', from: request, to: route('linked') };
    await f.objects.link(edge);
    const rule = await f.automation.rule(f.access, f.model, { name: 'Linked route', workflow: f.workflow.id,
      query: { type: 'Route', from: { object: request, link: 'route' } }, enabled: true });
    assert.deepEqual(queryFootprint(f.model, { type: 'Route', where: {}, from: { object: request, link: 'route' } }),
      { types: ['Route'], links: ['RequestRoute'], local: false });
    assert.equal((await f.scan(rule.id)).full, true);
    assert.deepEqual(await f.runs(), ['linked']);
    await f.objects.create(other, fields('other'));
    const unrelated = await f.scan(rule.id);
    assert.equal(unrelated.full, false, 'a RideRequest edit is outside the footprint');
    assert(unrelated.caughtUp);
    await f.objects.unlink(edge);
    assert.equal((await f.scan(rule.id)).full, true);
    assert.equal((await f.matched(rule.id, 'linked'))?.matched, false);
    await f.objects.link(edge);
    assert.equal((await f.scan(rule.id)).full, true);
    assert.deepEqual(await f.runs(), ['linked', 'linked'], 'relationship-driven re-entry triggers again');
  } finally { await f.close(); }
});

test('a rule over a derived property re-reads its set after the linked object changes', async () => {
  const f = await setup(document => {
    document.objectTypes.find(type => type.apiName === 'Route')!.properties.originCity = { description: 'City of the linked origin',
      schema: { type: 'string' }, required: false, derived: { op: 'linked', path: [{ link: 'origin' }], aggregate: 'select', property: 'city' } };
  });
  try {
    const place = { type: 'Place', id: 'start' };
    const placeFields = (city: string) => ({ id: 'start', name: 'Start', city, address: 'A', coordinates: { lat: 31, lng: 121 },
      coordinateSystem: 'GCJ02', sourceBinding: 'test', observedAt: new Date().toISOString() });
    await f.objects.create(place, placeFields('Shanghai'));
    await f.objects.create(route('trip'), { id: 'trip', name: 'Trip' });
    await f.objects.link({ type: 'RouteOrigin', from: route('trip'), to: place });
    const query = { type: 'Route', where: { originCity: 'Shanghai' } };
    assert.deepEqual(queryFootprint(f.model, query), { types: ['Place', 'Route'], links: ['RouteOrigin'], local: false });
    const rule = await f.automation.rule(f.access, f.model, { name: 'From Shanghai', workflow: f.workflow.id, query, enabled: true });
    assert.equal((await f.scan(rule.id)).full, true);
    assert.deepEqual(await f.runs(), ['trip']);
    await f.objects.create({ type: 'RideRequest', id: 'request' }, { id: 'request', name: 'request', status: 'requested', requestedAt: new Date().toISOString() });
    assert.equal((await f.scan(rule.id)).full, false, 'a RideRequest edit is outside the footprint');
    const city = async (name: string) => f.objects.edit(place, (await f.objects.read(place)).revision, { city: name });
    await city('Beijing');
    assert.equal((await f.scan(rule.id)).full, true);
    assert.equal((await f.matched(rule.id, 'trip'))?.matched, false, 'the route left the set without changing itself');
    await city('Shanghai');
    await f.scan(rule.id);
    assert.deepEqual(await f.runs(), ['trip', 'trip']);
  } finally { await f.close(); }
});

test('a change of visibility or publication re-reads the whole set', async () => {
  const f = await setup();
  try {
    await f.objects.create(route('hot'), { id: 'hot', name: 'hot' });
    const rule = await f.automation.rule(f.access, f.model, { name: 'Hot', workflow: f.workflow.id, query: { type: 'Route', where: { name: 'hot' } }, enabled: true });
    assert.equal((await f.scan(rule.id)).full, true);
    assert.equal((await f.scan(rule.id)).full, false);
    await f.db.query(`INSERT INTO ${f.db.schema}.security_memberships(subject,kind,name) VALUES($1,'group','incremental-test')`, [principal.owner]);
    assert.equal((await f.scan(rule.id)).full, true, 'a new security membership can change what the rule sees');
    assert.equal((await f.scan(rule.id)).full, false);
    // Activation waits for unfinished runs; the queued synthetic run is not executed here.
    await f.db.query(`UPDATE ${f.db.schema}.workflow_runs SET state='canceled'`);
    const document = structuredClone(f.model.document);
    document.actionTypes.push({ ...structuredClone(document.actionTypes.find(action => action.apiName === 'CopyRoute')!), apiName: 'CopyRouteAgain' });
    const model = await f.metadata.publish(document, f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    assert.notEqual(model.release, f.model.release);
    assert.equal((await f.scan(rule.id)).full, true, 'a new publication re-reads the set');
    await f.db.query(`UPDATE ${f.db.schema}.object_rules SET match_reconciled_at=now()-interval '11 minutes' WHERE id=$1`, [rule.id]);
    assert.equal((await f.scan(rule.id)).full, true, 'the reconcile interval re-reads the set');
    assert.deepEqual(await f.runs(), ['hot']);
  } finally { await f.close(); }
});

test('a scan does not consume a commit that is still open, and picks it up after it commits', async () => {
  const f = await setup();
  try {
    await f.objects.create(route('late'), { id: 'late', name: 'cold' });
    const rule = await f.automation.rule(f.access, f.model, { name: 'Hot', workflow: f.workflow.id, query: { type: 'Route', where: { name: 'hot' } }, enabled: true });
    await f.scan(rule.id);
    let release!: () => void, written!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; }), inside = new Promise<void>(resolve => { written = resolve; });
    const open = f.db.objectScopedTransaction(async client => {
      const graph = new Objects(f.db, f.model, f.access, client);
      await graph.edit(route('late'), (await graph.read(route('late'))).revision, { name: 'hot' });
      written();
      await released;
    }, 'test');
    await inside;
    const during = await f.scan(rule.id);
    assert(during.caughtUp);
    assert.deepEqual(await f.runs(), []);
    release(); await open;
    await f.scan(rule.id);
    assert.deepEqual(await f.runs(), ['late']);
  } finally { await f.close(); }
});

test('the change feed reads bounded commit windows and reports more changed objects than one read takes', async () => {
  const f = await setup();
  try {
    const client = f.db.pool, owner = principal.owner, projection = f.model.projection;
    const start = await latestCommit(f.db, owner, client);
    for (const id of ['a', 'b', 'c']) await f.objects.create(route(id), { id, name: id });
    await f.objects.create({ type: 'RideRequest', id: 'request' }, { id: 'request', name: 'request', status: 'requested', requestedAt: new Date().toISOString() });
    const latest = await latestCommit(f.db, owner, client);
    const commits = (await f.db.query(`SELECT commit_seq::text AS commit FROM ${f.db.schema}.change_commits WHERE owner=$1 AND commit_seq>$2 ORDER BY commit_seq`,
      [owner, start])).rows.map(row => String(row.commit));
    assert.equal(commits.length, 4);
    const window = await changedObjects(f.db, owner, projection, ['Route'], client, start, latest, { commits: 2 });
    assert.deepEqual(window, { refs: [route('a'), route('b')].sort((x, y) => x.id.localeCompare(y.id)), end: commits[1] });
    const rest = await changedObjects(f.db, owner, projection, ['Route'], client, window.end, latest, { commits: 2 });
    assert.deepEqual(rest.refs, [route('c')]);
    assert.equal(rest.end, commits[3]);
    assert.deepEqual(await changedObjects(f.db, owner, projection, ['Route'], client, latest, latest), { refs: [], end: latest });
    assert.equal((await changedObjects(f.db, owner, projection, ['Route'], client, start, latest, { objects: 2 })).refs, undefined);
    const linksOnly = { types: [], links: ['RequestRoute'], local: false };
    assert.deepEqual(await footprintChanged(f.db, owner, linksOnly, client, start, latest), { changed: false, end: latest });
    await f.objects.link({ type: 'RequestRoute', from: { type: 'RideRequest', id: 'request' }, to: route('a') });
    const linked = await latestCommit(f.db, owner, client);
    assert.deepEqual(await footprintChanged(f.db, owner, linksOnly, client, latest, linked), { changed: true, end: linked });
  } finally { await f.close(); }
});

test('a slow change consumer does not delay the other consumers', async () => {
  const controller = new AbortController();
  let fast = 0, release!: () => void, third!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), threeScans = new Promise<void>(resolve => { third = resolve; });
  const dispatch = dispatchAutomation({
    cleanup: async () => ({ more: false }),
    scans: [async () => { await blocked; return false; }, async () => { if (++fast === 3) third(); return false; }],
    run: async () => false,
  }, controller.signal, 5);
  try {
    await Promise.race([threeScans, delay(2000).then(() => { throw new Error('A slow consumer delayed another consumer'); })]);
  } finally { release(); controller.abort(); await dispatch; }
});
