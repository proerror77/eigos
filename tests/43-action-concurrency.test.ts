import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Conflict } from '../packages/core/identity.js';
import { profileDatabase, type DatabaseProfile } from '../packages/core/database-profile.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { fixture, principal } from './fixture.js';

const reference = { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false };
const route = (id: string): ObjectRef => ({ type: 'Route', id });

async function concurrency() {
  const f = await fixture();
  const renameInput = { type: 'object', properties: { route: reference, revision: { type: 'integer' }, name: { type: 'string' } },
    required: ['route', 'revision', 'name'], additionalProperties: false };
  const claimInput = { type: 'object', properties: { id: { type: 'string' }, slot: { type: 'string' } }, required: ['id', 'slot'], additionalProperties: false };
  const originInput = { type: 'object', properties: { route: reference, place: reference }, required: ['route', 'place'], additionalProperties: false };
  const rename = { apiName: 'StageRouteRename', description: 'Stage a route rename', version: '1', parameters: renameInput, returns: reference,
    edits: true, dependencies: { objectTypes: ['Route'] } };
  const claim = { apiName: 'StageSlotClaim', description: 'Claim a free slot by creating its route', version: '1', parameters: claimInput,
    returns: reference, edits: true, dependencies: { objectTypes: ['Route'] } };
  const origin = { apiName: 'StageRouteOrigin', description: 'Link a route to its origin', version: '1', parameters: originInput,
    returns: reference, edits: true, dependencies: { objectTypes: ['Route', 'Place'], linkTypes: ['RouteOrigin'] } };
  const document = structuredClone(f.model.document);
  document.functionTypes.push(rename, claim, origin);
  document.actionTypes.push(
    { apiName: 'RenameRouteConcurrently', description: 'Rename one route', parameters: renameInput, objectParameters: { route: 'Route' },
      submissionCriteria: [], function: rename.apiName },
    { apiName: 'ClaimSlot', description: 'Claim a slot once', parameters: claimInput, objectParameters: {}, submissionCriteria: [], function: claim.apiName },
    { apiName: 'SetRouteOrigin', description: 'Set the origin of a route', parameters: originInput, objectParameters: { route: 'Route', place: 'Place' },
      submissionCriteria: [], function: origin.apiName },
  );
  const capabilities = createCapabilities(f.db, f.source, { functions: [
    { definition: rename, implementationId: 'stage-route-rename-v1', handler: async (args, context) => {
      const target = args.route as ObjectRef;
      return context.edit!(target, graph => graph.edit(target, Number(args.revision), { name: String(args.name) }));
    } },
    { definition: claim, implementationId: 'stage-slot-claim-v1', handler: async (args, context) => {
      const target = route(String(args.id));
      return context.edit!(target, async graph => {
        if ((await graph.query({ type: 'Route', where: { name: String(args.slot) } })).items.length) throw new Conflict('Slot already claimed');
        await graph.create(target, { id: target.id, name: String(args.slot) });
      });
    } },
    { definition: origin, implementationId: 'stage-route-origin-v1', handler: async (args, context) => {
      const target = args.route as ObjectRef;
      return context.edit!(target, graph => graph.link({ type: 'RouteOrigin', from: target, to: args.place as ObjectRef }));
    } },
  ] });
  const model = await f.metadata.publish(document, capabilities, f.publisher);
  await setGrants(f.db, principal.owner, businessGrants(model));
  const access = await Access.load(f.db, principal), graph = new Objects(f.db, model, access);
  const apply = (action: string, input: Record<string, unknown>, requestId: string, beforeCommit?: () => Promise<void>) =>
    capabilities.actions.apply(access, model, action, input, requestId, beforeCommit);
  return { ...f, model, capabilities, access, graph, apply };
}

/** Holds a commit open after its edits, while it holds the Ontology edit lock. */
function holdCommit() {
  let release!: () => void, entered!: () => void, calls = 0;
  const released = new Promise<void>(resolve => { release = resolve; }), inside = new Promise<void>(resolve => { entered = resolve; });
  return { release, inside, beforeCommit: async () => { if (++calls === 2) { entered(); await released; } } };
}

test('writes to different objects of one owner commit while another commit still holds its edit lock', async () => {
  const f = await concurrency(), holder = holdCommit();
  try {
    for (const id of ['a', 'b']) await f.graph.create(route(id), { id, name: 'start' });
    const first = f.apply('RenameRouteConcurrently', { route: route('a'), revision: 1, name: 'A' }, 'rename-a', holder.beforeCommit);
    await holder.inside;
    let profile!: DatabaseProfile;
    const started = performance.now();
    await profileDatabase(async measured => { profile = measured;
      await f.apply('RenameRouteConcurrently', { route: route('b'), revision: 1, name: 'B' }, 'rename-b'); });
    const elapsed = performance.now() - started;
    holder.release();
    await first;
    assert(elapsed < 1000, `the second commit waited ${Math.round(elapsed)} ms behind the held one`);
    assert(profile.editLockWaitMs < 500, `edit lock wait ${profile.editLockWaitMs} ms`);
    assert.equal((await f.graph.read(route('a'))).properties.name, 'A');
    assert.equal((await f.graph.read(route('b'))).properties.name, 'B');
  } finally { holder.release(); await f.close(); }
});

test('many concurrent commits on unrelated objects all commit, rerunning conflicted ones with the exclusive lock', async () => {
  const f = await concurrency();
  try {
    const count = 24;
    for (let index = 0; index < count; index++) await f.graph.create(route('busy-' + index), { id: 'busy-' + index, name: 'start' });
    const slow = () => { let calls = 0; return async () => { if (++calls === 2) await delay(20); }; };
    let profile!: DatabaseProfile;
    const results = await profileDatabase(async measured => { profile = measured;
      return Promise.allSettled(Array.from({ length: count }, (_, index) => f.apply('RenameRouteConcurrently',
        { route: route('busy-' + index), revision: 1, name: 'renamed-' + index }, 'busy-' + index, slow()))); });
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => String(result.reason));
    assert.deepEqual(failures, []);
    for (let index = 0; index < count; index++) assert.equal((await f.graph.read(route('busy-' + index))).properties.name, 'renamed-' + index);
    assert(profile.commitFallbacks < count, `${profile.commitFallbacks} of ${count} commits fell back to the exclusive lock`);
  } finally { await f.close(); }
});

test('concurrent edits of one object commit once and report the other as a revision conflict', async () => {
  const f = await concurrency();
  try {
    await f.graph.create(route('shared'), { id: 'shared', name: 'start' });
    const results = await Promise.allSettled(['X', 'Y'].map(name =>
      f.apply('RenameRouteConcurrently', { route: route('shared'), revision: 1, name }, 'rename-' + name)));
    const committed = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(committed.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]!.reason), /revision changed/);
    const stored = await f.graph.read(route('shared'));
    assert.equal(stored.revision, 2);
    assert.equal(stored.properties.name, results[0]!.status === 'fulfilled' ? 'X' : 'Y');
  } finally { await f.close(); }
});

test('two concurrent claims that each check the same free slot commit only one', async () => {
  const f = await concurrency(), holder = holdCommit();
  try {
    const first = f.apply('ClaimSlot', { id: 'claim-x', slot: 'slot-1' }, 'claim-x', holder.beforeCommit);
    await holder.inside;
    const second = f.apply('ClaimSlot', { id: 'claim-y', slot: 'slot-1' }, 'claim-y');
    await delay(300);
    holder.release();
    const results = await Promise.allSettled([first, second]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]!.reason), /already claimed/);
    assert.equal((await f.graph.query({ type: 'Route', where: { name: 'slot-1' } })).items.length, 1);
  } finally { holder.release(); await f.close(); }
});

test('concurrent links to a single-valued relationship keep its cardinality', async () => {
  const f = await concurrency();
  try {
    await f.graph.create(route('trip'), { id: 'trip', name: 'Trip' });
    for (const id of ['p1', 'p2']) await f.graph.create({ type: 'Place', id }, { id, name: id, city: 'Shanghai', address: 'A',
      coordinates: { lat: 31, lng: 121 }, coordinateSystem: 'GCJ02', sourceBinding: 'test', observedAt: new Date().toISOString() });
    const results = await Promise.allSettled(['p1', 'p2'].map(id =>
      f.apply('SetRouteOrigin', { route: route('trip'), place: { type: 'Place', id } }, 'origin-' + id)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]!.reason), /cardinality/);
    assert.equal((await f.graph.follow(route('trip'), 'origin')).length, 1);
  } finally { await f.close(); }
});

test('a repeated request ID submitted concurrently commits one Action receipt', async () => {
  const f = await concurrency();
  try {
    await f.graph.create(route('once'), { id: 'once', name: 'start' });
    const input = { route: route('once'), revision: 1, name: 'Once' };
    const results = await Promise.all([f.apply('RenameRouteConcurrently', input, 'same-request'),
      f.apply('RenameRouteConcurrently', input, 'same-request')]);
    assert.deepEqual(results[0], results[1]);
    assert.equal((await f.db.query(`SELECT count(*)::int AS count FROM ${f.db.schema}.actions WHERE request_id='same-request'`)).rows[0]!.count, 1);
    assert.equal((await f.graph.read(route('once'))).revision, 2);
  } finally { await f.close(); }
});

test('a release switch waits for an open commit and rejects a candidate prepared before it landed', async () => {
  const f = await concurrency(), holder = holdCommit();
  try {
    await f.graph.create(route('versioned'), { id: 'versioned', name: 'start' });
    const first = f.apply('RenameRouteConcurrently', { route: route('versioned'), revision: 1, name: 'Before switch' }, 'before-switch', holder.beforeCommit);
    await holder.inside;
    const changed = structuredClone(f.model.document);
    changed.actionTypes.find(action => action.apiName === 'RenameRouteConcurrently')!.description = 'Rename one route in the next release';
    const candidate = await f.metadata.prepare(changed, f.capabilities, f.publisher);
    let settled = false;
    const switching = f.metadata.activate(candidate.release, f.capabilities, f.publisher).finally(() => { settled = true; });
    await delay(300);
    assert.equal(settled, false, 'activation must wait for the open commit');
    holder.release();
    await first;
    await assert.rejects(switching, /rebuild the candidate/);
    const next = await f.metadata.publish(changed, f.capabilities, f.publisher);
    assert.notEqual(next.release, f.model.release);
    assert.equal((await new Objects(f.db, next, await Access.load(f.db, principal)).read(route('versioned'))).properties.name, 'Before switch');
    await assert.rejects(f.apply('RenameRouteConcurrently', { route: route('versioned'), revision: 2, name: 'Old release' }, 'after-switch'),
      /read-only/);
  } finally { holder.release(); await f.close(); }
});
