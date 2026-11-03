import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {artifactDigest,canonical,createReleaseManifest,validateReleaseManifest,readReleaseManifest,verifyReleaseArtifacts,finalizeReleaseArtifacts,selectExactCiRun,proveExactCi} from '../scripts/release-artifacts.mjs';

const sourceSha='1'.repeat(40),rawDigest=bytes=>createHash('sha256').update(bytes).digest('hex'),roles=['gateway','relay','worker'];
const jobs=['scope','verify','relay-postgres',...Array.from({length:8},(_,i)=>`tests (${i+1})`)];
const ci={sourceSha,runId:17,url:'https://github.com/example/eigos/actions/runs/17',jobs};
const images=Object.fromEntries(roles.map((role,i)=>[role,`ghcr.io/example/eigos/${role}@sha256:${String(i+1).repeat(64)}`]));
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'eigos-release-artifacts-')),put=(prefix,path,bytes)=>{const file=join(directory,prefix,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes);return {path,sha256:rawDigest(bytes),bytes:Buffer.byteLength(bytes)};};
  const runtimeFiles=[put('runtime','dist/apps/gateway/main.js','// explicit synthetic runtime fixture\n'),put('runtime','package.json','{"name":"eigos","version":"0.1.0"}\n'),put('runtime','package-lock.json','{"lockfileVersion":3}\n')],sourceFiles=[put('source','apps/gateway/main.ts','// explicit synthetic source fixture\n')];
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
    assert.throws(()=>createReleaseManifest({...x.input,backend:'harness'}),/Harness/);
    assert.equal(Object.hasOwn(candidate.ontology,'publishedRef'),false);assert.equal(Object.hasOwn(candidate.ontology.package.kernel,'releaseId'),false);
  }finally{x.close();}
});

test('verification reads actual bytes, lockfile, ontology package and fixed document identity',()=>{
  const x=fixture();try{
    const manifest=createReleaseManifest({...x.input,images,ci});writeFileSync(join(x.directory,'manifest.json'),canonical(manifest)+'\n');assert.equal(readReleaseManifest(join(x.directory,'manifest.json'),{requireReady:true}).manifestDigest,manifest.manifestDigest);assert.equal(verifyReleaseArtifacts(x.directory).manifestDigest,manifest.manifestDigest);
    writeFileSync(join(x.directory,'runtime/package-lock.json'),'changed lock');assert.throws(()=>verifyReleaseArtifacts(x.directory),/differs/);
  }finally{x.close();}
});

test('artifact inventories reject private state, traversal, symlinks and invented database publication refs',()=>{
  const x=fixture();try{
    for(const path of ['../auth.json','/tmp/auth.json','data/tasks.sqlite','dist/.env.production','dist/private.config.json','dist/.codex/auth.json','dist/tasks.sqlite3','dist/credentials.json'])assert.throws(()=>createReleaseManifest({...x.input,runtimeFiles:[{path,sha256:'a'.repeat(64),bytes:1}]}),/Private state|relative paths/);
    const ordinary=createReleaseManifest(x.input),changed={...ordinary,ontology:{...ordinary.ontology,publishedRef:{releaseId:'invented'}}};assert.throws(()=>validateReleaseManifest(changed),/Invalid ontology artifact/);
    writeFileSync(join(x.directory,'manifest.json'),canonical(ordinary)+'\n');rmSync(join(x.directory,'runtime/dist/apps/gateway/main.js'));symlinkSync('/etc/hosts',join(x.directory,'runtime/dist/apps/gateway/main.js'));assert.throws(()=>verifyReleaseArtifacts(x.directory),/symbolic links/);
  }finally{x.close();}
});

test('latest exact CI, all required jobs and real runtime validation are gates before publishing',()=>{
  const run={id:17,run_number:4,run_attempt:1,head_sha:sourceSha,status:'completed',conclusion:'success',html_url:ci.url,head_repository:{full_name:'example/eigos'}},checks=jobs.map(name=>({name,status:'completed',conclusion:'success',...(name==='verify'?{steps:['npm run check','npm run build','npm run test:e2e:run'].map(command=>({name:`Run ${command}`,status:'completed',conclusion:'success'}))}:{})}));
  assert.equal(selectExactCiRun({workflow_runs:[run]},sourceSha).id,17);assert.deepEqual(proveExactCi(run,checks,sourceSha,'example/eigos'),ci);
  assert.throws(()=>selectExactCiRun({workflow_runs:[run,{...run,id:18,run_number:5,status:'in_progress',conclusion:null}]},sourceSha),/latest CI/);
  assert.throws(()=>proveExactCi(run,checks.filter(job=>job.name!=='relay-postgres'),sourceSha,'example/eigos'),/Required CI job/);
  assert.throws(()=>proveExactCi(run,checks.map(job=>job.name==='verify'?{...job,steps:[]}:job),sourceSha,'example/eigos'),/runtime validation/);
  assert.throws(()=>proveExactCi({...run,head_repository:{full_name:'foreign/repo'}},checks,sourceSha,'example/eigos'),/exact source and repository/);
});


test('finalization adds verified references once without changing the embedded image payload',()=>{
  const x=fixture();try{const candidate=createReleaseManifest(x.input);writeFileSync(join(x.directory,'manifest.json'),canonical(candidate)+'\n');const ready=finalizeReleaseArtifacts(x.directory,{images,ci});assert.equal(ready.state,'artifact-ready');assert.equal(ready.payloadDigest,candidate.payloadDigest);assert.equal(verifyReleaseArtifacts(x.directory).manifestDigest,ready.manifestDigest);assert.throws(()=>finalizeReleaseArtifacts(x.directory,{images,ci}),/finalized once/);}finally{x.close();}
});

test('container build inputs include PA assets and role images retain nonroot and exact tool pins',()=>{
  const docker=readFileSync(new URL('../Dockerfile',import.meta.url),'utf8'),ignore=readFileSync(new URL('../.dockerignore',import.meta.url),'utf8');
  assert.match(docker,/COPY integrations\/grok\/eigos-delegate/);assert.match(docker,/node:22\.22\.3-bookworm-slim/);assert.match(docker,/@openai\/codex@0\.164\.0/);assert.match(docker,/npm ci/);assert.match(docker,/USER node/);assert.match(docker,/AS gateway/);assert.match(docker,/AS relay/);assert.match(docker,/AS worker-codex/);assert(!docker.includes('AS worker-harness'));
  for(const pattern of ['**/.env*','**/*sqlite*','**/auth.json','**/private.config*'])assert(ignore.includes(pattern));
});

test('PR container smoke cannot publish while release publication requires explicit manual dispatch',()=>{
  const release=readFileSync(new URL('../.github/workflows/release-artifacts.yml',import.meta.url),'utf8'),smoke=readFileSync(new URL('../.github/workflows/container-smoke.yml',import.meta.url),'utf8');
  assert.match(release,/on:\n  workflow_dispatch:/);assert(!release.includes('  pull_request:'));assert.match(release,/needs: gate/);assert.match(release,/ci-proof/);assert.match(release,/include-hidden-files: true/);
  assert.match(smoke,/on:\n  pull_request:\n    paths:/);assert.match(smoke,/push: false/);assert.match(smoke,/github.event.pull_request.head.sha/);assert.match(smoke,/gateway, worker-codex/);assert(!smoke.includes('packages: write'));assert(!smoke.includes('login-action'));assert(!smoke.includes('push: true'));
});
