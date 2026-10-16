import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { Worker } from '../apps/worker/worker.js';
import { Coordinator, type Assessor } from '../packages/coordinator/coordinator.js';
import { createCapabilityRegistry } from '../packages/capabilities/registry.js';
import type { Assessment } from '../packages/core/delegation.js';
import { CSV_ONTOLOGY } from '../packages/ontology/csv-audit.js';
import { AuditPilot } from '../packages/capabilities/pilot/service.js';
import { SimulatedProvider, type Ledger } from '../packages/capabilities/pilot/providers.js';
import { type Fault } from '../packages/capabilities/pilot/contracts.js';
import { readConfig } from '../packages/core/config.js';
import { SCOPES, ownerKey, type Job } from '../packages/core/domain.js';
import { TaskService } from '../packages/core/tasks.js';
import { JobStore } from '../packages/core/store.js';
const exec = promisify(execFile);
const p = { issuer: 'local-development', tenant: 'local', subject: 'developer', clientId: 'test', scopes: [...SCOPES] };
const sample = 'record_id,email,amount_cny,event_date\nA,a@example.test,2,2026-10-15\nA,broken,-1,2026-02-30\nB,,3.00,2026-10-15\n';
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
function assessor(decide?: (job: Job) => Assessment): Assessor {
  return { assess: async job => ({ decision: decide ? decide(job) : job.messages.some(m => m.text.includes('sample.csv'))
    ? { decision: 'select_capability', capabilityId: 'data.quality.audit.simulated', message: 'Supported local CSV audit.', inputJson: JSON.stringify({fileName:'sample.csv', checks:[...CSV_ONTOLOGY.checks]}) }
    : { decision: 'ask_user', capabilityId: 'data.quality.audit.simulated', message: '请提供 CSV 文件名。', inputJson: '{}' }, evidence: {
      id: randomUUID(), runtime: 'ontology-test-fixture', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), outputSha256: 'fixture',
    } }) };
}
async function fixture(fault: Fault = 'none', planner = assessor()) {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-oag-')); writeFileSync(join(dir,'sample.csv'),sample);
  const server = createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const token = 'oag-test-token-'.repeat(4);
  const config = readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, PUBLIC_URL: base, PORT: String(address.port), DATABASE_PATH: ':memory:', EIGOS_COORDINATOR: 'codex', EIGOS_CSV_PILOT: 'true', EIGOS_CSV_INPUT_DIR: dir });
  const gateway = createApp(config); server.on('request',gateway.app);
  let clock = Date.now();
  const pilot = new AuditPilot(gateway.store,new SimulatedProvider(gateway.store,fault),()=>clock);
  const registry = createCapabilityRegistry(gateway.store,{csvInputDirectory:dir,pilot,csvTick:()=>pilot.tick()});
  const worker = new Worker(gateway.store, { coordinator: new Coordinator(gateway.store, planner, registry), maintenance:()=>registry.tick(), pollMs: 10 }); worker.start();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type':'application/json', 'A2A-Version':'1.0' };
  const rpc = async (method: string, params: object) => (await fetch(base+'/a2a',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})})).json();
  const send = (text: string, taskId?: string, immediate = true) => rpc('SendMessage',{configuration:{returnImmediately:immediate},message:{messageId:randomUUID(),role:'ROLE_USER',...(taskId?{taskId}:{}),parts:[{text}]}});
  const get = (id: string) => gateway.tasks.get(p,id);
  const wait = async (id: string, state: Job['state']) => {
    for(let i=0;i<300;i++){clock+=1000; const job=get(id); if(job.state===state)return job; await pause(10);}
    assert.fail(`Task did not reach ${state}: ${JSON.stringify(get(id))}`);
  };
  const approve = async (job: Job, change: object = {}) => fetch(base+`/tasks/${job.id}/authorize`,{method:'POST',headers,body:JSON.stringify({action:'confirm_simulated_payment',requestId:'approve-'+job.id,quoteId:job.pilot!.quote.id,quoteDigest:job.pilot!.quoteDigest,...change})});
  return {dir,base,token,gateway,worker,rpc,send,get,wait,approve,close:async()=>{await worker.close();await gateway.tasks.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await gateway.close();rmSync(dir,{recursive:true,force:true});}};
}

test('ontology grounded A2A intake → clarification → out-of-band authorization → independent acceptance; MCP shares readback', async()=>{
  const f=await fixture(); const mcp=new Client({name:'oag-test',version:'1'});
  try {
    const card=await(await fetch(f.base+'/.well-known/agent-card.json')).json();
    assert.equal(card.securitySchemes.eigos.httpAuthSecurityScheme.scheme, 'Bearer');
    assert.equal(card.securitySchemes.eigos.scheme, undefined);
    const skill=card.skills.find((s:{id:string})=>s.id==='eigos.delegate'); assert(skill.tags.includes('ontology')); assert(skill.description.includes('record_id'));
    const first=await f.send('用 EIGOS 做 CSV 数据质量审计'); const id=first.result.task.id;
    assert.equal(first.result.task.status.state,'TASK_STATE_SUBMITTED');
    const asked=await f.wait(id,'input-required'); assert.equal(asked.delegation?.phase,'clarifying');
    const reply = { configuration: { returnImmediately: true }, message: { messageId: 'stable-answer', taskId: id, role: 'ROLE_USER', parts: [{ text: 'sample.csv，按已注册的规则审计' }] } };
    await f.rpc('SendMessage', reply);
    const offered=await f.wait(id,'auth-required'); assert.equal(offered.delegation?.plan?.details?.inputSha256,offered.pilot?.quote.inputSha256);
    assert.equal(f.gateway.store.pilotRead(`payment:${offered.pilot!.orderId}`),undefined);
    assert(!(await f.rpc('SendMessage', reply)).error, 'reply retry must succeed even after the Worker reaches AUTH_REQUIRED');
    assert((await f.send('yes',id)).error); // Chat text is not an authorization receipt.
    assert.equal((await f.approve(offered,{quoteDigest:'0'.repeat(64)})).status,409);
    assert.equal((await f.approve(offered)).status,200); assert.equal((await f.approve(offered)).status,200);
    const done=await f.wait(id,'completed'); assert.equal(done.delegation!.phase,'accepted'); assert.equal(done.pilot!.acceptance,'accepted');
    assert(done.delegation!.events.some(e=>e.event==='plan_authorized')); assert.equal(done.runs!.length,2);
    assert.equal(f.gateway.store.pilotRead<Ledger>(`payment:${done.pilot!.orderId}`)!.charges,1);
    await mcp.connect(new StreamableHTTPClientTransport(new URL(f.base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${f.token}`}}}));
    const result=await mcp.callTool({name:'get_task',arguments:{taskId:id}}); assert(!result.isError);
    assert.deepEqual((result.structuredContent as {result:Job}).result.artifact,done.artifact);
    assert.throws(()=>f.gateway.tasks.get({...p,subject:'other'},id),/not found/);
    assert((await f.send('再改一下',id)).error);
  }finally{await mcp.close();await f.close();}
});

test('unsupported goal is rejected; invented ontology actions fail before input/payment',async()=>{
  for(const decision of [
    {decision:'unsupported',capabilityId:'',message:'Cannot buy coffee.',inputJson:'{}'},
    {decision:'select_capability',capabilityId:'data.quality.audit.simulated',message:'Invented rule',inputJson:JSON.stringify({fileName:'sample.csv',checks:['purchase_coffee']})},
  ] as Assessment[]){
    const f=await fixture('none',assessor(()=>decision));
    try{const sent=await f.send('买咖啡');const job=await f.wait(sent.result.task.id,decision.decision==='unsupported'?'rejected':'failed');assert.equal(job.pilot,undefined);assert.equal(job.artifact,undefined);}
    finally{await f.close();}
  }
});

test('plan and snapshot tampering are blocked by deterministic preconditions',async()=>{
  const f=await fixture();
  try{
    const sent=await f.send('审计 sample.csv');const offered=await f.wait(sent.result.task.id,'auth-required');
    const plan=offered.delegation!.plan!; plan.details!.checks=['invented'];f.gateway.store.save(ownerKey(p),offered);
    assert.equal((await f.approve(offered)).status,409);
    // A separate task demonstrates input evidence cannot be changed after a valid approval.
    const second=await f.send('审计 sample.csv');const ready=await f.wait(second.result.task.id,'auth-required');
    const snapshot=f.gateway.store.pilotRead<Record<string,unknown>>(`input:${ready.pilot!.orderId}`)!;snapshot.base64=Buffer.from('tampered').toString('base64');
    f.gateway.store.pilotWrite(`input:${ready.pilot!.orderId}`,snapshot);
    assert.equal((await f.approve(ready)).status,200);
    const failed=await f.wait(ready.id,'failed');assert.equal(failed.artifact,undefined);
    assert.equal(f.gateway.store.pilotRead(`payment:${ready.pilot!.orderId}`),undefined);
  }finally{await f.close();}
});

test('independent rejection leads to one redelivery or simulated refund, never false completion',async()=>{
  for(const fault of ['bad-once','bad-always'] as const){const f=await fixture(fault);
    try{const s=await f.send('审计 sample.csv');const ready=await f.wait(s.result.task.id,'auth-required');await f.approve(ready);
      if(fault==='bad-once'){const done=await f.wait(ready.id,'completed');assert.equal(done.pilot!.checks.length,2);assert(!done.pilot!.checks[0]!.accepted);assert(done.pilot!.checks[1]!.accepted);}
      else{await f.wait(ready.id,'failed');for(let i=0;i<30&&f.get(ready.id).pilot!.remediation!=='refunded';i++){await f.wait(ready.id,'failed');await pause(20);}const failed=f.get(ready.id);assert.equal(failed.pilot!.remediation,'refunded');assert.equal(failed.artifact,undefined);}
    }finally{await f.close();}
  }
});

test('blocking waits never return an active task on timeout or shutdown, including pilot work',async()=>{
  const store=new JobStore(':memory:');const tasks=new TaskService(store,{agent:true,waitTimeoutMs:15});
  try{const job=tasks.submit(p,{service:'agent.execute',goal:'test',requestId:'x'});
    await assert.rejects(tasks.wait(p,job.id),/Blocking task wait interrupted/);
    await tasks.close();await assert.rejects(tasks.wait(p,job.id),/Blocking task wait interrupted/);
    store.save(ownerKey(p),{...job,service:'data.quality.audit.simulated'});
    await assert.rejects(tasks.wait(p,job.id),/Blocking task wait interrupted/);
  }finally{store.close();}
});

test('A2A blocking send stops at a real interrupted state and rejects post-terminal continuation',async()=>{
  const f=await fixture();
  try{const r=await f.send('审计 CSV',undefined,false);assert.equal(r.result.task.status.state,'TASK_STATE_INPUT_REQUIRED');
    const proposal=await f.send('sample.csv',r.result.task.id,false);assert.equal(proposal.result.task.status.state,'TASK_STATE_AUTH_REQUIRED');
  }finally{await f.close();}
});

test('reusable Python client discovers, sends, resumes and authorizes without leaking its credential',async()=>{
  const f=await fixture();const script=resolve('integrations/grok/eigos-delegate/scripts/eigos_a2a.py');const profile=join(f.dir,'profile.json');const tokenFile=join(f.dir,'token');writeFileSync(tokenFile,f.token,{mode:0o600});chmodSync(tokenFile,0o600);
  const run=async(...args:string[])=>{const r=await exec('python3',[script,'--config',profile,...args],{env:{PATH:process.env.PATH,HOME:process.env.HOME},maxBuffer:1024*1024});assert(!r.stdout.includes(f.token));assert(!r.stderr.includes(f.token));return JSON.parse(r.stdout);};
  try{
    await run('configure','--card-url',f.base+'/.well-known/agent-card.json','--token-file',tokenFile,'--allow-loopback-http');assert(!readFileSync(profile,'utf8').includes(f.token));
    const input=join(f.dir,'goal.txt');writeFileSync(input,'审计 sample.csv');const sent=await run('send','--text-file',input,'--request-id','one');
    const again=await run('send','--text-file',input,'--request-id','one');assert.equal(again.id,sent.id);
    const ready=await f.wait(sent.id,'auth-required');const polled=await run('poll','--task-id',ready.id,'--seconds','0');assert.equal(polled.task.status.state,'TASK_STATE_AUTH_REQUIRED');
    const approval=join(f.dir,'approve.json');writeFileSync(approval,JSON.stringify({requestId:'approve',action:'confirm_simulated_payment',quoteId:ready.pilot!.quote.id,quoteDigest:ready.pilot!.quoteDigest}));
    await run('authorize','--task-id',ready.id,'--input-file',approval);await f.wait(ready.id,'completed');
    assert.equal((await run('get','--task-id',ready.id)).status.state,'TASK_STATE_COMPLETED');
    writeFileSync(input,'changed goal');await assert.rejects(run('send','--text-file',input,'--request-id','one'));
  }finally{await f.close();}
});
