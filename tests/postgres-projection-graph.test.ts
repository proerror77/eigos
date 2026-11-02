import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFileSync,readFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import {securityFixture} from './fixtures/security.js';
import {runtimeAuthorityDigest} from '../packages/core/runtime-authority.js';
import {BACKEND_VERSION} from '../packages/ontology/execution.js';
import {projectTask,projectTaskProgram} from '../packages/ontology/task-projection.js';
import {projectExecution,projectExecutionProgram} from '../packages/ontology/execution-projection.js';
import {OntologyObjectStore,IncompleteRelationshipRead,type ObjectBatch} from '../packages/ontology/object-store.js';
import {planBusinessSnapshot} from '../packages/postgres/business-snapshot.js';
import {importBusinessSnapshot} from '../packages/postgres/business-import.js';
import {postgresBusinessTransaction} from '../packages/postgres/runtime-transaction.js';
import {PostgresProjectionGraph} from '../packages/postgres/projection-graph.js';
import type {Job} from '../packages/core/domain.js';
import {digest} from '../packages/core/delegation.js';
import {sourceProof,sourceProofProgram} from '../packages/ontology/object-evidence.js';
import {evaluateFunction,evaluateFunctionProgram} from '../packages/ontology/object-functions.js';

test('PostgreSQL shared projection programs preserve SQLite versions, relationships, atomic rollback and complete reads',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
  const fixed=Date.now(),f=securityFixture(()=>fixed,{unified:true});
  const schema=`eigos_business_graph_${randomUUID().replaceAll('-','')}`,snapshot=join(f.directory,'projection-snapshot.sqlite');
  const local=process.env.PGHOST==='127.0.0.1',ca=process.env.EIGOS_TEST_PG_CA_FILE;
  if(!local&&!ca)throw new Error('Verified PostgreSQL CA is required');
  const options={ssl:local?false:{ca:readFileSync(ca!,'utf8'),rejectUnauthorized:true},connectionTimeoutMillis:15000};
  const client=new pg.Client(options);let connected=false,imported=false;
  try {
    const sqlite=(f.jobs as unknown as {db:DatabaseSync}).db,release=f.jobs.definitions.active();
    const policy=f.jobs.security.policies.definitionDigest,authority={id:f.authority!.id,revision:f.authority!.revision,digest:runtimeAuthorityDigest(f.authority!)};
    f.coordinator.close();sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');copyFileSync(f.database,snapshot);
    const offline=new DatabaseSync(snapshot);offline.exec('PRAGMA journal_mode=DELETE');offline.close();chmodSync(snapshot,0o600);
    const plan=planBusinessSnapshot(snapshot,authority.digest,policy);
    await client.connect();connected=true;
    await importBusinessSnapshot(client,{snapshot,schema,expectedFileDigest:plan.fileDigest,expectedAuthorityDigest:authority.digest,expectedPolicyDigest:policy,maxDatabaseBytes:1000000000});imported=true;
    const base=(f.jobs as unknown as {projectionBase:OntologyObjectStore}).projectionBase;
    const graph=base.forModel(release.model,{ontologyId:release.ref.ontologyId,releaseRef:release.ref,skipLegacyMigration:true});
    const owner=f.owner,at=new Date(fixed).toISOString(),id=randomUUID();
    const job:Job={id,contextId:randomUUID(),authorityId:authority.id,service:'eigos.delegate',goal:'Synthetic projected request',state:'submitted',revision:1,
      messages:[],createdAt:at,updatedAt:at,delegation:{backendVersion:BACKEND_VERSION,ontologyRelease:release.ref,ontologyReadScope:'request',phase:'grounding',events:[],
        request:{id,revision:1,originalGoal:'Synthetic projected request',requirements:[],messages:[{id:'synthetic-message',text:'Synthetic projected request',receivedAt:at}]}}};
    const write=()=>postgresBusinessTransaction(client,schema,authority,async c=>{
      const target=await PostgresProjectionGraph.create(c,owner,release.ref,undefined,{now:()=>fixed});
      await target.run(metadata=>projectTaskProgram(metadata,owner,job));
      await target.run(metadata=>projectExecutionProgram(metadata,owner,job));
    });
    const sourceWrite=()=>f.jobs.transaction(()=>{projectTask(graph,owner,job);projectExecution(graph,owner,job);});
    const compare=async()=>{
      for(const table of ['ontology_objects','ontology_links','ontology_object_versions','ontology_revisions']){
        const columns=sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(row=>({name:String(row.name),integer:row.type==='INTEGER'}));
        const select=columns.map(column=>`"${column.name}"`).join(',');
        const source=sqlite.prepare(`SELECT ${select} FROM "${table}" WHERE owner=?`).all(owner);
        const target=(await client.query(`SELECT ${select} FROM "${schema}"."${table}" WHERE owner=$1`,[owner])).rows.map(row=>Object.fromEntries(columns.map(column=>[column.name,column.integer&&row[column.name]!==null?Number(row[column.name]):row[column.name]])));
        const sort=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)).sort();assert.deepEqual(sort(target),sort(source),table);
      }
    };
    sourceWrite();await write();await compare();
    sourceWrite();await write();await compare();
    job.state='working';sourceWrite();await write();await compare();
    const source={kind:'synthetic' as const,id:'projection-fixture',observedAt:at};
    const place={type:'Place',id:'projection-place'},receipt={type:'SourceReceipt',id:'projection-place-receipt'};
    const placeProperties={placeId:place.id,displayTitle:'Synthetic place',name:'Synthetic place'};
    const placeBatch:ObjectBatch={objects:[{ref:place,properties:placeProperties},{ref:receipt,properties:{receiptId:receipt.id,displayTitle:'Synthetic receipt',sourceIdentity:source.id,
      sourceEventId:'projection-place-observation',observedAt:at,evidenceLevel:'synthetic',scope:'public_locations',contentDigest:digest(placeProperties),
      subjects:[{object:place,digest:digest(placeProperties),linksDigest:digest([])}],safeSummary:'Synthetic projection test'}}],links:[{type:'PlaceEvidence',from:place,to:receipt}]};
    graph.ingest(owner,placeBatch,source);
    await postgresBusinessTransaction(client,schema,authority,async c=>{
      const target=await PostgresProjectionGraph.create(c,owner,release.ref,undefined,{now:()=>fixed});await target.ingest(owner,placeBatch,source);
      const read=await target.read(owner,place);read.properties.name='Caller mutation';
      assert.equal((await target.read(owner,place)).properties.name,'Synthetic place','returned views cannot mutate a transaction cache');
      const sourceEvidence=sourceProof(graph,owner,place,{remaining:1000});assert(sourceEvidence);
      assert.deepEqual(await target.run(metadata=>sourceProofProgram(metadata,owner,place,{remaining:1000})),sourceEvidence,
        'trusted awaited proof validates the same current properties and relationships');
      const call={function:'taskOutcomeStatus' as const,object:{type:'ServiceRequest',id}};
      assert.deepEqual(await target.run(metadata=>evaluateFunctionProgram(metadata,owner,call,{remaining:1000})),
        evaluateFunction(graph,owner,call,{remaining:1000}),'missing business completion evidence stays unknown');
    });
    await compare();
    const sourceBudget={remaining:2};graph.query(owner,{object:place},sourceBudget);assert.equal(sourceBudget.remaining,0);
    await postgresBusinessTransaction(client,schema,authority,async c=>{
      const target=await PostgresProjectionGraph.create(c,owner,release.ref),budget={remaining:2};
      await target.query(owner,{object:place},budget);assert.deepEqual(budget,sourceBudget);
    });
    assert.throws(()=>graph.query(owner,{object:place},{remaining:1}),/work budget/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,async c=>{
      const target=await PostgresProjectionGraph.create(c,owner,release.ref);
      await target.query(owner,{object:place},{remaining:1});
    }),/work budget/);
    const stale:ObjectBatch={objects:[{ref:place,expectedRevision:99,properties:{placeId:place.id,displayTitle:'Stale change',name:'Stale change'}}]};
    assert.throws(()=>graph.ingest(owner,stale,source),/revision changed/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,async c=>(await PostgresProjectionGraph.create(c,owner,release.ref)).ingest(owner,stale,source)),/revision changed/);await compare();
    const changed:ObjectBatch={objects:[{ref:place,expectedRevision:1,properties:{...placeProperties,name:'Fenced update'}}]};
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,async c=>{
      const target=await PostgresProjectionGraph.create(c,owner,release.ref);await target.read(owner,place);
      // Deliberately bypass the graph inside this disposable transaction. The
      // persisted CAS must still reject a stale cached writer observation.
      await c.query(`UPDATE "${schema}".ontology_objects SET revision=revision+1 WHERE owner=$1 AND type=$2 AND id=$3`,[owner,place.type,place.id]);
      await target.ingest(owner,changed,source);
    }),/revision changed/);await compare();
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,async c=>{
      const target=await PostgresProjectionGraph.create(c,owner,release.ref);
      await c.query(`INSERT INTO "${schema}".ontology_object_versions(ontology_id,owner,type,id,revision,definition_digest,release_id,release_digest,body,deleted)
        SELECT $1,owner,type,id,revision+1,definition_digest,NULL,NULL,body,0 FROM "${schema}".ontology_objects WHERE owner=$2 AND type=$3 AND id=$4`,[release.ref.ontologyId,owner,place.type,place.id]);
      await target.ingest(owner,changed,source);
    }),/immutable object writer version/);await compare();
    const failed={type:'Place',id:'rolled-back-place'},bad:ObjectBatch={objects:[{ref:failed,properties:{placeId:failed.id,displayTitle:'Must roll back',name:'Must roll back'}}],links:[{type:'PlaceEvidence',from:failed,to:{type:'SourceReceipt',id:'missing-receipt'}}]};
    assert.throws(()=>graph.ingest(owner,bad,source),/not found/);
    await postgresBusinessTransaction(client,schema,authority,async c=>{
      const target=await PostgresProjectionGraph.create(c,owner,release.ref,undefined,{now:()=>fixed});
      await assert.rejects(target.ingest(owner,bad,source),/not found/);
      await assert.rejects(target.read(owner,failed),/not found/);
      await assert.rejects(target.read(JSON.stringify(['other','owner','subject']),place),/another owner/);
    });await compare();
    const instructions:ObjectBatch={objects:[],links:[]};
    for(let sequence=0;sequence<51;sequence++){
      const ref={type:'RequestInstruction',id:`pagination-instruction-${sequence}`};
      instructions.objects.push({ref,properties:{id:ref.id,displayTitle:'Synthetic instruction',introducedRevision:1,messageId:`page-${sequence}`,sequence,text:'Synthetic',receivedAt:at}});
      instructions.links!.push({type:'RequestInstructionRequest',from:ref,to:{type:'ServiceRequest',id}});
    }
    const taskSource={kind:'task' as const,id,observedAt:at};graph.ingest(owner,instructions,taskSource);
    await postgresBusinessTransaction(client,schema,authority,async c=>{
      const target=await PostgresProjectionGraph.create(c,owner,release.ref,undefined,{now:()=>fixed});await target.ingest(owner,instructions,taskSource);
      await assert.rejects(target.related(owner,{type:'ServiceRequest',id},'instructions',{remaining:1000}),IncompleteRelationshipRead);
      const first=await target.query(owner,{from:{type:'ServiceRequest',id},link:'instructions',limit:10});assert(first.page.hasMore);assert(first.page.cursor);
      const second=await target.query(owner,{from:{type:'ServiceRequest',id},link:'instructions',limit:10,cursor:first.page.cursor});assert(second.items.length>0);
      assert(!second.items.some(item=>first.items.some(prior=>prior.ref.id===item.ref.id)));
    });
    assert.throws(()=>graph.related(owner,{type:'ServiceRequest',id},'instructions',{remaining:1000}),IncompleteRelationshipRead);await compare();
    const orphan={type:'RequestInstruction',id:'missing-required-request'};
    const missing:ObjectBatch={objects:[{ref:orphan,properties:{...instructions.objects[0]!.properties,id:orphan.id}}]};
    assert.throws(()=>graph.ingest(owner,missing,taskSource),/Relationship cardinality/);
    await postgresBusinessTransaction(client,schema,authority,async c=>{
      const target=await PostgresProjectionGraph.create(c,owner,release.ref);
      await assert.rejects(target.ingest(owner,missing,taskSource),/Relationship cardinality/);
      await assert.rejects(target.read(owner,orphan),/not found/);
    });await compare();
    const unicode={type:'RequestInstruction',id:'unsupported-json-unicode'};
    await postgresBusinessTransaction(client,schema,authority,async c=>{
      const target=await PostgresProjectionGraph.create(c,owner,release.ref);
      await assert.rejects(target.ingest(owner,{objects:[{ref:unicode,properties:{...instructions.objects[0]!.properties,id:unicode.id,text:'\ud800'}}],
        links:[{type:'RequestInstructionRequest',from:unicode,to:{type:'ServiceRequest',id}}]},taskSource),/not representable/);
      await assert.rejects(target.read(owner,unicode),/not found/);
    });await compare();
    let escaped:PostgresProjectionGraph|undefined;
    await postgresBusinessTransaction(client,schema,authority,async c=>{escaped=await PostgresProjectionGraph.create(c,owner,release.ref);});
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,async()=>escaped!.read(owner,place)),/AUTHORIZATION_REQUIRED/);
  } finally {
    if(connected){try{if(imported)await client.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await client.end();}}
    f.close();
  }
});
