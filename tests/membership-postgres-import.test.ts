import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MemberStore } from '../packages/members/store.js';
import { importMembershipSnapshot } from '../packages/postgres/membership-import.js';

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
test('membership import preserves identity, revoked installations and sessions and rejects changed schemas', { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-member-test-')), path = join(dir, 'members.sqlite');
  const store = new MemberStore(path);
  const member = store.login({ issuer: 'issuer', tenant: 'tenant', subject: 'subject' });
  store.apply(member.id, { displayName: 'Example', locale: 'en', timezone: 'UTC', consent: true }, false);
  const session = store.createSession(member.id);
  const principal = { issuer: 'issuer', tenant: 'tenant', subject: 'subject', clientId: 'native-client', scopes: ['tasks:read'] };
  store.authorize(principal);
  const native = store.agents.authorizeNative(principal, member.id, 'synthetic-access-token', Date.now() + 60000);
  const connection = store.connections(member.id)[0]!; store.block(member.id, connection.id, true);
  const invitation = store.agents.invite(member.id); store.agents.revokeInvitation(invitation.id);
  const id = randomUUID(), credential = 'a'.repeat(43);
  store.agents.create({ registrationId: id, displayName: 'Agent' }, credential);
  for (let i = 0; i < 70; i++) store.agents.create({ registrationId: randomUUID(), displayName: 'Agent' }, credential);
  store.close();
  const sqlite = new DatabaseSync(path); sqlite.exec("PRAGMA journal_mode=DELETE; UPDATE agent_registrations SET revoked=1"); sqlite.close(); chmodSync(path, 0o600);
  const ca = process.env.EIGOS_TEST_PG_CA_FILE;
  const client = new pg.Client(ca ? { ssl: { ca: readFileSync(ca, 'utf8'), rejectUnauthorized: true } } : {}); await client.connect(); const schema = `eigos_membership_${randomUUID().replaceAll('-','')}`;
  try {
    const budgetSchema = `eigos_membership_${randomUUID().replaceAll('-','')}`;
    await assert.rejects(importMembershipSnapshot(client, path, budgetSchema, digest(path), 1), /budget exceeded/);
    assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [budgetSchema])).rowCount, 0);
    const result = await importMembershipSnapshot(client, path, schema, digest(path), Number.MAX_SAFE_INTEGER);
    assert.equal(result.status, 'imported-not-activated');
    const row = await client.query(`SELECT status FROM "${schema}".members WHERE id=$1`, [member.id]); assert.equal(row.rows[0].status, 'active');
    assert.equal(result.tables.find(table => table.table === 'agent_registrations')?.rows, 72);
    const sessions = await client.query(`SELECT count(*)::int n FROM "${schema}".member_sessions`); assert.equal(sessions.rows[0].n, 1);
    const registration = await client.query(`SELECT revoked FROM "${schema}".agent_registrations WHERE id=$1`, [id]); assert.equal(registration.rows[0].revoked, '1');
    assert.equal((await client.query(`SELECT blocked FROM "${schema}".member_connections WHERE id=$1`, [connection.id])).rows[0].blocked, '1');
    const nativeRow = (await client.query(`SELECT kind,revoked FROM "${schema}".agent_registrations WHERE id=$1`, [native.id])).rows[0];
    assert.equal(nativeRow.kind, 'native_mcp'); assert.equal(nativeRow.revoked, '1');
    assert.equal((await client.query(`SELECT revoked FROM "${schema}".member_invitations WHERE id=$1`, [invitation.id])).rows[0].revoked, '1');
    assert.equal((await client.query(`SELECT count(*)::int n FROM "${schema}".agent_access_tokens`)).rows[0].n, 1);
    assert(!JSON.stringify(result).includes(session.token)); assert(!JSON.stringify(result).includes(invitation.token));
    await assert.rejects(client.query(`DELETE FROM "${schema}".eigos_membership_migration_receipt`), /immutable/);
    await assert.rejects(importMembershipSnapshot(client, path, schema, digest(path), Number.MAX_SAFE_INTEGER), /already exists/);
    const uncertainSchema = `eigos_membership_${randomUUID().replaceAll('-','')}`;
    const uncertainClient = { query: async (sql: string, values?: unknown[]) => { const result = await client.query(sql, values); if (sql === 'COMMIT') throw new Error('lost response'); return result; } } as unknown as pg.Client;
    try {
      await assert.rejects(importMembershipSnapshot(uncertainClient, path, uncertainSchema, digest(path), Number.MAX_SAFE_INTEGER), /commit outcome is unknown/);
      assert.equal((await client.query(`SELECT body->>'status' AS status FROM "${uncertainSchema}".eigos_membership_migration_receipt`)).rows[0].status, 'imported-not-activated');
    } finally { await client.query(`DROP SCHEMA IF EXISTS "${uncertainSchema}" CASCADE`); }
    const broken = new DatabaseSync(path); broken.exec("UPDATE members SET display_name='bad' || char(0) || 'name'"); broken.close();
    const rollbackSchema = `eigos_membership_${randomUUID().replaceAll('-','')}`;
    await assert.rejects(importMembershipSnapshot(client, path, rollbackSchema, digest(path), Number.MAX_SAFE_INTEGER), /contains NUL/);
    const absent = await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [rollbackSchema]); assert.equal(absent.rowCount, 0);
    const invalidUtf8 = new DatabaseSync(path); invalidUtf8.exec("UPDATE members SET display_name=CAST(x'80' AS TEXT)"); invalidUtf8.close();
    await assert.rejects(importMembershipSnapshot(client, path, `eigos_membership_${randomUUID().replaceAll('-','')}`, digest(path), Number.MAX_SAFE_INTEGER), /not valid UTF-8/);
    const altered = new DatabaseSync(path); altered.exec('CREATE TABLE unreviewed(id TEXT PRIMARY KEY)'); altered.close();
    await assert.rejects(importMembershipSnapshot(client, path, `${schema}_bad`, digest(path), Number.MAX_SAFE_INTEGER), /Unexpected membership schema/);
  } finally { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end(); rmSync(dir, { recursive: true, force: true }); }
});

test('membership import CLI requires explicit apply and rejects connection options', () => {
  const script = fileURLToPath(new URL('../scripts/membership-postgres-import.mjs', import.meta.url));
  const absent = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(absent.status, 2);
  const token = 'synthetic-secret';
  const invalid = spawnSync(process.execPath, [script, '--apply', '--snapshot', '/tmp/member.sqlite', '--expected-file-digest', 'a'.repeat(64), '--schema', 'eigos_membership_fixture', '--max-database-bytes', '1000000000'], { encoding: 'utf8', env: { ...process.env, EIGOS_BUSINESS_POSTGRES_URL: `postgresql://user:${token}@localhost/database?sslmode=disable`, EIGOS_BUSINESS_POSTGRES_CA_FILE: '/tmp/ca.pem' } });
  assert.equal(invalid.status, 2); assert(!invalid.stderr.includes(token));
});
