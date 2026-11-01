import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { DefinitionStore } from '../packages/ontology/definition-store.js';
import { digest } from '../packages/core/delegation.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';
import { installPostgresAuthorityLock } from '../packages/postgres/authority-lock.js';
import { postgresBusinessTransaction } from '../packages/postgres/runtime-transaction.js';
import { postgresOntologyDefinitionCompatible, postgresOntologyRelease, postgresTaskOntologyRelease } from '../packages/postgres/ontology-release.js';

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
    for (const table of ['ontology_definition_releases','ontology_definition_release_aliases','ontology_definition_bootstrap']) {
      const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(row => ({ name: String(row.name), type: String(row.type).toUpperCase() }));
      await client.query(`CREATE TABLE "${schema}"."${table}" (${columns.map(c => `"${c.name}" ${c.type === 'INTEGER' ? 'BIGINT' : 'TEXT'}`).join(',')})`);
      for (const row of sqlite.prepare(`SELECT * FROM "${table}"`).all()) await client.query(`INSERT INTO "${schema}"."${table}" VALUES (${columns.map((_,i) => `$${i+1}`).join(',')})`,columns.map(c => row[c.name]));
    }
    await client.query(`CREATE TABLE "${schema}".jobs(id TEXT PRIMARY KEY,owner TEXT,body TEXT)`);
    const body = { id:task,authorityId:authority.id,delegation:{backendVersion:BACKEND_VERSION,ontologyRelease:legacy.ref} };
    await client.query(`INSERT INTO "${schema}".jobs VALUES($1,$2,$3)`,[task,owner,JSON.stringify(body)]);
    const taskRelease = () => postgresBusinessTransaction(client,schema,authority,c => postgresTaskOntologyRelease(c,owner,task));
    const first = await taskRelease();
    assert.deepEqual(first.ref,legacy.ref); assert.deepEqual(first.model.ref,legacy.model.ref);
    assert(Object.isFrozen(first.document)); assert(Object.isFrozen(first.ref));
    assert.notDeepEqual(first.ref,active.ref);
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
