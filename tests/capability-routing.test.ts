// Model decisions below are fixtures; live model routing is verified separately.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../apps/gateway/app.js';
import { Worker } from '../apps/worker/worker.js';
import { Coordinator, type Assessor } from '../packages/coordinator/coordinator.js';
import { CapabilityRegistry, type RegisteredCapability } from '../packages/core/capabilities.js';
import { createCapabilityRegistry } from '../packages/capabilities/registry.js';
import { BriefCapability, verifyBrief } from '../packages/capabilities/brief.js';
import { AuditPilot } from '../packages/capabilities/pilot/service.js';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { ownerKey, SCOPES, type Job } from '../packages/core/domain.js';
import { CSV_ONTOLOGY } from '../packages/ontology/csv-audit.js';
import { digest, type Assessment } from '../packages/core/delegation.js';
import { readConfig } from '../packages/core/config.js';
const p = { issuer:'local-development',tenant:'local',subject:'developer',clientId:'test',scopes:[...SCOPES] };
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const briefInput={goal:'Compare three suppliers',deliverable:'Record prices, capacities and source requirements in a task brief. Do not contact suppliers.'};
const select=(capabilityId:string,input:object):Assessment=>({decision:'select_capability',capabilityId,message:'Fixture selection',inputJson:JSON.stringify(input)});
const model=(decide:(job:Job,ids:string[])=>Assessment):Assessor=>({assess:async(job,candidates)=>({decision:decide(job,candidates.map(c=>c.id)),evidence:{id:randomUUID(),runtime:'routing-fixture',startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),outputSha256:'fixture'}})});
async function fixture(assessor:Assessor,csv=false,custom?:(store:JobStore)=>CapabilityRegistry){
 const dir=mkdtempSync(join(tmpdir(),'eigos-routing-'));writeFileSync(join(dir,'sample.csv'),'record_id,email,amount_cny,event_date\nA,a@example.test,1,2026-10-15\n');
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
 const token='routing-fixture-token-'.repeat(3);const config=readConfig({EIGOS_AUTH_MODE:'development',EIGOS_DEV_TOKEN:token,DATABASE_PATH:':memory:',PUBLIC_URL:base,PORT:String(address.port),EIGOS_COORDINATOR:'codex',...(csv?{EIGOS_CSV_PILOT:'true',EIGOS_CSV_INPUT_DIR:dir}:{})});
 const gateway=createApp(config,undefined,custom??(store=>{const pilot=csv?new AuditPilot(store):undefined;return createCapabilityRegistry(store,{pilot,csvInputDirectory:csv?dir:undefined,csvTick:()=>pilot!.tick()});}));server.on('request',gateway.app);
 const worker=new Worker(gateway.store,{coordinator:new Coordinator(gateway.store,assessor,gateway.registry),maintenance:()=>gateway.registry.tick(),pollMs:10});worker.start();
 const rpc=async(method:string,params:object)=>(await fetch(base+'/a2a',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','A2A-Version':'1.0'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})})).json();
 const send=async(text:string,taskId?:string)=>{const r=await rpc('SendMessage',{configuration:{returnImmediately:true},message:{messageId:randomUUID(),role:'ROLE_USER',...(taskId?{taskId}:{}),parts:[{text}]}});assert(!r.error,JSON.stringify(r));return r.result.task.id as string;};
 const wait=async(id:string,state:Job['state'])=>{for(let i=0;i<400;i++){const j=gateway.tasks.get(p,id);if(j.state===state)return j;await pause(10);}assert.fail('State deadline exceeded');};
 return{gateway,worker,base,token,send,wait,rpc,close:async()=>{await worker.close();await gateway.tasks.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await gateway.close();rmSync(dir,{recursive:true,force:true});}};
}

test('one delegate entry selects two registered capabilities; brief has no simulated-payment state',async()=>{
 const seen:string[][]=[];
 const f=await fixture(model((job,ids)=>{seen.push(ids);return job.goal==='csv' ?select('data.quality.audit.simulated',{fileName:'sample.csv',checks:[...CSV_ONTOLOGY.checks]}):select('brief.prepare',briefInput);}),true);
 try{
  const a=await f.send('brief');const brief=await f.wait(a,'completed');
  assert.equal(brief.delegation!.capabilityId,'brief.prepare');assert.equal(brief.delegation!.providerId,'local-brief-builder');
  assert.equal(brief.pilot,undefined);assert.equal(brief.artifact!.data.execution,'not_started');assert(brief.delegation!.acceptance!.accepted);
  assert(verifyBrief(brief.artifact!,briefInput));assert(!verifyBrief({...brief.artifact!,data:{...brief.artifact!.data,execution:'completed'}},briefInput));
  const b=await f.send('csv');const csv=await f.wait(b,'auth-required');assert.equal(csv.delegation!.capabilityId,'data.quality.audit.simulated');assert(csv.pilot);assert.equal(csv.artifact,undefined);
  assert(seen.every(ids=>ids.includes('brief.prepare')&&ids.includes('data.quality.audit.simulated')));
  const card=await(await fetch(f.base+'/.well-known/agent-card.json')).json();const skill=card.skills.find((s:{id:string})=>s.id==='eigos.delegate');assert(skill.description.includes('brief.prepare'));assert(skill.description.includes('data.quality.audit.simulated'));
 }finally{await f.close();}
});

test('coordinator works without CSV config; brief clarification resumes the same task',async()=>{
 const f=await fixture(model((job,ids)=>{assert.deepEqual(ids,['brief.prepare']);return job.messages.length===1?{decision:'ask_user',capabilityId:'brief.prepare',message:'What deliverable should the brief specify?',inputJson:'{}'}:select('brief.prepare',briefInput);}));
 try{const id=await f.send('prepare a brief');await f.wait(id,'input-required');assert.equal(await f.send('Record price, capacity and sources only.',id),id);const j=await f.wait(id,'completed');assert.equal(j.runs!.length,2);assert.equal(j.pilot,undefined);assert.equal(j.artifact!.data.deliverable,briefInput.deliverable);}
 finally{await f.close();}
});

test('unsupported and hallucinated/disabled capabilities cannot fall back to brief execution',async()=>{
 for(const decision of [
  {decision:'unsupported',capabilityId:'',message:'No registered coffee purchasing capability.',inputJson:'{}'} as Assessment,
  select('data.quality.audit.simulated',{fileName:'sample.csv',checks:[...CSV_ONTOLOGY.checks]}),
  select('invented.provider',{}),
 ]){const f=await fixture(model(()=>decision));try{const id=await f.send('buy a coffee');const j=await f.wait(id,decision.decision==='unsupported'?'rejected':'failed');assert.equal(j.artifact,undefined);assert.equal(j.pilot,undefined);}finally{await f.close();}}
});

test('a third capability runs through registration alone; no shared dispatcher changes',async()=>{
 let calls=0;
 const third:RegisteredCapability={definition:{id:'fixture.echo',version:'1',providerId:'local-fixture',ontologyVersion:'echo-v1',service:{id:'fixture.echo',name:'Fixture echo',description:'Echo supplied text in a test',requiredInputs:['text'],tags:['fixture'],examples:['Echo hello'],inputModes:['application/json'],outputModes:['application/json']},inputSchema:{type:'object'},ontology:{objects:['Text'],actions:['echo']}},available:()=>true,
  prepare:(_job,input)=>{assert.deepEqual(input,{text:'hello'});return{kind:'ready',input:{text:'hello'},details:{actions:['echo']}};},
  start:(job,prepared)=>{calls++;job.state='completed';job.delegation!.phase='accepted';job.delegation!.acceptance={accepted:prepared.input.text==='hello',reason:'Fixture echo matches supplied input',at:job.updatedAt};job.artifact={id:randomUUID(),name:'echo.json',data:{goal:job.goal,deliverable:String(prepared.input.text),execution:'completed'}};}};
 const f=await fixture(model((_job,ids)=>{assert.deepEqual(ids,['fixture.echo']);return select('fixture.echo',{text:'hello'});}),false,()=>new CapabilityRegistry([third]));
 try{const id=await f.send('echo');const j=await f.wait(id,'completed');assert.equal(j.delegation!.capabilityId,'fixture.echo');assert.equal(j.artifact!.data.deliverable,'hello');assert.equal(calls,1);assert.equal(j.pilot,undefined);}
 finally{await f.close();}
});

test('registry rejects duplicate bindings and excludes unavailable capabilities before model selection',()=>{
 const brief=new BriefCapability();assert.throws(()=>new CapabilityRegistry([brief,brief]),/Duplicate/);
 const store=new JobStore(':memory:');try{const registry=createCapabilityRegistry(store,{pilot:new AuditPilot(store),csvInputDirectory:'/fixture'});assert.deepEqual(registry.definitions(ownerKey({...p,subject:'other'})).map(d=>d.id),['brief.prepare']);}finally{store.close();}
});

test('legacy CSV plan is dispatched by its adapter and retains its quote digest across registry migration',async()=>{
 const f=await fixture(model(()=>select('data.quality.audit.simulated',{fileName:'sample.csv',checks:[...CSV_ONTOLOGY.checks]})),true);
 try{
  const id=await f.send('csv');const j=await f.wait(id,'auth-required');const d=j.delegation!;
  const body={id:d.plan!.id,...d.plan!.details};d.plan={...body,digest:digest(body)};delete d.capabilityId;delete d.capabilityVersion;delete d.providerId;delete d.routingVersion;delete j.executionMode;
  j.pilot!.quote.planDigest=d.plan.digest;j.pilot!.quoteDigest=digest(j.pilot!.quote);f.gateway.store.save(ownerKey(p),j);
  const registry=createCapabilityRegistry(f.gateway.store,{pilot:new AuditPilot(f.gateway.store),csvInputDirectory:'/fixture'});
  assert.equal(f.gateway.store.get(ownerKey(p),id).executionMode,'capability');
  assert.equal(registry.forJob(j,ownerKey(p)).definition.id,'data.quality.audit.simulated');
  const tasks=new TaskService(f.gateway.store,{registry,coordinator:true});const args={action:'confirm_simulated_payment',quoteId:j.pilot!.quote.id,quoteDigest:j.pilot!.quoteDigest,requestId:'legacy-approve'};
  tasks.authorize(p,id,args);tasks.authorize(p,id,{requestId:args.requestId,quoteDigest:args.quoteDigest,quoteId:args.quoteId,action:args.action});
  const done=await f.wait(id,'completed');assert.equal(done.pilot!.acceptance,'accepted');
 }finally{await f.close();}
});
