import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { DidiMcpConnector } from '../capabilities/didi/connector.js';
import { didiBindingSchema } from '../capabilities/didi/contracts.js';
import type { SourceResolver } from '../capabilities/didi/functions.js';
import { digest } from './identity.js';

export const configSchema = z.object({
  DATABASE_URL: z.string().min(1), EIGOS_PG_SCHEMA: z.string().default('eigos'),
  HOST: z.string().default('127.0.0.1'), PORT: z.coerce.number().int().default(3000),
  PUBLIC_URL: z.url().default('http://127.0.0.1:3000'),
  EIGOS_AUTH_MODE: z.enum(['jwt', 'development']).default('jwt'), EIGOS_DEV_TOKEN: z.string().min(32).optional(),
  OAUTH_ISSUER: z.url().optional(), OAUTH_AUDIENCE: z.string().optional(), OAUTH_JWKS_URL: z.url().optional(),
  EIGOS_DIDI_CONNECTION_FILE: z.string().optional(),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(env = process.env): Config {
  const config = configSchema.parse(env);
  if (config.EIGOS_AUTH_MODE === 'development') {
    if (!config.EIGOS_DEV_TOKEN || env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost'].includes(config.HOST)) throw new Error('Development authentication requires an explicit loopback token');
  } else if (!config.OAUTH_ISSUER || !config.OAUTH_AUDIENCE || !config.OAUTH_JWKS_URL) throw new Error('Configure JWT issuer, audience and verification keys');
  return config;
}
const connectionSchema = z.strictObject({ owner: z.string().min(1), active: z.boolean(), binding: didiBindingSchema });
export function configuredSource(path?: string): SourceResolver {
  const cache = new Map<string, DidiMcpConnector>();
  const read = async () => {
    if (!path || !isAbsolute(path)) throw new Error('Configure an absolute DiDi connection file');
    return connectionSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  };
  return async owner => {
    const connection = await read(), hash = digest(connection);
    if (!connection.active || connection.owner !== owner) throw new Error('DiDi source is unavailable for this owner');
    let connector = cache.get(hash);
    if (!connector) { cache.clear(); connector = new DidiMcpConnector(connection.binding); cache.set(hash, connector); }
    return { bindingId: connection.binding.bindingId, connector, async assertCurrent() {
      if (digest(await read()) !== hash) throw new Error('DiDi source configuration changed');
      await connector!.verifyCredential();
    } };
  };
}
