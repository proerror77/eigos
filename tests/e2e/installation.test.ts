import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, cp, symlink, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Database } from '../../packages/runtime/database.js';

test('an independently built host installs Shipment and resumes its PA Action after a Worker restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ontology-install-'));
  const url = process.env.EIGOS_TEST_DATABASE_URL!;
  assert.equal(new URL(url).hostname, '127.0.0.1');
  assert.equal(new URL(url).password, 'synthetic-only');
  const schema = 'eigos_shipment_' + randomUUID().replaceAll('-', '');
  const db = new Database(url, schema);
  const processes = new Set<ChildProcess>();
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, 'exit'), force = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGTERM');
    try { await ended; } finally { clearTimeout(force); }
  };
  try {
    await cp('dist/engine', root, { recursive: true });
    await cp('packages/solutions/shipment', join(root, 'freight'), { recursive: true });
    await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    const socket = createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const address = socket.address(); assert(address && typeof address !== 'string');
    await new Promise<void>(resolve => socket.close(() => resolve()));
    const base = 'http://127.0.0.1:' + address.port, token = 'shipment-process-test-'.repeat(2);
    const env = { DATABASE_URL: url, EIGOS_PG_SCHEMA: schema, EIGOS_AUTH_MODE: 'development',
      EIGOS_DEV_TOKEN: token, PUBLIC_URL: base, PORT: String(address.port),
      EIGOS_SOLUTION_MANIFEST: join(root, 'freight/installation.json') };
    const options = { env, cwd: root };
    const entry = 'apps/engine.js', cli = (...args: string[]) => promisify(execFile)(process.execPath, [entry, ...args], options);
    await cli('initialize');
    const release = JSON.parse((await cli('publish')).stdout).release;
    await cli('grant-business', 'local-developer');
    const types = await promisify(execFile)(process.execPath, ['scripts/generate-ontology-sdk.js', 'freight/ontology.json'], options);
    assert.match(types.stdout, /RegisterShipment/);
    const modulePath = join(root, 'freight/implementation.mjs'), bytes = await readFile(modulePath);
    await writeFile(modulePath, Buffer.concat([bytes, Buffer.from('\n')]));
    await assert.rejects(cli('publish'), /Implementation digest differs/);
    await writeFile(modulePath, bytes);
    let logs = '';
    const start = (role: string) => {
      const child = spawn(process.execPath, [entry, role], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => { logs += chunk; });
      child.stderr.on('data', chunk => { logs += chunk; });
      processes.add(child); return child;
    };
    const api = async (path: string, body?: unknown) => {
      const res = await fetch(base + path, { method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
        body: body ? JSON.stringify(body) : undefined });
      const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data;
    };
    const waitFor = async (read: () => Promise<boolean>) => {
      const until = Date.now() + 20000;
      while (!await read()) {
        assert(Date.now() < until, 'Timed out: ' + logs);
        await delay(50);
      }
    };
    start('gateway'); start('indexer'); let worker = start('worker');
    await waitFor(() => api('/health').then(r => r.ontologyRelease === release).catch(() => false));
    const card = await api('/.well-known/agent-card.json');
    assert.equal(card.name, 'Shipment');
    assert.deepEqual((await api('/ontology/query', { query: { type: 'Shipment' } })).items, []);
    const response = await api('/a2a', { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: {
      messageId: 'shipment-register', role: 'ROLE_USER',
      parts: [{ data: { action: { action: 'RegisterShipment', input: { id: 's1' } } }, mediaType: 'application/json' }] } } });
    const id = response.result?.task?.id; assert(id, JSON.stringify(response));
    await waitFor(async () => (await api('/tasks/' + id)).state === 'input-required');
    await stop(worker);
    const pending = await api('/tasks/' + id);
    const answer = { requestId: pending.inputRequest.requestId, response: { name: 'synthetic freight' } };
    await api('/tasks/' + id + '/pa-response', answer);
    await api('/tasks/' + id + '/pa-response', answer);
    worker = start('worker');
    await waitFor(async () => {
      const task = await api('/tasks/' + id); assert.notEqual(task.state, 'failed', JSON.stringify(task)); return task.state === 'completed';
    });
    assert.equal((await api('/ontology/functions', { function: 'ReadShipment', input: { id: 's1' } })), 'synthetic freight');
    const rows = await db.query(`SELECT id,release,ontology FROM ${db.schema}.tasks`);
    assert.deepEqual(rows.rows, [{ id, release, ontology: 'Shipment' }]);
    await stop(worker);
    const cancel = await api('/tasks', { requestId: 'cancel', message: 'Cancel before model execution' });
    assert.equal((await api('/tasks/' + cancel.id + '/cancel', {})).state, 'canceled');
  } finally {
    await Promise.all([...processes].map(stop));
    await db.query('DROP SCHEMA IF EXISTS ' + db.schema + ' CASCADE'); await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
