// Real managed-data runtime with synthetic decisions/records, never a provider
// operation or a live model. Caller contracts remain distinct from model review.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JobStore } from '../packages/core/store.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { digest } from '../packages/core/delegation.js';
import { callerOutcomeProofSchema } from '../packages/ontology/caller-outcome-proof.js';
import { outcomeAssessmentRef } from '../packages/ontology/outcome-assessment-values.js';
import { publishManagedFixture } from './fixtures/dynamic-ontology.js';
import { backend, owner, principal } from './backend-fixture.js';
import type { ObjectRef } from '../packages/ontology/model.js';

function fixture() {
  const store=new JobStore(':memory:'),published=publishManagedFixture(store,owner);let modelCalls=0;
  const never=async()=>{modelCalls++;throw new Error('Typed caller action must not invoke a model');};
  const b=backend(createExecutionCatalog({store}),{ground:never,plan:never,act:never,reviewGoal:never},store);
  const complete=async(id:string)=>{
    const job=b.tasks.prepareOntologyAction(principal,{ontologyId:published.ontologyId,action:'CreateOfficeAsset',input:{id,label:`Synthetic ${id}`},requestId:randomUUID()});
    const authorization=job.delegation!.authorizationRequest!;assert(authorization.kind==='object_write');
    b.tasks.authorize(principal,job.id,{action:'approve_object_write',requestId:randomUUID(),planDigest:authorization.planDigest,objectWrite:authorization.objectWrite,expiresAt:new Date(Date.now()+60000).toISOString(),environment:'managed'});
    await b.run();const done=store.get(owner,job.id);assert.equal(done.state,'completed');
    const request=published.graph.read(owner,{type:'ServiceRequest',id:job.id}),assessment=published.graph.read(owner,request.properties.currentAssessment as ObjectRef);
    return {job:done,request,assessment,proof:callerOutcomeProofSchema.parse(assessment.properties.callerProof)};
  };
  const patch=(ref:ObjectRef,properties:Record<string,unknown>)=>{const row=published.graph.read(owner,ref);published.graph.ingest(owner,{objects:[{ref,expectedRevision:row.revision,properties}],links:[]},{kind:'task',id:'synthetic-audit-tamper',observedAt:new Date().toISOString()});};
  return {...published,store,complete,patch,modelCalls:()=>modelCalls};
}

test('Caller-managed completion has typed contract/readback coverage with no fabricated model review',async()=>{
 const f=fixture();try{
  const a=await f.complete('caller-a'),value=f.graph.evaluate(owner,{function:'taskOutcomeStatus',object:a.request.ref});
  assert.equal(f.modelCalls(),0);assert.equal(a.job.delegation!.goalCoverage,undefined);assert.equal(a.job.runs!.length,0);
  assert.equal(a.proof.envelopeDigest,digest(a.job.delegation!.callerAction));assert.equal(a.proof.completionDigest,digest(a.job.delegation!.agent!.callerCompletion));
  assert.equal(value.status,'known');assert.equal((value.value as any).status,'satisfied');assert.equal((value.value as any).goalCoverage,'caller_contract');
  assert.deepEqual((value.value as any).sourceReceiptRefs,[]);assert.equal((value.value as any).callerExecutionRefs.length,5);
  const intent=a.job.delegation!.agent!.plans[0]!.steps[0]!.intentId,attempt=f.store.attempts(owner,intent)[0]!;
  assert.equal(attempt.authorizationId,a.proof.execution.authorization.id);
  const authorization=f.graph.read(owner,a.proof.execution.authorization),originalClock=f.graph.now;
  Object.defineProperty(f.graph,'now',{value:()=>Date.parse(String(authorization.properties.expiresAt))+1000,configurable:true});
  try{
    assert.equal(f.graph.evaluate(owner,{function:'authorizationStatus',object:authorization.ref}).value,'expired');
    assert.equal((f.graph.evaluate(owner,{function:'taskOutcomeStatus',object:a.request.ref}).value as any).goalCoverage,'caller_contract');
    f.patch(authorization.ref,{...authorization.properties,revoked:true,revokedAt:new Date(Date.parse(attempt.startedAt)+1000).toISOString(),ledgerDigest:'f'.repeat(64)});
    assert.equal((f.graph.evaluate(owner,{function:'taskOutcomeStatus',object:a.request.ref}).value as any).goalCoverage,'caller_contract','Historical acceptance is not fresh authorization');
  }finally{Object.defineProperty(f.graph,'now',{value:originalClock,configurable:true});}
 }finally{f.store.close();}
});

test('Caller proof rejects changed hashes, effects, unverified results and altered authorization terms',async()=>{
 const f=fixture();try{
  const a=await f.complete('caller-b'),check=()=>f.graph.evaluate(owner,{function:'taskOutcomeStatus',object:a.request.ref});
  const artifact=f.graph.related(owner,a.assessment.ref,'acceptedArtifact',{remaining:1000})![0]!;
  const cases:[ObjectRef,(p:Record<string,unknown>)=>Record<string,unknown>][]=[
    [a.assessment.ref,p=>({...p,callerProof:{...a.proof,digest:'0'.repeat(64)}})],
    [artifact.ref,p=>({...p,contentDigest:'d'.repeat(64)})],
    [a.proof.execution.step,p=>({...p,effect:'payment'})],
    [a.proof.execution.result,p=>({...p,verification:'unverified'})],
    [a.proof.execution.result,p=>({...p,applied:false})],
    [a.proof.execution.authorization,p=>({...p,approvedAt:new Date(Date.parse(String(p.approvedAt))-1000).toISOString()})],
  ];
  for(const [ref,change] of cases){const before=f.graph.read(owner,ref).properties;f.patch(ref,change(before));assert.equal(check().status,'unknown');f.patch(ref,before);assert.equal(check().status,'known');}
  const original=f.graph.read(owner,a.assessment.ref).properties,{callerProof:_proof,...without}=original;
  f.patch(a.assessment.ref,without);assert.equal(check().status,'unknown','Caller criterion strings alone cannot prove acceptance');
 }finally{f.store.close();}
});

test('Caller coverage cannot be relinked to another task plan or read through another owner',async()=>{
 const f=fixture();try{
  const a=await f.complete('caller-c'),b=await f.complete('caller-d');
  f.graph.ingest(owner,{objects:[],removeLinks:[{type:'AssessmentCallerPlan',from:a.assessment.ref,to:a.proof.execution.plan}],links:[{type:'AssessmentCallerPlan',from:a.assessment.ref,to:b.proof.execution.plan}]},{kind:'task',id:a.job.id,observedAt:new Date().toISOString()});
  assert.equal(f.graph.evaluate(owner,{function:'taskOutcomeStatus',object:a.request.ref}).status,'unknown');
  assert.throws(()=>f.graph.evaluate('another-owner',{function:'taskOutcomeStatus',object:a.request.ref}));
 }finally{f.store.close();}
});

test('Equal assessment verdicts on different active execution bases retain separate identities',async()=>{
 const f=fixture();try{
  const a=await f.complete('caller-e'),copy=structuredClone(a.job),outcome=copy.delegation!.outcome!;
  assert.deepEqual(outcomeAssessmentRef(copy,outcome),a.assessment.ref);
  copy.delegation!.agent!.callerCompletion!.planDigest='b'.repeat(64);assert.notEqual(outcomeAssessmentRef(copy,outcome).id,a.assessment.ref.id);
  delete copy.delegation!.agent;copy.delegation!.plan={digest:'c'.repeat(64)} as NonNullable<typeof copy.delegation>['plan'];
  const first=outcomeAssessmentRef(copy,outcome).id;copy.delegation!.plan!.digest='d'.repeat(64);assert.notEqual(outcomeAssessmentRef(copy,outcome).id,first);
 }finally{f.store.close();}
});
