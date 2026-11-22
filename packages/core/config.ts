import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { DidiMcpConnector } from '../capabilities/didi/connector.js';
import { didiBindingSchema } from '../capabilities/didi/contracts.js';
import type { SourceResolver } from '../capabilities/didi/functions.js';
import { Conflict, digest, SourceReadFailure } from './identity.js';
import { readPrivateSourceFile } from './private-source.js';
import { DidiOperations } from '../capabilities/didi/operations.js';

// A bare lowercase DNS hostname of at least two labels: no scheme, port, path or trailing dot.
const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const proxyPresets = ['loopback', 'linklocal', 'uniquelocal'];
/**
 * A value for Express's `trust proxy` that names the proxies: a hop count on its own, or a comma-separated list of preset names,
 * addresses and CIDRs. A CIDR prefix of 0 would trust every address. Anything else, such as `true`, never reaches Express.
 */
function trustedProxies(value: string) {
  if (/^\d+$/.test(value)) return true;
  return value.split(',').every(entry => {
    const item = entry.trim();
    if (proxyPresets.includes(item)) return true;
    const [address = '', prefix, ...rest] = item.split('/'), family = isIP(address);
    if (!family || rest.length) return false;
    return prefix === undefined || /^\d{1,3}$/.test(prefix) && Number(prefix) >= 1 && Number(prefix) <= (family === 4 ? 32 : 128);
  });
}

export const connectionConfigSchema = z.object({
  PUBLIC_URL: z.url().optional(),
  EIGOS_AUTH_MODE: z.enum(['jwt', 'development']).optional(),
  EIGOS_DIDI_CONNECTION_FILE: z.string().optional(),
  EIGOS_DIDI_WATCH_SANDBOX_CONNECTION_FILE: z.string().optional(),
  EIGOS_SERVICE_CONNECTION_FILE: z.string().optional(),
  EIGOS_FLIGGY_FLIGHT_CONNECTION_FILE: z.string().optional(),
  EIGOS_FLIGGY_HOTEL_CONNECTION_FILE: z.string().optional(),
  EIGOS_PAOTUI_CONNECTION_FILE: z.string().optional(),
  EIGOS_WAIMAI_CONNECTION_FILE: z.string().optional(),
  EIGOS_TAOBAO_INSTANT_DELIVERY_CONNECTION_FILE: z.string().optional(),
  EIGOS_HEMA_CONNECTION_FILE: z.string().optional(),
  EIGOS_AMAP_CONNECTION_FILE: z.string().optional(),
  EIGOS_BETA_AMAP_CONNECTION_FILE: z.string().optional(),
  EIGOS_BETA_FLYAI_TRIAL_UNTIL: z.iso.datetime().optional(),
  EIGOS_XIAOHONGSHU_CONNECTION_FILE: z.string().optional(),
  EIGOS_DIANPING_CONNECTION_FILE: z.string().optional(),
  EIGOS_TABLECHECK_CONNECTION_FILE: z.string().optional(),
  EIGOS_MEITUAN_DINING_CONNECTION_FILE: z.string().optional(),
  EIGOS_DINING_WEB_CONNECTION_FILE: z.string().optional(),
  EIGOS_DINING_MINIPROGRAM_CONNECTION_FILE: z.string().optional(),
  EIGOS_JOURNEY_CALENDAR_CONNECTION_FILE: z.string().optional(),
  EIGOS_TRAVEL_PA_CONNECTION_FILE: z.string().optional(),
  EIGOS_VARIFLIGHT_CONNECTION_FILE: z.string().optional(),
  EIGOS_FR24_CONNECTION_FILE: z.string().optional(), EIGOS_FR24_MCP_ENTRYPOINT: z.string().optional(),
  EIGOS_STRIPE_SANDBOX_CONNECTION_FILE: z.string().optional(),
});
export type ConnectionConfig = z.infer<typeof connectionConfigSchema>;

export const configSchema = z.object({
  ...connectionConfigSchema.shape,
  DATABASE_URL: z.string().min(1), QUERY_DATABASE_URL: z.string().min(1).optional(), EIGOS_PG_SCHEMA: z.string().default('eigos'),
  HOST: z.string().default('127.0.0.1'), PORT: z.coerce.number().int().default(3000),
  PUBLIC_URL: z.url().default('http://127.0.0.1:3000'),
  EIGOS_AUTH_MODE: z.enum(['jwt', 'development']).default('jwt'), EIGOS_DEV_TOKEN: z.string().min(32).optional(),
  OAUTH_WORKBENCH_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_MEMBER_CLIENT_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).optional(),
  OAUTH_MEMBER_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_MEMBER_MCP_CLIENT_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).optional(),
  OAUTH_EXISTING_CLIENT_IDS: z.string().regex(/^[a-zA-Z0-9_-]+(?:,[a-zA-Z0-9_-]+)*$/).optional(),
  OAUTH_MANAGEMENT_CLIENT_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).optional(),
  OAUTH_MANAGEMENT_CLIENT_SECRET: z.string().min(1).optional(),
  // The tenant's own domain. Under an Auth0 custom domain OAUTH_ISSUER is the custom one, but the Management API stays on this one.
  OAUTH_MANAGEMENT_DOMAIN: z.string().regex(hostname, 'Use a bare lowercase hostname such as dev-abc.us.auth0.com, with no scheme, port or path').optional(),
  OAUTH_ISSUER: z.url().optional(), OAUTH_AUDIENCE: z.string().optional(), OAUTH_JWKS_URL: z.url().optional(),
  OAUTH_TENANT_CLAIM: z.string().min(1).default('tenant_id'),
  EIGOS_SIGNUP: z.enum(['open', 'invite', 'closed']).default('invite'),
  EIGOS_ENFORCE_OWNER_RLS: z.enum(['true', 'false']).optional(),
  EIGOS_PORTAL_SECRET: z.string().min(32).optional(), EIGOS_ACCOUNT_LINK_SECRET: z.string().min(32).optional(),
  EIGOS_TRUST_PROXY: z.string().refine(trustedProxies,
    'Use a hop count such as 1, or a comma-separated list of proxy addresses, CIDRs and the presets loopback, linklocal and uniquelocal').optional(),
  EIGOS_EXTENSION_MODULE: z.string().optional(),
  EIGOS_SOURCE_COMMIT: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  EIGOS_HARNESS_BIN: z.string().optional(), EIGOS_HARNESS_CREDENTIAL_FILE: z.string().optional(),
  EIGOS_AGENT_SANDBOX_ENABLED: z.enum(['true', 'false']).optional(),
  EIGOS_HARNESS_MODEL: z.string().default('gpt-6.1-sol'), EIGOS_HARNESS_REASONING_EFFORT: z.string().default('low'),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(env = process.env): Config {
  const config = configSchema.parse(env);
  if (config.EIGOS_AUTH_MODE === 'development') {
    if (!config.EIGOS_DEV_TOKEN || env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost'].includes(config.HOST)) throw new Error('Development authentication requires an explicit loopback token');
  } else if (!config.OAUTH_ISSUER || !config.OAUTH_AUDIENCE || !config.OAUTH_JWKS_URL) throw new Error('Configure JWT issuer, audience and verification keys');
  if (config.OAUTH_MEMBER_CLIENT_ID || config.OAUTH_MEMBER_CLIENT_SECRET || config.OAUTH_MEMBER_MCP_CLIENT_ID || config.OAUTH_EXISTING_CLIENT_IDS) {
    if (config.EIGOS_AUTH_MODE !== 'jwt' || !config.OAUTH_MEMBER_CLIENT_ID || !config.OAUTH_MEMBER_CLIENT_SECRET ||
        !config.OAUTH_MEMBER_MCP_CLIENT_ID || !config.OAUTH_EXISTING_CLIENT_IDS ||
        config.OAUTH_MEMBER_CLIENT_ID === config.OAUTH_MEMBER_MCP_CLIENT_ID ||
        config.OAUTH_EXISTING_CLIENT_IDS.split(',').some(id => id === config.OAUTH_MEMBER_CLIENT_ID || id === config.OAUTH_MEMBER_MCP_CLIENT_ID) ||
        new URL(config.OAUTH_ISSUER!).protocol !== 'https:' || config.OAUTH_ISSUER !== new URL(config.OAUTH_ISSUER!).origin + '/' ||
        new URL(config.OAUTH_JWKS_URL!).origin !== new URL(config.OAUTH_ISSUER!).origin ||
        new URL(config.PUBLIC_URL).origin !== config.PUBLIC_URL || new URL(config.PUBLIC_URL).protocol !== 'https:') {
      throw new Error('Configure separate HTTPS member portal, MCP and existing OAuth clients');
    }
    if (!config.EIGOS_PORTAL_SECRET || !config.EIGOS_ACCOUNT_LINK_SECRET)
      throw new Error('Configure EIGOS_PORTAL_SECRET and EIGOS_ACCOUNT_LINK_SECRET for the account portal');
    if (config.EIGOS_PORTAL_SECRET === config.EIGOS_ACCOUNT_LINK_SECRET)
      throw new Error('Use separate portal and account link secrets');
    if (config.EIGOS_SIGNUP !== 'closed' && config.EIGOS_ENFORCE_OWNER_RLS !== 'true')
      throw new Error('Self sign-up requires EIGOS_ENFORCE_OWNER_RLS=true');
    if (Boolean(config.OAUTH_MANAGEMENT_CLIENT_ID) !== Boolean(config.OAUTH_MANAGEMENT_CLIENT_SECRET))
      throw new Error('Configure both OAUTH_MANAGEMENT_CLIENT_ID and OAUTH_MANAGEMENT_CLIENT_SECRET');
  }
  if (config.EIGOS_AGENT_SANDBOX_ENABLED === 'true' && config.EIGOS_AUTH_MODE !== 'development')
    throw new Error('Agent sandbox capabilities require development authentication');
  return config;
}
const connectionSchema = z.strictObject({
  owner: z.string().min(1), active: z.boolean(), expiresAt: z.iso.datetime().nullable().optional(),
  binding: didiBindingSchema, ordersEnabled: z.boolean().default(false), cancellationsEnabled: z.boolean().optional(),
});
const sandboxWatchSchema = connectionSchema.extend({
  binding: didiBindingSchema.extend({ environment: z.literal('mock') }),
  ordersEnabled: z.literal(false).default(false),
  cancellationsEnabled: z.literal(false).optional(),
  originalOrderId: z.string().min(1).max(500),
});
export function configuredSource(primaryPath?: string, sandboxWatchPath?: string): SourceResolver {
  const cache = new Map<boolean, { hash: string; connector: DidiMcpConnector }>();
  const read = async (path?: string) => {
    if (!path || !isAbsolute(path))
      throw new SourceReadFailure('Configure an absolute DiDi connection file', { unavailable: true });
    try {
      return connectionSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (cause) {
      throw new SourceReadFailure('DiDi connection configuration is unavailable', { cause, unavailable: true });
    }
  };
  return async (owner, order) => {
    const primary = await read(primaryPath);
    // Tracking supplies the binding from its stored order. Other calls select the primary connection.
    const sandbox = order !== undefined && order.bindingId !== primary.binding.bindingId;
    const readSandbox = async () => {
      if (!sandboxWatchPath)
        throw new SourceReadFailure('DiDi sandbox tracking is unavailable', { unavailable: true });
      try {
        return sandboxWatchSchema.parse(JSON.parse(await readPrivateSourceFile(sandboxWatchPath)));
      } catch (cause) {
        throw new SourceReadFailure('DiDi sandbox connection configuration is unavailable', { cause, unavailable: true });
      }
    };
    const sandboxConnection = sandbox ? await readSandbox() : undefined;
    const connection = sandboxConnection ?? primary;
    if (sandboxConnection && sandboxConnection.binding.bindingId !== order?.bindingId)
      throw new Conflict('Invalid DiDi sandbox watch binding');
    if (sandboxConnection && sandboxConnection.originalOrderId !== order?.orderId)
      throw new Conflict('Original sandbox order identity changed');
    const hash = digest(connection);
    if (!connection.active || connection.owner !== owner || connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now())
      throw new SourceReadFailure('DiDi source is unavailable for this owner', { unavailable: true });
    const cached = cache.get(sandbox);
    const connector = cached?.hash === hash ? cached.connector : new DidiMcpConnector(connection.binding);
    cache.set(sandbox, { hash, connector });
    // The cancel switch can change independently of the original order's authority.
    const { cancellationsEnabled, ...authority } = connection;
    const orders = new DidiOperations(connection.binding, connection.ordersEnabled, fetch, sandboxConnection?.originalOrderId,
      cancellationsEnabled ?? connection.ordersEnabled);
    return { bindingId: connection.binding.bindingId, authorityId: digest(authority), connector, orders, async assertCurrent() {
      if (digest(await (sandbox ? readSandbox() : read(primaryPath))) !== hash ||
        connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now())
        throw new Conflict('DiDi source configuration changed or expired');
      await connector.verifyCredential();
    } };
  };
}
