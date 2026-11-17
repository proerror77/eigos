import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { auth0AccountLogin } from '../apps/gateway/account-portal.js';
import { createApp } from '../apps/gateway/app.js';
import { jwtVerifier } from '../apps/gateway/auth.js';
import { readConfig, type Config } from '../packages/core/config.js';
import { digest } from '../packages/core/identity.js';
import { Accounts, type SignupMode } from '../packages/runtime/accounts.js';
import { portalEnv } from './account-env.js';
import type { fixture } from './fixture.js';

export type Fixture = Awaited<ReturnType<typeof fixture>>;
export type CallbackOutcome = { location: string | null; cookie: string; response: Response; replay: Response };
export interface AccountGateway {
  url: string; config: Config; accounts: Accounts;
  owner(sub: string): string;
  token(sub: string, options?: { azp?: string; aud?: string; scope?: string; issuedAt?: number }): Promise<string>;
  login(sub: string, email: string, options?: { verified?: boolean; tenant?: boolean; wrongState?: boolean; start?: string; startCookie?: string }):
    Promise<CallbackOutcome>;
  /**
   * Auth0 sends the browser back to /account/callback for the authorize request `authorize`, with a fresh code that it issues for
   * `sub`. `cookie` is the login cookie (name and value) the browser holds. This is the second half of `login`; calling it alone
   * stands for a login that Auth0 paused and resumes later.
   */
  callback(authorize: URL, cookie: string, sub: string, email: string, options?: { verified?: boolean; tenant?: boolean; wrongState?: boolean }):
    Promise<CallbackOutcome>;
  form(path: string, cookie: string, body?: URLSearchParams, origin?: string): Promise<Response>;
  call(path: string, accessToken?: string): Promise<Response>;
  page(cookie: string): Promise<string>;
  close(): Promise<void>;
}

type Identity = { sub: string; email: string; verified: boolean; tenant: boolean; nonce: string; challenge: string };
const responseCookie = (response: Response, name: string) =>
  response.headers.getSetCookie().find(value => value.startsWith(name + '='))?.split(';')[0] ?? '';

/**
 * The real Gateway on a loopback port, with the account portal logging in against a fake Auth0:
 * issuer https://identity.example/, PUBLIC_URL https://127.0.0.1, MCP audience https://127.0.0.1/mcp, tenant `personal`,
 * clients `portal`, `grok` and `existing-client`. `signup` sets EIGOS_SIGNUP and `env` adds or overrides variables.
 * The caller closes the fixture; `close()` only stops the server.
 */
export async function accountGateway(f: Fixture, options: { signup?: SignupMode; env?: Record<string, string> } = {}): Promise<AccountGateway> {
  const config = readConfig({ ...portalEnv, ...(options.signup ? { EIGOS_SIGNUP: options.signup } : {}), ...options.env });
  const issuer = config.OAUTH_ISSUER!, publicUrl = config.PUBLIC_URL, audience = publicUrl + '/mcp', tenant = 'personal';
  const owner = (sub: string) => digest([issuer, tenant, sub]);
  const key = await generateKeyPair('RS256'), jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(key.publicKey), kid: 'test' }] });
  const sign = (claims: Record<string, unknown>, sub: string, aud: string, issuedAt = Math.floor(Date.now() / 1000)) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(issuer).setSubject(sub).setAudience(aud).setIssuedAt(issuedAt).setExpirationTime('15m').sign(key.privateKey);
  // Every login gets its own code, and like Auth0 the fake honours a code once.
  const codes = new Map<string, Identity>();
  // The portal answers any failed exchange with ?status=login. Keep the first failed assertion so `login` can show it.
  let mismatch: unknown;
  const exchange: typeof fetch = async (input, init) => {
    try {
      assert.equal(String(input), issuer + 'oauth/token');
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('client_id'), 'portal');
      assert.equal(body.get('client_secret'), 'synthetic-portal-secret');
      assert.equal(body.get('redirect_uri'), publicUrl + '/account/callback');
      const code = body.get('code') ?? '', identity = codes.get(code);
      codes.delete(code);
      if (!identity) return Response.json({ error: 'invalid_grant', error_description: 'Invalid authorization code' }, { status: 400 });
      assert.equal(createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url'), identity.challenge);
      const claims = { ...(identity.tenant ? { [config.OAUTH_TENANT_CLAIM]: tenant } : {}),
        email: identity.email, email_verified: identity.verified, nonce: identity.nonce };
      return Response.json({ id_token: await sign(claims, identity.sub, 'portal') });
    } catch (error) { mismatch ??= error; throw error; }
  };
  const accounts = new Accounts(f.db, config.EIGOS_SIGNUP);
  const gateway = createApp(config, f.db, f.source, jwtVerifier(issuer, publicUrl, jwks, config.OAUTH_TENANT_CLAIM, audience), {},
    { accountLogin: auth0AccountLogin(config, exchange, jwks) });
  const server = gateway.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = 'http://127.0.0.1:' + address.port;
  const callback: AccountGateway['callback'] = async (authorize, loginCookie, sub, email, o = {}) => {
    const code = 'code-' + randomUUID();
    codes.set(code, { sub, email, verified: o.verified ?? true, tenant: o.tenant ?? true,
      nonce: authorize.searchParams.get('nonce')!, challenge: authorize.searchParams.get('code_challenge')! });
    const target = url + '/account/callback?code=' + code + '&state=' + (o.wrongState ? 'wrong' : authorize.searchParams.get('state'));
    const response = await fetch(target, { redirect: 'manual', headers: { Cookie: loginCookie } });
    const replay = await fetch(target, { redirect: 'manual', headers: { Cookie: loginCookie } });
    if (mismatch) throw mismatch;
    if (o.wrongState) assert(codes.has(code), 'a callback with the wrong state must not exchange the code');
    assert.equal(replay.headers.get('location'), '/account?status=login');
    return { location: response.headers.get('location'), cookie: responseCookie(response, '__Host-eigos-account'), response, replay };
  };
  return {
    url, config, accounts, owner, callback,
    token: (sub, o = {}) => sign({ [config.OAUTH_TENANT_CLAIM]: tenant, azp: o.azp ?? 'grok', scope: o.scope ?? 'tasks:read tasks:write ontology:write' },
      sub, o.aud ?? audience, o.issuedAt),
    async login(sub, email, o = {}) {
      const start = await fetch(url + (o.start ?? '/account/login?signup=1'),
        { redirect: 'manual', headers: o.startCookie ? { Cookie: o.startCookie } : {} });
      const authorize = new URL(start.headers.get('location')!);
      assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
      if (!o.start) assert.equal(authorize.searchParams.get('screen_hint'), 'signup');
      const loginCookie = responseCookie(start, '__Host-eigos-account-login');
      assert(loginCookie);
      return callback(authorize, loginCookie, sub, email, o);
    },
    form: (path, cookie, body = new URLSearchParams(), origin = publicUrl) =>
      fetch(url + '/account/' + path, { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body, redirect: 'manual' }),
    call: (path, accessToken) => fetch(url + path, { headers: accessToken ? { Authorization: 'Bearer ' + accessToken } : {} }),
    page: async cookie => (await fetch(url + '/account', { headers: { Cookie: cookie } })).text(),
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
