import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRelayApp } from '../../apps/relay/app.js';
import { readRelayConfig } from '../../apps/relay/config.js';
import { RelayClient } from '../../packages/agent-transport/client.js';

export async function relayFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-relay-business-')), server = createServer(), clients: RelayClient[] = [];
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const relay = createRelayApp(readRelayConfig({ EIGOS_RELAY_AUTH_MODE: 'development', EIGOS_RELAY_DEV_TOKEN: 'x'.repeat(32), EIGOS_RELAY_PUBLIC_URL: baseUrl, EIGOS_RELAY_DATABASE_PATH: join(directory, 'relay.sqlite') }),
    { verifyOwner: async token => { if (token !== 'fixture-owner') throw new Error('Invalid fixture owner'); return { issuer: 'https://fixture.example', tenant: 'fixture', subject: 'fixture-member' }; } });
  server.on('request', relay.app);
  async function client(name: string, fetcher?: typeof fetch) {
    const value = await RelayClient.open({ baseUrl, credentialPath: join(directory, name + '.json'), displayName: name, fetch: fetcher });
    clients.push(value); await value.register('fixture-owner'); return value;
  }
  return { directory, baseUrl, client,
    async connect(a: RelayClient, b: RelayClient) { const contact = await a.requestContact(b.agentId); await b.respondContact(contact.id, 'accept'); return contact.id; },
    async close() { for (const client of clients) client.close(); relay.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); relay.store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
