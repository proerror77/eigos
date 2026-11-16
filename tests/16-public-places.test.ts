import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../apps/gateway/app.js';
import { provisionPublicPlaceCatalogue } from '../packages/capabilities/public-places/catalogue.js';
import { readConfig } from '../packages/core/config.js';
import { publicPlacesOntology } from '../packages/ontology/public-places.js';
import { Access, memberGrants, setGrants, type Grant } from '../packages/runtime/access.js';
import { Database } from '../packages/runtime/database.js';
import { Governance } from '../packages/runtime/governance.js';
import { Objects } from '../packages/runtime/objects.js';
import { assertOwnerIsolation, installOwnerIsolation } from '../packages/runtime/owner-isolation.js';
import { fixture, principal } from './fixture.js';

test('only explicitly published places are shared within a project and access follows current membership', async () => {
  const f = await fixture();
  const role = 'eigos_places_' + f.schema.slice(-32);
  let roleCreated = false;
  let limited: Database | undefined;
  let server: ReturnType<ReturnType<typeof createApp>['app']['listen']> | undefined;
  try {
    await setGrants(f.db, 'deployment', [
      { resource: 'Eigos', permission: 'manage_definition' },
      { resource: publicPlacesOntology, permission: 'manage_definition' },
    ]);
    const deployer = await Access.load(f.db, { owner: 'deployment', scopes: [] });
    const governance = new Governance(f.db, f.metadata, f.capabilities);
    for (const id of ['Alpha', 'Beta'])
      await governance.project(deployer, { ontology: 'Eigos', id, name: id });
    const alpha = await provisionPublicPlaceCatalogue(f.db, f.metadata, f.capabilities, deployer, 'Alpha');
    const beta = await provisionPublicPlaceCatalogue(f.db, f.metadata, f.capabilities, deployer, 'Beta');
    assert.equal(alpha.release, beta.release);

    const permission = (project: string, publish = false): Grant[] => [
      { resource: 'Eigos/project/' + project, permission: 'view_definition' },
      { resource: 'Eigos/project/' + project, permission: 'view_objects' },
      ...(publish ? [{ resource: 'Eigos/project/' + project, permission: 'apply_action' as const }] : []),
    ];
    await setGrants(f.db, 'group:alpha-members', permission('Alpha'));
    await setGrants(f.db, 'group:alpha-publishers', permission('Alpha', true));
    await setGrants(f.db, 'group:beta-publishers', permission('Beta', true));
    await f.db.query(`INSERT INTO ${f.db.schema}.security_memberships(subject,kind,name) VALUES
      ('reader','group','alpha-members'),($1,'group','alpha-publishers'),('beta','group','beta-publishers')`, [principal.owner]);
    await setGrants(f.db, 'reader', memberGrants(f.model));
    const graph = new Objects(f.db, f.model, f.access);
    const privatePlace = { type: 'Place', id: 'private-place' };
    await graph.create(privatePlace, {
      id: privatePlace.id, name: 'Personal travel location', city: 'Shanghai', address: 'Private address',
      coordinates: { lat: 31.2, lng: 121.5 }, coordinateSystem: 'WGS84',
      sourceBinding: 'owner-only-source', observedAt: new Date().toISOString(),
    });

    await f.db.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'synthetic-only';
      GRANT USAGE ON SCHEMA ${f.db.schema} TO "${role}";
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${f.db.schema} TO "${role}";
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${f.db.schema} TO "${role}"`);
    roleCreated = true;
    await installOwnerIsolation(f.db);
    const dbUrl = new URL(process.env.EIGOS_TEST_DATABASE_URL!);
    dbUrl.username = role;
    const db = limited = new Database(dbUrl.href, f.schema, f.db.runtimeId, dbUrl.href, true);
    await assertOwnerIsolation(db);

    const config = readConfig({
      DATABASE_URL: dbUrl.href, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'synthetic-token-'.repeat(3),
      PUBLIC_URL: 'http://127.0.0.1:3000',
    });
    server = createApp(config, db, f.source, async token => {
      if (token === 'alpha') return principal;
      if (token === 'beta' || token === 'reader' || token === 'outsider') return { ...principal, owner: token };
      throw new Error('Unexpected test credential');
    }).app.listen(0, '127.0.0.1');
    const listening = server;
    await new Promise<void>(resolve => listening.once('listening', resolve));
    const base = 'http://127.0.0.1:' + (listening.address() as AddressInfo).port;
    const post = async (token: string, path: string, body: unknown, status = 200) => {
      const response = await fetch(base + '/ontology/' + path, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    };
    const list = 'services/list_public_places', publish = 'services/publish_public_place';
    const withdraw = 'services/withdraw_public_place';
    const place = { project: 'Alpha', requestId: 'publish-1', id: 'central-library', name: 'Alpha library',
      city: 'Shanghai', address: 'Public plaza', latitude: 31.2, longitude: 121.5, coordinateSystem: 'WGS84', confirmedPublic: true };
    assert.deepEqual((await post('reader', list, { project: 'Alpha' })).items, []);
    await post('reader', publish, place, 403);
    await post('alpha', publish, { ...place, confirmedPublic: false }, 400);
    await post('alpha', publish, { ...place, coordinateSystem: 'GCJ02' }, 400);
    await post('alpha', publish, { ...place, sourceBinding: 'owner-only-source' }, 400);
    await post('alpha', publish, place);
    await post('alpha', publish, place);
    await post('beta', publish, { ...place, project: 'Beta', name: 'Beta library' });
    const shared = await post('reader', list, { project: 'Alpha', city: 'Shanghai' });
    assert.deepEqual(shared.items, [{
      ref: { type: 'PublicPlace', id: place.id }, revision: 1,
      properties: { id: place.id, name: place.name, city: place.city, address: place.address,
        latitude: place.latitude, longitude: place.longitude, coordinateSystem: 'WGS84', published: true },
    }]);
    assert.deepEqual((await post('alpha', list, { project: 'Alpha', id: privatePlace.id })).items, []);
    assert.equal((await post('beta', list, { project: 'Beta' })).items[0].properties.name, 'Beta library');
    await post('beta', list, { project: 'Alpha' }, 403);
    await post('outsider', list, { project: 'Alpha' }, 403);
    assert.deepEqual((await post('reader', 'query', { query: { type: 'Place' } })).items, []);
    assert.equal((await post('alpha', 'query', { query: { type: 'Place' } })).items[0].ref.id, privatePlace.id);
    const ownerView = await db.withOwner(principal.owner, () => db.query(`SELECT id FROM ${db.schema}.objects WHERE type='PublicPlace'`));
    assert.equal(ownerView.rowCount, 0);

    await post('alpha', withdraw, { project: 'Alpha', id: place.id, revision: 2, requestId: 'stale' }, 409);
    await post('alpha', withdraw, { project: 'Alpha', id: place.id, revision: 1, requestId: 'withdraw' });
    assert.deepEqual((await post('reader', list, { project: 'Alpha' })).items, []);
    await post('reader', list, { project: 'Alpha', includeWithdrawn: true }, 403);
    const audited = (await post('alpha', list, { project: 'Alpha', includeWithdrawn: true })).items[0];
    assert.equal(audited.revision, 2);
    assert.equal(audited.properties.published, false);
    await post('alpha', publish, { ...place, requestId: 'republish', revision: 2 });
    assert.equal((await post('reader', list, { project: 'Alpha' })).items[0].revision, 3);
    await f.db.query(`DELETE FROM ${f.db.schema}.security_memberships WHERE subject='reader' AND kind='group'`);
    await post('reader', list, { project: 'Alpha' }, 403);

    const journal = await f.db.query(`SELECT executor_kind,executor_id FROM ${f.db.schema}.actions WHERE owner=$1`,
      ['public-places:Alpha']);
    assert.deepEqual(journal.rows, Array.from({ length: 3 }, () => ({
      executor_kind: 'client', executor_id: principal.owner,
    })));
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await limited?.close();
    if (roleCreated) await f.db.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    await f.close();
  }
});
