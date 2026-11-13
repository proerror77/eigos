import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { fixture, route } from '../fixture.js';
import { planningInput, calendarAnswer } from '../planning-fixture.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const ended = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await ended; } finally { clearTimeout(timer); }
}
test('separate Gateway and Worker complete inquiries and PA calendar scenarios on the original PostgreSQL tasks', async t => {
  const f = await fixture(), token = 'process-test-token-'.repeat(3);
  const portServer = createServer().listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const address = portServer.address(); assert(address && typeof address !== 'string'); const port = address.port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const env = { ...process.env, DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_PG_SCHEMA: f.schema, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, PUBLIC_URL: `http://127.0.0.1:${port}`, PORT: String(port) };
  const gateway = fork(new URL('../../apps/gateway/main.js', import.meta.url), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const worker = fork(new URL('./worker.js', import.meta.url), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const url = env.PUBLIC_URL, headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await fetch(url + '/health').then(response => response.ok).catch(() => false)) break;
      await delay(50);
    }
    const started = performance.now();
    const input = { requestId: 'e2e-route', message: '上海从中企云翠森林到前滩太古里，只询价', route };
    const submitted = await fetch(url + '/tasks', { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(submitted.status, 200);
    let task = await submitted.json() as { id: string; state: string; result: { accepted: boolean; estimates: unknown[] } };
    while (['working', 'submitted'].includes(task.state) && performance.now() - started < 20000) {
      await delay(25); task = await (await fetch(url + '/tasks/' + task.id, { headers })).json() as typeof task;
    }
    assert.equal(task.state, 'completed', JSON.stringify(task));
    assert.equal(task.result.accepted, false); assert.equal(task.result.estimates.length, 2);
    assert(performance.now() - started < 20000);
    const again = await (await fetch(url + '/tasks', { method: 'POST', headers, body: JSON.stringify(input) })).json() as typeof task;
    assert.equal(again.id, task.id);
    const quoteElapsed=Math.round(performance.now()-started);
    const client=new Client({name:'synthetic-calendar-pa',version:'1'});
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url+'/mcp'),{requestInit:{headers}}));
      const call=async(name:string,args:Record<string,unknown>)=>{
        const response=await client.callTool({name,arguments:args});assert(!response.isError,JSON.stringify(response));
        return JSON.parse((response.content as {text:string}[])[0]!.text);
      };
      const planning=planningInput(),created=await call('submit_task',{requestId:'e2e-calendar',message:JSON.stringify({planning})});
      const poll=async(taskId=created.id)=>{
        const until=Date.now()+15000;
        for(;;){const current=await call('get_task',{taskId});if(!['working','submitted'].includes(current.state))return current;
          if(Date.now()>until)throw new Error('Calendar task did not reach its next state');await delay(25);}
      };
      const waiting=await poll();assert.equal(waiting.state,'input-required');assert.equal(waiting.result.capability,'calendar.freebusy');
      const answer={requestId:waiting.result.requestId,response:calendarAnswer(planning)};
      const resumed=await fetch(url+'/a2a',{method:'POST',headers:{...headers,'A2A-Version':'1.0'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'SendMessage',params:{message:{messageId:'calendar-response',taskId:created.id,role:'ROLE_USER',parts:[{data:{paResponse:answer},mediaType:'application/json'}]}}})});
      const response=await resumed.json() as {result?:{task?:{id:string};id?:string};error?:unknown};assert(!response.error,JSON.stringify(response));
      const completed=await poll();assert.equal(completed.id,created.id);assert.equal(completed.state,'completed',JSON.stringify(completed));
      assert.equal(completed.result.validation.valid,true);assert.equal(completed.result.activities.length,1);assert.equal(completed.result.externalCalendarUpdated,false);
      const scenarioId=completed.result.scenarioId;
      const live=await call('query_ontology',{query:{type:'ScheduledActivity'}});assert.equal(live.items.length,0);
      const scenario=await call('query_ontology',{scenarioId,query:{type:'ScheduledActivity'}});assert.equal(scenario.items.length,1);
      const diff=await call('inspect_scenario',{scenarioId});
      await call('apply_ontology_action',{requestId:'e2e-explicit-merge',action:'CommitSchedulePlan',input:{plan:completed.result.plan.ref,scenarioId,revision:diff.revision}});
      assert.equal((await call('query_ontology',{query:{type:'ScheduledActivity'}})).items.length,1);
      t.diagnostic(JSON.stringify({calendarTask:created.id,PA:'synthetic free/busy',submission:'MCP',continuation:'A2A',scenarioMerge:'explicit MCP Action',externalCalendarUpdated:false}));
      const luma=await call('submit_task',{requestId:'e2e-luma',message:'luma discovery'}),lumaWait=await poll(luma.id);
      assert.equal(lumaWait.state,'input-required');assert.equal(lumaWait.result.capability,'luma.events.read');
      assert((await call('list_pa_requests',{})).items.some((item:{taskId:string})=>item.taskId===luma.id));
      const eventStart=new Date(Date.now()+7200000).toISOString();
      await call('respond_to_task',{taskId:luma.id,requestId:lumaWait.result.requestId,response:{status:'available',accountRef:'synthetic-grok-account',source:'https://mcp.luma.com',observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+240000).toISOString(),complete:true,cursor:null,proofDigest:'a'.repeat(64),items:[{nativeId:'evt-e2e',name:'Synthetic event',url:'https://luma.com/synthetic',status:'active',start:eventStart,end:new Date(Date.parse(eventStart)+3600000).toISOString(),timeZone:'Asia/Shanghai',address:'Synthetic venue',locationPrecision:'exact',registrationOpen:true,approvalRequired:false,startingPrice:0,currency:'CNY'}]}});
      const lumaDone=await poll(luma.id);assert.equal(lumaDone.state,'completed',JSON.stringify(lumaDone));
      const event=lumaDone.result.items[0].ref;
      const registration=await call('apply_ontology_action',{requestId:'e2e-register-proposal',interface:{type:'AttendableEvent',object:event,action:'register'},input:{event,ticketId:'free-ticket',sourceTaskId:luma.id}});
      const registrationData=(await call('query_ontology',{query:{type:'EventRegistration',where:{id:registration.id}}})).items[0];
      await call('apply_ontology_action',{requestId:'e2e-register-permit',action:'AuthorizeEventRegistration',input:{registration,revision:registrationData.revision,expiresAt:new Date(Date.now()+120000).toISOString()}});
      let request;const inboxDeadline=Date.now()+15000;
      while(!request&&Date.now()<inboxDeadline){request=(await call('list_pa_requests',{})).items.find((item:{request:{capability:string}})=>item.request.capability==='luma.participant.register');if(!request)await delay(25);}
      assert(request);assert.equal(request.sourceTaskId,luma.id);
      await call('respond_to_task',{taskId:request.taskId,requestId:request.request.requestId,response:{status:'confirmed',eventId:'evt-e2e',ticketId:'free-ticket',registrationId:'reg-e2e-original',participantRef:'synthetic-participant',accountRef:'synthetic-grok-account',amountMinor:'0',independentRead:true,observedAt:new Date().toISOString(),proofDigest:'b'.repeat(64)}});
      assert.equal((await poll(request.taskId)).state,'completed');
      const registered=(await call('evaluate_ontology',{function:'readEventRegistration',input:{registration}})).registration;
      assert.equal(registered.properties.state,'confirmed');assert.equal(registered.properties.evidence,'pa_reported');assert.equal((await call('get_task',{taskId:luma.id})).state,'completed');
      assert.equal((await call('query_ontology',{query:{type:'RideOrder'}})).items.length,0);
      t.diagnostic(JSON.stringify({lumaTask:luma.id,scheduledRegistrationTask:request.taskId,PA:'synthetic Grok/Luma responses',externalMutations:0}));
    } finally {await client.close();}
    t.diagnostic(JSON.stringify({ messageToQuoteMs: quoteElapsed, source: 'synthetic MCP responses', database: 'PostgreSQL', processes: ['Gateway', 'Worker'] }));
  } finally { await Promise.all([stop(gateway), stop(worker)]); await f.close(); }
});
