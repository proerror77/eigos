import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {postgresDidiFixture} from './fixtures/postgres-didi.js';
import {PostgresTaskReadService} from '../packages/postgres/task-read-service.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {PostgresProjectionGraph} from '../packages/postgres/projection-graph.js';
import {withPostgresSourceProjection} from '../packages/postgres/source-projection.js';
import {verifyPostgresDidiSourceReceipt} from '../packages/postgres/didi-policy.js';
import {checkedRideEstimate} from '../packages/ontology/ride-estimate-projection.js';
import {digest} from '../packages/core/delegation.js';
import {SecurityError} from '../packages/security/errors.js';
import type {AgentActionResult} from '../packages/core/agent-program.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
async function reader(x:Awaited<ReturnType<typeof postgresDidiFixture>>){const p={...x.f.principal,access:await x.t.publisher.authenticate(x.f.principal,x.installation.token)};return {p,service:new PostgresTaskReadService(x.t.database,x.t.policy,x.t.kernel)};}

test('DiDi actual PG places flow verifies original journal and canonical facts while the live goal refuses synthetic evidence',local,async()=>{
  const x=await postgresDidiFixture();try{
    const original=await x.stored(),component=await x.prepare(),plan=await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'}),accepted=await x.execute(plan);assert(accepted.object);
    const intermediate=await x.stored();assert.equal(intermediate.id,original.id);assert.equal(intermediate.contextId,original.contextId);assert.equal(intermediate.delegation!.acceptance,undefined);assert.deepEqual(intermediate.delegation!.ontologyRelease,original.delegation!.ontologyRelease);assert.deepEqual(intermediate.delegation!.agent!.composition!.goal,x.goal);
    const {p,service}=await reader(x),view=await service.queryOntology(p,{version:2,taskId:x.claim.job.id,query:{object:accepted.object}}) as any;assert(view.items?.[0]?.properties.observedData);assert.equal(view.items[0].properties.snapshot,undefined,'Private source/attempt snapshot is never a model/Agent object field');
    const final=await x.complete(component,accepted.object),done=await x.stored(),assessment=done.delegation!.agent!.composition!.assessment!;assert.equal(final.accepted,false,JSON.stringify(assessment));assert.equal(done.id,original.id);assert.equal(done.state,'working');assert.equal(done.delegation!.acceptance,undefined);assert.equal(assessment.components[0]!.status,'verified');assert.equal(assessment.components[0]!.delivery?.evidenceLevel,'synthetic');assert.equal(assessment.criteria[0]!.result,'unknown');assert.equal(done.artifact!.data.execution,'partial');
    assert.deepEqual(x.source.calls.filter(call=>call.method==='tools/call').map(call=>call.name),['maps_textsearch']);
    const counts=(await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_observations WHERE applied=1`)).rows[0];assert.equal(Number(counts.n),1);
    const projected=(await x.t.client.query(`SELECT o.type,o.id FROM ${x.q}.ontology_objects o JOIN ${x.q}.security_object_origins s ON s.owner=o.owner AND s.type=o.type AND s.object_id=o.id AND s.object_revision=o.revision WHERE o.owner=$1 AND o.type IN('Place','Provider','SourceReceipt') AND s.body::jsonb->>'sourceBindingId'=$2`,[x.f.owner,x.bindingId])).rows;assert.equal(projected.filter(row=>row.type==='Place').length,2);assert.equal(projected.filter(row=>row.type==='Provider').length,1);assert.equal(projected.filter(row=>row.type==='SourceReceipt').length,1);
    const provider=projected.find(row=>row.type==='Provider')!;const publicProvider=await service.queryOntology(p,{version:2,taskId:x.claim.job.id,query:{object:{type:'Provider',id:provider.id}}}) as any;assert(publicProvider.items[0]);assert.equal(publicProvider.items[0].properties.verifiedIdentityRefs,undefined,'The mapper endpoint integrity field remains private');
  }finally{await x.close();}
});

test('DiDi canonical provider reuse refuses changed private identity metadata instead of widening model field permissions',local,async()=>{
  const x=await postgresDidiFixture();try{
    const component=await x.prepare();await x.execute(await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'}));
    await x.t.client.query(`UPDATE ${x.q}.ontology_objects SET body=jsonb_set(body::jsonb,'{properties,verifiedIdentityRefs}',$2::jsonb)::text WHERE owner=$1 AND type='Provider' AND body::jsonb#>'{properties,verifiedIdentityRefs}' IS NOT NULL`,[x.f.owner,JSON.stringify(['https://unapproved.example/source'])]);
    const plan=await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'});
    await assert.rejects(x.execution.execute(x.claim,plan.steps[0]!.intentId,new AbortController().signal),error=>error instanceof SecurityError&&error.reason==='SOURCE_NOT_AUTHORIZED');
    const job=await x.stored();assert.equal(job.delegation!.acceptance,undefined);assert.equal(job.delegation!.agent!.observations.length,1);assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_observations WHERE applied=1`)).rows[0].n),1);
  }finally{await x.close();}
});

test('actual DiDi journal verifies the separately completed PG source request without promoting a signed synthetic receipt to live goal completion',local,async()=>{
  const x=await postgresDidiFixture(true);try{
    const component=await x.prepare(),plan=await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'}),result=await x.execute(plan);assert(result.object);
    const row=(await x.t.client.query(`SELECT state,request,result FROM ${x.q}.security_relay_reads WHERE state='completed'`)).rows[0];assert(row);assert.equal(JSON.parse(row.request).context.intentId,plan.steps[0]!.intentId);assert.equal(JSON.parse(row.result).requestDigest,digest(JSON.parse(row.request)));
    assert.equal((await x.complete(component,result.object)).accepted,false);const done=await x.stored();assert.equal(done.state,'working');assert.equal(done.delegation!.acceptance,undefined,'Synthetic source transport never certifies a live account or real provider result');
    assert.deepEqual(x.source.calls.filter(call=>call.method==='tools/call').map(call=>call.name),['maps_textsearch']);
  }finally{await x.close();}
});

test('DiDi actual PG estimate chooses accepted source places through original reads, preserves uncertain fees and never invokes a business tool',local,async()=>{
  const x=await postgresDidiFixture();try{
    const component=await x.prepare({mode:'estimate',city:'北京市',origin:'北京西站',destination:'西二旗地铁站'}),origin=await x.execute(await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'origin',keywords:'北京西站'})),destination=await x.execute(await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'destination',keywords:'西二旗地铁站'}));assert(origin.object&&destination.object);
    const {p,service}=await reader(x),from=await service.queryOntology(p,{version:2,taskId:x.claim.job.id,query:{object:origin.object}}) as any,to=await service.queryOntology(p,{version:2,taskId:x.claim.job.id,query:{object:destination.object}}) as any;
    const a=from.items[0].properties.observedData.data.places.find((value:any)=>value.name==='北京西站'),b=to.items[0].properties.observedData.data.places.find((value:any)=>value.name==='西二旗地铁站');assert(a&&b);
    const result=await x.execute(await x.install(component,'EstimateDidiRide',{scope:component.scope,originObservation:origin.object,originPlaceId:a.id,destinationObservation:destination.object,destinationPlaceId:b.id}));assert(result.object);
    assert.equal((await x.complete(component,result.object)).accepted,false);const done=await x.stored();assert.equal(done.state,'working');assert.equal(done.delegation!.acceptance,undefined);
    assert.deepEqual(x.source.calls.filter(call=>call.method==='tools/call').map(call=>call.name),['maps_textsearch','maps_textsearch','taxi_estimate']);assert(!JSON.stringify(done.artifact).includes('PRIVATE_TRACE_NEVER_TO_MODEL'));
    const money=(await x.t.client.query(`SELECT body FROM ${x.q}.ontology_objects WHERE owner=$1 AND type='RideEstimate'`,[x.f.owner])).rows.map(row=>JSON.parse(row.body).properties);assert(money.length);assert(money.every(value=>value.feesComplete==='unknown'&&value.priceKind==='estimate'));
  }finally{await x.close();}
});

test('queued actual PG source transport rechecks the same current account before source authorization and denies a revoked admission without dispatch',local,async()=>{
  const x=await postgresDidiFixture(true,{deliverSource:false}),controller=new AbortController();let executing:Promise<unknown>|undefined;
  try{
    const component=await x.prepare(),plan=await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'});
    const rejected=x.execution.execute(x.claim,plan.steps[0]!.intentId,controller.signal).then(()=>false,()=>true);executing=rejected;
    let readId:string|undefined;const deadline=Date.now()+10000;
    while(!readId&&Date.now()<deadline){const rows=await x.t.client.query(`SELECT id FROM ${x.q}.security_relay_reads WHERE state='queued' LIMIT 2`);assert(rows.rows.length<=1);readId=rows.rows[0]?.id;if(!readId)await delay(10);}
    assert(readId,'The original journal must create an actual pending source request');await x.reads!.authorize(readId);
    await x.t.database.run(client=>client.query(`UPDATE ${x.q}.member_didi_source_admissions SET state='revoked' WHERE configuration_digest=$1`,[x.accountDigest]).then(()=>{}));
    await assert.rejects(x.reads!.authorize(readId));assert.equal(await rejected,true);assert.equal((await x.stored()).delegation!.acceptance,undefined);assert.equal(x.source.calls.length,0);
    const rows=await x.t.client.query(`SELECT state FROM ${x.q}.security_relay_reads WHERE id=$1`,[readId]);assert.equal(rows.rows[0]?.state,'revoked');assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_observations WHERE applied=1`)).rows[0].n),0);
  }finally{controller.abort();if(executing)await executing.catch(()=>{});await x.close();}
});

test('DiDi current member account revocation during a provider read retains the original audit but applies no facts or business completion',local,async()=>{
  const x=await postgresDidiFixture();try{
    const component=await x.prepare(),plan=await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'});let called=false;
    x.source.flags.before=async()=>{if(called)return;called=true;await x.t.database.run(client=>client.query(`UPDATE ${x.q}.member_didi_source_admissions SET state='revoked' WHERE configuration_digest=$1`,[x.accountDigest]).then(()=>{}));};
    await assert.rejects(x.execution.execute(x.claim,plan.steps[0]!.intentId,new AbortController().signal));assert(called);
    const job=await x.stored();assert.equal(job.id,x.claim.job.id);assert.equal(job.delegation!.acceptance,undefined);assert.equal(job.delegation!.agent!.observations.length,0);assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_observations WHERE applied=1`)).rows[0].n),0);
    assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.ontology_objects WHERE owner=$1 AND type IN('DidiPlaceObservation','Place','RideEstimate')`,[x.f.owner])).rows[0].n),0);
    assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_attempts`)).rows[0].n),1);assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_observations`)).rows[0].n),1,'The original read outcome is audited rather than replaced');
  }finally{await x.close();}
});

test('DiDi account descriptor/source revocation after observation prevents whole-goal acceptance and ordinary source callbacks cannot acquire canonical private reads',local,async()=>{
  const x=await postgresDidiFixture();try{
    const component=await x.prepare(),accepted=await x.execute(await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'}));assert(accepted.object);
    const original=x.descriptor();x.setDescriptor({...original,revision:original.revision+1});await assert.rejects(x.complete(component,accepted.object));assert.equal((await x.stored()).delegation!.acceptance,undefined);x.setDescriptor(original);
    await x.t.database.run(async client=>{
      await assert.rejects(withPostgresSourceProjection(client,x.claim,{...x.options,programRef:x.program.ref,configurationDigest:x.program.configurationDigest,sourceBindingId:x.bindingId,action:'SearchDidiPlaces'},graph=>graph.readPrivate(x.f.owner,{type:'Place',id:randomUUID()})),error=>error instanceof SecurityError&&error.reason==='AUTHORIZATION_REQUIRED');
    });
    await x.t.database.run(client=>client.query(`UPDATE ${x.q}.security_sources SET state='revoked' WHERE binding_id=$1`,[x.bindingId]).then(()=>{}));await assert.rejects(x.complete(component,accepted.object));assert.notEqual((await x.stored()).state,'completed');
  }finally{await x.close();}
});

test('a Worker-shaped live DiDi snapshot with a valid self-digest is not a completed provider transport receipt',local,async()=>{
  const x=await postgresDidiFixture();try{
    const component=await x.prepare(),plan=await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'}),applied=await x.execute(plan);assert(applied.object);
    await x.t.database.run(async client=>{
      const store=new PostgresTaskStorage(client,x.t.kernel),job=await store.get(x.f.owner,x.claim.job.id),intent=await store.intent(x.f.owner,plan.steps[0]!.intentId),attempt=JSON.parse((await client.query(`SELECT body FROM ${x.q}.action_attempts WHERE intent_id=$1`,[intent.id])).rows[0].body);
      const original=checkedRideEstimate(intent.lastVerifiedResult!.output!.source),{contentDigest:_digest,...body}=original,forged={...body,evidenceKind:'live_readonly' as const},snapshot={...forged,contentDigest:digest(forged)},response:AgentActionResult={value:snapshot,evidenceRefs:[snapshot.id]},result={...intent.lastVerifiedResult!,output:{source:snapshot},evidenceRefs:[snapshot.id]};
      const graph=await PostgresProjectionGraph.create(client,x.f.owner,job.delegation!.ontologyRelease!,x.t.kernel,{readOnly:true}),context={model:graph.model,graph,owner:x.f.owner,intents:await store.intents(x.f.owner,job.id),validUntil:Date.now()+30000,job,plan,step:plan.steps[0]!,intent,input:plan.steps[0]!.input,operation:'accept' as const,attempt};
      await assert.rejects(verifyPostgresDidiSourceReceipt(client,x.claim,context,attempt,response,result,{kind:'relay',peerId:'agent_'+'A'.repeat(43),authorityId:x.t.authority.id,gatewayOrigin:'https://primary.example',binding:x.source.binding}),error=>error instanceof SecurityError&&error.reason==='SOURCE_NOT_AUTHORIZED');
    });
  }finally{await x.close();}
});
