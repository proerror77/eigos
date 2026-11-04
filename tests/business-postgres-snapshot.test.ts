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
import { encodeBusinessRow, planBusinessSnapshot } from '../packages/postgres/business-snapshot.js';
import { DefinitionStore } from '../packages/ontology/definition-store.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-business-snapshot-')), path = join(dir, 'business.sqlite');
  const store = new JobStore(path); store.createNetworkStore(); store.close();
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
    INSERT INTO migration_binary_probe VALUES('fixture',x'00FF',9007199254740993);
    CREATE TABLE migration_rowid_probe(id TEXT PRIMARY KEY,rowid TEXT NOT NULL);
    INSERT INTO migration_rowid_probe(_rowid_,id,rowid) VALUES(9007199254740993,'z-first','shadow'),(9007199254740994,'a-second','shadow');`);
  db.prepare('INSERT INTO migration_binary_probe VALUES(?,?,?)').run('large', Buffer.alloc(2 * 1024 * 1024, 0xa5), 1);
  db.exec("INSERT INTO network_events(event_id,kind,object_id,at) VALUES ('event-1','fixture','object','2026'),('event-2','fixture','object','2026'); DELETE FROM network_events WHERE event_id='event-2'");
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
    assert(plan.tables.some(table => table.name === 'migration_sequence_probe' && table.rows === 1 && table.maxIntegerPrimaryKey === '1'));
    assert(plan.tables.some(table => table.name === 'network_events' && table.maxIntegerPrimaryKey === '1'));
    assert.deepEqual(plan.sequences.find(sequence => sequence.table === 'migration_sequence_probe'), { table: 'migration_sequence_probe', lastValue: '9007199254740993' });
    assert(plan.tables.some(table => table.name === 'migration_binary_probe' && table.rows === 2 && table.maxRowBytes > 2 * 1024 * 1024 && table.totalEncodedBytes >= table.maxRowBytes));
    const ordered=plan.tables.find(table=>table.name==='migration_rowid_probe');
    assert.equal(plan.version,2);assert.equal(ordered?.maxRowid,'9007199254740994');
    assert.equal(ordered?.columns.find(column=>column.name==='__eigos_rowid')?.sourceRowidAlias,'_rowid_');
    assert(!plan.sequences.some(sequence => sequence.table === 'network_events'));
    assert(plan.triggers > 0); assert(plan.indexes > 0);
    assert(plan.tables.some(table => table.uniqueKeys.some(key => key.origin === 'pk')));
    assert(plan.tables.some(table => table.uniqueKeys.some(key => key.partial)));
    assert.deepEqual(readFileSync(f.path), bytes);
    assert.deepEqual(planBusinessSnapshot(f.path, f.authorityDigest, f.policy), plan);
    assert.throws(() => planBusinessSnapshot(f.path, '0'.repeat(64), f.policy), /authority/);
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, '0'.repeat(64)), /policy/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('business snapshot preserves a valid stale ontology draft without publishing or rebasing it', () => {
  const f=fixture();
  try {
    let db=new DatabaseSync(f.path);const definitions=new DefinitionStore(db);
    const draft=definitions.createDraft('synthetic-owner','eigos.business','Unpublished working draft',true);
    db.prepare('UPDATE ontology_namespaces SET generation=? WHERE id=?').run(draft.baseGeneration+1,draft.ontologyId);
    assert(definitions.validate(draft.id).issues.some(issue=>issue.code==='base_changed'));
    db.close();
    const before=readFileSync(f.path),plan=planBusinessSnapshot(f.path,f.authorityDigest,f.policy);
    assert.equal(plan.tables.find(table=>table.name==='ontology_definition_drafts')?.rows,1);
    assert.deepEqual(readFileSync(f.path),before);
    db=new DatabaseSync(f.path);const row=db.prepare('SELECT body FROM ontology_definition_drafts WHERE id=?').get(draft.id)!;
    const stored=JSON.parse(String(row.body));assert.deepEqual(stored,draft);assert.equal(stored.baseGeneration,1);
    stored.base.releaseId=randomUUID();db.prepare('UPDATE ontology_definition_drafts SET body=? WHERE id=?').run(JSON.stringify(stored),draft.id);db.close();
    assert.throws(()=>planBusinessSnapshot(f.path,f.authorityDigest,f.policy),/invalid open Ontology draft/);
    db=new DatabaseSync(f.path);const invalidGeneration={...draft,baseGeneration:draft.baseGeneration+2};
    db.prepare('UPDATE ontology_definition_drafts SET body=? WHERE id=?').run(JSON.stringify(invalidGeneration),draft.id);db.close();
    assert.throws(()=>planBusinessSnapshot(f.path,f.authorityDigest,f.policy),/invalid open Ontology draft/);
  } finally {rmSync(f.dir,{recursive:true,force:true});}
});

test('business fingerprint changes when row identities change but primary-key data does not', () => {
  const f=fixture();
  try {
    const before=planBusinessSnapshot(f.path,f.authorityDigest,f.policy).tables.find(table=>table.name==='migration_rowid_probe')!;
    const db=new DatabaseSync(f.path);
    db.exec("UPDATE migration_rowid_probe SET _rowid_=1 WHERE id='z-first'; UPDATE migration_rowid_probe SET _rowid_=9007199254740993 WHERE id='a-second'; UPDATE migration_rowid_probe SET _rowid_=9007199254740994 WHERE id='z-first'");db.close();
    const after=planBusinessSnapshot(f.path,f.authorityDigest,f.policy).tables.find(table=>table.name==='migration_rowid_probe')!;
    assert.equal(after.rows,before.rows);assert.equal(after.maxRowid,before.maxRowid);assert.notEqual(after.digest,before.digest);
    const exhausted=new DatabaseSync(f.path);exhausted.exec("UPDATE migration_rowid_probe SET _rowid_=9223372036854775807 WHERE id='z-first'");exhausted.close();
    assert.throws(()=>planBusinessSnapshot(f.path,f.authorityDigest,f.policy),/Hidden row identity is exhausted/);
    const negative=new DatabaseSync(f.path);negative.exec("UPDATE migration_rowid_probe SET _rowid_=-1 WHERE id='z-first'; UPDATE migration_rowid_probe SET _rowid_=-2 WHERE id='a-second'");negative.close();
    assert.throws(()=>planBusinessSnapshot(f.path,f.authorityDigest,f.policy),/Negative hidden row identity/);
  } finally {rmSync(f.dir,{recursive:true,force:true});}
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
    db.exec("DELETE FROM security_manager; INSERT INTO network_lease VALUES(1,'fixture-holder',9999999999999)"); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /active network lease/);
    db = new DatabaseSync(f.path);
    db.exec("DELETE FROM network_lease; INSERT INTO security_recoveries VALUES('recovery','owner','task','intent','running',1,0,'token',0,'{}',NULL)"); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /running security recovery/);
    db = new DatabaseSync(f.path);
    db.exec("DELETE FROM security_recoveries; INSERT INTO security_fences VALUES('fence','owner','fixture','target',1,'pending')"); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /unresolved permission fence/);
    db = new DatabaseSync(f.path);
    db.exec("DELETE FROM security_fences; INSERT INTO ontology_definition_drafts VALUES('draft','eigos.business','fixture',1,'open','{}')"); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /open Ontology draft/);
    db = new DatabaseSync(f.path);
    db.exec(`DELETE FROM ontology_definition_drafts; INSERT INTO jobs VALUES('bad-job','owner','context','unindexed','2026','2026','{"service":7}')`); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /Job JSON index types/);
    db = new DatabaseSync(f.path);
    db.exec(`UPDATE jobs SET body='{"service":"fixture","delegation":{"nextAt":1.5}}' WHERE id='bad-job'`); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /Job JSON index types/);
    db = new DatabaseSync(f.path);
    db.exec(`UPDATE jobs SET body='{"service":"fixture","delegation":{"nextAt":9007199254740992}}' WHERE id='bad-job'`); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /safe runtime range/);
    for (const body of [
      '{"service":"first","service":"second"}',
      '{"delegation":{"nextAt":1,"nextAt":2}}',
      '{"delegation":{"request":{"revision":1,"revision":2}}}',
    ]) {
      db = new DatabaseSync(f.path); db.prepare('UPDATE jobs SET body=? WHERE id=?').run(body,'bad-job'); db.close();
      assert.throws(() => planBusinessSnapshot(f.path,f.authorityDigest,f.policy), /Duplicate task JSON keys/);
    }
    db = new DatabaseSync(f.path);
    db.exec(`DELETE FROM jobs WHERE id='bad-job'; INSERT INTO network_evidence_cards VALUES('numeric','fixture','{"taskId":1}')`); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /Network identity JSON is incompatible/);
    db = new DatabaseSync(f.path);
    db.exec("DELETE FROM network_evidence_cards; UPDATE migration_sequence_probe SET body='bad' || char(0) || 'text'"); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /NUL text/);
    db = new DatabaseSync(f.path);
    db.exec("UPDATE migration_sequence_probe SET body=CAST(x'80' AS TEXT)"); db.close();
    assert.throws(() => planBusinessSnapshot(f.path, f.authorityDigest, f.policy), /Invalid UTF-8/);
    db = new DatabaseSync(f.path);
    db.exec("UPDATE migration_sequence_probe SET body='first'; CREATE TABLE unsupported_fixture(id TEXT PRIMARY KEY,value REAL)"); db.close();
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

test('source and PostgreSQL row fingerprints preserve 64-bit integer and binary types', () => {
  const columns = [
    { name: 'id', type: 'TEXT', notNull: true, primaryKey: 1 },
    { name: 'value', type: 'INTEGER', notNull: true, primaryKey: 0 },
    { name: 'blob', type: 'BLOB', notNull: true, primaryKey: 0 },
  ];
  const source = { id: 'fixture', value: 9007199254740993n, blob: Uint8Array.from([0, 255]) };
  const target = { id: 'fixture', value: '9007199254740993', blob: Buffer.from([0, 255]) };
  assert.equal(encodeBusinessRow(source, columns, 'sqlite'), encodeBusinessRow(target, columns, 'postgres'));
  assert.throws(() => encodeBusinessRow({ ...source, value: '9007199254740993' }, columns, 'sqlite'), /Unsupported database value/);
  assert.throws(() => encodeBusinessRow({ ...target, value: Number.MAX_SAFE_INTEGER + 1 }, columns, 'postgres'), /Unsupported database value/);
});

test('canonical BLOB encoding preserves only the selected byte view without changing its backing data', () => {
  const columns = [{ name: 'blob', type: 'BLOB', notNull: true, primaryKey: 0 }];
  const backing = Uint8Array.from([17, 0, 255, 34]), before = backing.slice();
  assert.equal(encodeBusinessRow({ blob: backing.subarray(1, 3) }, columns, 'sqlite'), '[{"bytes":"AP8="}]');
  assert.equal(encodeBusinessRow({ blob: Buffer.from(backing.buffer, 1, 2) }, columns, 'postgres'), '[{"bytes":"AP8="}]');
  assert.deepEqual(backing, before);
  const shared = new Uint8Array(new SharedArrayBuffer(4)); shared.set(backing);
  assert.equal(encodeBusinessRow({ blob: shared.subarray(1, 3) }, columns, 'sqlite'), '[{"bytes":"AP8="}]');
  assert.deepEqual(shared, before);
});

test('business import CLI requires explicit apply and rejects TLS overrides without exposing credentials', () => {
  const script = fileURLToPath(new URL('../scripts/business-postgres-import.mjs', import.meta.url));
  const secret = 'synthetic-not-for-output';
  const env = { ...process.env, EIGOS_BUSINESS_POSTGRES_URL: `postgresql://postgres:${secret}@localhost/postgres?sslmode=disable`, EIGOS_BUSINESS_POSTGRES_CA_FILE: '/tmp/fixture-ca' };
  const common = ['--snapshot','/tmp/snapshot.sqlite','--authority','/tmp/authority.json','--policy-digest','a'.repeat(64),'--expected-file-digest','b'.repeat(64),'--schema','eigos_business_test','--max-database-bytes','1000000'];
  const absent = spawnSync(process.execPath, [script, ...common], { env, encoding: 'utf8' });
  assert.equal(absent.status, 2); assert.match(absent.stderr, /--apply/);
  const overridden = spawnSync(process.execPath, [script, '--apply', ...common], { env, encoding: 'utf8' });
  assert.equal(overridden.status, 2); assert.match(overridden.stderr, /must not include options/);
  assert(!absent.stderr.includes(secret)); assert(!overridden.stderr.includes(secret)); assert(!overridden.stdout.includes(secret));
});
