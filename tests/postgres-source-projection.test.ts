// Actual PG source bindings and shared Document programs. All source/model
// values below are synthetic; this suite claims no external business result.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {digest} from '../packages/core/delegation.js';
import type {AgentExecutionState,AgentActionPlan} from '../packages/ontology/agent-actions.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {initializeDocumentProgram,prepareDocumentInvocationProgram,buildDocumentResult,projectDocumentProgram} from '../packages/capabilities/document-program.js';
import {graphRead,runGraphProgramAsync} from '../packages/ontology/graph-program.js';
import {templatePlanning} from '../packages/ontology/planning-contract.js';
import {PostgresTaskBindings} from '../packages/postgres/task-bindings.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {PostgresTaskReadService} from '../packages/postgres/task-read-service.js';
import {SecurityError,SecurityLineageLimitError} from '../packages/security/errors.js';
import {withPostgresSourceProjection,type PostgresSourceProjectionOptions,type PostgresSourceProjectionGraph} from '../packages/postgres/source-projection.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';
import {evidence} from './backend-fixture.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
async function fixture(){
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined,timer:ReturnType<typeof setInterval>|undefined,heartbeat:Promise<void>|undefined,failure:unknown;
  try{
    const program=new DocumentAgentProgram(),installation=f.installation('Synthetic source projection',3600000),expiry=new Date(Date.now()+3600000).toISOString(),bindingId='synthetic-doc-source';
    const fields=(type:string)=>Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only');
    const types=['ServiceRequest','DocumentTask','DocumentDraft','Place','SourceReceipt'];
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[program.ref.id],resources:types.map(type=>({type,fields:fields(type)})),sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt:expiry});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,role:'Viewer',resource:{kind:'namespace',id:f.jobs.ontology.model.ref.id,version:f.jobs.ontology.model.ref.digest},executeActions:['ComposeDocument'],expiresAt:expiry},f.jobs.security.policies.revision());
    const markings=['member_private','personal_data','precise_location','financial','account_private'] as const;
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:[...markings],channels:['agent_response'],expiresAt:expiry},f.jobs.security.policies.revision());
    f.jobs.security.policies.setModelChannel('synthetic:source-projection',{classification:'sensitive',markings:[...markings],expiresAt:expiry},f.jobs.security.policies.revision());
    f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:['ComposeDocument'],outputTypes:types.filter(type=>type!=='ServiceRequest'),expiresAt:expiry},f.jobs.security.policies.revision());
    const original=f.task(installation.id);f.jobs.security.revokeGrant(f.owner,original.grant.id,original.grant.revision);
    const grant=f.jobs.security.issueTaskGrant({...original.grant,id:randomUUID(),operations:['task.process','task.query','task.result.read'],channels:['agent_response','registered_model'],outputs:types.filter(type=>type!=='ServiceRequest').map(type=>({type,fields:fields(type),programId:program.ref.id,programDigest:program.configurationDigest,sourceBindingId:bindingId}))});
    f.jobs.security.attachTaskAuthority({...original.authority,id:randomUUID(),dataGrant:{id:grant.id,revision:grant.revision}});
    const principal={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)};
    target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`,worker=new PostgresWorkerStore(t.database,t.policy),claim=await worker.claim(['eigos.delegate'],30000);assert(claim);
    timer=setInterval(()=>{if(!heartbeat)heartbeat=worker.renew(claim,30000).then(ok=>{assert(ok);}).catch(error=>{failure=error;}).finally(()=>{heartbeat=undefined;});},5000);timer.unref();
    const options:PostgresSourceProjectionOptions={policyDigest:t.policy,modelChannel:'synthetic:source-projection',programRef:program.ref,configurationDigest:program.configurationDigest,sourceBindingId:bindingId,action:'ComposeDocument',inspectClaim:c=>t.database.inspectClaim(c,t.policy)};
    const run=<T>(action:(graph:PostgresSourceProjectionGraph)=>Promise<T>,changes:Partial<PostgresSourceProjectionOptions>={})=>t.run(c=>withPostgresSourceProjection(c,claim,{...options,...changes},action));
    const initialize=()=>run(graph=>runGraphProgramAsync(graph,initializeDocumentProgram(program,f.owner,graph.request,{format:'markdown'})));
    const counts=async()=>(await t.client.query(`SELECT(SELECT count(*) FROM ${q}.ontology_objects)::int AS objects,(SELECT count(*) FROM ${q}.ontology_links)::int AS links,(SELECT count(*) FROM ${q}.security_bindings)::int AS bindings,(SELECT count(*) FROM ${q}.security_object_origins)::int AS origins,(SELECT count(*) FROM ${q}.ontology_object_versions)::int AS versions`)).rows[0];
    return {f,t,q,claim,worker,program,grant,principal,installation,bindingId,options,run,initialize,counts,pauseHeartbeat:async()=>{if(timer)clearInterval(timer);if(heartbeat)await heartbeat;},close:async()=>{if(timer)clearInterval(timer);if(heartbeat)await heartbeat;await t.close();f.close();assert.equal(failure,undefined);}};
  }catch(error){if(timer)clearInterval(timer);if(heartbeat)await heartbeat;if(target)await target.close();f.close();throw error;}
}

async function seedSharedSourceEdge(x:Awaited<ReturnType<typeof fixture>>){
  const place={type:'Place',id:randomUUID()},receipt={type:'SourceReceipt',id:randomUUID()},at=new Date().toISOString(),properties={placeId:place.id,displayTitle:'Synthetic shared place',name:'Shared independently authorized endpoint'},edge={type:'PlaceEvidence',from:place,to:receipt},source={kind:'synthetic' as const,id:'synthetic-shared-link',observedAt:at};
  await x.run(graph=>graph.ingest(x.f.owner,{objects:[{ref:place,properties},{ref:receipt,properties:{receiptId:receipt.id,displayTitle:'Synthetic shared receipt',sourceIdentity:'synthetic-source',sourceEventId:receipt.id,observedAt:at,evidenceLevel:'synthetic',scope:'public_locations',contentDigest:digest(properties),subjects:[{object:place,digest:digest(properties),linksDigest:digest([])}],safeSummary:'Synthetic link validation fixture'}}],links:[edge]},source));
  return {place,receipt,edge,source};
}

test('source link validation reads shared ancestry once instead of once per duplicate edge',local,async t=>{
  const x=await fixture();try{
    const seeded=await seedSharedSourceEdge(x),query=x.t.client.query;let bindingReads=0;
    const spy=t.mock.method(x.t.client,'query',function(this:typeof x.t.client,...args:unknown[]){
      const text=typeof args[0]==='string'?args[0]:undefined;if(text?.includes('.security_bindings')&&/^\s*(SELECT|WITH)\b/.test(text))bindingReads++;return Reflect.apply(query,this,args);
    });
    try{
      await x.run(graph=>graph.ingest(x.f.owner,{objects:[],links:[seeded.edge]},seeded.source));const single=bindingReads;bindingReads=0;
      await x.run(graph=>graph.ingest(x.f.owner,{objects:[],links:Array.from({length:32},()=>structuredClone(seeded.edge))},seeded.source));assert(single>0);assert(bindingReads<=single+4,`Shared endpoint binding reads grew from ${single} to ${bindingReads}`);
    }finally{spy.mock.restore();}
    assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.ontology_links WHERE type=$1 AND from_id=$2`,[seeded.edge.type,seeded.place.id])).rows[0].n),1);
  }finally{await x.close();}
});

test('a source frame rechecks tightened current labels after its own writes and atomically rolls back both ingests',local,async()=>{
  const x=await fixture();try{
    const seeded=await seedSharedSourceEdge(x),before=await x.counts(),first={type:'Place',id:randomUUID()},second={type:'Place',id:randomUUID()};
    await assert.rejects(x.t.run(client=>withPostgresSourceProjection(client,x.claim,x.options,async graph=>{
      const batch=(ref:typeof first)=>({objects:[{ref,properties:{placeId:ref.id,displayTitle:'Synthetic later endpoint',name:'Must not survive failed authorization'}}],links:[{type:'PlaceEvidence',from:ref,to:seeded.receipt}]});
      await graph.ingest(x.f.owner,batch(first),seeded.source);
      await client.query(`INSERT INTO ${x.q}.security_labels(owner,type,object_id,field,body) VALUES($1,'SourceReceipt',$2,'*',$3) ON CONFLICT(owner,type,object_id,field) DO UPDATE SET body=excluded.body`,[x.f.owner,seeded.receipt.id,JSON.stringify({classification:'internal',requiredMarkings:[],channels:['registered_model']})]);
      await graph.ingest(x.f.owner,batch(second),seeded.source);
    })),/AUTHORIZATION_REQUIRED|OUTPUT_NOT_ALLOWED|INSUFFICIENT_ACCESS/);
    assert.deepEqual(await x.counts(),before);assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.security_labels WHERE object_id=$1`,[seeded.receipt.id])).rows[0].n),0);assert.equal((await x.run(graph=>graph.read(x.f.owner,seeded.receipt))).ref.id,seeded.receipt.id);
  }finally{await x.close();}
});

test('mapper readonly reuse closes before its next write and label change in the same source frame',local,async()=>{
  const x=await fixture();try{
    const initialized=await x.initialize(),before=await x.counts(),original=await x.run(graph=>graph.read(x.f.owner,initialized.scope));
    await assert.rejects(x.t.run(client=>withPostgresSourceProjection(client,x.claim,x.options,async graph=>{
      const current=await graph.read(x.f.owner,initialized.scope);
      await graph.ingest(x.f.owner,{objects:[{ref:initialized.scope,expectedRevision:current.revision,properties:{...current.properties,displayTitle:'Synthetic revised title'}}],links:[]},current.source);
      const revised=await graph.read(x.f.owner,initialized.scope);
      assert.equal(revised.revision,current.revision+1);assert.equal(revised.properties.displayTitle,'Synthetic revised title');
      await client.query(`INSERT INTO ${x.q}.security_labels(owner,type,object_id,field,body) VALUES($1,$2,$3,'*',$4)
        ON CONFLICT(owner,type,object_id,field) DO UPDATE SET body=excluded.body`,[x.f.owner,initialized.scope.type,initialized.scope.id,JSON.stringify({classification:'internal',requiredMarkings:[],channels:['registered_model']})]);
      await graph.read(x.f.owner,initialized.scope);
    })),/AUTHORIZATION_REQUIRED|OUTPUT_NOT_ALLOWED|INSUFFICIENT_ACCESS/);
    assert.deepEqual(await x.counts(),before);
    assert.deepEqual(await x.run(graph=>graph.read(x.f.owner,initialized.scope)),original,'Rejected source frames roll back the earlier write as well');
  }finally{await x.close();}
});

test('only a readonly shared-lineage limit falls back to fully authenticating every original edge',local,async t=>{
  for(const mode of ['limit','denied'] as const)await t.test(mode,async context=>{
    const x=await fixture();try{
      const before=await x.counts(),query=x.t.client.query;let origins=0,injected=false,roleReadsAfterFault=0;
      const spy=context.mock.method(x.t.client,'query',function(this:typeof x.t.client,...args:unknown[]){
        const text=typeof args[0]==='string'?args[0]:'';if(text.includes('INSERT INTO')&&text.includes('.security_object_origins'))origins++;
        if(/^\s*SELECT\b/.test(text)&&text.includes('.security_roles')){
          if(injected)roleReadsAfterFault++;
          if(origins===2&&!injected){injected=true;throw mode==='limit'?new SecurityLineageLimitError():new SecurityError('AUTHORIZATION_REQUIRED');}
        }
        return Reflect.apply(query,this,args);
      });
      try{
        if(mode==='limit'){const seeded=await seedSharedSourceEdge(x);assert(roleReadsAfterFault>0,'Fallback must perform real current role checks');assert.equal((await x.run(graph=>graph.read(x.f.owner,seeded.place))).ref.id,seeded.place.id);}
        else{await assert.rejects(seedSharedSourceEdge(x),/AUTHORIZATION_REQUIRED/);assert.equal(roleReadsAfterFault,0,'A role denial must not be retried through fallback');assert.deepEqual(await x.counts(),before);}
        assert(injected,'The fault must occur in the readonly link pass after all origins are written');
      }finally{spy.mock.restore();}
    }finally{await x.close();}
  });
});

test('checked PostgreSQL Document initialization and projection create immediately readable source bindings',local,async()=>{
  const x=await fixture();try{
    const initialized=await x.initialize();let escaped:PostgresSourceProjectionGraph|undefined;
    const prepared=await x.run(async graph=>{
      escaped=graph;const input={scope:initialized.scope},body:Omit<AgentActionPlan,'digest'>={id:randomUUID(),version:'2',sequence:1,requestId:graph.request.id,requestRevision:graph.request.revision,programRef:x.program.ref,programDigest:x.program.configurationDigest,scope:initialized.scope,scopeDigest:'synthetic',reasoning:'Synthetic storage fixture',createdAt:new Date().toISOString(),ontologyPlanning:templatePlanning(graph.request,graph.model.ref),steps:[]};
      const state:AgentExecutionState={version:'1',programRef:x.program.ref,programDigest:x.program.configurationDigest,scope:initialized.scope,input:initialized.input,requestRevision:graph.request.revision,plans:[{...body,digest:digest(body)}],observations:[],feedback:[]};
      const ctx={graph,owner:x.f.owner,request:graph.request,state,intents:[],planId:body.id,intentId:randomUUID(),attemptId:randomUUID(),modelRunId:'synthetic-original-choice'};
      assert.equal((await graph.read(x.f.owner,initialized.scope)).properties.configurationDigest,x.program.configurationDigest);
      return {ctx:{...ctx,graph:undefined},input,invocation:await runGraphProgramAsync(graph,prepareDocumentInvocationProgram(x.program,ctx,'ComposeDocument',input,true))};
    });
    await assert.rejects(escaped!.read(x.f.owner,initialized.scope),/AUTHORIZATION_REQUIRED/);assert.throws(()=>escaped!.readPrivate(x.f.owner,initialized.scope),/AUTHORIZATION_REQUIRED/);
    const restriction=JSON.stringify({classification:'sensitive',requiredMarkings:['financial'],channels:['registered_model']});
    await x.t.client.query(`INSERT INTO ${x.q}.security_labels(owner,type,object_id,field,body) VALUES($1,'ServiceRequest',$2,'originalGoal',$3)`,[x.f.owner,x.claim.job.id,restriction]);
    const response={output:{decision:'complete' as const,message:'Synthetic model receipt',artifact:'# Synthetic Document'},evidence:evidence()},result=buildDocumentResult(prepared.invocation,response);
    const document=await x.run(graph=>runGraphProgramAsync(graph,projectDocumentProgram(x.program,{...prepared.ctx,graph},'ComposeDocument',prepared.input,result)));
    const read=await x.run(graph=>graph.read(x.f.owner,document));assert.equal((read.properties.snapshot as {modelRunId:string}).modelRunId,response.evidence.id);
    const rows=(await x.t.client.query(`SELECT body FROM ${x.q}.security_object_origins WHERE object_id=ANY($1::text[])`,[[initialized.scope.id,document.id]])).rows;assert.equal(rows.length,2);
    for(const row of rows){const origin=JSON.parse(row.body);assert.equal(origin.programId,x.program.ref.id);assert.equal(origin.sourceBindingId,x.bindingId);assert.equal(origin.inputEnvelope.submission.taskId,x.claim.job.id);assert(origin.inputEnvelope.requiredMarkings.includes('member_private'));assert.equal(origin.personalAsset,undefined);}
    const inherited=JSON.parse(rows.find(row=>JSON.parse(row.body).inputEnvelope.requiredMarkings.includes('financial'))!.body).inputEnvelope;
    assert.deepEqual(inherited.channels,['registered_model']);
    assert.equal((await new PostgresTaskReadService(x.t.database,x.t.policy).checkAccess(x.principal,{taskId:x.claim.job.id,operation:'task.query',object:document})).allowed,false,'projection cannot declassify model-only input for the PA');
    await x.t.run(async c=>{
      const binder=new PostgresTaskBindings(c);await assert.rejects(binder.bind(x.grant,document,['id','displayTitle'],x.bindingId),/SOURCE_NOT_AUTHORIZED/);
      await assert.rejects(Reflect.apply(binder.bindSourceProjection,binder,[{}]),/SOURCE_NOT_AUTHORIZED/);
    });
  }finally{await x.close();}
});

test('PostgreSQL source projection rolls back graph/bindings/origins when source, grant, fields, links or lease are invalid',local,async()=>{
  const x=await fixture();try{
    const before=await x.counts();
    await assert.rejects(x.run(graph=>runGraphProgramAsync(graph,initializeDocumentProgram(x.program,x.f.owner,graph.request,{format:'markdown'})),{configurationDigest:'a'.repeat(64)}),/SOURCE_NOT_AUTHORIZED/);assert.deepEqual(await x.counts(),before);
    await assert.rejects(x.run(async graph=>{
      const initialized=await runGraphProgramAsync(graph,initializeDocumentProgram(x.program,x.f.owner,graph.request,{format:'markdown'}));
      const current=await graph.read(x.f.owner,initialized.scope);
      await graph.ingest(x.f.owner,{objects:[{ref:initialized.scope,properties:current.properties,expectedRevision:current.revision,observedFields:['notAField']}],links:[]},current.source);
    }),/SOURCE_NOT_AUTHORIZED|source observation/);assert.deepEqual(await x.counts(),before);
    await assert.rejects(x.run(async graph=>{
      const initialized=await runGraphProgramAsync(graph,initializeDocumentProgram(x.program,x.f.owner,graph.request,{format:'markdown'}));
      await graph.ingest(x.f.owner,{objects:[],links:[{type:'DocumentTaskRequest',from:initialized.scope,to:{type:'ServiceRequest',id:randomUUID()}}]},{kind:'task',id:x.claim.job.id,observedAt:new Date().toISOString()});
    }),/Unknown|missing|endpoint|unavailable|cardinality|not found/i);assert.deepEqual(await x.counts(),before);
    await assert.rejects(x.run(async graph=>{await graph.ingest(x.f.owner,{objects:[{ref:{type:'Person',id:'unapproved'},properties:{}}],links:[]},{kind:'user',id:'invented-personal-authority',observedAt:new Date().toISOString()});}),/SOURCE_NOT_AUTHORIZED/);assert.deepEqual(await x.counts(),before);
    let allowed=true;await assert.rejects(x.run(async graph=>{await runGraphProgramAsync(graph,initializeDocumentProgram(x.program,x.f.owner,graph.request,{format:'markdown'}));allowed=false;},{inspectClaim:claim=>allowed?x.t.database.inspectClaim(claim,x.t.policy):Promise.resolve(undefined)}),/ACCESS_REVOKED/);assert.deepEqual(await x.counts(),before);
    await assert.rejects(x.run(async graph=>{void graph.ingest(x.f.owner,{objects:[],links:[]},{kind:'task',id:x.claim.job.id,observedAt:new Date().toISOString()}).catch(()=>{});}),/must await every storage operation/);assert.deepEqual(await x.counts(),before);
    const data=JSON.stringify({...x.grant,outputs:[]});await x.t.client.query(`UPDATE ${x.q}.security_grants SET body=$1 WHERE id=$2`,[data,x.grant.id]);
    await assert.rejects(x.initialize(),/SOURCE_NOT_AUTHORIZED/);assert.deepEqual(await x.counts(),before);
  }finally{await x.close();}
});

test('fresh source bindings retain current input restrictions and source revocation ends readability',local,async()=>{
  const x=await fixture();try{
    const initialized=await x.initialize(),origin=(await x.t.client.query(`SELECT body FROM ${x.q}.security_object_origins WHERE object_id=$1`,[initialized.scope.id])).rows[0].body;
    await x.run(graph=>graph.read(x.f.owner,initialized.scope));
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='revoked' WHERE binding_id=$1`,[x.bindingId]);
    const service=new PostgresTaskReadService(x.t.database,x.t.policy);
    assert.equal((await service.checkAccess(x.principal,{taskId:x.claim.job.id,operation:'task.query',object:initialized.scope})).allowed,false);
    await assert.rejects(x.run(graph=>graph.read(x.f.owner,initialized.scope)),/SOURCE_NOT_AUTHORIZED|OUTPUT_NOT_ALLOWED/);
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='active' WHERE binding_id=$1`,[x.bindingId]);
    const row=JSON.parse(origin),[issuer,tenant]=JSON.parse(x.f.owner);row.inputEnvelope.ownerKey=JSON.stringify([issuer,tenant,'another-owner']);await x.t.client.query(`UPDATE ${x.q}.security_object_origins SET body=$1 WHERE object_id=$2`,[JSON.stringify(row),initialized.scope.id]);
    const before=await x.counts();await assert.rejects(x.run(async graph=>{const value=await graph.read(x.f.owner,initialized.scope);await graph.ingest(x.f.owner,{objects:[{ref:initialized.scope,properties:value.properties,expectedRevision:value.revision}],links:[]},value.source);}),/POLICY_CHANGED/);assert.deepEqual(await x.counts(),before);
  }finally{await x.close();}
});

test('same-source reobservation preserves revision/origin and replaces an unreadable historical link only through reviewed readback versions',local,async()=>{
  const x=await fixture();try{
    const place={type:'Place',id:randomUUID()},oldReceipt={type:'SourceReceipt',id:randomUUID()},newReceipt={type:'SourceReceipt',id:randomUUID()},properties={placeId:place.id,displayTitle:'Synthetic repeated place',name:'Unchanged independently observed fact'},at=new Date().toISOString();
    const receipt=(ref:typeof oldReceipt)=>({ref,properties:{receiptId:ref.id,displayTitle:'Synthetic repeated receipt',sourceIdentity:'synthetic-source',sourceEventId:ref.id,observedAt:at,evidenceLevel:'synthetic',scope:'public_locations',contentDigest:digest(properties),subjects:[{object:place,digest:digest(properties),linksDigest:digest([])}],safeSummary:'Synthetic source replacement only'}});
    const provenance={kind:'synthetic' as const,id:'synthetic-repeated-source',observedAt:at};
    await x.run(graph=>graph.ingest(x.f.owner,{objects:[{ref:place,properties},receipt(oldReceipt)],links:[{type:'PlaceEvidence',from:place,to:oldReceipt}]},provenance));
    const original=(await x.t.client.query(`SELECT body FROM ${x.q}.security_object_origins WHERE object_id=$1`,[place.id])).rows[0].body;
    const old=(await x.t.client.query(`SELECT body FROM ${x.q}.security_object_origins WHERE object_id=$1`,[oldReceipt.id])).rows[0].body,legacy={sourceBindingId:'synthetic-legacy-source',programDigest:'a'.repeat(64)};
    await x.t.client.query(`UPDATE ${x.q}.security_object_origins SET body=$1 WHERE object_id=$2`,[JSON.stringify({...JSON.parse(old),...legacy}),oldReceipt.id]);
    await x.t.client.query(`DELETE FROM ${x.q}.security_bindings WHERE object_id=$1`,[oldReceipt.id]);
    const batch={objects:[{ref:place,properties,expectedRevision:1,reuseIfUnchanged:true,observedFields:['placeId','displayTitle','name']},receipt(newReceipt)],links:[{type:'PlaceEvidence',from:place,to:newReceipt}],removeLinks:[{type:'PlaceEvidence',from:place,to:oldReceipt}]};
    const before=await x.counts();await assert.rejects(x.run(graph=>graph.ingest(x.f.owner,batch,{...provenance,observedAt:new Date().toISOString()})),/AUTHORIZATION_REQUIRED/);assert.deepEqual(await x.counts(),before);
    const source=(await x.t.client.query(`SELECT body FROM ${x.q}.security_sources WHERE binding_id=$1`,[x.bindingId])).rows[0].body;
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET body=$1 WHERE binding_id=$2`,[JSON.stringify({...JSON.parse(source),readbackVersions:[legacy]}),x.bindingId]);
    await x.run(graph=>graph.ingest(x.f.owner,batch,{...provenance,observedAt:new Date().toISOString()}));
    const result=await x.run(async graph=>({place:await graph.read(x.f.owner,place),receipts:await graph.related(x.f.owner,place,'sourceReceipts',{remaining:1000})}));
    assert.equal(result.place.revision,1);assert.deepEqual(result.receipts?.map(value=>value.ref),[newReceipt]);
    assert.equal((await x.t.client.query(`SELECT body FROM ${x.q}.security_object_origins WHERE object_id=$1`,[place.id])).rows[0].body,original);
    const binding=JSON.parse((await x.t.client.query(`SELECT body FROM ${x.q}.security_bindings WHERE object_id=$1`,[place.id])).rows[0].body);assert.equal(binding.sourceObservation.programDigest,x.program.configurationDigest);
    await assert.rejects(x.run(graph=>graph.read(x.f.owner,oldReceipt)),/AUTHORIZATION_REQUIRED|OUTPUT_NOT_ALLOWED/);
  }finally{await x.close();}
});

test('Worker graph commands commit original state and source bindings together and reject late or asynchronous callbacks',local,async()=>{
  const x=await fixture();try{
    const before=await x.counts(),{policyDigest:_policy,inspectClaim:_inspect,builder:_builder,...options}=x.options;
    await assert.rejects(x.worker.project(x.claim,options,function*({graph,request,job}){
      const initialized=yield* initializeDocumentProgram(x.program,x.f.owner,request,{format:'markdown'});
      job.question='Uncommitted original state';job.state='input-required';
      throw new Error('Synthetic failed graph command');
      return initialized;
    }),/Synthetic failed graph command/);
    assert.deepEqual(await x.counts(),before);
    assert.equal((await x.t.client.query(`SELECT state FROM ${x.q}.jobs WHERE id=$1`,[x.claim.job.id])).rows[0].state,'working');
    await assert.rejects(x.worker.project(x.claim,options,(() => Promise.resolve({})) as never),/synchronous graph program/);
    await assert.rejects(x.worker.checkpoint(x.claim,(async()=>{}) as never),/must not perform asynchronous work/);
    const changed={...x.claim,token:randomUUID()};
    assert.deepEqual(await x.worker.project(changed,options,function*(){throw new Error('Inactive command must not run');}),{applied:false});
    const result=await x.worker.project(x.claim,options,function*({request,job}){
      const initialized=yield* initializeDocumentProgram(x.program,x.f.owner,request,{format:'markdown'});
      job.delegation!.agent={version:'1',programRef:x.program.ref,programDigest:x.program.configurationDigest,scope:initialized.scope,input:initialized.input,requestRevision:request.revision,plans:[],observations:[],feedback:[]};
      job.updatedAt=new Date().toISOString();return initialized;
    });
    assert(result.applied);
    const state=(await x.t.client.query(`SELECT body FROM ${x.q}.jobs WHERE id=$1`,[x.claim.job.id])).rows[0];
    assert.deepEqual(JSON.parse(state.body).delegation.agent.scope,result.value.scope);
    assert.equal((await x.run(graph=>graph.read(x.f.owner,result.value.scope))).properties.configurationDigest,x.program.configurationDigest);
    const run={...evidence(),purpose:'document' as const};
    assert(await x.worker.recordActionRun(x.claim,run));
    const stored=JSON.parse((await x.t.client.query(`SELECT body FROM ${x.q}.jobs WHERE id=$1`,[x.claim.job.id])).rows[0].body);
    assert.deepEqual(stored.runs.find((value:{id:string})=>value.id===run.id),run);
    assert(await x.worker.recordActionRun(x.claim,run));
    await assert.rejects(x.worker.recordActionRun(x.claim,{...run,model:'Changed original receipt'}),/Original action model evidence changed|usage receipt/);
    await x.pauseHeartbeat();
    await x.t.client.query(`UPDATE ${x.q}.work_claims SET expires_at=$1 WHERE job_id=$2`,[Date.now()-1,x.claim.job.id]);
    assert.deepEqual(await x.worker.project(x.claim,options,function*(){throw new Error('Expired command must not run');}),{applied:false});
  }finally{await x.close();}
});


test('a graph command seals newly read model-only fields before returning any task output',local,async()=>{
  const x=await fixture();try{
    const place={type:'Place',id:randomUUID()},secret='SYNTHETIC_MODEL_ONLY_VALUE',receipt={type:'SourceReceipt',id:randomUUID()},at=new Date().toISOString();
    const properties={placeId:place.id,displayTitle:'Synthetic source',name:secret};
    await x.run(graph=>graph.ingest(x.f.owner,{objects:[{ref:place,properties},{ref:receipt,properties:{receiptId:receipt.id,displayTitle:'Synthetic receipt',sourceIdentity:'synthetic-source',sourceEventId:receipt.id,observedAt:at,evidenceLevel:'synthetic',scope:'public_locations',contentDigest:digest(properties),subjects:[{object:place,digest:digest(properties),linksDigest:digest([])}],safeSummary:'Synthetic source only'}}],links:[{type:'PlaceEvidence',from:place,to:receipt}]},{kind:'synthetic',id:'synthetic-projection-seal',observedAt:at}));
    await x.t.client.query(`INSERT INTO ${x.q}.security_labels(owner,type,object_id,field,body) VALUES($1,'Place',$2,'name',$3)`,[x.f.owner,place.id,JSON.stringify({classification:'sensitive',requiredMarkings:['financial'],channels:['registered_model']})]);
    const {policyDigest:_policy,inspectClaim:_inspect,builder:_builder,...options}=x.options;
    const result=await x.worker.project(x.claim,options,function*({job}){
      const object=yield* graphRead(x.f.owner,place);job.question=String(object.properties.name);job.updatedAt=new Date().toISOString();return true;
    });assert(result.applied);
    const seal=JSON.parse((await x.t.client.query(`SELECT body FROM ${x.q}.security_outputs WHERE owner=$1 AND task_id=$2 AND output_id='question'`,[x.f.owner,x.claim.job.id])).rows[0].body);
    assert.deepEqual(seal.channels,['registered_model']);assert(seal.requiredMarkings.includes('financial'));
    const view=await new PostgresTaskReadService(x.t.database,x.t.policy).get(x.principal,x.claim.job.id);
    assert.equal(view.question,undefined);assert.equal(view.outputStatus,'restricted');assert(!view.messages.some(message=>message.text===secret));
  }finally{await x.close();}
});
