import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  EIGOS_COORDINATOR: z.enum(['disabled', 'codex']).default('disabled'),
  EIGOS_LIFE_INTAKE: z.enum(['false', 'true']).default('false'),
  EIGOS_CSV_INPUT_DIR: z.string().optional(),
  EIGOS_CSV_PILOT: z.enum(['false', 'true']).optional(),
  EIGOS_PAOTUI_ORDERS_ENABLED: z.enum(['false', 'true']).optional(),
  EIGOS_PAOTUI_SKILL_DIR: z.string().optional(),
  EIGOS_ONTOLOGY_AUDIT_PATH: z.string().optional(),
  EIGOS_ACTION_SANDBOX: z.enum(['false', 'true']).default('false'),
  EIGOS_SANDBOX_PROVIDER_URL: z.url().optional(),
  EIGOS_SANDBOX_TOKEN_FILE: z.string().optional(),
  EIGOS_TASK_MAX_MS: z.coerce.number().int().min(1000).max(604800000).optional(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.url().default('http://127.0.0.1:3000'),
  DATABASE_PATH: z.string().default('./data/eigos.sqlite'),
  EIGOS_AUTH_MODE: z.enum(['jwt', 'development']).default('jwt'),
  EIGOS_DEV_TOKEN: z.string().optional(),
  OAUTH_ISSUER: z.url().optional(),
  OAUTH_JWKS_URL: z.url().optional(),
  OAUTH_AUDIENCE: z.url().optional(),
  OAUTH_TENANT_CLAIM: z.string().trim().min(1).max(400).optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_AGENT_CLIENT_ID: z.string().min(1).optional(),
  MEMBERSHIP_DATABASE_PATH: z.string().optional(),
  EIGOS_MEMBERSHIP_APPROVAL: z.enum(['self-service', 'manual', 'invite-only']).default('self-service'),
  ALLOWED_ORIGINS: z.string().default(''),
  EIGOS_EXECUTOR: z.enum(['disabled', 'codex']).default('disabled'),
  EIGOS_CODEX_BIN: z.string().default('codex'),
  EIGOS_EXECUTOR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(120000),
  EIGOS_AUDIT_PATH: z.string().optional(),
});
export type Config = z.infer<typeof schema>;

function parseConfig(env: NodeJS.ProcessEnv, role: 'gateway' | 'worker'): Config {
  const c = schema.parse(env);
  if (c.EIGOS_CSV_PILOT === 'true' && (env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(c.HOST) || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(c.PUBLIC_URL).hostname))) throw new Error('CSV simulation requires non-production loopback');
  if (c.EIGOS_CSV_INPUT_DIR && (c.EIGOS_CSV_PILOT !== 'true' || c.EIGOS_AUTH_MODE !== 'development' || !isAbsolute(c.EIGOS_CSV_INPUT_DIR))) throw new Error('Local CSV import requires an absolute directory and loopback development pilot');
  const publicUrl = new URL(c.PUBLIC_URL);
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error('PUBLIC_URL must be an origin without a path, credentials, query or fragment');
  }
  c.PUBLIC_URL = publicUrl.origin;
  if (c.OIDC_CLIENT_ID && c.EIGOS_AUTH_MODE !== 'jwt') throw new Error('Member login requires JWT/OIDC configuration');
  if (c.OIDC_CLIENT_SECRET && !c.OIDC_CLIENT_ID) throw new Error('OIDC_CLIENT_SECRET requires OIDC_CLIENT_ID');
  if (c.OIDC_AGENT_CLIENT_ID && c.EIGOS_AUTH_MODE !== 'jwt') throw new Error('Agent onboarding requires JWT mode');
  if (role === 'gateway' && c.EIGOS_AUTH_MODE === 'jwt' && c.MEMBERSHIP_DATABASE_PATH === ':memory:') throw new Error('JWT membership requires a persistent database');
  if (c.MEMBERSHIP_DATABASE_PATH && c.MEMBERSHIP_DATABASE_PATH !== ':memory:' && resolve(c.MEMBERSHIP_DATABASE_PATH) === resolve(c.DATABASE_PATH)) throw new Error('Membership and task databases require separate files');
  if (c.EIGOS_AUTH_MODE === 'development') {
    if (!['127.0.0.1', 'localhost', '::1'].includes(c.HOST) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(publicUrl.hostname) ||
        env.NODE_ENV === 'production') throw new Error('Development credentials are restricted to loopback and non-production');
    if (role === 'gateway' && (!c.EIGOS_DEV_TOKEN || c.EIGOS_DEV_TOKEN.length < 32)) throw new Error('Development token must contain at least 32 characters; run npm run setup:dev');
  } else if (role === 'gateway') {
    if (!c.OAUTH_ISSUER || !c.OAUTH_JWKS_URL || !c.OAUTH_AUDIENCE) throw new Error('JWT mode requires OAUTH_ISSUER, OAUTH_JWKS_URL and OAUTH_AUDIENCE');
    for (const value of [c.PUBLIC_URL, c.OAUTH_ISSUER, c.OAUTH_JWKS_URL, c.OAUTH_AUDIENCE]) {
      if (new URL(value).protocol !== 'https:') throw new Error('JWT mode requires HTTPS public, issuer, JWKS and audience URLs');
    }
  }
  for (const origin of c.ALLOWED_ORIGINS.split(',').filter(Boolean)) {
    if (new URL(origin).origin !== origin) throw new Error('ALLOWED_ORIGINS must contain exact origins, without trailing slashes');
  }
  if (c.EIGOS_PAOTUI_SKILL_DIR && (c.EIGOS_AUTH_MODE !== 'development' || env.NODE_ENV === 'production')) throw new Error('Personal Paotui credentials are restricted to local development');
  if (c.EIGOS_ONTOLOGY_AUDIT_PATH && (!c.EIGOS_PAOTUI_SKILL_DIR || !isAbsolute(c.EIGOS_ONTOLOGY_AUDIT_PATH))) throw new Error('Ontology audit requires configured Paotui and an absolute private path');
  if (c.EIGOS_ACTION_SANDBOX === 'true' && (c.EIGOS_COORDINATOR !== 'codex' || c.EIGOS_AUTH_MODE !== 'development' || env.NODE_ENV === 'production')) throw new Error('Action sandbox requires the local ontology backend');
  if (!!c.EIGOS_SANDBOX_PROVIDER_URL !== !!c.EIGOS_SANDBOX_TOKEN_FILE) throw new Error('Sandbox provider requires both endpoint and private token file');
  if (c.EIGOS_SANDBOX_PROVIDER_URL) {
    const target = new URL(c.EIGOS_SANDBOX_PROVIDER_URL);
    if (c.EIGOS_ACTION_SANDBOX !== 'true' || target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/' || target.search || target.hash || target.username || target.password || !isAbsolute(c.EIGOS_SANDBOX_TOKEN_FILE!)) throw new Error('Sandbox provider must be an explicit loopback origin with an absolute credential file');
  }
  return c;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config { return parseConfig(env, 'gateway'); }
export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env): Config { return parseConfig(env, 'worker'); }
