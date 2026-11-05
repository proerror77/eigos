// Synthetic identities/goals and real configured Document metadata. Actual
// PostgreSQL importer, claim, catalogue programs and native MCP read boundary;
// no model/provider call or business completion is performed by this suite.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {digest} from '../packages/core/delegation.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {PostgresNativePlanningSession} from '../packages/postgres/native-planning-session.js';
import {openOntologyMcp} from '../packages/coordinator/ontology-mcp.js';
import {postgresProjectCapabilityCatalog,type PostgresCapabilityCatalogEntry} from '../packages/postgres/capability-catalog.js';
import {withPostgresSourceProjection} from '../packages/postgres/source-projection.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
async function fixture(){
  const f=securityFixture(Date.now,{unified:true}),program=new DocumentAgentProgram(),channel='synthetic:catalogue-native';
  let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined,timer:ReturnType<typeof setInterval>|undefined,pending:Promise<void>|undefined,failure:unknown;
  try{
    const installation=f.installation('Synthetic Document catalogue',3600000),expiresAt=new Date(Date.now()+3600000).toISOString(),bindingId='program:document.compose';
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[program.ref.id],
      resources:[...new Set(['ServiceRequest',...Object.keys(taskContextFields),'DocumentTask','DocumentDraft'])].map(type=>({type,fields:Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only')})),
      sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,role:'Viewer',resource:{kind:'namespace',id:f.jobs.ontology.model.ref.id,version:f.jobs.ontology.model.ref.digest},expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setModelChannel(channel,{classification:'sensitive',markings:['member_private','personal_data'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:[...program.actionIds],outputTypes:['DocumentTask','DocumentDraft'],expiresAt},f.jobs.security.policies.revision());
    const principal={...f.principal,scopes:['tasks:write'],access:f.coordinator.authenticate({...f.principal,scopes:['tasks:write']},installation.token)};
    target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`;
    const task=await new PostgresTaskCommandService(t.database,t.policy).submit(principal,{requestId:randomUUID(),goal:'Create a Markdown document using only supplied information. No orders, payments or external actions.'});
    const worker=new PostgresWorkerStore(t.database,t.policy),claim=await worker.claim(['eigos.delegate'],30000);assert(claim);assert.equal(claim.job.id,task.id);
    timer=setInterval(()=>{if(!pending)pending=worker.renew(claim,30000).then(ok=>{assert(ok);}).catch(error=>{failure=error;}).finally(()=>{pending=undefined;});},5000);timer.unref();
    const options={policyDigest:t.policy,modelChannel:channel,inspectClaim:reference=>t.database.inspectClaim(reference,t.policy)} satisfies Parameters<typeof postgresProjectCapabilityCatalog>[3];
    const entries:PostgresCapabilityCatalogEntry[]=[{capability:program.capability(),program}];
    const project=(values=entries)=>t.run(client=>postgresProjectCapabilityCatalog(client,claim,values,options));
    const state=async()=>({grants:(await t.client.query(`SELECT id,state,revision,expires_at,body FROM ${q}.security_grants ORDER BY id`)).rows,
      origins:(await t.client.query(`SELECT * FROM ${q}.security_object_origins ORDER BY owner,type,object_id,object_revision`)).rows});
    const counts=async()=>(await t.client.query(`SELECT(SELECT count(*) FROM ${q}.ontology_objects WHERE type='RegisteredCapability')::int AS objects,(SELECT count(*) FROM ${q}.ontology_links WHERE type='CapabilityRequest')::int AS links,(SELECT count(*) FROM ${q}.security_bindings WHERE type='RegisteredCapability')::int AS bindings`)).rows[0];
    const parent=(await t.client.query(`SELECT id,body FROM ${q}.security_grants WHERE installation_id=$1 AND kind='agent_access'`,[installation.id])).rows[0],parentBody=JSON.parse(parent.body);
    return {f,t,q,program,channel,claim,worker,entries,options,project,state,counts,parent,parentBody,installation,bindingId,
      pauseHeartbeat:async()=>{if(timer)clearInterval(timer);if(pending)await pending;},
      close:async()=>{if(timer)clearInterval(timer);if(pending)await pending;await t.close();f.close();assert.equal(failure,undefined);}};
  }catch(error){if(timer)clearInterval(timer);if(pending)await pending;if(target)await target.close();f.close();throw error;}
}

test('real native grounding reads Document catalogue instances with reserved bindings and unchanged grants',local,async()=>{
  const x=await fixture();let mcp:Awaited<ReturnType<typeof openOntologyMcp>>|undefined,client:Client|undefined,transport:StreamableHTTPClientTransport|undefined,session:PostgresNativePlanningSession|undefined;
  try{
    assert.deepEqual(await x.counts(),{objects:0,links:0,bindings:0});const original=await x.state();
    // The source catalogue does not turn discovery into execution: a retained
    // task output scope may list metadata while its source requires renewal.
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='revoked' WHERE binding_id=$1`,[x.bindingId]);
    const page=await x.project();assert.deepEqual(page.items.map(item=>item.ref),[x.program.ref]);assert.equal(page.hasMore,false);
    const object=(await x.t.client.query(`SELECT id,revision,body FROM ${x.q}.ontology_objects WHERE type='RegisteredCapability'`)).rows[0],properties=JSON.parse(object.body).properties;
    assert.equal(object.id,`capability:${properties.definitionDigest}`);assert.deepEqual(properties.goalOutcomes,x.program.capability().goalOutcomes);
    const bound=JSON.parse((await x.t.client.query(`SELECT body FROM ${x.q}.security_bindings WHERE object_id=$1`,[object.id])).rows[0].body);
    assert.equal(bound.sourceBindingId,'task_context');assert.deepEqual(await x.state(),original);
    session=await PostgresNativePlanningSession.create(x.worker,x.claim,x.t.policy,x.channel,{taskContext:{purpose:'grounding'}});
    mcp=await openOntologyMcp(session,new AbortController().signal,undefined,{type:'object'},x.channel);client=new Client({name:'real-catalogue-native',version:'1'});
    transport=new StreamableHTTPClientTransport(new URL(mcp.connection.url),{requestInit:{headers:{Authorization:`Bearer ${mcp.connection.token}`}}});await client.connect(transport);
    const response=await client.callTool({name:'read_task_context',arguments:{}});assert(!response.isError,JSON.stringify(response));
    const wire=(response.structuredContent as {result:any}).result,capabilities=wire.result.data.capabilities;
    assert.deepEqual(capabilities,JSON.parse(JSON.stringify(page.items)));assert(session.lastReceipt()!.securityEnvelope!.lineage.some(snapshot=>snapshot.object.id===object.id));
    assert.deepEqual(properties.capabilityRef,capabilities[0]!.ref);assert.equal((capabilities[0]!.inputSchema as {properties:{format:{const:string}}}).properties.format.const,'markdown');
    await x.project();assert.deepEqual(await x.state(),original);assert.deepEqual((await x.t.client.query(`SELECT id,revision,body FROM ${x.q}.ontology_objects WHERE type='RegisteredCapability'`)).rows,[object]);
    await assert.rejects(x.t.run(c=>withPostgresSourceProjection(c,x.claim,{...x.options,programRef:x.program.ref,configurationDigest:x.program.configurationDigest,sourceBindingId:x.bindingId,action:'ComposeDocument'},async()=>{})),/SOURCE_NOT_AUTHORIZED/);
    await x.t.client.query(`UPDATE ${x.q}.security_grants SET state='revoked' WHERE id=$1`,[x.parent.id]);
    const denied=await fetch(mcp.connection.url,{method:'POST',headers:{Authorization:`Bearer ${mcp.connection.token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'read_task_context',arguments:{}}})});
    assert.equal(denied.status,403);assert.deepEqual(await denied.json(),{error:'session_authority_ended'});
  }finally{await client?.close();await transport?.close();await mcp?.close();session?.close();await x.close();}
});

test('catalogue filtering and role/field/configuration errors never manufacture task metadata authority',local,async()=>{
  const x=await fixture();try{
    const initial=await x.counts(),original=await x.state();
    const patch=async(body:unknown)=>x.t.client.query(`UPDATE ${x.q}.security_grants SET body=$1 WHERE id=$2`,[JSON.stringify(body),x.parent.id]);
    await patch({...x.parentBody,capabilityIds:['brief.prepare']});assert.deepEqual((await x.project()).items,[]);assert.deepEqual(await x.counts(),initial);await patch(x.parentBody);
    const {capability,program}=x.entries[0]!;
    await assert.rejects(x.project([{program,capability:{...capability,name:'Invented catalogue metadata'}}]),/differs from its configured program/);assert.deepEqual(await x.counts(),initial);
    await assert.rejects(x.project(JSON.parse(JSON.stringify(x.entries))),/Server-registered capability metadata/);assert.deepEqual(await x.counts(),initial);
    await patch({...x.parentBody,resources:x.parentBody.resources.map((resource:{type:string;fields:string[]})=>resource.type==='RegisteredCapability'?{...resource,fields:resource.fields.filter(field=>field!=='goalOutcomes')}:resource)});
    await assert.rejects(x.project(),/INSUFFICIENT_ACCESS/);assert.deepEqual(await x.counts(),initial);await patch(x.parentBody);
    await x.t.client.query(`UPDATE ${x.q}.ontology_namespaces SET owner=$1 WHERE id='eigos.business'`,[JSON.stringify(['https://synthetic-issuer.example','synthetic','another-owner'])]);
    await assert.rejects(x.project(),/belongs to another owner/);assert.deepEqual(await x.counts(),initial);await x.t.client.query(`UPDATE ${x.q}.ontology_namespaces SET owner=NULL WHERE id='eigos.business'`);
    await x.t.client.query(`DELETE FROM ${x.q}.security_roles WHERE subject_id=$1`,[x.installation.id]);await assert.rejects(x.project(),/AUTHORIZATION_REQUIRED|OUTPUT_NOT_ALLOWED|INSUFFICIENT_ACCESS/);assert.deepEqual(await x.counts(),initial);
    assert.deepEqual(await x.state(),original);
  }finally{await x.close();}
});

test('loss of the original claim after catalogue writes rolls back objects, links and reserved bindings',local,async()=>{
  const x=await fixture();let ended=false;
  try{
    const original=await x.counts();await x.pauseHeartbeat();
    await assert.rejects(x.t.database.run(async client=>{
      const query=client.query.bind(client);
      client.query=(async(...args:unknown[])=>{
        const result=await Reflect.apply(query,client,args),[statement,values]=args;
        if(!ended&&typeof statement==='string'&&statement.includes('INSERT INTO')&&statement.includes('ontology_objects')&&Array.isArray(values)&&values.includes('RegisteredCapability')){
          ended=true;await x.t.client.query(`UPDATE ${x.q}.work_claims SET expires_at=$1 WHERE job_id=$2 AND token=$3`,[Date.now()-1,x.claim.job.id,x.claim.token]);
        }
        return result;
      }) as typeof client.query;
      try{return await postgresProjectCapabilityCatalog(client,x.claim,x.entries,x.options);}finally{client.query=query;}
    }),/ACCESS_REVOKED|POLICY_CHANGED|AUTHORIZATION_REQUIRED/);assert(ended);
    assert.deepEqual(await x.counts(),original);
  }finally{await x.close();}
});
