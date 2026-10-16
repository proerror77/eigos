import * as oidc from 'openid-client';
import { z } from 'zod';
import type { Config } from '../../../packages/core/config.js';
import type { Identity } from '../../../packages/members/store.js';
import { readTenantClaim } from '../../../packages/core/identity-claims.js';

export interface LoginAttempt { state: string; nonce: string; verifier: string }
export interface LoginProvider {
  start(): Promise<LoginAttempt & { url: URL }>;
  finish(url: URL, attempt: LoginAttempt): Promise<Identity>;
}
const identityClaims = z.object({
  iss: z.url(), sub: z.string().min(1),
  name: z.string().optional(), email: z.email().optional(), email_verified: z.boolean().optional(),
});

export function createLoginProvider(c: Config): LoginProvider | undefined {
  if (!c.OIDC_CLIENT_ID || !c.OAUTH_ISSUER) return;
  // Discovery is lazy; the gateway still starts and rejects unregistered members when login is unavailable.
  let configuration: Promise<oidc.Configuration> | undefined;
  const discover = () => {
    if (!configuration) {
      configuration = oidc.discovery(new URL(c.OAUTH_ISSUER!), c.OIDC_CLIENT_ID!, undefined,
        c.OIDC_CLIENT_SECRET ? oidc.ClientSecretPost(c.OIDC_CLIENT_SECRET) : oidc.None(), { timeout: 10 }).then(config => {
          const metadata = config.serverMetadata();
          for (const url of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
            if (!url || new URL(url).protocol !== 'https:') throw new Error('OIDC endpoints must use HTTPS');
          }
          return config;
        });
      void configuration.catch(() => { configuration = undefined; });
    }
    return configuration;
  };
  return oidcLoginProvider(discover, `${c.PUBLIC_URL}/members/callback`, c.OAUTH_TENANT_CLAIM);
}

// The injected discovery function is also used by the local signed-token identity-provider fixture.
export function oidcLoginProvider(discover: () => Promise<oidc.Configuration>, redirectUri: string, tenantClaim = 'tenant_id'): LoginProvider {
  return {
    async start() {
      const config = await discover();
      const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri, scope: 'openid profile email', state, nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      });
      return { url, state, nonce, verifier };
    },
    async finish(url, attempt) {
      const config = await discover();
      oidc.enableNonRepudiationChecks(config);
      const tokens = await oidc.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: attempt.verifier, expectedState: attempt.state, expectedNonce: attempt.nonce, idTokenExpected: true,
      });
      const signedClaims = tokens.claims();
      const claims = identityClaims.parse(signedClaims);
      // Keep only validated identity fields; upstream tokens never enter sessions, tasks, logs or HTML.
      return {
        issuer: claims.iss, subject: claims.sub, tenant: readTenantClaim(signedClaims, tenantClaim),
        ...(claims.name ? { displayName: claims.name } : {}),
        ...(claims.email_verified && claims.email ? { email: claims.email } : {}),
      };
    },
  };
}
