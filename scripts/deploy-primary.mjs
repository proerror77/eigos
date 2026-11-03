import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync,copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {parseArgs,parseEnv} from 'node:util';
import {readConfig,readWorkerConfig} from '../dist/packages/core/config.js';
import {runtimeAuthorityDigest} from '../dist/packages/core/runtime-authority.js';
import {releaseFiles} from '../dist/packages/deployment/files.js';
import {installReleaseDependencies} from '../dist/packages/deployment/dependencies.js';
import {primaryRuntime,waitForPrimaryHealth} from '../dist/packages/deployment/primary.js';
import {primaryService} from '../dist/packages/deployment/service-manager.js';
import {privateDeploymentFile,resolveDeploymentBinary,assertPrimaryStores} from '../dist/packages/deployment/preflight.js';
import {verifyPrimaryIngresses} from '../dist/packages/deployment/ingress-readiness.js';
import {HarnessExecutor,HARNESS_TESTED_VERSION} from '../dist/packages/capabilities/harness-executor.js';
import {readHarnessLogin,CODEX_LOGIN_VERSION} from '../dist/packages/deployment/harness-login.js';

const {values}=parseArgs({options:{config:{type:'string'},apply:{type:'boolean'},'login-config':{type:'string'},'verify-ingresses':{type:'boolean'}}});
if(!['darwin','linux'].includes(process.platform) || !values.config)throw new Error('Use --config with the owned primary environment on macOS or systemd Linux');
if(values['verify-ingresses'] && !values.apply)throw new Error('Ingress verification follows an applied deployment');
privateDeploymentFile(values.config);
const source=readFileSync(values.config,'utf8'),settings=parseEnv(source),config=readConfig(settings),authority=config.authority;
readWorkerConfig(settings);
if(settings.EIGOS_TASK_RELAY_FILE && config.EIGOS_TASK_RELAY_FILE!==settings.EIGOS_TASK_RELAY_FILE)throw new Error('Configured Task Relay is unsupported by this checkout');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),runtime=primaryRuntime();
assertPrimaryStores(config,runtime);
if(values['login-config']){
  if(process.platform!=='linux'||config.EIGOS_EXECUTOR!=='harness'||config.EIGOS_HARNESS_CREDENTIAL_KIND==='api-key')throw new Error('Managed cloud login requires the Linux GPT Harness recipient');
  const login=readHarnessLogin(values['login-config'],runtime);
  if(resolve(login.credentialFile)!==resolve(config.EIGOS_HARNESS_CREDENTIAL_FILE))throw new Error('Cloud login must refresh this exact Harness credential file');
  const version=execFileSync(resolveDeploymentBinary(login.codexBin),['--version'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000,maxBuffer:4096}).trim();
  if(version!==CODEX_LOGIN_VERSION)throw new Error('Install the reviewed native cloud-login runtime');
  resolveDeploymentBinary('/usr/bin/flock');
}
const modelBinary=config.EIGOS_EXECUTOR==='disabled'?process.execPath:resolveDeploymentBinary(config.EIGOS_EXECUTOR==='harness'?(config.EIGOS_HARNESS_BIN??'dsh'):config.EIGOS_CODEX_BIN);
if(config.EIGOS_EXECUTOR==='harness'){
  const version=execFileSync(modelBinary,['--version'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000,maxBuffer:4096}).trim();
  if(version!==HARNESS_TESTED_VERSION)throw new Error('Install the reviewed Harness runtime version before deployment');
  await new HarnessExecutor(modelBinary,config.EIGOS_EXECUTOR_TIMEOUT_MS,{credentialFile:config.EIGOS_HARNESS_CREDENTIAL_FILE,credentialKind:config.EIGOS_HARNESS_CREDENTIAL_KIND}).assertReady();
}
if(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim())throw new Error('Deploy a committed, reviewed checkout');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),files=releaseFiles(root),hash=createHash('sha256');
for(const file of files){hash.update(file+'\0');hash.update(readFileSync(join(root,file)));}
const buildDigest=hash.digest('hex'),release=join(runtime,'releases',buildDigest);
const manager=primaryService({platform:process.platform,home:homedir(),runtime,release,node:process.execPath,modelBinary,loginConfig:values['login-config']});
manager.assertReady();
const envPath=manager.envPath,servicePath=manager.serviceFile,prior=join(runtime,'release.json');
if(existsSync(prior)){
  privateDeploymentFile(prior);
  const previous=JSON.parse(readFileSync(prior,'utf8'));
  if(previous.authorityId!==authority.id)throw new Error('Primary deployment cannot change authority identity');
  if(previous.manager && previous.manager!==manager.manager)throw new Error('Retire the previous host manager before replacing it');
}
if(existsSync(servicePath)){
  privateDeploymentFile(servicePath);
  if(!manager.ownsConfiguration(readFileSync(servicePath,'utf8')))throw new Error('The service file is not owned by this primary deployment');
}
for(const [path,owns] of manager.login?[[manager.login.serviceFile,manager.login.ownsService],[manager.login.timerFile,manager.login.ownsTimer]]:[]){if(existsSync(path)){privateDeploymentFile(path);if(!owns(readFileSync(path,'utf8')))throw new Error('Refusing an unowned login service');}}
const result={label:manager.label,manager:manager.manager,serviceFile:servicePath,sourceCommit,buildDigest,authorityId:authority.id,endpoint:config.PUBLIC_URL,...(values['login-config']?{loginConfig:values['login-config']}: {})};
if(!values.apply){console.log(JSON.stringify({status:'prepared',...result}));process.exit(0);}
const write=(path,value)=>{writeFileSync(path,value,{mode:0o600});chmodSync(path,0o600);};
for(const path of [runtime,release,dirname(servicePath)])mkdirSync(path,{recursive:true,mode:0o700});
const backup=join(runtime,'backups',new Date().toISOString().replaceAll(':','-'));mkdirSync(backup,{recursive:true,mode:0o700});
for(const [i,path] of [envPath,servicePath,prior,join(runtime,'authority.json'),...(manager.login?[manager.login.serviceFile,manager.login.timerFile]:[])].entries())if(existsSync(path))copyFileSync(path,join(backup,String(i)));
for(const file of files){const target=join(release,file);mkdirSync(dirname(target),{recursive:true});if(!existsSync(target))copyFileSync(join(root,file),target);if(!readFileSync(target).equals(readFileSync(join(root,file))))throw new Error('Immutable release differs from its manifest');}
installReleaseDependencies(root,runtime,release);
execFileSync(process.execPath,['--input-type=module','-e',"await import('./dist/apps/gateway/app.js'); await import('./dist/apps/worker/runtime.js')"],{cwd:release,stdio:'pipe',timeout:15000});
manager.stop();
// Configuration/code may be repaired forward after failure. The current
// business and membership stores are never restored from an older snapshot.
write(envPath,source.split('\n').filter(line=>!line.startsWith('EIGOS_RELEASE_DIGEST=')).join('\n')+'\nEIGOS_RELEASE_DIGEST='+buildDigest+'\n');
write(join(runtime,'authority.json'),JSON.stringify(authority,null,2)+'\n');write(servicePath,manager.render());
if(manager.login){write(manager.login.serviceFile,manager.login.service);write(manager.login.timerFile,manager.login.timer);}
manager.start();
try{await waitForPrimaryHealth(config.PORT,new URL(config.PUBLIC_URL).host,{authorityId:authority.id,releaseDigest:buildDigest,...(config.EIGOS_TASK_RELAY_FILE?{taskRelay:'connected'}:{})});}
catch(error){throw new Error(error.message+'; preserve its stores and inspect the owned logs before forward repair',{cause:error});}
write(prior,JSON.stringify({...result,release,files,authorityDigest:runtimeAuthorityDigest(authority),profile:'primary',updatedAt:new Date().toISOString()},null,2)+'\n');
const frontend=values['verify-ingresses']?await verifyPrimaryIngresses(authority,{authorityId:authority.id,releaseDigest:buildDigest}):undefined;
console.log(JSON.stringify({status:'running',...result,frontendReadback:frontend?'verified':'required',...(frontend?{ingresses:frontend}:{})}));
