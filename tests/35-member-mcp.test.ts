import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../apps/gateway/app.js';
import { jwtVerifier } from '../apps/gateway/auth.js';
import { auth0MemberLogin } from '../apps/gateway/member-login.js';
import { readConfig } from '../packages/core/config.js';
import { digest } from '../packages/core/identity.js';
import { setGrants } from '../packages/runtime/access.js';
import { Members, memberQueryGroup } from '../packages/runtime/members.js';
import { fixture } from './fixture.js';

test('verified invitation, separate Grok consent, owner isolation and revocation on the actual MCP gateway', async () => {
  const issuer = 'https://identity.example/', publicUrl = 'https://127.0.0.1', audience = publicUrl + '/mcp';
  const owner = (sub: string) => digest([issuer, 'personal', sub]);
  const departureDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const flight = { origin: 'SHA', destination: 'PEK', departureDate, limit: 1 };
  let sourceReads = 0;
  const f = await fixture({ model: 'synthetic-flight-agent', async run(_prompt, tools) {
    await tools.get('complete_with_function')!.invoke({ function: 'readFliggyFlights', input: flight });
  } }, async (actor, provider) => {
    assert.equal(actor, owner('alice'));
    assert.equal(provider, 'Fliggy');
    return { provider, bindingId: 'synthetic-fliggy', async assertCurrent() {}, async read(input) {
      assert.deepEqual(input, flight);
      sourceReads++;
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
  const members = new Members(f.db);
  const config = readConfig({
    DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, PUBLIC_URL: publicUrl,
    OAUTH_ISSUER: issuer, OAUTH_AUDIENCE: publicUrl, OAUTH_JWKS_URL: issuer + '.well-known/jwks.json',
    OAUTH_MEMBER_CLIENT_ID: 'portal', OAUTH_MEMBER_CLIENT_SECRET: 'synthetic-portal-secret',
    OAUTH_MEMBER_MCP_CLIENT_ID: 'grok', OAUTH_EXISTING_CLIENT_IDS: 'existing-client',
    EIGOS_PORTAL_SECRET: 'p'.repeat(32), EIGOS_ACCOUNT_LINK_SECRET: 'l'.repeat(32),
    EIGOS_ENFORCE_OWNER_RLS: 'true', EIGOS_SIGNUP: 'invite',
  });
  const key = await generateKeyPair('RS256'), jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(key.publicKey), kid: 'test' }] });
  const sign = (payload: Record<string, unknown>, sub: string, aud: string, issuedAt = Math.floor(Date.now() / 1000)) =>
    new SignJWT({ tenant_id: 'personal', ...payload }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(issuer).setSubject(sub).setAudience(aud).setIssuedAt(issuedAt).setExpirationTime('15m').sign(key.privateKey);
  const token = (sub: string, azp = 'grok', aud = audience, scope = 'tasks:read tasks:write ontology:write', issuedAt?: number) =>
    sign({ azp, scope }, sub, aud, issuedAt);
  let nextIdentity: { name: string; email: string; verified: boolean; nonce: string; challenge: string } | undefined;
  let exchanges = 0;
  const exchange: typeof fetch = async (input, init) => {
    assert.equal(String(input), issuer + 'oauth/token');
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('redirect_uri'), publicUrl + '/members/callback');
    assert.equal(body.get('client_secret'), 'synthetic-portal-secret');
    assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), nextIdentity?.challenge);
    assert.equal(body.get('code'), 'test-authorization-code');
    exchanges++;
    const { name, email, verified, nonce } = nextIdentity!;
    return Response.json({ id_token: await sign({ email, email_verified: verified, nonce }, name, 'portal') });
  };
  const gateway = createApp(config, f.db, f.source, jwtVerifier(issuer, publicUrl, jwks, 'tenant_id', audience), {},
    { memberLogin: auth0MemberLogin(config, exchange, jwks) });
  const server = gateway.app.listen(0, '127.0.0.1'), clients: Client[] = [];
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = 'http://127.0.0.1:' + address.port;
  const responseCookie = (response: Response, key: string) =>
    response.headers.getSetCookie().find(value => value.startsWith(key + '='))?.split(';')[0] ?? '';
  const login = async (name: string, email: string, verified: boolean, wrongState = false) => {
    const start = await fetch(url + '/members/login?signup=1', { redirect: 'manual' });
    const location = new URL(start.headers.get('location')!);
    assert.equal(location.searchParams.get('screen_hint'), 'signup');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    const loginCookie = responseCookie(start, '__Host-eigos-member-login');
    assert(loginCookie);
    nextIdentity = { name, email, verified, challenge: location.searchParams.get('code_challenge')!, nonce: location.searchParams.get('nonce')! };
    const code = '?code=test-authorization-code&state=' + (wrongState ? 'wrong' : location.searchParams.get('state'));
    const result = await fetch(url + '/members/callback' + code, { redirect: 'manual', headers: { Cookie: loginCookie } });
    const replay = await fetch(url + '/members/callback' + code, { redirect: 'manual', headers: { Cookie: loginCookie } });
    assert.equal(replay.headers.get('location'), '/members?status=login');
    return { location: result.headers.get('location'), cookie: responseCookie(result, '__Host-eigos-member') };
  };
  const form = (path: string, cookie: string, body = new URLSearchParams(), origin = publicUrl) =>
    fetch(url + '/members/' + path, { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body, redirect: 'manual' });
  const call = (path: string, accessToken?: string) => fetch(url + path, { headers: accessToken ? { Authorization: 'Bearer ' + accessToken } : {} });
  const makeClient = async (accessToken: string) => {
    const client = new Client({ name: 'test-grok', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + accessToken } },
    }));
    return client;
  };
  try {
    const anonymous = await call('/mcp');
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate')!, /oauth-protected-resource\/mcp/);
    assert.equal((await (await call('/.well-known/oauth-protected-resource/mcp')).json()).resource, audience);
    assert.equal((await login('alice', 'alice@example.test', true, true)).location, '/members?status=login');
    assert.equal(exchanges, 0);
    const unverified = await login('alice', 'alice@example.test', false);
    assert.equal(unverified.location, '/members?status=verify');
    assert.equal(unverified.cookie, '__Host-eigos-member=');
    assert.equal(await members.account(owner('alice')), undefined);
    const unaffiliated = await token('alice', 'grok', audience, undefined, Math.floor(Date.now() / 1000) - 1);
    assert.equal((await call('/mcp', unaffiliated)).status, 403);

    const alice = await login('alice', 'alice@example.test', true);
    const bob = await login('bob', 'bob@example.test', true);
    assert.match(alice.cookie, /^__Host-eigos-member=.{43}$/);
    assert.equal((await fetch(url + '/mcp', { headers: { Cookie: alice.cookie } })).status, 401);
    const aliceCode = await members.invite('Alice@example.test', 24);
    assert.equal((await form('activate', bob.cookie, new URLSearchParams({ code: aliceCode }))).headers.get('location'), '/members?status=invite');
    assert.equal((await form('activate', alice.cookie, new URLSearchParams({ code: aliceCode }), 'https://other.example')).status, 403);
    assert.equal((await form('activate', alice.cookie, new URLSearchParams({ code: aliceCode }))).headers.get('location'), '/members');
    assert.equal((await call('/mcp', unaffiliated)).status, 403);
    assert.equal((await form('approve', alice.cookie)).status, 303);
    assert.equal((await call('/mcp', unaffiliated)).status, 403);
    assert.equal((await call('/mcp', await token('alice', 'grok', publicUrl))).status, 403);
    assert.equal((await call('/mcp', await token('alice', 'arbitrary-client'))).status, 403);
    assert.equal((await call('/mcp', await token('alice', 'grok', audience, 'tasks:read'))).status, 403);

    const bobCode = await members.invite('bob@example.test', 24);
    await form('activate', bob.cookie, new URLSearchParams({ code: bobCode }));
    await form('approve', bob.cookie);
    await setGrants(f.db, 'group:' + memberQueryGroup, [
      { resource: 'Eigos', permission: 'view_definition' },
      { resource: 'Eigos/function/readFliggyFlights', permission: 'execute_function' },
      { resource: 'Eigos/source/Fliggy', permission: 'read_source' },
    ]);
    const issuedAt = Math.ceil(Date.now() / 1000), aliceToken = await token('alice', 'grok', audience, undefined, issuedAt);
    const aliceMcp = await makeClient(aliceToken);
    const bobMcp = await makeClient(await token('bob', 'grok', audience, undefined, issuedAt));
    assert.deepEqual((await aliceMcp.listTools()).tools.map(tool => tool.name).sort(), ['get_task', 'submit_task']);
    assert.deepEqual((await (await call('/identity', aliceToken)).json()).scopes, ['tasks:read', 'tasks:write']);
    assert.equal((await call('/ontology', aliceToken)).status, 403);
    assert.equal((await call('/a2a', aliceToken)).status, 403);
    assert.equal((await call('/identity', await token('legacy', 'existing-client', publicUrl))).status, 403);
    await setGrants(f.db, owner('legacy'), [{ resource: 'Eigos', permission: 'view_definition' }]);
    assert.equal((await call('/identity', await token('legacy', 'existing-client', publicUrl))).status, 200);
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
    assert.equal(sourceReads, 1);
    assert.equal(f.provider.flags.orderCreates, 0);
    assert.equal((await form('revoke', alice.cookie)).status, 303);
    for (const [name, args] of [['get_task', { taskId: id }], ['submit_task', { requestId: 'after-revoke', message: '只查航班' }]] as const) {
      const denied = await fetch(url + '/mcp', { method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + aliceToken,
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      assert.equal(denied.status, 403);
    }
    assert.equal((await call('/mcp', await token('alice', 'grok', audience, undefined, issuedAt + 1))).status, 403);
    await form('approve', alice.cookie);
    assert.equal((await call('/mcp', aliceToken)).status, 403);
    assert.equal((await bobMcp.listTools()).tools.length, 2);
  } finally {
    for (const client of clients) await client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
});
