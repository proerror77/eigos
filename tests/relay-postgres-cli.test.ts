import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'pg';
import { importRelaySnapshot } from '../packages/relay/postgres-import.js';

const script = fileURLToPath(new URL('../scripts/relay-postgres-import.mjs', import.meta.url));
test('Relay import requires an explicit apply and never prints connection credentials', () => {
  const secret = 'synthetic-secret-not-for-output';
  const env = { ...process.env, EIGOS_RELAY_POSTGRES_URL: `postgresql://postgres:${secret}@localhost/postgres`, EIGOS_RELAY_POSTGRES_CA_FILE: '/tmp/fixture-ca' };
  const result = spawnSync(process.execPath, [script, '--snapshot', '/tmp/snapshot.sqlite', '--expected-file-digest', 'a'.repeat(64), '--schema', 'eigos_relay_test'], { env, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--apply/);
  assert(!result.stdout.includes(secret)); assert(!result.stderr.includes(secret));
});
test('Relay import requires a reviewed source digest before connecting', () => {
  const result = spawnSync(process.execPath, [script, '--apply', '--snapshot', '/tmp/snapshot.sqlite', '--schema', 'eigos_relay_test'], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /expected-file-digest/);
});
test('Relay import rejects connection URL SSL overrides before opening a connection', () => {
  const env = { ...process.env, EIGOS_RELAY_POSTGRES_URL: 'postgresql://postgres:fixture@localhost/postgres?sslmode=disable', EIGOS_RELAY_POSTGRES_CA_FILE: '/tmp/fixture-ca' };
  const result = spawnSync(process.execPath, [script, '--apply', '--snapshot', '/tmp/snapshot.sqlite', '--expected-file-digest', 'a'.repeat(64), '--schema', 'eigos_relay_test'], { env, encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /must not include options/);
});

test('Relay snapshot import refuses a world-readable file or symlink before accessing PostgreSQL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-source-guard-'));
  try {
    const file = join(dir, 'source.sqlite'), link = join(dir, 'link.sqlite');
    writeFileSync(file, 'not a database', { mode: 0o600 }); chmodSync(file, 0o644); symlinkSync(file, link);
    await assert.rejects(importRelaySnapshot({} as Client, file, 'eigos_relay_test', 'a'.repeat(64)), /private regular file/);
    chmodSync(file, 0o600);
    await assert.rejects(importRelaySnapshot({} as Client, link, 'eigos_relay_test', 'a'.repeat(64)), /private regular file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
