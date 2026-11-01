import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { JobStore } from '../packages/core/store.js';
import { compileBusinessSchema } from '../packages/postgres/business-schema.js';
import { validateBusinessJsonCompatibility } from '../packages/postgres/business-json-compat.js';

test('business schema compiler refuses unreviewed indexes, triggers and conflict rules', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE sample(id TEXT PRIMARY KEY, body TEXT); CREATE INDEX unusual ON sample(length(body))');
    assert.throws(() => compileBusinessSchema(db), /Unreviewed expression/);
    db.exec('DROP INDEX unusual; CREATE TRIGGER unexpected AFTER INSERT ON sample BEGIN SELECT 1; END');
    assert.throws(() => compileBusinessSchema(db), /Unreviewed trigger/);
    db.exec('DROP TRIGGER unexpected; DROP TABLE sample; CREATE TABLE sample(id TEXT PRIMARY KEY, body TEXT UNIQUE ON CONFLICT IGNORE)');
    assert.throws(() => compileBusinessSchema(db), /Unreviewed table semantics/);
    db.exec('DROP TABLE sample; CREATE TABLE sample(id TEXT PRIMARY KEY,rowid TEXT,_rowid_ TEXT,oid TEXT)');
    assert.throws(() => compileBusinessSchema(db), /Hidden row identity/);
    db.exec('DROP TABLE sample; CREATE TABLE sample(id TEXT PRIMARY KEY,__eigos_rowid TEXT)');
    assert.throws(() => compileBusinessSchema(db), /Hidden row identity/);
  } finally { db.close(); }
});

test('synthetic business schema maps to PostgreSQL with guarded history and security uniqueness', { skip: process.env.EIGOS_TEST_RELAY_POSTGRES !== '1' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-business-schema-')), path = join(dir, 'fixture.sqlite');
  const store = new JobStore(path); store.createNetworkStore(); store.close();
  const sqlite = new DatabaseSync(path);
  const schema = `eigos_business_schema_test_${randomBytes(8).toString('hex')}`;
  const ca = process.env.EIGOS_TEST_PG_CA_FILE, local = process.env.EIGOS_TEST_PG_LOCAL === '1';
  if (local && process.env.PGHOST !== '127.0.0.1') throw new Error('Local test mode requires 127.0.0.1');
  if (!local && !ca) throw new Error('EIGOS_TEST_PG_CA_FILE is required');
  const client = new pg.Client({ ssl: local ? false : { ca: readFileSync(ca!, 'utf8'), rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
  let connected = false, transaction = false;
  try {
    const mapping = compileBusinessSchema(sqlite);
    assert(mapping.tables >= 95); assert(mapping.indexes >= 45); assert(mapping.triggers >= 47); assert.equal(mapping.requiresDataValidation, true); assert.equal(mapping.requiresRuntimePort, true);
    await client.connect(); connected = true; await client.query('BEGIN'); transaction = true;
    await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog, pg_temp`);
    await client.query(mapping.schemaStatements.join(';\n'));
    const installed = await client.query('SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal', [schema]);
    assert.equal(installed.rows[0].n, 0);
    // Network invalidation triggers must not rewrite the copied source epoch.
    await client.query(`INSERT INTO network_state VALUES('activity_epoch','0'); INSERT INTO network_evidence_cards VALUES('precopy','owner','{"taskId":"precopy"}'); INSERT INTO jobs VALUES('precopy','owner','context','submitted','2026','2026','{}')`);
    assert.equal((await client.query("SELECT value FROM network_state WHERE key='activity_epoch'")).rows[0].value, '0');
    await client.query("DELETE FROM jobs WHERE id='precopy'; DELETE FROM network_evidence_cards WHERE id='precopy'; DELETE FROM network_state WHERE key='activity_epoch'");
    await client.query(mapping.triggerStatements.join(';\n'));
    assert(mapping.identities.some(identity => identity.table === 'network_events' && !identity.usesSqliteSequence));
    assert(mapping.identities.some(identity => identity.table === 'ontology_pipeline_events' && identity.usesSqliteSequence));
    async function rejectSql(sql: string, code: string) {
      await client.query('SAVEPOINT expected_failure');
      try { await assert.rejects(client.query(sql), error => !!error && typeof error === 'object' && 'code' in error && error.code === code); }
      finally { await client.query('ROLLBACK TO SAVEPOINT expected_failure'); await client.query('RELEASE SAVEPOINT expected_failure'); }
    }
    const localEvent = sqlite.prepare("INSERT INTO network_events(event_id,kind,object_id,at) VALUES('event','fixture','object','2026')").run();
    const remoteEvent = await client.query("INSERT INTO network_events(event_id,kind,object_id,at) VALUES('event','fixture','object','2026') RETURNING seq");
    assert.equal(remoteEvent.rows[0].seq, String(localEvent.lastInsertRowid));
    await client.query("INSERT INTO security_settings VALUES(1,1,'foundation')");
    await rejectSql("INSERT INTO security_settings VALUES(2,1,'foundation')", '23514');
    await client.query("INSERT INTO ontology_object_versions VALUES('eigos.business','owner','type','object',1,'digest',NULL,NULL,'{}',0)");
    await rejectSql("UPDATE ontology_object_versions SET body='changed'", '55000');
    await rejectSql('DELETE FROM ontology_object_versions', '55000');
    await client.query("INSERT INTO security_grants VALUES('g1','agent_access','owner','member','installation',NULL,NULL,1,'active',1,'{}')");
    await rejectSql("INSERT INTO security_grants VALUES('g2','agent_access','owner','member','installation',NULL,NULL,1,'active',1,'{}')", '23505');
    await client.query("INSERT INTO security_grants VALUES('g3','agent_access','owner','member','installation',NULL,NULL,1,'revoked',1,'{}')");
    const malformed = "INSERT INTO jobs VALUES('bad','owner','context','submitted','2026','2026','not-json')";
    assert.throws(() => sqlite.exec(malformed), /malformed JSON/i);
    await rejectSql(malformed, '23514');
    const harmless = "INSERT INTO jobs VALUES('other','owner','context','unindexed','2026','2026','not-json')";
    sqlite.exec(harmless); await client.query(harmless);
    await rejectSql("UPDATE jobs SET __eigos_rowid=999 WHERE id='other'",'428C9');
    await rejectSql("UPDATE jobs SET __eigos_rowid=DEFAULT WHERE id='other'",'55000');
    sqlite.exec("UPDATE network_state SET value='0' WHERE key='activity_epoch'");
    await client.query("INSERT INTO network_state VALUES('activity_epoch','0') ON CONFLICT (key) DO UPDATE SET value='0'");
    const both = async (sql: string) => { sqlite.exec(sql); await client.query(sql); };
    const sameEpoch = async (expected: string) => {
      assert.equal(String(sqlite.prepare("SELECT value FROM network_state WHERE key='activity_epoch'").get()!.value), expected);
      assert.equal((await client.query("SELECT value FROM network_state WHERE key='activity_epoch'")).rows[0].value, expected);
    };
    await both(`INSERT INTO network_evidence_cards VALUES('evidence-1','owner','{"taskId":"task1"}')`);
    const duplicateEvidence = `INSERT INTO network_evidence_cards VALUES('evidence-2','owner','{"taskId":"task1"}')`;
    assert.throws(() => sqlite.exec(duplicateEvidence), /UNIQUE constraint/i); await rejectSql(duplicateEvidence, '23505');
    await rejectSql(`INSERT INTO network_evidence_cards VALUES('numeric','owner','{"taskId":1}')`, '23514');
    await both(`INSERT INTO jobs VALUES('task1','owner','context','submitted','2026','2026','{}')`); await sameEpoch('1');
    await both("UPDATE jobs SET updated_at='2027' WHERE id='other'"); await sameEpoch('1');
    await both("UPDATE jobs SET state='working' WHERE id='task1'");
    await both("DELETE FROM jobs WHERE id='task1'"); await sameEpoch('3');
    await both("INSERT INTO action_intents VALUES('intent','owner','task1','business','ready','{}','{}')"); await sameEpoch('4');
    await both("INSERT INTO ontology_objects VALUES('owner','type','object',1,'digest','{}')"); await sameEpoch('5');
    await both("DELETE FROM ontology_objects WHERE id='object'"); await sameEpoch('6');
    await both("INSERT INTO outcome_feedback VALUES('task1','owner','binding','{}')"); await sameEpoch('7');
    await both("INSERT INTO ontology_links VALUES('owner','link','type','from','type','to','digest')"); await sameEpoch('8');
    const compatible = await validateBusinessJsonCompatibility(sqlite, client, schema);
    assert.equal(compatible.jobs, 1); assert.equal(compatible.network_evidence_cards, 1);
    sqlite.prepare('INSERT INTO ontology_objects VALUES(?,?,?,?,?,?)').run('owner','type','json-nul',1,'digest',JSON.stringify({ value: '\u0000' }));
    await assert.rejects(validateBusinessJsonCompatibility(sqlite, client, schema), /JSON compatibility mismatch in ontology_objects/);


  } finally {
    if (connected && transaction) await client.query('ROLLBACK');
    await client.end(); sqlite.close(); rmSync(dir, { recursive: true, force: true });
  }
});
