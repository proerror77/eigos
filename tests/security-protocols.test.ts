import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {securityGatewayFixture} from './fixtures/security-gateway.js';
import {ownerKey} from '../packages/core/domain.js';
import {didiFixture} from './fixtures/didi.js';
import {DidiAgentProgram} from '../packages/capabilities/didi/program.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {securityFixture} from './fixtures/security.js';
import {TaskService} from '../packages/core/tasks.js';
import {currentKernelImplementation} from '../packages/ontology/definition-store.js';
const businessModel=currentKernelImplementation();
import {securityDefaults} from '../packages/security/contracts.js';
import {bindPersonalSourceOwner} from '../packages/core/source-owner.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {securedDidiReasoner,runNativeDidiTask} from './fixtures/secured-didi.js';
import {Coordinator} from '../packages/coordinator/coordinator.js';
import {didiBusinessViewSchema} from '../packages/security/projections.js';

test('HTTP, MCP and A2A return the same sealed native goal observations for the original task',{timeout:300000},async t=>{
  // Field/authority semantics use a controlled clock. CI CPU scheduling must
  // not expire the fixture's Gateway eligibility lease mid-synchronous read.
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  let configured:DidiAgentProgram|undefined;
  const source=didiFixture({booking:true}),f=await securityGatewayFixture((store,p)=>{
    const program=new DidiAgentProgram(source.binding,{connector:source.connector});bindPersonalSourceOwner(program,ownerKey(p));
    configured=program;
    return new ExecutionCatalog([program.capability()],[],[],[],[program],undefined,store.security);
  }),a=f.install(),client=new Client({name:'goal-readback',version:'1'});
  try {
    assert(configured);const program=configured,store=f.gateway.store,owner=ownerKey(f.p),policy=store.security.policies;
    const profile=f.gateway.catalog.securityProfiles(owner)[0]!,until=new Date(Date.now()+3600000).toISOString(),channels=['agent_response','registered_model'];
    const resources=[...new Set(['ServiceRequest',...profile.outputTypes,...Object.keys(taskContextFields)])].map(type=>({type,fields:Object.keys(policy.fields(type)).filter(field=>policy.fieldPolicy(type,field)!=='internal_only')}));
    f.gateway.security!.approveAgentGrant(f.member.id,{installationId:a.id,capabilityIds:[program.ref.id],resources,sourceBindingIds:[profile.bindingId],channels,expiresAt:until});
    policy.setRole({subjectKind:'installation',subjectId:a.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',executeActions:program.actionIds,invokeFunctions:policy.model.definitionSnapshot().functions.map(fn=>fn.id),expiresAt:until},policy.revision());
    const markings=['member_private','personal_data','precise_location','financial','account_private'];
    policy.setRecipient(a.id,{classification:'sensitive',markings,channels,expiresAt:until},policy.revision());
    policy.setModelChannel('synthetic-didi',{classification:'sensitive',markings,expiresAt:until},policy.revision());
    policy.setSource(owner,{installationId:a.id,bindingId:profile.bindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:program.actionIds,outputTypes:profile.outputTypes,expiresAt:until},policy.revision());
    const headers={authorization:`Bearer ${a.token}`};
    await client.connect(new StreamableHTTPClientTransport(new URL(f.base+'/mcp'),{requestInit:{headers}}));
    const created=await f.post('/tasks',{service:'eigos.delegate',requestId:randomUUID(),goal:'查询北京西站到西二旗地铁站的预估车费，不叫车、不付款',executionEnvironment:'sandbox'},headers),id=created.value.id as string;
    assert.equal(created.status,200);
    const {reasoner}=securedDidiReasoner(program,'native-goal',{dataflow:true}),coordinator=new Coordinator(store,reasoner,f.gateway.catalog,{allowSandbox:true});
    await runNativeDidiTask(store,coordinator,owner,id,t.signal,()=>t.mock.timers.tick(20));
    const done=store.get(owner,id);assert.equal(done.state,'completed',JSON.stringify({state:done.state,error:done.error,recovery:done.delegation?.recovery,feedback:done.delegation?.agent?.feedback,intents:store.intents(owner,id).map(intent=>({state:intent.state,result:intent.lastResult?.message}))}));assert.equal(done.delegation!.agent!.programRef.id,'eigos.goal');
    assert.equal(done.runs!.length,4,JSON.stringify({expected:'Grounding, independent goal review, context preparation and one model-selected read graph',runs:done.runs!.map(run=>run.purpose),feedback:done.delegation!.agent!.feedback,plans:done.delegation!.agent!.plans.map(plan=>({steps:plan.steps.map(step=>step.action),planned:!!plan.modelDecision?.plannedGoalCompletion})),events:done.delegation!.events}));
    assert.equal(done.runs!.filter(run=>run.purpose==='goal_coverage').length,1);
    assert.equal(done.delegation!.agent!.completion!.mode,'planned');
    assert(done.delegation!.agent!.completion!.ontologyPlanning.reads.every(read=>read.origin==='worker_context'));
    assert.deepEqual(source.calls.filter(call=>call.name).map(call=>call.name),['maps_textsearch','maps_textsearch','taxi_estimate']);
    const queried=await f.post('/ontology/query',{version:2,taskId:id,query:{type:'RideEstimateObservation'}},headers);assert.equal(queried.status,200);
    const expected=didiBusinessViewSchema.parse(queried.value.items[0].properties.observedData);assert.equal(expected.data.kind,'estimate');
    const http=await fetch(f.base+'/tasks/'+id,{headers}).then(r=>r.json());
    const mcp=await client.callTool({name:'get_task',arguments:{taskId:id}});assert(!mcp.isError);
    const rpc=await f.post('/a2a',{jsonrpc:'2.0',id:randomUUID(),method:'GetTask',params:{id}},headers);assert.equal(rpc.status,200);
    const native=(mcp.structuredContent as {result:{artifact:{data:unknown}}}).result.artifact.data;
    const a2a=rpc.value.result.artifacts[0].parts[0].data;
    assert.deepEqual(native,http.artifact.data);assert.deepEqual(a2a,http.artifact.data);
    for(const data of [http.artifact.data,native,a2a] as {result:{observations:{properties:{observedData:unknown}}[]}}[]) {
      const actual=didiBusinessViewSchema.parse(data.result.observations[0]!.properties.observedData);assert.deepEqual(actual,expected);
      assert.equal(actual.data.kind,'estimate');assert(actual.data.kind==='estimate');
      assert.equal(actual.data.items[0]!.productName,'快车');assert.equal(actual.data.items[0]!.estimatedMoney?.currency,'CNY');assert.equal(actual.data.items[0]!.estimatedMoney?.minor,'7305');
      assert.equal(actual.observedAt,expected.observedAt);assert.equal(actual.expiresAt,expected.expiresAt);assert.equal(Date.parse(actual.expiresAt)-Date.parse(actual.observedAt)<=300000,true);assert.equal(actual.noBusinessWrites,true);
    }
    for(const result of [http,mcp,rpc.value])for(const hidden of ['"snapshot":','"components":','PRIVATE_TRACE_NEVER_TO_MODEL','didiAnswer'])assert(!JSON.stringify(result).includes(hidden));
  }finally{await client.close();await f.close();source.close();}
});

test('foundation health becomes unavailable when its authorization publisher stops',async()=>{
  const f=await securityGatewayFixture();
  try {
    assert.equal((await fetch(`${f.base}/health`)).status,200);
    f.gateway.security!.close();
    const response=await fetch(`${f.base}/health`);
    assert.equal(response.status,503);assert.equal((await response.json()).status,'unavailable');
  }finally{await f.close();}
});

test('a long-lived installation issues a task grant from one timestamp even while the clock advances',()=>{
  let clock=Date.now();const f=securityFixture(()=>++clock);
  try {
    const a=f.installation('Long-lived installation'),expiresAt=new Date(clock+30*86400000).toISOString(),policy=f.jobs.security.policies;
    f.coordinator.approveAgentGrant(f.member.id,{installationId:a.id,capabilityIds:['brief.prepare'],resources:[{type:'ServiceRequest',fields:['requestId','displayTitle','originalGoal']}],sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt});
    policy.setRole({subjectKind:'installation',subjectId:a.id,resource:{kind:'namespace',id:businessModel.ref.id,version:businessModel.ref.digest},role:'Viewer',expiresAt},policy.revision());
    policy.setRecipient(a.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response','registered_model'],expiresAt},policy.revision());
    const p={...f.principal,access:f.coordinator.authenticate(f.principal,a.token)},tasks=new TaskService(f.jobs,{catalog:new ExecutionCatalog([],[],[])});
    const job=tasks.submit(p,{service:'eigos.delegate',requestId:randomUUID(),goal:'Synthetic long-lived installation task'});
    const grant=f.jobs.security.listGrants(f.owner).find(g=>g.kind==='task_data' && g.taskId===job.id)!;
    assert.equal(Date.parse(grant.expiresAt)-Date.parse(grant.issuedAt),securityDefaults.taskGrantMaxSeconds*1000);
    assert(f.jobs.security.workAuthority(f.owner,job.id));
  }finally{f.close();}
});

test('HTTP, MCP and A2A share task grants, safe metadata and current replay authorization',async()=>{
  const f=await securityGatewayFixture(),a=f.install(),b=f.install(),ca=new Client({name:'scoped-a',version:'1'}),cb=new Client({name:'scoped-b',version:'1'});
  try {
    for(const actor of [a,b]){assert.equal((await f.post('/members/security/grants',f.control(f.grantInput(actor.id)),f.memberHeaders)).status,200);f.qualify(actor.id);}
    const headers=(token:string)=>({authorization:`Bearer ${token}`});
    await ca.connect(new StreamableHTTPClientTransport(new URL(f.base+'/mcp'),{requestInit:{headers:headers(a.token)}}));
    await cb.connect(new StreamableHTTPClientTransport(new URL(f.base+'/mcp'),{requestInit:{headers:headers(b.token)}}));
    const tools=await ca.listTools(),schema=JSON.stringify(tools);
    assert.ok(schema.includes('check_access'));assert.ok(!schema.includes('registrationStatus'),'Tool discovery must not enumerate hidden functions');
    const paymentContract=await fetch(f.base+'/.well-known/eigos-pa-payment').then(r=>r.json());assert.equal(paymentContract.requestPath,'metadata.payment.request');assert.ok(!JSON.stringify(paymentContract.requestSchema).includes('ownerDigest'));assert.ok(!JSON.stringify(paymentContract.requestSchema).includes('configurationDigest'));
    const body={service:'eigos.delegate',requestId:'same-request',goal:'Private A goal'};
    const created=await f.post('/tasks',body,headers(a.token));assert.equal(created.status,200);assert.equal(created.value.view,'eigos.task.v2');
    const x=created.value.id as string;
    const raw=f.gateway.store.get(ownerKey(f.p),x);raw.state='paused';raw.question='UNSEALED_PRIVATE_QUESTION';raw.delegation!.events.push({at:new Date().toISOString(),event:'PRIVATE_LEDGER'});f.gateway.store.save(ownerKey(f.p),raw);
    const get=await ca.callTool({name:'get_task',arguments:{taskId:x}});assert.ok(!get.isError);assert.ok(!JSON.stringify(get).includes('PRIVATE_'));
    const query=await ca.callTool({name:'query_ontology',arguments:{version:2,taskId:x,query:{object:{type:'ServiceRequest',id:x}}}});assert.ok(!query.isError);
    assert.ok(JSON.stringify(query).includes('Private A goal'));assert.ok(!JSON.stringify(query).includes('datasetRevision'));assert.ok(!JSON.stringify(query).includes('scanned'));
    const other=await cb.callTool({name:'get_task',arguments:{taskId:x}});assert.equal(other.isError,true);
    const unknown=await ca.callTool({name:'evaluate_ontology',arguments:{version:2,taskId:x,call:{function:'HiddenFunction',object:{type:'ServiceRequest',id:x}}}});assert.equal(unknown.isError,true);assert.ok(!JSON.stringify(unknown).includes('bookingObservationStatus'));
    const rpc=(method:string,params:object,token=a.token)=>f.post('/a2a',{jsonrpc:'2.0',id:randomUUID(),method,params},headers(token));
    const task=await rpc('GetTask',{id:x});assert.equal(task.status,200);assert.equal(task.value.result.id,x);assert.equal(task.value.result.metadata.view,'eigos.task.v2');assert.equal(task.value.result.status.state,'TASK_STATE_WORKING');assert.equal(task.value.result.metadata.internalState,'paused');assert.ok(!JSON.stringify(task.value).includes('PRIVATE_'));assert.ok(!('delegation' in task.value.result.metadata));
    assert.ok((await rpc('GetTask',{id:x},b.token)).value.error);
    const byB=await cb.callTool({name:'submit_task',arguments:body});assert.ok(!byB.isError);const y=(byB.structuredContent as {result:{id:string}}).result.id;assert.notEqual(x,y);
    const listed=await rpc('ListTasks',{pageSize:10,includeArtifacts:true});assert.equal(listed.value.result.totalSize,1);assert.equal(listed.value.result.tasks[0].id,x);
    const ownList=await ca.callTool({name:'list_tasks',arguments:{limit:10,offset:0}});assert.equal((ownList.structuredContent as {result:{total:number}}).result.total,1);
    assert.equal((await f.post('/tasks',{...body,requestId:'spoof',ownerKey:ownerKey(f.p),installationId:b.id},headers(a.token))).status,400);
    const access=await ca.callTool({name:'check_access',arguments:{taskId:x,operation:'task.query',object:{type:'ServiceRequest',id:x}}});assert.ok(!access.isError);
    const grants=f.gateway.security!.grants(f.member.id),grant=grants.find(g=>g.kind==='task_data' && g.installationId===a.id)!;
    assert.equal((await f.post(`/members/security/grants/${grant.id}/revoke`,f.control({expectedRevision:grant.revision}),f.memberHeaders)).status,200);
    assert.equal((await f.post('/tasks',body,headers(a.token))).status,403);
    assert.equal((await ca.callTool({name:'get_task',arguments:{taskId:x}})).isError,true);
    assert.ok((await rpc('GetTask',{id:x})).value.error);
  }finally{await ca.close();await cb.close();await f.close();}
});

test('A2A write-only response and retry remain minimal, including terminal tasks',async()=>{
  const f=await securityGatewayFixture();try {
    const a=f.install({...f.p,scopes:['tasks:write']});await f.post('/members/security/grants',f.control(f.grantInput(a.id)),f.memberHeaders);
    const messageId=randomUUID(),body={jsonrpc:'2.0',id:'write-only',method:'SendMessage',params:{configuration:{returnImmediately:true},message:{messageId,role:'ROLE_USER',parts:[{text:'SECRET_SUBMISSION'}]}}};
    const first=await f.post('/a2a',body,{authorization:`Bearer ${a.token}`});assert.equal(first.status,200);assert.ok(first.value.result?.task?.id,JSON.stringify(first.value));
    assert.ok(!JSON.stringify(first.value).includes('SECRET_SUBMISSION'));assert.equal(first.value.result.task.metadata.outputStatus,'receipt_only');
    const id=first.value.result.task.id,raw=f.gateway.store.get(ownerKey(f.p),id);raw.state='completed';raw.artifact={id:randomUUID(),name:'SECRET_ARTIFACT',data:{goal:'SECRET_SUBMISSION',deliverable:'SECRET_RESULT',execution:'completed'}};f.gateway.store.save(ownerKey(f.p),raw);
    const replay=await f.post('/a2a',body,{authorization:`Bearer ${a.token}`});assert.equal(replay.value.result.task.id,id);assert.ok(!JSON.stringify(replay.value).includes('SECRET_'));assert.equal(replay.value.result.task.metadata.outputStatus,'receipt_only');
    assert.equal((await fetch(f.base+'/tasks/'+id,{headers:{authorization:`Bearer ${a.token}`}})).status,403);
  }finally{await f.close();}
});

test('member review fixes the exact grant server-side and cannot be replaced, replayed or silently widened',async()=>{
  const source=didiFixture();
  const f=await securityGatewayFixture((_store,p)=>{class ScopedProgram extends DidiAgentProgram{override permitted(owner:string){return owner===ownerKey(p);}}const program=new ScopedProgram(source.binding,{connector:source.connector});return new ExecutionCatalog([program.capability()],[],[],[],[program]);});
  try {
    const a=f.install(),profile=f.gateway.security!.sourceProfiles(f.member.id).profiles[0]!;
    const page=await fetch(f.base+'/members/permissions',{headers:{cookie:f.cookie}}).then(r=>r.text());assert.ok(page.includes('客户授权总览'));assert.ok(!page.includes(source.keyFile));
    const form=new URLSearchParams({_csrf:f.session.csrf,kind:'agent',installationId:a.id,programs:profile.programId,hours:'1'});
    form.append('fields','ServiceRequest.requestId');form.append('fields','ServiceRequest.originalGoal');form.append('channels','agent_response');
    const preview=await fetch(f.base+'/members/permissions/review',{method:'POST',headers:{...f.memberHeaders,'content-type':'application/x-www-form-urlencoded'},body:form});
    assert.equal(preview.status,200);const html=await preview.text(),id=html.match(/name="reviewId" value="([A-Za-z0-9_-]+)"/)?.[1];assert.ok(id);assert.ok(html.includes('完整字段上限'));assert.equal(f.gateway.security!.grants(f.member.id).length,0);
    const tampered=await f.post('/members/permissions/approve',f.control({reviewId:id,confirm:'approve',installationId:randomUUID()}),f.memberHeaders);assert.equal(tampered.status,400);
    assert.equal((await f.post('/members/permissions/approve',f.control({reviewId:id,confirm:'approve'}),f.memberHeaders)).status,303);
    const grant=f.gateway.security!.grants(f.member.id)[0]!;assert.equal(grant.kind,'agent_access');if(grant.kind==='agent_access')assert.deepEqual(grant.resources,[{type:'ServiceRequest',fields:['requestId','originalGoal']}]);
    assert.equal((await f.post('/members/permissions/approve',f.control({reviewId:id,confirm:'approve'}),f.memberHeaders)).status,409);
    assert.equal((await f.post('/members/security/sources',f.control({installationId:a.id,bindingId:profile.bindingId,programId:profile.programId,operations:['SearchDidiPlaces'],outputTypes:['DidiPlaceObservation'],expiresAt:grant.expiresAt,expectedRevision:f.gateway.store.security.policies.revision(),expectedAgentGrant:{id:grant.id,revision:grant.revision}}),f.memberHeaders)).status,200);
    const withSource=await fetch(f.base+'/members/permissions',{headers:{cookie:f.cookie}}).then(r=>r.text());assert.ok(withSource.includes('Synthetic Agent · 来源许可'));assert.ok(withSource.includes('审阅撤销范围'));
    const revoke=new URLSearchParams({_csrf:f.session.csrf,kind:'revoke_source',installationId:a.id,bindingId:profile.bindingId});
    const revokePage=await fetch(f.base+'/members/permissions/review',{method:'POST',headers:{...f.memberHeaders,'content-type':'application/x-www-form-urlencoded'},body:revoke}).then(r=>r.text());
    const revokeId=revokePage.match(/name="reviewId" value="([A-Za-z0-9_-]+)"/)?.[1];assert.ok(revokeId);assert.ok(revokePage.includes('收回这项服务授权'));assert.ok(revokePage.includes('查询出发地和目的地'));
    assert.equal((await f.post('/members/permissions/approve',f.control({reviewId:revokeId,confirm:'approve'}),f.memberHeaders)).status,303);
    assert.deepEqual(f.gateway.security!.managementView(f.member.id).sources,[]);
    const other=f.install(),next=new URLSearchParams(form);next.set('installationId',other.id);
    const pending=await fetch(f.base+'/members/permissions/review',{method:'POST',headers:{...f.memberHeaders,'content-type':'application/x-www-form-urlencoded'},body:next}).then(r=>r.text());const nextId=pending.match(/name="reviewId" value="([A-Za-z0-9_-]+)"/)?.[1];assert.ok(nextId);
    f.qualify(a.id); // A policy change invalidates a pending review.
    assert.equal((await f.post('/members/permissions/approve',f.control({reviewId:nextId,confirm:'approve'}),f.memberHeaders)).status,409);
    assert.equal(f.gateway.security!.grants(f.member.id).filter(g=>g.status==='active').length,1);
    assert.equal(source.calls.length,0,'Permission review never invokes the source');
  }finally{await f.close();source.close();}
});

test('member takeover binds the reviewed parent, stops on a live claim and creates explicit controller authority',async()=>{
  const f=await securityGatewayFixture();try {
    const a=f.install(),b=f.install();for(const actor of [a,b]){f.gateway.security!.approveAgentGrant(f.member.id,f.grantInput(actor.id));f.qualify(actor.id);}
    const created=await f.post('/tasks',{service:'eigos.delegate',requestId:'takeover',goal:'Synthetic takeover'},{authorization:`Bearer ${a.token}`});assert.equal(created.status,200);
    const parent=f.gateway.store.security.agentGrant(b.id),input={installationId:b.id,taskId:created.value.id,expectedRequestRevision:1,expectedAgentGrant:{id:parent.id,revision:parent.revision},takeover:true,inputs:[],programIds:[],purpose:'delegated_task',operations:['task.process','task.query','task.result.read'],channels:['agent_response'],expiresAt:parent.expiresAt};
    assert.equal((await f.post('/members/security/task-grants',f.control({...input,expectedAgentGrant:{id:randomUUID(),revision:1}}),f.memberHeaders)).status,403);
    const claim=f.gateway.store.claim(['eigos.delegate'],10000)!;assert.ok(claim);
    assert.equal((await f.post('/members/security/task-grants',f.control(input),f.memberHeaders)).status,409);
    f.gateway.store.release(claim);
    const review=await f.post('/members/permissions/review',f.control({kind:'task',installationId:b.id,taskId:created.value.id,channels:'agent_response',takeover:'yes',hours:1}),f.memberHeaders);assert.equal(review.status,200);
    const reviewId=String(review.value).match(/name="reviewId" value="([A-Za-z0-9_-]+)"/)?.[1];assert.ok(reviewId);
    assert.equal((await f.post('/members/permissions/approve',f.control({reviewId,confirm:'approve'}),f.memberHeaders)).status,303);
    const authority=f.gateway.store.security.workAuthority(ownerKey(f.p),created.value.id)!;assert.equal(authority.installationId,b.id);assert.equal(authority.authorityOrigin,'member_controller');assert.deepEqual(authority.submittedScopes,[]);
    assert.equal((await fetch(f.base+'/tasks/'+created.value.id,{headers:{authorization:`Bearer ${a.token}`}})).status,403);
    assert.equal((await fetch(f.base+'/tasks/'+created.value.id,{headers:{authorization:`Bearer ${b.token}`}})).status,200);
    const next=f.gateway.store.claim(['eigos.delegate'],10000)!;assert.equal(next.securityAuthorityId,authority.id);f.gateway.store.release(next);
  }finally{await f.close();}
});
