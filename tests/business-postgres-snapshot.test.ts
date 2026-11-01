import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JobStore } from '../packages/core/store.js';
import { installRuntimeAuthority, runtimeAuthorityDigest, type RuntimeAuthority } from '../packages/core/runtime-authority.js';
import { planBusinessSnapshot } from '../packages/postgres/business-snapshot.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-business-snapshot-')), path = join(dir, 'business.sqlite');
  const store = new JobStore(path); store.close();
  const db = new DatabaseSync(path);
  const authority: RuntimeAuthority = {
    version: 1, id: randomUUID(), revision: 1, canonicalOrigin: 'https://eigos.example', issuer: 'https://issuer.example', ontologyId: 'eigos.business',
    databasePath: path, membershipDatabasePath: join(dir, 'members.sqlite'),
    ingresses: [{ origin: 'https://eigos.example', audience: 'https://eigos.example', tenantClaim: 'tenant_id', agentClientId: 'agent', agentClientIds: ['agent'], nativeClientIds: [], browserRedirect: false, newRegistrations: true }],
  };
  installRuntimeAuthority(db, authority);
  db.exec(`CREATE TABLE migration_sequence_probe(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
    INSERT INTO migration_sequence_probe(body) VALUES ('first'),('second'); DELETE FROM migration_sequence_probe WHERE id=2;
    INSERT INTO migration_sequence_probe(id,body) VALUES (9007199254740993,'high'); DELETE FROM migration_sequence_probe WHERE id=9007199254740993;
    CREATE TABLE migration_binary_probe(id TEXT PRIMARY KEY, payload BLOB NOT NULL, value INTEGER NOT NULL);
    INSERT INTO migration_binary_probe VALUES('fixture',x'00FF',9007199254740993);`);
  const policy = String(db.prepare('SELECT digest FROM security_policy_definitions WHERE slot=1').get()!.digest);
  db.exec('PRAGMA journal_mode=DELETE'); db.close();
  return { dir, path, authorityDigest: runtimeAuthorityDigest(authority), policy };
}

test('business snapshot inventory binds authority, policy, rows, triggers and sequence without changing the file', () => {
  const f = fixture();
  try {
    const bytes = readFileSync(f.path), plan = planBusinessSnapshot(f.path, f.authorityDigest, f.policy);
    assert.equal(plan.purpose, 'inventory-only'); assert.equal(plan.authority.digest, f.authorityDigest);
    assert(plan.tables.some(table => table.name === 'ontology_definition_releases' && table.rows > 0));
    assert(plan.tables.some(table => table.name === 'migration_sequence_probe' && table.rows === 1));
    assert.deepEqual(plan.sequences.find(sequence => sequence.table === 'migration_sequence_probe'), { table: 'migration_sequence_probe', lastValue: '9007199254740993' });
    assert(plan.tables.some(table => table.name === 'migration_binary_probe' && table.rows === 1));
    assert(plan.triggers > 0); assert(plan.indexes > 0);
    assert(plan.tables.some(table => table.uniqueKeys.some(key => key.origin === 'pk')));
    assert(plan.tables.some(table => table.uniqueKeys.some(key => key.partial)));
    assert.deepEqual(readFileSync(f.path), bytes);
    assert.deepEqual(planBusinessSnapshot(f.path, f.authorityDigest, f.policy), plan);
    assert.throws(() => planBusinessSnapshot(f.path, '0'.repeat(64), f.policy), /authority/);
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, '0'.repeat(64)), /policy/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('business snapshot inventory fails closed for active claims, drafts and unsupported values', () => {
  const f = fixture();
  try {
    let db = new DatabaseSync(f.path);
    db.exec("INSERT INTO work_claims VALUES('fixture-job','fixture-token',1,1)"); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /Worker claims/);
    db = new DatabaseSync(f.path);
    db.exec("DELETE FROM work_claims; INSERT INTO security_manager VALUES(1,'fixture-manager',9999999999999)"); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /active security manager/);
    db = new DatabaseSync(f.path);
    db.exec("DELETE FROM security_manager; INSERT INTO security_recoveries VALUES('recovery','owner','task','intent','running',1,0,'token',0,'{}',NULL)"); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /running security recovery/);
    db = new DatabaseSync(f.path);
    db.exec("DELETE FROM security_recoveries; INSERT INTO security_fences VALUES('fence','owner','fixture','target',1,'pending')"); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /unresolved permission fence/);
    db = new DatabaseSync(f.path);
    db.exec("DELETE FROM security_fences; INSERT INTO ontology_definition_drafts VALUES('draft','eigos.business','fixture',1,'open','{}')"); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /open Ontology draft/);
    db = new DatabaseSync(f.path);
    db.exec("DELETE FROM ontology_definition_drafts; CREATE TABLE unsupported_fixture(id TEXT PRIMARY KEY,value REAL)"); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /Unsupported column type/);
    db = new DatabaseSync(f.path);
    db.exec("DROP TABLE unsupported_fixture; CREATE TABLE generated_fixture(id TEXT PRIMARY KEY,x TEXT,derived TEXT GENERATED ALWAYS AS (x || 'y') STORED)"); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /Generated or hidden column/);
    db = new DatabaseSync(f.path);
    db.exec("DROP TABLE generated_fixture; CREATE TABLE without_rowid_fixture(id TEXT PRIMARY KEY) WITHOUT ROWID"); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /WITHOUT ROWID/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('business preflight CLI refuses incomplete input before reading any files', () => {
  const script = fileURLToPath(new URL('../scripts/business-postgres-preflight.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--snapshot', '/tmp/not-a-real-snapshot', '--authority', '/tmp/not-an-authority', '--policy-digest', 'invalid'], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /policy-digest/);
});
