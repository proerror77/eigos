import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { fixture, route } from '../fixture.js';

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const ended = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await ended; } finally { clearTimeout(timer); }
}
test('separate Gateway and Worker receive a message and return the original quote through PostgreSQL', async t => {
  const f = await fixture(), token = 'process-test-token-'.repeat(3);
  const portServer = createServer().listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const address = portServer.address(); assert(address && typeof address !== 'string'); const port = address.port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const env = { ...process.env, DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_PG_SCHEMA: f.schema, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, PUBLIC_URL: `http://127.0.0.1:${port}`, PORT: String(port) };
  const gateway = fork(new URL('../../apps/gateway/main.js', import.meta.url), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const worker = fork(new URL('./worker.js', import.meta.url), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const url = env.PUBLIC_URL, headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await fetch(url + '/health').then(response => response.ok).catch(() => false)) break;
      await delay(50);
    }
    const started = performance.now();
    const input = { requestId: 'e2e-route', message: '上海从中企云翠森林到前滩太古里，只询价', route };
    const submitted = await fetch(url + '/tasks', { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(submitted.status, 200);
    let task = await submitted.json() as { id: string; state: string; result: { accepted: boolean; estimates: unknown[] } };
    while (['working', 'submitted'].includes(task.state) && performance.now() - started < 20000) {
      await delay(25); task = await (await fetch(url + '/tasks/' + task.id, { headers })).json() as typeof task;
    }
    assert.equal(task.state, 'completed', JSON.stringify(task));
    assert.equal(task.result.accepted, false); assert.equal(task.result.estimates.length, 2);
    assert(performance.now() - started < 20000);
    const again = await (await fetch(url + '/tasks', { method: 'POST', headers, body: JSON.stringify(input) })).json() as typeof task;
    assert.equal(again.id, task.id);
    t.diagnostic(JSON.stringify({ messageToQuoteMs: Math.round(performance.now() - started), source: 'synthetic MCP responses', database: 'PostgreSQL', processes: ['Gateway', 'Worker'] }));
  } finally { await Promise.all([stop(gateway), stop(worker)]); await f.close(); }
});
