// Pure finite projection checks. Authorization is intentionally NOT mocked:
// callers must obtain the seal and current typed field before invoking these.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {digest} from '../packages/core/delegation.js';
import type {Job} from '../packages/core/domain.js';
import {documentDraftSchema} from '../packages/ontology/document-action.js';
import {goalDocumentCandidates,projectGoalDocument,publicTaskArtifact,type PublicGoalDocument} from '../packages/security/task-artifact.js';

function fixture(){
  const taskId='task',markdown='# Actual bounded document\n\nSupplied information.',snapshot=documentDraftSchema.parse({id:'document',requestId:taskId,requestRevision:1,configurationDigest:'a'.repeat(64),scope:{type:'DocumentTask',id:'scope'},actionInputDigest:'b'.repeat(64),planId:'plan',intentId:'intent',attemptId:'attempt',decisionRunId:'planning-model',modelRunId:'document-model',createdAt:'2026-11-03T00:00:00.000Z',status:'draft',markdown,message:'Explicit synthetic fixture',contentDigest:digest(markdown),citations:[],noExternalActions:true});
  const child={id:snapshot.id,name:'deliverable.md',data:{goal:'Requested document',deliverable:'Current verified Markdown artifact',execution:'completed',markdown,result:{modelGenerated:true,noExternalActions:true,contentSha256:snapshot.contentDigest,citations:[],providerPayload:'PRIVATE_PROVIDER_RESULT'},privatePayload:'PRIVATE_CHILD_DATA'},privateObject:'PRIVATE_CHILD_OBJECT'};
  const artifact:NonNullable<Job['artifact']>={id:'goal',name:'goal-result.json',data:{goal:'Requested document',deliverable:'Fixed whole goal verified',execution:'completed',result:{version:'1',goalDigest:'c'.repeat(64),components:[{contextId:'document',status:'verified',artifact:child,privateDetails:'PRIVATE_COMPONENT'}],privatePayload:'PRIVATE_GOAL_RESULT'}}};
  return {taskId,snapshot,artifact,child,markdown};
}

test('whole-goal projection retains the exact current verified document and excludes opaque child/ledger data',()=>{
  const x=fixture(),before=structuredClone(x.artifact),candidates=goalDocumentCandidates(x.artifact);assert(candidates);assert.equal(candidates.length,1);
  const document=projectGoalDocument(candidates[0]!,x.snapshot,x.taskId,1);assert(document);
  const projected=publicTaskArtifact(x.artifact,[],[document]),result=projected.data.result as {components:PublicGoalDocument[]};
  assert.equal(result.components[0]!.artifact.data.markdown,x.markdown);assert.equal(projected.data.markdown,undefined,'the goal is not silently replaced with one component');
  assert.deepEqual(Object.keys(result.components[0]!.artifact.data),['markdown']);assert(!JSON.stringify(projected).includes('PRIVATE_'));assert(!JSON.stringify(projected).includes('modelRunId'));assert(!Object.hasOwn(result.components[0]!.artifact.data,'result'));
  assert.deepEqual(x.artifact,before,'projection cannot rewrite the sealed delivery');
});

test('another task/revision, changed snapshot, absent field and changed citation proof cannot supply text',()=>{
  const x=fixture(),candidate=goalDocumentCandidates(x.artifact)![0]!;
  for(const snapshot of [undefined,{}, {...x.snapshot,id:'another-document'},{...x.snapshot,requestId:'another-task'},{...x.snapshot,requestRevision:2},{...x.snapshot,status:'needs_input'},
    {...x.snapshot,markdown:'Changed after acceptance',contentDigest:digest('Changed after acceptance')},
    {...x.snapshot,citations:[{object:{type:'Place',id:'source'},revision:1,propertiesDigest:'a'.repeat(64),receiptDigest:'b'.repeat(64),evidenceRefs:['source-event']}]},
    {...x.snapshot,privatePayload:'PRIVATE_UNREGISTERED_SNAPSHOT'}])assert.equal(projectGoalDocument(candidate,snapshot,x.taskId,1),undefined);
  assert.equal(projectGoalDocument(candidate,x.snapshot,x.taskId,2),undefined);
});

test('opaque providers and unverified documents remain opaque even when they contain Markdown',()=>{
  const x=fixture(),value=x.artifact.data.result as {components:unknown[]};
  value.components=[{contextId:'opaque',status:'verified',artifact:{name:'provider-result.json',data:{execution:'completed',markdown:'PRIVATE_PROVIDER_MARKDOWN',result:{privatePayload:'PRIVATE_RESULT'}}}},
    {contextId:'unverified',status:'unverified',artifact:x.child}];
  assert.deepEqual(goalDocumentCandidates(x.artifact),[]);const projected=publicTaskArtifact(x.artifact,[],[]);assert.equal(projected.data.result,undefined);assert(!JSON.stringify(projected).includes('PRIVATE_'));assert(!JSON.stringify(projected).includes(x.markdown));
});

test('malformed document proof and over-budget component/body shapes fail closed',()=>{
  for(const mutate of [(x:ReturnType<typeof fixture>)=>{x.child.data.result.contentSha256='d'.repeat(64);},(x:ReturnType<typeof fixture>)=>{x.child.data.markdown='x'.repeat(40001);},
    (x:ReturnType<typeof fixture>)=>{x.child.data.goal='A different goal';},(x:ReturnType<typeof fixture>)=>{(x.artifact.data.result as {components:unknown[]}).components=Array.from({length:17},(_,i)=>({contextId:`c${i}`,status:'unverified'}));}]){
    const x=fixture();mutate(x);assert.equal(goalDocumentCandidates(x.artifact),undefined);
  }
});

test('multiple bounded documents retain context identity and partial whole-goal status',()=>{
  const x=fixture(),value=x.artifact.data.result as {components:unknown[]};x.artifact.data.execution='partial';
  const second=structuredClone(x.child);second.id='document-two';second.data.markdown='# A separate document';second.data.result.contentSha256=digest(second.data.markdown);value.components.push({contextId:'second',status:'verified',artifact:second});
  const candidates=goalDocumentCandidates(x.artifact)!,documents=candidates.map(candidate=>projectGoalDocument(candidate,candidate.document.id==='document'?x.snapshot:{...x.snapshot,id:second.id,markdown:second.data.markdown,contentDigest:second.data.result.contentSha256},x.taskId,1)!);
  const projected=publicTaskArtifact(x.artifact,[{ref:{type:'ServiceRequest',id:x.taskId},revision:1,properties:{}}],documents),result=projected.data.result as {components:{contextId:string}[];observations:unknown[]};
  assert.deepEqual(result.components.map(value=>value.contextId),['document','second']);assert.equal(result.observations.length,1);assert.equal(projected.data.execution,'partial');
});

test('non-goal text delivery keeps its existing public shape and opaque results are still omitted',()=>{
  const x=fixture();x.artifact.name='ordinary.md';x.artifact.data.markdown='# Existing top-level text';
  assert.deepEqual(goalDocumentCandidates(x.artifact),[]);const projected=publicTaskArtifact(x.artifact,[],[]);assert.equal(projected.data.markdown,'# Existing top-level text');assert.equal(projected.data.result,undefined);
});
