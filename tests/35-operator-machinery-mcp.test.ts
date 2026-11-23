import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readConfig } from '../packages/core/config.js';
import { digest } from '../packages/core/identity.js';
import { journeySettings } from '../packages/ontology/calendar-journey.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { portalEnv } from './account-env.js';
import { accountGateway } from './account-harness.js';
import { fixture } from './fixture.js';

const operator = digest([portalEnv.OAUTH_ISSUER, 'personal', 'machinery-operator']);
const processType = 'CalendarJourneyStateLog';

test('a configured operator MCP connection can read its permitted Machinery history', async () => {
  const f = await fixture();
  const clients: Client[] = [];
  let gateway: Awaited<ReturnType<typeof accountGateway>> | undefined;
  try {
    const g = gateway = await accountGateway(f, { signup: 'open', env: {
      OAUTH_EXISTING_CLIENT_IDS: 'existing-client,other-existing-client',
      EIGOS_MCP_OPERATOR_MACHINERY: 'existing-client:' + operator,
    } });
    const connect = async (token: string) => {
      const client = new Client({ name: 'test-codex', version: '1' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(g.url + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + token } },
      }));
      return client;
    };
    const tokenFor = (name: string, azp = 'existing-client', scope = 'tasks:read tasks:write') =>
      g.token(name, { azp, aud: g.config.PUBLIC_URL, scope });
    const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args });
    const read = async (client: Client, name: string, args?: Record<string, unknown>) => {
      const result = await call(client, name, args);
      assert(!result.isError, JSON.stringify(result));
      return JSON.parse((result.content[0] as { text: string }).text);
    };
    const denied = async (client: Client, name: string, args: Record<string, unknown> = {}, scope = 'ontology:read') => {
      const result = await call(client, name, args);
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, { status: 403, error: 'Permission required: ' + scope });
    };
    const grants = businessGrants(f.model);
    const otherOwner = g.owner('other-operator');
    await setGrants(f.db, operator, grants);
    await setGrants(f.db, otherOwner, grants);
    const token = await tokenFor('machinery-operator');
    const fullScope = 'ontology:read ontology:write tasks:read tasks:write';
    const client = await connect(token);
    const author = await connect(await tokenFor('machinery-operator', 'existing-client', fullScope));
    const from = new Date(Date.now() - 3600000).toISOString();
    const settings = journeySettings.parse({ origin: { calendarId: 'synthetic', eventId: 'first' },
      destination: { calendarId: 'synthetic', eventId: 'second' },
      monitorUntil: new Date(Date.now() + 3600000).toISOString(), mode: 'driving' });
    const seedJourney = async (owner: string, id: string) => {
      const graph = new Objects(f.db, f.model, await Access.load(f.db, { owner, scopes: [] }));
      const ref = { type: 'CalendarJourney', id };
      await graph.create(ref, { id, name: 'Synthetic calendar journey', settings,
        scheduleId: id, mapAuthority: digest(id), state: 'pending', reason: 'pending',
        checkedAt: null, validUntil: null, nextCheckAt: null, calendar: null, route: null,
        weather: null, timing: null, reminder: null, reminderVersion: 0 });
      await graph.edit(ref, 1, { state: 'canceled', reason: 'monitor_canceled' });
      return ref;
    };
    const journey = await seedJourney(operator, 'operator-journey');
    const otherJourney = await seedJourney(otherOwner, 'other-journey');
    const analysis = { type: processType, from, to: new Date().toISOString() };
    const list = 'ontology_machinery_processes', analyze = 'ontology_machinery_analysis';

    const processes = await read(client, list);
    assert(processes.items.some((item: { type: string }) => item.type === processType));
    assert.deepEqual(await read(client, list, { _ontology: 'Eigos' }), await read(author, list));
    const result = await read(client, analyze, analysis);
    assert.deepEqual(result.cases.map((item: { object: ObjectRef }) => item.object), [journey]);
    const detail = await read(client, analyze, { ...analysis, object: journey, _ontology: 'Eigos' });
    assert.deepEqual(detail.cases[0].timeline.map((event: { to: string }) => event.to), ['pending', 'canceled']);
    assert((await call(client, analyze, { ...analysis, object: otherJourney })).isError);

    const other = await connect(await tokenFor('other-operator'));
    const otherClient = await connect(await tokenFor('machinery-operator', 'other-existing-client'));
    const noRead = await connect(await tokenFor('machinery-operator', 'existing-client', 'tasks:write'));
    for (const rejected of [other, otherClient, noRead]) {
      await denied(rejected, list);
      await denied(rejected, analyze, analysis);
    }
    await denied(client, list, { _ontology: 'Other' });
    await denied(client, analyze, { ...analysis, _ontology: 'Other' });
    await denied(client, 'ontology_workbench_access');
    await denied(client, 'ontology_execution_trace', { requestId: 'machinery-fixture' });
    await denied(client, 'ontology_save_machinery_cases', { analysis, name: 'Cases', requestId: 'blocked-save' }, 'ontology:write');
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    assert.deepEqual((await (await g.call('/identity', token)).json()).scopes, ['tasks:read', 'tasks:write']);
    const http = await fetch(g.url + '/ontology/services/machinery_analysis', {
      method: 'POST', headers, body: JSON.stringify(analysis),
    });
    assert.equal(http.status, 403);
    assert.equal((await http.json()).error, 'Permission required: ontology:read');

    await g.accounts.provision(g.owner('member'));
    assert(await g.accounts.approve(g.owner('member')));
    const member = await connect(await g.token('member', { scope: fullScope }));
    assert(!(await member.listTools()).tools.some(tool => tool.name === list || tool.name === analyze));
    await assert.rejects(call(member, list), /Tool ontology_machinery_processes not found/);
    await assert.rejects(call(member, analyze, analysis), /Tool ontology_machinery_analysis not found/);

    await setGrants(f.db, operator, grants.filter(grant => grant.resource !== 'Eigos/object/' + processType));
    assert(!(await read(client, list)).items.some((item: { type: string }) => item.type === processType));
    const revoked = await call(client, analyze, { ...analysis, object: journey });
    assert.deepEqual(revoked.structuredContent, { status: 403, error: 'Permission required: view_objects' });
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await gateway?.close();
    await f.close();
  }
});

test('operator Machinery settings require a configured existing OAuth client', () => {
  for (const client of ['grok', 'unknown']) {
    assert.throws(() => readConfig({ ...portalEnv, EIGOS_MCP_OPERATOR_MACHINERY: client + ':' + operator }),
      /MCP Machinery exception requires an existing operator OAuth client/);
  }
});
