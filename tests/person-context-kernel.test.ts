import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessFactsKernelDefinition, createCurrentKernelDefinition } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { PERSONAL_CONTEXT_PREDECESSOR } from '../packages/ontology/personal-context-kernel.js';
import { personalActionIds } from '../packages/ontology/personal-context.js';
import { businessFactsPolicyContracts } from '../packages/security/policy-store.js';

test('Person extends the reviewed v24 model without rewriting its constructors or other stored contracts', () => {
  const old = createBusinessFactsKernelDefinition(), current = createCurrentKernelDefinition();
  const before = compileOntologyDocument(old.document, old.registry), after = compileOntologyDocument(current.document, current.registry);
  assert.equal(before.ref.digest, PERSONAL_CONTEXT_PREDECESSOR);
  assert.equal(businessFactsPolicyContracts(before).after, '61a64d7f6c60e3ff6a2506710ae27b2b75f179cc485eec412a7873dc5e02e0fa');
  for (const type of old.document.objects) if (type.id !== 'RequestFact') assert.equal(after.fingerprint(type.id), before.fingerprint(type.id));
  assert.equal(after.properties('RequestFact').personalBasis!.required, false);
  for (const action of old.document.actions) assert.deepEqual(after.action(action.id), before.action(action.id));
  assert.equal(after.navigation('ServiceRequest', 'travelContext').other.type, 'OriginDestination');
  assert.equal(after.navigation('ServiceRequest', 'transportContext').other.type, 'OriginDestination');
  for (const action of personalActionIds) assert.deepEqual(after.action(action).effects, ['object_write']);
  const changed = structuredClone(current.document);
  changed.actions.find(action => action.id === 'SetPersonalPreference')!.description = 'Unreviewed replacement';
  assert.throws(() => compileOntologyDocument(changed, current.registry), /kernel resources cannot be changed/);
});
