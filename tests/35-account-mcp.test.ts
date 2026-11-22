import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { digest } from '../packages/core/identity.js';
import { setGrants, syncAccountGrants } from '../packages/runtime/access.js';
import { Accounts } from '../packages/runtime/accounts.js';
import { accountGateway, type AccountGateway } from './account-harness.js';
import { fixture } from './fixture.js';

test('invited accounts use the shared Beta capabilities with separate consent, task isolation and revocation', async () => {
  const departureDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const flight = { origin: 'SHA', destination: 'PEK', departureDate, limit: 1 };
  const sourceReaders: string[] = [];
  let g: AccountGateway;
  const f = await fixture({ model: 'synthetic-flight-agent', async run(_prompt, tools) {
    await tools.get('complete_with_function')!.invoke({ function: 'readFliggyFlights', input: flight });
  } }, async (actor, provider) => {
    assert([g.owner('alice'), g.owner('bob')].includes(actor));
    assert.equal(provider, 'Fliggy');
    return { provider, bindingId: 'synthetic-fliggy', async assertCurrent() {}, async read(input) {
      assert.deepEqual(input, flight);
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
    assert.equal((await g.form('activate', bob.cookie, new URLSearchParams({ code: bobCode }))).headers.get('location'), '/account');
    assert.equal((await g.form('approve', bob.cookie)).status, 303);
    const issuedAt = Math.ceil(Date.now() / 1000), aliceToken = await g.token('alice', { issuedAt });
    const aliceMcp = await makeClient(aliceToken);
    const bobMcp = await makeClient(await g.token('bob', { issuedAt }));
    assert.deepEqual((await aliceMcp.listTools()).tools.map(tool => tool.name).sort(), ['get_task', 'submit_task']);
    assert.deepEqual((await (await g.call('/identity', aliceToken)).json()).scopes, ['tasks:read', 'tasks:write']);
    assert.equal((await g.call('/ontology', aliceToken)).status, 403);
    assert.equal((await g.call('/a2a', aliceToken)).status, 403);
    assert.equal((await g.call('/identity', await g.token('legacy', { azp: 'existing-client', aud: publicUrl }))).status, 403);
    await setGrants(f.db, g.owner('legacy'), [{ resource: 'Eigos', permission: 'view_definition' }]);
    assert.equal((await g.call('/identity', await g.token('legacy', { azp: 'existing-client', aud: publicUrl }))).status, 200);
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
    assert.equal((await renewed.listTools()).tools.length, 2);
    assert.equal((await bobMcp.listTools()).tools.length, 2);
  } finally {
    for (const client of clients) await client.close();
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
