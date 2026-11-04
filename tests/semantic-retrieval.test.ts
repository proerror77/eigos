import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkedEmbeddingVector,embeddedFieldInput,embeddingSpaceSchema} from '../packages/ontology/semantic-retrieval.js';
import {createCurrentKernelDefinition,createSemanticRetrievalKernelDefinition} from '../packages/ontology/seed-definition.js';
import {extendPaymentCommerceKernel} from '../packages/ontology/payment-commerce-kernel.js';
import {compileOntologyDocument} from '../packages/ontology/model-compiler.js';
import {assertReviewedModel} from '../packages/security/model-review.js';
import {digest} from '../packages/core/delegation.js';
import {persistentConsentPolicyContracts} from '../packages/security/policy-store.js';
import {postgresConsentDeadline} from '../packages/postgres/consent.js';
import {SecurityError} from '../packages/security/errors.js';

test('supplied vectors retain exact model-space, float32 and authorized field input semantics',()=>{
  assert.equal(checkedEmbeddingVector([0.1,1],2).digest,checkedEmbeddingVector([Math.fround(0.1),1],2).digest);
  assert.equal(checkedEmbeddingVector([-0,1],2).digest,checkedEmbeddingVector([0,1],2).digest);
  for(const vector of [[0,0],[Infinity,1],[NaN,1],[Number.MAX_VALUE,1],[[1],1],[null,1]])assert.throws(()=>checkedEmbeddingVector(vector,2));
  assert.throws(()=>checkedEmbeddingVector([1],2));
  const ref={ontologyId:'eigos.business',releaseId:'synthetic-release',digest:'a'.repeat(64)},object={type:'Place',id:'synthetic'};
  assert.notEqual(embeddedFieldInput(ref,object,1,['name'],{}).fieldsDigest,embeddedFieldInput(ref,object,1,['name'],{name:null}).fieldsDigest);
  assert.notEqual(embeddedFieldInput(ref,object,1,['name'],{name:'A'}).inputDigest,embeddedFieldInput(ref,object,2,['name'],{name:'A'}).inputDigest);
  const space={modelId:'synthetic-local',modelRevision:'1',dimensions:2,metric:'cosine',inputFormat:'canonical-fields-json-v1'};
  assert.notEqual(digest(embeddingSpaceSchema.parse(space)),digest(embeddingSpaceSchema.parse({...space,modelRevision:'2'})));
});
test('semantic retrieval is an additive forward release, preserving its exact v27 predecessor',()=>{
  const current=createSemanticRetrievalKernelDefinition(),prior=createCurrentKernelDefinition(current.registry).document;
  assert.equal(current.document.version,'28');assert.equal(prior.version,'27');
  const model=compileOntologyDocument(current.document,current.registry),old=compileOntologyDocument(prior,current.registry);
  assert.doesNotThrow(()=>assertReviewedModel(model,old));assert.equal(old.functionIds().includes('semanticCandidates'),false);
  const contracts=persistentConsentPolicyContracts(old);
  assert.deepEqual(persistentConsentPolicyContracts(model),contracts,'the unchanged field contract preserves finite and until-revoked policies');
  assert.equal(postgresConsentDeadline(null,contracts.after,model),Infinity);assert.throws(()=>postgresConsentDeadline(null,contracts.before,model),error=>error instanceof SecurityError&&error.reason==='POLICY_CHANGED');
  assert.deepEqual(current.document.objects,prior.objects);assert.deepEqual(current.document.actions,prior.actions);assert.deepEqual(current.document.links,prior.links);
  const changed=structuredClone(prior);changed.version='28';changed.functions.push(current.document.functions.find(fn=>fn.id==='semanticCandidates')!);changed.objects[0]!.description+=' changed';
  assert.throws(()=>assertReviewedModel(model,compileOntologyDocument(changed,current.registry)));
});
