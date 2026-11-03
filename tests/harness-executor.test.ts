import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessExecutor, HARNESS_SECURITY_CHANNEL_ID, HARNESS_DEEPSEEK_SECURITY_CHANNEL_ID, type HarnessConfiguration } from '../packages/capabilities/harness-executor.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { withModelUsage } from '../packages/core/model-usage-context.js';

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
 if(q.method==='initialize'){reply(q.id,{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}});return;}
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
  const output=mode==='bad-json'?'invalid':JSON.stringify({ok:mode!=='bad-schema'});
  event('assistant/message',{message:{role:'assistant',content:[{type:'text',text:output}]},usage:{inputTokens:3,outputTokens:2}});
  if(mode!=='no-completion')event('turn/end',{turn:1,reason:{kind:mode==='failed'?'failed':'completed'}});
  reply(q.id,{});return;
 }
 if(q.method==='shutdown'){reply(q.id,{});return;}
});
`.replace('MODE_VALUE', JSON.stringify(mode)).replace('LOG_VALUE', JSON.stringify(log)), { mode: 0o700 });
  const model = new HarnessExecutor(binary, mode === 'hang' ? 1200 : 5000, { credentialFile: key, credentialKind: 'api-key' });
  return { root, key, binary, model, log, boot: () => JSON.parse(readFileSync(log, 'utf8')) as { pid: number; childPid?: number; args: string[]; home: string; dshHome: string; patch: { id?: string; disabled?: boolean; insert?: { name: string; config?: unknown }[] }[]; env: string[]; hasCredential: boolean },
    close: () => rmSync(root, { recursive: true, force: true }) };
}
const schema = { type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false };

test('Harness preserves Chinese and emoji split inside UTF-8 bytes across stdout chunks', async t => {
  const f = fixture('split-utf8'); t.after(f.close);
  const textSchema = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false };
  const result = await f.model.runStructured('synthetic', textSchema, t.signal, { toolFree: true });
  assert.deepEqual(result.output, { message: '东京你好 👋🧪' });
});

test('Harness waits for durable dispatch acknowledgement and accounting before returning', async t => {
  const f = fixture(); t.after(f.close);
  let admit!: () => void, finish!: () => void, began!: () => void, accounting!: () => void;
  const admitted = new Promise<void>(resolve => { admit = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  const ending = new Promise<void>(resolve => { accounting = resolve; });
  let settled = false;
  const pending = withModelUsage({ begin: async () => { began(); await admitted; }, finish: async () => { accounting(); await finished; } },
    () => f.model.runStructured('synthetic', schema, t.signal, { toolFree: true })).finally(() => { settled = true; });
  t.after(() => { admit(); finish(); });
  await started; assert(!existsSync(f.log), 'No model process before the durable begin acknowledgement');
  admit(); await ending; assert.equal(settled, false, 'Completion must wait for accounting acknowledgement');
  finish(); assert.deepEqual((await pending).output, { ok: true });
  assert(!existsSync(f.boot().home));
});

test('Harness never dispatches when the durable begin acknowledgement fails or is unknown', async t => {
  const f = fixture(); t.after(f.close);
  await assert.rejects(withModelUsage({ begin: async () => { throw new Error('Commit acknowledgement unknown'); }, finish: () => { assert.fail('No admitted dispatch'); } },
    () => f.model.runStructured('synthetic', schema, t.signal)), /Commit acknowledgement unknown/);
  assert(!existsSync(f.log));
});

test('Harness confines the original turn, credentials, profile and receipt to its invocation', async t => {
  const f = fixture(); t.after(f.close);
  const previousGateway=process.env.EIGOS_DEV_TOKEN,previousModel=process.env.DEEPSEEK_API_KEY;
  process.env.EIGOS_DEV_TOKEN='gateway-secret';process.env.DEEPSEEK_API_KEY='unrelated-host-key';
  t.after(()=>{if(previousGateway===undefined)delete process.env.EIGOS_DEV_TOKEN;else process.env.EIGOS_DEV_TOKEN=previousGateway;if(previousModel===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=previousModel;});
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
  assert(boot.patch.flatMap(x => x.insert ?? []).some(x => x.name === '@deepseek-ai/dsh-mcp-client'));
});

test('Harness configuration is opt-in, with no credential requirement on the protocol-only Gateway', () => {
  assert.equal(readWorkerConfig({}).EIGOS_EXECUTOR, 'disabled');
  assert.throws(() => readWorkerConfig({ EIGOS_EXECUTOR: 'harness' }), /absolute private credential/);
  assert.throws(() => readWorkerConfig({ EIGOS_EXECUTOR: 'harness', EIGOS_HARNESS_CREDENTIAL_FILE: 'relative.key' }), /absolute private credential/);
  const config = readWorkerConfig({ EIGOS_EXECUTOR: 'harness', EIGOS_HARNESS_CREDENTIAL_FILE: '/private/key' });
  assert.equal(config.EIGOS_EXECUTOR, 'harness');
  assert.equal(readConfig({ EIGOS_EXECUTOR: 'harness', EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'a'.repeat(32) }).EIGOS_HARNESS_CREDENTIAL_FILE, undefined);
});
