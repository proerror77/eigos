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

const secrets = { EIGOS_AUDIENCES: 'https://eigos.example/mcp,https://eigos.example', DEFAULT_TENANT: 'personal',
  LINK_URL: 'https://eigos.example/account/link', LINK_SECRET: 'l'.repeat(32),
  MANAGEMENT_DOMAIN: 'tenant.example', MANAGEMENT_CLIENT_ID: 'm2m', MANAGEMENT_CLIENT_SECRET: 'synthetic' };
const older: Profile = { user_id: 'google-oauth2|1', email: 'amy@example.test', email_verified: true, created_at: '2026-01-01T00:00:00Z',
  identities: [{ provider: 'google-oauth2', user_id: '1', connection: 'google-oauth2' }], app_metadata: { tenant_id: 'personal' } };
const newer: Profile = { user_id: 'auth0|2', email: 'amy@example.test', email_verified: true, created_at: '2026-11-17T00:00:00Z',
  identities: [{ provider: 'auth0', user_id: '2', connection: 'Username-Password-Authentication' }], app_metadata: {} };
const notVerified = '请先验证邮箱，再连接 EIGOS。', notLinked = '合并没有完成，请用原来的方式重新登录。';

/** A Post-Login event for `user`; the default request asks for the EIGOS API, as an agent connecting to /mcp does. */
const login = (user: Profile, extra: Claims = {}) => ({ user, secrets, transaction: { protocol: 'oidc-basic-profile' }, request: { query: {} },
  resource_server: { identifier: 'https://eigos.example/mcp' }, ...extra });

/**
 * Records what the Action does to Auth0's `api`. `token` is what validateToken returns (it throws without one),
 * and `order` collects the calls whose order matters.
 */
function fakeApi(token?: Claims, order: string[] = []) {
  const calls = { deny: [] as string[], idToken: {} as Claims, accessToken: {} as Claims, metadata: [] as Array<[string, unknown]>,
    redirects: [] as Array<{ url: string; options: unknown }>, encoded: [] as unknown[], validated: [] as unknown[], primary: [] as string[] };
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
      set: (key: string, value: string, options?: { ttl?: number }) => { cache.set(key, { value, ttl: options?.ttl }); return { type: 'success' }; },
    },
  };
  return { api, calls, cache };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Stands in for the Auth0 tenant: the token endpoint and the three Management API calls the Action makes. */
function fakeManagement(users: Profile[], options: { expiresIn?: number; tokenStatus?: number; searchStatus?: number; linkStatus?: number } = {}, order: string[] = []) {
  const { expiresIn = 86400, tokenStatus = 200, searchStatus = 200, linkStatus = 201 } = options;
  const requests: Array<{ method: string; path: string; query: Record<string, string>; body: unknown; authorization: string | null }> = [];
  const links: Array<{ primary: string; body: unknown }> = [];
  const fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input), method = init.method ?? 'GET', authorization = new Headers(init.headers).get('authorization');
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, authorization });
    assert.equal(url.origin, 'https://tenant.example');
    if (url.pathname === '/oauth/token') return tokenStatus === 200 ? json({ access_token: 'management-token', token_type: 'Bearer', expires_in: expiresIn }) : json({ error: 'server_error' }, tokenStatus);
    if (authorization !== 'Bearer management-token') return json({ message: 'Unauthorized' }, 401);
    if (url.pathname === '/api/v2/users-by-email') {
      return searchStatus === 200 ? json(users.filter(user => user.email === url.searchParams.get('email'))) : json({ message: 'Unavailable' }, searchStatus);
    }
    const match = /^\/api\/v2\/users\/([^/]+)(\/identities)?$/.exec(url.pathname);
    if (!match) return json({ message: 'Not found' }, 404);
    const id = decodeURIComponent(match[1]!), user = users.find(candidate => candidate.user_id === id);
    if (method === 'POST' && match[2]) { links.push({ primary: id, body }); order.push('link'); return json(user?.identities ?? [], linkStatus); }
    return method === 'GET' && !match[2] && user ? json(user) : json({ message: 'The user does not exist.' }, 404);
  };
  return { fetch, requests, links };
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
  const claims = async (user: Profile, overrides: Record<string, string> = {}) => {
    const { api, calls } = fakeApi();
    await createPostLogin({ fetch: fakeManagement([user]).fetch }).onExecutePostLogin(login(user, { secrets: { ...secrets, ...overrides } }), api);
    return calls;
  };
  // A managed tenant goes into both tokens as it is, and nothing is written back.
  let calls = await claims({ ...older, app_metadata: { tenant_id: 'org-7' } });
  assert.deepEqual([calls.idToken, calls.accessToken, calls.metadata, calls.deny], [{ tenant_id: 'org-7' }, { tenant_id: 'org-7' }, [], []]);
  // A new user gets DEFAULT_TENANT, and it is stored so that it stays the same from now on.
  calls = await claims({ ...older, app_metadata: {} });
  assert.deepEqual([calls.idToken, calls.accessToken, calls.metadata], [{ tenant_id: 'personal' }, { tenant_id: 'personal' }, [['tenant_id', 'personal']]]);
  // An empty value is not a tenant.
  calls = await claims({ ...older, app_metadata: { tenant_id: '' } });
  assert.deepEqual([calls.idToken, calls.metadata], [{ tenant_id: 'personal' }, [['tenant_id', 'personal']]]);
  // The claim name and the metadata key are configurable.
  const names = { TENANT_CLAIM: 'https://eigos.example/tenant', TENANT_METADATA_KEY: 'eigos_tenant' };
  calls = await claims({ ...older, app_metadata: { eigos_tenant: 'org-7', tenant_id: 'ignored' } }, names);
  assert.deepEqual([calls.idToken, calls.accessToken, calls.metadata], [{ [names.TENANT_CLAIM]: 'org-7' }, { [names.TENANT_CLAIM]: 'org-7' }, []]);
  calls = await claims({ ...older, app_metadata: {} }, names);
  assert.deepEqual(calls.metadata, [['eigos_tenant', 'personal']]);
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

  // With several candidates the earliest verified account is the primary, wherever it sits in the result.
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

test('no link redirect for unverified duplicates, refresh tokens or the link verification login', async () => {
  const unverifiedNewer = { ...newer, email_verified: false };
  const linked = { ...newer, identities: [...newer.identities, { provider: 'google-oauth2', user_id: '3', connection: 'google-oauth2' }] };
  const cases: Array<{ name: string; user: Profile; users: Profile[]; extra?: Claims; lookup: boolean; accessToken: boolean }> = [
    { name: 'the older duplicate has not verified its email', user: newer, users: [{ ...older, email_verified: false }, newer], lookup: true, accessToken: true },
    { name: 'the new account has not verified its email and only asks for an ID token', user: unverifiedNewer, users: [older, unverifiedNewer],
      extra: { resource_server: undefined }, lookup: false, accessToken: false },
    { name: 'a refresh token exchange', user: newer, users: [older, newer], extra: { transaction: { protocol: 'oauth2-refresh-token' } }, lookup: false, accessToken: true },
    { name: 'the link verification login', user: newer, users: [older, newer], extra: { request: { query: { eigos_link: '1' } } }, lookup: false, accessToken: true },
    { name: 'an account that already has several identities', user: linked, users: [older, linked], lookup: false, accessToken: true },
  ];
  for (const { name, user, users, extra, lookup, accessToken } of cases) {
    const { api, calls } = fakeApi(), management = fakeManagement(users);
    await createPostLogin({ fetch: management.fetch }).onExecutePostLogin(login(user, extra), api);
    assert.deepEqual(calls.redirects, [], name);
    assert.deepEqual(calls.deny, [], name);
    assert.deepEqual(calls.idToken, { tenant_id: 'personal' }, name);
    assert.deepEqual(calls.accessToken, accessToken ? { tenant_id: 'personal' } : {}, name);
    // Only the first case gets as far as looking for duplicates, and finds none it may use.
    assert.equal(management.requests.some(request => request.path === '/api/v2/users-by-email'), lookup, name);
  }
});

test('continue links the identity into the verified primary and switches the login', async () => {
  const order: string[] = [], { api, calls } = fakeApi({ primary: 'google-oauth2|1' }, order), management = fakeManagement([older, newer], {}, order);
  await createPostLogin({ fetch: management.fetch }).onContinuePostLogin(login(newer), api);
  assert.deepEqual(calls.validated, [{ secret: secrets.LINK_SECRET, tokenParameterName: 'session_token' }]);
  assert.deepEqual(management.requests.map(request => `${request.method} ${request.path}`), [
    'POST /oauth/token', 'GET /api/v2/users/google-oauth2%7C1', 'POST /api/v2/users/google-oauth2%7C1/identities']);
  assert.deepEqual(management.links, [{ primary: 'google-oauth2|1', body: { provider: 'auth0', user_id: '2' } }]);
  assert.deepEqual(calls.primary, ['google-oauth2|1']);
  // Auth0 only accepts the new primary once the identity is linked to it.
  assert.deepEqual(order, ['link', 'setPrimaryUser']);
  assert.deepEqual([calls.idToken, calls.accessToken, calls.deny], [{ tenant_id: 'personal' }, { tenant_id: 'personal' }, []]);

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

test('continue refuses a primary with a different or unverified email', async () => {
  const toOlder = { primary: older.user_id }, unverifiedNewer = { ...newer, email_verified: false };
  const refusals: Array<[string, Profile, Profile[], Claims | undefined]> = [
    ['a different email', newer, [{ ...older, email: 'someone-else@example.test' }, newer], toOlder],
    ['an unverified email', newer, [{ ...older, email_verified: false }, newer], toOlder],
    ['a primary that is not older than the current user', newer, [{ ...older, created_at: '2026-12-01T00:00:00Z' }, newer], toOlder],
    ['a primary that does not exist', newer, [newer], toOlder],
    ['a current user who has not verified their email', unverifiedNewer, [older, unverifiedNewer], toOlder],
    ['a token without a primary', newer, [older, newer], {}],
    ['a token that does not validate', newer, [older, newer], undefined],
  ];
  for (const [name, user, users, token] of refusals) {
    const { api, calls } = fakeApi(token), management = fakeManagement(users);
    await createPostLogin({ fetch: management.fetch }).onContinuePostLogin(login(user), api);
    assert.deepEqual(calls.deny, [notLinked], name);
    assert.deepEqual(management.links, [], name);
    assert.deepEqual(calls.primary, [], name);
    assert.deepEqual([calls.idToken, calls.accessToken], [{}, {}], name);
  }
});

test('continue refuses when the Management API cannot link the identity', async () => {
  const { api, calls } = fakeApi({ primary: 'google-oauth2|1' }), management = fakeManagement([older, newer], { linkStatus: 409 });
  await createPostLogin({ fetch: management.fetch }).onContinuePostLogin(login(newer), api);
  assert.deepEqual(management.links, [{ primary: 'google-oauth2|1', body: { provider: 'auth0', user_id: '2' } }]);
  assert.deepEqual(calls.deny, [notLinked]);
  assert.deepEqual([calls.primary, calls.idToken, calls.accessToken], [[], {}, {}]);
});

test('the Management token is cached until a minute before it expires', async () => {
  const tokenRequests = (management: ReturnType<typeof fakeManagement>) => management.requests.filter(request => request.path === '/oauth/token').length;
  const { api, cache } = fakeApi(), management = fakeManagement([older, newer], { expiresIn: 3600 });
  const { onExecutePostLogin } = createPostLogin({ fetch: management.fetch });
  await onExecutePostLogin(login(newer), api);
  await onExecutePostLogin(login(newer), api);
  assert.equal(tokenRequests(management), 1);
  assert.equal(management.requests.filter(request => request.path === '/api/v2/users-by-email').length, 2);
  assert.deepEqual([...cache.values()], [{ value: 'management-token', ttl: (3600 - 60) * 1000 }]);

  // A token that would be expired by then is not worth keeping.
  const short = fakeApi(), brief = fakeManagement([older, newer], { expiresIn: 30 });
  await createPostLogin({ fetch: brief.fetch }).onExecutePostLogin(login(newer), short.api);
  await createPostLogin({ fetch: brief.fetch }).onExecutePostLogin(login(newer), short.api);
  assert.equal(short.cache.size, 0);
  assert.equal(tokenRequests(brief), 2);
});

test('a failure while checking for duplicates or a missing secret stops the login before any claim is written', async () => {
  const failures: Array<[string, ReturnType<typeof fakeManagement>, Record<string, string | undefined>, RegExp]> = [
    ['the token request fails', fakeManagement([older, newer], { tokenStatus: 500 }), {}, /token request failed with status 500/],
    ['the duplicate lookup fails', fakeManagement([older, newer], { searchStatus: 500 }), {}, /users-by-email request failed with status 500/],
    ['DEFAULT_TENANT is not set', fakeManagement([newer]), { DEFAULT_TENANT: undefined }, /DEFAULT_TENANT/],
    ['the Management credentials are not set', fakeManagement([newer]), { MANAGEMENT_CLIENT_SECRET: undefined }, /MANAGEMENT_CLIENT_SECRET/],
  ];
  for (const [name, management, overrides, message] of failures) {
    const { api, calls } = fakeApi();
    await assert.rejects(createPostLogin({ fetch: management.fetch }).onExecutePostLogin(login(newer, { secrets: { ...secrets, ...overrides } }), api), message, name);
    assert.deepEqual([calls.idToken, calls.accessToken, calls.redirects, calls.deny], [{}, {}, [], []], name);
  }
});
