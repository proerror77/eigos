import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withModelDispatchGuard,authorizeModelDispatch} from '../packages/core/model-dispatch-context.js';
import {withModelUsage} from '../packages/core/model-usage-context.js';
import {CodexExecutor} from '../packages/capabilities/executor.js';

test('model dispatch guards retain outer authority, await current checks and do not leak between tasks',async()=>{
  const events:string[]=[];let resolve!:()=>void;
  const gate=new Promise<void>(done=>{resolve=done;});
  const outer={channelId:'synthetic-model',authorize:async()=>{events.push('outer');await gate;}};
  const inner={channelId:'synthetic-model',authorize:async()=>{events.push('inner');}};
  const pending=withModelDispatchGuard(outer,()=>withModelDispatchGuard(inner,async()=>{await authorizeModelDispatch('synthetic-model');events.push('dispatch');}));
  await Promise.resolve();assert.deepEqual(events,['outer']);
  await authorizeModelDispatch('different-task-with-no-guard');assert.deepEqual(events,['outer']);
  resolve();await pending;assert.deepEqual(events,['outer','inner','dispatch']);
  await assert.rejects(withModelDispatchGuard(outer,()=>authorizeModelDispatch('wrong-channel')),/differs from its admitted boundary/);
  await assert.rejects(withModelDispatchGuard({...outer,authorize:async()=>{throw new Error('Original authority revoked');}},
    ()=>withModelDispatchGuard(inner,()=>authorizeModelDispatch('synthetic-model'))),/Original authority revoked/);
});

test('actual Codex transport rechecks authority after preparation and never spawns a denied prompt',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'eigos-model-dispatch-')),binary=join(directory,'synthetic-codex'),marker=join(directory,'spawned');
  try{
    await writeFile(binary,`#!/bin/sh\nprintf spawned > '${marker}'\nexit 1\n`,{mode:0o700});
    const executor=new CodexExecutor(binary),events:string[]=[],signal=new AbortController();
    await assert.rejects(withModelUsage({begin:async()=>{events.push('durable-begin');},finish:async(_id,_evidence,outcome)=>{events.push(outcome);}},
      ()=>withModelDispatchGuard({channelId:executor.securityChannelId,authorize:async()=>{events.push('current-dispatch-check');throw new Error('Original source evidence expired during CLI preparation');}},
        ()=>executor.runStructured('Synthetic prompt only',{type:'object'},signal.signal))),/Original source evidence expired/);
    await assert.rejects(readFile(marker),{code:'ENOENT'});
    assert.deepEqual(events,['durable-begin','current-dispatch-check','failed']);
  }finally{await rm(directory,{recursive:true,force:true});}
});
