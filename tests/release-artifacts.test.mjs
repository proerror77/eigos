import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {parse} from 'yaml';
import {artifactDigest,canonical,createReleaseManifest,createReleaseArtifacts,validateReleaseManifest,readReleaseManifest,verifyReleaseArtifacts,verifyRuntimeImagePayload,finalizeReleaseArtifacts,selectExactCiRun,proveExactCi,proveExactSemanticCi,HARNESS_RELEASE_TOOLS} from '../scripts/release-artifacts.mjs';

const sourceSha='1'.repeat(40),rawDigest=bytes=>createHash('sha256').update(bytes).digest('hex'),roles=['gateway','relay','worker'];
const jobs=['scope','verify','relay-postgres','postgres-storage','postgres-access','postgres-execution','postgres-coordinator','postgres-vectors','postgres-coordinator-cases (protocol)','postgres-coordinator-cases (revocation)','postgres-coordinator-cases (lifecycle)','postgres-execution-cases (contracts)','postgres-execution-cases (planning)','postgres-execution-cases (documents)','postgres-execution-cases (didi)','postgres-execution-cases (transitions)',...Array.from({length:8},(_,i)=>`tests (${i+1})`)];
const legacyJobs=jobs.slice();jobs.push('minimum-node');
const minimumNodeCommand='Run node --import tsx --test tests/transaction-savepoints.test.ts tests/execution-projection-noop.test.ts tests/graph-read-window.test.ts';
const ci={sourceSha,runId:17,url:'https://github.com/example/eigos/actions/runs/17',jobs},legacyCi={...ci,jobs:legacyJobs};
const images=Object.fromEntries(roles.map((role,i)=>[role,`ghcr.io/example/eigos/${role}@sha256:${String(i+1).repeat(64)}`]));
const harnessImage={sourceSha,image:images.worker,version:HARNESS_RELEASE_TOOLS.harness,providers:['deepseek-official','openai-codex'],initialize:'acknowledged',modelTurns:0,compiledAdapter:'present',state:'candidate'};
const harnessPaths=['dist/packages/capabilities/harness-executor.js','dist/apps/worker/postgres-runtime.js','dist/packages/core/model-usage-context.js','dist/packages/core/model-dispatch-context.js','dist/packages/postgres/coordinator.js'];
function fixture(backend='codex',semantic=false,incremental=false){
  const directory=mkdtempSync(join(tmpdir(),'eigos-release-artifacts-')),put=(prefix,path,bytes)=>{const file=join(directory,prefix,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes);return {path,sha256:rawDigest(bytes),bytes:Buffer.byteLength(bytes)};};
  const runtimeFiles=[put('runtime','dist/apps/gateway/main.js','// explicit synthetic runtime fixture\n'),put('runtime','package.json','{"name":"eigos","version":"0.1.0"}\n'),put('runtime','package-lock.json','{"lockfileVersion":3}\n')],sourceFiles=[put('source','apps/gateway/main.ts','// explicit synthetic source fixture\n')];
  if(backend==='harness')for(const path of harnessPaths){runtimeFiles.push(put('runtime',path,'// explicit synthetic Harness runtime inventory\n'));sourceFiles.push(put('source',path.replace(/^dist\//,'').replace(/\.js$/,'.ts'),'// explicit synthetic Harness source inventory\n'));}
  if(semantic){runtimeFiles.push(put('runtime','dist/packages/semantic/runtime.js','// synthetic optional local semantic module\n'));sourceFiles.push(put('source','packages/semantic/runtime.ts','// synthetic optional local semantic source\n'));}
  if(incremental){runtimeFiles.push(put('runtime','dist/packages/ontology/projection-delta.js','// synthetic incremental projection runtime\n'));sourceFiles.push(put('source','packages/ontology/projection-delta.ts','// synthetic incremental projection source\n'));}
  const document={formatVersion:1,id:'synthetic.ontology',version:'1',objects:[],interfaces:[],links:[],actions:[],functions:[]},kernelBytes=canonical(document)+'\n',file=put('ontology','kernel.json',kernelBytes),pkg={format:'eigos.ontology-package/1',kernel:{id:document.id,version:document.version,documentDigest:artifactDigest(document),modelDigest:'a'.repeat(64),file},providerModules:[]},packageFile=put('','ontology/package.json',canonical(pkg)+'\n');
  const build=createHash('sha256');for(const file of runtimeFiles){build.update(file.path+'\0');build.update(readFileSync(join(directory,'runtime',file.path)));}
  const input={sourceSha,version:'0.1.0',buildDigest:build.digest('hex'),runtimeFiles,sourceFiles,lockfile:runtimeFiles[2],ontology:{packageFile,package:pkg}};
  return {directory,input,put,close:()=>rmSync(directory,{recursive:true,force:true})};
}

test('release manifests are deterministic and candidate until all fixed image digests and exact-source CI exist',()=>{
  const x=fixture();try{
    const candidate=createReleaseManifest(x.input);assert.equal(candidate.state,'candidate');assert.throws(()=>validateReleaseManifest(candidate,{requireReady:true}),/artifact-ready/);
    const ready=createReleaseManifest({...x.input,images,ci});assert.equal(ready.state,'artifact-ready');assert.equal(candidate.payloadDigest,ready.payloadDigest);assert.notEqual(candidate.manifestDigest,ready.manifestDigest);
    const again=createReleaseManifest({...x.input,images:{worker:images.worker,relay:images.relay,gateway:images.gateway},ci});assert.equal(canonical(ready),canonical(again));
    assert.throws(()=>createReleaseManifest({...x.input,images:{gateway:'ghcr.io/example/eigos/gateway:latest'},ci}),/immutable OCI/);
    assert.throws(()=>createReleaseManifest({...x.input,ci:{...ci,sourceSha:'2'.repeat(40)}}),/Exact-source/);
    assert.throws(()=>createReleaseManifest({...x.input,backend:'harness'}),/actual executor.*runtime inventory/);
    assert.throws(()=>createReleaseManifest({...x.input,backend:'disabled'}),/registered.*backend/);
    assert.equal(Object.hasOwn(candidate.ontology,'publishedRef'),false);assert.equal(Object.hasOwn(candidate.ontology.package.kernel,'releaseId'),false);
  }finally{x.close();}
});

test('verification reads actual bytes, lockfile, ontology package and fixed document identity',()=>{
  const x=fixture();try{
    const manifest=createReleaseManifest({...x.input,images,ci});writeFileSync(join(x.directory,'manifest.json'),canonical(manifest)+'\n');assert.equal(readReleaseManifest(join(x.directory,'manifest.json'),{requireReady:true}).manifestDigest,manifest.manifestDigest);assert.equal(verifyReleaseArtifacts(x.directory).manifestDigest,manifest.manifestDigest);
    writeFileSync(join(x.directory,'runtime/package-lock.json'),'changed lock');assert.throws(()=>verifyReleaseArtifacts(x.directory),/differs/);
  }finally{x.close();}
});

test('installed image proof verifies actual runtime bytes and rejects a different release backend or source',()=>{
  for(const backend of ['codex','harness']){
    const x=fixture(backend);try{
      const candidate=createReleaseManifest({...x.input,backend}),root=join(x.directory,'runtime');
      mkdirSync(join(root,'release'));writeFileSync(join(root,'release/manifest.json'),canonical(candidate)+'\n');
      assert.deepEqual(verifyRuntimeImagePayload(root,{sourceSha,backend}),{sourceSha,backend,payloadDigest:candidate.payloadDigest,buildDigest:candidate.runtime.buildDigest});
      assert.throws(()=>verifyRuntimeImagePayload(root,{sourceSha,backend:backend==='codex'?'harness':'codex'}),/selected source or release backend/);
      assert.throws(()=>verifyRuntimeImagePayload(root,{sourceSha:'2'.repeat(40),backend}),/selected source or release backend/);
      writeFileSync(join(root,'dist/apps/gateway/main.js'),'different installed runtime');
      assert.throws(()=>verifyRuntimeImagePayload(root,{sourceSha,backend}),/Installed image runtime differs/);
    }finally{x.close();}
  }
});

test('artifact inventories reject private state, traversal, symlinks and invented database publication refs',()=>{
  const x=fixture();try{
    for(const path of ['../auth.json','/tmp/auth.json','data/tasks.sqlite','dist/.env.production','dist/private.config.json','dist/.codex/auth.json','dist/.dsh/session.json','dist/tasks.sqlite3','dist/credentials.json'])assert.throws(()=>createReleaseManifest({...x.input,runtimeFiles:[{path,sha256:'a'.repeat(64),bytes:1}]}),/Private state|relative paths/);
    const ordinary=createReleaseManifest(x.input),changed={...ordinary,ontology:{...ordinary.ontology,publishedRef:{releaseId:'invented'}}};assert.throws(()=>validateReleaseManifest(changed),/Invalid ontology artifact/);
    writeFileSync(join(x.directory,'manifest.json'),canonical(ordinary)+'\n');rmSync(join(x.directory,'runtime/dist/apps/gateway/main.js'));symlinkSync('/etc/hosts',join(x.directory,'runtime/dist/apps/gateway/main.js'));assert.throws(()=>verifyReleaseArtifacts(x.directory),/symbolic links/);
  }finally{x.close();}
});

test('latest exact CI, all required jobs and real runtime validation are gates before publishing',()=>{
  const run={id:17,run_number:4,run_attempt:1,head_sha:sourceSha,status:'completed',conclusion:'success',html_url:ci.url,head_repository:{full_name:'example/eigos'}},checks=jobs.map(name=>({name,status:'completed',conclusion:'success',...(name==='verify'?{steps:['npm run check','npm run build','npm run test:e2e:run'].map(command=>({name:`Run ${command}`,status:'completed',conclusion:'success'}))}:name==='postgres-vectors'?{steps:[{name:'Run node scripts/postgres-tests.mjs run --group vectors',status:'completed',conclusion:'success'}]}:name==='minimum-node'?{steps:['Verify exact source',minimumNodeCommand].map(name=>({name,status:'completed',conclusion:'success'}))}:{})}));
  assert.equal(selectExactCiRun({workflow_runs:[run]},sourceSha).id,17);assert.deepEqual(proveExactCi(run,checks,sourceSha,'example/eigos'),ci);
  assert.throws(()=>selectExactCiRun({workflow_runs:[run,{...run,id:18,run_number:5,status:'in_progress',conclusion:null}]},sourceSha),/latest CI/);
  assert.throws(()=>proveExactCi(run,checks.filter(job=>job.name!=='relay-postgres'),sourceSha,'example/eigos'),/Required CI job/);
  assert.throws(()=>proveExactCi(run,checks.map(job=>job.name==='verify'?{...job,steps:[]}:job),sourceSha,'example/eigos'),/runtime validation/);
  assert.throws(()=>proveExactCi(run,checks.map(job=>job.name==='postgres-vectors'?{...job,steps:[]}:job),sourceSha,'example/eigos'),/vector validation/);
  assert.throws(()=>proveExactCi(run,checks.map(job=>job.name==='postgres-vectors'?{...job,steps:job.steps.map(step=>({...step,conclusion:'skipped'}))}:job),sourceSha,'example/eigos'),/vector validation/);
  assert.throws(()=>proveExactCi(run,checks.filter(job=>job.name!=='minimum-node'),sourceSha,'example/eigos'),/Required CI job/);
  assert.throws(()=>proveExactCi(run,[...checks,{name:'unregistered-job',status:'completed',conclusion:'success'}],sourceSha,'example/eigos'),/Required CI job inventory/);
  assert.throws(()=>proveExactCi({...run,head_sha:'2'.repeat(40)},checks,sourceSha,'example/eigos'),/exact source and repository/);
  assert.throws(()=>proveExactCi({...run,conclusion:'failure'},checks,sourceSha,'example/eigos'),/exact source and repository/);
  for(const invalid of [{...checks.find(job=>job.name==='minimum-node'),conclusion:'skipped'},
    ...['Verify exact source',minimumNodeCommand].flatMap(name=>['missing','skipped','wrong-command'].map(kind=>({...checks.find(job=>job.name==='minimum-node'),steps:checks.find(job=>job.name==='minimum-node').steps.flatMap(step=>step.name!==name?[step]:kind==='missing'?[]:[{...step,...(kind==='skipped'?{conclusion:'skipped'}:{name:step.name+' --test-name-pattern=partial'})}])})))]){
    assert.throws(()=>proveExactCi(run,checks.map(job=>job.name==='minimum-node'?invalid:job),sourceSha,'example/eigos'),/minimum-node/);
  }
  assert.throws(()=>proveExactCi({...run,head_repository:{full_name:'foreign/repo'}},checks,sourceSha,'example/eigos'),/exact source and repository/);
});

test('published legacy 24-job manifests remain readable without rewriting their immutable records',()=>{
  const x=fixture();try{
    const ready=createReleaseManifest({...x.input,images,ci:legacyCi});assert.equal(ready.state,'artifact-ready');
    const path=join(x.directory,'manifest.json'),bytes=canonical(ready)+'\n';writeFileSync(path,bytes);
    const read=readReleaseManifest(path,{requireReady:true});assert.deepEqual(read,ready);assert.deepEqual(read.ci.jobs,legacyJobs);
    assert.equal(verifyReleaseArtifacts(x.directory).manifestDigest,ready.manifestDigest);
    assert.equal(readFileSync(path,'utf8'),bytes);assert.equal(read.payloadDigest,ready.payloadDigest);
  }finally{x.close();}
});

test('incremental runtime inventories require current minimum-node proof before readiness or finalization',()=>{
  const x=fixture('codex',false,true);try{
    const candidate=createReleaseManifest({...x.input,images,ci:legacyCi});assert.equal(candidate.state,'candidate');
    assert.throws(()=>validateReleaseManifest(candidate,{requireReady:true}),/exact-source minimum-node CI/);
    assert.throws(()=>validateReleaseManifest({...candidate,state:'artifact-ready'}),/minimum-node CI/);
    const path=join(x.directory,'manifest.json'),bytes=canonical(candidate)+'\n';writeFileSync(path,bytes);
    assert.throws(()=>finalizeReleaseArtifacts(x.directory,{images,ci:legacyCi}),/minimum-node CI/);
    assert.equal(readFileSync(path,'utf8'),bytes,'Refused finalization must preserve the existing candidate');
    for(const invalid of [[...jobs,'minimum-node'],[...legacyJobs.slice(0,-1),'unregistered-job']]){
      assert.throws(()=>createReleaseManifest({...x.input,images,ci:{...ci,jobs:invalid}}),/Exact-source successful CI proof/);
    }
    const ready=finalizeReleaseArtifacts(x.directory,{images,ci});assert.equal(ready.state,'artifact-ready');
    assert.equal(ready.payloadDigest,candidate.payloadDigest);assert.deepEqual(ready.ci.jobs,jobs);
    assert.equal(readReleaseManifest(path,{requireReady:true}).manifestDigest,ready.manifestDigest);
  }finally{x.close();}
});

test('minimum-node validates the actual exact PR checkout before running its complete regression command',()=>{
  const workflow=parse(readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8')),job=workflow.jobs['minimum-node'];
  const checkout=job.steps.find(step=>step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref,'${{ github.event.pull_request.head.sha || github.sha }}');
  assert.equal(checkout.with['persist-credentials'],false);assert.equal(job.env.SOURCE_SHA,checkout.with.ref);
  const verify=job.steps.find(step=>step.name==='Verify exact source');assert.equal(verify.run,'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"');
  assert(job.steps.indexOf(verify)>job.steps.indexOf(checkout));
  assert(job.steps.some(step=>step.run===minimumNodeCommand.slice(4)));
  assert.equal(job.steps.find(step=>step.uses?.startsWith('actions/setup-node@')).with['node-version'],'22.13.0');
});

test('local semantic CI proves exact checkout and real non-skipped model retrieval separately from core CI',()=>{
  const run={id:23,head_sha:sourceSha,status:'completed',conclusion:'success',html_url:'https://github.com/example/eigos/actions/runs/23',head_repository:{full_name:'example/eigos'}},
    job={name:'local-embedding-pgvector',status:'completed',conclusion:'success',steps:['Verify exact source','Prepare pinned public model artifacts','Actual offline embedding and authorized Agent retrieval'].map(name=>({name,status:'completed',conclusion:'success'}))};
  assert.deepEqual(proveExactSemanticCi(run,[job],sourceSha,'example/eigos'),{sourceSha,runId:23,url:run.html_url,jobs:[job.name]});
  for(const change of [{head_sha:'2'.repeat(40)},{conclusion:'failure'},{head_repository:{full_name:'foreign/repo'}}])assert.throws(()=>proveExactSemanticCi({...run,...change},[job],sourceSha,'example/eigos'),/exact source and repository/);
  for(const jobs of [[],[job,job],[{...job,conclusion:'skipped'}]])assert.throws(()=>proveExactSemanticCi(run,jobs,sourceSha,'example/eigos'),/semantic CI job/);
  for(const step of job.steps)assert.throws(()=>proveExactSemanticCi(run,[{...job,steps:job.steps.map(value=>value===step?{...value,conclusion:'skipped'}:value)}],sourceSha,'example/eigos'),/actual non-skipped/);
});

test('runtime inventory with local semantic code cannot finalize using only legacy core CI',()=>{
  const x=fixture('codex',true),semantic={sourceSha,runId:23,url:'https://github.com/example/eigos/actions/runs/23',jobs:['local-embedding-pgvector']};
  try{
    const candidate=createReleaseManifest({...x.input,images,ci});assert.equal(candidate.state,'candidate');
    assert.throws(()=>validateReleaseManifest(candidate,{requireReady:true}),/exact-source local semantic CI/);
    assert.throws(()=>validateReleaseManifest({...candidate,state:'artifact-ready'}),/semantic CI/);
    writeFileSync(join(x.directory,'manifest.json'),canonical(candidate)+'\n');
    assert.throws(()=>finalizeReleaseArtifacts(x.directory,{images,ci}),/semantic CI/);
    assert.equal(readReleaseManifest(join(x.directory,'manifest.json')).manifestDigest,candidate.manifestDigest);
    const ready=finalizeReleaseArtifacts(x.directory,{images,ci:{...ci,semantic}});
    assert.equal(ready.state,'artifact-ready');assert.equal(ready.payloadDigest,candidate.payloadDigest);
    assert.deepEqual(readReleaseManifest(join(x.directory,'manifest.json'),{requireReady:true}).ci.semantic,semantic);
    assert.throws(()=>createReleaseManifest({...x.input,images,ci:{...ci,semantic:{...semantic,sourceSha:'2'.repeat(40)}}}),/Exact-source/);
  }finally{x.close();}
});


test('finalization adds verified references once without changing the embedded image payload',()=>{
  const x=fixture();try{const candidate=createReleaseManifest(x.input);writeFileSync(join(x.directory,'manifest.json'),canonical(candidate)+'\n');const ready=finalizeReleaseArtifacts(x.directory,{images,ci});assert.equal(ready.state,'artifact-ready');assert.equal(ready.payloadDigest,candidate.payloadDigest);assert.equal(verifyReleaseArtifacts(x.directory).manifestDigest,ready.manifestDigest);assert.throws(()=>finalizeReleaseArtifacts(x.directory,{images,ci}),/finalized once/);}finally{x.close();}
});

test('Harness candidates bind the actual adapter inventory and selected tool pins without claiming a verified native worker image',()=>{
  const x=fixture('harness');try{
    const candidate=createReleaseManifest({...x.input,backend:'harness'});assert.equal(candidate.backend,'harness');assert.equal(candidate.state,'candidate');assert.deepEqual(candidate.tools,HARNESS_RELEASE_TOOLS);assert(!Object.hasOwn(candidate.tools,'codex'));
    const referenced=createReleaseManifest({...x.input,backend:'harness',images,ci});assert.equal(referenced.state,'candidate','OCI digest strings and CI alone do not prove dsh is installed or executable in the image');assert.equal(referenced.payloadDigest,candidate.payloadDigest);
    assert.throws(()=>validateReleaseManifest(referenced,{requireReady:true}),/native dsh.*installation.*image compatibility/);assert.throws(()=>validateReleaseManifest({...referenced,state:'artifact-ready'}),/native dsh/);
    assert.throws(()=>validateReleaseManifest({...candidate,tools:{node:candidate.tools.node,codex:'0.164.0'}}),/tool versions.*selected backend/);
    assert.throws(()=>validateReleaseManifest({...candidate,tools:{...candidate.tools,harness:'latest'}}),/tool versions/);
    for(const path of harnessPaths)assert.throws(()=>createReleaseManifest({...x.input,backend:'harness',runtimeFiles:x.input.runtimeFiles.filter(file=>file.path!==path)}),/runtime inventory/);
    assert.throws(()=>createReleaseManifest({...x.input,backend:'harness',images:{worker:'ghcr.io/example/eigos/worker:latest'}}),/immutable OCI/);
    assert.throws(()=>createReleaseManifest({...x.input,backend:'harness',ci:{...ci,sourceSha:'2'.repeat(40)}}),/Exact-source/);
    writeFileSync(join(x.directory,'manifest.json'),canonical(candidate)+'\n');assert.equal(verifyReleaseArtifacts(x.directory).backend,'harness');assert.throws(()=>finalizeReleaseArtifacts(x.directory,{images,ci}),/native dsh.*installation/);assert.equal(readReleaseManifest(join(x.directory,'manifest.json')).manifestDigest,candidate.manifestDigest,'Refused finalization preserves the immutable candidate');
    writeFileSync(join(x.directory,'runtime',harnessPaths[0]),'changed adapter');assert.throws(()=>verifyReleaseArtifacts(x.directory),/differs/);
  }finally{x.close();}
});

test('Harness finalization binds the actual initialize-only image proof to its source and worker OCI digest',()=>{
  const x=fixture('harness');try{
    const candidate=createReleaseManifest({...x.input,backend:'harness'});
    for(const change of [{sourceSha:'2'.repeat(40)},{image:images.gateway},{version:'unverified'},{providers:['deepseek-official']},
      {initialize:'failed'},{modelTurns:1},{compiledAdapter:'absent'},{state:'artifact-ready'}]){
      assert.throws(()=>createReleaseManifest({...x.input,backend:'harness',images,ci,harnessImage:{...harnessImage,...change}}),/image proof.*exact source/);
    }
    assert.throws(()=>createReleaseManifest({...x.input,images,ci,harnessImage}),/Only Harness/);
    writeFileSync(join(x.directory,'manifest.json'),canonical(candidate)+'\n');
    const ready=finalizeReleaseArtifacts(x.directory,{images,ci,harnessImage});
    assert.equal(ready.state,'artifact-ready');assert.equal(ready.payloadDigest,candidate.payloadDigest);
    assert.deepEqual(ready.harnessImage,harnessImage);assert.equal(verifyReleaseArtifacts(x.directory).manifestDigest,ready.manifestDigest);
    assert.equal(readReleaseManifest(join(x.directory,'manifest.json'),{requireReady:true}).backend,'harness');
    assert.throws(()=>finalizeReleaseArtifacts(x.directory,{images,ci,harnessImage}),/finalized once/);
  }finally{x.close();}
});

function packagingFixture({version=HARNESS_RELEASE_TOOLS.harness,adapter=true}={}){
  const root=mkdtempSync(join(tmpdir(),'eigos-harness-package-')),output=join(root,'candidate'),put=(path,value)=>{const full=join(root,path);mkdirSync(dirname(full),{recursive:true});writeFileSync(full,value);};
  const paths=[...harnessPaths,'package.json','package-lock.json'];
  put('package.json','{"name":"synthetic-harness-package","type":"module","version":"0.1.0"}');put('package-lock.json','{"lockfileVersion":3}');
  for(const path of harnessPaths){put(path,'// synthetic runtime fixture, never invoked\n');put(path.replace(/^dist\//,'').replace(/\.js$/,'.ts'),'// synthetic source fixture\n');}
  put(harnessPaths[0],`export const HARNESS_TESTED_VERSION=${JSON.stringify(version)};export class HarnessExecutor {runStructured(){throw new Error('Synthetic packaging must never dispatch a model')}}`);
  put(harnessPaths[1],`export function createPostgresWorker(){throw new Error('Synthetic packaging must never start a Worker')}\n${adapter?"export function postgresHarnessReasoner(){throw new Error('Synthetic packaging must never invoke reasoning')}":''}`);
  put('dist/packages/deployment/files.js',`export const releaseFiles=()=>${JSON.stringify(paths)};`);
  const document={formatVersion:1,id:'synthetic.harness-package',version:'1',objects:[],interfaces:[],links:[],actions:[],functions:[]};
  put('dist/packages/ontology/seed-definition.js',`const document=${JSON.stringify(document)};export class StagedKernelBuilder{static stages=1;step(){}result(){return {document}}}export const stagedKernelComponents=()=>({documentDigest:${JSON.stringify(artifactDigest(document))},model:{ref:{digest:'${'a'.repeat(64)}'}}});`);
  put('dist/packages/ontology/mcp-read.js','export const loadMcpReadModule=()=>{};export const mcpReadModuleRef=()=>{};');mkdirSync(join(root,'dist/packages/ontology/definitions'),{recursive:true});
  for(const path of ['Dockerfile','.dockerignore','tsconfig.json','scripts/build.mjs','scripts/ontology.mjs','scripts/release-artifacts.mjs'])put(path,'// synthetic source packaging fixture\n');
  return {root,output,put,close:()=>rmSync(root,{recursive:true,force:true})};
}

test('Harness packaging checks real bundled export/version metadata without executing a model, CLI or credential reader',async()=>{
  const x=packagingFixture();try{
    const candidate=await createReleaseArtifacts({root:x.root,output:x.output,sourceSha,backend:'harness',images,ci});assert.equal(candidate.state,'candidate');assert.deepEqual(candidate.tools,HARNESS_RELEASE_TOOLS);assert.equal(verifyReleaseArtifacts(x.output).manifestDigest,candidate.manifestDigest);
    await assert.rejects(createReleaseArtifacts({root:x.root,output:x.output,sourceSha,backend:'harness'}),/output already exists/);
  }finally{x.close();}
  for(const options of [{version:'unverified'},{adapter:false}]){
    const invalid=packagingFixture(options);try{await assert.rejects(createReleaseArtifacts({root:invalid.root,output:invalid.output,sourceSha,backend:'harness'}),options.adapter===false?/actual Harness executor.*adapter must be bundled/:/version differs.*release tool pin/);}finally{invalid.close();}
  }
});

test('container build inputs include PA assets and role images retain nonroot and exact tool pins',()=>{
  const docker=readFileSync(new URL('../Dockerfile',import.meta.url),'utf8'),ignore=readFileSync(new URL('../.dockerignore',import.meta.url),'utf8');
  assert.match(docker,/COPY integrations\/grok\/eigos-delegate/);assert.match(docker,/node:22\.22\.3-bookworm-slim/);assert.match(docker,/@openai\/codex@0\.164\.0/);assert.match(docker,/npm ci/);assert.match(docker,/USER node/);assert.match(docker,/AS gateway/);assert.match(docker,/AS relay/);assert.match(docker,/AS worker-codex/);assert.match(docker,/AS worker-harness/);assert.match(docker,/@deepseek-ai\/dsh@0\.2\.1-rc\.5/);assert.match(docker,/@deepseek-ai\/dsh-llm-pi-ai@0\.2\.1-rc\.5/);
  for(const pattern of ['**/.env*','**/*sqlite*','**/auth.json','**/private.config*'])assert(ignore.includes(pattern));
  assert(ignore.includes('!scripts/postgres-task-vectors.mjs'));
  assert(docker.split('\n').some(line=>line.startsWith('COPY scripts/')&&line.includes('scripts/postgres-task-vectors.mjs')),'the actual operator CLI must enter the build context, not merely the source tree');
  assert(ignore.includes('!scripts/install-business-descriptions.mjs'));
  assert(docker.split('\n').some(line=>line.startsWith('COPY scripts/')&&line.includes('scripts/install-business-descriptions.mjs')),'the legitimate description installer must travel with the immutable package');
  assert(ignore.includes('!scripts/semantic-catalog.mjs'));
  assert(docker.split('\n').some(line=>line.startsWith('COPY scripts/')&&line.includes('scripts/semantic-catalog.mjs')),'local semantic management must travel with both executor packages');
});

test('relocated semantic CLI help needs no source modules, model, database or credentials',()=>{
  const root=mkdtempSync(join(tmpdir(),'eigos-semantic-cli-'));
  try{
    mkdirSync(join(root,'scripts'));writeFileSync(join(root,'scripts/semantic-catalog.mjs'),readFileSync(new URL('../scripts/semantic-catalog.mjs',import.meta.url)));
    assert.match(execFileSync(process.execPath,['scripts/semantic-catalog.mjs','--help'],{cwd:root,encoding:'utf8',timeout:10000}),/Use model\|init\|index\|search/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('semantic publication records actual source and model validation before any image publication',()=>{
  const semantic=parse(readFileSync(new URL('../.github/workflows/semantic.yml',import.meta.url),'utf8')),
    release=parse(readFileSync(new URL('../.github/workflows/release-artifacts.yml',import.meta.url),'utf8')),
    job=semantic.jobs['local-embedding-pgvector'],checkout=job.steps.find(step=>step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref,'${{ github.event.pull_request.head.sha || github.sha }}');
  assert.equal(job.env.SOURCE_SHA,checkout.with.ref);assert(job.steps.some(step=>step.name==='Verify exact source'&&step.run.includes('git rev-parse HEAD')));
  assert.match(job.steps.find(step=>step.name==='Actual offline embedding and authorized Agent retrieval').run,/EIGOS_TEST_SEMANTIC=1 node/);
  assert(semantic.on.push.branches.includes('main'));
  const proof=release.jobs.gate.steps.find(step=>step.name==='Require terminal CI on this exact source');
  assert(proof.run.includes('actions/workflows/semantic.yml/runs'));
  assert(proof.run.includes('--semantic-runs'));assert(proof.run.includes('--semantic-jobs'));
  const install=release.jobs.gate.steps.findIndex(step=>step.name==='Install locked packaging dependencies'),validate=release.jobs.gate.steps.findIndex(step=>step.name==='Validate exact checkout and packaging logic');
  assert(install>=0&&install<validate,'the real packaging tests import locked dependencies');
});

test('PR container smoke cannot publish while release publication requires explicit manual dispatch',()=>{
  const release=readFileSync(new URL('../.github/workflows/release-artifacts.yml',import.meta.url),'utf8'),smoke=readFileSync(new URL('../.github/workflows/container-smoke.yml',import.meta.url),'utf8');
  assert.match(release,/on:\n  workflow_dispatch:/);assert(!release.includes('  pull_request:'));assert.match(release,/needs: gate/);assert.match(release,/ci-proof/);assert.match(release,/include-hidden-files: true/);
  assert.match(smoke,/on:\n  pull_request:\n    paths:/);assert.match(smoke,/push: false/);assert.match(smoke,/github.event.pull_request.head.sha/);assert.match(smoke,/gateway, worker-codex/);assert(!smoke.includes('packages: write'));assert(!smoke.includes('login-action'));assert(!smoke.includes('push: true'));
});

test('manual Harness publication checks native images before push and again at the returned digest without model credentials',()=>{
  const workflow=parse(readFileSync(new URL('../.github/workflows/release-artifacts.yml',import.meta.url),'utf8'));
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.backend.options,['codex','harness']);
  const worker=workflow.jobs.image.strategy.matrix.include.find(role=>role.role==='worker');
  assert(worker.target.includes("inputs.backend == 'harness'"));assert(worker.target.includes('worker-harness'));
  const steps=workflow.jobs.image.steps,publish=steps.findIndex(step=>step.id==='build');
  const sdk=steps.filter(step=>step.run?.includes('/opt/eigos-smoke.mjs'));
  assert.equal(sdk.length,2);assert(steps.indexOf(sdk[0])<publish);assert(steps.indexOf(sdk[1])>publish);
  for(const step of sdk){assert.equal(step.if,"inputs.backend == 'harness' && matrix.role == 'worker'");
    for(const flag of ['--network none','--read-only','--entrypoint node','--env SOURCE_SHA'])assert(step.run.includes(flag));
    assert(!/TOKEN|PASSWORD|api.?key/i.test(step.run));}
  assert(sdk[1].env.IMAGE.includes('steps.build.outputs.digest'));
  const finish=workflow.jobs.package.steps.find(step=>step.name==='Finalize immutable OCI references without republishing Ontology');
  assert(finish.run.includes('--harness-image-proof'));assert(workflow.jobs.package.steps.some(step=>step.with?.target?.includes('release-package-harness')));
  for(const job of [workflow.jobs.image,workflow.jobs.package])for(const step of job.steps.filter(step=>step.uses?.startsWith('docker/build-push-action@'))){
    assert(step.with['build-args'].includes('RELEASE_BACKEND=${{ inputs.backend }}'),'Every role and downloaded package must embed the selected backend');
  }
  assert(workflow.jobs.image.steps.some(step=>step.run?.includes('verify-image --root /app')));
  assert(finish.run.includes('proof.payloadDigest!==candidate.payloadDigest'));assert(finish.run.includes('proof.buildDigest!==candidate.runtime.buildDigest'));
});
