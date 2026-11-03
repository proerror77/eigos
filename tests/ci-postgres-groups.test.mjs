import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';
import {POSTGRES_TEST_GROUPS,POSTGRES_GROUP_JOBS,POSTGRES_TEST_FILES,POSTGRES_PURE_TEST_FILES,POSTGRES_EXECUTION_GROUPS,POSTGRES_EXECUTION_JOBS,POSTGRES_COORDINATOR_CASES,POSTGRES_COORDINATOR_JOBS,postgresTestsRequired,assertPostgresGroups,assertExecutionCases,assertCoordinatorCases,coordinatorTestPattern,assertCoordinatorTap} from '../scripts/postgres-tests.mjs';
import {proveExactCi} from '../scripts/release-artifacts.mjs';
import {testFiles,shardFiles} from '../scripts/test-scope.mjs';

const workflow=parse(readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8'));
const sourceRef='${{ github.event.pull_request.head.sha || github.sha }}';
const needed={'1':['tests/postgres-coordinator.test.ts']},empty={'1':['tests/ci-postgres-groups.test.mjs']};
const success=()=>Object.fromEntries(['scope',...POSTGRES_GROUP_JOBS].map(name=>[name,{result:'success'}]));

test('real PostgreSQL suites have one deterministic group with no missing or duplicate files',()=>{
  assert.equal(POSTGRES_TEST_FILES.length,new Set(POSTGRES_TEST_FILES).size);
  const flagged=readdirSync(new URL('.',import.meta.url)).filter(name=>name.endsWith('.test.ts')).filter(name=>/process\.env\.(?:EIGOS_TEST_PG_LOCAL|EIGOS_TEST_RELAY_POSTGRES|EIGOS_TEST_LARGE_ROW)/.test(readFileSync(new URL(name,import.meta.url),'utf8'))).map(name=>'tests/'+name);
  assert.deepEqual(flagged.filter(path=>!POSTGRES_TEST_FILES.includes(path)),[]);
  for(const path of POSTGRES_TEST_FILES)assert(readFileSync(new URL('../'+path,import.meta.url),'utf8').length);
  assert.deepEqual(Object.keys(POSTGRES_TEST_GROUPS),['storage','access','execution','coordinator']);
  assert.deepEqual(POSTGRES_TEST_GROUPS.coordinator,['tests/postgres-coordinator.test.ts']);
  const all=testFiles(fileURLToPath(new URL('../',import.meta.url)));
  assert.equal(postgresTestsRequired(shardFiles(all)),true,'the actual full test-scope shards must remain schedulable');
  for(const path of POSTGRES_PURE_TEST_FILES){assert(!POSTGRES_TEST_FILES.includes(path));assert(!/process\.env\.(?:EIGOS_TEST_PG_LOCAL|EIGOS_TEST_RELAY_POSTGRES|EIGOS_TEST_LARGE_ROW)/.test(readFileSync(new URL('../'+path,import.meta.url),'utf8')));}
});

test('PG scope selection rejects unknown suites instead of silently dropping a required check',()=>{
  assert.equal(postgresTestsRequired(needed),true);assert.equal(postgresTestsRequired(JSON.stringify(empty)),false);
  assert.equal(postgresTestsRequired({'1':[...POSTGRES_PURE_TEST_FILES]}),false);
  for(const value of [null,[],{'1':'not-an-array'},{'1':['tests/postgres-unregistered.test.ts']}])assert.throws(()=>postgresTestsRequired(value));
});

test('the relay-postgres aggregate rejects missing, skipped, failed or canceled required groups',()=>{
  assert.equal(assertPostgresGroups(success(),needed).required,true);
  for(const result of ['failure','cancelled','skipped',undefined])for(const name of POSTGRES_GROUP_JOBS){const needs=success();if(result===undefined)delete needs[name];else needs[name].result=result;assert.throws(()=>assertPostgresGroups(needs,needed),/not successful/);}
  assert.throws(()=>assertPostgresGroups({...success(),scope:{result:'failure'}},needed),/successful test scope/);
  const skipped={scope:{result:'success'},...Object.fromEntries(POSTGRES_GROUP_JOBS.map(name=>[name,{result:'skipped'}]))};
  assert.equal(assertPostgresGroups(skipped,empty).required,false);
});

test('all required groups keep their own bounded service and exact-source checkout; aggregate runs on failure',()=>{
  for(const name of ['scope','verify',...POSTGRES_GROUP_JOBS,'postgres-execution-cases','postgres-coordinator-cases','tests','relay-postgres']){
    const job=workflow.jobs[name];assert(job,name);
    for(const step of job.steps.filter(step=>step.uses?.startsWith('actions/checkout@')))assert.equal(step.with?.ref,sourceRef,name);
  }
  for(const [group,files] of Object.entries(POSTGRES_TEST_GROUPS)){
    const job=workflow.jobs[group==='coordinator'?'postgres-coordinator-cases':group==='execution'?'postgres-execution-cases':'postgres-'+group];assert(job.services.postgres);assert.equal(job['timeout-minutes'],30);assert(job.if.includes("needs.scope.outputs.postgres == 'true'"));
    assert(job.steps.some(step=>step.run?.startsWith('node scripts/postgres-tests.mjs run --group '+group)));assert(files.length);
  }
  assert.deepEqual(workflow.jobs['relay-postgres'].needs,['scope',...POSTGRES_GROUP_JOBS]);
  assert.equal(workflow.jobs['relay-postgres'].if,'${{ always() }}');
  assert(workflow.jobs['relay-postgres'].steps.some(step=>step.run==='node scripts/postgres-tests.mjs aggregate'));
  assert(readFileSync(new URL('../scripts/postgres-tests.mjs',import.meta.url),'utf8').includes("'--test-concurrency=1'"));
});

test('execution partitions preserve every original file once and require all actual partition results',()=>{
  const files=Object.values(POSTGRES_EXECUTION_GROUPS).flat();assert.equal(files.length,new Set(files).size);assert.deepEqual([...files].sort(),[...POSTGRES_TEST_GROUPS.execution].sort());
  assert.deepEqual(workflow.jobs['postgres-execution-cases'].strategy.matrix.case,Object.keys(POSTGRES_EXECUTION_GROUPS));assert.deepEqual(workflow.jobs['postgres-execution'].needs,['scope','postgres-execution-cases']);assert.equal(workflow.jobs['postgres-execution'].if,'${{ always() }}');
  for(const result of ['failure','cancelled','skipped',undefined])assert.throws(()=>assertExecutionCases({scope:{result:'success'},'postgres-execution-cases':{result}},needed),/not successful/);
  assert.equal(assertExecutionCases({scope:{result:'success'},'postgres-execution-cases':{result:'success'}},needed).required,true);
});

test('Coordinator case sets cover every top-level test once and keep every revocation child selected',()=>{
  const source=readFileSync(new URL('./postgres-coordinator.test.ts',import.meta.url),'utf8');
  const names=[...source.matchAll(/^test\('([^']+)'/gm)].map(match=>match[1]);assert.equal(names.length,7);
  for(const name of names)assert.equal(Object.keys(POSTGRES_COORDINATOR_CASES).filter(scenario=>new RegExp(coordinatorTestPattern(scenario)).test(name)).length,1,name);
  for(const child of ['parent','role','source','model'])assert(new RegExp(coordinatorTestPattern('revocation')).test(names.find(name=>name.startsWith('parent, action role'))+' '+child));
  assert.deepEqual(workflow.jobs['postgres-coordinator-cases'].strategy.matrix.case,Object.keys(POSTGRES_COORDINATOR_CASES));
  assert.deepEqual(workflow.jobs['postgres-coordinator'].needs,['scope','postgres-coordinator-cases']);assert.equal(workflow.jobs['postgres-coordinator'].if,'${{ always() }}');
  for(const result of ['failure','cancelled','skipped',undefined])assert.throws(()=>assertCoordinatorCases({scope:{result:'success'},'postgres-coordinator-cases':{result}},needed),/not successful/);
  assert.equal(assertCoordinatorCases({scope:{result:'success'},'postgres-coordinator-cases':{result:'success'}},needed).required,true);
});

test('Coordinator success requires actual non-skipped TAP cases and all four revocation children',()=>{
  const names=POSTGRES_COORDINATOR_CASES.protocol.map((name,i)=>`ok ${i+1} - ${name}`);assertCoordinatorTap('protocol',names);
  assert.throws(()=>assertCoordinatorTap('protocol',names.map(line=>line+' # SKIP')),/did not actually pass/);
  const revoked=['parent','role','source','model'].map((name,i)=>`    ok ${i+1} - ${name}`),parent='ok 5 - '+POSTGRES_COORDINATOR_CASES.revocation[0];
  assertCoordinatorTap('revocation',[...revoked,parent]);assert.throws(()=>assertCoordinatorTap('revocation',[...revoked.slice(1),parent]),/subtest did not actually pass/);
});

test('immutable release proof requires the actual successful PG groups as well as their aggregate',()=>{
  const sha='1'.repeat(40),run={id:17,head_sha:sha,status:'completed',conclusion:'success',html_url:'https://github.com/example/eigos/actions/runs/17',head_repository:{full_name:'example/eigos'}};
  const names=['scope','verify','relay-postgres',...POSTGRES_GROUP_JOBS,...POSTGRES_COORDINATOR_JOBS,...POSTGRES_EXECUTION_JOBS,...Array.from({length:8},(_,i)=>`tests (${i+1})`)];
  const jobs=names.map(name=>({name,status:'completed',conclusion:'success',...(name==='verify'?{steps:['npm run check','npm run build','npm run test:e2e:run'].map(command=>({name:'Run '+command,status:'completed',conclusion:'success'}))}:{})}));
  assert.deepEqual(proveExactCi(run,jobs,sha,'example/eigos').jobs,names);
  for(const name of [...POSTGRES_GROUP_JOBS,...POSTGRES_COORDINATOR_JOBS,...POSTGRES_EXECUTION_JOBS])assert.throws(()=>proveExactCi(run,jobs.filter(job=>job.name!==name),sha,'example/eigos'),/Required CI job/);
});
