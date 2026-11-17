'use strict';

/**
 * EIGOS Post-Login Action: verified email, tenant claim and same-email account linking.
 *
 * Deployed to Auth0 by an operator; nothing in the gateway imports it. It runs on Auth0's Node 22 with the
 * global fetch and uses no npm package. Every setting is an Action secret:
 *
 *   EIGOS_AUDIENCES                 comma separated API identifiers that mean "an EIGOS API token is requested"
 *   TENANT_CLAIM                    claim name written to the tokens (default tenant_id)
 *   TENANT_METADATA_KEY             app_metadata key that holds a user's tenant (default tenant_id)
 *   DEFAULT_TENANT                  tenant of a user who has none yet
 *   LINK_URL                        https://<gateway>/account/link
 *   LINK_SECRET                     the gateway's EIGOS_ACCOUNT_LINK_SECRET
 *   MANAGEMENT_DOMAIN, MANAGEMENT_CLIENT_ID, MANAGEMENT_CLIENT_SECRET
 *                                   a machine-to-machine client granted read:users and update:users
 *
 * An unfinished check or merge never ends in a tenant claim: failures throw or deny, and the claims are written
 * last, so a token without the claim is the only thing that can come out of a half-done login.
 *
 * Auth0 behavior this relies on (Post-Login API object and redirect documentation):
 * - api.cache.set takes ttl in milliseconds; api.redirect.encodeToken takes expiresInSeconds in seconds.
 * - api.redirect.validateToken returns the token's payload, and onContinuePostLogin only runs for a login this
 *   Action paused with sendUserTo.
 * - api.authentication.setPrimaryUser only works after the login's identity is linked to that user.
 * - api.access.deny does not undo api.user.setAppMetadata (which is batched), so the email check comes first.
 */

const NOT_VERIFIED = '请先验证邮箱，再连接 EIGOS。';
const NOT_LINKED = '合并没有完成，请用原来的方式重新登录。';
const LINK_TOKEN_SECONDS = 300;
const TOKEN_MARGIN_SECONDS = 60;

function createPostLogin({ fetch }) {
  const secret = (event, name) => {
    const value = event.secrets?.[name];
    if (!value) throw new Error(`The Action secret ${name} is not set`);
    return value;
  };
  const claimName = event => event.secrets?.TENANT_CLAIM || 'tenant_id';
  const metadataKey = event => event.secrets?.TENANT_METADATA_KEY || 'tenant_id';
  const isEigosApi = event => secret(event, 'EIGOS_AUDIENCES').split(',').map(entry => entry.trim()).filter(Boolean)
    .includes(event.resource_server?.identifier);
  const managedTenant = (appMetadata, key) => {
    const value = appMetadata?.[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const sameEmail = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const earlier = (a, b) => Date.parse(a) < Date.parse(b);
  const refuse = api => { api.access.deny(NOT_LINKED); };

  const writeClaims = (event, api, tenant, eigosApi) => {
    api.idToken.setCustomClaim(claimName(event), tenant);
    if (eigosApi) api.accessToken.setCustomClaim(claimName(event), tenant);
  };

  /** A client-credentials token for the Management API, cached until a minute before it expires. */
  const managementToken = async (event, api) => {
    const domain = secret(event, 'MANAGEMENT_DOMAIN'), clientId = secret(event, 'MANAGEMENT_CLIENT_ID');
    const cacheKey = `management-token:${domain}:${clientId}`;
    const cached = api.cache.get(cacheKey)?.value;
    if (cached) return cached;
    const response = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId,
        client_secret: secret(event, 'MANAGEMENT_CLIENT_SECRET'), audience: `https://${domain}/api/v2/` }),
    });
    if (!response.ok) throw new Error(`Auth0 token request failed with status ${response.status}`);
    const { access_token: token, expires_in: expiresIn } = await response.json();
    if (typeof token !== 'string' || token === '') throw new Error('Auth0 token response has no access_token');
    const ttl = (expiresIn - TOKEN_MARGIN_SECONDS) * 1000;
    if (ttl > 0) api.cache.set(cacheKey, token, { ttl });
    return token;
  };

  const management = async (event, api, method, path, body) => {
    const token = await managementToken(event, api);
    return fetch(`https://${secret(event, 'MANAGEMENT_DOMAIN')}${path}`, {
      method,
      headers: body === undefined ? { authorization: `Bearer ${token}` } : { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  /** The earliest created, verified account that shares the user's email, if there is one. */
  const olderDuplicate = async (event, api) => {
    const response = await management(event, api, 'GET', `/api/v2/users-by-email?email=${encodeURIComponent(event.user.email)}`);
    if (!response.ok) throw new Error(`Auth0 users-by-email request failed with status ${response.status}`);
    const users = await response.json();
    if (!Array.isArray(users)) throw new Error('Auth0 users-by-email response is not a list');
    return users
      .filter(user => user.user_id !== event.user.user_id && user.email_verified === true && earlier(user.created_at, event.user.created_at))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
  };

  const onExecutePostLogin = async (event, api) => {
    const eigosApi = isEigosApi(event);
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

    // A verified account that signs in through a second connection must merge into the older verified one instead of
    // becoming another account. Refresh exchanges cannot redirect, and the link verification login is the older
    // account signing in again, so neither looks for duplicates.
    const looksForDuplicates = event.transaction?.protocol !== 'oauth2-refresh-token' && event.request?.query?.eigos_link !== '1'
      && event.user.email_verified === true && event.user.identities.length === 1;
    const older = looksForDuplicates ? await olderDuplicate(event, api) : undefined;
    if (older) {
      api.redirect.sendUserTo(secret(event, 'LINK_URL'), { query: { session_token: api.redirect.encodeToken({
        secret: secret(event, 'LINK_SECRET'), expiresInSeconds: LINK_TOKEN_SECONDS,
        payload: { primary: older.user_id, connection: older.identities[0].connection } }) } });
      return;
    }

    writeClaims(event, api, tenant, eigosApi);
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
    if (!primary || primary.email_verified !== true || !sameEmail(primary.email, event.user.email) || !earlier(primary.created_at, event.user.created_at)) {
      return refuse(api);
    }

    // Everything that can be misconfigured is read before the accounts are changed.
    const eigosApi = isEigosApi(event);
    const tenant = managedTenant(primary.app_metadata, metadataKey(event)) ?? secret(event, 'DEFAULT_TENANT');

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
