import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { auditImportedIdentities } from '../packages/postgres/identity-audit.js';

test('identity audit binds receipts and detects revoked, blocked and mismatched active identities', { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
  const suffix = randomUUID().replaceAll('-', ''), businessSchema = `eigos_business_${suffix}`, membershipSchema = `eigos_membership_${suffix}`;
  const ca = process.env.EIGOS_TEST_PG_CA_FILE;
  const client = new pg.Client(ca ? { ssl: { ca: readFileSync(ca, 'utf8'), rejectUnauthorized: true } } : {}); await client.connect();
  const b = `"${businessSchema}"`, m = `"${membershipSchema}"`, businessFileDigest = 'a'.repeat(64), membershipFileDigest = 'b'.repeat(64), now = Date.now();
  try {
    await client.query(`CREATE SCHEMA ${b}; CREATE SCHEMA ${m};
      CREATE TABLE ${b}.eigos_migration_receipt(slot BIGINT PRIMARY KEY,body JSONB NOT NULL);
      CREATE TABLE ${m}.eigos_membership_migration_receipt(slot BIGINT PRIMARY KEY,body JSONB NOT NULL);
      CREATE TABLE ${b}.security_subjects(installation_id TEXT PRIMARY KEY,owner TEXT NOT NULL,member_id TEXT NOT NULL,client_id TEXT NOT NULL,state TEXT NOT NULL,valid_until BIGINT NOT NULL);
      CREATE TABLE ${m}.members(id TEXT PRIMARY KEY,issuer TEXT,tenant TEXT,subject TEXT,status TEXT,accepted_at TEXT);
      CREATE TABLE ${m}.agent_registrations(id TEXT PRIMARY KEY,member_id TEXT,client_id TEXT,revoked BIGINT);
      CREATE TABLE ${m}.member_connections(member_id TEXT,client_id TEXT,blocked BIGINT,UNIQUE(member_id,client_id))`);
    await client.query(`INSERT INTO ${b}.eigos_migration_receipt VALUES(1,$1)`, [JSON.stringify({ version:1,status:'imported-not-activated',sourceFileDigest:businessFileDigest })]);
    await client.query(`INSERT INTO ${m}.eigos_membership_migration_receipt VALUES(1,$1)`, [JSON.stringify({ version:1,status:'imported-not-activated',sourceFileDigest:membershipFileDigest })]);
    await client.query(`INSERT INTO ${m}.members VALUES('m','issuer','tenant','subject','active','2026'); INSERT INTO ${m}.agent_registrations VALUES('i','m','client',0); INSERT INTO ${m}.member_connections VALUES('m','client',0)`);
    await client.query(`INSERT INTO ${b}.security_subjects VALUES('i',$1,'m','client','active',$2)`, [JSON.stringify(['issuer','tenant','subject']),now+60000]);
    const options = { businessSchema,membershipSchema,businessFileDigest,membershipFileDigest,now };
    assert.deepEqual(await auditImportedIdentities(client,options), {version:1,status:'audit-only',checkedAt:now,activeSubjects:1,mismatchedSubjects:0,runtimeActivated:false});
    await client.query(`UPDATE ${m}.agent_registrations SET revoked=1`);
    assert.equal((await auditImportedIdentities(client,options)).mismatchedSubjects,1);
    await client.query(`UPDATE ${m}.agent_registrations SET revoked=0; UPDATE ${m}.member_connections SET blocked=1`);
    assert.equal((await auditImportedIdentities(client,options)).mismatchedSubjects,1);
    await client.query(`UPDATE ${m}.member_connections SET blocked=0; UPDATE ${b}.security_subjects SET owner='wrong'`);
    assert.equal((await auditImportedIdentities(client,options)).mismatchedSubjects,1);
    await assert.rejects(auditImportedIdentities(client,{...options,membershipFileDigest:'c'.repeat(64)}), /receipt/);
    await assert.rejects(auditImportedIdentities(client,{...options,businessSchema:'public;DROP TABLE x'}), /Invalid/);
  } finally { await client.query(`DROP SCHEMA IF EXISTS ${b} CASCADE; DROP SCHEMA IF EXISTS ${m} CASCADE`); await client.end(); }
});

test('identity audit CLI requires reviewed inputs and forbids TLS overrides', () => {
  const script = fileURLToPath(new URL('../scripts/postgres-identity-audit.mjs', import.meta.url));
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2);
  const secret = 'synthetic-secret';
  const result = spawnSync(process.execPath, [script, '--business-schema', 'eigos_business_fixture', '--membership-schema', 'eigos_membership_fixture', '--business-digest', 'a'.repeat(64), '--membership-digest', 'b'.repeat(64)], { encoding: 'utf8', env: { ...process.env, EIGOS_BUSINESS_POSTGRES_URL: `postgresql://user:${secret}@localhost/db?sslmode=disable`, EIGOS_BUSINESS_POSTGRES_CA_FILE: '/tmp/ca.pem' } });
  assert.equal(result.status, 2); assert(!result.stderr.includes(secret));
});
