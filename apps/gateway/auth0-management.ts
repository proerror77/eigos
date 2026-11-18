import { z } from 'zod';
import type { Config } from '../../packages/core/config.js';

/** What the account portal asks of the Auth0 Management API. The client behind it needs the `update:users` scope. */
export interface Auth0Management {
  /**
   * Has Auth0 send the verification email of the Auth0 user `subject` again, for the member portal client, so that its link leads back to
   * the portal. The portal logs the message of a plain `Error` that this rejects with, so such a message names no token, secret or user.
   */
  resendVerification(subject: string): Promise<void>;
}

const tokenAnswer = z.object({ access_token: z.string().min(1), expires_in: z.number() });
const marginSeconds = 60, timeoutMs = 10_000;

/**
 * The Management API client of the portal, or undefined unless OAUTH_MANAGEMENT_CLIENT_ID and OAUTH_MANAGEMENT_CLIENT_SECRET are set
 * (and with them the member portal client that the portal settings already require). Every request goes to OAUTH_MANAGEMENT_DOMAIN
 * when that is set, and to OAUTH_ISSUER otherwise: under an Auth0 custom domain the issuer is the custom domain, but the Management API
 * and its audience stay on the tenant's own domain. The token is cached until a minute before it expires. A failure says only the
 * HTTP status or that an answer was not usable: the token, the client secret, the user and Auth0's own wording never appear in an error.
 */
export function auth0Management(config: Config, fetcher: typeof fetch = fetch): Auth0Management | undefined {
  const { OAUTH_ISSUER: issuer, OAUTH_MANAGEMENT_DOMAIN: domain, OAUTH_MEMBER_CLIENT_ID: memberClient,
    OAUTH_MANAGEMENT_CLIENT_ID: clientId, OAUTH_MANAGEMENT_CLIENT_SECRET: clientSecret } = config;
  const base = domain ? `https://${domain}/` : issuer;
  if (!base || !memberClient || !clientId || !clientSecret) return undefined;
  const audience = new URL('api/v2/', base).href;
  // A request never follows a redirect, because the token and the secret travel in it, and never waits for Auth0 for long.
  const send = (path: string, headers: Record<string, string>, body: unknown) => fetcher(new URL(path, base), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  let held: { token: string; until: number } | undefined, pending: Promise<string> | undefined;

  const requestToken = async () => {
    const response = await send('oauth/token', {}, { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, audience });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Auth0 token request failed with status ${response.status}`); }
    const answer = tokenAnswer.safeParse(await response.json().catch(() => undefined));
    if (!answer.success) throw new Error('Auth0 token answer is not usable');
    const seconds = answer.data.expires_in - marginSeconds;
    if (seconds > 0) held = { token: answer.data.access_token, until: Date.now() + seconds * 1000 };
    return answer.data.access_token;
  };
  // Requests that arrive while a token is on its way wait for that token instead of asking for another.
  const token = () => held && Date.now() < held.until ? Promise.resolve(held.token)
    : pending ??= requestToken().finally(() => { pending = undefined; });

  return {
    async resendVerification(subject) {
      const response = await send('api/v2/jobs/verification-email', { Authorization: `Bearer ${await token()}` },
        { user_id: subject, client_id: memberClient });
      await response.body?.cancel();
      // A token that Auth0 rejects is dropped, so that the next request asks for a new one instead of waiting for the old one to expire.
      if (response.status === 401) held = undefined;
      if (!response.ok) throw new Error(`Auth0 verification email request failed with status ${response.status}`);
    },
  };
}
