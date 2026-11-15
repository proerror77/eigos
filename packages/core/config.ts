import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { DidiMcpConnector } from '../capabilities/didi/connector.js';
import { didiBindingSchema } from '../capabilities/didi/contracts.js';
import type { SourceResolver } from '../capabilities/didi/functions.js';
import { digest } from './identity.js';
import { readPrivateSourceFile } from './private-source.js';
import { DidiOperations } from '../capabilities/didi/operations.js';

export const configSchema = z.object({
  DATABASE_URL: z.string().min(1), QUERY_DATABASE_URL: z.string().min(1).optional(), EIGOS_PG_SCHEMA: z.string().default('eigos'),
  HOST: z.string().default('127.0.0.1'), PORT: z.coerce.number().int().default(3000),
  PUBLIC_URL: z.url().default('http://127.0.0.1:3000'),
  EIGOS_AUTH_MODE: z.enum(['jwt', 'development']).default('jwt'), EIGOS_DEV_TOKEN: z.string().min(32).optional(),
  OAUTH_WORKBENCH_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_ISSUER: z.url().optional(), OAUTH_AUDIENCE: z.string().optional(), OAUTH_JWKS_URL: z.url().optional(),
  OAUTH_TENANT_CLAIM: z.string().min(1).default('tenant_id'),
  EIGOS_EXTENSION_MODULE: z.string().optional(),
  EIGOS_SOURCE_COMMIT: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  EIGOS_DIDI_CONNECTION_FILE: z.string().optional(),
  EIGOS_DIDI_WATCH_SANDBOX_CONNECTION_FILE: z.string().optional(),
  EIGOS_SERVICE_CONNECTION_FILE: z.string().optional(),
  EIGOS_PAOTUI_CONNECTION_FILE: z.string().optional(),
  EIGOS_WAIMAI_CONNECTION_FILE: z.string().optional(),
  EIGOS_AMAP_CONNECTION_FILE: z.string().optional(),
  EIGOS_XIAOHONGSHU_CONNECTION_FILE: z.string().optional(),
  EIGOS_DINING_WEB_CONNECTION_FILE: z.string().optional(),
  EIGOS_DINING_MINIPROGRAM_CONNECTION_FILE: z.string().optional(),
  EIGOS_JOURNEY_CALENDAR_CONNECTION_FILE: z.string().optional(),
  EIGOS_TRAVEL_PA_CONNECTION_FILE: z.string().optional(),
  EIGOS_VARIFLIGHT_CONNECTION_FILE: z.string().optional(),
  EIGOS_FR24_CONNECTION_FILE: z.string().optional(), EIGOS_FR24_MCP_ENTRYPOINT: z.string().optional(),
  EIGOS_STRIPE_SANDBOX_CONNECTION_FILE: z.string().optional(),
  EIGOS_HARNESS_BIN: z.string().optional(), EIGOS_HARNESS_CREDENTIAL_FILE: z.string().optional(),
  EIGOS_HARNESS_MODEL: z.string().default('gpt-6.1-sol'), EIGOS_HARNESS_REASONING_EFFORT: z.string().default('low'),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(env = process.env): Config {
  const config = configSchema.parse(env);
  if (config.EIGOS_AUTH_MODE === 'development') {
    if (!config.EIGOS_DEV_TOKEN || env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost'].includes(config.HOST)) throw new Error('Development authentication requires an explicit loopback token');
  } else if (!config.OAUTH_ISSUER || !config.OAUTH_AUDIENCE || !config.OAUTH_JWKS_URL) throw new Error('Configure JWT issuer, audience and verification keys');
  return config;
}
const connectionSchema = z.strictObject({ owner: z.string().min(1), active: z.boolean(), expiresAt: z.iso.datetime().nullable().optional(), binding: didiBindingSchema, ordersEnabled:z.boolean().default(false) });
const sandboxWatchSchema = connectionSchema.extend({
  binding: didiBindingSchema.extend({ environment: z.literal('mock') }),
  ordersEnabled: z.literal(false).default(false),
  originalOrderId: z.string().min(1).max(500),
});
export function configuredSource(primaryPath?: string, sandboxWatchPath?: string): SourceResolver {
  const cache = new Map<boolean, { hash: string; connector: DidiMcpConnector }>();
  const read = async (path?: string) => {
    if (!path || !isAbsolute(path)) throw new Error('Configure an absolute DiDi connection file');
    return connectionSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  };
  return async (owner, order) => {
    const primary = await read(primaryPath);
    // Tracking supplies the binding from its stored order. Other calls select the primary connection.
    const sandbox = order !== undefined && order.bindingId !== primary.binding.bindingId;
    const readSandbox = async () => {
      if (!sandboxWatchPath) throw new Error('DiDi sandbox tracking is unavailable');
      return sandboxWatchSchema.parse(JSON.parse(await readPrivateSourceFile(sandboxWatchPath)));
    };
    const sandboxConnection = sandbox ? await readSandbox() : undefined;
    const connection = sandboxConnection ?? primary;
    if (sandboxConnection && sandboxConnection.binding.bindingId !== order?.bindingId)
      throw new Error('Invalid DiDi sandbox watch binding');
    if (sandboxConnection && sandboxConnection.originalOrderId !== order?.orderId)
      throw new Error('Original sandbox order identity changed');
    const hash = digest(connection);
    if (!connection.active || connection.owner !== owner || connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now())
      throw new Error('DiDi source is unavailable for this owner');
    const cached = cache.get(sandbox);
    const connector = cached?.hash === hash ? cached.connector : new DidiMcpConnector(connection.binding);
    cache.set(sandbox, { hash, connector });
    const orders = new DidiOperations(connection.binding, connection.ordersEnabled, fetch, sandboxConnection?.originalOrderId);
    return { bindingId: connection.binding.bindingId, authorityId: hash, connector, orders, async assertCurrent() {
      if (digest(await (sandbox ? readSandbox() : read(primaryPath))) !== hash ||
        connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now())
        throw new Error('DiDi source configuration changed or expired');
      await connector.verifyCredential();
    } };
  };
}
