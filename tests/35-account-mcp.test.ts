import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAmap, testConnection, type Recorded } from './amap-fixture.js';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { digest } from '../packages/core/identity.js';
import { businessGrants, setGrants, syncAccountGrants } from '../packages/runtime/access.js';
import { accountGroup, Accounts } from '../packages/runtime/accounts.js';
import { accountGateway, type AccountGateway } from './account-harness.js';
import { fixture, route } from './fixture.js';

const accountMcpTools = ['apply_ontology_action', 'complete_with_action', 'describe_ontology', 'execute_ontology', 'get_task', 'query_ontology', 'respond_to_task',
  'search_restaurants', 'select_task_places', 'submit_task', 'supply_task_input'];

test('invited accounts use OAuth and portable MCP/A2A access with shared Beta capabilities and owner isolation', async () => {
  const departureDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const flight = { origin: 'SHA', destination: 'PEK', departureDate, limit: 1 };
  const secondFlight = { ...flight, origin: 'PVG' };
  const sourceReaders: string[] = [];
  const compositionPrompts: string[] = [];
  let g: AccountGateway;
  const f = await fixture({ model: 'synthetic-flight-agent', async run(prompt, tools) {
    assert.deepEqual([...tools.keys()].sort(), ['apply_action', 'complete_with_action', 'complete_with_function', 'complete_with_functions', 'describe_ontology', 'evaluate_function']);
    await assert.rejects(tools.get('evaluate_function')!.invoke({ function: 'readDidiRideWatch', input: {} }), /Permission required: execute_function/);
    await assert.rejects(tools.get('apply_action')!.invoke({ action: 'EstimateRide', input: route }), /Permission required: apply_action/);
    if (prompt.includes('组合查航班')) {
      compositionPrompts.push(prompt);
      await tools.get('complete_with_functions')!.invoke({
        reads: [flight, secondFlight].map(input => ({ function: 'readFliggyFlights', input })),
      });
    } else await tools.get('complete_with_function')!.invoke({ function: 'readFliggyFlights', input: flight });
  } }, async (actor, provider) => {
    assert([g.owner('alice'), g.owner('bob')].includes(actor));
    assert.equal(provider, 'Fliggy');
    return { provider, bindingId: 'synthetic-fliggy', async assertCurrent() {}, async read(input) {
      assert.deepEqual(input, input.origin === secondFlight.origin ? secondFlight : flight);
      sourceReaders.push(actor);
      const items = [{
        nativeId: 'synthetic-flight', name: 'MU5101', url: 'https://example.test/synthetic-flight', priceDisplay: '500 CNY', adultFareDisplay: null,
        journeys: [{ kind: 'outbound', segments: [{ flightNumber: 'MU5101', departureAirport: 'SHA',
          departureLocal: departureDate + ' 08:00', arrivalAirport: 'PEK', arrivalLocal: departureDate + ' 10:00' }] }],
      }];
      return {
        provider: 'Fliggy', accessMode: 'trial', bindingId: 'synthetic-fliggy', evidence: 'synthetic', items, complete: false, cursor: null,
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 180000).toISOString(),
        inputDigest: digest(input), contentDigest: digest(items),
      };
    } };
  });
  g = await accountGateway(f, { signup: 'invite' });
  const publicUrl = g.config.PUBLIC_URL, audience = publicUrl + '/mcp', clients: Client[] = [];
  const makeClient = async (accessToken: string) => {
    const client = new Client({ name: 'test-grok', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(g.url + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + accessToken } },
    }));
    return client;
  };
  try {
    await syncAccountGrants(f.db, f.model);
    const anonymous = await g.call('/mcp');
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate')!, /oauth-protected-resource\/mcp/);
    assert.equal((await (await g.call('/.well-known/oauth-protected-resource/mcp')).json()).resource, audience);
    // A callback with the wrong state never reaches the code exchange: the harness checks that the code stays unused.
    assert.equal((await g.login('alice', 'alice@example.test', { wrongState: true })).location, '/account?status=login');
    const unverified = await g.login('alice', 'alice@example.test', { verified: false });
    assert.equal(unverified.location, '/account?status=verify');
    assert.equal(unverified.cookie, '__Host-eigos-account=');
    assert.equal(await g.accounts.account(g.owner('alice')), undefined);
    const unaffiliated = await g.token('alice', { issuedAt: Math.floor(Date.now() / 1000) - 1 });
    assert.equal((await g.call('/mcp', unaffiliated)).status, 403);

    const alice = await g.login('alice', 'alice@example.test');
    const bob = await g.login('bob', 'bob@example.test');
    assert.match(alice.cookie, /^__Host-eigos-account=.{43}$/);
    assert.equal((await fetch(g.url + '/mcp', { headers: { Cookie: alice.cookie } })).status, 401);
    const apply = (cookie: string, email: string) => g.form('apply', cookie, new URLSearchParams({ email, purpose: 'Read flight details' }));
    assert.equal((await apply(alice.cookie, 'alice@example.test')).status, 303);
    assert.equal((await apply(bob.cookie, 'bob@example.test')).status, 303);
    const aliceCode = await g.accounts.invite('Alice@example.test', 24);
    assert.equal((await g.form('activate', bob.cookie, new URLSearchParams({ code: aliceCode }))).headers.get('location'), '/account?status=invite');
    assert.equal((await g.form('activate', alice.cookie, new URLSearchParams({ code: aliceCode }), 'https://other.example')).status, 403);
    assert.equal((await g.form('activate', alice.cookie, new URLSearchParams({ code: aliceCode }))).headers.get('location'), '/account');
    assert.equal((await g.call('/mcp', unaffiliated)).status, 403);
    assert.equal((await g.form('approve', alice.cookie)).status, 303);
    assert.equal((await g.call('/mcp', unaffiliated)).status, 403);
    assert.equal((await g.call('/mcp', await g.token('alice', { aud: publicUrl }))).status, 403);
    assert.equal((await g.call('/mcp', await g.token('alice', { azp: 'arbitrary-client' }))).status, 403);
    assert.equal((await g.call('/mcp', await g.token('alice', { scope: 'tasks:read' }))).status, 403);

    const bobCode = await g.accounts.invite('bob@example.test', 24);
    assert.equal((await g.form('agent-token', bob.cookie)).status, 403);
    assert.equal((await g.form('activate', bob.cookie, new URLSearchParams({ code: bobCode }))).headers.get('location'), '/account');
    assert.equal((await g.form('agent-token', bob.cookie, new URLSearchParams(), 'https://other.example')).status, 403);
    const issue = async (cookie = bob.cookie) => {
      const response = await g.form('agent-token', cookie);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const html = await response.text();
      assert.match(html, /<code>https:\/\/127\.0\.0\.1\/a2a<\/code>/);
      const match = html.match(/Bearer (eigos_agent_[A-Za-z0-9_-]{43})/);
      assert(match?.[1], 'a Beta account receives its credential once');
      assert(!(await g.page(cookie)).includes(match[1]));
      return match[1];
    };
    const bobToken = await issue();
    const a2a = async (method: string, params: unknown, token = bobToken) => {
      const response = await fetch(g.url + '/a2a', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return { status: response.status, body: await response.json() };
    };
    const issuedAt = Math.ceil(Date.now() / 1000), aliceToken = await g.token('alice', { issuedAt });
    const aliceMcp = await makeClient(aliceToken);
    const bobMcp = await makeClient(bobToken);
    // The rollout must also work against the broad grants left behind by an older release.
    await setGrants(f.db, 'group:' + accountGroup, businessGrants(f.model));
    assert.equal((await g.call('/ontology', bobToken)).status, 403);
    assert.equal((await g.call('/tasks', bobToken)).status, 403);
    assert.equal((await a2a('GetTask', { id: 'unused' }, 'eigos_agent_' + 'x'.repeat(43))).status, 401);
    assert.deepEqual((await aliceMcp.listTools()).tools.map(tool => tool.name).sort(), accountMcpTools);
    assert.deepEqual((await (await g.call('/identity', aliceToken)).json()).scopes, ['tasks:read', 'tasks:write']);
    assert.equal((await g.call('/ontology', aliceToken)).status, 403);
    assert.equal((await g.call('/a2a', aliceToken)).status, 403);
    assert.equal((await g.call('/identity', await g.token('legacy', { azp: 'existing-client', aud: publicUrl }))).status, 403);
    await setGrants(f.db, g.owner('legacy'), [{ resource: 'Eigos', permission: 'view_definition' }]);
    assert.equal((await g.call('/identity', await g.token('legacy', { azp: 'existing-client', aud: publicUrl }))).status, 200);
    const renewedLegacy = await g.token('legacy', { azp: 'existing-client',
      scope: 'tasks:read tasks:write ontology:read ontology:write' });
    assert.deepEqual((await (await g.call('/identity', renewedLegacy)).json()).scopes, ['tasks:read', 'tasks:write']);
    assert.equal((await g.call('/ontology', renewedLegacy)).status, 403);
    assert.equal((await g.call('/a2a', renewedLegacy)).status, 403);
    const limitedLegacy = await g.token('legacy', { azp: 'existing-client', scope: 'tasks:read' });
    assert.equal((await (await g.call('/identity', limitedLegacy)).json()).reason, 'insufficient_scope');
    const readResult = (result: { content?: unknown }) => JSON.parse((result.content as { text: string }[])[0]!.text);
    const args = { requestId: 'grok-original-request', message: '只查询明天上海到北京的航班' };
    const submission = await aliceMcp.callTool({ name: 'submit_task', arguments: args });
    assert(!submission.isError, JSON.stringify(submission));
    const id = readResult(submission).id;
    assert.equal(readResult(await aliceMcp.callTool({ name: 'submit_task', arguments: args })).id, id);
    assert.equal((await bobMcp.callTool({ name: 'get_task', arguments: { taskId: id } })).isError, true);
    await f.worker.runOne();
    const result = readResult(await aliceMcp.callTool({ name: 'get_task', arguments: { taskId: id } }));
    assert.equal(result.id, id);
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.equal(result.result.evidence, 'synthetic');
    assert.equal(result.result.items[0].name, 'MU5101');
    assert.deepEqual(sourceReaders, [g.owner('alice')]);
    const bobSubmission = await bobMcp.callTool({ name: 'submit_task', arguments: args });
    assert(!bobSubmission.isError, JSON.stringify(bobSubmission));
    const bobTaskId = readResult(bobSubmission).id;
    await f.worker.runOne();
    const bobResult = readResult(await bobMcp.callTool({ name: 'get_task', arguments: { taskId: bobTaskId } }));
    assert.equal(bobResult.state, 'completed', JSON.stringify(bobResult));
    assert.equal(bobResult.result.items[0].name, 'MU5101');
    assert.deepEqual(sourceReaders, [g.owner('alice'), g.owner('bob')]);
    assert.equal((await aliceMcp.callTool({ name: 'get_task', arguments: { taskId: bobTaskId } })).isError, true);
    const readThroughA2A = await a2a('GetTask', { id: bobTaskId });
    assert.equal(readThroughA2A.body.result.id, bobTaskId);
    assert((await a2a('GetTask', { id })).body.error, 'A2A cannot read another owner’s task');
    const send = { message: { messageId: 'portable-a2a', role: 'ROLE_USER', parts: [{ text: args.message }] } };
    const a2aSubmission = await a2a('SendMessage', send);
    assert.equal(a2aSubmission.status, 200, JSON.stringify(a2aSubmission.body));
    const a2aId = a2aSubmission.body.result.task.id;
    assert.equal((await a2a('SendMessage', send)).body.result.task.id, a2aId);
    assert((await a2a('SendMessage', { message: { ...send.message, taskId: a2aId } })).body.error);
    const retryAfter = Date.now() + 3000;
    while (!await f.worker.runOne()) {
      assert(Date.now() < retryAfter, 'A2A task did not become eligible for its Worker');
      await delay(25);
    }
    const a2aResult = readResult(await bobMcp.callTool({ name: 'get_task', arguments: { taskId: a2aId } }));
    assert.equal(a2aResult.state, 'completed');
    assert.equal(a2aResult.result.items[0].name, 'MU5101');
    assert.deepEqual(sourceReaders, [g.owner('alice'), g.owner('bob'), g.owner('bob')]);
    const alicePortable = await issue(alice.cookie);
    const markers = ['fixture-alpha', 'fixture-bravo'] as const;
    const ids = await Promise.all(markers.map(async (marker, index) => {
      const response = await a2a('SendMessage', { message: {
        contextId: 'same-context-on-two-agents', messageId: 'same-delivery-id', role: 'ROLE_USER',
        parts: [{ text: '组合查航班 ' + marker }],
      } }, index === 0 ? alicePortable : bobToken);
      assert.equal(response.status, 200);
      return response.body.result.task.id;
    }));
    assert.notEqual(ids[0], ids[1]);
    const compositionDeadline = Date.now() + 5000;
    for (const _ of ids) {
      while (!await f.worker.runOne()) {
        assert(Date.now() < compositionDeadline, 'The A2A composition did not reach the worker');
        await delay(25);
      }
    }
    const composites = await Promise.all(ids.map((taskId, index) =>
      a2a('GetTask', { id: taskId }, index === 0 ? alicePortable : bobToken)));
    for (const { body } of composites) {
      assert.equal(body.result.status.state, 'TASK_STATE_COMPLETED');
      assert.equal(body.result.artifacts[0].parts[0].data.results.length, 2);
    }
    assert.equal(compositionPrompts.length, 2);
    assert(compositionPrompts.every(prompt => markers.filter(marker => prompt.includes(marker)).length === 1));
    assert((await a2a('GetTask', { id: ids[0] })).body.error);
    assert.equal(f.provider.flags.orderCreates, 0);
    assert.equal((await g.form('revoke', alice.cookie)).status, 303);
    for (const [name, args] of [['get_task', { taskId: id }], ['submit_task', { requestId: 'after-revoke', message: '只查航班' }]] as const) {
      const denied = await fetch(g.url + '/mcp', { method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + aliceToken,
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      assert.equal(denied.status, 403);
    }
    assert.equal((await g.call('/mcp', await g.token('alice', { issuedAt: issuedAt + 1 }))).status, 403);
    // An approval is stamped by the database clock and compared in whole seconds: approve again only once that clock is past the second aliceToken was issued in.
    const databaseSecond = async () => Number((await f.db.query<{ second: string }>("SELECT floor(extract(epoch FROM clock_timestamp()))::text AS second")).rows[0]!.second);
    for (let attempt = 0; await databaseSecond() <= issuedAt; attempt++) {
      assert(attempt < 200, 'the database clock did not pass the second the token was issued in');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await g.form('approve', alice.cookie);
    // Approving again starts a new grant: the token issued before it stays rejected (403), a token issued after it works (200).
    assert.equal((await g.call('/mcp', aliceToken)).status, 403);
    const renewedToken = await g.token('alice', { issuedAt: Math.ceil(Date.now() / 1000) });
    assert.equal((await g.call('/identity', renewedToken)).status, 200);
    const renewed = await makeClient(renewedToken);
    for (const client of [renewed, bobMcp])
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), accountMcpTools);
    const replacement = await issue();
    assert.equal((await a2a('GetTask', { id: a2aId })).status, 401);
    assert.equal((await a2a('GetTask', { id: a2aId }, replacement)).body.result.id, a2aId);
    await g.accounts.suspend(g.owner('bob'), 'synthetic');
    assert.equal((await a2a('GetTask', { id: a2aId }, replacement)).status, 401);
    assert.equal((await g.form('agent-token', bob.cookie)).status, 403);
    await g.accounts.restore(g.owner('bob'));
    assert.equal((await g.form('revoke', bob.cookie)).status, 303);
    assert.equal((await g.call('/mcp', replacement)).status, 401);
    assert.equal((await a2a('GetTask', { id: a2aId }, replacement)).status, 401);
  } finally {
    for (const client of clients) await client.close();
    await g.close();
    await f.close();
  }
});

test('an authorized task-scoped operator can complete a ride quote without submitting a task', async () => {
  const f = await fixture();
  let g: AccountGateway;
  g = await accountGateway({ ...f, source: async owner => {
    assert.equal(owner, g.owner('rider'));
    return f.provider.source;
  } }, { signup: 'invite' });
  const mcp = new Client({ name: 'test-grok-quote', version: '1' });
  try {
    const owner = g.owner('rider'), grants = businessGrants(f.model);
    await setGrants(f.db, owner, grants);
    const token = await g.token('rider', { azp: 'existing-client', aud: g.config.PUBLIC_URL, scope: 'tasks:read tasks:write' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(g.url + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }));
    const args = {
      requestId: 'grok-ride-quote',
      action: { interface: { type: 'RideInquiry', action: 'estimate', implementation: 'RideRequest' }, input: route },
      read: { function: 'readRideEstimates', resultParameter: 'request' },
    };
    const quote = (input: Record<string, unknown> = args) => mcp.callTool({ name: 'complete_with_action', arguments: input });
    for (const changed of [
      { ...args, action: { ...args.action, interface: { ...args.action.interface, action: 'book' } } },
      { ...args, read: { ...args.read, function: 'readInteractiveRideEstimate' } },
      { ...args, ontology: 'Other' },
      { ...args, action: { ...args.action, scenarioId: '00000000-0000-4000-8000-000000000000' } },
    ]) assert.equal((await quote(changed)).isError, true);
    assert.deepEqual(f.provider.calls, []);

    const readQuote = async () => {
      const result = await quote();
      assert(!result.isError, JSON.stringify(result));
      return JSON.parse((result.content as { text: string }[])[0]!.text);
    };
    const first = await readQuote();
    assert.equal(first.request.type, 'RideRequest');
    assert.equal(first.estimates.length, 2);
    assert.deepEqual(first.evidence, ['fixture']);
    assert.deepEqual((await readQuote()).request, first.request);
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    assert.equal(f.provider.flags.orderCreates, 0);
    assert.equal((await f.db.query(`SELECT 1 FROM ${f.schema}.tasks WHERE owner=$1`, [g.owner('rider')])).rowCount, 0);

    f.provider.flags.ambiguous = true;
    const ambiguous = await quote({ ...args, requestId: 'grok-ambiguous-ride' });
    assert.partialDeepStrictEqual(ambiguous.structuredContent, { status: 409 });
    assert.equal(f.provider.calls.filter(name => name === 'taxi_estimate').length, 1);

    await setGrants(f.db, owner, grants.filter(grant => grant.resource !== 'Eigos/action/EstimateRide'));
    const denied = await quote({ ...args, requestId: 'grok-quote-without-grant' });
    assert.partialDeepStrictEqual(denied.structuredContent, { status: 403 });

    assert.equal(f.provider.flags.orderCreates, 0);
  } finally {
    await mcp.close();
    await g.close();
    await f.close();
  }
});

test('a task submitted while its account is being suspended is refused with the reason', async t => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' }), client = new Client({ name: 'test-grok', version: '1' });
  try {
    const { cookie } = await g.login('ivy', 'ivy@example.test');
    assert.equal((await g.form('approve', cookie)).status, 303);
    const active = Accounts.prototype.active;
    let checks = 0;
    // The token passes the Gateway's own check. The suspension lands before the submission checks the account again inside its transaction.
    t.mock.method(Accounts.prototype, 'active', async function (this: Accounts, ...args: Parameters<Accounts['active']>) {
      checks++;
      await this.suspend(g.owner('ivy'), 'synthetic');
      return active.apply(this, args);
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(g.url + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + await g.token('ivy', { issuedAt: Math.ceil(Date.now() / 1000) }) } },
    }));
    const refused = await client.callTool({ name: 'submit_task', arguments: { requestId: 'suspended-meanwhile', message: '只查询明天上海到北京的航班' } });
    assert.equal(checks, 1);
    assert.equal(refused.isError, true);
    assert.deepEqual(refused.structuredContent, { status: 403, error: 'This EIGOS account is suspended or its client authorization was revoked' });
    assert.equal((await g.accounts.account(g.owner('ivy')))?.status, 'suspended');
  } finally { await client.close(); await g.close(); await f.close(); }
});


test('member restaurant search uses the original account source and exposes no generic Ontology permissions', async () => {
  const f = await fixture();
  const folder = await mkdtemp(join(tmpdir(), 'eigos-member-restaurant-'));
  const clients: Client[] = [];
  let gateway: AccountGateway | undefined;
  try {
    const connection = await testConnection(folder);
    const betaConnection = join(folder, 'beta.json');
    const { owner: _owner, ...shared } = JSON.parse(await readFile(connection, 'utf8'));
    await writeFile(betaConnection, JSON.stringify({ ...shared, active: false }), { mode: 0o600 });
    const providerCalls: Recorded[] = [];
    const supply = fakeAmap(providerCalls);
    let revokeDuringSearch = false;
    const amapFetch: typeof fetch = async (target, init) => {
      const result = await supply(target, init);
      if (revokeDuringSearch && init?.body && JSON.parse(String(init.body)).method === 'tools/call')
        await g.accounts.revoke(g.owner('alice'));
      return result;
    };
    const g = gateway = await accountGateway(f, {
      signup: 'invite', env: { EIGOS_AMAP_CONNECTION_FILE: connection, EIGOS_BETA_AMAP_CONNECTION_FILE: betaConnection }, amapFetch,
    });
    const binding = JSON.parse(await readFile(connection, 'utf8'));
    await writeFile(connection, JSON.stringify({ ...binding, owner: g.owner('alice') }), { mode: 0o600 });
    await syncAccountGrants(f.db, f.model);
    const approved = async (sub: string) => {
      const email = sub + '@example.test', session = await g.login(sub, email);
      assert.equal((await g.form('apply', session.cookie, new URLSearchParams({ email, purpose: 'Search restaurant listings' }))).status, 303);
      const code = await g.accounts.invite(email, 24);
      assert.equal((await g.form('activate', session.cookie, new URLSearchParams({ code }))).headers.get('location'), '/account');
      assert.equal((await g.form('approve', session.cookie)).status, 303);
      const token = await g.token(sub, { issuedAt: Math.ceil(Date.now() / 1000) });
      const client = new Client({ name: 'codex-fixture', version: '1' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(g.url + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + token } },
      }));
      return { client, token };
    };
    const alice = await approved('alice'), bob = await approved('bob');
    const input = { requestId: 'amap-member-search', query: '咖啡店', city: '上海市', limit: 1 };
    const search = (client: Client, args: Record<string, unknown> = input) =>
      client.callTool({ name: 'search_restaurants', arguments: args });
    const body = (res: { content?: unknown }) => JSON.parse((res.content as { text: string }[])[0]!.text);
    const first = await search(alice.client);
    assert(!first.isError, JSON.stringify(first));
    const result = body(first);
    assert.deepEqual(result.outcomes, [{ provider: 'Amap', status: 'observed', count: 1 }]);
    assert.equal(result.venues[0].name, '咖啡店');
    assert.equal(result.venues[0].evidence, 'provider_mock');
    const code = `async ({ query }) => {
      const [searches, venues] = await Promise.all([query({ type: "RestaurantSearchResult" }), query({ type: "RestaurantSourceVenue" })]);
      return { searches: searches.items.length, venues: venues.items.length };
    }`;
    assert.deepEqual(body(await alice.client.callTool({ name: 'execute_ontology', arguments: { code } })), { searches: 1, venues: 1 });
    assert.deepEqual(body(await bob.client.callTool({ name: 'execute_ontology', arguments: { code } })), { searches: 0, venues: 0 });
    assert.deepEqual(body(await alice.client.callTool({ name: 'query_ontology', arguments: { query: { type: 'DidiRideOrder' } } })).items, []);
    assert.deepEqual(body(await search(alice.client)), result);
    assert.equal((await search(alice.client, { ...input, query: '烧烤' })).isError, true);
    assert.equal((await search(alice.client, { ...input, providers: ['TableCheck'] })).isError, true);
    assert.equal((await search(alice.client, { ...input, provider: 'TableCheck' })).isError, true);
    assert.equal((await search(alice.client, { ...input, action: 'ConfirmTableCheckReservation' })).isError, true);
    const otherOwner = await search(bob.client);
    assert(!otherOwner.isError, JSON.stringify(otherOwner));
    assert.deepEqual(body(otherOwner).outcomes, [{ provider: 'Amap', status: 'authorization_required', count: 0 }]);
    assert.deepEqual(body(otherOwner).venues, []);
    assert.deepEqual(providerCalls.map(entry => entry.name), ['maps_text_search']);
    assert.deepEqual((await (await g.call('/identity', alice.token)).json()).scopes, ['tasks:read', 'tasks:write']);
    assert.equal((await g.call('/ontology', alice.token)).status, 403);
    const catalogue = body(await alice.client.callTool({ name: 'describe_ontology', arguments: {} }));
    assert(catalogue.actionTypes.some((action: { apiName: string }) => action.apiName === 'EstimateRide'));
    await assert.rejects(alice.client.callTool({ name: 'check_restaurant_availability', arguments: {} }), /Tool .* not found/);
    const rows = await f.db.query(`SELECT action FROM ${f.schema}.action_changes WHERE request_id=$1`, [input.requestId]);
    assert.deepEqual(rows.rows.map(row => row.action), ['FindRestaurants', 'FindRestaurants']);
    assert.equal((await f.db.query(`SELECT 1 FROM ${f.schema}.external_operations`)).rowCount, 0);
    await writeFile(betaConnection, JSON.stringify(shared), { mode: 0o600 });
    const beta = await search(bob.client, { ...input, requestId: 'beta-amap-default-search' });
    assert(!beta.isError, JSON.stringify(beta));
    assert.deepEqual(body(beta).outcomes, [{ provider: 'Amap', status: 'observed', count: 1 }]);
    assert.deepEqual(providerCalls.map(entry => entry.name), ['maps_text_search', 'maps_text_search']);
    assert.equal((await f.db.query(`SELECT 1 FROM ${f.schema}.external_operations`)).rowCount, 0);
    revokeDuringSearch = true;
    const revokedRequest = 'amap-revoked-during-search';
    assert.equal((await search(alice.client, { ...input, requestId: revokedRequest })).isError, true);
    assert.equal((await f.db.query(`SELECT 1 FROM ${f.schema}.action_changes WHERE request_id=$1`, [revokedRequest])).rowCount, 0);
    assert.equal((await g.call('/mcp', alice.token)).status, 403);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await gateway?.close();
    await f.close();
    await rm(folder, { recursive: true, force: true });
  }
});
