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
import { postgresHandoffFixture } from './fixtures/postgres-handoff.js';
import { postgresRuntimeGrantPlan } from '../packages/deployment/postgres-handoff.js';

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

test('projection epoch translation requires the exact complete source triggers and preserves legacy snapshots',()=>{
  const legacy=new DatabaseSync(':memory:');try{legacy.exec('CREATE TABLE sample(id TEXT PRIMARY KEY)');assert(!compileBusinessSchema(legacy).schemaStatements.some(sql=>sql.includes('eigos_projection_epoch_invalidate')));}finally{legacy.close();}
  const f=postgresHandoffFixture(),db=new DatabaseSync(f.business);
  try{
    const original=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all().filter(row=>/^ontology_(?:scoped_)?(?:objects|links)_projection_(?:insert|update|delete)$/.test(String(row.name)));assert.equal(original.length,12);
    const mapping=compileBusinessSchema(db);assert.equal(mapping.triggerStatements.filter(sql=>sql.includes('eigos_projection_epoch_invalidate')).length,12);
    db.exec('SAVEPOINT legacy_snapshot');try{
      for(const trigger of original)db.exec(`DROP TRIGGER ${String(trigger.name)}`);
      db.exec('DROP TABLE ontology_projection_epochs; DROP TABLE ontology_projection_checkpoints');
      const beforeDelta=compileBusinessSchema(db);assert.equal(beforeDelta.tables,mapping.tables-2);
      assert(!beforeDelta.schemaStatements.some(sql=>sql.includes('eigos_projection_epoch_invalidate')));
    }finally{db.exec('ROLLBACK TO legacy_snapshot; RELEASE legacy_snapshot');}
    const changed=(name:string,replace:(sql:string)=>string)=>{
      const sql=String(original.find(row=>row.name===name)!.sql);assert.notEqual(replace(sql),sql);
      db.exec('SAVEPOINT tamper');try{db.exec(`DROP TRIGGER ${name}; ${replace(sql)}`);assert.throws(()=>compileBusinessSchema(db),/Unreviewed projection/);}finally{db.exec('ROLLBACK TO tamper; RELEASE tamper');}
    };
    changed('ontology_objects_projection_insert',sql=>sql.replace('AFTER INSERT','BEFORE INSERT'));
    changed('ontology_objects_projection_insert',sql=>sql.replace('revision=revision+1','revision=revision+2'));
    changed('ontology_links_projection_insert',sql=>sql.replace("'link/'","'object/'"));
    changed('ontology_objects_projection_insert',sql=>sql.replace("'object/'","'object/ '"));
    changed('ontology_scoped_objects_projection_insert',sql=>sql.replace('NEW.ontology_id',"'eigos.business'"));
    changed('ontology_objects_projection_update',sql=>sql.replace(/INSERT INTO ontology_projection_epochs VALUES\([\s\S]*?OLD\.type,1\)\s*ON CONFLICT\(ontology_id,owner,type\) DO UPDATE SET revision=revision\+1;/,''));
    db.exec('SAVEPOINT missing');try{db.exec('DROP TRIGGER ontology_links_projection_delete');assert.throws(()=>compileBusinessSchema(db),/Unreviewed projection/);}finally{db.exec('ROLLBACK TO missing; RELEASE missing');}
  }finally{db.close();f.close();}
});

test('PostgreSQL projection epochs match SQLite updates, rollback and preserved rowids under the fixed runtime role',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
  assert.equal(process.env.PGHOST,'127.0.0.1');
  const f=postgresHandoffFixture(),sqlite=new DatabaseSync(f.business),schema=f.binding.business.schema,q=`"${schema}"`,role=f.role;
  const client=new pg.Client({host:'127.0.0.1',port:Number(process.env.PGPORT),database:'postgres',user:'postgres',password:process.env.PGPASSWORD,ssl:false});
  const owners=['synthetic-epoch-owner-a','synthetic-epoch-owner-b'];let connected=false;
  try{
    await client.connect();connected=true;await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${q}; SET LOCAL search_path TO ${q}, pg_catalog, pg_temp`);
    const path=(await client.query("SELECT current_setting('search_path') AS path")).rows[0].path;
    const mapping=compileBusinessSchema(sqlite);await client.query(mapping.statements.join(';\n'));
    const fn=(await client.query(`SELECT p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname='eigos_projection_epoch_invalidate'`,[schema])).rows[0];
    assert.equal(fn.prosecdef,false);assert.deepEqual(fn.proconfig,[`search_path=${path}`]);
    const compare=async()=>{
      const source=sqlite.prepare('SELECT ontology_id,owner,type,revision FROM ontology_projection_epochs WHERE owner IN (?,?) ORDER BY ontology_id,owner,type').all(...owners);
      const target=(await client.query(`SELECT ontology_id,owner,type,revision::int AS revision FROM ${q}.ontology_projection_epochs WHERE owner=ANY($1::text[]) ORDER BY ontology_id,owner,type`,[owners])).rows;
      assert.deepEqual(target,source.map(row=>({...row})));
    };
    const both=async(sql:string,values:(string|number)[]=[])=>{
      sqlite.prepare(sql).run(...values);let n=0;await client.query(sql.replaceAll('?',()=>'$'+(++n)),values);await compare();
    };
    const insert=async(table:string,id:string,preserve=true)=>{
      const scoped=table.includes('_scoped_'),links=table.endsWith('_links');
      const value:Record<string,string|number>={ontology_id:'synthetic.epoch.one',owner:owners[0]!,type:links?'EpochRelation':'EpochNode',id,revision:1,definition_digest:'synthetic-digest',body:'{}',from_type:'EpochNode',from_id:id,to_type:'EpochNode',to_id:'other'};
      const columns=sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row=>String(row.name)),values=columns.map(name=>value[name]!);
      assert.equal(columns.includes('ontology_id'),scoped);
      const result=sqlite.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...values);
      const target=await client.query(`INSERT INTO ${table}(${columns.join(',')}${preserve?',__eigos_rowid':''}) ${preserve?'OVERRIDING SYSTEM VALUE ':''}VALUES(${[...values,...(preserve?[String(result.lastInsertRowid)]:[])].map((_,i)=>'$'+(i+1)).join(',')}) RETURNING __eigos_rowid`,[...values,...(preserve?[String(result.lastInsertRowid)]:[])]);
      if(preserve)assert.equal(target.rows[0].__eigos_rowid,String(result.lastInsertRowid));await compare();return target.rows[0].__eigos_rowid;
    };
    for(const table of ['ontology_objects','ontology_links','ontology_scoped_objects','ontology_scoped_links']){
      const rowid=await insert(table,'original-rowid');
      await both(`UPDATE ${table} SET definition_digest=? WHERE owner=?`,['changed-digest',owners[0]!]);
      assert.equal((await client.query(`SELECT __eigos_rowid FROM ${table} WHERE owner=$1`,[owners[0]])).rows[0].__eigos_rowid,rowid);
      await both(`UPDATE ${table} SET owner=?,type=?${table.includes('_scoped_')?',ontology_id=?':''} WHERE owner=?`,[owners[1]!,table.endsWith('_links')?'ChangedRelation':'ChangedNode',...(table.includes('_scoped_')?['synthetic.epoch.two']:[]),owners[0]!]);
      assert.equal((await client.query(`SELECT __eigos_rowid FROM ${table} WHERE owner=$1`,[owners[1]])).rows[0].__eigos_rowid,rowid);
      await both(`DELETE FROM ${table} WHERE owner=?`,[owners[1]!]);
    }
    sqlite.exec('SAVEPOINT rolled_back');await client.query('SAVEPOINT rolled_back');
    await insert('ontology_objects','rolled-back-object');
    sqlite.exec('ROLLBACK TO rolled_back; RELEASE rolled_back');await client.query('ROLLBACK TO SAVEPOINT rolled_back; RELEASE SAVEPOINT rolled_back');await compare();
    await client.query(`CREATE ROLE "${role}" NOINHERIT LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT USAGE ON SCHEMA ${q} TO "${role}"; REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${q} FROM PUBLIC`);
    const grants=postgresRuntimeGrantPlan(f.binding,f.plan.tables.map(table=>table.name));
    for(const table of f.plan.tables){const allowed=grants.business.tables[table.name];if(allowed?.length)await client.query(`GRANT ${allowed.join(',')} ON ${q}."${table.name}" TO "${role}"`);}
    await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${q} TO "${role}"; GRANT EXECUTE ON FUNCTION ${q}.eigos_try_jsonb(text) TO "${role}"; SET LOCAL ROLE "${role}"`);
    assert.equal((await client.query('SELECT current_user AS role')).rows[0].role,role);
    assert.equal((await client.query(`SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed`,[`${schema}.eigos_projection_epoch_invalidate()`])).rows[0].allowed,false);
    await insert('ontology_objects','runtime-owned',false);await both('UPDATE ontology_objects SET definition_digest=? WHERE owner=?',['runtime-update',owners[0]!]);
    await insert('ontology_links','runtime-link',false);await both('DELETE FROM ontology_links WHERE owner=?',[owners[0]!]);
    for(const sql of ['DELETE FROM ontology_projection_epochs','INSERT INTO ontology_projection_checkpoints VALUES(\'x\',\'x\',\'x\',\'x\',\'[]\',\'{}\')','DELETE FROM ontology_objects','UPDATE ontology_links SET definition_digest=\'forbidden\'','CREATE TABLE forbidden(id integer)']){
      await client.query('SAVEPOINT forbidden');try{await assert.rejects(client.query(sql),error=>!!error&&typeof error==='object'&&'code'in error&&error.code==='42501');}finally{await client.query('ROLLBACK TO SAVEPOINT forbidden; RELEASE SAVEPOINT forbidden');}
    }
    await compare();
  }finally{if(connected)await client.query('ROLLBACK');await client.end();sqlite.close();f.close();}
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
    assert(mapping.schemaStatements.some(sql => sql.includes('CREATE INDEX "jobs_owner_body_validity"')));
    for (const [id,body] of [['valid','{}'],['invalid','{']] as const) {
      sqlite.prepare('INSERT INTO jobs(id,owner,context_id,state,created_at,updated_at,body) VALUES(?,?,?,?,?,?,?)').run(id,'fixture','context','input-required','2026','2026',body);
      await client.query('INSERT INTO jobs(id,owner,context_id,state,created_at,updated_at,body) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,'fixture','context','input-required','2026','2026',body]);
      const source = sqlite.prepare('SELECT typeof(body) AS kind,json_valid(body) AS valid FROM jobs INDEXED BY jobs_owner_body_validity WHERE owner=? AND id=?').get('fixture',id);
      const target = (await client.query('SELECT eigos_try_jsonb(body) IS NOT NULL AS valid FROM jobs WHERE owner=$1 AND id=$2',['fixture',id])).rows[0];
      assert.equal(source?.kind,'text'); assert.equal(Boolean(source?.valid),target.valid);
    }
    sqlite.prepare("DELETE FROM jobs WHERE owner='fixture'").run();
    await client.query("DELETE FROM jobs WHERE owner='fixture'");
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
    const harmlessRowid = sqlite.prepare(harmless).run().lastInsertRowid;
    await client.query("INSERT INTO jobs(id,owner,context_id,state,created_at,updated_at,body,__eigos_rowid) OVERRIDING SYSTEM VALUE VALUES('other','owner','context','unindexed','2026','2026','not-json',$1)",[String(harmlessRowid)]);
    await rejectSql("UPDATE jobs SET __eigos_rowid=999 WHERE id='other'",'428C9');
    await rejectSql("UPDATE jobs SET __eigos_rowid=DEFAULT WHERE id='other'",'55000');
    sqlite.exec("UPDATE network_state SET value='0' WHERE key='activity_epoch'");
    await client.query("INSERT INTO network_state VALUES('activity_epoch','0') ON CONFLICT (key) DO UPDATE SET value='0'");
    const both = async (sql: string) => { sqlite.exec(sql); await client.query(sql); };
    const sameEpoch = async (expected: string) => {
      assert.equal(String(sqlite.prepare("SELECT value FROM network_state WHERE key='activity_epoch'").get()!.value), expected);
      assert.equal((await client.query("SELECT value FROM network_state WHERE key='activity_epoch'")).rows[0].value, expected);
    };
    const evidenceBody = '{"taskId":"task1"}';
    const evidenceRowid = sqlite.prepare("INSERT INTO network_evidence_cards VALUES('evidence-1','owner',?)").run(evidenceBody).lastInsertRowid;
    await client.query("INSERT INTO network_evidence_cards(id,owner,body,__eigos_rowid) OVERRIDING SYSTEM VALUE VALUES('evidence-1','owner',$1,$2)",[evidenceBody,String(evidenceRowid)]);
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
    const invalidJson = JSON.stringify({ value: '\u0000' });
    const rowid = sqlite.prepare('INSERT INTO ontology_objects VALUES(?,?,?,?,?,?)').run('owner','type','json-nul',1,'digest',invalidJson).lastInsertRowid;
    await client.query("INSERT INTO ontology_objects(owner,type,id,revision,definition_digest,body,__eigos_rowid) OVERRIDING SYSTEM VALUE VALUES('owner','type','json-nul',1,'digest',$1,$2)",[invalidJson,String(rowid)]);
    await assert.rejects(validateBusinessJsonCompatibility(sqlite, client, schema), /JSON compatibility mismatch in ontology_objects/);


  } finally {
    if (connected && transaction) await client.query('ROLLBACK');
    await client.end(); sqlite.close(); rmSync(dir, { recursive: true, force: true });
  }
});
