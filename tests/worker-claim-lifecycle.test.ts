import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {WorkClaim} from '../packages/core/store.js';
import {withWorkerClaimRelease,notifyWorkerClaimRelease} from '../packages/core/worker-claim-lifecycle.js';

function claim(suffix='a'):WorkClaim{
  const at='2026-11-04T00:00:00.000Z';
  return {owner:'owner-'+suffix,token:'token-'+suffix,job:{id:'task-'+suffix,contextId:'context-'+suffix,
    service:'eigos.delegate',goal:'Synthetic lifecycle only',state:'working',messages:[],createdAt:at,updatedAt:at}};
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const notify=(work:WorkClaim)=>notifyWorkerClaimRelease(work.owner,work.job.id,work.token);

test('a matching notification awaits heartbeat drain before its caller can continue to release',async()=>{
  const work=claim(),entered=deferred(),drained=deferred(),events:string[]=[];
  const action=withWorkerClaimRelease(work,async()=>{events.push('stop');entered.resolve();await drained.promise;events.push('drained');},async()=>{
    await notify(work);events.push('release-caller-continues');return 'original-result';
  });
  await entered.promise;assert.deepEqual(events,['stop']);drained.resolve();
  assert.equal(await action,'original-result');assert.deepEqual(events,['stop','drained','release-caller-continues']);
});

test('concurrent and repeated notifications share the same completed drain',async()=>{
  const work=claim(),entered=deferred(),drained=deferred();let calls=0;
  await withWorkerClaimRelease(work,async()=>{calls++;entered.resolve();await drained.promise;},async()=>{
    const first=notify(work),second=notify(work);await entered.promise;assert.equal(calls,1);
    drained.resolve();await Promise.all([first,second]);await notify(work);assert.equal(calls,1);
  });
});

test('owner, task and original token must all match and are captured before action mutations',async()=>{
  const work=claim(),original={owner:work.owner,taskId:work.job.id,token:work.token};let calls=0;
  await withWorkerClaimRelease(work,async()=>{calls++;},async()=>{
    await notifyWorkerClaimRelease('another-owner',original.taskId,original.token);
    await notifyWorkerClaimRelease(original.owner,'another-task',original.token);
    await notifyWorkerClaimRelease(original.owner,original.taskId,'another-token');assert.equal(calls,0);
    work.owner='changed-owner';work.job.id='changed-task';work.token='changed-token';await notify(work);assert.equal(calls,0);
    await notifyWorkerClaimRelease(original.owner,original.taskId,original.token);assert.equal(calls,1);
  });
});

test('a nested different Worker cannot notify an outer Worker and restores its parent on exit',async()=>{
  const a=claim('a'),b=claim('b'),calls:string[]=[];
  await withWorkerClaimRelease(a,async()=>{calls.push('a');},async()=>{
    await withWorkerClaimRelease(b,async()=>{calls.push('b');},async()=>{
      await notify(a);assert.deepEqual(calls,[]);await notify(b);assert.deepEqual(calls,['b']);
    });
    await notify(a);assert.deepEqual(calls,['b','a']);
  });
});

test('parallel Worker scopes stay isolated across asynchronous continuations',async()=>{
  const a=claim('a'),b=claim('b'),bothReady=deferred(),calls:string[]=[];let ready=0;
  await Promise.all([a,b].map(work=>withWorkerClaimRelease(work,async()=>{calls.push(work.owner);},async()=>{
    if(++ready===2)bothReady.resolve();await bothReady.promise;await notify(work===a?b:a);await notify(work);
  })));
  assert.deepEqual(calls.sort(),[a.owner,b.owner]);
});

test('hook failure propagates unchanged and prevents the release caller from proceeding',async()=>{
  for(const synchronous of [false,true]){
    const work=claim(),failure=new Error('Synthetic real renewal refusal');let calls=0,continued=false;
    await withWorkerClaimRelease(work,()=>{calls++;if(synchronous)throw failure;return Promise.reject(failure);},async()=>{
      await assert.rejects(async()=>{await notify(work);continued=true;},error=>error===failure);
      await assert.rejects(notify(work),error=>error===failure);
    });
    assert.equal(calls,1);assert.equal(continued,false);
  }
});

test('no scope and escaped closed contexts cannot stop a current or later Worker',async()=>{
  const a=claim('a'),b=claim('b'),later=deferred();let escaped!:Promise<void>,calls=0;
  await notify(a);
  await withWorkerClaimRelease(a,async()=>{calls++;},async()=>{
    escaped=(async()=>{await later.promise;await notify(a);await notify(b);})();
  });
  await withWorkerClaimRelease(b,async()=>{calls++;},async()=>{
    later.resolve();await escaped;assert.equal(calls,0);await notify(b);assert.equal(calls,1);
  });
});

test('scope cleanup also runs when the action rejects and cannot retain its previous hook',async()=>{
  const work=claim(),failure=new Error('Synthetic action rollback');let oldCalls=0,newCalls=0;
  await assert.rejects(withWorkerClaimRelease(work,async()=>{oldCalls++;},async()=>{throw failure;}),error=>error===failure);
  await notify(work);assert.equal(oldCalls,0);
  await withWorkerClaimRelease(work,async()=>{newCalls++;},async()=>{await notify(work);});
  assert.equal(oldCalls,0);assert.equal(newCalls,1);
});

test('an in-flight notification cannot let a detached release continue after its scope closes',async()=>{
  const work=claim(),entered=deferred(),drained=deferred();let pending!:Promise<void>;
  await withWorkerClaimRelease(work,async()=>{entered.resolve();await drained.promise;},async()=>{
    pending=notify(work);void pending.catch(()=>{});await entered.promise;
  });
  drained.resolve();await assert.rejects(pending,/scope closed/);
});

test('a reentrant release hook fails instead of waiting on its own notification',async()=>{
  const work=claim();
  await assert.rejects(withWorkerClaimRelease(work,()=>notify(work),()=>notify(work)),/cannot await itself/);
});
