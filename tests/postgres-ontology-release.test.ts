import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { DefinitionStore } from '../packages/ontology/definition-store.js';
import { digest } from '../packages/core/delegation.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';
import { StagedKernelBuilder, stagedKernelComponents } from '../packages/ontology/seed-definition.js';
import { installPostgresAuthorityLock } from '../packages/postgres/authority-lock.js';
import { postgresBusinessTransaction } from '../packages/postgres/runtime-transaction.js';
import { postgresAssertOntologyAccess, postgresOntologyDefinitionCompatible, postgresOntologyReadContext, postgresOntologyRelease, postgresProjectedTaskOntologyRelease, postgresTaskOntologyRelease,withPostgresOntologyReleaseSnapshot } from '../packages/postgres/ontology-release.js';

test('PostgreSQL resolves the exact task-pinned ontology and legacy release', { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
  const sqlite = new DatabaseSync(':memory:'), definitions = new DefinitionStore(sqlite);
  const active = definitions.bootstrap(), legacy = definitions.legacy();
  const client = new pg.Client(process.env.EIGOS_TEST_PG_CA_FILE ? { ssl: { ca: readFileSync(process.env.EIGOS_TEST_PG_CA_FILE,'utf8'), rejectUnauthorized: true } } : {});
  await client.connect();
  const schema = `eigos_business_${randomUUID().replaceAll('-','')}`, authority = { id: randomUUID(), revision: 1, digest: 'a'.repeat(64) };
  const owner = 'synthetic-owner', task = randomUUID();
  try {
    await client.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".runtime_authority(slot BIGINT PRIMARY KEY,id TEXT,revision BIGINT,configuration_digest TEXT)`);
    await client.query(`INSERT INTO "${schema}".runtime_authority VALUES(1,$1,$2,$3)`,[authority.id,authority.revision,authority.digest]);
    await installPostgresAuthorityLock(client,schema);
    for (const table of ['ontology_definition_releases','ontology_definition_release_aliases','ontology_definition_bootstrap','ontology_namespaces']) {
      const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(row => ({ name: String(row.name), type: String(row.type).toUpperCase() }));
      await client.query(`CREATE TABLE "${schema}"."${table}" (${columns.map(c => `"${c.name}" ${c.type === 'INTEGER' ? 'BIGINT' : 'TEXT'}`).join(',')})`);
      for (const row of sqlite.prepare(`SELECT * FROM "${table}"`).all()) await client.query(`INSERT INTO "${schema}"."${table}" VALUES (${columns.map((_,i) => `$${i+1}`).join(',')})`,columns.map(c => row[c.name]));
    }
    await client.query(`CREATE TABLE "${schema}".jobs(id TEXT PRIMARY KEY,owner TEXT,body TEXT)`);
    await client.query(`CREATE TABLE "${schema}".ontology_task_read_projections(owner TEXT,task_id TEXT,body TEXT,digest TEXT,PRIMARY KEY(owner,task_id))`);
    await client.query(`CREATE FUNCTION "${schema}".eigos_try_jsonb(value TEXT) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE STRICT AS $$ BEGIN RETURN value::jsonb; EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR untranslatable_character THEN RETURN NULL; END $$`);
    const body = { id:task,authorityId:authority.id,delegation:{backendVersion:BACKEND_VERSION,ontologyRelease:legacy.ref} };
    await client.query(`INSERT INTO "${schema}".jobs VALUES($1,$2,$3)`,[task,owner,JSON.stringify(body)]);
    const staged=new StagedKernelBuilder();
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresOntologyRelease(c,active.ref,staged)),/not ready/);
    for(let stage=0;stage<StagedKernelBuilder.stages;stage++)staged.step(stage);
    const stagedCurrent=await postgresBusinessTransaction(client,schema,authority,c=>postgresOntologyRelease(c,active.ref,staged));
    assert.equal(stagedCurrent.model,stagedKernelComponents(staged).model,'exact current document uses the staged model');
    assert.deepEqual((await postgresBusinessTransaction(client,schema,authority,c=>postgresOntologyRelease(c,legacy.ref,staged))).ref,legacy.ref);
    let taskQueryBytes = 0, proofQueryBytes = 0;
    const observed = new Proxy(client, { get(target, property) {
      if (property === 'query') return async (sql: string, values?: unknown[]) => {
        const result = await target.query(sql, values);
        if (sql.includes('.jobs j CROSS JOIN')) taskQueryBytes = Buffer.byteLength(JSON.stringify(result.rows));
        if (sql.includes('minimal.value')) proofQueryBytes = Buffer.byteLength(JSON.stringify(result.rows));
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await client.query(`UPDATE "${schema}".jobs SET body=$1`,[JSON.stringify({...body,padding:'x'.repeat(16 * 1024 * 1024)})]);
    assert.deepEqual((await postgresBusinessTransaction(observed,schema,authority,c => postgresTaskOntologyRelease(c,owner,task))).ref,legacy.ref);
    assert(taskQueryBytes < 4096, `task lookup returned ${taskQueryBytes} bytes`);
    await client.query(`UPDATE "${schema}".jobs SET body=$1`,[JSON.stringify({...body,delegation:{...body.delegation,ontologyRelease:{...legacy.ref,extra:'x'.repeat(16 * 1024 * 1024)}}})]);
    await assert.rejects(postgresBusinessTransaction(observed,schema,authority,c => postgresTaskOntologyRelease(c,owner,task)),/Stored ontology reference is invalid/);
    assert(taskQueryBytes < 4096, `invalid task lookup returned ${taskQueryBytes} bytes`);
    await client.query(`UPDATE "${schema}".jobs SET body=$1`,[JSON.stringify(body)]);
    const taskRelease = () => postgresBusinessTransaction(client,schema,authority,c => postgresTaskOntologyRelease(c,owner,task));
    const first = await taskRelease();
    assert.deepEqual(first.ref,legacy.ref); assert.deepEqual(first.model.ref,legacy.model.ref);
    assert(Object.isFrozen(first.document)); assert(Object.isFrozen(first.ref));
    assert.notDeepEqual(first.ref,active.ref);
    const originalQuery=client.query;let resolutions=0;
    client.query=(async(...args:unknown[])=>{
      if(String(args[0]).includes('SELECT body,model_digest,created_at,sequence FROM '))resolutions++;
      return Reflect.apply(originalQuery,client,args);
    }) as typeof client.query;
    try{
      await postgresBusinessTransaction(client,schema,authority,async c=>{
        await withPostgresOntologyReleaseSnapshot(c,async()=>{
          const a=await postgresOntologyRelease(c,legacy.ref),b=await postgresOntologyRelease(c,legacy.ref);
          assert.equal(a,b,'One reading scope can reuse the same immutable compilation');
          await c.query(`UPDATE "${schema}".ontology_namespaces SET owner=$1 WHERE id=$2`,[owner,legacy.ref.ontologyId]);
          assert.deepEqual((await postgresOntologyReadContext(c,owner,{release:legacy.ref})).ref,legacy.ref);
          await assert.rejects(postgresOntologyReadContext(c,'other-owner',{release:legacy.ref}),/Ontology belongs to another owner/);
          await c.query(`UPDATE "${schema}".ontology_namespaces SET owner=NULL WHERE id=$1`,[legacy.ref.ontologyId]);
        });
        assert.equal(resolutions,1,'Immutable release lookup is not repeated within its reading scope');
        await postgresOntologyRelease(c,legacy.ref);
        assert.equal(resolutions,2,'Even the same transaction resolves rows freshly after that scope closes');
      });
      await postgresBusinessTransaction(client,schema,authority,c=>postgresOntologyRelease(c,legacy.ref));
      assert.equal(resolutions,3,'A later transaction must resolve its own persisted release');
    }finally{client.query=originalQuery;}
    const rolledBackAlias={...legacy.ref,releaseId:randomUUID()};
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,async c=>{
      await assert.rejects(postgresOntologyRelease(c,rolledBackAlias),/exact ontology release is unavailable/);
      await c.query(`INSERT INTO "${schema}".ontology_definition_release_aliases VALUES($1,$2,$3,$4,$5,$6)`,
        [rolledBackAlias.releaseId,rolledBackAlias.ontologyId,legacy.ref.releaseId,rolledBackAlias.digest,'synthetic','2026']);
      assert.deepEqual((await withPostgresOntologyReleaseSnapshot(c,()=>postgresOntologyRelease(c,rolledBackAlias))).ref,rolledBackAlias,'An earlier miss is not cached');
      throw new Error('Synthetic release alias rollback');
    }),/Synthetic release alias rollback/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresOntologyRelease(c,rolledBackAlias)),/exact ontology release is unavailable/);
    const readContext = (input: unknown) => postgresBusinessTransaction(client,schema,authority,c => postgresOntologyReadContext(c,owner,input));
    assert.deepEqual((await readContext({})).ref,active.ref);
    assert.deepEqual((await readContext({release:legacy.ref})).ref,legacy.ref);
    await assert.rejects(readContext({taskId:task,release:legacy.ref}),/Task reads already have an immutable ontology release/);
    await assert.rejects(readContext({ontologyId:'synthetic.other',release:legacy.ref}),/Ontology namespace and release differ/);
    const project = () => postgresBusinessTransaction(observed,schema,authority,c => postgresProjectedTaskOntologyRelease(c,owner,task));
    assert.equal(await project(),undefined);
    const historical={...body,padding:'x'.repeat(16 * 1024 * 1024),delegation:{...body.delegation,backendVersion:'historical',request:{revision:1,unicode:'猫🐈',numbers:[1e-7,1e21,-0,1.25],keys:{'10':'ten','2':'two',z:'字'}}},artifact:{synthetic:true}};
    const proof={version:1,sourceAuthority:'synthetic',taskId:task,owner,backend:'historical',original:legacy.ref,
      requestDigest:digest(historical.delegation.request),artifactDigest:digest(historical.artifact),target:active.ref,
      verifiedObjectCount:0,factDigest:'a'.repeat(64),createdAt:new Date().toISOString()};
    await client.query(`UPDATE "${schema}".jobs SET body=$1`,[JSON.stringify(historical)]);
    await client.query(`INSERT INTO "${schema}".ontology_task_read_projections VALUES($1,$2,$3,$4)`,[owner,task,JSON.stringify(proof),digest(proof)]);
    assert.deepEqual((await project())?.ref,active.ref);
    assert.deepEqual((await readContext({taskId:task})).ref,active.ref);
    assert(proofQueryBytes < 4096, `historical proof returned ${proofQueryBytes} bytes`);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c => postgresProjectedTaskOntologyRelease(c,'other-owner',task)),/Task not found/);
    await client.query(`UPDATE "${schema}".ontology_task_read_projections SET digest=$1`,['b'.repeat(64)]);
    await assert.rejects(project(),/Historical read projection no longer matches/);
    await client.query(`UPDATE "${schema}".ontology_task_read_projections SET digest=$1`,[digest(proof)]);
    await client.query(`UPDATE "${schema}".jobs SET body=$1`,[JSON.stringify({...historical,artifact:{synthetic:false}})]);
    await assert.rejects(project(),/Historical read projection no longer matches/);
    await client.query(`UPDATE "${schema}".jobs SET body=$1`,[JSON.stringify({...historical,artifact:{payload:'x'.repeat(9 * 1024 * 1024)}})]);
    await assert.rejects(project(),/exceed safe runtime limits/);
    assert(proofQueryBytes < 4096, `oversized proof input returned ${proofQueryBytes} bytes`);
    await client.query(`DELETE FROM "${schema}".ontology_task_read_projections`);
    await client.query(`UPDATE "${schema}".jobs SET body=$1`,[JSON.stringify(historical)]);
    assert.deepEqual((await readContext({taskId:task})).ref,legacy.ref,'historical reads retain the original explicit pin');
    await assert.rejects(taskRelease(),/Historical backend tasks/);
    await client.query(`UPDATE "${schema}".jobs SET body=$1`,[JSON.stringify(body)]);
    const namespaceAccess = (actor: string, id: string, admin = false) => postgresBusinessTransaction(client,schema,authority,c => postgresAssertOntologyAccess(c,actor,id,admin));
    definitions.assertAccess(owner, active.ref.ontologyId);
    await namespaceAccess(owner,active.ref.ontologyId);
    const privateId = 'synthetic.private';
    sqlite.prepare('INSERT INTO ontology_namespaces SELECT ?,?,name,active_release_id,generation,created_at FROM ontology_namespaces WHERE id=?').run(privateId,owner,active.ref.ontologyId);
    await client.query(`INSERT INTO "${schema}".ontology_namespaces SELECT $1,$2,name,active_release_id,generation,created_at FROM "${schema}".ontology_namespaces WHERE id=$3`,[privateId,owner,active.ref.ontologyId]);
    definitions.assertAccess(owner,privateId); await namespaceAccess(owner,privateId);
    assert.throws(() => definitions.assertAccess('other-owner',privateId),/Ontology belongs to another owner/);
    await assert.rejects(namespaceAccess('other-owner',privateId),/Ontology belongs to another owner/);
    definitions.assertAccess('other-owner',privateId,true); await namespaceAccess('other-owner',privateId,true);
    assert.throws(() => definitions.assertAccess(owner,'synthetic.missing'),/Ontology is not available/);
    await assert.rejects(namespaceAccess(owner,'synthetic.missing'),/Ontology is not available/);
    delete (body.delegation as {ontologyRelease?: unknown}).ontologyRelease;
    await client.query(`UPDATE "${schema}".jobs SET body=$1`,[JSON.stringify(body)]);
    assert.deepEqual((await taskRelease()).ref,legacy.ref);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c => postgresTaskOntologyRelease(c,'other-owner',task)),/Task not found/);
    await assert.rejects(postgresOntologyRelease(client,legacy.ref),/active PostgreSQL business transaction/);
    body.authorityId=randomUUID(); await client.query(`UPDATE "${schema}".jobs SET body=$1`,[JSON.stringify(body)]);
    await assert.rejects(taskRelease(),/Historical runtime authority/);
    body.authorityId=authority.id; await client.query(`UPDATE "${schema}".jobs SET body=$1`,[JSON.stringify(body)]);
    body.delegation.backendVersion='historical'; await client.query(`UPDATE "${schema}".jobs SET body=$1`,[JSON.stringify(body)]);
    await assert.rejects(taskRelease(),/Historical backend tasks/);
    body.delegation.backendVersion=BACKEND_VERSION; await client.query(`UPDATE "${schema}".jobs SET body=$1`,[JSON.stringify(body)]);
    const alias = {...legacy.ref,releaseId:randomUUID()};
    await client.query(`INSERT INTO "${schema}".ontology_definition_release_aliases VALUES($1,$2,$3,$4,$5,$6)`,[alias.releaseId,alias.ontologyId,legacy.ref.releaseId,alias.digest,'synthetic','2026']);
    assert.deepEqual((await postgresBusinessTransaction(client,schema,authority,c => postgresOntologyRelease(c,alias))).model.ref,legacy.model.ref);
    await client.query(`CREATE TABLE "${schema}".ontology_definition_fingerprints(ontology_id TEXT,kind TEXT,api_name TEXT,fingerprint TEXT,release_id TEXT)`);
    const link = legacy.document.links.map(value => value.id).find(id => {
      try { return active.compatibleDefinition({kind:'link',id,storedDigest:digest(legacy.model.link(id)),currentDigest:digest(active.model.link(id))}); }
      catch { return false; }
    });
    assert(link, 'fixture needs a compatible historical link');
    const inputs = [
      { kind:'link' as const,id:link,storedDigest:digest(legacy.model.link(link)),currentDigest:digest(active.model.link(link)) },
      { kind:'object' as const,id:'ServiceRequest',storedDigest:active.model.fingerprint('ServiceRequest'),currentDigest:active.model.fingerprint('ServiceRequest'),properties:{requestId:'request',displayTitle:'Original request',originalGoal:'Read only'} },
    ];
    for (const input of inputs) {
      const row=sqlite.prepare('SELECT * FROM ontology_definition_fingerprints WHERE ontology_id=? AND kind=? AND api_name=? AND fingerprint=?').get(active.ref.ontologyId,input.kind,input.id,input.storedDigest);
      assert(row);
      await client.query(`INSERT INTO "${schema}".ontology_definition_fingerprints VALUES($1,$2,$3,$4,$5)`,[row.ontology_id,row.kind,row.api_name,row.fingerprint,row.release_id]);
      const expected=active.compatibleDefinition(input); assert.equal(expected,true);
      assert.equal(await postgresBusinessTransaction(client,schema,authority,c => postgresOntologyDefinitionCompatible(c,active.ref,input)),expected);
      const changed={...input,currentDigest:'b'.repeat(64)};
      assert.equal(await postgresBusinessTransaction(client,schema,authority,c => postgresOntologyDefinitionCompatible(c,active.ref,changed)),active.compatibleDefinition(changed));
    }
    assert.equal(await postgresBusinessTransaction(client,schema,authority,c => postgresOntologyDefinitionCompatible(c,active.ref,{...inputs[0]!,storedDigest:'b'.repeat(64)})),false);
    await client.query(`UPDATE "${schema}".ontology_definition_releases SET model_digest=$1 WHERE id=$2`,['b'.repeat(64),legacy.ref.releaseId]);
    await assert.rejects(taskRelease(),/compiler or trusted handler/);
    const altered = structuredClone(legacy.document); altered.id='synthetic.other';
    await client.query(`UPDATE "${schema}".ontology_definition_releases SET body=$1 WHERE id=$2`,[JSON.stringify(altered),legacy.ref.releaseId]);
    await assert.rejects(taskRelease(),/digest is invalid/);
    await client.query(`UPDATE "${schema}".ontology_definition_releases SET body=$1 WHERE id=$2`,['{}',legacy.ref.releaseId]);
    await assert.rejects(taskRelease(),/Stored ontology release is invalid/);
  } finally { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end(); sqlite.close(); }
});
