import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { digest } from '../packages/core/identity.js';
import { businessGrants, setGrants } from '../packages/runtime/access.js';
import { portalEnv } from './account-env.js';
import { accountGateway, type AccountGateway } from './account-harness.js';
import { fixture } from './fixture.js';

test('a verified operator can use the scoped catalog and TableCheck tools without generic Ontology scopes', async () => {
  const f = await fixture(), folder = await mkdtemp(join(tmpdir(), 'eigos-tablecheck-mcp-'));
  const clients: Client[] = [];
  let gateway: AccountGateway | undefined;
  try {
    const operator = digest([portalEnv.OAUTH_ISSUER, 'personal', 'operator']);
    const keyFile = join(folder, 'availability.key'), binding = join(folder, 'binding.json');
    const key = 'synthetic-tablecheck-availability-key';
    const shopId = 'a'.repeat(24);
    const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const startsAt = date + 'T11:00:00.000Z';
    await writeFile(keyFile, key, { mode: 0o600 });
    await writeFile(binding, JSON.stringify({ owner: operator, active: true, expiresAt: new Date(Date.now() + 3600000).toISOString(),
      keyFile, keySha256: createHash('sha256').update(key).digest('hex') }), { mode: 0o600 });
    const calls: string[] = [];
    const shop = { id: shopId, name_translations: { en: 'Synthetic Shanghai Restaurant' }, time_zone: 'Asia/Shanghai', address: { city: 'Shanghai' } };
    const tableCheckFetch: typeof fetch = async (target, init) => {
      const url = new URL(String(target));
      assert.equal(url.origin, 'https://api.tablecheck.com');
      assert.equal(init?.method, 'GET');
      calls.push(url.pathname);
      if (url.pathname === '/api/availability/v1/shops') {
        assert.equal(url.searchParams.get('address_city'), 'Shanghai');
        return Response.json({ shops: [shop] });
      }
      if (url.pathname.endsWith('/shops/' + shopId)) return Response.json({ shop });
      assert.equal(url.pathname, '/api/availability/v1/timetable/' + shopId);
      assert.equal(url.searchParams.get('pax'), '2');
      assert.equal(url.searchParams.get('date_min'), date);
      return Response.json({ timetable: { id: shopId, availability: [startsAt], availability_cached_at: new Date().toISOString() } });
    };
    const g = gateway = await accountGateway(f, {
      env: { EIGOS_TABLECHECK_CONNECTION_FILE: binding, EIGOS_MCP_OPERATOR_CATALOG: 'existing-client:' + operator }, tableCheckFetch,
    });
    assert.equal(g.owner('operator'), operator);
    const authorizedClient = async (name: string, scope = 'tasks:read tasks:write') => {
      const token = await g.token(name, { azp: 'existing-client', aud: g.config.PUBLIC_URL, scope });
      const client = new Client({ name: 'test-codex', version: '1' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(g.url + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + token } },
      }));
      return client;
    };
    const grants = businessGrants(f.model);
    await setGrants(f.db, operator, grants);
    await setGrants(f.db, g.owner('other-operator'), grants);
    const client = await authorizedClient('operator'), other = await authorizedClient('other-operator');
    const noScope = await authorizedClient('operator', 'tasks:write');
    const describe = (target: Client, args = {}) => target.callTool({ name: 'describe_ontology', arguments: args });
    assert(!(await describe(client)).isError);
    assert((await describe(client, { ontology: 'Other' })).isError);
    assert((await describe(noScope)).isError);
    assert((await describe(other)).isError);
    const names = { names: ['RestaurantDiscovery'] };
    assert(!(await describe(client, names)).isError);
    assert((await describe(client, { ...names, ontology: 'Other' })).isError);
    assert((await describe(other, { query: 'TableCheck' })).isError);
    assert((await describe(noScope, names)).isError);
    const blocked = await client.callTool({ name: 'evaluate_ontology', arguments: {
      function: 'readRestaurantSearch', input: { search: { type: 'RestaurantSearchResult', id: 'unused' } },
    } });
    assert.equal(blocked.isError, true);
    assert.match(JSON.stringify(blocked), /ontology:read/);

    const search = await client.callTool({ name: 'search_restaurants', arguments: {
      requestId: 'tablecheck-search', provider: 'TableCheck', city: 'Shanghai', query: 'Synthetic Shanghai', limit: 1,
    } });
    assert(!search.isError, JSON.stringify(search));
    const jsonBody = (result: { content?: unknown }) => JSON.parse((result.content as { text: string }[])[0]!.text);
    const searchPage = jsonBody(search);
    assert.deepEqual(searchPage.outcomes, [{ provider: 'TableCheck', status: 'observed', count: 1 }]);
    const args = { requestId: 'tablecheck-availability', venueId: searchPage.venues[0].id, partySize: 2, date };
    const review = (target: Client, input = args) => target.callTool({ name: 'check_restaurant_availability', arguments: input });
    assert((await review(other)).isError);
    const availability = await review(client);
    assert(!availability.isError, JSON.stringify(availability));
    assert.deepEqual(jsonBody(availability).availableTimes, ['19:00']);
    assert.equal(jsonBody(availability).timeZone, 'Asia/Shanghai');
    assert.deepEqual(jsonBody(await review(client)), jsonBody(availability));
    assert.deepEqual(calls, ['/api/availability/v1/shops', '/api/availability/v1/shops/' + shopId, '/api/availability/v1/timetable/' + shopId]);
    assert.equal((await f.db.query(`SELECT 1 FROM ${f.schema}.external_operations`)).rowCount, 0);
    assert.equal((await f.db.query(`SELECT 1 FROM ${f.schema}.action_effects`)).rowCount, 0);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await gateway?.close();
    await f.close();
    await rm(folder, { recursive: true, force: true });
  }
});
