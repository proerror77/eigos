import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {setImmediate as yieldToHost} from 'node:timers/promises';

export const RELEASE_ARTIFACT_FORMAT='eigos.release-artifacts/1';
export const ONTOLOGY_PACKAGE_FORMAT='eigos.ontology-package/1';
export const RELEASE_TOOLS=Object.freeze({node:'22.22.3',codex:'0.164.0'});
export const HARNESS_RELEASE_TOOLS=Object.freeze({node:RELEASE_TOOLS.node,harness:'0.2.1-rc.5'});
const harnessRuntimeFiles=['dist/packages/capabilities/harness-executor.js','dist/apps/worker/postgres-runtime.js','dist/packages/core/model-usage-context.js','dist/packages/core/model-dispatch-context.js','dist/packages/postgres/coordinator.js'];
const harnessImagePending=`Harness remains a candidate until the native dsh ${HARNESS_RELEASE_TOOLS.harness} installation and worker image compatibility are independently verified against its exact OCI digest`;
const sha=/^[a-f0-9]{64}$/,commit=/^(?!0{40}$)[a-f0-9]{40}$/;
const image=/^[a-z0-9][a-z0-9.:-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[a-f0-9]{64}$/;
const roles=['gateway','relay','worker'];
const legacyRequiredJobs=['scope','verify','relay-postgres','postgres-storage','postgres-access','postgres-execution','postgres-coordinator','postgres-vectors','postgres-coordinator-cases (protocol)','postgres-coordinator-cases (revocation)','postgres-coordinator-cases (lifecycle)','postgres-execution-cases (contracts)','postgres-execution-cases (planning)','postgres-execution-cases (documents)','postgres-execution-cases (didi)','postgres-execution-cases (transitions)',...Array.from({length:8},(_,i)=>`tests (${i+1})`)];
const minimumNodeJob='minimum-node',minimumNodeCommand='Run node --import tsx --test tests/transaction-savepoints.test.ts tests/execution-projection-noop.test.ts tests/graph-read-window.test.ts';
const requiredJobs=[...legacyRequiredJobs,minimumNodeJob];
const semanticJob='local-embedding-pgvector';
function fail(message){throw new Error(message);}
function backendTools(backend){if(backend==='codex')return RELEASE_TOOLS;if(backend==='harness')return HARNESS_RELEASE_TOOLS;fail('Only the registered codex or harness release backend is supported');}
function assertHarnessInventory(value){
  for(const [inventory,paths] of [[value.runtime.files,harnessRuntimeFiles],[value.sourceFiles,harnessRuntimeFiles.map(path=>path.replace(/^dist\//,'').replace(/\.js$/,'.ts'))]]){
    const names=new Set(inventory.map(file=>file.path));if(paths.some(path=>!names.has(path)))fail('The Harness candidate requires the actual executor, PostgreSQL reasoning adapter and acknowledged usage/dispatch runtime inventory');
  }
}
async function assertHarnessPackaging(root){
  // The fixed, reviewed checkout is already required below. Import only its
  // built API metadata; never invoke a model, CLI, credential reader or worker.
  // This proves bundled adapter/version parity, not an installed dsh binary.
  const [executor,worker]=await Promise.all([import(pathToFileURL(checkedFile(root,harnessRuntimeFiles[0])).href),import(pathToFileURL(checkedFile(root,harnessRuntimeFiles[1])).href)]);
  if(executor.HARNESS_TESTED_VERSION!==HARNESS_RELEASE_TOOLS.harness)fail('The bundled Harness runtime version differs from its release tool pin');
  if(typeof executor.HarnessExecutor!=='function'||typeof executor.HarnessExecutor.prototype?.runStructured!=='function'||typeof worker.postgresHarnessReasoner!=='function'||typeof worker.createPostgresWorker!=='function')fail('The actual Harness executor and acknowledged PostgreSQL reasoning adapter must be bundled');
}
export function canonical(value){const normalize=input=>Array.isArray(input)?input.map(normalize):input&&typeof input==='object'?Object.fromEntries(Object.entries(input).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,normalize(v)])):input;return JSON.stringify(normalize(value));}
export const artifactDigest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const bytesDigest=value=>createHash('sha256').update(value).digest('hex');
function record(value,keys,label){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))fail(`Invalid ${label}`);return value;}
function text(value,label){if(typeof value!=='string'||!value||value.length>500)fail(`Invalid ${label}`);return value;}
function safePath(path){
  if(typeof path!=='string'||!path||path.length>1000||isAbsolute(path)||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..'))fail('Artifact paths must be bounded relative paths');
  const parts=path.split('/');if(parts.some(part=>['.git','node_modules','data','private.config','auth.json','credentials.json'].includes(part)||part.startsWith('.env')||/^(?:\.?private[._-]?config(?:[._-]|$)|\.codex$|\.dsh$|\.aws$|\.ssh$)/i.test(part)||/\.(?:sqlite[^/]*|db(?:[-.].*)?|pem|key|p12|pfx)$/i.test(part)))fail('Private state is not a release artifact');return path;
}
function descriptor(input){record(input,['path','sha256','bytes'],'file descriptor');safePath(input.path);if(!sha.test(input.sha256)||!Number.isSafeInteger(input.bytes)||input.bytes<0)fail('Invalid file digest');return {...input};}
function files(input){if(!Array.isArray(input)||!input.length||input.length>30000)fail('Invalid bounded artifact file inventory');const result=input.map(descriptor);if(new Set(result.map(x=>x.path)).size!==result.length)fail('Duplicate artifact path');return result;}
function checkedFile(root,path){safePath(path);const full=resolve(root,path);let current=resolve(root);for(const part of path.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())fail('Release artifacts cannot follow symbolic links');}if(!lstatSync(full).isFile())fail('Release artifacts require regular files');return full;}
function fileDescriptor(root,path){const full=checkedFile(root,path),bytes=readFileSync(full);return {path,sha256:bytesDigest(bytes),bytes:bytes.length};}
function copyFile(root,path,output,prefix){const full=checkedFile(root,path),target=join(output,prefix,path);mkdirSync(dirname(target),{recursive:true});copyFileSync(full,target);}
function writeJson(path,value){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,canonical(value)+'\n',{mode:0o600});}

export function validateOntologyPackage(input){
  record(input,['format','kernel','providerModules'],'ontology package');if(input.format!==ONTOLOGY_PACKAGE_FORMAT)fail('Unsupported ontology package format');
  const kernel=record(input.kernel,['id','version','documentDigest','modelDigest','file'],'kernel package');text(kernel.id,'ontology id');text(kernel.version,'ontology version');if(!sha.test(kernel.documentDigest)||!sha.test(kernel.modelDigest))fail('Invalid ontology package digest');descriptor(kernel.file);if(kernel.file.path!=='kernel.json')fail('Invalid kernel package path');
  if(!Array.isArray(input.providerModules)||input.providerModules.length>200)fail('Invalid provider module inventory');
  for(const module of input.providerModules){record(module,['id','version','digest','file'],'provider module');text(module.id,'provider module id');text(module.version,'provider module version');if(!sha.test(module.digest))fail('Invalid provider module digest');descriptor(module.file);if(!/^providers\/[A-Za-z0-9._-]+\.json$/.test(module.file.path))fail('Invalid provider module path');}
  if(new Set(input.providerModules.map(x=>x.file.path)).size!==input.providerModules.length)fail('Duplicate provider module path');return structuredClone(input);
}
function ciProof(input,sourceSha){
  record(input,['sourceSha','runId','url','jobs','semantic'],'CI proof');if(input.sourceSha!==sourceSha||!Number.isSafeInteger(input.runId)||input.runId<1||!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(input.url)||!Array.isArray(input.jobs)||![legacyRequiredJobs,requiredJobs].some(names=>input.jobs.length===names.length&&names.every(name=>input.jobs.filter(x=>x===name).length===1)))fail('Exact-source successful CI proof is required');
  if(input.semantic)semanticCiProof(input.semantic,sourceSha);return structuredClone(input);
}
function semanticCiProof(input,sourceSha){
  record(input,['sourceSha','runId','url','jobs'],'semantic CI proof');
  if(input.sourceSha!==sourceSha||!Number.isSafeInteger(input.runId)||input.runId<1||!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(input.url)||!input.url.endsWith(`/runs/${input.runId}`)||canonical(input.jobs)!==canonical([semanticJob]))fail('Exact-source successful local semantic CI proof is required');
  return structuredClone(input);
}
const needsSemanticCi=value=>value.runtime.files.some(file=>file.path.startsWith('dist/packages/semantic/'))||value.sourceFiles.some(file=>file.path.startsWith('packages/semantic/'));
const needsMinimumNodeCi=value=>value.runtime.files.some(file=>file.path==='dist/packages/ontology/projection-delta.js');
const hasMinimumNodeCi=value=>Array.isArray(value.ci?.jobs)&&value.ci.jobs.includes(minimumNodeJob);
function artifactReady(value){return (value.backend==='codex'||!!value.harnessImage)&&roles.every(role=>value.images[role])&&!!value.ci&&(!needsSemanticCi(value)||!!value.ci.semantic)&&(!needsMinimumNodeCi(value)||hasMinimumNodeCi(value));}
export function selectExactCiRun(input,sourceSha){
  if(!commit.test(sourceSha)||!Array.isArray(input?.workflow_runs))fail('Invalid CI run query');
  const selected=input.workflow_runs.filter(run=>run.head_sha===sourceSha).sort((a,b)=>b.run_number-a.run_number||b.run_attempt-a.run_attempt)[0];
  if(!selected||selected.status!=='completed'||selected.conclusion!=='success')fail('The latest CI run for this exact source must finish successfully');return selected;
}
export function proveExactCi(run,jobs,sourceSha,repository,semantic){
  if(!commit.test(sourceSha)||run.head_sha!==sourceSha||run.status!=='completed'||run.conclusion!=='success'||run.head_repository?.full_name!==repository||!Array.isArray(jobs))fail('CI must belong to the exact source and repository');
  if(jobs.length!==requiredJobs.length)fail('Required CI job inventory differs from this release');
  for(const name of requiredJobs){const matches=jobs.filter(job=>job.name===name);if(matches.length!==1||matches[0].status!=='completed'||matches[0].conclusion!=='success')fail(`Required CI job is not successful: ${name}`);}
  const verify=jobs.find(job=>job.name==='verify');for(const command of ['npm run check','npm run build','npm run test:e2e:run'])if(!verify.steps?.some(step=>step.name===`Run ${command}`&&step.status==='completed'&&step.conclusion==='success'))fail('Release CI must include runtime validation; run the CI workflow manually for this source');
  const vectors=jobs.find(job=>job.name==='postgres-vectors');if(!vectors.steps?.some(step=>step.name==='Run node scripts/postgres-tests.mjs run --group vectors'&&step.status==='completed'&&step.conclusion==='success'))fail('Release CI must include actual non-skipped vector validation');
  const minimum=jobs.find(job=>job.name===minimumNodeJob);
  for(const name of ['Verify exact source',minimumNodeCommand]){const steps=minimum.steps?.filter(step=>step.name===name);if(steps?.length!==1||steps[0].status!=='completed'||steps[0].conclusion!=='success')fail('Release CI must include exact-checkout and actual non-skipped minimum-node runtime validation');}
  return ciProof({sourceSha,runId:run.id,url:run.html_url,jobs:requiredJobs,...(semantic?{semantic:proveExactSemanticCi(semantic.run,semantic.jobs,sourceSha,repository)}:{})},sourceSha);
}
export function proveExactSemanticCi(run,jobs,sourceSha,repository){
  if(!commit.test(sourceSha)||run.head_sha!==sourceSha||run.status!=='completed'||run.conclusion!=='success'||run.head_repository?.full_name!==repository||!Array.isArray(jobs))fail('Semantic CI must belong to the exact source and repository');
  const matches=jobs.filter(job=>job.name===semanticJob),job=matches[0];
  if(matches.length!==1||job.status!=='completed'||job.conclusion!=='success')fail('Required local semantic CI job is not successful');
  for(const name of ['Verify exact source','Prepare pinned public model artifacts','Actual offline embedding and authorized Agent retrieval'])if(!job.steps?.some(step=>step.name===name&&step.status==='completed'&&step.conclusion==='success'))fail('Semantic CI must verify the exact checkout and run actual non-skipped local embedding and retrieval');
  return semanticCiProof({sourceSha,runId:run.id,url:run.html_url,jobs:[semanticJob]},sourceSha);
}
function payloadOf(value){return {format:value.format,source:value.source,backend:value.backend,tools:value.tools,runtime:value.runtime,sourceFiles:value.sourceFiles,lockfile:value.lockfile,ontology:value.ontology};}
export function validateHarnessImageProof(input,sourceSha,workerImage){
  record(input,['sourceSha','image','version','providers','initialize','modelTurns','compiledAdapter','state'],'Harness image proof');
  if(input.sourceSha!==sourceSha||!image.test(workerImage??'')||input.image!==workerImage
    ||input.version!==HARNESS_RELEASE_TOOLS.harness||canonical(input.providers)!==canonical(['deepseek-official','openai-codex'])
    ||input.initialize!=='acknowledged'||input.modelTurns!==0||input.compiledAdapter!=='present'||input.state!=='candidate')fail('Harness image proof must match the exact source, OCI digest and actual initialize-only SDK checks');
  return structuredClone(input);
}
export function createReleaseManifest(input){
  const backend=input.backend??'codex';
  const value={format:RELEASE_ARTIFACT_FORMAT,source:{sha:input.sourceSha,version:input.version},backend,tools:{...backendTools(backend)},runtime:{buildDigest:input.buildDigest,files:input.runtimeFiles},sourceFiles:input.sourceFiles,lockfile:input.lockfile,ontology:input.ontology,images:input.images??{},...(input.ci?{ci:input.ci}:{}),...(input.harnessImage?{harnessImage:input.harnessImage}:{}),state:'candidate'};
  if(artifactReady(value))value.state='artifact-ready';
  value.payloadDigest=artifactDigest(payloadOf(value));value.manifestDigest=artifactDigest(value);return validateReleaseManifest(value);
}
export function validateReleaseManifest(input,{requireReady=false}={}){
  record(input,['format','source','backend','tools','runtime','sourceFiles','lockfile','ontology','images','ci','harnessImage','state','payloadDigest','manifestDigest'],'release manifest');
  if(input.format!==RELEASE_ARTIFACT_FORMAT||!commit.test(input.source?.sha))fail('A fixed source SHA is required');record(input.source,['sha','version'],'source');text(input.source.version,'package version');
  if(canonical(input.tools)!==canonical(backendTools(input.backend)))fail('Release tool versions must remain pinned for the selected backend');
  record(input.runtime,['buildDigest','files'],'runtime inventory');if(!sha.test(input.runtime.buildDigest))fail('Invalid runtime build digest');files(input.runtime.files);files(input.sourceFiles);descriptor(input.lockfile);if(input.lockfile.path!=='package-lock.json')fail('Release lockfile must be package-lock.json');
  if(input.backend==='harness')assertHarnessInventory(input);
  record(input.ontology,['packageFile','package'],'ontology artifact');descriptor(input.ontology.packageFile);if(input.ontology.packageFile.path!=='ontology/package.json')fail('Invalid ontology package path');validateOntologyPackage(input.ontology.package);
  record(input.images,roles,'OCI references');for(const ref of Object.values(input.images))if(typeof ref!=='string'||!image.test(ref))fail('Image references must use an immutable OCI sha256 digest');
  if(input.ci)ciProof(input.ci,input.source.sha);
  if(input.harnessImage){if(input.backend!=='harness')fail('Only Harness releases may contain a Harness image proof');validateHarnessImageProof(input.harnessImage,input.source.sha,input.images.worker);}
  const ready=artifactReady(input);
  if(needsMinimumNodeCi(input)&&!hasMinimumNodeCi(input)&&(requireReady||input.state==='artifact-ready'))fail('An artifact-ready incremental projection runtime requires exact-source minimum-node CI');
  if(needsSemanticCi(input)&&!input.ci?.semantic&&(requireReady||input.state==='artifact-ready'))fail('An artifact-ready semantic runtime requires exact-source local semantic CI');
  if(input.backend==='harness'&&!input.harnessImage&&(input.state==='artifact-ready'||requireReady))fail(harnessImagePending);
  if(input.state!==(ready?'artifact-ready':'candidate')||requireReady&&!ready)fail('An artifact-ready release requires all OCI digests and exact-source CI');
  if(input.payloadDigest!==artifactDigest(payloadOf(input)))fail('Release payload digest does not match');const {manifestDigest,...body}=input;if(manifestDigest!==artifactDigest(body))fail('Release manifest digest does not match');return structuredClone(input);
}
export function readReleaseManifest(path,options){if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile()||lstatSync(path).size>16_000_000)fail('Manifest must be a bounded regular file');return validateReleaseManifest(JSON.parse(readFileSync(path,'utf8')),options);}
/** Run inside the actual image. Source packaging is deliberately absent from
 * runtime images; validate their installed whitelist against the embedded,
 * exact-source candidate before the outer release can bind its OCI digest. */
export function verifyRuntimeImagePayload(root,{sourceSha,backend}){
  const value=readReleaseManifest(join(root,'release/manifest.json'));backendTools(backend);
  if(!commit.test(sourceSha)||value.source.sha!==sourceSha||value.backend!==backend||value.state!=='candidate')fail('Embedded image candidate differs from the selected source or release backend');
  const build=createHash('sha256');
  for(const file of value.runtime.files){
    if(canonical(fileDescriptor(root,file.path))!==canonical(file))fail('Installed image runtime differs from its candidate manifest');
    build.update(file.path+'\0');build.update(readFileSync(checkedFile(root,file.path)));
  }
  if(build.digest('hex')!==value.runtime.buildDigest)fail('Installed image runtime build digest differs');
  return {sourceSha,backend,payloadDigest:value.payloadDigest,buildDigest:value.runtime.buildDigest};
}
export function verifyReleaseArtifacts(directory,manifest=readReleaseManifest(join(directory,'manifest.json'))){
  const value=validateReleaseManifest(manifest);for(const [prefix,list] of [['runtime',value.runtime.files],['source',value.sourceFiles]])for(const file of list)if(canonical(fileDescriptor(join(directory,prefix),file.path))!==canonical(file))fail('Artifact file differs from its fixed manifest');
  const hash=createHash('sha256');for(const file of value.runtime.files){hash.update(file.path+'\0');hash.update(readFileSync(checkedFile(join(directory,'runtime'),file.path)));}if(hash.digest('hex')!==value.runtime.buildDigest)fail('Runtime differs from the reviewed releaseFiles build digest');
  if(canonical(fileDescriptor(join(directory,'runtime'),value.lockfile.path))!==canonical(value.lockfile))fail('Lockfile differs from the fixed manifest');
  if(JSON.parse(readFileSync(checkedFile(join(directory,'runtime'),'package.json'),'utf8')).version!==value.source.version)fail('Runtime package version differs');
  const pkg=value.ontology.packageFile;if(canonical(fileDescriptor(directory,pkg.path))!==canonical(pkg))fail('Ontology package bytes differ');const parsed=validateOntologyPackage(JSON.parse(readFileSync(checkedFile(directory,pkg.path),'utf8')));if(canonical(parsed)!==canonical(value.ontology.package))fail('Ontology package metadata differs');
  for(const entry of [parsed.kernel,...parsed.providerModules])if(canonical(fileDescriptor(join(directory,'ontology'),entry.file.path))!==canonical(entry.file))fail('Ontology artifact file differs');
  const document=JSON.parse(readFileSync(checkedFile(join(directory,'ontology'),parsed.kernel.file.path),'utf8'));if(artifactDigest(document)!==parsed.kernel.documentDigest||document.id!==parsed.kernel.id||document.version!==parsed.kernel.version)fail('Ontology document digest or identity differs');return value;
}

export function finalizeReleaseArtifacts(directory,{images,ci,harnessImage}){
  const current=verifyReleaseArtifacts(directory);if(current.state!=='candidate')fail('Only a verified candidate can be finalized once');
  if(current.backend==='harness'&&!harnessImage)fail(harnessImagePending);
  const value=createReleaseManifest({sourceSha:current.source.sha,version:current.source.version,backend:current.backend,buildDigest:current.runtime.buildDigest,runtimeFiles:current.runtime.files,sourceFiles:current.sourceFiles,lockfile:current.lockfile,ontology:current.ontology,images,ci,harnessImage});
  validateReleaseManifest(value,{requireReady:true});if(value.payloadDigest!==current.payloadDigest)fail('Finalization cannot change the image payload');writeJson(join(directory,'manifest.json'),value);return value;
}

export async function createReleaseArtifacts({root=process.cwd(),output,sourceSha,backend='codex',images={},ci,kernelVersion}){
  root=resolve(root);if(!output)fail('An explicit new artifact output directory is required');output=resolve(output);if(existsSync(output))fail('Artifact output already exists; preserve immutable releases');if(!commit.test(sourceSha))fail('Use an exact 40-character source SHA');backendTools(backend);
  if(existsSync(join(root,'.git'))){if(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==sourceSha)fail('Release source SHA differs from this checkout');if(execFileSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:root,encoding:'utf8'}).trim())fail('Release packaging requires a clean reviewed source checkout');}
  const {releaseFiles}=await import(pathToFileURL(join(root,'dist/packages/deployment/files.js')).href),runtimePaths=releaseFiles(root);if(new Set(runtimePaths).size!==runtimePaths.length)fail('Runtime whitelist contains duplicate paths');
  const runtimeFiles=runtimePaths.map(path=>fileDescriptor(root,path)),build=createHash('sha256');for(const path of runtimePaths){build.update(path+'\0');build.update(readFileSync(checkedFile(root,path)));}
  const scan=directory=>readdirSync(join(root,directory),{withFileTypes:true}).flatMap(entry=>{const path=`${directory}/${entry.name}`;if(entry.isSymbolicLink())fail('Source inventory cannot follow symbolic links');return entry.isDirectory()?scan(path):entry.isFile()&&/\.(?:ts|json)$/.test(entry.name)?[safePath(path)]:[];});
  const sourcePaths=[...new Set([...scan('apps'),...scan('packages'),'Dockerfile','.dockerignore','tsconfig.json','scripts/build.mjs','scripts/ontology.mjs','scripts/release-artifacts.mjs',...runtimePaths.filter(path=>!path.startsWith('dist/'))])].sort();
  const sourceFiles=sourcePaths.map(path=>fileDescriptor(root,path)),lockfile=fileDescriptor(root,'package-lock.json'),version=JSON.parse(readFileSync(checkedFile(root,'package.json'),'utf8')).version;
  if(backend==='harness'){
    assertHarnessInventory({runtime:{files:runtimeFiles},sourceFiles});await assertHarnessPackaging(root);
  }
  const {StagedKernelBuilder,stagedKernelComponents}=await import(pathToFileURL(join(root,'dist/packages/ontology/seed-definition.js')).href),kernel=new StagedKernelBuilder(kernelVersion);
  let progress=kernel.step(0);while(!progress.ready){await yieldToHost();progress=kernel.step(progress.completed);}
  const ready=stagedKernelComponents(kernel),definition=kernel.result().document;
  const {loadMcpReadModule,mcpReadModuleRef}=await import(pathToFileURL(join(root,'dist/packages/ontology/mcp-read.js')).href),providerDirectory='dist/packages/ontology/definitions';
  mkdirSync(output,{recursive:true});for(const path of runtimePaths)copyFile(root,path,output,'runtime');for(const path of sourcePaths)copyFile(root,path,output,'source');
  writeJson(join(output,'ontology/kernel.json'),definition);const providerModules=readdirSync(join(root,providerDirectory)).filter(name=>name.endsWith('.json')).sort().map(name=>{const path=`${providerDirectory}/${name}`,module=loadMcpReadModule(checkedFile(root,path)),ref=mcpReadModuleRef(module);const destination=`providers/${name}`,target=join(output,'ontology',destination);mkdirSync(dirname(target),{recursive:true});copyFileSync(checkedFile(root,path),target);return {...ref,file:fileDescriptor(join(output,'ontology'),destination)};});
  const pkg=validateOntologyPackage({format:ONTOLOGY_PACKAGE_FORMAT,kernel:{id:definition.id,version:definition.version,documentDigest:ready.documentDigest,modelDigest:ready.model.ref.digest,file:fileDescriptor(join(output,'ontology'),'kernel.json')},providerModules});writeJson(join(output,'ontology/package.json'),pkg);
  const manifest=createReleaseManifest({sourceSha,version,backend,buildDigest:build.digest('hex'),runtimeFiles,sourceFiles,lockfile,ontology:{packageFile:fileDescriptor(output,'ontology/package.json'),package:pkg},images,ci});writeJson(join(output,'manifest.json'),manifest);verifyReleaseArtifacts(output,manifest);return manifest;
}

async function main(){
  const command=process.argv[2],{values}=parseArgs({args:process.argv.slice(3),options:{root:{type:'string'},out:{type:'string'},'source-sha':{type:'string'},backend:{type:'string'},'kernel-version':{type:'string'},manifest:{type:'string'},'image-gateway':{type:'string'},'image-relay':{type:'string'},'image-worker':{type:'string'},'ci-proof':{type:'string'},'harness-image-proof':{type:'string'},'require-ready':{type:'boolean'},runs:{type:'string'},jobs:{type:'string'},'semantic-runs':{type:'string'},'semantic-jobs':{type:'string'},repository:{type:'string'}}});
  if(values['harness-image-proof']&&command!=='finalize')fail('Harness image proof is admitted only during finalization');
  if(command==='select-ci'){const run=selectExactCiRun(JSON.parse(readFileSync(values.runs,'utf8')),values['source-sha']);console.log(run.id);return;}
  if(command==='ci-proof'){
    if(!!values['semantic-runs']!==!!values['semantic-jobs'])fail('Semantic run and job evidence must be supplied together');
    let semantic;
    if(values['semantic-runs']){const raw=JSON.parse(readFileSync(values['semantic-jobs'],'utf8'));semantic={run:selectExactCiRun(JSON.parse(readFileSync(values['semantic-runs'],'utf8')),values['source-sha']),jobs:Array.isArray(raw)?raw:raw.jobs};}
    const runs=JSON.parse(readFileSync(values.runs,'utf8')),run=selectExactCiRun(runs,values['source-sha']),raw=JSON.parse(readFileSync(values.jobs,'utf8')),proof=proveExactCi(run,Array.isArray(raw)?raw:raw.jobs,values['source-sha'],values.repository,semantic);writeJson(values.out,proof);console.log(canonical(proof));return;
  }
  if(command==='verify'){const value=verifyReleaseArtifacts(values.root??process.cwd(),values.manifest?readReleaseManifest(values.manifest,{requireReady:values['require-ready']}):undefined);if(values['require-ready'])validateReleaseManifest(value,{requireReady:true});console.log(canonical({state:value.state,sourceSha:value.source.sha,payloadDigest:value.payloadDigest,manifestDigest:value.manifestDigest}));return;}
  if(command==='verify-image'){console.log(canonical(verifyRuntimeImagePayload(values.root??process.cwd(),{sourceSha:values['source-sha'],backend:values.backend})));return;}
  if(!['create','finalize'].includes(command))fail('Use create, finalize, verify, verify-image, select-ci or ci-proof');const images=Object.fromEntries(roles.filter(role=>values[`image-${role}`]).map(role=>[role,values[`image-${role}`]]));
  if(command==='finalize'){const value=finalizeReleaseArtifacts(values.root??process.cwd(),{images,ci:values['ci-proof']?JSON.parse(readFileSync(values['ci-proof'],'utf8')):undefined,harnessImage:values['harness-image-proof']?JSON.parse(readFileSync(values['harness-image-proof'],'utf8')):undefined});console.log(canonical({state:value.state,payloadDigest:value.payloadDigest,manifestDigest:value.manifestDigest}));return;}
  const value=await createReleaseArtifacts({root:values.root,output:values.out,sourceSha:values['source-sha'],backend:values.backend,kernelVersion:values['kernel-version'],images,ci:values['ci-proof']?JSON.parse(readFileSync(values['ci-proof'],'utf8')):undefined});console.log(canonical({state:value.state,sourceSha:value.source.sha,payloadDigest:value.payloadDigest,manifestDigest:value.manifestDigest}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
