import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { publicGeoQuerySchema } from '../capabilities/paotui-contracts.js';
import { shopifyMerchantsSchema } from '../capabilities/shopify/contracts.js';

const merchantList = (name: string) => z.string().max(16384).transform((value, ctx) => {
  try { return shopifyMerchantsSchema.parse(JSON.parse(value)); }
  catch { ctx.addIssue({ code: 'custom', message: `${name} must be a JSON array of at most 8 strict, unique merchant identities` }); return z.NEVER; }
});

const publicGeoQueries = z.string().max(16384).transform((value, ctx) => {
  let input: unknown;
  try { input = JSON.parse(value); }
  catch {
    ctx.addIssue({ code: 'custom', message: 'EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES must contain a valid JSON array' });
    return z.NEVER;
  }
  const parsed = z.array(publicGeoQuerySchema).max(16).safeParse(input);
  if (!parsed.success) {
    ctx.addIssue({ code: 'custom', message: 'EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES must contain at most 16 strict public city/keyword queries' });
    return z.NEVER;
  }
  return parsed.data;
});

const networkMembers = z.string().max(4096).default('[]').transform((value, ctx) => {
  try { return z.array(z.uuid()).max(50).refine(ids => new Set(ids).size === ids.length).parse(JSON.parse(value)); }
  catch { ctx.addIssue({ code: 'custom', message: 'EIGOS_NETWORK_MEMBER_IDS must be a unique JSON array of at most 50 member UUIDs' }); return z.NEVER; }
});

const schema = z.object({
  EIGOS_INVITE_BETA: z.enum(['false', 'true']).default('false'),
  EIGOS_NETWORK_ENABLED: z.enum(['false', 'true']).default('false'),
  EIGOS_NETWORK_MEMBER_IDS: networkMembers,
  EIGOS_NETWORK_OPERATOR_MEMBER_IDS: networkMembers,
  EIGOS_NETWORK_MAX_RESPONDERS: z.coerce.number().int().min(1).max(10).default(3),
  EIGOS_NETWORK_MAX_CLARIFICATION_ROUNDS: z.coerce.number().int().min(1).max(10).default(2),
  EIGOS_RELEASE_DIGEST: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  EIGOS_COORDINATOR: z.literal('codex').default('codex'),
  EIGOS_CSV_INPUT_DIR: z.string().optional(),
  EIGOS_CSV_PILOT: z.enum(['false', 'true']).optional(),
  EIGOS_PAOTUI_ORDERS_ENABLED: z.literal('false').default('false'),
  EIGOS_PAOTUI_SKILL_DIR: z.string().optional(),
  EIGOS_PAOTUI_MEMBER_CONNECTION_FILE: z.string().optional(),
  EIGOS_MEMBER_SOURCE_KEY_FILE: z.string().optional(),
  EIGOS_MEMBER_SOURCE_TAILNET_ORIGIN: z.url().optional(),
  EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES: publicGeoQueries.optional(),
  EIGOS_SHOPIFY_CATALOG_MERCHANTS: merchantList('EIGOS_SHOPIFY_CATALOG_MERCHANTS').optional(),
  EIGOS_SHOPIFY_AUDIT_DIR: z.string().optional(),
  EIGOS_DIDI_KEY_FILE: z.string().optional(),
  EIGOS_DIDI_KEY_SHA256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  EIGOS_DIDI_BINDING_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
  EIGOS_DIDI_ENVIRONMENT: z.enum(['production', 'mock']).default('production'),
  EIGOS_DIDI_AUDIT_DIR: z.string().optional(),
  EIGOS_DIDI_ORDERS_ENABLED: z.enum(['false', 'mock']).default('false'),
  EIGOS_SHOPIFY_CHECKOUT_MERCHANTS: merchantList('EIGOS_SHOPIFY_CHECKOUT_MERCHANTS').optional(),
  EIGOS_SHOPIFY_CHECKOUT_AUDIT_DIR: z.string().optional(),
  EIGOS_ONTOLOGY_AUDIT_PATH: z.string().optional(),
  EIGOS_ACTION_SANDBOX: z.enum(['false', 'true']).default('false'),
  EIGOS_SANDBOX_PROVIDER_URL: z.url().optional(),
  EIGOS_SANDBOX_TOKEN_FILE: z.string().optional(),
  EIGOS_COMMERCE_SANDBOX_URL: z.url().optional(),
  EIGOS_COMMERCE_SANDBOX_TOKEN_FILE: z.string().optional(),
  EIGOS_COMMERCE_SANDBOX_AUDIT_DIR: z.string().optional(),
  EIGOS_FREE_BOOKING_BRIDGE_URL: z.url().optional(),
  EIGOS_FREE_BOOKING_TOKEN_FILE: z.string().optional(),
  EIGOS_FREE_BOOKING_BINDING_ID: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
  EIGOS_FREE_BOOKING_ATTENDEE_SHA256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL: z.url().optional(),
  EIGOS_SHOPIFY_PAYMENT_SANDBOX_TOKEN_FILE: z.string().optional(),
  EIGOS_BOOKING_SANDBOX_URL: z.url().optional(),
  EIGOS_BOOKING_SANDBOX_TOKEN_FILE: z.string().optional(),
  EIGOS_STRIPE_TEST_ENABLED: z.enum(['false', 'true']).default('false'),
  EIGOS_STRIPE_TEST_SECRET_KEY_FILE: z.string().optional(),
  EIGOS_STRIPE_TEST_ACCOUNT_ID: z.string().regex(/^acct_[A-Za-z0-9]{1,100}$/).optional(),
  EIGOS_STRIPE_TEST_MERCHANT_ID: z.string().trim().min(1).max(200).optional(),
  // Connection reservation only: no credentials, MCP client or executable capability.
  EIGOS_STRIPE_TREASURY_ENABLED: z.literal('false', { error: 'Stripe Treasury is reserved and disabled; account authorization and execution are not implemented' }).default('false'),
  EIGOS_STRIPE_TREASURY_MCP_URL: z.literal('https://mcp.stripe.com', { error: 'Stripe Treasury reservation requires the official MCP endpoint' }).default('https://mcp.stripe.com'),
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
  OAUTH_LEGACY_AUDIENCE: z.url().optional(),
  OAUTH_TENANT_CLAIM: z.string().trim().min(1).max(400).optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_AGENT_CLIENT_ID: z.string().min(1).optional(),
  OIDC_MCP_CLIENT_ID: z.string().min(1).optional(),
  MEMBERSHIP_DATABASE_PATH: z.string().optional(),
  EIGOS_MEMBERSHIP_APPROVAL: z.enum(['self-service', 'manual', 'invite-only']).default('self-service'),
  ALLOWED_ORIGINS: z.string().default(''),
  EIGOS_EXECUTOR: z.enum(['disabled', 'codex']).default('disabled'),
  EIGOS_CODEX_BIN: z.string().default('codex'),
  EIGOS_CODEX_MODEL: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/).default('gpt-6-luna'),
  EIGOS_CODEX_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  EIGOS_CODEX_SERVICE_TIER: z.enum(['priority', 'default']).default('priority'),
  EIGOS_EXECUTOR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(120000),
  EIGOS_AUDIT_PATH: z.string().optional(),
});
export type Config = z.infer<typeof schema>;

function parseConfig(env: NodeJS.ProcessEnv, role: 'gateway' | 'worker'): Config {
  const c = schema.parse(env);
  if (c.EIGOS_CSV_PILOT === 'true' && (env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(c.HOST) || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(c.PUBLIC_URL).hostname))) throw new Error('CSV simulation requires non-production loopback');
  if (c.EIGOS_CSV_INPUT_DIR && (c.EIGOS_CSV_PILOT !== 'true' || c.EIGOS_AUTH_MODE !== 'development' || !isAbsolute(c.EIGOS_CSV_INPUT_DIR))) throw new Error('Local CSV import requires an absolute directory and loopback development pilot');
  if (c.EIGOS_NETWORK_OPERATOR_MEMBER_IDS.some(id => !c.EIGOS_NETWORK_MEMBER_IDS.includes(id))) throw new Error('Network operators must be explicitly enrolled members');
  const publicUrl = new URL(c.PUBLIC_URL);
  if (c.EIGOS_DIDI_ORDERS_ENABLED === 'mock' && (!c.EIGOS_DIDI_KEY_FILE || c.EIGOS_DIDI_ENVIRONMENT !== 'mock' || !c.EIGOS_DIDI_AUDIT_DIR || c.EIGOS_ACTION_SANDBOX !== 'true')) throw new Error('DiDi orders require explicit official mock configuration, durable audit and sandbox action authorization');
  if (!!c.EIGOS_DIDI_KEY_FILE !== !!c.EIGOS_DIDI_BINDING_ID) throw new Error('DiDi requires a private key file and an explicit account binding ID');
  if (!!c.EIGOS_DIDI_KEY_FILE !== !!c.EIGOS_DIDI_KEY_SHA256) throw new Error('DiDi requires a pinned credential fingerprint; rotate with a new binding');
  if (c.EIGOS_DIDI_KEY_FILE && (!isAbsolute(c.EIGOS_DIDI_KEY_FILE) || c.EIGOS_AUTH_MODE !== 'development' || env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(c.HOST) || !['127.0.0.1', 'localhost', '[::1]'].includes(publicUrl.hostname))) throw new Error('Personal DiDi is restricted to explicitly configured non-production loopback development');
  if (c.EIGOS_DIDI_AUDIT_DIR && (!c.EIGOS_DIDI_KEY_FILE || !isAbsolute(c.EIGOS_DIDI_AUDIT_DIR))) throw new Error('DiDi audit requires an enabled binding and an absolute private directory');
  if (c.EIGOS_SHOPIFY_CATALOG_MERCHANTS?.length && (c.EIGOS_AUTH_MODE !== 'development' || env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(c.HOST) || !['127.0.0.1', 'localhost', '[::1]'].includes(publicUrl.hostname))) throw new Error('Shopify anonymous catalog requires explicitly configured local development');
  if (c.EIGOS_SHOPIFY_AUDIT_DIR && (!c.EIGOS_SHOPIFY_CATALOG_MERCHANTS?.length || !isAbsolute(c.EIGOS_SHOPIFY_AUDIT_DIR))) throw new Error('Shopify audit requires enabled catalog and an absolute private directory');
  if (c.EIGOS_SHOPIFY_CHECKOUT_MERCHANTS?.length && (c.EIGOS_AUTH_MODE !== 'development' || env.NODE_ENV === 'production' || c.EIGOS_INVITE_BETA === 'true'
    || !['127.0.0.1', 'localhost', '::1'].includes(c.HOST) || !['127.0.0.1', 'localhost', '[::1]'].includes(publicUrl.hostname)
    || !isAbsolute(c.DATABASE_PATH) || !c.EIGOS_SHOPIFY_CHECKOUT_AUDIT_DIR || !isAbsolute(c.EIGOS_SHOPIFY_CHECKOUT_AUDIT_DIR))) throw new Error('Unpaid Shopify checkout requires explicit private loopback development, a persistent absolute database and private source audit directory');
  if (c.EIGOS_SHOPIFY_CHECKOUT_AUDIT_DIR && (!c.EIGOS_SHOPIFY_CHECKOUT_MERCHANTS?.length || !isAbsolute(c.EIGOS_SHOPIFY_CHECKOUT_AUDIT_DIR))) throw new Error('Shopify checkout audit requires enabled private checkout preparation');
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error('PUBLIC_URL must be an origin without a path, credentials, query or fragment');
  }
  c.PUBLIC_URL = publicUrl.origin;
  if (c.EIGOS_INVITE_BETA === 'true') {
    if (c.EIGOS_AUTH_MODE !== 'jwt' || publicUrl.protocol !== 'https:' || c.OAUTH_AUDIENCE !== publicUrl.href
      || c.EIGOS_MEMBERSHIP_APPROVAL !== 'invite-only' || !c.OIDC_CLIENT_ID || !c.OIDC_AGENT_CLIENT_ID || !c.OIDC_MCP_CLIENT_ID
      || !isAbsolute(c.DATABASE_PATH) || !c.MEMBERSHIP_DATABASE_PATH || !isAbsolute(c.MEMBERSHIP_DATABASE_PATH)
      || c.EIGOS_EXECUTOR !== 'codex') throw new Error('Invite beta requires HTTPS/JWT, its exact audience, invite-only membership, registered clients, persistent absolute database paths and the document executor');
    if (c.EIGOS_DEV_TOKEN || c.EIGOS_NETWORK_ENABLED === 'true' || c.EIGOS_PAOTUI_SKILL_DIR || c.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE
      || c.EIGOS_MEMBER_SOURCE_KEY_FILE || c.EIGOS_MEMBER_SOURCE_TAILNET_ORIGIN || c.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES?.length
      || c.EIGOS_SHOPIFY_CATALOG_MERCHANTS?.length || c.EIGOS_SHOPIFY_AUDIT_DIR || c.EIGOS_SHOPIFY_CHECKOUT_MERCHANTS?.length || c.EIGOS_SHOPIFY_CHECKOUT_AUDIT_DIR || c.EIGOS_CSV_INPUT_DIR || c.EIGOS_CSV_PILOT === 'true'
      || c.EIGOS_ACTION_SANDBOX === 'true' || c.EIGOS_SANDBOX_PROVIDER_URL || c.EIGOS_SANDBOX_TOKEN_FILE
      || c.EIGOS_COMMERCE_SANDBOX_URL || c.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE || c.EIGOS_BOOKING_SANDBOX_URL || c.EIGOS_BOOKING_SANDBOX_TOKEN_FILE || c.EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL || c.EIGOS_SHOPIFY_PAYMENT_SANDBOX_TOKEN_FILE
      || c.EIGOS_STRIPE_TEST_ENABLED === 'true' || c.EIGOS_STRIPE_TEST_SECRET_KEY_FILE) throw new Error('Invite beta exposes document tasks only; private sources, development credentials, network publication and transaction fixtures cannot be enabled');
  }
  if (c.OAUTH_LEGACY_AUDIENCE && (c.EIGOS_INVITE_BETA !== 'true' || c.OAUTH_LEGACY_AUDIENCE !== c.PUBLIC_URL || c.OAUTH_AUDIENCE !== publicUrl.href)) throw new Error('Legacy OAuth audience must be the exact prior origin of this canonical invite-beta resource');
  if (c.EIGOS_NETWORK_ENABLED === 'true' && (c.EIGOS_AUTH_MODE !== 'jwt' || !c.OIDC_CLIENT_ID || !c.OIDC_AGENT_CLIENT_ID || !c.EIGOS_NETWORK_MEMBER_IDS.length || c.DATABASE_PATH === ':memory:')) throw new Error('Network pilot requires persistent JWT membership, browser/agent clients and explicit enrolled member IDs');
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
  assertPersonalSourceConfig(c, env.NODE_ENV);
  if (c.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES?.length && (!c.EIGOS_PAOTUI_SKILL_DIR || c.EIGOS_AUTH_MODE !== 'development' || env.NODE_ENV === 'production'
    || !['127.0.0.1', 'localhost', '::1'].includes(c.HOST) || !['127.0.0.1', 'localhost', '[::1]'].includes(publicUrl.hostname))) {
    throw new Error('Public-location discovery requires configured personal Paotui in non-production loopback development');
  }
  if (c.EIGOS_ONTOLOGY_AUDIT_PATH && (!c.EIGOS_PAOTUI_SKILL_DIR || !isAbsolute(c.EIGOS_ONTOLOGY_AUDIT_PATH))) throw new Error('Ontology audit requires configured Paotui and an absolute private path');
  if (c.EIGOS_ACTION_SANDBOX === 'true' && (c.EIGOS_COORDINATOR !== 'codex' || c.EIGOS_AUTH_MODE !== 'development' || env.NODE_ENV === 'production')) throw new Error('Action sandbox requires the local ontology backend');
  if (!!c.EIGOS_SANDBOX_PROVIDER_URL !== !!c.EIGOS_SANDBOX_TOKEN_FILE) throw new Error('Sandbox provider requires both endpoint and private token file');
  if (c.EIGOS_SANDBOX_PROVIDER_URL) {
    const target = new URL(c.EIGOS_SANDBOX_PROVIDER_URL);
    if (c.EIGOS_ACTION_SANDBOX !== 'true' || target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/' || target.search || target.hash || target.username || target.password || !isAbsolute(c.EIGOS_SANDBOX_TOKEN_FILE!)) throw new Error('Sandbox provider must be an explicit loopback origin with an absolute credential file');
  }
  if (!!c.EIGOS_COMMERCE_SANDBOX_URL !== !!c.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE) throw new Error('Commerce sandbox requires both endpoint and private token file');
  if (c.EIGOS_COMMERCE_SANDBOX_URL) {
    const target = new URL(c.EIGOS_COMMERCE_SANDBOX_URL);
    if (c.EIGOS_ACTION_SANDBOX !== 'true' || target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.pathname !== '/' || target.search || target.hash || target.username || target.password || !isAbsolute(c.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE!)) throw new Error('Commerce sandbox must use the explicit local sandbox environment and 127.0.0.1 source');
  }
  if (c.EIGOS_COMMERCE_SANDBOX_AUDIT_DIR && (!c.EIGOS_COMMERCE_SANDBOX_URL || !isAbsolute(c.EIGOS_COMMERCE_SANDBOX_AUDIT_DIR))) throw new Error('Commerce audit requires an enabled sandbox and an absolute private directory');
  const stripeConfigured = !!(c.EIGOS_STRIPE_TEST_SECRET_KEY_FILE || c.EIGOS_STRIPE_TEST_ACCOUNT_ID || c.EIGOS_STRIPE_TEST_MERCHANT_ID);
  if (c.EIGOS_STRIPE_TEST_ENABLED === 'true' || stripeConfigured) throw new Error('Merchant-side Stripe payment is not an EIGOS runtime capability; use PA-owned booking payment handoff');
  if (!!c.EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL !== !!c.EIGOS_SHOPIFY_PAYMENT_SANDBOX_TOKEN_FILE) throw new Error('Shopify test payment source requires its endpoint and source token file');
  if (c.EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL) {
    const u = new URL(c.EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL);
    if (c.EIGOS_AUTH_MODE !== 'development' || c.EIGOS_ACTION_SANDBOX !== 'true' || env.NODE_ENV === 'production' || u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.pathname !== '/' || u.search || u.hash || u.username || u.password || !isAbsolute(c.EIGOS_SHOPIFY_PAYMENT_SANDBOX_TOKEN_FILE!)) throw new Error('Shopify PA payment requires explicit isolated loopback test configuration');
  }
  if (!!c.EIGOS_BOOKING_SANDBOX_URL !== !!c.EIGOS_BOOKING_SANDBOX_TOKEN_FILE) throw new Error('Booking sandbox requires its endpoint and private source token file');
  if (c.EIGOS_BOOKING_SANDBOX_URL) {
    const u = new URL(c.EIGOS_BOOKING_SANDBOX_URL);
    if (c.EIGOS_AUTH_MODE !== 'development' || c.EIGOS_ACTION_SANDBOX !== 'true' || env.NODE_ENV === 'production' || u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.pathname !== '/' || u.search || u.hash || u.username || u.password || !isAbsolute(c.EIGOS_BOOKING_SANDBOX_TOKEN_FILE!)) throw new Error('Booking source requires explicit local sandbox configuration');
  }
  const participantFields = [c.EIGOS_FREE_BOOKING_BRIDGE_URL, c.EIGOS_FREE_BOOKING_TOKEN_FILE, c.EIGOS_FREE_BOOKING_BINDING_ID, c.EIGOS_FREE_BOOKING_ATTENDEE_SHA256];
  if (participantFields.some(Boolean) && !participantFields.every(Boolean)) throw new Error('Free participant booking requires the bridge, private token path and pinned account binding');
  if (c.EIGOS_FREE_BOOKING_BRIDGE_URL) {
    const u = new URL(c.EIGOS_FREE_BOOKING_BRIDGE_URL);
    if (c.EIGOS_AUTH_MODE !== 'development' || env.NODE_ENV === 'production' || u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.pathname !== '/' || u.search || u.hash || u.username || u.password || !isAbsolute(c.EIGOS_FREE_BOOKING_TOKEN_FILE!)) throw new Error('Participant browser is restricted to explicit non-production loopback and a private account binding');
  }
  return c;
}

/** Both owned-source modes remain explicit, non-production and loopback-only. */
export function assertPersonalSourceConfig(c: Config, nodeEnv = process.env.NODE_ENV) {
  const privateOrigin = c.EIGOS_MEMBER_SOURCE_TAILNET_ORIGIN;
  if (privateOrigin && (!c.EIGOS_MEMBER_SOURCE_KEY_FILE || new URL(privateOrigin).origin !== privateOrigin || new URL(privateOrigin).protocol !== 'https:' || !new URL(privateOrigin).hostname.endsWith('.ts.net') || privateOrigin !== c.PUBLIC_URL)) throw new Error('Member source private origin must exactly match an explicit HTTPS Tailscale origin');
  if (c.EIGOS_MEMBER_SOURCE_KEY_FILE) {
    if (!isAbsolute(c.EIGOS_MEMBER_SOURCE_KEY_FILE) || !c.EIGOS_PAOTUI_SKILL_DIR || !isAbsolute(c.EIGOS_PAOTUI_SKILL_DIR) || c.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE
      || c.EIGOS_AUTH_MODE !== 'jwt' || c.EIGOS_NETWORK_ENABLED !== 'true' || !c.EIGOS_NETWORK_MEMBER_IDS.length || c.DATABASE_PATH === ':memory:'
      || nodeEnv === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(c.HOST) || (!privateOrigin && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(c.PUBLIC_URL).hostname))
      || new URL(c.PUBLIC_URL).protocol !== 'https:' || c.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES?.length) throw new Error('Member-supplied sources require isolated loopback HTTPS/JWT network configuration and a private encryption key; shared credentials are forbidden');
  } else if (c.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE) {
    if (!isAbsolute(c.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE) || !c.EIGOS_PAOTUI_SKILL_DIR || !isAbsolute(c.EIGOS_PAOTUI_SKILL_DIR)
      || c.EIGOS_AUTH_MODE !== 'jwt' || c.EIGOS_NETWORK_ENABLED !== 'true' || !c.EIGOS_NETWORK_MEMBER_IDS.length || c.DATABASE_PATH === ':memory:'
      || nodeEnv === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(c.HOST) || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(c.PUBLIC_URL).hostname)
      || c.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES?.length) throw new Error('Member source requires explicit loopback JWT network configuration, a persistent database and private connection metadata');
  } else if (c.EIGOS_PAOTUI_SKILL_DIR && (c.EIGOS_AUTH_MODE !== 'development' || nodeEnv === 'production'
    || !['127.0.0.1', 'localhost', '::1'].includes(c.HOST) || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(c.PUBLIC_URL).hostname))) {
    throw new Error('Personal Paotui credentials are restricted to local development unless an explicit loopback member source connection is configured');
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config { return parseConfig(env, 'gateway'); }
export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env): Config { return parseConfig(env, 'worker'); }
