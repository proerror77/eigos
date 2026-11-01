import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { once } from 'node:events';
import { handleAsNodeRequest } from 'cloudflare:node';
import pg from 'pg';
import { createRelayApp } from './app.js';
import { readRelayConfig } from './config.js';
import { PostgresRelayStore } from '../../packages/relay/postgres-store.js';

interface RelayWorkerEnv {
  RELAY_DATABASE: { connectionString: string };
  RELAY_SCHEMA: string;
  EIGOS_RELAY_PUBLIC_URL: string;
  EIGOS_RELAY_OAUTH_ISSUER: string;
  EIGOS_RELAY_OAUTH_AUDIENCE: string;
  EIGOS_RELAY_OAUTH_JWKS_URL: string;
  EIGOS_RELAY_CLIENT_IDS: string;
  EIGOS_RELAY_TENANT_CLAIM?: string;
}

/** Each request owns its pool: Cloudflare does not allow reusing sockets across
 * request contexts. Hyperdrive provides the actual persistent connection pool. */
export default {
  async fetch(request: Request, env: RelayWorkerEnv): Promise<Response> {
    const address = request.headers.get('CF-Connecting-IP');
    if (!address || !isIP(address)) return Response.json({ error: 'INGRESS_ADDRESS_REQUIRED' }, { status: 400 });
    const config = readRelayConfig({
      NODE_ENV: 'production', EIGOS_RELAY_DATABASE_PATH: '/unused/cloudflare-relay',
      EIGOS_RELAY_PUBLIC_URL: env.EIGOS_RELAY_PUBLIC_URL, EIGOS_RELAY_AUTH_MODE: 'jwt',
      EIGOS_RELAY_OAUTH_ISSUER: env.EIGOS_RELAY_OAUTH_ISSUER, EIGOS_RELAY_OAUTH_AUDIENCE: env.EIGOS_RELAY_OAUTH_AUDIENCE,
      EIGOS_RELAY_OAUTH_JWKS_URL: env.EIGOS_RELAY_OAUTH_JWKS_URL, EIGOS_RELAY_CLIENT_IDS: env.EIGOS_RELAY_CLIENT_IDS,
      EIGOS_RELAY_TENANT_CLAIM: env.EIGOS_RELAY_TENANT_CLAIM ?? 'tenant_id',
    });
    if (new URL(request.url).origin !== config.publicUrl) return Response.json({ error: 'ORIGIN_NOT_ALLOWED' }, { status: 403 });
    const pool = new pg.Pool({ connectionString: env.RELAY_DATABASE.connectionString, max: 1, connectionTimeoutMillis: 10000, query_timeout: 15000 });
    const store = new PostgresRelayStore(pool, env.RELAY_SCHEMA);
    const relay = createRelayApp(config, { store, trustedIngressAddress: address });
    const server = createServer(relay.app);
    try {
      server.listen(0); await once(server, 'listening');
      const bound = server.address();
      if (!bound || typeof bound === 'string') throw new Error('Relay server failed to bind');
      const result = await handleAsNodeRequest(bound.port, request);
      // Relay responses are bounded JSON, so consume before closing request-owned
      // sockets. This avoids leaking database connections into another request.
      const bytes = await result.arrayBuffer();
      return new Response([204, 205, 304].includes(result.status) ? null : bytes, { status: result.status, statusText: result.statusText, headers: result.headers });
    } finally {
      relay.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await store.close();
    }
  },
};
