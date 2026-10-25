import { LocalArtifactProgram } from '../packages/capabilities/local-artifact-agent.js';
// Aggregate/source/model values are synthetic. The first test uses the actual
// native Ontology MCP transport; it does not execute a provider or real model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { CatalogAgentProgram } from '../packages/capabilities/catalog-agent.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { OntologyPlanningSession } from '../packages/coordinator/planning-session.js';
import { reasonWithOntology } from '../packages/coordinator/reasoning-loop.js';
import { projectCapabilityCatalog, readCapabilityCatalog } from '../packages/ontology/capability-catalog.js';
import { sanitizeCapabilityVerificationHistory } from '../packages/ontology/capability-feedback.js';
import { scriptedMcpModel } from './fixtures/native-ontology-model.js';
import { securityFixture } from './fixtures/security.js';
import { evidence, owner, principal } from './backend-fixture.js';

function fixture() {
  const store = new JobStore(':memory:'), program = new CatalogAgentProgram([{id:'coffee',name:'Coffee',shopId:'gid://shopify/Shop/12',domain:'coffee.myshopify.com'}]);
  const catalog = new ExecutionCatalog([program.capability()], [], [], [], [program]), tasks = new TaskService(store, {catalog});
  const submit = () => tasks.submit(principal, {service:'eigos.delegate',goal:'Inspect the synthetic catalog context only',requestId:randomUUID()});
  return {store,program,summary:catalog.summaries(owner)[0]!,submit};
}
const history = (definitionDigest: string, extra = 0) => ({
  scope:'Task outcomes for this owner and exact binding version; unresolved tasks remain in the denominator',
  definitionDigest,sampleCount:2+extra,outcomeCounts:{satisfied:1,unknown:1+extra},taskStateCounts:{completed:1,canceled:1+extra},evidenceLevelCounts:{synthetic:1,unverified:1+extra},
  goalKindCounts:{PRIVATE_GOAL_KIND_MAY_CONTAIN_PII:2+extra},firstObservedAt:'2026-10-25T01:00:00Z',lastObservedAt:'2026-10-25T02:00:00Z',
  includesUnknownAndCanceled:true,availabilityProof:false,automaticPromotion:false,
});
const linked = (f: ReturnType<typeof fixture>, id: string) => f.store.ontology.related(owner,{type:'ServiceRequest',id},'capabilities',{remaining:1000})![0]!;

test('Native task context consumes bounded authorized feedback without exporting free-form goal labels', async () => {
  const f=fixture();
  try {
    const job=f.submit(), raw=history(f.program.configurationDigest);
    projectCapabilityCatalog(f.store.ontology,owner,job.id,[{...f.summary,verificationHistory:raw}]);
    const session=new OntologyPlanningSession(f.store.ontologyForJob(owner,job),owner,job.delegation!.request,[],()=>{},()=>{},'request',[],{taskContext:{purpose:'grounding'}});
    let turns=0;
    const model=scriptedMcpModel({runStructured:async prompt=>{
      turns++;const packet=JSON.parse(prompt.split('\n\n').at(-1)!);
      if(!packet.conversation.length)return {output:{kind:'read',calls:[{tool:'read_task_context',argumentsJson:'{}'}],finalJson:''},evidence:evidence()};
      const view=packet.conversation[0].result.data.capabilities[0].verificationHistory;
      assert.equal(view.sampleCount,2);assert.deepEqual(view.outcomeCounts,{satisfied:1,unknown:1});assert.equal(view.automaticPromotion,false);assert.equal(view.availabilityProof,false);
      assert(!JSON.stringify(packet).includes('PRIVATE_GOAL_KIND_MAY_CONTAIN_PII'));assert(!Object.hasOwn(view,'goalKindCounts'));assert(!Object.hasOwn(view,'taskId'));
      return {output:{kind:'final',calls:[],finalJson:'{"feedbackRead":true}'},evidence:evidence()};
    }});
    const result=await reasonWithOntology(model,'Inspect aggregate feedback only',{type:'object',properties:{feedbackRead:{type:'boolean'}},required:['feedbackRead'],additionalProperties:false},session,new AbortController().signal,()=>{});
    assert.equal(turns,2);assert.deepEqual(result.output,{feedbackRead:true});assert(result.evidence.ontologyMcp?.decisionSubmitted);
  }finally{f.store.close();}
});

test('Feedback snapshots are request-specific, preserve definition identity, and reject tampering or foreign task links', () => {
  const f=fixture();
  try {
    const a=f.submit(),b=f.submit();
    projectCapabilityCatalog(f.store.ontology,owner,a.id,[f.summary]);const reusable=linked(f,a.id);
    projectCapabilityCatalog(f.store.ontology,owner,b.id,[f.summary]);assert.equal(linked(f,b.id).ref.id,reusable.ref.id);
    const raw=history(f.program.configurationDigest);
    projectCapabilityCatalog(f.store.ontology,owner,a.id,[{...f.summary,verificationHistory:raw}]);const oldA=linked(f,a.id);
    assert.equal(oldA.properties.definitionDigest,reusable.properties.definitionDigest);assert.notEqual(oldA.ref.id,reusable.ref.id);
    projectCapabilityCatalog(f.store.ontology,owner,b.id,[{...f.summary,verificationHistory:raw}]);const oldB=linked(f,b.id);assert.notEqual(oldA.ref.id,oldB.ref.id);
    projectCapabilityCatalog(f.store.ontology,owner,a.id,[{...f.summary,verificationHistory:history(f.program.configurationDigest,1)}]);const updated=linked(f,a.id);
    assert.notEqual(updated.ref.id,oldA.ref.id);assert.equal((f.store.ontology.read(owner,oldA.ref).properties.verificationHistory as {sampleCount:number}).sampleCount,2);
    assert.equal(readCapabilityCatalog(f.store.ontology,owner,a.id)[0]!.verificationHistory!.sampleCount,3);
    f.store.ontology.ingest(owner,{objects:[{ref:updated.ref,expectedRevision:updated.revision,properties:{...updated.properties,verificationHistory:{...sanitizeCapabilityVerificationHistory(history(f.program.configurationDigest,1)),definitionDigest:'a'.repeat(64)}}}],links:[]},{kind:'task',id:a.id,observedAt:new Date().toISOString()});
    assert.throws(()=>readCapabilityCatalog(f.store.ontology,owner,a.id),/evidence changed/);
    f.store.ontology.ingest(owner,{objects:[],links:[{type:'CapabilityRequest',from:oldA.ref,to:{type:'ServiceRequest',id:b.id}}],removeLinks:[{type:'CapabilityRequest',from:oldB.ref,to:{type:'ServiceRequest',id:b.id}}]},{kind:'task',id:b.id,observedAt:new Date().toISOString()});
    assert.throws(()=>readCapabilityCatalog(f.store.ontology,owner,b.id),/another request/);
    assert.throws(()=>readCapabilityCatalog(f.store.ontology,'another-owner',b.id));
  }finally{f.store.close();}
});

test('Aggregate validation rejects private fields, unknown labels, dropped samples and promotion claims', () => {
  const raw=history('b'.repeat(64));
  assert.throws(()=>sanitizeCapabilityVerificationHistory({...raw,taskIds:['PRIVATE_TASK_ID']}));
  assert.throws(()=>sanitizeCapabilityVerificationHistory({...raw,outcomeCounts:{PRIVATE_ACCOUNT_NAME:2}}));
  assert.throws(()=>sanitizeCapabilityVerificationHistory({...raw,sampleCount:3}));
  assert.throws(()=>sanitizeCapabilityVerificationHistory({...raw,availabilityProof:true}));
  assert.throws(()=>sanitizeCapabilityVerificationHistory({...raw,automaticPromotion:true}));
});

test('Foundation task-only views cannot project owner-wide aggregate history', () => {
  const f=securityFixture();
  try {
    const program=new CatalogAgentProgram([{id:'coffee',name:'Coffee',shopId:'gid://shopify/Shop/12',domain:'coffee.myshopify.com'}]);
    const catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]);
    const summary=catalog.summaries(owner)[0]!;
    assert.throws(()=>projectCapabilityCatalog(f.jobs.ontology,f.owner,randomUUID(),[{...summary,verificationHistory:history(program.configurationDigest)}]),/Task-scoped authority does not grant cross-task feedback/);
  }finally{f.close();}
});

test('Semantic capability feedback resolves one actual runtime and omits ambiguous provider configurations', () => {
 const program=new LocalArtifactProgram('brief'),capability=program.capability();
 const catalog=new ExecutionCatalog([capability],[],[],[],[program]);
 assert.notDeepEqual(program.ref,capability.ref);
 assert.deepEqual(catalog.programForCapability(capability.ref,owner)?.ref,program.ref);
 const alternate=Object.create(program) as LocalArtifactProgram;
 Object.defineProperties(alternate,{ref:{value:{id:program.ref.id+'.alternate',version:program.ref.version}},configurationDigest:{value:'c'.repeat(64)},listingBinding:{value:undefined},permitted:{value:()=>true,configurable:true}});
 const ambiguous=new ExecutionCatalog([capability],[],[],[],[program,alternate]);
 assert.equal(ambiguous.programForCapability(capability.ref,owner),undefined);
 Object.defineProperty(alternate,'permitted',{value:()=>false});
 assert.deepEqual(ambiguous.programForCapability(capability.ref,owner)?.ref,program.ref);
});
