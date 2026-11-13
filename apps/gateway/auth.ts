import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { digest, type Principal } from '../../packages/core/identity.js';
import type { Config } from '../../packages/core/config.js';

export type VerifyToken = (token: string) => Promise<Principal>;
export const developmentPrincipal: Principal = { owner: 'local-developer', scopes: ['tasks:read', 'tasks:write', 'ontology:read', 'ontology:write', 'sources:Didi:read'] };
export function jwtVerifier(issuer: string, audience: string, keys: JWTVerifyGetKey, tenantClaim = 'tenant_id'): VerifyToken {
  return async token => {
    const { payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256', 'ES256', 'EdDSA'], requiredClaims: ['exp', 'iat', 'sub', tenantClaim, 'scope'] });
    const claims = z.object({ sub: z.string().min(1), scope: z.string() }).parse(payload);
    const tenant = z.string().min(1).parse(payload[tenantClaim]);
    return { owner: digest([issuer, tenant, claims.sub]), scopes: claims.scope.split(/\s+/).filter(Boolean) };
  };
}
export function verifier(config: Config): VerifyToken {
  if (config.EIGOS_AUTH_MODE === 'jwt') return jwtVerifier(config.OAUTH_ISSUER!, config.OAUTH_AUDIENCE!, createRemoteJWKSet(new URL(config.OAUTH_JWKS_URL!)), config.OAUTH_TENANT_CLAIM);
  return async token => {
    const expected = Buffer.from(config.EIGOS_DEV_TOKEN!), actual = Buffer.from(token);
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new Error('Invalid access token');
    return developmentPrincipal;
  };
}
