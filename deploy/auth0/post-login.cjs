'use strict';

/**
 * EIGOS Post-Login Action: verified email, tenant claim and same-email account linking.
 *
 * Deployed to Auth0 by an operator; nothing in the gateway imports it. It runs on Auth0's Node 22 with the
 * global fetch and uses no npm package. Every setting is an Action secret:
 *
 *   EIGOS_AUDIENCES                 comma separated API identifiers that mean "an EIGOS API token is requested"
 *   EIGOS_CLIENT_IDS                comma separated client IDs of the EIGOS applications: the account portal, Grok, …
 *   EIGOS_CONNECTIONS               comma separated connections the account portal signs in with, for example
 *                                   Username-Password-Authentication,google-oauth2
 *   TENANT_CLAIM                    claim name written to the tokens (default tenant_id)
 *   TENANT_METADATA_KEY             app_metadata key that holds a user's tenant (default tenant_id)
 *   DEFAULT_TENANT                  tenant of a user who has none yet
 *   LINK_URL                        https://<gateway>/account/link
 *   LINK_SECRET                     the gateway's EIGOS_ACCOUNT_LINK_SECRET
 *   MANAGEMENT_DOMAIN, MANAGEMENT_CLIENT_ID, MANAGEMENT_CLIENT_SECRET
 *                                   a machine-to-machine client granted read:users and update:users
 *
 * Only EIGOS logins are touched: a login that asks for an EIGOS API or comes from an EIGOS client. Every other application of
 * the tenant gets nothing from this Action, no metadata, lookup, redirect or claim, so its tenant claim stays with whatever
 * Action it has. A missing or empty list fails the login, because without it no login can be told apart.
 *
 * The account another login of the same verified email merges into is the one that became an EIGOS account first. A verified
 * user is stamped with app_metadata.eigos_since once, when it first gets EIGOS claims, and the stamp never moves. Candidates rank
 * stamped before unstamped, the earlier stamp first, then the earlier created_at. Creation time alone is not enough: an address can
 * be verified long after the account was created, by its owner or by whoever pre-registered it.
 *
 * An unfinished check or merge never ends in a tenant claim: failures throw or deny, and the claims are written
 * last, so a token without the claim is the only thing that can come out of a half-done login.
 *
 * Auth0 behavior this relies on (Post-Login API object and redirect documentation):
 * - api.cache.set takes ttl in milliseconds and a key of at most 64 bytes; a refused write is returned as
 *   { type: 'error' } instead of thrown. api.cache.delete removes a key. api.redirect.encodeToken takes expiresInSeconds in seconds.
 * - api.redirect.validateToken returns the token's payload, and onContinuePostLogin only runs for a login this
 *   Action paused with sendUserTo.
 * - api.authentication.setPrimaryUser only works after the login's identity is linked to that user.
 * - api.access.deny does not undo api.user.setAppMetadata (which is batched), so the email check comes first.
 * - PATCH /api/v2/users/{id} merges the top-level keys of app_metadata, so a stamp leaves the other keys alone.
 */

const NOT_VERIFIED = '请先验证邮箱，再连接 EIGOS。';
const NOT_LINKED = '合并没有完成，请用原来的方式重新登录。';
const LINK_TOKEN_SECONDS = 300;
const TOKEN_MARGIN_SECONDS = 60;
// Auth0 caps a cache key at 64 bytes, which a key built from the domain and the 32 character client id easily passes.
// One Action serves one tenant and one machine-to-machine client, so a short fixed key says enough.
const TOKEN_CACHE_KEY = 'eigos-mgmt-token';
// When the user first got EIGOS claims, as an ISO time in app_metadata.
const STAMP_KEY = 'eigos_since';

function createPostLogin({ fetch, now = Date.now }) {
  const secret = (event, name) => {
    const value = event.secrets?.[name];
    if (!value) throw new Error(`The Action secret ${name} is not set`);
    return value;
  };
  /** A comma separated secret. One that lists nothing is as good as missing. */
  const list = (event, name) => {
    const entries = secret(event, name).split(',').map(entry => entry.trim()).filter(Boolean);
    if (entries.length === 0) throw new Error(`The Action secret ${name} is not set`);
    return entries;
  };
  const claimName = event => event.secrets?.TENANT_CLAIM || 'tenant_id';
  const metadataKey = event => event.secrets?.TENANT_METADATA_KEY || 'tenant_id';
  const isEigosApi = event => list(event, 'EIGOS_AUDIENCES').includes(event.resource_server?.identifier);
  const isEigosClient = event => list(event, 'EIGOS_CLIENT_IDS').includes(event.client?.client_id);
  const managedTenant = (appMetadata, key) => {
    const value = appMetadata?.[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const sameEmail = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const refuse = api => { api.access.deny(NOT_LINKED); };

  /** When the user first got EIGOS claims, or undefined when it never did or its stamp is not a time. */
  const eigosSince = user => {
    const value = user?.app_metadata?.[STAMP_KEY];
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? time : undefined;
  };
  /**
   * Whether account `a` ranks before account `b` as the one to keep: stamped before unstamped, the earlier stamp first, and the
   * earlier created when the stamps do not decide. A time that cannot be read never ranks first.
   */
  const ranksBefore = (a, b) => {
    const sinceA = eigosSince(a), sinceB = eigosSince(b);
    if (sinceA !== sinceB) {
      if (sinceA === undefined) return false;
      if (sinceB === undefined) return true;
      return sinceA < sinceB;
    }
    return Date.parse(a.created_at) < Date.parse(b.created_at);
  };
  /** The connection out of `connections` that the account portal can ask `user` to sign in with, if it has one. */
  const portalConnection = (user, connections) =>
    (Array.isArray(user?.identities) ? user.identities : []).map(identity => identity?.connection).find(connection => connections.includes(connection));

  const writeClaims = (event, api, tenant, eigosApi) => {
    api.idToken.setCustomClaim(claimName(event), tenant);
    if (eigosApi) api.accessToken.setCustomClaim(claimName(event), tenant);
  };

  /** A client-credentials token for the Management API, cached until a minute before it expires. */
  const newManagementToken = async (event, api) => {
    const domain = secret(event, 'MANAGEMENT_DOMAIN');
    const response = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: secret(event, 'MANAGEMENT_CLIENT_ID'),
        client_secret: secret(event, 'MANAGEMENT_CLIENT_SECRET'), audience: `https://${domain}/api/v2/` }),
    });
    if (!response.ok) throw new Error(`Auth0 token request failed with status ${response.status}`);
    const { access_token: token, expires_in: expiresIn } = await response.json();
    if (typeof token !== 'string' || token === '') throw new Error('Auth0 token response has no access_token');
    const ttl = (expiresIn - TOKEN_MARGIN_SECONDS) * 1000;
    if (ttl > 0) api.cache.set(TOKEN_CACHE_KEY, token, { ttl });
    return token;
  };

  /**
   * A Management API request. A cached token can stop working before it expires, for example after the signing keys rotate, and
   * Auth0 then answers 401. A refused token is dropped, so that no later login reuses it, and a request that used a cached token
   * is sent once more with a new one.
   */
  const management = async (event, api, method, path, body) => {
    const url = `https://${secret(event, 'MANAGEMENT_DOMAIN')}${path}`;
    const send = token => fetch(url, {
      method,
      headers: body === undefined ? { authorization: `Bearer ${token}` } : { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cached = api.cache.get(TOKEN_CACHE_KEY)?.value;
    let response = await send(cached || await newManagementToken(event, api));
    if (response.status === 401) {
      api.cache.delete(TOKEN_CACHE_KEY);
      if (cached) {
        response = await send(await newManagementToken(event, api));
        if (response.status === 401) api.cache.delete(TOKEN_CACHE_KEY);
      }
    }
    return response;
  };

  /** The verified account with the user's email that ranks first, if it ranks before the user and the portal can sign in to it. */
  const primaryFor = async (event, api, connections) => {
    const response = await management(event, api, 'GET', `/api/v2/users-by-email?email=${encodeURIComponent(event.user.email)}`);
    if (!response.ok) throw new Error(`Auth0 users-by-email request failed with status ${response.status}`);
    const users = await response.json();
    if (!Array.isArray(users)) throw new Error('Auth0 users-by-email response is not a list');
    return users
      .filter(user => user.user_id !== event.user.user_id && user.email_verified === true
        && portalConnection(user, connections) !== undefined && ranksBefore(user, event.user))
      .sort((a, b) => ranksBefore(a, b) ? -1 : ranksBefore(b, a) ? 1 : 0)[0];
  };

  const onExecutePostLogin = async (event, api) => {
    const eigosApi = isEigosApi(event), eigosClient = isEigosClient(event);
    // Another application's login: nothing here is for it.
    if (!eigosApi && !eigosClient) return;
    if (eigosApi && event.user.email_verified !== true) {
      api.access.deny(NOT_VERIFIED);
      return;
    }

    const key = metadataKey(event);
    let tenant = managedTenant(event.user.app_metadata, key);
    if (tenant === undefined) {
      tenant = secret(event, 'DEFAULT_TENANT');
      api.user.setAppMetadata(key, tenant);
    }

    // A verified account that signs in through a second connection must merge into the account that ranks first instead of
    // becoming another account. Refresh exchanges cannot redirect, so they do not look for duplicates. No request parameter may
    // switch the check off, because the caller controls them: the link verification login is checked like any other, and passes
    // because it signs in as the account that ranks first, so nobody ranks before it.
    const looksForDuplicates = event.transaction?.protocol !== 'oauth2-refresh-token'
      && event.user.email_verified === true && event.user.identities.length === 1;
    const connections = looksForDuplicates ? list(event, 'EIGOS_CONNECTIONS') : [];
    const primary = looksForDuplicates ? await primaryFor(event, api, connections) : undefined;
    if (primary) {
      api.redirect.sendUserTo(secret(event, 'LINK_URL'), { query: { session_token: api.redirect.encodeToken({
        secret: secret(event, 'LINK_SECRET'), expiresInSeconds: LINK_TOKEN_SECONDS,
        payload: { primary: primary.user_id, connection: portalConnection(primary, connections) } }) } });
      return;
    }

    writeClaims(event, api, tenant, eigosApi);
    // These are the EIGOS claims of a verified user. The first ones make it an EIGOS account from now on, and later ones keep its stamp.
    if (event.user.email_verified === true && eigosSince(event.user) === undefined) {
      api.user.setAppMetadata(STAMP_KEY, new Date(now()).toISOString());
    }
  };

  const onContinuePostLogin = async (event, api) => {
    const linkSecret = secret(event, 'LINK_SECRET');
    let primaryId;
    try {
      primaryId = api.redirect.validateToken({ secret: linkSecret, tokenParameterName: 'session_token' }).primary;
    } catch {
      // An invalid, expired or missing token leaves primaryId unset and is refused below.
    }
    // Only a verified account is ever merged. The Action pauses only such logins, but the merge does not rely on that.
    if (event.user.email_verified !== true || typeof primaryId !== 'string' || primaryId === '') return refuse(api);

    const response = await management(event, api, 'GET', `/api/v2/users/${encodeURIComponent(primaryId)}`);
    const primary = response.ok ? await response.json() : undefined;
    // The same rules that chose the primary when the login was paused: verified, the same email, an account the portal can sign in
    // to, and ranked before the user who is being merged.
    if (!primary || primary.email_verified !== true || !sameEmail(primary.email, event.user.email)
      || portalConnection(primary, list(event, 'EIGOS_CONNECTIONS')) === undefined || !ranksBefore(primary, event.user)) {
      return refuse(api);
    }

    // Everything that can be misconfigured is read before the accounts are changed.
    const eigosApi = isEigosApi(event);
    const tenant = managedTenant(primary.app_metadata, metadataKey(event)) ?? secret(event, 'DEFAULT_TENANT');

    // The primary gets EIGOS claims at the end of this login. One that never had any is stamped now, before anything is linked, so a
    // failed stamp leaves both accounts as they were. The stamp goes through the Management API, because api.user changes the user
    // who signed in, and that user stops being a user of its own once it is linked.
    if (eigosSince(primary) === undefined) {
      const stamp = await management(event, api, 'PATCH', `/api/v2/users/${encodeURIComponent(primaryId)}`,
        { app_metadata: { [STAMP_KEY]: new Date(now()).toISOString() } });
      if (!stamp.ok) return refuse(api);
    }

    const identity = event.user.identities[0];
    const linked = await management(event, api, 'POST', `/api/v2/users/${encodeURIComponent(primaryId)}/identities`,
      { provider: identity.provider, user_id: identity.user_id });
    if (!linked.ok) return refuse(api);

    api.authentication.setPrimaryUser(primaryId);
    writeClaims(event, api, tenant, eigosApi);
  };

  return { onExecutePostLogin, onContinuePostLogin };
}

const action = createPostLogin({ fetch: globalThis.fetch });
exports.createPostLogin = createPostLogin;
exports.onExecutePostLogin = action.onExecutePostLogin;
exports.onContinuePostLogin = action.onContinuePostLogin;
