import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('E2E: a compiled Gateway serves the complete PA skill from its built assets without a member or business grant', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-pa-site-process-'));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `https://127.0.0.1:${port}`, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [resolve('dist/apps/gateway/main.js')], {
    env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port), PUBLIC_URL: origin,
      DATABASE_PATH: join(directory, 'tasks.sqlite'), MEMBERSHIP_DATABASE_PATH: join(directory, 'members.sqlite'),
      EIGOS_AUTH_MODE: 'jwt', OAUTH_ISSUER: 'https://identity.example/', OAUTH_JWKS_URL: 'https://identity.example/jwks',
      OAUTH_AUDIENCE: origin, OIDC_AGENT_CLIENT_ID: 'public-connector', OIDC_MCP_CLIENT_ID: 'public-native' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) assert.fail(`Gateway exited: ${output}`);
      try { ready = (await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok; } catch { /* Startup is still pending. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, output);
    const guide = await (await fetch(base + '/connect/agent.json')).json(); assert.equal(guide.origin, origin);
    for (const path of ['/connect', '/connect/SKILL.md', '/connect/references/a2a.md', '/connect/references/relay.md', '/connect/references/test-payments.md', '/connect/scripts/eigos_a2a.py']) {
      const response = await fetch(base + path); assert.equal(response.status, 200, path); assert((await response.text()).length > 0);
    }
    const archive = await fetch(base + '/connect/eigos-delegate.tar.gz'); assert.equal(archive.status, 200);
    assert(archive.headers.get('content-disposition')?.includes('attachment'));
    assert((await archive.arrayBuffer()).byteLength > 1000);
    assert.equal((await fetch(base + '/mcp')).status, 401);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timer); rmSync(directory, { recursive: true, force: true });
  }
});
