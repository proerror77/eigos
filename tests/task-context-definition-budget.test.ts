// Synthetic providers and reasoning; no business operation is submitted. The
// oversized metadata comes from the real current six-domain registry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { domainCapability } from '../packages/capabilities/domain-service.js';
import { domainNames } from '../packages/ontology/service-domains.js';
import { OntologyPlanningSession } from '../packages/coordinator/planning-session.js';
import { digest } from '../packages/core/delegation.js';
import { domainProvider } from './fixtures/service-domains.js';
import { backend, owner, reasoner, interpretation, evidence, proposal, acknowledgeReads } from './backend-fixture.js';
import type { TaskContextPayload } from '../packages/coordinator/task-context.js';

test('Large fixed-adapter contexts defer schemas while retaining exact vehicle facts and recovery instructions', async t => {
  const sources = domainNames.map(name => domainProvider(name)), source = sources.find(value => value.provider.domain === 'vehicle')!;
  const capability = domainCapability('vehicle'), catalog = createExecutionCatalog({domainSandboxProviders:sources.map(value=>value.provider)});
  const model = reasoner(request => ({...interpretation(request,capability.ref.id,source.parameters),capabilityRef:capability.ref}));
  let planning: TaskContextPayload | undefined;
  model.plan = async (context,_signal,access) => {
    const reply=access.session.call('read_task_context',{}) as {data:TaskContextPayload};assert(reply.data);
    planning=reply.data;
    assert.equal(planning.request.originalGoal,context.request.originalGoal);
    assert.deepEqual(planning.request.messages,context.request.messages);
    assert.deepEqual(planning.request.requirements,context.request.requirements);
    assert.equal(digest(planning.resolution),digest(context.resolution),'No prepared candidate, source fact, condition or price may be truncated');
    assert(Buffer.byteLength(JSON.stringify(planning))<=180000);
    assert(Buffer.byteLength(JSON.stringify(planning.definitions.bundle.types))<51000);
    const deferred=planning.definitions.bundle.deferredTypes as string[];assert(deferred.length>0);
    t.diagnostic(JSON.stringify({contextBytes:Buffer.byteLength(JSON.stringify(planning)),definitionBytes:Buffer.byteLength(JSON.stringify(planning.definitions.bundle)),typeBytes:Buffer.byteLength(JSON.stringify(planning.definitions.bundle.types)),deferredTypes:deferred.length}));
    const actions=planning.definitions.bundle.actions as {id:string;inputSchema?:object;read?:{inputSchema:object};operation?:{inputSchema:object};inputs:object;submissionCriteria:string[]}[];assert(actions.length>0);
    for(const action of actions){const actual=access.session.graph.model.action(action.id);assert.deepEqual(action.inputSchema,actual.inputSchema);assert.deepEqual(action.read?.inputSchema,actual.read?.inputSchema);assert.deepEqual(action.operation?.inputSchema,actual.operation?.inputSchema);assert.deepEqual(action.inputs,actual.inputs);assert.deepEqual(action.submissionCriteria,actual.submissionCriteria);}
    const name=deferred[0]!;
    assert(!(planning.definitions.bundle.types as {id:string}[]).some(type=>type.id===name));
    const retrieved=access.session.call('describe_ontology',{search:name,limit:5,includeSchemas:true}) as {types:{id:string;properties:Record<string,{schema?:object}>}[]};
    const type=retrieved.types.find(type=>type.id===name);assert(type,'Deferred definition remains explicitly retrievable');
    assert(Object.values(type.properties).every(field=>field.schema),'The requested definition retains complete field schemas');
    const receipt=access.session.receipts().at(-1)!;assert.equal(receipt.tool,'describe_ontology');assert.equal(receipt.status,'ok');assert.equal(receipt.inputDigest,digest({search:name,limit:5,includeSchemas:true}));assert.equal(receipt.outputDigest,digest(retrieved));
    acknowledgeReads(access);return {decision:proposal(context),evidence:evidence()};
  };
  const b=backend(catalog,model,undefined,{allowSandbox:true});
  try {
    const submitted=b.submit({goal:'合成验证 vehicle',executionEnvironment:'sandbox'});
    const ready=await b.run();assert.equal(ready.state,'auth-required');assert(planning);
    assert(sources.every(item=>item.counters().submits===0),'Preparing metadata must never dispatch an external operation');
    const session=new OntologyPlanningSession(b.store.ontologyForJob(owner,ready),owner,ready.delegation!.request,[],()=>{},()=>{},'request',[],{taskContext:{purpose:'grounding'}});
    const recovery=session.call('read_task_context',{}) as {data:TaskContextPayload};assert(recovery.data,'Persisted resolution must remain readable during grounding recovery');
    assert.equal(recovery.data.request.id,submitted.id);assert.deepEqual(recovery.data.request.messages,planning.request.messages);
    assert.equal(digest(recovery.data.resolution),digest(planning.resolution));assert(Buffer.byteLength(JSON.stringify(recovery.data))<=180000);
  }finally{b.store.close();}
});
