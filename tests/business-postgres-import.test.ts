import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { JobStore } from '../packages/core/store.js';
import { installRuntimeAuthority, runtimeAuthorityDigest, type RuntimeAuthority } from '../packages/core/runtime-authority.js';
import { planBusinessSnapshot } from '../packages/postgres/business-snapshot.js';
import { importBusinessSnapshot } from '../packages/postgres/business-import.js';
import { verifyBusinessSnapshot } from '../packages/postgres/business-verify.js';

const enabled = process.env.EIGOS_TEST_RELAY_POSTGRES === '1';
test('business snapshot import preserves data, authority, uniqueness, triggers and identity high-water marks', { skip: !enabled }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-business-import-')), path = join(dir, 'business.sqlite');
  const store = new JobStore(path, { securityMode: 'foundation' }); store.createNetworkStore();
  const draft=store.definitions.createDraft('synthetic-owner','eigos.business','Unpublished migration draft',true);store.close();
  const db = new DatabaseSync(path);
  db.prepare('UPDATE ontology_namespaces SET generation=? WHERE id=?').run(draft.baseGeneration+1,draft.ontologyId);
  const authority: RuntimeAuthority = { version: 1, id: randomUUID(), revision: 1, canonicalOrigin: 'https://eigos.example', issuer: 'https://issuer.example', ontologyId: 'eigos.business', databasePath: path, membershipDatabasePath: join(dir,'members.sqlite'),
    ingresses: [{ origin: 'https://eigos.example', audience: 'https://eigos.example', tenantClaim: 'tenant_id', agentClientId: 'agent', agentClientIds: ['agent'], nativeClientIds: [], browserRedirect: false, newRegistrations: true }] };
  installRuntimeAuthority(db, authority);
  db.exec(`INSERT INTO network_evidence_cards VALUES('evidence','owner','{"taskId":"task"}');
    INSERT INTO jobs VALUES('task','owner','context','submitted','2026','2026','{"service":"eigos.delegate","delegation":{"backendVersion":"fixture","request":{"revision":1},"nextAt":1}}');
    INSERT INTO ontology_objects VALUES('owner','type','object',1,'digest','{"source":{"id":"fixture"}}');
    INSERT INTO ontology_object_versions VALUES('eigos.business','owner','type','object',1,'digest',NULL,NULL,'{}',0);
    INSERT INTO network_events(event_id,kind,object_id,at) VALUES('event','fixture','object','2026');
    INSERT INTO security_grants VALUES('grant','agent_access','owner','member','installation',NULL,NULL,1,'active',1,'{}');
    CREATE TABLE migration_sequence_probe(id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);
    INSERT INTO migration_sequence_probe(id,body) VALUES(9007199254740993,'high'); DELETE FROM migration_sequence_probe WHERE id=9007199254740993;
    INSERT INTO migration_sequence_probe(id,body) VALUES(1,'retained');
    CREATE TABLE migration_binary_probe(id TEXT PRIMARY KEY,payload BLOB NOT NULL,value INTEGER NOT NULL,label TEXT);
    INSERT INTO migration_binary_probe VALUES('fixture',x'00FF',9007199254740993,NULL);
    CREATE TABLE migration_rowid_probe(id TEXT PRIMARY KEY,rowid TEXT NOT NULL);
    INSERT INTO migration_rowid_probe(_rowid_,id,rowid) VALUES(9007199254740993,'z-first','shadow'),(9007199254740994,'a-second','shadow');`);
  const epoch = String(db.prepare("SELECT value FROM network_state WHERE key='activity_epoch'").get()!.value);
  const policy = String(db.prepare('SELECT digest FROM security_policy_definitions WHERE slot=1').get()!.digest);
  db.exec('PRAGMA journal_mode=DELETE'); db.close();
  const authorityDigest = runtimeAuthorityDigest(authority), plan = planBusinessSnapshot(path, authorityDigest, policy);
  const schema = `eigos_business_test_${randomBytes(6).toString('hex')}`;
  const ca = process.env.EIGOS_TEST_PG_CA_FILE, local = process.env.EIGOS_TEST_PG_LOCAL === '1';
  if (local && process.env.PGHOST !== '127.0.0.1') throw new Error('Local test mode requires 127.0.0.1');
  if (!local && !ca) throw new Error('EIGOS_TEST_PG_CA_FILE is required');
  const client = new pg.Client({ ssl: local ? false : { ca: readFileSync(ca!, 'utf8'), rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
  const options = { snapshot: path, schema, expectedFileDigest: plan.fileDigest, expectedAuthorityDigest: authorityDigest, expectedPolicyDigest: policy, maxDatabaseBytes: 1_000_000_000 };
  let connected = false, imported = false;
  try {
    await client.connect(); connected = true;
    await assert.rejects(importBusinessSnapshot(client, { ...options, expectedFileDigest: '0'.repeat(64) }), /changed after review/);
    const budgetSchema = `${schema}_budget`;
    await assert.rejects(importBusinessSnapshot(client, { ...options, schema: budgetSchema, maxDatabaseBytes: 1 }), /size budget/);
    assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[budgetSchema])).rowCount, 0);
    const result = await importBusinessSnapshot(client, options); imported = true;
    assert.equal(result.status, 'imported-not-activated'); assert.equal(result.sourceFileDigest, plan.fileDigest);
    const verified=await verifyBusinessSnapshot(client,options);
    assert.equal(verified.status,'verified-at-snapshot');assert.equal(verified.runtimeActivated,false);assert.equal(verified.writerFenceVerified,false);
    assert.equal(verified.sequenceObservation.atomicWithRows,false);assert(verified.sequenceObservation.checked>=plan.tables.length);
    assert(Number.isFinite(Date.parse(verified.transactionStartedAt)));assert.deepEqual(verified.tables,result.tables);
    await client.query('BEGIN');
    try {await assert.rejects(verifyBusinessSnapshot(client,options),/idle, non-pipelined/);assert.equal(client.getTransactionStatus(),'T');}
    finally {await client.query('ROLLBACK');}
    await assert.rejects(verifyBusinessSnapshot(client,{...options,expectedFileDigest:'0'.repeat(64)}),/changed after review/);
    const sequence=(await client.query('SELECT pg_get_serial_sequence($1,$2) AS name',[`"${schema}"."migration_sequence_probe"`,'id'])).rows[0]!.name;
    await client.query('SELECT setval($1::regclass,$2::bigint,true)',[sequence,'1']);
    await assert.rejects(verifyBusinessSnapshot(client,options),/sequence high-water mark differs/);
    await client.query('SELECT setval($1::regclass,$2::bigint,true)',[sequence,'9007199254740993']);
    const noSequencePrivilege=new Proxy(client,{get(target,property){
      if(property==='query')return async(sql:unknown,values?:unknown)=>{
        const result=await (target.query as (...args:any[])=>Promise<any>).call(target,sql,values);
        if(typeof sql==='string' && sql.includes('has_sequence_privilege'))result.rows[0].readable=false;
        return result;
      };
      const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }});
    await assert.rejects(verifyBusinessSnapshot(noSequencePrivilege,options),/sequence configuration or read privilege differs/);
    const forgedReceipt=new Proxy(client,{get(target,property){
      if(property==='query')return async(sql:unknown,values?:unknown)=>{
        const result=await (target.query as (...args:any[])=>Promise<any>).call(target,sql,values);
        if(typeof sql==='string' && sql.includes('.eigos_migration_receipt WHERE'))result.rows[0].body={...result.rows[0].body,sourceFileDigest:'0'.repeat(64)};
        return result;
      };
      const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }});
    await assert.rejects(verifyBusinessSnapshot(forgedReceipt,options),/receipt does not match/);
    const lostBoundary=new Proxy(client,{get(target,property){
      if(property==='query')return async(sql:unknown,values?:unknown)=>{
        const result=await (target.query as (...args:any[])=>Promise<any>).call(target,sql,values);
        if(typeof sql==='string' && sql.includes("current_setting('eigos.verification_nonce',true)"))result.rows[0].nonce='different-transaction';
        return result;
      };
      const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }});
    await assert.rejects(verifyBusinessSnapshot(lostBoundary,options),/transaction boundary was lost/);
    const other=new pg.Client({ ssl: local ? false : { ca: readFileSync(ca!, 'utf8'), rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });await other.connect();
    try {
      let changed=false;
      const concurrent=new Proxy(client,{get(target,property){
        if(property==='query')return async(sql:unknown,values?:unknown)=>{
          const result=await (target.query as (...args:any[])=>Promise<any>).call(target,sql,values);
          if(!changed && typeof sql==='string' && sql.startsWith('WITH checked AS')){
            changed=true;await other.query(`UPDATE "${schema}".migration_binary_probe SET value=7 WHERE id='fixture'`);
          }
          return result;
        };
        const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
      }});
      assert.equal((await verifyBusinessSnapshot(concurrent,options)).status,'verified-at-snapshot');assert(changed);
      await assert.rejects(verifyBusinessSnapshot(client,options),/readback mismatch/);
      await other.query(`UPDATE "${schema}".migration_binary_probe SET value=9007199254740993 WHERE id='fixture'`);
    } finally {await other.end();}
    const backup=join(dir,'snapshot-before-concurrent-change.sqlite');copyFileSync(path,backup);
    try {
      let changed=false;
      const changingSource=new Proxy(client,{get(target,property){
        if(property==='query')return async(sql:unknown,values?:unknown)=>{
          const result=await (target.query as (...args:any[])=>Promise<any>).call(target,sql,values);
          if(!changed && typeof sql==='string' && sql.startsWith('WITH checked AS')){
            changed=true;const changedDb=new DatabaseSync(path);
            try {changedDb.prepare("UPDATE migration_binary_probe SET value=7 WHERE id='fixture'").run();} finally {changedDb.close();}
          }
          return result;
        };
        const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
      }});
      await assert.rejects(verifyBusinessSnapshot(changingSource,options),/snapshot changed during verification/);assert(changed);
    } finally {copyFileSync(backup,path);rmSync(backup,{force:true});}
    await client.query(`UPDATE "${schema}".migration_binary_probe SET value=7 WHERE id='fixture'`);
    await assert.rejects(verifyBusinessSnapshot(client,options),/readback mismatch/);
    await client.query(`UPDATE "${schema}".migration_binary_probe SET value=9007199254740993 WHERE id='fixture'`);
    await client.query(`UPDATE "${schema}".migration_binary_probe SET payload=decode('ff00','hex') WHERE id='fixture'`);
    await assert.rejects(verifyBusinessSnapshot(client,options),/readback mismatch/);
    await client.query(`UPDATE "${schema}".migration_binary_probe SET payload=decode('00ff','hex'),label='' WHERE id='fixture'`);
    await assert.rejects(verifyBusinessSnapshot(client,options),/readback mismatch/);
    await client.query(`UPDATE "${schema}".migration_binary_probe SET label=NULL WHERE id='fixture'`);
    await client.query(`UPDATE "${schema}".migration_binary_probe SET payload=decode(repeat('ff',1024),'hex') WHERE id='fixture'`);
    let sawBoundedRejection=false;
    const boundedRead=new Proxy(client,{get(target,property){
      if(property==='query')return async(sql:unknown,values?:unknown)=>{
        const result=await (target.query as (...args:any[])=>Promise<any>).call(target,sql,values);
        if(typeof sql==='string' && sql.startsWith('WITH checked AS') && result.rows[0]?.bounded===false){
          sawBoundedRejection=true;
          assert.deepEqual(Object.keys(result.rows[0]),['rows','bounded','digest']);
        }
        return result;
      };
      const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }});
    await assert.rejects(verifyBusinessSnapshot(boundedRead,options),/exceeds its reviewed bound/);assert(sawBoundedRejection);
    await client.query(`UPDATE "${schema}".migration_binary_probe SET payload=decode('00ff','hex') WHERE id='fixture'`);
    await client.query(`ALTER TABLE "${schema}".migration_binary_probe ADD COLUMN unreviewed TEXT`);
    await assert.rejects(verifyBusinessSnapshot(client,options),/columns differ/);
    await client.query(`ALTER TABLE "${schema}".migration_binary_probe DROP COLUMN unreviewed`);
    await client.query(`CREATE TABLE "${schema}".unreviewed_table(id INTEGER)`);
    await assert.rejects(verifyBusinessSnapshot(client,options),/table inventory differs/);
    await client.query(`DROP TABLE "${schema}".unreviewed_table`);
    assert.equal((await verifyBusinessSnapshot(client,options)).status,'verified-at-snapshot');
    const lockedAuthority = await client.query(`SELECT * FROM "${schema}".eigos_lock_runtime_authority()`);
    assert.equal(lockedAuthority.rows[0].id, authority.id); assert.equal(lockedAuthority.rows[0].configuration_digest, authorityDigest);
    const functionSecurity = await client.query("SELECT p.prosecdef, EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_exec FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname='eigos_lock_runtime_authority'", [schema]);
    assert.equal(functionSecurity.rows[0].prosecdef, true); assert.equal(functionSecurity.rows[0].public_exec, false);
    assert.deepEqual(result.tables, plan.tables.map(table => ({ name: table.name, rows: table.rows, digest: table.digest })));
    await assert.rejects(importBusinessSnapshot(client, options), /already exists/);
    assert.equal((await client.query(`SELECT value FROM "${schema}".network_state WHERE key='activity_epoch'`)).rows[0].value, epoch);
    await client.query('CREATE TEMP TABLE network_evidence_cards(owner TEXT, body TEXT)');
    await client.query(`UPDATE "${schema}".jobs SET updated_at='2027' WHERE id='task'`);
    assert.equal((await client.query(`SELECT value FROM "${schema}".network_state WHERE key='activity_epoch'`)).rows[0].value, String(Number(epoch) + 1));
    await assert.rejects(client.query(`INSERT INTO "${schema}".security_grants VALUES('duplicate','agent_access','owner','member','installation',NULL,NULL,1,'active',1,'{}')`), error => !!error && typeof error === 'object' && 'code' in error && error.code === '23505');
    const binary = (await client.query(`SELECT payload,value FROM "${schema}".migration_binary_probe`)).rows[0];
    assert.deepEqual(binary.payload, Buffer.from([0,255])); assert.equal(binary.value, '9007199254740993');
    const importedDraft=(await client.query(`SELECT body FROM "${schema}".ontology_definition_drafts WHERE id=$1`,[draft.id])).rows[0];
    assert.equal(importedDraft.body,JSON.stringify(draft));assert.deepEqual(JSON.parse(importedDraft.body),draft);
    assert.equal(Number((await client.query(`SELECT generation FROM "${schema}".ontology_namespaces WHERE id=$1`,[draft.ontologyId])).rows[0].generation),draft.baseGeneration+1);
    const next = await client.query(`INSERT INTO "${schema}".migration_sequence_probe(body) VALUES('next') RETURNING id,__eigos_rowid`);
    assert.equal(next.rows[0].id, '9007199254740994');
    assert.equal(next.rows[0].__eigos_rowid,'9007199254740994');
    const ordered=await client.query(`SELECT id,__eigos_rowid FROM "${schema}".migration_rowid_probe ORDER BY __eigos_rowid`);
    assert.deepEqual(ordered.rows,[{id:'z-first',__eigos_rowid:'9007199254740993'},{id:'a-second',__eigos_rowid:'9007199254740994'}]);
    const later=await client.query(`INSERT INTO "${schema}".migration_rowid_probe(id,rowid) VALUES('new','shadow') RETURNING __eigos_rowid`);
    assert.equal(later.rows[0].__eigos_rowid,'9007199254740995');
    await assert.rejects(client.query(`INSERT INTO "${schema}".migration_rowid_probe(id,rowid,__eigos_rowid) VALUES('forged','shadow',7)`),error=>!!error && typeof error==='object' && 'code' in error && error.code==='428C9');
    await assert.rejects(client.query(`UPDATE "${schema}".migration_rowid_probe SET __eigos_rowid=42 WHERE id='new'`),error=>!!error && typeof error==='object' && 'code' in error && error.code==='428C9');
    await assert.rejects(client.query(`UPDATE "${schema}".migration_rowid_probe SET __eigos_rowid=DEFAULT WHERE id='new'`),error=>!!error && typeof error==='object' && 'code' in error && error.code==='55000');
    await client.query(`UPDATE "${schema}".migration_rowid_probe SET rowid='updated' WHERE id='new'`);
    const event = await client.query(`INSERT INTO "${schema}".network_events(event_id,kind,object_id,at) VALUES('event2','fixture','object','2026') RETURNING seq`);
    assert.equal(event.rows[0].seq, '2');
    await assert.rejects(client.query(`UPDATE "${schema}".ontology_object_versions SET body='changed'`), error => !!error && typeof error === 'object' && 'code' in error && error.code === '55000');
    await assert.rejects(client.query(`DELETE FROM "${schema}".eigos_migration_receipt`), error => !!error && typeof error === 'object' && 'code' in error && error.code === '55000');
    const acl = await client.query("SELECT count(*)::int AS n FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a WHERE n.nspname=$1 AND a.grantee=0 AND a.privilege_type='USAGE'",[schema]);
    assert.equal(acl.rows[0].n, 0);
    // A successful commit whose response is lost must not be called a rollback.
    const uncertainSchema = `${schema}_uncertain`; let observedCommitted = false;
    try {
      const disconnected = { query: async (sql: string, params?: unknown[]) => {
        const value = await client.query(sql, params);
        if (sql === 'COMMIT') throw new Error('simulated lost commit response');
        return value;
      } } as unknown as pg.Client;
      await assert.rejects(importBusinessSnapshot(disconnected, { ...options, schema: uncertainSchema }), /commit outcome is unknown/);
      observedCommitted = (await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [uncertainSchema])).rowCount === 1;
      assert(observedCommitted);
      const receipt = await client.query(`SELECT body FROM "${uncertainSchema}".eigos_migration_receipt WHERE slot=1`);
      assert.equal(receipt.rows[0].body.sourceFileDigest, plan.fileDigest);
    } finally { if (observedCommitted) await client.query(`DROP SCHEMA "${uncertainSchema}" CASCADE`); }
    // SQLite permits this escaped NUL JSON; PostgreSQL JSONB does not. The
    // comparison must reject it before any business rows can be committed.
    const changed = new DatabaseSync(path);
    changed.prepare('INSERT INTO ontology_objects VALUES(?,?,?,?,?,?)').run('owner','type','json-nul',1,'digest',JSON.stringify({ value: '\u0000' })); changed.close();
    const incompatible = planBusinessSnapshot(path, authorityDigest, policy), rejectedSchema = `${schema}_json`;
    await assert.rejects(importBusinessSnapshot(client, { ...options, schema: rejectedSchema, expectedFileDigest: incompatible.fileDigest }), /JSON compatibility mismatch/);
    assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [rejectedSchema])).rowCount, 0);

  } finally {
    if (connected && imported) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end(); rmSync(dir, { recursive: true, force: true });
  }
});
