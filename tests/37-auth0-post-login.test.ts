import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createPostLogin } = require('../deploy/auth0/post-login.cjs');

type Claims = Record<string, unknown>;
interface Profile {
  user_id: string; email: string; email_verified: boolean; created_at: string;
  identities: Array<{ provider: string; user_id: string; connection: string }>; app_metadata: Claims;
}

const secrets = { EIGOS_AUDIENCES: 'https://eigos.example/mcp,https://eigos.example', EIGOS_CLIENT_IDS: 'portal,grok',
  EIGOS_CONNECTIONS: 'Username-Password-Authentication,google-oauth2', DEFAULT_TENANT: 'personal',
  LINK_URL: 'https://eigos.example/account/link', LINK_SECRET: 'l'.repeat(32),
  MANAGEMENT_DOMAIN: 'tenant.example', MANAGEMENT_CLIENT_ID: 'm2m', MANAGEMENT_CLIENT_SECRET: 'synthetic' };
const older: Profile = { user_id: 'google-oauth2|1', email: 'amy@example.test', email_verified: true, created_at: '2026-01-01T00:00:00Z',
  identities: [{ provider: 'google-oauth2', user_id: '1', connection: 'google-oauth2' }], app_metadata: { tenant_id: 'personal' } };
const newer: Profile = { user_id: 'auth0|2', email: 'amy@example.test', email_verified: true, created_at: '2026-11-17T00:00:00Z',
  identities: [{ provider: 'auth0', user_id: '2', connection: 'Username-Password-Authentication' }], app_metadata: {} };
const notVerified = '请先验证邮箱，再连接 EIGOS。', notLinked = '合并没有完成，请用原来的方式重新登录。';
// Another application of the same tenant, with a client and an API of its own.
const otherApp = { client: { client_id: 'other-app' }, resource_server: { identifier: 'https://other.example/api' } };
// The time the stamp tests run at, and the stamp the Action writes then.
const at = Date.parse('2026-11-18T09:00:00.000Z'), stampAt = '2026-11-18T09:00:00.000Z';
const stamped = (user: Profile, since: string): Profile => ({ ...user, app_metadata: { ...user.app_metadata, eigos_since: since } });

/** A Post-Login event for `user`; the default request is Grok asking for the EIGOS API, as an agent connecting to /mcp does. */
const login = (user: Profile, extra: Claims = {}) => ({ user, secrets, client: { client_id: 'grok' }, transaction: { protocol: 'oidc-basic-profile' },
  request: { query: {} }, resource_server: { identifier: 'https://eigos.example/mcp' }, ...extra });

/** Auth0 Actions refuse to cache under a key longer than this many bytes. */
const CACHE_KEY_LIMIT = 64;

/**
 * Records what the Action does to Auth0's `api`. `token` is what validateToken returns (it throws without one),
 * and `order` collects the calls whose order matters. Like Auth0, `cache.set` answers a key over the limit with
 * `{ type: 'error' }` instead of throwing, stores nothing and lists the key in `calls.refusedKeys`.
 */
function fakeApi(token?: Claims, order: string[] = []) {
  const calls = { deny: [] as string[], idToken: {} as Claims, accessToken: {} as Claims, metadata: [] as Array<[string, unknown]>,
    redirects: [] as Array<{ url: string; options: unknown }>, encoded: [] as unknown[], validated: [] as unknown[], primary: [] as string[],
    refusedKeys: [] as string[], cacheDeletes: [] as string[] };
  const cache = new Map<string, { value: string; ttl?: number }>();
  const api = {
    access: { deny: (reason: string) => { calls.deny.push(reason); } },
    idToken: { setCustomClaim: (name: string, value: unknown) => { calls.idToken[name] = value; } },
    accessToken: { setCustomClaim: (name: string, value: unknown) => { calls.accessToken[name] = value; } },
    user: { setAppMetadata: (key: string, value: unknown) => { calls.metadata.push([key, value]); } },
    authentication: { setPrimaryUser: (id: string) => { calls.primary.push(id); order.push('setPrimaryUser'); } },
    redirect: {
      sendUserTo: (url: string, options: unknown) => { calls.redirects.push({ url, options }); },
      encodeToken: (options: { payload: unknown }) => { calls.encoded.push(options); return 'encoded:' + JSON.stringify(options.payload); },
      validateToken: (options: unknown) => { calls.validated.push(options); if (!token) throw new Error('No session token'); return token; },
    },
    cache: {
      get: (key: string) => { const record = cache.get(key); return record && { value: record.value }; },
      set: (key: string, value: string, options?: { ttl?: number }) => {
        if (Buffer.byteLength(key) > CACHE_KEY_LIMIT) { calls.refusedKeys.push(key); return { type: 'error' }; }
        cache.set(key, { value, ttl: options?.ttl });
        return { type: 'success' };
      },
      delete: (key: string) => { calls.cacheDeletes.push(key); cache.delete(key); return { type: 'success' }; },
    },
  };
  return { api, calls, cache };
}
type Calls = ReturnType<typeof fakeApi>['calls'];
const payloads = (calls: Calls) => calls.encoded.map(call => (call as { payload: unknown }).payload);
const stampsOf = (calls: Calls) => calls.metadata.filter(([key]) => key === 'eigos_since');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Stands in for the Auth0 tenant: the token endpoint and the Management API calls the Action makes. The token endpoint always
 * issues `management-token`; the API accepts only the bearer token `accepted` and answers anything else with 401.
 */
function fakeManagement(users: Profile[], options: { domain?: string; expiresIn?: number; tokenStatus?: number; searchStatus?: number;
  linkStatus?: number; stampStatus?: number; accepted?: string } = {}, order: string[] = []) {
  const { domain = secrets.MANAGEMENT_DOMAIN, expiresIn = 86400, tokenStatus = 200, searchStatus = 200, linkStatus = 201, stampStatus = 200,
    accepted = 'management-token' } = options;
  const requests: Array<{ method: string; path: string; query: Record<string, string>; body: unknown; authorization: string | null }> = [];
  const links: Array<{ primary: string; body: unknown }> = [], stamps: Array<{ user: string; body: unknown }> = [];
  const fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input), method = init.method ?? 'GET', authorization = new Headers(init.headers).get('authorization');
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, authorization });
    assert.equal(url.origin, `https://${domain}`);
    if (url.pathname === '/oauth/token') return tokenStatus === 200 ? json({ access_token: 'management-token', token_type: 'Bearer', expires_in: expiresIn }) : json({ error: 'server_error' }, tokenStatus);
    if (authorization !== `Bearer ${accepted}`) return json({ message: 'Unauthorized' }, 401);
    if (url.pathname === '/api/v2/users-by-email') {
      return searchStatus === 200 ? json(users.filter(user => user.email === url.searchParams.get('email'))) : json({ message: 'Unavailable' }, searchStatus);
    }
    const match = /^\/api\/v2\/users\/([^/]+)(\/identities)?$/.exec(url.pathname);
    if (!match) return json({ message: 'Not found' }, 404);
    const id = decodeURIComponent(match[1]!), user = users.find(candidate => candidate.user_id === id);
    if (method === 'POST' && match[2]) { links.push({ primary: id, body }); order.push('link'); return json(user?.identities ?? [], linkStatus); }
    if (method === 'PATCH' && !match[2]) {
      stamps.push({ user: id, body }); order.push('stamp');
      return stampStatus === 200 && user ? json(user) : json({ message: 'Unavailable' }, stampStatus);
    }
    return method === 'GET' && !match[2] && user ? json(user) : json({ message: 'The user does not exist.' }, 404);
  };
  return { fetch, requests, links, stamps };
}

test('unverified email cannot obtain an EIGOS API token', async () => {
  for (const identifier of ['https://eigos.example/mcp', 'https://eigos.example']) {
    const { api, calls } = fakeApi(), management = fakeManagement([]);
    await createPostLogin({ fetch: management.fetch }).onExecutePostLogin(login({ ...newer, email_verified: false }, { resource_server: { identifier } }), api);
    assert.deepEqual(calls.deny, [notVerified], identifier);
    assert.deepEqual([calls.idToken, calls.accessToken], [{}, {}], identifier);
    // deny() does not undo a metadata write, so none may happen before it
    assert.deepEqual(calls.metadata, [], identifier);
    assert.deepEqual([calls.redirects, management.requests], [[], []], identifier);
  }
});

test('verified login gets the managed tenant claim', async () => {
  // These users are EIGOS accounts already, so the tenant is the only metadata the Action could write.
  const since = { eigos_since: '2026-01-01T00:00:00.000Z' };
  const claims = async (user: Profile, overrides: Record<string, string> = {}) => {
    const { api, calls } = fakeApi();
    await createPostLogin({ fetch: fakeManagement([user]).fetch }).onExecutePostLogin(login(user, { secrets: { ...secrets, ...overrides } }), api);
    return calls;
  };
  // A managed tenant goes into both tokens as it is, and nothing is written back.
  let calls = await claims({ ...older, app_metadata: { ...since, tenant_id: 'org-7' } });
  assert.deepEqual([calls.idToken, calls.accessToken, calls.metadata, calls.deny], [{ tenant_id: 'org-7' }, { tenant_id: 'org-7' }, [], []]);
  // A new user gets DEFAULT_TENANT, and it is stored so that it stays the same from now on.
  calls = await claims({ ...older, app_metadata: { ...since } });
  assert.deepEqual([calls.idToken, calls.accessToken, calls.metadata], [{ tenant_id: 'personal' }, { tenant_id: 'personal' }, [['tenant_id', 'personal']]]);
  // An empty value is not a tenant.
  calls = await claims({ ...older, app_metadata: { ...since, tenant_id: '' } });
  assert.deepEqual([calls.idToken, calls.metadata], [{ tenant_id: 'personal' }, [['tenant_id', 'personal']]]);
  // The claim name and the metadata key are configurable.
  const names = { TENANT_CLAIM: 'https://eigos.example/tenant', TENANT_METADATA_KEY: 'eigos_tenant' };
  calls = await claims({ ...older, app_metadata: { ...since, eigos_tenant: 'org-7', tenant_id: 'ignored' } }, names);
  assert.deepEqual([calls.idToken, calls.accessToken, calls.metadata], [{ [names.TENANT_CLAIM]: 'org-7' }, { [names.TENANT_CLAIM]: 'org-7' }, []]);
  calls = await claims({ ...older, app_metadata: { ...since } }, names);
  assert.deepEqual(calls.metadata, [['eigos_tenant', 'personal']]);
});

test('only EIGOS logins are touched: other applications of the tenant get no metadata, lookup, redirect or claim', async () => {
  // The user has an older verified duplicate and no tenant yet, in the second case no verified email either. Whatever else runs for
  // that application decides about all of it.
  const others: Array<[string, Profile, Claims]> = [
    ['an older verified duplicate', newer, otherApp],
    ['an unverified email', { ...newer, email_verified: false }, otherApp],
    ['an ID token only', newer, { ...otherApp, resource_server: undefined }],
  ];
  for (const [name, user, extra] of others) {
    const { api, calls } = fakeApi(), management = fakeManagement([older, newer]);
    await createPostLogin({ fetch: management.fetch }).onExecutePostLogin(login(user, extra), api);
    assert.deepEqual([calls.redirects, management.requests, calls.metadata, calls.idToken, calls.accessToken, calls.deny],
      [[], [], [], {}, {}, []], name);
  }

  // An EIGOS client is checked even when it asks for no EIGOS API, and an EIGOS API is checked for any client.
  const eigos: Array<[string, Claims]> = [
    ['the account portal asking for an ID token only', { client: { client_id: 'portal' }, resource_server: undefined }],
    ['a client that is not listed asking for the EIGOS API', { client: { client_id: 'new-agent' } }],
  ];
  for (const [name, extra] of eigos) {
    const { api, calls } = fakeApi(), management = fakeManagement([older, newer]);
    await createPostLogin({ fetch: management.fetch }).onExecutePostLogin(login(newer, extra), api);
    assert.deepEqual(payloads(calls), [{ primary: 'google-oauth2|1', connection: 'google-oauth2' }], name);
    assert.equal(management.requests.some(request => request.path === '/api/v2/users-by-email'), true, name);
  }
});

test('a newer identity with an older verified duplicate is sent to the EIGOS link page', async () => {
  const { api, calls } = fakeApi(), management = fakeManagement([older, newer]);
  await createPostLogin({ fetch: management.fetch }).onExecutePostLogin(login(newer), api);
  assert.deepEqual(calls.redirects, [{ url: secrets.LINK_URL, options: { query: { session_token: 'encoded:{"primary":"google-oauth2|1","connection":"google-oauth2"}' } } }]);
  assert.deepEqual(calls.encoded, [{ secret: secrets.LINK_SECRET, expiresInSeconds: 300, payload: { primary: 'google-oauth2|1', connection: 'google-oauth2' } }]);
  assert.deepEqual([calls.idToken, calls.accessToken, calls.deny], [{}, {}, []]);
  assert.deepEqual(management.requests.map(({ method, path, query, authorization }) => [method, path, query, authorization]), [
    ['POST', '/oauth/token', {}, null],
    ['GET', '/api/v2/users-by-email', { email: 'amy@example.test' }, 'Bearer management-token'],
  ]);
  assert.deepEqual(management.requests[0]?.body,
    { grant_type: 'client_credentials', client_id: 'm2m', client_secret: 'synthetic', audience: 'https://tenant.example/api/v2/' });

  // No request parameter can skip the check: a newer duplicate that adds eigos_link=1 to /authorize is sent to the link page all the same.
  const forged = fakeApi(), forgedLookup = fakeManagement([older, newer]);
  await createPostLogin({ fetch: forgedLookup.fetch }).onExecutePostLogin(login(newer, { request: { query: { eigos_link: '1' } } }), forged.api);
  assert.deepEqual(forged.calls.redirects, [{ url: secrets.LINK_URL, options: { query: { session_token: 'encoded:{"primary":"google-oauth2|1","connection":"google-oauth2"}' } } }]);
  assert.deepEqual([forged.calls.idToken, forged.calls.accessToken, forged.calls.deny], [{}, {}, []]);
  assert.equal(forgedLookup.requests.some(request => request.path === '/api/v2/users-by-email'), true);

  // With several unstamped candidates the earliest created verified account is the primary, wherever it sits in the result.
  const oldest: Profile = { ...older, user_id: 'auth0|0', created_at: '2025-06-01T00:00:00Z',
    identities: [{ provider: 'auth0', user_id: '0', connection: 'Username-Password-Authentication' }] };
  const unverifiedOlder: Profile = { ...older, user_id: 'auth0|9', email_verified: false, created_at: '2024-01-01T00:00:00Z' };
  const many = fakeApi();
  await createPostLogin({ fetch: fakeManagement([unverifiedOlder, older, newer, oldest]).fetch }).onExecutePostLogin(login(newer), many.api);
  assert.deepEqual(many.calls.encoded, [{ secret: secrets.LINK_SECRET, expiresInSeconds: 300,
    payload: { primary: 'auth0|0', connection: 'Username-Password-Authentication' } }]);

  // The older account itself is not sent anywhere: the duplicate is newer than it.
  const first = fakeApi();
  await createPostLogin({ fetch: fakeManagement([older, newer]).fetch }).onExecutePostLogin(login(older), first.api);
  assert.deepEqual([first.calls.redirects, first.calls.idToken], [[], { tenant_id: 'personal' }]);

  // The address is encoded in the lookup: a plus sign must not turn into a space.
  const tagged = { ...older, email: 'amy+eigos@example.test' }, taggedNewer = { ...newer, email: 'amy+eigos@example.test' };
  const plus = fakeApi(), lookup = fakeManagement([tagged, taggedNewer]);
  await createPostLogin({ fetch: lookup.fetch }).onExecutePostLogin(login(taggedNewer), plus.api);
  assert.deepEqual(lookup.requests[1]?.query, { email: 'amy+eigos@example.test' });
  assert.deepEqual(plus.calls.encoded, [{ secret: secrets.LINK_SECRET, expiresInSeconds: 300, payload: { primary: 'google-oauth2|1', connection: 'google-oauth2' } }]);
});

test('the primary is the account that became an EIGOS account first, not the one created first', async () => {
  // A signed up with a password first and did not verify. B signed in with Google later, got EIGOS claims, was stamped and keeps
  // the data. Then A verified its address.
  const a: Profile = { ...newer, user_id: 'auth0|a', created_at: '2026-01-01T00:00:00Z',
    identities: [{ provider: 'auth0', user_id: 'a', connection: 'Username-Password-Authentication' }] };
  const b = stamped({ ...older, user_id: 'google-oauth2|b', created_at: '2026-06-01T00:00:00Z',
    identities: [{ provider: 'google-oauth2', user_id: 'b', connection: 'google-oauth2' }] }, '2026-06-01T00:05:00.000Z');

  // A is sent to merge into B and gets no claim.
  const asA = fakeApi();
  await createPostLogin({ fetch: fakeManagement([a, b]).fetch }).onExecutePostLogin(login(a), asA.api);
  assert.deepEqual(payloads(asA.calls), [{ primary: 'google-oauth2|b', connection: 'google-oauth2' }]);
  assert.deepEqual([asA.calls.idToken, asA.calls.accessToken, stampsOf(asA.calls)], [{}, {}, []]);

  // B is never sent anywhere, before or after A verified, and its stamp stays as it is.
  for (const users of [[{ ...a, email_verified: false }, b], [a, b]]) {
    const asB = fakeApi();
    await createPostLogin({ fetch: fakeManagement(users).fetch }).onExecutePostLogin(login(b), asB.api);
    assert.deepEqual([asB.calls.redirects, asB.calls.metadata, asB.calls.idToken], [[], [], { tenant_id: 'personal' }]);
  }

  // Continue takes A into B, and B keeps its stamp.
  const merge = fakeApi({ primary: b.user_id }), accounts = fakeManagement([a, b]);
  await createPostLogin({ fetch: accounts.fetch }).onContinuePostLogin(login(a), merge.api);
  assert.deepEqual([merge.calls.deny, merge.calls.primary, accounts.stamps], [[], ['google-oauth2|b'], []]);
  assert.deepEqual(accounts.links, [{ primary: 'google-oauth2|b', body: { provider: 'auth0', user_id: 'a' } }]);

  // Among stamped accounts the earlier stamp wins, and of two equal stamps the earlier created one. Unstamped accounts come last,
  // however old they are.
  const early = stamped({ ...older, user_id: 'google-oauth2|early', created_at: '2026-09-01T00:00:00Z' }, '2026-03-01T00:00:00.000Z');
  const late = stamped({ ...older, user_id: 'google-oauth2|late', created_at: '2026-02-01T00:00:00Z' }, '2026-04-01T00:00:00.000Z');
  const unstampedOldest: Profile = { ...older, user_id: 'google-oauth2|old', created_at: '2024-01-01T00:00:00Z' };
  const twin = stamped({ ...older, user_id: 'google-oauth2|twin', created_at: '2026-08-01T00:00:00Z' }, '2026-03-01T00:00:00.000Z');
  const pick = async (users: Profile[]) => {
    const run = fakeApi();
    await createPostLogin({ fetch: fakeManagement([...users, newer]).fetch }).onExecutePostLogin(login(newer), run.api);
    return payloads(run.calls).map(payload => (payload as { primary: string }).primary);
  };
  assert.deepEqual(await pick([unstampedOldest, late, early]), ['google-oauth2|early']);
  assert.deepEqual(await pick([early, twin, unstampedOldest]), ['google-oauth2|twin'], 'equal stamps: the earlier created');
  // A stamped user is sent only to an account stamped before it.
  const stampedNewer = stamped(newer, '2026-03-15T00:00:00.000Z');
  for (const [users, expected] of [[[late, unstampedOldest], []], [[late, early], ['google-oauth2|early']]] as const) {
    const run = fakeApi();
    await createPostLogin({ fetch: fakeManagement([...users, stampedNewer]).fetch }).onExecutePostLogin(login(stampedNewer), run.api);
    assert.deepEqual(payloads(run.calls).map(payload => (payload as { primary: string }).primary), expected);
  }
});

test('a duplicate that the account portal cannot sign in to is never the primary', async () => {
  // A connection that is not in EIGOS_CONNECTIONS, such as an enterprise one: the link page could not ask for that login.
  const corporate: Profile = { ...older, user_id: 'samlp|corp|7', created_at: '2025-01-01T00:00:00Z',
    identities: [{ provider: 'samlp', user_id: 'corp|7', connection: 'corp-saml' }] };
  const alone = fakeApi(), lookup = fakeManagement([corporate, newer]);
  await createPostLogin({ fetch: lookup.fetch }).onExecutePostLogin(login(newer), alone.api);
  assert.deepEqual([alone.calls.redirects, alone.calls.idToken], [[], { tenant_id: 'personal' }], 'nobody to merge into');
  assert.equal(lookup.requests.some(request => request.path === '/api/v2/users-by-email'), true);

  // An older account on such a connection does not hide a later one that the portal can sign in to.
  const both = fakeApi();
  await createPostLogin({ fetch: fakeManagement([corporate, older, newer]).fetch }).onExecutePostLogin(login(newer), both.api);
  assert.deepEqual(payloads(both.calls), [{ primary: 'google-oauth2|1', connection: 'google-oauth2' }]);

  // An account with several identities is asked for a login with one that the portal can use.
  const linked: Profile = { ...corporate, identities: [...corporate.identities, { provider: 'google-oauth2', user_id: '8', connection: 'google-oauth2' }] };
  const several = fakeApi();
  await createPostLogin({ fetch: fakeManagement([linked, newer]).fetch }).onExecutePostLogin(login(newer), several.api);
  assert.deepEqual(payloads(several.calls), [{ primary: 'samlp|corp|7', connection: 'google-oauth2' }]);
});

test('a verified user is stamped once, when it first gets EIGOS claims, and the stamp never moves', async () => {
  const run = async (user: Profile, extra: Claims = {}, users: Profile[] = [user]) => {
    const { api, calls } = fakeApi();
    await createPostLogin({ fetch: fakeManagement(users).fetch, now: () => at }).onExecutePostLogin(login(user, extra), api);
    return calls;
  };
  // The first EIGOS claims: an agent's EIGOS API token, or the account portal's ID token.
  assert.deepEqual(stampsOf(await run(older)), [['eigos_since', stampAt]]);
  assert.deepEqual(stampsOf(await run(older, { client: { client_id: 'portal' }, resource_server: undefined })), [['eigos_since', stampAt]]);
  // A stamped user keeps the stamp it has, in any later login.
  const since = stamped(older, '2026-02-01T00:00:00.000Z');
  for (const extra of [{}, { transaction: { protocol: 'oauth2-refresh-token' } }, { client: { client_id: 'portal' }, resource_server: undefined }])
    assert.deepEqual(stampsOf(await run(since, extra)), [], JSON.stringify(extra));
  // Without EIGOS claims there is no stamp: an unverified user, a login that is sent to the link page, another application.
  assert.deepEqual(stampsOf(await run({ ...older, email_verified: false }, { resource_server: undefined })), []);
  const linking = await run(newer, {}, [older, newer]);
  assert.equal(linking.redirects.length, 1);
  assert.deepEqual(linking.metadata, [['tenant_id', 'personal']], 'only the tenant');
  assert.deepEqual((await run(older, otherApp)).metadata, []);
});

test('continue links the identity into the verified primary and switches the login', async () => {
  const order: string[] = [], { api, calls } = fakeApi({ primary: 'google-oauth2|1' }, order), management = fakeManagement([older, newer], {}, order);
  await createPostLogin({ fetch: management.fetch, now: () => at }).onContinuePostLogin(login(newer), api);
  assert.deepEqual(calls.validated, [{ secret: secrets.LINK_SECRET, tokenParameterName: 'session_token' }]);
  assert.deepEqual(management.requests.map(request => `${request.method} ${request.path}`), [
    'POST /oauth/token', 'GET /api/v2/users/google-oauth2%7C1', 'PATCH /api/v2/users/google-oauth2%7C1', 'POST /api/v2/users/google-oauth2%7C1/identities']);
  assert.deepEqual(management.links, [{ primary: 'google-oauth2|1', body: { provider: 'auth0', user_id: '2' } }]);
  assert.deepEqual(calls.primary, ['google-oauth2|1']);
  // The primary gets its first EIGOS claims now, so it is stamped, through the Management API and before anything is linked: the user
  // who signed in becomes part of the primary and gets no metadata of its own. Auth0 only accepts the new primary once the identity is linked to it.
  assert.deepEqual(management.stamps, [{ user: 'google-oauth2|1', body: { app_metadata: { eigos_since: stampAt } } }]);
  assert.deepEqual(order, ['stamp', 'link', 'setPrimaryUser']);
  assert.deepEqual([calls.metadata, calls.idToken, calls.accessToken, calls.deny], [[], { tenant_id: 'personal' }, { tenant_id: 'personal' }, []]);

  // A primary that is stamped already keeps its stamp.
  const kept = fakeApi({ primary: 'google-oauth2|1' }), stampedPrimary = fakeManagement([stamped(older, '2026-01-02T00:00:00.000Z'), newer]);
  await createPostLogin({ fetch: stampedPrimary.fetch }).onContinuePostLogin(login(newer), kept.api);
  assert.deepEqual([kept.calls.deny, kept.calls.primary, stampedPrimary.stamps], [[], ['google-oauth2|1'], []]);

  // The tenant is the primary's own, and DEFAULT_TENANT only fills in when the primary has none.
  const variants: Array<[string, Profile, Claims]> = [
    ['the primary has a tenant', { ...older, app_metadata: { tenant_id: 'org-7' } }, { tenant_id: 'org-7' }],
    ['the primary has no tenant', { ...older, app_metadata: {} }, { tenant_id: 'fallback' }],
    ['the email differs only by case', { ...older, email: 'AMY@Example.Test' }, { tenant_id: 'personal' }],
  ];
  for (const [name, primary, expected] of variants) {
    const run = fakeApi({ primary: primary.user_id }), accounts = fakeManagement([primary, newer]);
    await createPostLogin({ fetch: accounts.fetch }).onContinuePostLogin(login(newer, { secrets: { ...secrets, DEFAULT_TENANT: 'fallback' } }), run.api);
    assert.deepEqual([run.calls.deny, run.calls.primary, run.calls.idToken, run.calls.accessToken],
      [[], [primary.user_id], expected, expected], name);
  }

  // A login that only asks for an ID token gets only that claim.
  const idOnly = fakeApi({ primary: 'google-oauth2|1' });
  await createPostLogin({ fetch: fakeManagement([older, newer]).fetch }).onContinuePostLogin(login(newer, { resource_server: undefined }), idOnly.api);
  assert.deepEqual([idOnly.calls.primary, idOnly.calls.idToken, idOnly.calls.accessToken], [['google-oauth2|1'], { tenant_id: 'personal' }, {}]);
});

test('continue refuses a primary that is not the one the user would be sent to', async () => {
  const toOlder = { primary: older.user_id }, unverifiedNewer = { ...newer, email_verified: false };
  const stampedNewer = stamped(newer, '2026-11-17T00:10:00.000Z');
  const refusals: Array<[string, Profile, Profile[], Claims | undefined]> = [
    ['a different email', newer, [{ ...older, email: 'someone-else@example.test' }, newer], toOlder],
    ['an unverified email', newer, [{ ...older, email_verified: false }, newer], toOlder],
    ['a primary that is not older than the current user', newer, [{ ...older, created_at: '2026-12-01T00:00:00Z' }, newer], toOlder],
    ['an unstamped primary for a stamped user', stampedNewer, [older, stampedNewer], toOlder],
    ['a primary stamped after the user', stampedNewer, [stamped(older, '2026-11-17T00:20:00.000Z'), stampedNewer], toOlder],
    ['a primary that the portal cannot sign in to', newer, [{ ...older, identities: [{ provider: 'samlp', user_id: 'corp|1', connection: 'corp-saml' }] }, newer], toOlder],
    ['a primary that does not exist', newer, [newer], toOlder],
    ['a current user who has not verified their email', unverifiedNewer, [older, unverifiedNewer], toOlder],
    ['a token without a primary', newer, [older, newer], {}],
    ['a token that does not validate', newer, [older, newer], undefined],
  ];
  for (const [name, user, users, token] of refusals) {
    const { api, calls } = fakeApi(token), management = fakeManagement(users);
    await createPostLogin({ fetch: management.fetch }).onContinuePostLogin(login(user), api);
    assert.deepEqual(calls.deny, [notLinked], name);
    assert.deepEqual([management.links, management.stamps], [[], []], name);
    assert.deepEqual(calls.primary, [], name);
    assert.deepEqual([calls.idToken, calls.accessToken], [{}, {}], name);
  }
});

test('continue refuses when the Management API cannot stamp the primary or link the identity', async () => {
  // A stamp that fails stops the merge before anything is linked.
  const unstampable = fakeApi({ primary: 'google-oauth2|1' }), failing = fakeManagement([older, newer], { stampStatus: 500 });
  await createPostLogin({ fetch: failing.fetch }).onContinuePostLogin(login(newer), unstampable.api);
  assert.deepEqual([unstampable.calls.deny, failing.stamps.length, failing.links], [[notLinked], 1, []]);
  assert.deepEqual([unstampable.calls.primary, unstampable.calls.idToken, unstampable.calls.accessToken], [[], {}, {}]);

  const { api, calls } = fakeApi({ primary: 'google-oauth2|1' }), management = fakeManagement([older, newer], { linkStatus: 409 });
  await createPostLogin({ fetch: management.fetch }).onContinuePostLogin(login(newer), api);
  assert.deepEqual(management.links, [{ primary: 'google-oauth2|1', body: { provider: 'auth0', user_id: '2' } }]);
  assert.deepEqual(calls.deny, [notLinked]);
  assert.deepEqual([calls.primary, calls.idToken, calls.accessToken], [[], {}, {}]);
});

test('the Management token is cached until a minute before it expires', async () => {
  // What a real tenant has: a domain like dev-abcd1234.us.auth0.com and a 32 character client id. A cache key built from them
  // (management-token:<domain>:<client id> is 75 bytes with these values) is refused by Auth0, so the token would never be cached.
  const real = { MANAGEMENT_DOMAIN: 'dev-abcd1234.us.auth0.com', MANAGEMENT_CLIENT_ID: 'AbCdEfGh1234IjKlMnOp5678QrStUvWx' };
  const event = (user: Profile) => login(user, { secrets: { ...secrets, ...real } });
  const tokenRequests = (management: ReturnType<typeof fakeManagement>) => management.requests.filter(request => request.path === '/oauth/token').length;
  const { api, calls, cache } = fakeApi(), management = fakeManagement([older, newer], { domain: real.MANAGEMENT_DOMAIN, expiresIn: 3600 });
  const { onExecutePostLogin } = createPostLogin({ fetch: management.fetch });
  await onExecutePostLogin(event(newer), api);
  await onExecutePostLogin(event(newer), api);
  assert.deepEqual(calls.refusedKeys, [], 'every cache key fits the 64 byte limit');
  assert.equal(tokenRequests(management), 1);
  assert.equal(management.requests.filter(request => request.path === '/api/v2/users-by-email').length, 2);
  assert.deepEqual([...cache.values()], [{ value: 'management-token', ttl: (3600 - 60) * 1000 }]);

  // A token that would be expired by then is not worth keeping.
  const short = fakeApi(), brief = fakeManagement([older, newer], { domain: real.MANAGEMENT_DOMAIN, expiresIn: 30 });
  await createPostLogin({ fetch: brief.fetch }).onExecutePostLogin(event(newer), short.api);
  await createPostLogin({ fetch: brief.fetch }).onExecutePostLogin(event(newer), short.api);
  assert.equal(short.cache.size, 0);
  assert.equal(tokenRequests(brief), 2);
});

test('a cached Management token that Auth0 refuses is dropped, and the request is sent once more with a new token', async () => {
  const sent = (management: ReturnType<typeof fakeManagement>) => management.requests.map(request => `${request.path} ${request.authorization ?? ''}`.trim());
  // After a signing key rotation the cached token is refused before it expires.
  const rotated = fakeApi(), management = fakeManagement([older, newer]);
  rotated.cache.set('eigos-mgmt-token', { value: 'stale-token' });
  await createPostLogin({ fetch: management.fetch }).onExecutePostLogin(login(newer), rotated.api);
  assert.deepEqual(sent(management), ['/api/v2/users-by-email Bearer stale-token', '/oauth/token', '/api/v2/users-by-email Bearer management-token']);
  assert.deepEqual(payloads(rotated.calls), [{ primary: 'google-oauth2|1', connection: 'google-oauth2' }], 'the login goes on');
  assert.deepEqual([...rotated.cache.values()].map(record => record.value), ['management-token'], 'the new token replaces it');

  // A new token that is refused too ends the login, and only once: no token that Auth0 refused stays in the cache.
  const refused = fakeApi(), nobody = fakeManagement([older, newer], { accepted: 'none' });
  refused.cache.set('eigos-mgmt-token', { value: 'stale-token' });
  await assert.rejects(createPostLogin({ fetch: nobody.fetch }).onExecutePostLogin(login(newer), refused.api), /users-by-email request failed with status 401/);
  assert.deepEqual(sent(nobody), ['/api/v2/users-by-email Bearer stale-token', '/oauth/token', '/api/v2/users-by-email Bearer management-token']);
  assert.equal(refused.cache.size, 0);
  assert.deepEqual([refused.calls.redirects, refused.calls.idToken, refused.calls.accessToken], [[], {}, {}]);

  // A token that was just issued is not asked for again when it is refused, and it is not kept.
  const fresh = fakeApi(), rejecting = fakeManagement([older, newer], { accepted: 'none' });
  await assert.rejects(createPostLogin({ fetch: rejecting.fetch }).onExecutePostLogin(login(newer), fresh.api), /status 401/);
  assert.deepEqual(sent(rejecting), ['/oauth/token', '/api/v2/users-by-email Bearer management-token']);
  assert.equal(fresh.cache.size, 0);
});

test('a failure while checking for duplicates or a missing secret stops the login before any claim is written', async () => {
  const failures: Array<[string, ReturnType<typeof fakeManagement>, Record<string, string | undefined>, RegExp, Claims?]> = [
    ['the token request fails', fakeManagement([older, newer], { tokenStatus: 500 }), {}, /token request failed with status 500/],
    ['the duplicate lookup fails', fakeManagement([older, newer], { searchStatus: 500 }), {}, /users-by-email request failed with status 500/],
    ['DEFAULT_TENANT is not set', fakeManagement([newer]), { DEFAULT_TENANT: undefined }, /DEFAULT_TENANT/],
    ['the Management credentials are not set', fakeManagement([newer]), { MANAGEMENT_CLIENT_SECRET: undefined }, /MANAGEMENT_CLIENT_SECRET/],
    ['EIGOS_AUDIENCES lists nothing', fakeManagement([older, newer]), { EIGOS_AUDIENCES: ' , ' }, /EIGOS_AUDIENCES/],
    // Without the client list the Action cannot tell an EIGOS login from another application's, so it lets neither through.
    ['EIGOS_CLIENT_IDS is not set', fakeManagement([older, newer]), { EIGOS_CLIENT_IDS: undefined }, /EIGOS_CLIENT_IDS/],
    ['EIGOS_CLIENT_IDS is not set for another application', fakeManagement([older, newer]), { EIGOS_CLIENT_IDS: undefined }, /EIGOS_CLIENT_IDS/, otherApp],
    // The connection list is read before the lookup, so it fails even when there is nobody to merge into.
    ['EIGOS_CONNECTIONS is not set', fakeManagement([newer]), { EIGOS_CONNECTIONS: undefined }, /EIGOS_CONNECTIONS/],
    ['EIGOS_CONNECTIONS lists nothing', fakeManagement([older, newer]), { EIGOS_CONNECTIONS: ',' }, /EIGOS_CONNECTIONS/],
  ];
  for (const [name, management, overrides, message, extra = {}] of failures) {
    const { api, calls } = fakeApi();
    await assert.rejects(createPostLogin({ fetch: management.fetch }).onExecutePostLogin(login(newer, { ...extra, secrets: { ...secrets, ...overrides } }), api), message, name);
    assert.deepEqual([calls.idToken, calls.accessToken, calls.redirects, calls.deny], [{}, {}, [], []], name);
  }
  // Continue checks the primary against the same connection list.
  const { api, calls } = fakeApi({ primary: older.user_id }), management = fakeManagement([older, newer]);
  await assert.rejects(createPostLogin({ fetch: management.fetch }).onContinuePostLogin(login(newer, { secrets: { ...secrets, EIGOS_CONNECTIONS: undefined } }), api), /EIGOS_CONNECTIONS/);
  assert.deepEqual([management.links, management.stamps, calls.primary, calls.idToken], [[], [], [], {}]);
});

test('no link redirect for unverified duplicates, refresh tokens or the link verification login', async () => {
  const unverifiedNewer = { ...newer, email_verified: false };
  const linked = { ...newer, identities: [...newer.identities, { provider: 'google-oauth2', user_id: '3', connection: 'google-oauth2' }] };
  const cases: Array<{ name: string; user: Profile; users: Profile[]; extra?: Claims; lookup: boolean; accessToken: boolean }> = [
    { name: 'the older duplicate has not verified its email', user: newer, users: [{ ...older, email_verified: false }, newer], lookup: true, accessToken: true },
    { name: 'the new account has not verified its email and only asks for an ID token', user: unverifiedNewer, users: [older, unverifiedNewer],
      extra: { resource_server: undefined }, lookup: false, accessToken: false },
    { name: 'a refresh token exchange', user: newer, users: [older, newer], extra: { transaction: { protocol: 'oauth2-refresh-token' } }, lookup: false, accessToken: true },
    // The verification login is the older primary signing in again. It is checked like every login (eigos_link=1 changes nothing) and
    // passes because no verified account ranks before the primary.
    { name: 'the link verification login', user: older, users: [older, newer], extra: { request: { query: { eigos_link: '1' } } }, lookup: true, accessToken: true },
    { name: 'an account that already has several identities', user: linked, users: [older, linked], lookup: false, accessToken: true },
  ];
  for (const { name, user, users, extra, lookup, accessToken } of cases) {
    const { api, calls } = fakeApi(), management = fakeManagement(users);
    await createPostLogin({ fetch: management.fetch }).onExecutePostLogin(login(user, extra), api);
    assert.deepEqual(calls.redirects, [], name);
    assert.deepEqual(calls.deny, [], name);
    assert.deepEqual(calls.idToken, { tenant_id: 'personal' }, name);
    assert.deepEqual(calls.accessToken, accessToken ? { tenant_id: 'personal' } : {}, name);
    // Only the first case and the verification login look for duplicates, and neither finds one it may use.
    assert.equal(management.requests.some(request => request.path === '/api/v2/users-by-email'), lookup, name);
  }
});

test('EIGOS_AUDIENCES supports both /mcp and /a2a audiences', async () => {
  const bothAudiences = { ...secrets, EIGOS_AUDIENCES: 'https://eigos.example/mcp, https://eigos.example/a2a' };
  const a2a = { secrets: bothAudiences, resource_server: { identifier: 'https://eigos.example/a2a' } };

  // Unverified email is denied for /a2a just like /mcp.
  const denied = fakeApi(), noLookup = fakeManagement([]);
  await createPostLogin({ fetch: noLookup.fetch }).onExecutePostLogin(login({ ...newer, email_verified: false }, a2a), denied.api);
  assert.deepEqual(denied.calls.deny, [notVerified]);
  assert.deepEqual([denied.calls.idToken, denied.calls.accessToken, denied.calls.metadata], [{}, {}, []]);

  // Verified email receives tenant claim in both ID and access tokens for /a2a.
  const ok = fakeApi();
  await createPostLogin({ fetch: fakeManagement([older]).fetch, now: () => at }).onExecutePostLogin(login(older, a2a), ok.api);
  assert.deepEqual(ok.calls.deny, []);
  assert.deepEqual([ok.calls.idToken, ok.calls.accessToken], [{ tenant_id: 'personal' }, { tenant_id: 'personal' }]);
});

test('mixed-case email also checks lowercase duplicate in users-by-email', async () => {
  const mixedNewer: Profile = { ...newer, email: 'Amy@Example.Test' };
  const { api, calls } = fakeApi(), management = fakeManagement([older, mixedNewer]);
  await createPostLogin({ fetch: management.fetch }).onExecutePostLogin(login(mixedNewer), api);
  assert.deepEqual(payloads(calls), [{ primary: 'google-oauth2|1', connection: 'google-oauth2' }]);
  assert.deepEqual(
    management.requests.filter(request => request.path === '/api/v2/users-by-email').map(request => request.query.email),
    ['Amy@Example.Test', 'amy@example.test'],
  );

  // Already-lowercase email makes only a single lookup request.
  const lowerRun = fakeApi(), lowerMgmt = fakeManagement([older, newer]);
  await createPostLogin({ fetch: lowerMgmt.fetch }).onExecutePostLogin(login(newer), lowerRun.api);
  assert.deepEqual(
    lowerMgmt.requests.filter(request => request.path === '/api/v2/users-by-email').map(request => request.query.email),
    ['amy@example.test'],
  );
});

test('missing identities or email edge cases never crash execute or stamp on continue', async () => {
  const noIdentities = { ...newer, identities: undefined as unknown as Profile['identities'] };
  const emptyIdentities = { ...newer, identities: [] };
  const missingEmail = { ...newer, email: '' };

  for (const [name, user] of [['missing identities', noIdentities], ['empty identities', emptyIdentities], ['empty email', missingEmail]] as const) {
    const { api, calls } = fakeApi(), management = fakeManagement([older, newer]);
    await createPostLogin({ fetch: management.fetch }).onExecutePostLogin(login(user), api);
    assert.deepEqual(calls.deny, [], name);
    assert.deepEqual(calls.redirects, [], name);
    assert.deepEqual(calls.idToken, { tenant_id: 'personal' }, name);
    assert.equal(management.requests.length, 0, name);
  }

  // onContinuePostLogin refuses cleanly before stamping or linking when identities are missing, empty, or already linked.
  const alreadyLinked = { ...newer, identities: [...newer.identities, { provider: 'google-oauth2', user_id: '3', connection: 'google-oauth2' }] };
  const malformedIdentity = { ...newer, identities: [{ provider: '', user_id: '2', connection: 'Username-Password-Authentication' }] };
  for (const [name, user] of [
    ['missing identities', noIdentities],
    ['empty identities', emptyIdentities],
    ['already linked', alreadyLinked],
    ['missing provider', malformedIdentity],
  ] as const) {
    const { api, calls } = fakeApi({ primary: older.user_id }), management = fakeManagement([older, newer]);
    await createPostLogin({ fetch: management.fetch }).onContinuePostLogin(login(user), api);
    assert.deepEqual(calls.deny, [notLinked], name);
    assert.deepEqual([management.stamps, management.links, management.requests], [[], [], []], name);
  }
});
