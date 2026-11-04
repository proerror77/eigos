import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessExecutor, HARNESS_SECURITY_CHANNEL_ID, HARNESS_DEEPSEEK_SECURITY_CHANNEL_ID, type HarnessConfiguration } from '../packages/capabilities/harness-executor.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { withModelUsage } from '../packages/core/model-usage-context.js';
import {withModelDispatchGuard} from '../packages/core/model-dispatch-context.js';
import {createPostgresWorker,postgresHarnessReasoner} from '../apps/worker/postgres-runtime.js';
import {PostgresDatabase} from '../packages/postgres/database.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import type {Pool} from 'pg';
import {CodexExecutor} from '../packages/capabilities/executor.js';

function fixture(mode = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'eigos-harness-test-')), binary = join(root, 'harness.cjs'), log = join(root, 'boot.json'), key = join(root, 'model.key');
  writeFileSync(key, 'synthetic-model-credential', { mode: 0o600 });
  writeFileSync(binary, '#!' + process.execPath + '\n' + String.raw`
const fs=require('node:fs'), readline=require('node:readline'), {spawn}=require('node:child_process');
const mode=MODE_VALUE, log=LOG_VALUE, patch=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--patch')+1],'utf8'));
const writeBoot=value=>{fs.writeFileSync(log+'.next',JSON.stringify(value));fs.renameSync(log+'.next',log)};
writeBoot({pid:process.pid,args:process.argv.slice(2),home:process.env.HOME,dshHome:process.env.DSH_HOME,patch,env:Object.keys(process.env),hasCredential:!!process.env.EIGOS_HARNESS_MODEL_TOKEN});
let session, messageId='prompt-receipt';
const reply=(id,result)=>console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
const event=(type,data)=>console.log(JSON.stringify({jsonrpc:'2.0',method:'session.event',params:{sessionId:mode==='other-session'?'another-session':session,event:{type,data}}}));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);
 const boot=JSON.parse(fs.readFileSync(log,'utf8'));writeBoot({...boot,methods:[...(boot.methods??[]),q.method]});
 if(q.method==='initialize'){
  writeBoot({...JSON.parse(fs.readFileSync(log,'utf8')),initialization:q.params});
  const acknowledge=()=>reply(q.id,{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}});
  if(mode==='hold-initialize'){const timer=setInterval(()=>{if(fs.existsSync(log+'.ack')){clearInterval(timer);acknowledge();}},5);}
  else acknowledge();return;
 }
 if(q.method==='session/prompt'){
  session=q.params.sessionId;
  if(mode!=='unread')event('user/message',{id:messageId});
  reply(q.id,{messageId});return;
 }
 if(q.method==='session/wait'){
  if(mode==='hang'){
   const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
   writeBoot({...JSON.parse(fs.readFileSync(log,'utf8')),childPid:child.pid});return;
  }
  if(mode==='tool')event('tool/call',{name:'bash',callId:'forbidden',arguments:'{}'});
  if(mode==='output-limit'){console.log('x'.repeat(2100000));return;}
  if(mode==='split-utf8'){
   const text=JSON.stringify({message:'东京你好 👋🧪'});
   const frame=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'session.event',params:{sessionId:session,event:{type:'assistant/message',data:{message:{role:'assistant',content:[{type:'text',text}]}}}}})+'\n');
   const chinese=frame.indexOf(Buffer.from('京'))+1, emoji=frame.indexOf(Buffer.from('👋'))+2;
   process.stdout.write(frame.subarray(0,chinese));
   setTimeout(()=>{process.stdout.write(frame.subarray(chinese,emoji));setTimeout(()=>{
    process.stdout.write(frame.subarray(emoji));event('turn/end',{turn:1,reason:{kind:'completed'}});reply(q.id,{});
   },30);},30);return;
  }
  const output=mode==='bad-json'?'invalid':JSON.stringify(mode==='review'?{requestRevision:1,verdict:'covered',message:'Synthetic transport review only',clauses:[{messageId:'message',quote:'Write a draft',disposition:'covered',inputKeys:['format'],requirementIds:[],conditionIds:[],reason:'Explicit fixture'}]}:{ok:mode!=='bad-schema'});
  event('assistant/message',{message:{role:'assistant',content:[{type:'text',text:output}]},usage:{inputTokens:3,outputTokens:2}});
  if(mode!=='no-completion')event('turn/end',{turn:1,reason:{kind:mode==='failed'?'failed':'completed'}});
  reply(q.id,{});return;
 }
 if(q.method==='shutdown'){reply(q.id,{});return;}
});
`.replace('MODE_VALUE', JSON.stringify(mode)).replace('LOG_VALUE', JSON.stringify(log)), { mode: 0o700 });
  const model = new HarnessExecutor(binary, mode === 'hang' ? 1200 : 5000, { credentialFile: key, credentialKind: 'api-key' });
  return { root, key, binary, model, log, boot: () => JSON.parse(readFileSync(log, 'utf8')) as { pid: number; childPid?: number; methods?:string[];args: string[]; home: string; dshHome: string; initialization?:{model:string;provider:string;maxTokens:number;reasoningEffort?:string};patch: { id?: string; disabled?: boolean; insert?: { name: string; config?: unknown }[] }[]; env: string[]; hasCredential: boolean },
    close: () => rmSync(root, { recursive: true, force: true }) };
}
const schema = { type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false };

async function waitForInitialization(f:ReturnType<typeof fixture>) {
  const deadline=Date.now()+8000;
  while((!existsSync(f.log)||!f.boot().initialization)&&Date.now()<deadline)await new Promise<void>(resolve=>setImmediate(resolve));
  assert(existsSync(f.log)&&f.boot().initialization,'Observe the actual synthetic child receiving initialize');
}

test('Harness default initialization accepts a 20s ACK inside the original invocation budget',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let now=0;t.mock.method(performance,'now',()=>now);
  const f=fixture('hold-initialize'),controller=new AbortController();t.after(f.close);t.after(()=>controller.abort());
  const model=new HarnessExecutor(f.binary,180000,{credentialFile:f.key,credentialKind:'api-key',model:'original-model',reasoningEffort:'medium',maxTokens:8192});
  let settled=false;const pending=model.runStructured('synthetic',schema,controller.signal,{toolFree:true});
  void pending.then(()=>{settled=true;},()=>{settled=true;});
  await waitForInitialization(f);now=20000;t.mock.timers.tick(20000);
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,false,'The old 15s timer must no longer kill initialization');
  writeFileSync(f.log+'.ack','ack');const result=await pending;
  assert.deepEqual(result.output,{ok:true});assert.equal(result.evidence.model,'original-model');assert.equal(result.evidence.durationMs,20000);
  assert.deepEqual(f.boot().initialization,{cwd:f.boot().home,provider:'deepseek-official',model:'original-model',reasoningEffort:'medium',maxTokens:8192});
  assert.deepEqual(f.boot().methods,['initialize','session/prompt','session/wait','shutdown']);assert(!existsSync(f.boot().home));
});

for(const mode of ['initialize-timeout','cancel','invocation-timeout','late-initialize-ack','late-invocation-ack'] as const)
test('Harness initialization '+mode+' cannot dispatch a prompt or revive completion',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let now=0;t.mock.method(performance,'now',()=>now);
  const f=fixture('hold-initialize'),controller=new AbortController(),outcomes:string[]=[];t.after(f.close);t.after(()=>controller.abort());
  const overall=mode==='invocation-timeout'?2000:180000;
  const model=new HarnessExecutor(f.binary,overall,{credentialFile:f.key,credentialKind:'api-key',initializeTimeoutMs:mode==='invocation-timeout'?45000:1000});
  const pending=withModelUsage({begin:async()=>{},finish:async(_id,_evidence,outcome)=>{outcomes.push(outcome);}},()=>
    withModelDispatchGuard({channelId:model.securityChannelId,authorize:async()=>{if(mode==='invocation-timeout')now=1500;}},()=>model.runStructured('synthetic',schema,controller.signal,{toolFree:true})));
  void pending.catch(()=>{});await waitForInitialization(f);
  if(mode==='cancel')controller.abort();
  else if(mode==='late-initialize-ack'||mode==='late-invocation-ack'){
    // An overdue ACK can arrive before a delayed timer callback. The absolute
    // bounds must reject it without writing session/prompt.
    now=mode==='late-initialize-ack'?1001:180001;writeFileSync(f.log+'.ack','late ack');
  }else if(mode==='invocation-timeout'){
    now=1999;t.mock.timers.tick(499);await new Promise<void>(resolve=>setImmediate(resolve));
    assert.deepEqual(f.boot().methods,['initialize']);now=2000;t.mock.timers.tick(1);
  }else{now=1000;t.mock.timers.tick(1000);}
  await assert.rejects(pending,mode==='cancel'?/canceled/:mode.includes('invocation')?/invocation timed out/:/initialization timed out/);
  assert.deepEqual(outcomes,[mode==='cancel'?'interrupted':'failed']);assert.deepEqual(f.boot().methods,['initialize']);
  assert(!existsSync(f.boot().home));assert.throws(()=>process.kill(f.boot().pid,0),{code:'ESRCH'});
});

test('Harness preserves Chinese and emoji split inside UTF-8 bytes across stdout chunks', async t => {
  const f = fixture('split-utf8'); t.after(f.close);
  const textSchema = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false };
  const result = await f.model.runStructured('synthetic', textSchema, t.signal, { toolFree: true });
  assert.deepEqual(result.output, { message: '东京你好 👋🧪' });
});

test('Harness waits for durable begin, current dispatch authorization and final accounting', async t => {
  const f = fixture(); t.after(f.close);
  let admit!: () => void, finish!: () => void, began!: () => void, accounting!: () => void,authorize!:()=>void,checking!:()=>void;
  const admitted = new Promise<void>(resolve => { admit = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  const ending = new Promise<void>(resolve => { accounting = resolve; });
  const authorized=new Promise<void>(resolve=>{authorize=resolve;}),checked=new Promise<void>(resolve=>{checking=resolve;});
  let settled = false;
  const pending = withModelUsage({ begin: async () => { began(); await admitted; }, finish: async () => { accounting(); await finished; } },
    () => withModelDispatchGuard({channelId:f.model.securityChannelId,authorize:async()=>{checking();await authorized;}},()=>f.model.runStructured('synthetic', schema, t.signal, { toolFree: true }))).finally(() => { settled = true; });
  t.after(() => { admit(); authorize();finish(); });
  await started; assert(!existsSync(f.log), 'No model process before the durable begin acknowledgement');
  admit();await checked;assert(!existsSync(f.log),'No process before the current authorization finishes');authorize(); await ending; assert.equal(settled, false, 'Completion must wait for accounting acknowledgement');
  finish(); assert.deepEqual((await pending).output, { ok: true });
  assert(!existsSync(f.boot().home));
});

test('Harness pre-spawn denial, channel mismatch and abort cannot dispatch a prompt',async t=>{
  for(const mode of ['denied','channel','abort'] as const){
    const f=fixture(),controller=new AbortController(),events:string[]=[];t.after(f.close);
    await assert.rejects(withModelUsage({begin:async()=>{events.push('begin');},finish:async(_id,_evidence,outcome)=>{events.push(outcome);}},()=>
      withModelDispatchGuard({channelId:mode==='channel'?'wrong-channel':f.model.securityChannelId,authorize:async()=>{
        events.push('authorize');if(mode==='denied')throw new Error('Original permission revoked');if(mode==='abort')controller.abort(new Error('Synthetic canceled before spawn'));
      }},()=>f.model.runStructured('synthetic',schema,controller.signal))),mode==='channel'?/differs from its admitted boundary/:mode==='denied'?/Original permission revoked/:/Synthetic canceled/);
    assert(!existsSync(f.log));assert.deepEqual(events,mode==='channel'?['begin','failed']:mode==='abort'?['begin','authorize','interrupted']:['begin','authorize','failed']);
  }
});

test('Harness rejects failed finish acknowledgement and cancellation during accounting',async t=>{
  for(const cancel of [false,true]){
    const f=fixture(),controller=new AbortController();t.after(f.close);
    await assert.rejects(withModelUsage({begin:async()=>{},finish:async(_id,_evidence,outcome)=>{
      assert.equal(outcome,'completed');if(cancel)controller.abort(new Error('Synthetic canceled during finish'));else throw new Error('Finish acknowledgement unknown');
    }},()=>withModelDispatchGuard({channelId:f.model.securityChannelId,authorize:async()=>{}},()=>f.model.runStructured('synthetic',schema,controller.signal))),cancel?/canceled during finish/:/Finish acknowledgement unknown/);
    assert(!existsSync(f.boot().home));
  }
});

test('Harness never spawns when pre-dispatch preparation exhausts its original timeout',async t=>{
  const f=fixture();t.after(f.close);
  const model=new HarnessExecutor(f.binary,10,{credentialFile:f.key,credentialKind:'api-key'});
  await assert.rejects(withModelUsage({begin:async()=>{},finish:async()=>{}},()=>withModelDispatchGuard({channelId:model.securityChannelId,authorize:async()=>{await new Promise(resolve=>setTimeout(resolve,20));}},()=>model.runStructured('synthetic',schema,t.signal))),/Harness invocation timed out/);
  assert(!existsSync(f.log));
});

test('PostgreSQL Harness reasoning uses its selected guarded exec transport and configuration',async t=>{
  const f=fixture('review');t.after(f.close);
  const model=new HarnessExecutor(f.binary,5000,{credentialFile:f.key,credentialKind:'api-key',model:'selected-harness-model',reasoningEffort:'high',maxTokens:2048});
  Object.assign(model,{openStructuredSession:()=>{throw new Error('App-server must not receive a prompt');}});
  const reasoner=postgresHarnessReasoner(model),events:string[]=[],at=new Date().toISOString();
  assert.equal(model.postgresModelDispatch,'acknowledged-v1');assert.equal(reasoner.postgresModelDispatch,'acknowledged-v1');assert.equal(reasoner.ontologyContextMode,'task');assert.equal(reasoner.securityChannelId,HARNESS_DEEPSEEK_SECURITY_CHANNEL_ID);
  const result=await withModelUsage({begin:async()=>{events.push('begin');},finish:async()=>{events.push('finish');}},()=>withModelDispatchGuard({channelId:model.securityChannelId,authorize:async()=>{events.push('authorize');}},()=>reasoner.reviewGoal!({request:{id:'synthetic-review',revision:1,originalGoal:'Write a draft',requirements:[],messages:[{id:'message',text:'Write a draft',receivedAt:at}]},capability:new DocumentAgentProgram().capability(),input:{format:'markdown'}},t.signal)));
  assert.equal(result.decision.verdict,'covered');assert.deepEqual(events,['begin','authorize','finish']);
  assert.deepEqual(f.boot().initialization,{cwd:f.boot().home,provider:'deepseek-official',model:'selected-harness-model',maxTokens:2048,reasoningEffort:'high'});
  assert.equal(result.evidence.model,'selected-harness-model');assert.equal(result.evidence.runtime,'harness-sdk');
});

test('PostgreSQL factory honors Harness selection without starting or connecting and retains synthetic injection',async t=>{
  const f=fixture();t.after(f.close);let connected=0;
  const pool={connect:async()=>{connected++;throw new Error('No database work belongs to model-port construction');},end:async()=>{}} as Pick<Pool,'connect'|'end'>;
  const database=new PostgresDatabase(pool,'eigos_business_harness_factory',{id:'synthetic-harness',revision:1,digest:'a'.repeat(64)});
  const config=readWorkerConfig({EIGOS_EXECUTOR:'harness',EIGOS_HARNESS_BIN:f.binary,EIGOS_HARNESS_CREDENTIAL_FILE:f.key,EIGOS_HARNESS_CREDENTIAL_KIND:'api-key',EIGOS_HARNESS_MODEL:'kept-model'});
  const runtime=createPostgresWorker(config,{database,policyDigest:'a'.repeat(64),modelChannel:HARNESS_DEEPSEEK_SECURITY_CHANNEL_ID});
  await runtime.close();assert.equal(connected,0);assert(!existsSync(f.log));
  assert.throws(()=>createPostgresWorker({...config,EIGOS_HARNESS_INITIALIZE_TIMEOUT_MS:999},{database,policyDigest:'a'.repeat(64)}),/initialization timeout/);
  const legacy=createPostgresWorker({...config,EIGOS_EXECUTOR:undefined,EIGOS_CODEX_BIN:'must-not-start-legacy-codex'},{database,policyDigest:'a'.repeat(64),modelChannel:new CodexExecutor('must-not-start-channel-probe').securityChannelId});
  await legacy.close();assert.equal(connected,0);
  assert.throws(()=>createPostgresWorker({...config,EIGOS_HARNESS_CREDENTIAL_FILE:undefined},{database,policyDigest:'a'.repeat(64)}),/absolute private credential/);
  assert.throws(()=>createPostgresWorker({...config,EIGOS_EXECUTOR:'disabled'},{database,policyDigest:'a'.repeat(64)}),/model execution is disabled/);
  const unexpected=async()=>{throw new Error('Synthetic model ports must remain idle');};
  const injected=createPostgresWorker({...config,EIGOS_EXECUTOR:'disabled'},{database,policyDigest:'a'.repeat(64),reasoner:{postgresModelDispatch:'acknowledged-v1',securityChannelId:'synthetic',ontologyContextMode:'task',ground:unexpected,plan:unexpected},executor:{postgresModelDispatch:'acknowledged-v1',securityChannelId:'synthetic',run:unexpected}});
  await injected.close();assert.equal(connected,0);await database.close();
});

test('Harness never dispatches when the durable begin acknowledgement fails or is unknown', async t => {
  const f = fixture(); t.after(f.close);
  await assert.rejects(withModelUsage({ begin: async () => { throw new Error('Commit acknowledgement unknown'); }, finish: () => { assert.fail('No admitted dispatch'); } },
    () => f.model.runStructured('synthetic', schema, t.signal)), /Commit acknowledgement unknown/);
  assert(!existsSync(f.log));
});

test('Harness confines the original turn, credentials, profile and receipt to its invocation', async t => {
  const f = fixture(); t.after(f.close);
  const privateKeys=['EIGOS_DEV_TOKEN','DEEPSEEK_API_KEY','PGPASSWORD','PGHOST','DATABASE_URL','SUPABASE_SERVICE_ROLE_KEY'],previous=new Map(privateKeys.map(key=>[key,process.env[key]]));
  for(const key of privateKeys)process.env[key]='synthetic-unrelated-host-secret';
  t.after(()=>{for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const recorded: unknown[] = [];
  const result = await withModelUsage({ begin: () => {}, finish: (...args) => { recorded.push(args); } },
    () => f.model.runStructured('Only synthetic supplied information', schema, t.signal, { toolFree: true }));
  assert.deepEqual(result.output, { ok: true });
  assert.equal(result.evidence.runtime, 'harness-sdk'); assert.equal(f.model.securityChannelId, HARNESS_DEEPSEEK_SECURITY_CHANNEL_ID);
  assert.notEqual(f.model.securityChannelId, HARNESS_SECURITY_CHANNEL_ID, 'A different model recipient must not inherit the GPT channel');
  assert.deepEqual(result.evidence.toolFreeInvocation, { completedTurns: 1, toolCalls: 0 });
  assert.deepEqual(result.evidence.usage, { inputTokens: 3, outputTokens: 2 }); assert.equal(recorded.length, 1);
  const boot = f.boot();
  assert(boot.hasCredential); assert(!boot.env.includes('EIGOS_DEV_TOKEN')); assert(!boot.env.includes('DEEPSEEK_API_KEY')); assert(!boot.env.includes('CODEX_HOME'));
  for(const key of privateKeys)assert(!boot.env.includes(key),'Host credentials are not Harness invocation credentials');
  assert(boot.args.includes('sdk-minimal')); assert(!boot.args.join(' ').includes('synthetic-model-credential'));
  for (const id of ['tool-fs', 'tool-working-directory', 'persistent-bash', 'persistent-pwsh']) assert(boot.patch.some(x => x.id === id && x.disabled));
  assert(!existsSync(boot.home)); assert(!existsSync(boot.dshHome)); assert(existsSync(f.key));
  assert(!JSON.stringify(result.evidence).includes('synthetic-model-credential'));
});

for (const [mode, message] of [
  ['bad-json', /invalid structured/], ['bad-schema', /invalid structured/], ['other-session', /another session/],
  ['unread', /original, completed/], ['no-completion', /original, completed/], ['failed', /original, completed/],
  ['tool', /outside the task/], ['output-limit', /output limit/],
] as const) test('Harness rejects ' + mode + ' instead of manufacturing completion', async t => {
  const f = fixture(mode); t.after(f.close);
  await assert.rejects(f.model.runStructured('synthetic', schema, t.signal, { toolFree: true }), message);
  assert(!existsSync(f.boot().home));
});

test('Harness cancellation and timeout reap its process group before returning', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const cancel of [false, true]) {
    const f = fixture('hang'), controller = new AbortController(); t.after(f.close);
    t.after(() => controller.abort());
    const pending = f.model.runStructured('synthetic', schema, controller.signal).then(() => undefined, (error: unknown) => error);
    const deadline = Date.now() + 8000;
    while ((!existsSync(f.log) || !f.boot().childPid) && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
    assert(f.boot().childPid, 'Observe the real descendant before interrupting');
    if (cancel) controller.abort();
    else t.mock.timers.tick(5000);
    const error = await pending; assert(error instanceof Error); assert.match(error.message, cancel ? /canceled/ : /timed out/);
    const boot = f.boot(); assert(!existsSync(boot.home));
    for (const pid of [boot.pid, boot.childPid!]) {
      try { process.kill(pid, 0); assert.equal(process.platform, 'linux'); assert.equal(readFileSync('/proc/' + pid + '/stat', 'utf8').split(' ')[2], 'Z'); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error; }
    }
  }
});

test('Harness does not spawn after cancellation or with a public or expired credential', async t => {
  const f = fixture(); t.after(f.close);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.model.runStructured('synthetic', schema, aborted.signal)); assert(!existsSync(f.log));
  chmodSync(f.key, 0o644);
  await assert.rejects(f.model.runStructured('synthetic', schema, t.signal), /owned private/); assert(!existsSync(f.log));
  chmodSync(f.key, 0o600);
  writeFileSync(f.key, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x.' + Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url') + '.x', refresh_token: 'never-pass-refresh' } }));
  const oauth = new HarnessExecutor(f.binary, 5000, { credentialFile: f.key });
  await assert.rejects(oauth.runStructured('synthetic', schema, t.signal), /expired/); assert(!existsSync(f.log));
});

test('Harness pins its recipient while reading current OAuth access without exporting refresh credentials', async t => {
  const f = fixture(); t.after(f.close);
  const token = 'x.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.x';
  writeFileSync(f.key, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'never-pass-refresh' } }));
  const config: HarnessConfiguration = { credentialFile: f.key, credentialKind: 'codex-oauth' };
  const oauth = new HarnessExecutor(f.binary, 5000, config);
  config.credentialKind = 'api-key';
  await oauth.runStructured('synthetic', schema, t.signal, { toolFree: true });
  assert.equal(oauth.securityChannelId, HARNESS_SECURITY_CHANNEL_ID);
  const boot = f.boot(); assert(boot.patch.some(x => x.id === 'llm-deepseek' && x.disabled));
  assert(!JSON.stringify(boot).includes('never-pass-refresh')); assert(!JSON.stringify(boot.patch).includes(token));
});

test('Harness MCP confines endpoints and keeps the task bearer out of command arguments', async t => {
  const f = fixture(); t.after(f.close);
  const mcp = { name: 'eigos_ontology' as const, url: 'https://remote.example/mcp', token: 'synthetic-task-bearer', tools: ['read_task_context', 'submit_decision'] };
  await assert.rejects(f.model.runStructured('synthetic', schema, t.signal, { mcp }), /task-bound loopback/); assert(!existsSync(f.log));
  await assert.rejects(f.model.runStructured('synthetic', schema, t.signal, { toolFree: true, mcp }), /cannot attach/);
  await f.model.runStructured('synthetic', schema, t.signal, { mcp: { ...mcp, url: 'http://127.0.0.1:12345/mcp' } });
  const boot = f.boot(); assert(!boot.args.join(' ').includes(mcp.token));
  const plugin=boot.patch.flatMap(x => x.insert ?? []).find(x => x.name === '@deepseek-ai/dsh-mcp-client');assert(plugin);
  assert(plugin.config&&typeof plugin.config==='object');assert.equal(Reflect.get(plugin.config,'toolCallTimeoutMs'),30000,'The native Harness tool budget stays unchanged');
});

test('Harness configuration is opt-in, with no credential requirement on the protocol-only Gateway', () => {
  assert.equal(readWorkerConfig({}).EIGOS_EXECUTOR, 'disabled');
  assert.throws(() => readWorkerConfig({ EIGOS_EXECUTOR: 'harness' }), /absolute private credential/);
  assert.throws(() => readWorkerConfig({ EIGOS_EXECUTOR: 'harness', EIGOS_HARNESS_CREDENTIAL_FILE: 'relative.key' }), /absolute private credential/);
  const config = readWorkerConfig({ EIGOS_EXECUTOR: 'harness', EIGOS_HARNESS_CREDENTIAL_FILE: '/private/key' });
  assert.equal(config.EIGOS_EXECUTOR, 'harness');
  assert.equal(config.EIGOS_HARNESS_INITIALIZE_TIMEOUT_MS,45000);
  assert.equal(readWorkerConfig({EIGOS_HARNESS_INITIALIZE_TIMEOUT_MS:'60000'}).EIGOS_HARNESS_INITIALIZE_TIMEOUT_MS,60000);
  for(const value of ['999','90001','1500.5','NaN'])assert.throws(()=>readWorkerConfig({EIGOS_HARNESS_INITIALIZE_TIMEOUT_MS:value}));
  assert.equal(readWorkerConfig({EIGOS_HARNESS_INITIALIZE_TIMEOUT_MS:'1000'}).EIGOS_HARNESS_INITIALIZE_TIMEOUT_MS,1000);
  assert.equal(readWorkerConfig({EIGOS_HARNESS_INITIALIZE_TIMEOUT_MS:'90000'}).EIGOS_HARNESS_INITIALIZE_TIMEOUT_MS,90000);
  assert.equal(config.EIGOS_EXECUTOR_TIMEOUT_MS,120000,'Initialization does not change the configured invocation default');
  assert.equal(readConfig({ EIGOS_EXECUTOR: 'harness', EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'a'.repeat(32) }).EIGOS_HARNESS_CREDENTIAL_FILE, undefined);
});
