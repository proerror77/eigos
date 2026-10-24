import { CURRENT_KERNEL_VERSION } from '../../packages/ontology/seed-definition.js';
// Process/configuration verification only. No model or public Luma page is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { JobStore } from '../../packages/core/store.js';
import { BACKEND_VERSION } from '../../packages/ontology/execution.js';
import { participantDeploymentSettings } from '../../packages/capabilities/free-booking/runtime-config.js';

async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); return value;
}
test('E2E: one managed launcher starts and stops Gateway, Worker and the resident participant browser queue', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-participant-process-')), taskDatabasePath = join(directory, 'tasks.sqlite');
  const store = new JobStore(taskDatabasePath); store.close();
  const gatewayPort = await port(), bridgePort = await port(), bearer = randomBytes(32).toString('hex'), release = 'f'.repeat(64);
  const config = { bindingId: 'synthetic-process-only', attendeeRef: 'a'.repeat(64), port: bridgePort, taskDatabasePath, databasePath: join(directory, 'queue.sqlite'), evidenceDirectory: join(directory, 'evidence'), workerTokenFile: join(directory, 'worker-token'), operatorTokenFile: join(directory, 'operator-token') };
  for (const file of [config.workerTokenFile, config.operatorTokenFile]) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  const file = join(directory, 'browser.json'); writeFileSync(file, JSON.stringify(config));
  const settings = participantDeploymentSettings({ EIGOS_FREE_BOOKING_BROWSER_CONFIG: file }, {}, taskDatabasePath);
  const child = spawn(process.execPath, [resolve('scripts/run-local.mjs'), '--built'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: '1', NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(gatewayPort), PUBLIC_URL: `http://127.0.0.1:${gatewayPort}`, DATABASE_PATH: taskDatabasePath, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: bearer, EIGOS_EXECUTOR: 'disabled', EIGOS_RELEASE_DIGEST: release, ...settings }, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = ''; child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-3000); });
  const gateway = `http://127.0.0.1:${gatewayPort}`, bridge = `http://127.0.0.1:${bridgePort}`;
  try {
    let ready = false;
    for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
      if (child.exitCode !== null) assert.fail('Managed launcher exited: ' + diagnostics);
      try {
        const health = await Promise.all([gateway, bridge].map(origin => fetch(origin + '/health', { signal: AbortSignal.timeout(500) }).then(r => r.json())));
        if (health.every(value => value.backend === BACKEND_VERSION && value.releaseDigest === release)) { ready = true; break; }
      } catch { /* Wait for the independently started processes. */ }
      await new Promise(done => setTimeout(done, 50));
    }
    assert(ready, diagnostics);
    const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };
    const model = await fetch(gateway + '/ontology/describe', { method: 'POST', headers, body: JSON.stringify({ search: 'Registration', limit: 5 }) }).then(r => r.json());
    assert.equal(model.model.version, CURRENT_KERNEL_VERSION); assert(['RegistrationTask', 'RegistrationOffer', 'RegistrationRecord'].every(id => model.types.some((type: { id: string }) => type.id === id)));
    const card = await fetch(gateway + '/.well-known/agent-card.json').then(r => r.json());
    assert.match(card.skills[0].description, /booking\.participant\.free/);
    assert.equal((await fetch(bridge + '/operator/next')).status, 403);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000); timer.unref();
      await exited; clearTimeout(timer);
    }
    for (const origin of [gateway, bridge]) await assert.rejects(fetch(origin + '/health', { signal: AbortSignal.timeout(500) }));
    rmSync(directory, { recursive: true, force: true });
  }
});
