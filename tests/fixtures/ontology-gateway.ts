import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createApp } from '../../apps/gateway/app.js';
import { readConfig } from '../../packages/core/config.js';
import { SCOPES } from '../../packages/core/domain.js';

const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); if (!address || typeof address === 'string') throw new Error('Listener unavailable');
const config = readConfig({ ...process.env, EIGOS_DEV_TOKEN: readFileSync(process.env.GATEWAY_TOKEN_FILE!, 'utf8').trim(), PORT: String(address.port), PUBLIC_URL: `http://127.0.0.1:${address.port}` });
const alternate = process.env.ALTERNATE_TOKEN_FILE ? readFileSync(process.env.ALTERNATE_TOKEN_FILE, 'utf8').trim() : undefined;
const runtime = createApp(config, alternate ? async token => {
  if (token !== config.EIGOS_DEV_TOKEN && token !== alternate) throw new Error('Invalid test credential');
  return { issuer: 'local-development', tenant: 'local', subject: token === alternate ? 'other' : 'developer', clientId: 'e2e', scopes: [...SCOPES] };
} : undefined);
server.on('request', runtime.app); console.log(JSON.stringify({ port: address.port, pid: process.pid }));
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await runtime.close(); };
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
