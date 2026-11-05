// Read-only image acceptance: actual dsh version + initialize/shutdown only.
// CI runs this in a nonroot, read-only container with --network none. It sends
// no session/prompt, model turn, provider request, business action or credential.
// The published native loader copies verified .node libraries to its isolated
// HOME cache; the /tmp tmpfs permits executable mappings for those libraries.
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

export const HARNESS_IMAGE_VERSION='0.2.1-rc.5';
export const HARNESS_INITIALIZE_TIMEOUT_MS=15000;
const execute=promisify(execFile);
const fail=message=>{throw new Error(message);};

export async function smokeHarnessSdk({binary='/usr/local/bin/dsh',initializeTimeoutMs=HARNESS_INITIALIZE_TIMEOUT_MS,provider='deepseek-official'}={}){
  if(!Number.isSafeInteger(initializeTimeoutMs)||initializeTimeoutMs<1||initializeTimeoutMs>HARNESS_INITIALIZE_TIMEOUT_MS)fail('Harness initialization must retain its original 15 second bound');
  if(!['deepseek-official','openai-codex'].includes(provider))fail('Only the existing Harness provider backends may be initialized');
  const directory=await mkdtemp(join(tmpdir(),'eigos-harness-image-'));
  // Whitelist only nonsecret process settings. Do not inherit any host login,
  // model/provider key, proxy, database URL or existing account home.
  const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:directory,DSH_HOME:join(directory,'dsh'),LANG:'C.UTF-8',TERM:'dumb',NO_COLOR:'1'};
  let child,closed,exited=false,bytes=0,buffer='',failure,sequence=0;const pending=new Map();
  const stop=()=>{if(!child)return;try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
  const reject=message=>{failure??=new Error(message);for(const item of pending.values()){clearTimeout(item.timer);item.reject(failure);}pending.clear();stop();};
  try{
    const version=await execute(binary,['--version'],{cwd:directory,env,timeout:5000,maxBuffer:65536});
    if(version.stdout.trim()!==HARNESS_IMAGE_VERSION)fail('The installed dsh binary differs from the fixed image version');
    const patch=join(directory,'smoke.patch.json');
    const plugins=[...['tool-fs','tool-working-directory','persistent-bash','persistent-pwsh'].map(id=>({id,disabled:true})),{id:'sandbox-policy',config:{mode:'read-only'}}];
    if(provider==='openai-codex')plugins.push({id:'llm-deepseek',disabled:true},{insert:[{id:'eigos-model',name:'@deepseek-ai/dsh-llm-pi-ai',config:{providers:{'openai-codex':{apiKeyEnv:'EIGOS_HARNESS_MODEL_TOKEN',retryPolicy:{mode:'normal',maxRetries:0},models:[{id:'gpt-6-luna',contextWindow:128000,maxTokens:8192}]}}}}]});
    await writeFile(patch,JSON.stringify(plugins),{mode:0o600});
    child=spawn(binary,['--profile','sdk-minimal','--patch',patch],{cwd:directory,env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
    closed=new Promise(resolve=>child.once('close',()=>{exited=true;for(const item of pending.values()){clearTimeout(item.timer);item.reject(failure??new Error('Harness exited before its initialization acknowledgement'));}pending.clear();resolve();}));
    child.once('error',()=>reject('The actual Harness SDK runtime could not start'));child.stdin.on('error',()=>{});
    child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>2000000)reject('Harness initialization exceeded its bounded output');});
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      bytes+=Buffer.byteLength(chunk);if(bytes>2000000){reject('Harness initialization exceeded its bounded output');return;}buffer+=chunk;let end;
      while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;let packet;
        try{packet=JSON.parse(line);}catch{reject('Invalid Harness SDK initialization frame');return;}
        if(!packet||packet.jsonrpc!=='2.0'){reject('Invalid Harness SDK protocol version');return;}
        if('id'in packet){const item=pending.get(packet.id);if(!item||typeof packet.method==='string'){reject('Unexpected Harness SDK response or host request');return;}pending.delete(packet.id);clearTimeout(item.timer);if(packet.error)item.reject(new Error('Harness rejected SDK initialization or shutdown'));else item.resolve(packet.result);}
        else if(packet.method==='session.event'){reject('Initialize-only smoke must not create a model session or turn');return;}
      }
    });
    const request=(method,params,timeout)=>new Promise((resolve,rejectRequest)=>{
      if(failure||exited){rejectRequest(failure??new Error('Harness SDK is closed'));return;}const id=++sequence,timer=setTimeout(()=>reject(method==='initialize'?'Harness initialization exceeded its original 15 second bound':'Harness SDK shutdown timed out'),timeout);pending.set(id,{resolve,reject:rejectRequest,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})+'\n');
    });
    const initialized=await request('initialize',{cwd:directory,provider,model:provider==='openai-codex'?'gpt-6-luna':'deepseek-flash',maxTokens:8192},initializeTimeoutMs);
    if(initialized?.serverInfo?.name!=='deepseek-harness-sdk-runtime')fail('The native dsh SDK returned an unexpected runtime identity');
    await request('shutdown',undefined,5000);child.stdin.end();
    const finished=await Promise.race([closed.then(()=>true),new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),5000);timer.unref();})]);if(!finished)fail('Harness SDK did not stop after its initialize-only check');
    if(failure)throw failure;return {version:HARNESS_IMAGE_VERSION,provider,initialize:'acknowledged',modelTurns:0};
  }finally{for(const item of pending.values())clearTimeout(item.timer);stop();if(closed)await closed;await rm(directory,{recursive:true,force:true});}
}

export async function smokeHarnessImage(root=process.cwd()){
  if(process.getuid?.()===0)fail('The reusable Harness image must run as a nonroot user');
  if(process.versions.node!=='22.22.3')fail('The Harness image Node version differs from its fixed runtime');
  const manifest=JSON.parse(await readFile(join(root,'release/manifest.json'),'utf8'));
  if(manifest.backend!=='harness'||manifest.state!=='candidate'||manifest.tools?.harness!==HARNESS_IMAGE_VERSION||manifest.tools?.node!==process.versions.node||manifest.source?.sha!==process.env.SOURCE_SHA||!/^[a-f0-9]{40}$/.test(process.env.SOURCE_SHA??''))fail('Harness image must retain its exact source and honest candidate manifest');
  const executor=await import(pathToFileURL(join(root,'dist/packages/capabilities/harness-executor.js')).href),factory=await import(pathToFileURL(join(root,'dist/apps/worker/postgres-runtime.js')).href);
  if(executor.HARNESS_TESTED_VERSION!==HARNESS_IMAGE_VERSION||typeof executor.HarnessExecutor?.prototype?.runStructured!=='function'||typeof factory.postgresHarnessReasoner!=='function'||typeof factory.createPostgresWorker!=='function')fail('The compiled actual PostgreSQL Harness execution API is missing');
  const checks=[];for(const provider of ['deepseek-official','openai-codex'])checks.push(await smokeHarnessSdk({provider}));
  return {version:HARNESS_IMAGE_VERSION,providers:checks.map(check=>check.provider),initialize:'acknowledged',modelTurns:0,sourceSha:manifest.source.sha,compiledAdapter:'present',state:'candidate'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))smokeHarnessImage().then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.message);process.exitCode=1;});
