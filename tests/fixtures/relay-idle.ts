import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { createRelayApp } from '../../apps/relay/app.js';
import { readRelayConfig } from '../../apps/relay/config.js';
import { RelayStore } from '../../packages/relay/store.js';
import { PostgresRelayStore } from '../../packages/relay/postgres-store.js';
import { importRelaySnapshot } from '../../packages/relay/postgres-import.js';
import { MemoryRelayNotifications, type RelayNotifications } from '../../packages/relay/notifications.js';
import { RelayClient } from '../../packages/agent-transport/client.js';
import { createProof, signEnvelope, verifyEnvelope, type NodeKeys } from '../../packages/agent-transport/crypto.js';

/** Real, disposable loopback PostgreSQL only. Never accepts a remote URL. */
export async function idleRelayFixture(notifications: RelayNotifications = new MemoryRelayNotifications()) {
  if (process.env.EIGOS_TEST_PG_LOCAL !== '1' || process.env.PGHOST !== '127.0.0.1') throw new Error('Idle regressions require disposable loopback PostgreSQL');
  const directory = mkdtempSync(join(tmpdir(), 'relay-idle-')), path = join(directory, 'relay.sqlite');
  const initial = new RelayStore(path); initial.close();
  const sqlite = new DatabaseSync(path); sqlite.exec('PRAGMA journal_mode=DELETE'); sqlite.close();
  const schema = `eigos_relay_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Client({ ssl: false }); await admin.connect();
  await importRelaySnapshot(admin, path, schema, createHash('sha256').update(readFileSync(path)).digest('hex'));
  const wire: string[] = [], pool = new pg.Pool({ ssl: false, max: 4, application_name: schema });
  pool.on('connect', client => {
    // Observe actual simple-query/extended-parse messages sent by pg, rather
    // than counting wrapper calls that could hide a multi-statement command.
    const connection = Reflect.get(client, 'connection') as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const method of ['query', 'parse']) {
      const original = connection[method]!;
      connection[method] = function (...args: unknown[]) {
        const text = method === 'query' ? args[0] : (args[0] as { text?: string }).text;
        if (typeof text !== 'string') throw new Error('Unobserved PostgreSQL wire statement');
        wire.push(text); return Reflect.apply(original, this, args);
      };
    }
  });
  let offset = 0;
  const store = new PostgresRelayStore(pool, schema, () => Date.now() + offset);
  const external = new PostgresRelayStore(new pg.Pool({ ssl: false, max: 2 }), schema, () => Date.now() + offset);
  let server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const config = readRelayConfig({ EIGOS_RELAY_AUTH_MODE: 'development', EIGOS_RELAY_DEV_TOKEN: 'x'.repeat(32), EIGOS_RELAY_PUBLIC_URL: baseUrl, EIGOS_RELAY_DATABASE_PATH: path });
  const openApp = (channel: RelayNotifications) => createRelayApp(config, { store, notifications: channel, trustedIngressAddress: '203.0.113.12', verifyOwner: async () => ({ issuer: 'synthetic', tenant: 'test', subject: 'owner' }) });
  let app = openApp(notifications); server.on('request', app.app);
  const clients: RelayClient[] = [];
  async function client(name: string) {
    const c = await RelayClient.open({ baseUrl, credentialPath: join(directory, name + '.json'), displayName: name });
    clients.push(c); await c.register('synthetic-owner'); return c;
  }
  async function headers(c: RelayClient) {
    const raw = JSON.parse(readFileSync(join(directory, c.identity.card.name + '.json'), 'utf8'));
    const keys: NodeKeys = { signingKey: raw.signingKey, encryptionKey: raw.encryptionKey, identity: c.identity };
    return { Authorization: 'DPoP ' + raw.secret, DPoP: await createProof(keys, raw.secret, 'GET', baseUrl + '/v1/inbox'), 'X-EIGOS-Agent-ID': c.agentId };
  }
  async function prepareExternal(a: RelayClient, b: RelayClient, connection: string, expiresAt?: number) {
    const id = await a.queue(b.agentId, connection, { fixture: 'external-commit' }, expiresAt ? { expiresAt } : {});
    // Read only this synthetic client's committed private outbox. Its public
    // outbox view intentionally omits ciphertext and credentials.
    const state = new DatabaseSync(join(directory, a.identity.card.name + '.json.sqlite'), { readOnly: true });
    let signed: string;
    try { const row = state.prepare('SELECT envelope FROM node_outbox WHERE id=?').get(id); if (!row || typeof row.envelope !== 'string') throw new Error('Missing synthetic outbox'); signed = row.envelope; } finally { state.close(); }
    const envelope = await verifyEnvelope(signed, a.identity);
    return { id, commit: async () => { await external.send(a.agentId, envelope, signed); return id; } };
  }
  return { admin, schema, pool, store, external, wire, baseUrl, notifications, client, headers, prepareExternal,
    async externallySend(...args: Parameters<typeof prepareExternal>) { return (await prepareExternal(...args)).commit(); },
    async expiringExternalMessage(a: RelayClient, b: RelayClient, connection: string) {
      const raw = JSON.parse(readFileSync(join(directory, a.identity.card.name + '.json'), 'utf8'));
      const keys: NodeKeys = { signingKey: raw.signingKey, encryptionKey: raw.encryptionKey, identity: a.identity };
      const signed = await signEnvelope(keys, b.identity, connection, { fixture: 'expiry-at-dispatch' }, { expiresAt: Date.now() + 2000 });
      const envelope = await verifyEnvelope(signed, a.identity); await external.send(a.agentId, envelope, signed);
    },
    advance(milliseconds: number) { offset += milliseconds; },
    async request(c: RelayClient, seconds = 1, supplied?: Awaited<ReturnType<typeof headers>>) { return fetch(baseUrl + '/v1/inbox?wait=' + seconds, { headers: supplied ?? await headers(c) }); },
    async connect(a: RelayClient, b: RelayClient) { const contact = await a.requestContact(b.agentId); await b.respondContact(contact.id, 'accept'); return contact.id; },
    async restart() {
      app.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      app = openApp(new MemoryRelayNotifications()); server = createServer(app.app); server.listen(address.port, '127.0.0.1'); await once(server, 'listening');
    },
    async close() {
      for (const c of clients) c.close(); app.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await store.close(); await external.close(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); rmSync(directory, { recursive: true, force: true });
    },
  };
}
