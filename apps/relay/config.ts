import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { agentIdSchema, relayOrigin, type RelayOwner } from '../../packages/relay/contracts.js';

export interface RelayConfig {
  host: string; port: number; publicUrl: string; databasePath: string;
  authMode: 'jwt' | 'development'; devToken?: string;
  issuer?: string; audience?: string; jwksUrl?: string; tenantClaim: string; clientIds: string[];
  trustLoopbackProxy?: boolean;
}
export type VerifyOwner = (token: string) => Promise<RelayOwner>;
export function readRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const value = z.object({
    EIGOS_RELAY_HOST: z.string().default('127.0.0.1'), EIGOS_RELAY_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
    EIGOS_RELAY_PUBLIC_URL: z.string().default('http://127.0.0.1:8788'), EIGOS_RELAY_DATABASE_PATH: z.string().min(1),
    EIGOS_RELAY_AUTH_MODE: z.enum(['jwt', 'development']).default('jwt'), EIGOS_RELAY_DEV_TOKEN: z.string().min(32).optional(),
    EIGOS_RELAY_OAUTH_ISSUER: z.url().optional(), EIGOS_RELAY_OAUTH_AUDIENCE: z.string().optional(), EIGOS_RELAY_OAUTH_JWKS_URL: z.url().optional(),
    EIGOS_RELAY_TENANT_CLAIM: z.string().default('tenant_id'), EIGOS_RELAY_CLIENT_IDS: z.string().default(''),
    EIGOS_RELAY_TRUST_LOOPBACK_PROXY: z.enum(['true', 'false']).default('false'),
  }).parse(env);
  const config: RelayConfig = { host: value.EIGOS_RELAY_HOST, port: value.EIGOS_RELAY_PORT, publicUrl: relayOrigin(value.EIGOS_RELAY_PUBLIC_URL),
    databasePath: value.EIGOS_RELAY_DATABASE_PATH, authMode: value.EIGOS_RELAY_AUTH_MODE, devToken: value.EIGOS_RELAY_DEV_TOKEN,
    issuer: value.EIGOS_RELAY_OAUTH_ISSUER, audience: value.EIGOS_RELAY_OAUTH_AUDIENCE, jwksUrl: value.EIGOS_RELAY_OAUTH_JWKS_URL,
    tenantClaim: value.EIGOS_RELAY_TENANT_CLAIM, clientIds: value.EIGOS_RELAY_CLIENT_IDS.split(',').map(s => s.trim()).filter(Boolean), trustLoopbackProxy: value.EIGOS_RELAY_TRUST_LOOPBACK_PROXY === 'true' };
  if (config.trustLoopbackProxy && !['127.0.0.1', '::1', 'localhost'].includes(config.host)) throw new Error('Trusted loopback proxy mode requires a loopback-only Relay listener');
  if (resolve(config.databasePath) !== config.databasePath || config.databasePath === ':memory:') throw new Error('Relay requires a dedicated absolute database path');
  if (config.authMode === 'development') {
    if (env.NODE_ENV === 'production' || !['127.0.0.1', '::1', 'localhost'].includes(config.host)
      || !['127.0.0.1', '[::1]', 'localhost'].includes(new URL(config.publicUrl).hostname) || !config.devToken) throw new Error('Development relay credentials require explicit loopback configuration');
  } else if (!config.issuer || !config.audience || !config.jwksUrl || !config.clientIds.length
    || [config.publicUrl, config.issuer, config.jwksUrl].some(url => new URL(url).protocol !== 'https:')) throw new Error('Relay JWT enrollment requires HTTPS, an explicit issuer, audience, key URL and client allowlist');
  return config;
}

export function relayJwtVerifier(config: RelayConfig, keys: JWTVerifyGetKey): VerifyOwner {
  return async token => {
    const { payload } = await jwtVerify(token, keys, { issuer: config.issuer!, audience: config.audience!, algorithms: ['RS256', 'ES256', 'EdDSA'],
      typ: 'at+jwt', requiredClaims: ['sub', 'iat', 'exp', 'client_id', 'scope', config.tenantClaim], maxTokenAge: '15m', clockTolerance: 5 });
    const claims = z.object({ sub: z.string().min(1), iat: z.number(), exp: z.number(), client_id: z.string(), scope: z.string(), eigos_agent_id: agentIdSchema.optional() }).parse(payload);
    const tenant = z.string().min(1).parse(payload[config.tenantClaim]);
    if (claims.exp - claims.iat > 900 || !config.clientIds.includes(claims.client_id) || !claims.scope.split(/\s+/).includes('relay:enroll')) throw new Error('Relay enrollment authority required');
    return { issuer: config.issuer!, subject: claims.sub, tenant, ...(claims.eigos_agent_id ? { enrollmentAgentId: claims.eigos_agent_id } : {}) };
  };
}
export function createOwnerVerifier(config: RelayConfig): VerifyOwner {
  if (config.authMode === 'development') return async token => {
    const expected = Buffer.from(config.devToken!), actual = Buffer.from(token);
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new Error('Invalid enrollment credential');
    return { issuer: 'loopback-development', subject: 'developer', tenant: 'local' };
  };
  return relayJwtVerifier(config, createRemoteJWKSet(new URL(config.jwksUrl!)));
}
