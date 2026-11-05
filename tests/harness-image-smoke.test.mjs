// Synthetic SDK process tests exercise the initialize-only smoke protocol.
// They are not model, permission, provider or business-acceptance fixtures.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {smokeHarnessSdk,HARNESS_IMAGE_VERSION,HARNESS_INITIALIZE_TIMEOUT_MS} from '../scripts/smoke-harness-image.mjs';

function sdk(mode='normal'){
  const directory=mkdtempSync(join(tmpdir(),'synthetic-harness-image-')),binary=join(directory,'dsh.cjs'),log=join(directory,'calls.jsonl');
  writeFileSync(binary,`#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline'),mode=${JSON.stringify(mode)},log=${JSON.stringify(log)};
if(process.argv.includes('--version')){console.log(mode==='version'?'unverified':${JSON.stringify(HARNESS_IMAGE_VERSION)});process.exit(0);}
const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{
 const request=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({method:request.method,params:request.params,home:process.env.HOME,keys:Object.keys(process.env)})+'\\n');
 if(request.method==='initialize'){
  if(mode==='hang')return;
  if(mode==='turn'){console.log(JSON.stringify({jsonrpc:'2.0',method:'session.event',params:{event:{type:'turn/end'}}}));return;}
  console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{serverInfo:{name:mode==='identity'?'other-runtime':'deepseek-harness-sdk-runtime'}}}));
 }else if(request.method==='shutdown'){console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{}}));lines.close();process.stdin.destroy();}
 else{process.exitCode=2;lines.close();process.stdin.destroy();}
});
`,{mode:0o700});
  return {binary,calls:()=>readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line)),close:()=>rmSync(directory,{recursive:true,force:true})};
}

test('the image smoke sends only initialize/shutdown with an isolated home and no inherited credential or task environment',async t=>{
  const f=sdk();t.after(f.close);const result=await smokeHarnessSdk({binary:f.binary});assert.equal(result.version,HARNESS_IMAGE_VERSION);assert.equal(result.modelTurns,0);
  const calls=f.calls();assert.deepEqual(calls.map(call=>call.method),['initialize','shutdown']);assert.equal(calls[0].params.provider,'deepseek-official');assert.equal(calls[0].params.cwd,calls[0].home);
  for(const key of ['EIGOS_HARNESS_MODEL_TOKEN','DEEPSEEK_API_KEY','OPENAI_API_KEY','CODEX_HOME','PGPASSWORD','DATABASE_URL','SUPABASE_SERVICE_ROLE_KEY'])assert(calls.every(call=>!call.keys.includes(key)));
  assert.equal(HARNESS_INITIALIZE_TIMEOUT_MS,15000);
});

test('image smoke refuses another version, another runtime identity and unsolicited model turns',async t=>{
  for(const [mode,error] of [['version',/fixed image version/],['identity',/unexpected runtime identity/],['turn',/must not create a model session/]]){
    const f=sdk(mode);t.after(f.close);await assert.rejects(smokeHarnessSdk({binary:f.binary}),error);
  }
});

test('the selected OAuth provider uses the same initialize-only protocol without any token',async t=>{
  const f=sdk();t.after(f.close);const result=await smokeHarnessSdk({binary:f.binary,provider:'openai-codex'});assert.equal(result.provider,'openai-codex');assert.equal(f.calls()[0].params.provider,'openai-codex');assert.equal(f.calls()[0].params.model,'gpt-6-luna');assert(!f.calls()[0].keys.includes('EIGOS_HARNESS_MODEL_TOKEN'));
  await assert.rejects(smokeHarnessSdk({binary:f.binary,provider:'arbitrary-provider'}),/existing Harness provider backends/);
});

test('SDK smoke keeps the existing initialization deadline and reaps a stalled process',async t=>{
  const f=sdk('hang');t.after(f.close);await assert.rejects(smokeHarnessSdk({binary:f.binary,initializeTimeoutMs:50}),/original 15 second bound/);
  await assert.rejects(smokeHarnessSdk({binary:f.binary,initializeTimeoutMs:15001}),/original 15 second bound/);
});

test('the reusable image pins native packages and the pull request smoke checks the nonroot SDK without provider networking or publication',()=>{
  const docker=readFileSync(new URL('../Dockerfile',import.meta.url),'utf8'),workflow=readFileSync(new URL('../.github/workflows/container-smoke.yml',import.meta.url),'utf8');
  assert.match(docker,/FROM worker AS worker-harness/);assert.match(docker,/@deepseek-ai\/dsh@0\.2\.1-rc\.5/);assert.match(docker,/@deepseek-ai\/dsh-llm-pi-ai@0\.2\.1-rc\.5/);assert.match(docker,/--backend harness/);assert.match(docker,/release-harness\/manifest\.json/);assert.match(docker,/EIGOS_EXECUTOR=harness EIGOS_HARNESS_BIN=\/usr\/local\/bin\/dsh/);assert.match(docker,/LABEL io\.eigos\.model-cli="dsh@0\.2\.1-rc\.5"\nUSER node/);
  assert.match(workflow,/target: \[gateway, worker-codex, worker-harness\]/);assert.match(workflow,/--network none --read-only --tmpfs \/tmp:rw,exec,mode=1777/);assert.match(workflow,/smoke-harness-image\.mjs,dst=.*readonly/);assert.match(workflow,/push: false/);assert(!workflow.includes('push: true'));assert(!workflow.includes('packages: write'));
});
