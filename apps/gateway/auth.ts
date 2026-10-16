import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { Config } from '../../packages/core/config.js';
import { SCOPES, type Principal } from '../../packages/core/domain.js';

export type VerifyToken = (token: string) => Promise<Principal>;

export function jwtVerifier(issuer: string, audience: string, keys: JWTVerifyGetKey): VerifyToken {
  return async token => {
    const { payload } = await jwtVerify(token, keys, {
      issuer, audience, algorithms: ['RS256', 'ES256', 'EdDSA'],
      typ: 'at+jwt',
      requiredClaims: ['exp', 'iat', 'sub', 'tenant_id', 'scope', 'client_id'],
      maxTokenAge: '15m', clockTolerance: 5,
    });
    const claims = z.object({
      sub: z.string().min(1), tenant_id: z.string().min(1), client_id: z.string().min(1), scope: z.string(),
      exp: z.number(), iat: z.number(),
    }).parse(payload);
    if (claims.exp - claims.iat > 900) throw new Error('Access-token lifetime must not exceed 15 minutes');
    return { issuer, subject: claims.sub, tenant: claims.tenant_id, clientId: claims.client_id, scopes: claims.scope.split(/\s+/).filter(Boolean) };
  };
}

export function createVerifier(c: Config): VerifyToken {
  if (c.EIGOS_AUTH_MODE === 'development') {
    const expected = Buffer.from(c.EIGOS_DEV_TOKEN!);
    return async token => {
      const supplied = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Invalid token');
      return { issuer: 'local-development', subject: 'developer', tenant: 'local', clientId: 'eigos-local-dev', scopes: [...SCOPES] };
    };
  }
  return jwtVerifier(c.OAUTH_ISSUER!, c.OAUTH_AUDIENCE!, createRemoteJWKSet(new URL(c.OAUTH_JWKS_URL!)));
}

export function protectedResourceMetadata(c: Config): object {
  return {
    resource: c.OAUTH_AUDIENCE ?? c.PUBLIC_URL,
    authorization_servers: c.OAUTH_ISSUER ? [c.OAUTH_ISSUER] : [],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'EIGOS task gateway',
  };
}
