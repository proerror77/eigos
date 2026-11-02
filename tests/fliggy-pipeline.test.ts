import test from 'node:test';
import assert from 'node:assert/strict';
import { JobStore } from '../packages/core/store.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { FliggyProgram } from '../packages/capabilities/fliggy/program.js';
import { prepareFliggyProductPipeline } from '../packages/ontology/pipeline/fliggy-products.js';
import { packageInput as input, packageData } from './fixtures/fliggy.js';
import { digest } from '../packages/core/delegation.js';
import { backend,owner,interpretation,evidence,observeTaskContext,acknowledgeReads,syntheticGoalReview } from './backend-fixture.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';

test('existing Pipeline validates source SPUs and task evidence without fabricating package SKUs or duplicate identities',async()=>{
  const store=new JobStore(':memory:');let calls=0;
  const catalog=createExecutionCatalog({store,fliggy:{mode:'trial',evidenceKind:'fixture',connector:{search:async()=>{calls++;return{data:packageData,observedAt:new Date().toISOString()};}}}});
  const model:Reasoner={reviewGoal:syntheticGoalReview,
    ground:async(request,_caps,_signal,access)=>({decision:{...interpretation(observeTaskContext(access)??request,'fliggy.travel.search',input),capabilityRef:{id:'fliggy.travel.search',version:'1'}},evidence:evidence()}),
    plan:async()=>{throw Error('No legacy plan');},
    act:async(ctx,_signal,access)=>{
      observeTaskContext(access);access.session.call('describe_ontology',{actions:['SearchFliggyMarriottPackages']});access.session.call('query_ontology',{object:ctx.state.scope});
      const ref=ctx.state.observations[0];if(ref){access.session.call('query_ontology',{object:ref});access.session.call('evaluate_ontology',{function:'fliggySearchStatus',object:ref});}
      const decision={kind:ref?'complete' as const:'execute' as const,requestRevision:ctx.request.revision,message:'Read the source package candidates',steps:ref?[]:[{id:'search',action:'SearchFliggyMarriottPackages',argumentsJson:JSON.stringify({scope:ctx.state.scope}),dependsOn:[],inputRefs:[]}],completionJson:ref?JSON.stringify({observation:ref,rationale:'Partial source discovery only'}):''};
      acknowledgeReads(access);return{decision,evidence:{...evidence(),decisionDigest:digest(decision)}};
    }};
  const b=backend(catalog,model,store),program=catalog.agentProgram({id:'fliggy.travel.search',version:'1'},owner);
  assert(program instanceof FliggyProgram);
  async function run(){const submitted=b.submit({goal:'Discover synthetic hotel package products',executionEnvironment:'sandbox'});for(let i=0;i<10 && ['submitted','working'].includes(store.get(owner,submitted.id).state);i++)await b.run();const job=store.get(owner,submitted.id);assert.equal(job.state,'completed',JSON.stringify(job.delegation?.agent?.feedback));return job;}
  try{
    const first=await run(), namespace=store.definitions.namespace(), products=store.ontology.query(owner,{type:'TravelProduct'}).items;
    assert.equal(products.length,1);
    const options={model:store.ontology.model,program,serviceId:'synthetic.fliggy.products',source:{id:'synthetic.fliggy.schema',revision:'1',digest:'a'.repeat(64),reference:'urn:eigos:synthetic:fliggy-products',observedAt:new Date(Date.now()-1000).toISOString()},samples:products.map(p=>p.properties)};
    const intake=prepareFliggyProductPipeline(options);
    assert.equal(intake.mappings[0]!.objectType,'TravelProduct');assert.equal(intake.actions[0]!.requiredEvidence,'synthetic');
    assert.throws(()=>prepareFliggyProductPipeline({...options,samples:[{...products[0]!.properties,skuId:'invented-from-title'}]}),/Unreviewed|Unknown|schema/);
    let draft=store.definitions.createDraft(owner,namespace.id,'Synthetic Fliggy product mapping',true);
    draft=store.definitions.putPipeline(owner,draft.id,draft.revision,intake,true);
    const validated=store.definitions.validatePipeline(owner,draft.id,draft.revision,intake.serviceId,new Date(Date.now()+60000).toISOString(),true);
    assert.equal(validated.valid,true,JSON.stringify(validated));
    const candidate=store.definitions.pipelineDraft(owner,draft.id,draft.revision,intake.serviceId,true);
    const proof=store.definitions.pipeline.verifyTask(namespace.id,owner,candidate.ref,candidate.model,first,id=>store.intent(owner,id),new Date(Date.now()+60000).toISOString());
    assert.equal(proof.availabilityProof,false);assert.equal(proof.authorizationProof,false);
    const release=store.definitions.publish(owner,draft.id,draft.revision,true).release;
    store.definitions.activate(owner,release,namespace.generation,true);
    assert.equal(store.ontology.pipelineStatus(owner,program.ref,program.configurationDigest,'SearchFliggyMarriottPackages').status,'verified');
    await run();assert.equal(calls,2);
    assert.deepEqual(store.ontology.query(owner,{type:'TravelProduct'}).items.map(p=>p.ref),products.map(p=>p.ref));
    assert.equal(store.ontology.query(owner,{type:'ProductVariant'}).items.length,0);
    assert.equal(store.ontology.query(owner,{type:'RoomType'}).items.length,0);
  }finally{store.close();}
});
