import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { RelayClient } from '../../packages/agent-transport/client.js';

async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  server.close(); await once(server, 'close'); return address.port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit'); child.kill('SIGTERM'); await done;
}

test('independent Relay process persists offline ciphertext; synthetic PA coordination and node restart return the same candidate contract', { timeout: 45000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-relay-process-')), listenPort = await port(), token = randomBytes(32).toString('base64url');
  const baseUrl = `http://127.0.0.1:${listenPort}`, databasePath = join(directory, 'relay.sqlite');
  const env = { ...process.env, NODE_ENV: 'test', EIGOS_RELAY_AUTH_MODE: 'development', EIGOS_RELAY_DEV_TOKEN: token,
    EIGOS_RELAY_HOST: '127.0.0.1', EIGOS_RELAY_PORT: String(listenPort), EIGOS_RELAY_PUBLIC_URL: baseUrl,
    EIGOS_RELAY_DATABASE_PATH: databasePath, EIGOS_RELAY_EXAMPLE_DIRECTORY: join(directory, 'demo') };
  const start = async () => {
    const child = spawn(process.execPath, [resolve('dist/apps/relay/main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout!.on('data', data => { output += String(data); }); child.stderr!.on('data', data => { output += String(data); });
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error('Relay failed to start');
        try { const response = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(500) }); if (response.ok) return { child, output: () => output }; } catch { /* startup only */ }
        await sleep(50);
      }
      throw new Error('Relay readiness timed out');
    } catch (error) { await stop(child); throw error; }
  };
  let relay: Awaited<ReturnType<typeof start>> | undefined, a: RelayClient | undefined, b: RelayClient | undefined;
  try {
    relay = await start();
    const runExample = () => {
      const result = spawnSync(process.execPath, [resolve('dist/examples/relay-pa-coordination.js')], { env, encoding: 'utf8', timeout: 12000 });
      assert.equal(result.status, 0, result.stderr);
      const value = JSON.parse(result.stdout.trim()); assert.equal(value.execution, 'synthetic');
      assert.deepEqual(value.result.slots, ['fixture-day 16:00']); assert.equal(value.result.calendarWritten, false); return value;
    };
    runExample();
    const optionsA = { baseUrl, credentialPath: join(directory, 'offline-a.json'), displayName: 'Offline A' },
      optionsB = { baseUrl, credentialPath: join(directory, 'offline-b.json'), displayName: 'Offline B' };
    a = await RelayClient.open(optionsA); b = await RelayClient.open(optionsB);
    await a.register(token); await b.register(token); const connection = await a.requestContact(b.agentId); await b.respondContact(connection.id, 'accept');
    const senderId = a.agentId; b.close(); b = undefined;
    const sent = await a.send(connection.recipient, connection.id, { privateFixture: 'offline-fixture-never-in-relay-plaintext' });
    a.close(); a = undefined; const before = relay.output(); await stop(relay.child);
    relay = await start(); b = await RelayClient.open(optionsB);
    const received = await b.poll(); assert.equal(received.length, 1); assert.equal(received[0]!.id, sent.id);
    b.close(); b = await RelayClient.open(optionsB); assert.equal((await b.pending())[0]!.id, sent.id);
    b.markHandled(senderId, sent.id); assert.deepEqual(await b.poll(), []); b.close(); b = undefined;
    runExample();
    const data = Buffer.concat(readdirSync(directory).filter(name => name.startsWith('relay.sqlite')).map(name => readFileSync(join(directory, name))));
    for (const secret of [token, 'offline-fixture-never-in-relay-plaintext']) { assert(!data.includes(Buffer.from(secret))); assert(!(before + relay.output()).includes(secret)); }
  } finally { a?.close(); b?.close(); if (relay) await stop(relay.child); rmSync(directory, { recursive: true, force: true }); }
});
