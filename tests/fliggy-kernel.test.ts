import test from 'node:test';
import assert from 'node:assert/strict';
import { createCurrentKernelDefinition, createSingleReadKernelDefinition } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { FLIGGY_PREDECESSOR } from '../packages/ontology/fliggy-kernel.js';
import { fliggyPolicyContracts, singleReadPolicyContracts } from '../packages/security/policy-store.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';

test('Fliggy v27 is additive, preserves exact v26 definitions and leaves the source disabled',()=>{
  const prior=createSingleReadKernelDefinition(),next=createCurrentKernelDefinition();
  const before=compileOntologyDocument(prior.document,prior.registry),after=compileOntologyDocument(next.document,next.registry);
  assert.equal(before.ref.digest,FLIGGY_PREDECESSOR);assert.equal(after.ref.version,'27');
  assert.equal(fliggyPolicyContracts(before,after).before,singleReadPolicyContracts(before).after);
  for(const object of prior.document.objects)assert.equal(after.fingerprint(object.id),before.fingerprint(object.id));
  for(const action of prior.document.actions)assert.deepEqual(after.action(action.id),before.action(action.id));
  for(const fn of prior.document.functions)assert.deepEqual(after.function(fn.id),before.function(fn.id));
  for(const id of ['SearchFliggyFlights','SearchFliggyHotels','SearchFliggyMarriottHotels','SearchFliggyMarriottPackages']){
    assert.equal(after.action(id).read!.effect,'read');assert.equal(after.action(id).composition!.inputs.scope!.semantics.phase,'request');
  }
  assert.equal(createExecutionCatalog().summaries(JSON.stringify(['local-development','local','developer'])).some(c=>c.ref.id==='fliggy.travel.search'),false);
});
test('Gateway/Worker reject implicit accounts and incomplete or contradictory Fliggy modes',()=>{
  const base={EIGOS_AUTH_MODE:'development',EIGOS_DEV_TOKEN:'x'.repeat(32)};
  for(const read of [readConfig,readWorkerConfig]){
    assert.equal(read(base).EIGOS_FLIGGY_MODE,'disabled');
    for(const mode of [{EIGOS_FLIGGY_MODE:'trial'},{EIGOS_FLIGGY_MODE:'key'},{EIGOS_FLIGGY_KEY_FILE:'/private/key'},{EIGOS_FLIGGY_MODE:'disabled',EIGOS_FLIGGY_KEY_SHA256:'a'.repeat(64)}])assert.throws(()=>read({...base,...mode}),/Fliggy/);
  }
});
