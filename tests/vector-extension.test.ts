import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {rootCertificates} from 'node:tls';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {postgresVectorOperationSchema,previewPostgresVector,postgresVectorConnectionOptions,assertPostgresVectorSmoke,verifyPostgresVector,type PostgresVectorOperation} from '../packages/postgres/vector-extension.js';
import {readOwnedBindingFile} from '../packages/deployment/postgres-binding.js';
import {observePostgresClient} from '../packages/postgres/client-errors.js';

function operation():PostgresVectorOperation{return {version:1,kind:'eigos.postgres-vector-operation',
  target:{host:'aws-0-ap-northeast-1.pooler.supabase.com',port:5432,database:'postgres',ca:{path:'/private/synthetic-ca.pem',sha256:'a'.repeat(64)}},
  adminIdentity:{user:'postgres.synthetic-project',role:'postgres'},extension:{name:'vector',schema:'extensions',version:'0.8.2'}};}

test('vector preview pins only the reviewed extension and exact version without selecting business embeddings or grants',()=>{
  const input=operation(),preview=previewPostgresVector(input);
  assert.equal(preview.status,'preview-only');assert.equal(preview.targetInspected,false);
  assert.equal(preview.installSql,"CREATE EXTENSION vector WITH SCHEMA extensions VERSION '0.8.2'");
  assert.equal(preview.businessDataChanged,false);assert.equal(preview.runtimeGrantStatementsIssued,false);
  assert.equal(preview.runtimeRoleCompatibility,'not-verified');assert.equal(preview.semanticRetrieval,'not-configured');
  assert.equal(preview.embeddingProvider,'not-configured');
  assert.throws(()=>previewPostgresVector({...input,extension:{...input.extension,schema:'public'}}));
  assert.throws(()=>previewPostgresVector({...input,extension:{...input.extension,name:'unreviewed'}}));
  assert.throws(()=>previewPostgresVector({...input,extension:{...input.extension,version:"0.8.2'; SELECT 1"}}));
  assert.throws(()=>previewPostgresVector({...input,target:{...input.target,password:'do-not-accept'}}));
  assert.throws(()=>previewPostgresVector({...input,target:{...input.target,url:'postgresql://unused'}}));
});

test('vector admin connection keeps pinned CA, hostname, identity and password environment separate from operation files',()=>{
  const directory=mkdtempSync(join(tmpdir(),'eigos-vector-pure-'));
  try{
    const pem=rootCertificates[0];assert(pem);const path=join(directory,'ca.pem');writeFileSync(path,pem,{mode:0o600});
    const input=operation();input.target.ca={path,sha256:createHash('sha256').update(pem).digest('hex')};
    const environment={EIGOS_POSTGRES_ADMIN_USER:input.adminIdentity.user,EIGOS_POSTGRES_ADMIN_PASSWORD:'synthetic-in-memory-only'};
    const options=postgresVectorConnectionOptions(input,environment);
    assert.equal(options.ssl.rejectUnauthorized,true);assert.equal(options.ssl.servername,input.target.host);
    assert.equal(options.ssl.ca,pem);assert.equal(options.password,environment.EIGOS_POSTGRES_ADMIN_PASSWORD);
    assert.equal(options.user,'postgres.synthetic-project');assert.equal(options.database,'postgres');
    assert.equal(options.options,'-c search_path=pg_catalog');assert(!JSON.stringify(input).includes(environment.EIGOS_POSTGRES_ADMIN_PASSWORD));
    assert.throws(()=>postgresVectorConnectionOptions(input,{...environment,EIGOS_POSTGRES_ADMIN_USER:'another-user'}),/login differs/);
    assert.throws(()=>postgresVectorConnectionOptions(input,{...environment,EIGOS_POSTGRES_ADMIN_PASSWORD:''}),/password is unavailable/);
    assert.throws(()=>postgresVectorConnectionOptions(input,{...environment,PGOPTIONS:'-c search_path=public'}),/ambient/);
    assert.throws(()=>postgresVectorConnectionOptions(input,{...environment,NODE_TLS_REJECT_UNAUTHORIZED:'0'}),/TLS verification/);
    assert.throws(()=>postgresVectorConnectionOptions({...input,target:{...input.target,ca:{path,sha256:'b'.repeat(64)}}},environment),/CA differs/);
    assert.throws(()=>postgresVectorOperationSchema.parse({...input,target:{...input.target,proxyUrl:'http://user:password@localhost:7890'}}));
    assert.throws(()=>postgresVectorOperationSchema.parse({...input,target:{...input.target,host:'example.com',proxyUrl:'http://127.0.0.1:7890'}}));
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('vector arithmetic evidence refuses incomplete, nonfinite or incorrect operator results',()=>{
  const fixture={fixture:'orthogonal-unit-vectors-v1',dimensions:3,l2:Math.SQRT2,cosine:1,negativeInnerProduct:0,selfL2:0,selfCosine:0,selfNegativeInnerProduct:-1};
  assert.deepEqual(assertPostgresVectorSmoke(fixture),fixture);
  for(const invalid of [{...fixture,l2:2},{...fixture,cosine:0},{...fixture,selfNegativeInnerProduct:1},{...fixture,l2:Infinity},{...fixture,dimensions:384},{...fixture,source:'fabricated-model'}])assert.throws(()=>assertPostgresVectorSmoke(invalid));
  const {selfCosine:_missing,...incomplete}=fixture;assert.throws(()=>assertPostgresVectorSmoke(incomplete));
});

test('vector CLI refuses implicit connection, URL/password flags, missing review digest and overwrite modes without leaking environment secrets',()=>{
  const secret='synthetic-private-value-only',environment={...process.env,EIGOS_POSTGRES_ADMIN_PASSWORD:secret};
  const invoke=(args:string[])=>spawnSync(process.execPath,['scripts/postgres-vector.mjs',...args],{encoding:'utf8',env:environment});
  const help=invoke(['--help']);assert.equal(help.status,0);assert.match(help.stdout,/Preview is the default/);
  for(const args of [['--apply'],['--input','/private/unused.json','--apply','--readback'],['--input','/private/unused.json','--apply'],['--input','/private/unused.json','--output','/private/receipt.json'],['--url',`postgresql://postgres:${secret}@localhost/postgres`],['--password',secret],['--input','relative.json']]){
    const result=invoke(args);assert.equal(result.status,2);assert(!result.stdout.includes(secret));assert(!result.stderr.includes(secret));
  }
});

/** Opt in only against an already installed, explicitly reviewed vector
 * target. This suite never creates a schema/role/extension or a container. */
test('actual vector target has exact extension-owned C routines/operators and independently verified arithmetic',
  {skip:process.env.EIGOS_TEST_PG_VECTOR!=='1'},async()=>{
  const path=process.env.EIGOS_TEST_PG_VECTOR_OPERATION;if(!path)throw new Error('An explicit reviewed vector operation file is required');
  const input=postgresVectorOperationSchema.parse(JSON.parse(readOwnedBindingFile(path,16384,true).toString('utf8')));
  const client=new pg.Client(postgresVectorConnectionOptions(input,process.env)),observer=observePostgresClient(client);
  try{
    await client.connect();observer.check();const result=await verifyPostgresVector(client,input);observer.check();
    assert.equal(result.extension.version,input.extension.version);assert.equal(result.extension.schema,'extensions');
    assert(Math.abs(result.smoke.l2-Math.SQRT2)<1e-12,'PostgreSQL text float formatting must preserve the expected distance');assert.equal(result.runtimeGrantStatementsIssued,false);assert.equal(result.semanticRetrieval,'not-configured');
    await assert.rejects(verifyPostgresVector(client,{...input,extension:{...input.extension,version:input.extension.version==='999.999.999'?'998.999.999':'999.999.999'}}),/version differs/);
    assert.equal(client.getTransactionStatus(),'I','mismatch refuses and closes its read-only transaction');
  }finally{try{await client.end();observer.check();}finally{observer.close();}}
});
