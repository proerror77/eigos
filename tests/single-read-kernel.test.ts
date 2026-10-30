import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalContextKernelDefinition, createCurrentKernelDefinition } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { SINGLE_READ_PREDECESSOR } from '../packages/ontology/single-read-kernel.js';
import { personalContextPolicyContracts, singleReadPolicyContracts } from '../packages/security/policy-store.js';

test('the read-contract release preserves v25 and changes only goal validation metadata', () => {
  const prior = createPersonalContextKernelDefinition(), next = createCurrentKernelDefinition();
  const before = compileOntologyDocument(prior.document, prior.registry), after = compileOntologyDocument(next.document, next.registry);
  assert.equal(before.ref.digest, SINGLE_READ_PREDECESSOR);
  assert.equal(personalContextPolicyContracts(before).after, singleReadPolicyContracts(after).before);
  assert.equal(after.ref.version, '26');
  for (const object of prior.document.objects) if (object.id !== 'GoalCoverage') assert.equal(after.fingerprint(object.id), before.fingerprint(object.id));
  for (const action of prior.document.actions) assert.deepEqual(after.action(action.id), before.action(action.id));
  for (const fn of prior.document.functions) assert.deepEqual(after.function(fn.id), before.function(fn.id));
  assert.equal(before.properties('GoalCoverage').reviewOrigin!.schema.safeParse('ontology_read_contract').success, false);
  assert.equal(after.properties('GoalCoverage').reviewOrigin!.schema.safeParse('ontology_read_contract').success, true);
});
