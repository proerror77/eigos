import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync,copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {parseArgs,parseEnv} from 'node:util';
import {readConfig} from '../dist/packages/core/config.js';
import {JobStore} from '../dist/packages/core/store.js';
import {runtimeAuthorityDigest} from '../dist/packages/core/runtime-authority.js';
import {releaseFiles} from '../dist/packages/deployment/files.js';
import {installReleaseDependencies} from '../dist/packages/deployment/dependencies.js';
import {primaryRuntime,readPrimaryHealth} from '../dist/packages/deployment/primary.js';
import {CODEX_SECURITY_CHANNEL_ID} from '../dist/packages/capabilities/executor.js';

const {values}=parseArgs({options:{config:{type:'string'},apply:{type:'boolean'}}});
if(process.platform!=='darwin' || !values.config)throw new Error('Use --config with the owned primary environment on macOS');
const stat=lstatSync(values.config);if(!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid() || stat.mode&0o077)throw new Error('Primary settings must be an owned private regular file');
const source=readFileSync(values.config,'utf8'),settings=parseEnv(source),config=readConfig(settings),authority=config.authority;
if(!authority)throw new Error('Primary deployment requires its preinstalled runtime authority');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),runtime=primaryRuntime(),label='com.eigos.primary',service=`gui/${process.getuid()}/${label}`;
const envPath=join(runtime,'server.env'),plistPath=join(homedir(),'Library/LaunchAgents',label+'.plist');
if(!authority.databasePath.startsWith(runtime+'/') || !authority.membershipDatabasePath.startsWith(runtime+'/'))throw new Error('Primary stores must live in the owned primary runtime');
const store=new JobStore(authority.databasePath,{securityMode:'foundation',authority});
try{if(config.EIGOS_EXECUTOR==='codex')store.security.policies.modelChannel(CODEX_SECURITY_CHANNEL_ID);}finally{store.close();}
const loaded=name=>{try{execFileSync('launchctl',['print',`gui/${process.getuid()}/${name}`],{stdio:'ignore'});return true;}catch{return false;}};
if(['com.eigos.grok-life','com.eigos.invite-beta','com.eigos.shopify-checkout-private','com.eigos.member-network'].some(loaded))throw new Error('Stop the retired formal profiles before installing the single authority');
if(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim())throw new Error('Deploy a committed, reviewed checkout');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),files=releaseFiles(root),hash=createHash('sha256');
for(const file of files){hash.update(file+'\0');hash.update(readFileSync(join(root,file)));}
const buildDigest=hash.digest('hex'),release=join(runtime,'releases',buildDigest);
if(!values.apply){console.log(JSON.stringify({status:'prepared',label,sourceCommit,buildDigest,authorityId:authority.id,endpoint:config.PUBLIC_URL}));process.exit(0);}
const write=(path,value)=>{writeFileSync(path,value,{mode:0o600});chmodSync(path,0o600);};
for(const path of [runtime,release,dirname(plistPath)])mkdirSync(path,{recursive:true,mode:0o700});
const prior=join(runtime,'release.json');
if(existsSync(prior) && JSON.parse(readFileSync(prior,'utf8')).authorityId!==authority.id)throw new Error('Primary deployment cannot change authority identity');
if(existsSync(plistPath) && !readFileSync(plistPath,'utf8').includes(envPath))throw new Error('The LaunchAgent is not owned by this deployment');
const backup=join(runtime,'backups',new Date().toISOString().replaceAll(':','-'));mkdirSync(backup,{recursive:true,mode:0o700});
for(const [i,path] of [envPath,plistPath,prior,join(runtime,'authority.json')].entries())if(existsSync(path))copyFileSync(path,join(backup,String(i)));
for(const file of files){const target=join(release,file);mkdirSync(dirname(target),{recursive:true});if(!existsSync(target))copyFileSync(join(root,file),target);if(!readFileSync(target).equals(readFileSync(join(root,file))))throw new Error('Immutable release differs from its manifest');}
installReleaseDependencies(root,runtime,release);
execFileSync(process.execPath,['--input-type=module','-e',"await import('./dist/apps/gateway/app.js'); await import('./dist/apps/worker/runtime.js')"],{cwd:release,stdio:'pipe',timeout:15000});
const xml=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const paths=[dirname(process.execPath),dirname(settings.EIGOS_CODEX_BIN||'/usr/local/bin/codex'),join(homedir(),'.local/bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].join(':');
const plist=`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath,'--env-file='+envPath,join(release,'scripts/run-local.mjs'),'--built'].map(v=>`<string>${xml(v)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(release)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(paths)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(join(runtime,'stdout.log'))}</string><key>StandardErrorPath</key><string>${xml(join(runtime,'stderr.log'))}</string></dict></plist>`;
if(loaded(label))execFileSync('launchctl',['bootout',service],{stdio:'ignore'});
// Preserve the current database after failure. Restoring old data could lose
// results or resurrect permissions changed after the primary accepted work.
write(envPath,source.split('\n').filter(line=>!line.startsWith('EIGOS_RELEASE_DIGEST=')).join('\n')+'\nEIGOS_RELEASE_DIGEST='+buildDigest+'\n');
write(join(runtime,'authority.json'),JSON.stringify(authority,null,2)+'\n');write(plistPath,plist);
execFileSync('launchctl',['enable',service]);execFileSync('launchctl',['bootstrap',`gui/${process.getuid()}`,plistPath]);
let healthy=false;
for(let i=0;i<30;i++){
  try{const result=await readPrimaryHealth(config.PORT,new URL(config.PUBLIC_URL).host);if(result.authorityId===authority.id && result.releaseDigest===buildDigest){healthy=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,500));
}
if(!healthy)throw new Error('Primary failed readiness; preserve its database and inspect the owned logs before forward repair');
write(prior,JSON.stringify({sourceCommit,buildDigest,release,files,authorityId:authority.id,authorityDigest:runtimeAuthorityDigest(authority),profile:'primary',endpoint:config.PUBLIC_URL,updatedAt:new Date().toISOString()},null,2)+'\n');
console.log(JSON.stringify({status:'running',label,sourceCommit,buildDigest,authorityId:authority.id,endpoint:config.PUBLIC_URL,frontendReadback:'required'}));
