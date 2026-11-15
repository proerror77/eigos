import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Database } from '../packages/runtime/database.js';
import { Objects } from '../packages/runtime/objects.js';
import { assertOwnerIsolation, installOwnerIsolation } from '../packages/runtime/owner-isolation.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { OntologyClient } from '../packages/sdk/client.js';
import { fixture, principal } from './fixture.js';

test('owner RLS isolates a restricted role and cross-account approval exposes only the exact proposal', async () => {
  const f = await fixture();
  const reviewer = { ...principal, owner: 'proposal-reviewer' };
  const role = 'eigos_rls_' + f.schema.slice(-32);
  let limited: Database | undefined;
  let server: ReturnType<ReturnType<typeof createApp>['app']['listen']> | undefined;
  try {
    await setGrants(f.db, reviewer.owner, memberGrants(f.model));
    const authorRoute = { type: 'Route', id: 'author-private-route' };
    const peerRoute = { type: 'Route', id: 'reviewer-private-route' };
    await new Objects(f.db, f.model, f.access).create(authorRoute, { id: authorRoute.id, name: 'Original' });
    await new Objects(f.db, f.model, await Access.load(f.db, reviewer)).create(peerRoute, { id: peerRoute.id, name: 'Other owner' });
    await f.db.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'synthetic-only';
      GRANT USAGE ON SCHEMA ${f.db.schema} TO "${role}";
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${f.db.schema} TO "${role}";
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${f.db.schema} TO "${role}"`);
    await installOwnerIsolation(f.db);
    const url = new URL(process.env.EIGOS_TEST_DATABASE_URL!);
    url.username = role;
    const db = limited = new Database(url.href, f.schema, f.db.runtimeId, url.href, true);
    await assertOwnerIsolation(db);
    const runAs = <T>(owner: string, action: () => Promise<T>) => db.withOwner(owner, action);
    assert.equal((await db.query(`SELECT id FROM ${db.schema}.objects`)).rowCount, 0);
    const readUnfiltered = (owner: string) => runAs(owner, async () =>
      (await db.readQuery(`SELECT id FROM ${db.schema}.objects WHERE type='Route'`)).rows.map(row => row.id));
    assert.deepEqual(await Promise.all([readUnfiltered(principal.owner), readUnfiltered(reviewer.owner)]), [[authorRoute.id], [peerRoute.id]]);
    await assert.rejects(runAs(reviewer.owner, () => db.query(
      `INSERT INTO ${db.schema}.objects(projection,owner,type,id,properties) VALUES($1,$2,'Route','unauthorized','{}')`,
      [f.model.projection, principal.owner],
    )), /row-level security/);
    assert.equal((await db.query(`SELECT id FROM ${db.schema}.objects`)).rowCount, 0);

    const config = readConfig({
      DATABASE_URL: url.href, EIGOS_PG_SCHEMA: f.schema, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'a'.repeat(32),
      PUBLIC_URL: 'http://127.0.0.1:3000',
    });
    const gateway = createApp(config, db, f.source, async token => {
      if (token === 'author') return { ...principal, clientId: 'author-client' };
      if (token === 'reviewer') return { ...reviewer, clientId: 'review-client' };
      throw new Error('Unknown fixture token');
    });
    server = gateway.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const author = new OntologyClient({ baseUrl, token: 'author' });
    const peer = new OntologyClient({ baseUrl, token: 'reviewer' });
    assert.deepEqual((await author.query({ type: 'Route', filter: { op: 'eq', property: 'name', value: 'Original' } })).items.map(item => item.ref), [authorRoute]);
    assert.deepEqual((await peer.query({ type: 'Route' })).items.map(item => item.ref), [peerRoute]);
    const scene = await author.createScenario({ requestId: 'private-reviewed-proposal', name: 'Route correction' });
    const peerScene = peer.scenario(scene.id);
    await assert.rejects(peerScene.inspectReview(), /unavailable/);
    const scenarios = new Scenarios(db);
    await runAs(principal.owner, async () => {
      const access = await Access.load(db, principal);
      const view = await scenarios.view(access, f.model, scene.id);
      await new Objects(db, view, access).edit(authorRoute, 1, { name: 'Reviewed correction' });
    });
    const invitation = await scene.inviteReviewers((await scene.inspect()).revision, [reviewer.owner]);
    const review = await peerScene.inspectReview();
    assert.equal(review.revision, invitation.revision);
    assert.deepEqual(review.objects, [{
      ref: authorRoute, before: { name: 'Original' }, after: { name: 'Reviewed correction' }, editedFields: ['name'], conflict: false,
    }]);
    await assert.rejects(peerScene.query({ type: 'Route' }), /unavailable/);
    const merge = () => runAs(principal.owner, async () => {
      const access = await Access.load(db, principal);
      return db.transaction(client => scenarios.mergeInto(new Objects(db, f.model, access, client), scene.id, review.revision, { objects: ['Route'], links: [] }));
    });
    await assert.rejects(merge(), /requires approval/);
    await assert.rejects(peerScene.approveReview(review.revision, '0'.repeat(64)), /review changed/);
    await peerScene.approveReview(review.revision, review.snapshot);
    await setGrants(f.db, reviewer.owner, memberGrants(f.model).filter(grant => grant.resource !== 'Eigos/object/Route'));
    await assert.rejects(merge(), /requires approval/);
    await setGrants(f.db, reviewer.owner, memberGrants(f.model));
    await merge();
    assert.equal((await author.query({ type: 'Route' })).items[0]?.properties.name, 'Reviewed correction');
    assert.equal((await peer.query({ type: 'Route' })).items[0]?.properties.name, 'Other owner');

    await f.db.query(`UPDATE ${f.db.schema}.scenarios SET expires_at=now()-interval '1 second' WHERE id=$1`, [scene.id]);
    assert.equal((await scenarios.cleanup()).deleted, 1);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await limited?.close();
    await f.db.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    await f.close();
  }
});
