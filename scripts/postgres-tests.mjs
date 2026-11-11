// Deterministic real-PostgreSQL CI groups. Every selected boundary remains
// covered; each group runs one test file at a time on its own service instance.
import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';

export const POSTGRES_TEST_GROUPS=Object.freeze({
  storage:Object.freeze(["tests/relay-postgres-import.test.ts","tests/relay-postgres-grant.test.ts","tests/business-postgres-schema.test.ts","tests/business-postgres-import.test.ts","tests/business-postgres-large-row.test.ts","tests/membership-postgres-import.test.ts","tests/postgres-identity-audit.test.ts","tests/postgres-runtime-transaction.test.ts","tests/postgres-work-authority.test.ts","tests/postgres-ontology-release.test.ts","tests/postgres-kernel-runtime.test.ts","tests/postgres-projection-graph.test.ts","tests/postgres-supabase-proxy.test.ts","tests/postgres-messaging.test.ts","tests/postgres-client-errors.test.ts","tests/postgres-primary-handoff.test.ts","tests/postgres-handoff-vector-isolation.test.ts","tests/relay-client-repoint.test.ts","tests/postgres-node-migration.test.ts"]),
  access:Object.freeze(["tests/postgres-task-read-access.test.ts","tests/postgres-ontology-metadata.test.ts","tests/postgres-definition-service.test.ts","tests/postgres-action-discovery.test.ts","tests/postgres-ontology-query.test.ts","tests/postgres-ontology-functions.test.ts","tests/postgres-executable-contracts.test.ts","tests/postgres-function-closeout.test.ts","tests/postgres-planning-context.test.ts","tests/postgres-native-planning.test.ts","tests/postgres-model-usage.test.ts","tests/postgres-member-store.test.ts","tests/postgres-authority-publisher.test.ts","tests/postgres-permission-management.test.ts","tests/postgres-task-relay.test.ts","tests/postgres-host-runtime.test.ts","tests/postgres-authentication.test.ts","tests/postgres-access-check.test.ts","tests/postgres-eligibility-inspection.test.ts","tests/postgres-eligibility-snapshot.test.ts","tests/postgres-work-availability.test.ts","tests/postgres-worker-loop.test.ts"]),
  execution:Object.freeze(["tests/postgres-consent.test.ts","tests/postgres-task-commands.test.ts","tests/postgres-task-intents.test.ts","tests/postgres-action-journal.test.ts","tests/postgres-caller-action.test.ts","tests/postgres-task-binding-batch.test.ts","tests/postgres-action-authorization.test.ts","tests/postgres-action-permit.test.ts","tests/postgres-recovery-commands.test.ts","tests/document-program-parity.test.ts","tests/composition-program-parity.test.ts","tests/postgres-source-projection.test.ts","tests/postgres-document-policy.test.ts","tests/postgres-document-execution.test.ts","tests/postgres-didi.test.ts","tests/postgres-didi-scheduling.test.ts","tests/postgres-didi-relay.test.ts","tests/postgres-agent-plan.test.ts","tests/postgres-goal-contexts.test.ts","tests/postgres-document-bindings.test.ts","tests/postgres-model-context.test.ts","tests/postgres-capability-catalog.test.ts","tests/goal-assessment-program.test.ts","tests/postgres-worker-read-lease.test.ts","tests/postgres-worker-write-lease.test.ts"]),
  coordinator:Object.freeze(["tests/postgres-coordinator.test.ts"]),
  vectors:Object.freeze(['tests/postgres-embedding-index.test.ts']),
});
export const POSTGRES_VECTOR_CASES=Object.freeze(['supplied task vectors use actual pgvector through a restricted runtime, exact field grants and complete current index']);
export const POSTGRES_EXECUTION_GROUPS=Object.freeze({
  contracts:Object.freeze(['tests/postgres-consent.test.ts','tests/composition-program-parity.test.ts','tests/document-program-parity.test.ts','tests/goal-assessment-program.test.ts','tests/postgres-action-authorization.test.ts','tests/postgres-action-journal.test.ts','tests/postgres-action-permit.test.ts','tests/postgres-capability-catalog.test.ts','tests/postgres-recovery-commands.test.ts']),
  planning:Object.freeze(['tests/postgres-agent-plan.test.ts','tests/postgres-document-bindings.test.ts','tests/postgres-goal-contexts.test.ts','tests/postgres-model-context.test.ts']),
  documents:Object.freeze(['tests/postgres-document-execution.test.ts','tests/postgres-document-policy.test.ts']),
  didi:Object.freeze(['tests/postgres-didi.test.ts','tests/postgres-didi-relay.test.ts']),
  // Keep fixed-workflow/scheduling regressions beside the shorter transition suites.
  transitions:Object.freeze(['tests/postgres-didi-scheduling.test.ts','tests/postgres-task-commands.test.ts','tests/postgres-task-intents.test.ts','tests/postgres-caller-action.test.ts','tests/postgres-task-binding-batch.test.ts','tests/postgres-source-projection.test.ts','tests/postgres-worker-read-lease.test.ts','tests/postgres-worker-write-lease.test.ts']),
});
export const POSTGRES_EXECUTION_JOBS=Object.freeze(Object.keys(POSTGRES_EXECUTION_GROUPS).map(name=>'postgres-execution-cases ('+name+')'));
export const POSTGRES_COORDINATOR_CASES=Object.freeze({
  protocol:Object.freeze(['the default Codex review','an unadapted synchronous model port','HTTP MCP and A2A reach']),
  revocation:Object.freeze(['parent, action role, source and model revocation']),
  lifecycle:Object.freeze(['canceling the original task','an incomplete whole-goal assessment','an unknown original document invocation','repairable pre-dispatch plan feedback']),
});
export const POSTGRES_COORDINATOR_JOBS=Object.freeze(Object.keys(POSTGRES_COORDINATOR_CASES).map(name=>'postgres-coordinator-cases ('+name+')'));
export const POSTGRES_GROUP_JOBS=Object.freeze(Object.keys(POSTGRES_TEST_GROUPS).map(group=>'postgres-'+group));
export const POSTGRES_TEST_FILES=Object.freeze(Object.values(POSTGRES_TEST_GROUPS).flat());
// These names describe offline PostgreSQL migration formats/CLI planning;
// they never connect to the fixture service and remain ordinary unit suites.
export const POSTGRES_PURE_TEST_FILES=Object.freeze(['tests/business-postgres-snapshot.test.ts','tests/business-postgres-verify-cli.test.ts','tests/relay-postgres-cli.test.ts','tests/postgres-gateway-startup.test.ts','tests/postgres-binding.test.ts','tests/postgres-handoff.test.ts','tests/postgres-node-migration-pure.test.ts','tests/postgres-didi-host.test.ts']);
const pgFile=path=>/^tests\/(?:postgres-|relay-postgres-|business-postgres-|membership-postgres-)/.test(path)||['tests/document-program-parity.test.ts','tests/composition-program-parity.test.ts','tests/goal-assessment-program.test.ts','tests/relay-client-repoint.test.ts'].includes(path);

export function postgresTestsRequired(input){
  const shards=typeof input==='string'?JSON.parse(input):input;
  if(!shards||typeof shards!=='object'||Array.isArray(shards)||Object.values(shards).some(files=>!Array.isArray(files)||files.some(path=>typeof path!=='string')))throw Error('A valid selected test scope is required');
  const selected=Object.values(shards).flat().filter(path=>pgFile(path)&&!POSTGRES_PURE_TEST_FILES.includes(path));
  if(selected.some(path=>!POSTGRES_TEST_FILES.includes(path)))throw Error('A selected PostgreSQL suite has no registered CI group');
  return selected.length>0;
}

export function assertPostgresGroups(needs,scope){
  if(!needs||typeof needs!=='object'||needs.scope?.result!=='success')throw Error('PostgreSQL checks require a successful test scope');
  const required=postgresTestsRequired(scope);
  for(const name of POSTGRES_GROUP_JOBS){
    const result=needs[name]?.result;
    if(required&&result!=='success')throw Error('Required PostgreSQL group is not successful: '+name+' ('+String(result)+')');
    if(!required&&result!=='skipped'&&result!=='success')throw Error('Unexpected PostgreSQL group result: '+name);
  }
  return {required,groups:[...POSTGRES_GROUP_JOBS]};
}

export function assertCoordinatorCases(needs,scope){
  if(!needs||needs.scope?.result!=='success')throw Error('Coordinator checks require a successful test scope');
  const required=postgresTestsRequired(scope),result=needs['postgres-coordinator-cases']?.result;
  if(required&&result!=='success'||!required&&result!=='success'&&result!=='skipped')throw Error('Required Coordinator cases are not successful: '+String(result));
  return {required,cases:[...POSTGRES_COORDINATOR_JOBS]};
}

export function assertExecutionCases(needs,scope){
  if(!needs||needs.scope?.result!=='success')throw Error('Execution checks require a successful test scope');
  const required=postgresTestsRequired(scope),result=needs['postgres-execution-cases']?.result;
  if(required&&result!=='success'||!required&&result!=='success'&&result!=='skipped')throw Error('Required execution groups are not successful: '+String(result));
  return {required,groups:[...POSTGRES_EXECUTION_JOBS]};
}

export function coordinatorTestPattern(scenario){
  if(!Object.hasOwn(POSTGRES_COORDINATOR_CASES,scenario))throw Error('Unknown Coordinator case set');
  return '^(?:'+POSTGRES_COORDINATOR_CASES[scenario].map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')';
}
export function assertCoordinatorTap(scenario,lines){
  const top=[],nested=[];
  for(const line of lines){const match=line.match(/^(\s*)ok \d+ - (.+)$/);if(!match||/ #\s*(?:SKIP|TODO)\b/i.test(match[2]))continue;(match[1]?nested:top).push(match[2]);}
  for(const name of POSTGRES_COORDINATOR_CASES[scenario])if(!top.some(value=>value.startsWith(name)))throw Error('Coordinator case did not actually pass: '+name);
  if(scenario==='revocation')for(const name of ['parent','role','source','model'])if(!nested.includes(name))throw Error('Revocation subtest did not actually pass: '+name);
}

export function assertVectorTap(lines){
  const passed=lines.flatMap(line=>{const match=line.match(/^ok \d+ - (.+)$/);return match&&!/ #\s*(?:SKIP|TODO)\b/i.test(match[1])?[match[1]]:[];});
  if(passed.length!==POSTGRES_VECTOR_CASES.length||POSTGRES_VECTOR_CASES.some(name=>!passed.includes(name)))throw Error('Required vector cases did not actually pass');
  for(const [key,expected] of Object.entries({tests:POSTGRES_VECTOR_CASES.length,pass:POSTGRES_VECTOR_CASES.length,fail:0,cancelled:0,skipped:0,todo:0})){
    const counts=lines.flatMap(line=>{const match=line.match(new RegExp('^# '+key+' (\\d+)$'));return match?[Number(match[1])]:[];});
    if(counts.length!==1||counts[0]!==expected)throw Error('Vector TAP requires complete non-skipped success: '+key);
  }
}

/** This synthetic fixture has an explicit loopback port/password contract.
 * Neither needed/aggregate nor normal test startup initializes any database. */
export function vectorTestFixtureOptions(env){
  const port=Number(env.EIGOS_TEST_VECTOR_PGPORT);
  if(env.EIGOS_TEST_VECTOR_PG!=='1'||env.EIGOS_TEST_PG_LOCAL!=='1'||env.PGHOST!=='127.0.0.1'||env.PGUSER!=='postgres'||env.PGDATABASE!=='postgres'
    ||env.PGPASSWORD!=='synthetic-vectors-only'||!Number.isSafeInteger(port)||port<1||port>65535||String(port)!==env.PGPORT||env.PGOPTIONS||env.PGSERVICE||env.PGSERVICEFILE)throw Error('Vector tests require their explicit isolated synthetic loopback fixture');
  return {host:'127.0.0.1',port,user:'postgres',database:'postgres',password:'synthetic-vectors-only',ssl:false,connectionTimeoutMillis:10000,statement_timeout:10000};
}
async function prepareVectorFixture(env){
  const connection=vectorTestFixtureOptions(env),{default:pg}=await import('pg'),client=new pg.Client(connection);let failure,open=false;
  client.on('error',error=>{failure??=error;});
  try{
    await client.connect();await client.query('BEGIN');open=true;
    const installed=await client.query(`SELECT n.nspname,e.extversion FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'`);
    if(installed.rowCount){if(installed.rowCount!==1||installed.rows[0].nspname!=='extensions'||installed.rows[0].extversion!=='0.8.2')throw Error('Vector fixture must use exact pgvector0.8.2; upgrades/relocation are forbidden');}
    else{
      if((await client.query("SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='extensions'")).rowCount)throw Error('Vector fixture namespace must be fresh or already contain the exact extension');
      await client.query("CREATE SCHEMA extensions; CREATE EXTENSION vector WITH SCHEMA extensions VERSION '0.8.2'");
    }
    await client.query('REVOKE ALL ON SCHEMA extensions FROM PUBLIC');if(failure)throw failure;
    await client.query('COMMIT');open=false;if(failure)throw failure;
  }catch(error){if(open)try{await client.query('ROLLBACK');}catch{/* Keep the original fixture failure; do not retry. */}throw error;}
  finally{await client.end();if(failure)throw failure;}
}

async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,options:{group:{type:'string'},case:{type:'string'}}}),command=positionals[0];
  if(command==='needed'){const required=postgresTestsRequired(process.env.PG_TEST_SHARDS);if(!process.env.GITHUB_OUTPUT)throw Error('CI output path is required');appendFileSync(process.env.GITHUB_OUTPUT,'required='+required+'\n');console.log(JSON.stringify({required,groups:POSTGRES_GROUP_JOBS}));return;}
  if(command==='aggregate-execution'){console.log(JSON.stringify(assertExecutionCases(JSON.parse(process.env.PG_CI_NEEDS??'null'),process.env.PG_TEST_SHARDS)));return;}
  if(command==='aggregate-coordinator'){console.log(JSON.stringify(assertCoordinatorCases(JSON.parse(process.env.PG_CI_NEEDS??'null'),process.env.PG_TEST_SHARDS)));return;}
  if(command==='aggregate'){console.log(JSON.stringify(assertPostgresGroups(JSON.parse(process.env.PG_CI_NEEDS??'null'),process.env.PG_TEST_SHARDS)));return;}
  if(command!=='run'||!Object.hasOwn(POSTGRES_TEST_GROUPS,values.group??''))throw Error('Use needed, aggregate, or run --group <registered group>');
  const scenario=values.case,coordinator=values.group==='coordinator',execution=values.group==='execution',vectors=values.group==='vectors';
  if(coordinator&&!Object.hasOwn(POSTGRES_COORDINATOR_CASES,scenario??'')||execution&&!Object.hasOwn(POSTGRES_EXECUTION_GROUPS,scenario??'')||!coordinator&&!execution&&scenario)throw Error('Use exactly one registered case set for split suites');
  const files=execution?POSTGRES_EXECUTION_GROUPS[scenario]:POSTGRES_TEST_GROUPS[values.group];
  // Prefix matching intentionally includes every nested revocation subtest.
  const pattern=coordinator?coordinatorTestPattern(scenario):undefined;
  const options=['--import','tsx','--test','--test-concurrency=1','--test-reporter=tap',...(pattern?['--test-name-pattern='+pattern]:[])];
  console.log(JSON.stringify({group:values.group,testFileConcurrency:1,files}));
  for(const name of ['EIGOS_TEST_PG_LOCAL','EIGOS_TEST_RELAY_POSTGRES','EIGOS_TEST_LARGE_ROW'])if(process.env[name]!=='1')throw Error('Required PostgreSQL test flag is missing: '+name);
  if(vectors)await prepareVectorFixture(process.env);
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[...options,...files],{stdio:['inherit','pipe','inherit']}),lines=[];let pending='',bytes=0;
    child.stdout.on('data',chunk=>{process.stdout.write(chunk);if(coordinator||vectors){bytes+=chunk.length;if(bytes>4194304){child.kill();reject(Error('PostgreSQL TAP exceeds its bounded validation log'));return;}pending+=chunk.toString();const complete=pending.split('\n');pending=complete.pop();lines.push(...complete);}});
    child.once('error',reject);child.once('close',(code,signal)=>{if(code!==0||signal){reject(Error('PostgreSQL group failed: '+values.group+' ('+String(signal??code)+')'));return;}try{if(coordinator)assertCoordinatorTap(scenario,[...lines,pending]);if(vectors)assertVectorTap([...lines,pending]);resolve();}catch(error){reject(error);}});
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
