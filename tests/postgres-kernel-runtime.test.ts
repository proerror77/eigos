import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {installPostgresAuthorityLock} from '../packages/postgres/authority-lock.js';
import {preparePostgresKernel} from '../packages/postgres/kernel-runtime.js';
import {StagedKernelBuilder,stagedKernelComponents,PAYMENT_COMMERCE_KERNEL_MODEL_REF,BUSINESS_DESCRIPTIONS_KERNEL_MODEL_REF} from '../packages/ontology/seed-definition.js';
import {PostgresDatabase} from '../packages/postgres/database.js';
import {postgresBusinessTransaction,postgresBusinessKernel,postgresBusinessToken} from '../packages/postgres/runtime-transaction.js';
import {postgresOntologyRelease,postgresOntologyReadContext} from '../packages/postgres/ontology-release.js';
import {postgresWorkerAdmission} from '../packages/postgres/worker-admission.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';
import {persistentConsentPolicyContracts,reviewedKernelVersionForPolicy} from '../packages/security/policy-store.js';
import {currentKernelImplementation} from '../packages/ontology/definition-store.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
async function fixture(){
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{const installation=f.installation('Synthetic prepared kernel',3600000);f.approve(installation.id);const task=f.task(installation.id),ref=f.jobs.definitions.active().ref;target=await importPostgresFixture(f);const t=target;return {f,t,task,ref,close:async()=>{await t.close();f.close();}};}
  catch(error){if(target)await target.close();f.close();throw error;}
}

test('PostgreSQL kernel preparation yields between all genuine stages and rejects an aborted startup',async()=>{
  let running=true,ticks=0;const pulse=()=>{if(running){ticks++;setImmediate(pulse);}};setImmediate(pulse);
  let kernel:StagedKernelBuilder;try{kernel=await preparePostgresKernel();}finally{running=false;}
  assert(kernel instanceof StagedKernelBuilder);assert.equal(kernel.step(StagedKernelBuilder.stages).ready,true);assert(ticks>=StagedKernelBuilder.stages-1,'host callbacks must run between construction stages');
  assert(stagedKernelComponents(kernel).model.actionIds().includes('ComposeDocument'));
  assert.deepEqual(stagedKernelComponents(kernel).model.ref,currentKernelImplementation().ref,'The staged PG compiler must include every current trusted kernel extension');
  const controller=new AbortController(),reason=new Error('Synthetic startup canceled');controller.abort(reason);await assert.rejects(preparePostgresKernel(controller.signal),error=>error===reason);
});

test('reviewed policy selects the exact v27 or descriptions-v28 kernel without upgrading grants',async()=>{
  const legacy=await preparePostgresKernel(undefined,'27'),legacyModel=stagedKernelComponents(legacy).model;
  assert.deepEqual(legacyModel.ref,PAYMENT_COMMERCE_KERNEL_MODEL_REF);assert.equal(legacy.step(14).total,14);
  const current=await preparePostgresKernel(),currentModel=stagedKernelComponents(current).model;
  assert.deepEqual(currentModel.ref,BUSINESS_DESCRIPTIONS_KERNEL_MODEL_REF);assert.equal(current.step(15).total,15);
  for(const [model,version] of [[legacyModel,'27'],[currentModel,'28']] as const){
    const contracts=persistentConsentPolicyContracts(model);
    assert.equal(reviewedKernelVersionForPolicy(contracts.before),version);
    assert.equal(reviewedKernelVersionForPolicy(contracts.after),version);
  }
  assert.notEqual(persistentConsentPolicyContracts(legacyModel).after,persistentConsentPolicyContracts(currentModel).after);
  assert.throws(()=>reviewedKernelVersionForPolicy('0'.repeat(64)),/explicit supported kernel review/);
  assert.throws(()=>new StagedKernelBuilder('29' as never),/Unsupported reviewed kernel target/);
  assert.throws(()=>stagedKernelComponents(Object.setPrototypeOf({},StagedKernelBuilder.prototype)),/private|read|member/i);
});

test('prepared kernel is bound to the exact callback token and explicit builders retain priority',local,async()=>{
  const x=await fixture();try{
    const second=await preparePostgresKernel(),expected=stagedKernelComponents(x.t.kernel),other=stagedKernelComponents(second);assert.notEqual(expected.model,other.model);assert.deepEqual(expected.model.ref,other.model.ref);
    let oldToken:object|undefined,late:(()=>unknown)|undefined;
    await x.t.database.run(async client=>{
      const token=postgresBusinessToken(client);assert.equal(postgresBusinessKernel(client,token),x.t.kernel);
      const first=await postgresOntologyRelease(client,x.ref),again=await postgresOntologyRelease(client,x.ref);assert.equal(first.model,expected.model);assert.equal(again.model,first.model);assert(Object.isFrozen(first.document));assert.notEqual(first.document,again.document,'each persisted release row is still parsed and verified');
      assert.equal((await postgresOntologyRelease(client,x.ref,second)).model,other.model,'explicit reviewed builder overrides this transaction host default');
    });
    await x.t.run(async client=>{oldToken=postgresBusinessToken(client);late=()=>postgresBusinessKernel(client,oldToken!);assert.equal(late(),x.t.kernel);});
    assert.throws(()=>late!(),/exact active/);
    await postgresBusinessTransaction(x.t.client,x.t.schema,x.t.authority,async client=>{
      const token=postgresBusinessToken(client);assert.notEqual(token,oldToken);assert.equal(postgresBusinessKernel(client,token),second);assert.throws(()=>late!(),/exact active/);
    },{kernel:second});
    await postgresBusinessTransaction(x.t.client,x.t.schema,x.t.authority,async client=>{assert.equal(postgresBusinessKernel(client,postgresBusinessToken(client)),undefined);});
  }finally{await x.close();}
});

test('unfinished, forged and method-overridden kernels are rejected before a PostgreSQL command',local,async()=>{
  const x=await fixture();try{
    const partial=new StagedKernelBuilder(),forged={trusted:()=>stagedKernelComponents(x.t.kernel)};
    Object.defineProperty(partial,'trusted',{value:()=>stagedKernelComponents(x.t.kernel)});
    let connections=0;const pool={connect:async()=>{connections++;throw new Error('An invalid kernel must not acquire a client');},end:async()=>{}};
    for(const kernel of [partial,forged,null]){
      assert.throws(()=>new PostgresDatabase(pool as never,x.t.schema,x.t.authority,{kernel:kernel as StagedKernelBuilder}),/not ready|Invalid staged/);
      let queried=false;const own=x.t.client.query.bind(x.t.client);x.t.client.query=((...args:Parameters<typeof own>)=>{queried=true;return Reflect.apply(own,undefined,args);}) as typeof x.t.client.query;
      try{await assert.rejects(postgresBusinessTransaction(x.t.client,x.t.schema,x.t.authority,async()=>{throw new Error('Invalid kernel callback ran');},{kernel:kernel as StagedKernelBuilder}),/not ready|Invalid staged/);assert.equal(queried,false);}
      finally{x.t.client.query=own;}
    }
    assert.equal(connections,0);
    await x.t.run(client=>assert.rejects(postgresOntologyRelease(client,x.ref,null as never),/Invalid staged/));
  }finally{await x.close();}
});

test('prepared models never bypass changed release rows, namespace ownership or the current task grant',local,async()=>{
  const x=await fixture(),corruptSchema=`eigos_business_${randomUUID().replaceAll('-','')}`,corrupt=`\"${corruptSchema}\"`,source=`\"${x.t.schema}\"`;try{
    // A minimal corruption fixture, matching the existing release-loader suite.
    // Imported append-only history and fingerprints remain untouched.
    await x.t.client.query(`CREATE SCHEMA ${corrupt};CREATE TABLE ${corrupt}.runtime_authority(slot BIGINT PRIMARY KEY,id TEXT,revision BIGINT,configuration_digest TEXT)`);
    await x.t.client.query(`INSERT INTO ${corrupt}.runtime_authority VALUES(1,$1,$2,$3)`,[x.t.authority.id,x.t.authority.revision,x.t.authority.digest]);
    await installPostgresAuthorityLock(x.t.client,corruptSchema);
    await x.t.client.query(`CREATE TABLE ${corrupt}.ontology_definition_releases(id TEXT,ontology_id TEXT,sequence BIGINT,digest TEXT,model_digest TEXT,body TEXT,created_at TEXT);CREATE TABLE ${corrupt}.ontology_definition_release_aliases(alias_id TEXT,ontology_id TEXT,canonical_id TEXT,digest TEXT);INSERT INTO ${corrupt}.ontology_definition_releases SELECT id,ontology_id,sequence,digest,model_digest,body,created_at FROM ${source}.ontology_definition_releases;INSERT INTO ${corrupt}.ontology_definition_release_aliases SELECT alias_id,ontology_id,canonical_id,digest FROM ${source}.ontology_definition_release_aliases`);
    await postgresBusinessTransaction(x.t.client,corruptSchema,x.t.authority,async client=>{
      const loaded=await postgresOntologyRelease(client,x.ref),found=await client.query(`SELECT id,body,model_digest FROM ${corrupt}.ontology_definition_releases WHERE id=$1 OR id IN(SELECT canonical_id FROM ${corrupt}.ontology_definition_release_aliases WHERE alias_id=$1 AND ontology_id=$2 AND digest=$3)`,[x.ref.releaseId,x.ref.ontologyId,x.ref.digest]);assert.equal(found.rowCount,1);const row=found.rows[0]!;
      await client.query(`UPDATE ${corrupt}.ontology_definition_releases SET body='{}' WHERE id=$1`,[row.id]);await assert.rejects(postgresOntologyRelease(client,x.ref),/Stored ontology release is invalid/);
      await client.query(`UPDATE ${corrupt}.ontology_definition_releases SET body=$1,model_digest=$2 WHERE id=$3`,[row.body,'b'.repeat(64),row.id]);await assert.rejects(postgresOntologyRelease(client,x.ref),/compiler or trusted handler contract changed/);
      await client.query(`UPDATE ${corrupt}.ontology_definition_releases SET model_digest=$1 WHERE id=$2`,[row.model_digest,row.id]);assert.equal((await postgresOntologyRelease(client,x.ref)).model,loaded.model);
    },{kernel:x.t.kernel});
    await x.t.run(async client=>{
      const q=`"${x.t.schema}"`,loaded=await postgresOntologyRelease(client,x.ref);
      assert.equal(loaded.model,stagedKernelComponents(x.t.kernel).model);
      const namespace=(await client.query(`SELECT owner FROM ${q}.ontology_namespaces WHERE id=$1`,[x.ref.ontologyId])).rows[0]!;
      await client.query(`UPDATE ${q}.ontology_namespaces SET owner='synthetic-foreign-owner' WHERE id=$1`,[x.ref.ontologyId]);await assert.rejects(postgresOntologyReadContext(client,x.f.owner,{release:x.ref}),/belongs to another owner/);
      await client.query(`UPDATE ${q}.ontology_namespaces SET owner=$1 WHERE id=$2`,[namespace.owner,x.ref.ontologyId]);assert.equal((await postgresOntologyReadContext(client,x.f.owner,{release:x.ref})).model,loaded.model);
      await postgresWorkerAdmission(client,x.f.owner,x.task.job.id,x.t.policy);
      await client.query(`UPDATE ${q}.security_grants SET state='revoked' WHERE id=$1`,[x.task.grant.id]);await assert.rejects(postgresWorkerAdmission(client,x.f.owner,x.task.job.id,x.t.policy),/AUTHORIZATION_REQUIRED/);
    });
  }finally{try{await x.t.client.query(`DROP SCHEMA IF EXISTS ${corrupt} CASCADE`);}finally{await x.close();}}
});
