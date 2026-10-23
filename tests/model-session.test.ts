// Synthetic protocol subprocesses, never real model/provider evidence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexExecutor } from '../packages/capabilities/executor.js';

function fakeServer(mode = 'ok') {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-model-protocol-')), binary = join(directory, 'fake-codex'), trace = join(directory, 'trace.jsonl'), nativeConfig = join(directory, 'native');
  mkdirSync(nativeConfig); writeFileSync(join(nativeConfig, 'auth.json'), 'SYNTHETIC_AUTH_ONLY', { mode: 0o600 });
  const previousConfig = process.env.CODEX_HOME, previousSecret = process.env.EIGOS_DEV_TOKEN;
  process.env.CODEX_HOME = nativeConfig; process.env.EIGOS_DEV_TOKEN = 'SYNTHETIC_GATEWAY_SECRET';
  writeFileSync(binary, '#!' + process.execPath + '\n' + `
const fs = require('node:fs'), readline = require('node:readline');
const mode = ${JSON.stringify(mode)}, thread = 'synthetic-thread-' + process.pid;
const log = value => fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value) + '\\n');
log({ type:'boot', args:process.argv.slice(2), config:process.env.CODEX_HOME, gatewaySecretPresent:!!process.env.EIGOS_DEV_TOKEN,
  authIsLink:fs.lstatSync(process.env.CODEX_HOME+'/auth.json').isSymbolicLink(), authTarget:fs.readlinkSync(process.env.CODEX_HOME+'/auth.json'), emptyConfig:fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8') === '' });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');let count=0;
readline.createInterface({ input:process.stdin }).on('line', line => {
  const r=JSON.parse(line);log({type:'request',method:r.method,params:r.params});
  if(r.method==='initialize')send({id:r.id,result:{}});
  if(r.method==='thread/start'){
    if(mode==='refresh')fs.writeFileSync(process.env.CODEX_HOME+'/auth.json','SYNTHETIC_REFRESHED_AUTH');
    send({id:r.id,result:{thread:{id:thread,ephemeral:true},model:'synthetic-model',approvalPolicy:'never',sandbox:{type:mode==='policy'?'workspaceWrite':'readOnly'},instructionSources:[]}});
  }
  if(r.method==='turn/start'){
    const turn='synthetic-turn-'+(++count), target=mode==='wrong-thread'?'other-thread':thread;
    const emit=(method,params)=>send({method,params:{threadId:target,turnId:turn,...params}});
    if(mode==='rpc-error'){send({id:r.id,error:{code:1,message:'SYNTHETIC_UPSTREAM_SECRET'}});return;}
    if(mode==='early')emit('item/completed',{item:{type:'agentMessage',id:'early',text:JSON.stringify({answer:count}),phase:'final_answer'}});
    send({id:r.id,result:{turn:{id:turn,status:'inProgress'}}});
    if(mode==='hang')return;
    if(mode==='oversize'){process.stdout.write('x'.repeat(2000001));return;}
    if(mode==='approval'){send({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:turn}});return;}
    if(mode==='native-tool'){emit('item/started',{item:{type:'commandExecution',id:'forbidden'}});return;}
    emit('item/completed',{item:{type:'reasoning',id:'hidden',summary:['SYNTHETIC_HIDDEN_REASONING'],content:[]}});
    if(mode!=='early')emit('item/completed',{item:{type:'agentMessage',id:'answer',text:JSON.stringify({answer:count}),phase:'final_answer'}});
    emit('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:10+count,cachedInputTokens:count===2?10:0,outputTokens:3},total:{inputTokens:999}}});
    emit('turn/completed',{turn:{id:turn,status:mode==='failed'?'failed':'completed',error:null}});
  }
});process.stdin.on('end',()=>process.exit(0));
`, { mode: 0o700 });
  return { binary, nativeConfig, events: () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [], close: () => {
    if (previousConfig === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousConfig;
    if (previousSecret === undefined) delete process.env.EIGOS_DEV_TOKEN; else process.env.EIGOS_DEV_TOKEN = previousSecret;
    rmSync(directory, { recursive: true, force: true });
  } };
}
const schema = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false };

for (const mode of ['ok', 'early']) test(`A bounded ${mode} conversation reuses its thread and preserves each actual model response`, async () => {
  const f = fakeServer(mode); const session = await new CodexExecutor(f.binary, 5000).openStructuredSession(schema, new AbortController().signal);
  try {
    const first = await session.run('Synthetic initial context'), second = await session.run('Only newly returned synthetic results');
    assert.deepEqual(first.output, { answer: 1 }); assert.deepEqual(second.output, { answer: 2 });
    assert.equal(first.evidence.threadId, second.evidence.threadId); assert.notEqual(first.evidence.turnId, second.evidence.turnId); assert.notEqual(first.evidence.id, second.evidence.id);
    assert.equal(second.evidence.usage!.input_tokens, 12); assert.equal(second.evidence.usage!.cached_input_tokens, 10);
    assert.equal(second.evidence.runtime, 'codex-app-server'); assert.equal(second.evidence.promptBytes, Buffer.byteLength('Only newly returned synthetic results'));
    assert(!JSON.stringify([first, second]).includes('SYNTHETIC_HIDDEN_REASONING'));
    const events = f.events(), boot = events[0], start = events.find(e => e.method === 'thread/start');
    assert.equal(boot.gatewaySecretPresent, false); assert(boot.authIsLink && boot.emptyConfig); assert.equal(boot.authTarget, join(f.nativeConfig, 'auth.json'));
    assert(start.params.ephemeral && start.params.approvalPolicy === 'never' && start.params.sandbox === 'read-only');
    assert(start.params.baseInstructions.includes('bounded EIGOS business reasoner'));
    assert(boot.args.includes('shell_tool') && boot.args.includes('plugins') && boot.args.includes('hooks'));
    assert(boot.args.includes('cli_auth_credentials_store="file"'));
    await session.close(); assert(!existsSync(boot.config)); assert.equal(readFileSync(join(f.nativeConfig, 'auth.json'), 'utf8'), 'SYNTHETIC_AUTH_ONLY');
    await assert.rejects(session.run('Cannot reuse a closed context'), /closed|exited/);
  } finally { await session.close(); f.close(); }
});

for (const mode of ['wrong-thread', 'approval', 'native-tool', 'failed', 'rpc-error', 'oversize']) test(`Bounded conversation fails closed on ${mode}`, async () => {
  const f = fakeServer(mode), session = await new CodexExecutor(f.binary, 5000).openStructuredSession(schema, new AbortController().signal);
  try {
    await assert.rejects(session.run('Synthetic'), error => error instanceof Error && !error.message.includes('SYNTHETIC_UPSTREAM_SECRET'));
  } finally { await session.close(); const boot = f.events()[0]; assert(!existsSync(boot.config)); f.close(); }
});

test('A failed policy handshake never starts a model turn', async () => {
  const f = fakeServer('policy');
  try { await assert.rejects(new CodexExecutor(f.binary, 5000).openStructuredSession(schema, new AbortController().signal), /policy/); assert(!f.events().some(e => e.method === 'turn/start')); assert(!existsSync(f.events()[0].config)); }
  finally { f.close(); }
});

test('Different planning sessions never share a process, thread or temporary context', async () => {
  const f = fakeServer(), model = new CodexExecutor(f.binary, 5000), threads: string[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const session = await model.openStructuredSession(schema, new AbortController().signal);
      try { const result = await session.run('Synthetic isolated decision ' + i); assert.deepEqual(result.output, { answer: 1 }); threads.push(result.evidence.threadId!); }
      finally { await session.close(); }
    }
    assert.notEqual(threads[0], threads[1]); const boots = f.events().filter(e => e.type === 'boot');
    assert.equal(boots.length, 2); assert.notEqual(boots[0].config, boots[1].config); assert(boots.every(b => !existsSync(b.config)));
  } finally { f.close(); }
});

test('Native file-store refresh writes through the auth reference and cleanup preserves the native store', async () => {
  const f = fakeServer('refresh'), session = await new CodexExecutor(f.binary, 5000).openStructuredSession(schema, new AbortController().signal);
  try {
    assert.equal(readFileSync(join(f.nativeConfig, 'auth.json'), 'utf8'), 'SYNTHETIC_REFRESHED_AUTH');
    await session.run('Synthetic auth-store lifecycle only'); await session.close();
    assert.equal(readFileSync(join(f.nativeConfig, 'auth.json'), 'utf8'), 'SYNTHETIC_REFRESHED_AUTH'); assert(!existsSync(f.events()[0].config));
  } finally { await session.close(); f.close(); }
});

test('Timeout and cancellation terminate the owned conversation without a fallback or next turn', async () => {
  for (const cancel of [false, true]) {
    const f = fakeServer('hang'), controller = new AbortController(), session = await new CodexExecutor(f.binary, 1000).openStructuredSession(schema, controller.signal);
    try {
      const result = session.run('Synthetic pending turn');
      if (cancel) controller.abort();
      await assert.rejects(result, cancel ? /canceled/ : /timed out/);
      await session.close(); const dispatched = f.events().filter(e => e.method === 'turn/start').length;
      assert(cancel ? dispatched <= 1 : dispatched === 1); assert(!existsSync(f.events()[0].config));
    } finally { await session.close(); f.close(); }
  }
});
