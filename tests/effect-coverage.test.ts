import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContractClosureKernelDefinition, createEffectCoverageKernelDefinition } from '../packages/ontology/seed-definition.js';

const covered = createEffectCoverageKernelDefinition();
const document = covered.document as typeof covered.document & { effectCoverage?: { derived: number; kept: number; undeclared: string[] } };

test('v33 fills the effect gap from the intent that was already declared', () => {
  const declared = (action: typeof document.actions[number]) => action.operation?.effect ?? action.read?.effect;
  let derived = 0, kept = 0;
  for (const action of document.actions) {
    const effects = action.effects ?? [];
    if (effects.length) { kept++; continue; }
    derived++;
    // The only actions without an effect are the two definition-only decisions.
    assert.equal(declared(action), undefined, `${action.id} states an effect and must declare it`);
  }
  assert.equal(document.version, '33');
  assert.deepEqual(document.effectCoverage, { derived: 55, kept: 66, undeclared: ['RequestDeliveryQuote', 'SelectOffer'] });
  assert.equal(derived, 2);
  assert.equal(kept, 121);
});

test('no implemented action is left without a declared effect', () => {
  const missing = document.actions.filter(action => action.implementation && !(action.effects ?? []).length).map(action => action.id);
  assert.deepEqual(missing, [], 'an action the system can execute must say what it changes');
  // Every derived set still contains the provider effect it was copied from.
  for (const action of document.actions) {
    const effect = action.operation?.effect ?? action.read?.effect;
    if (effect) assert.ok((action.effects ?? []).includes(effect), `${action.id} lost its declared effect`);
  }
});

test('the richer reviewed effect sets are not overwritten', () => {
  const checkout = document.actions.find(action => action.id === 'CompleteCheckout');
  assert.deepEqual(checkout?.effects, ['order', 'payment'], 'a checkout does two things and says so');
});

test('v32 stays byte-identical while v33 is a separate release', () => {
  const previous = createContractClosureKernelDefinition();
  assert.equal(previous.audit.model.digest, '53bdaa43dd60980322180e1a9aafa52a8669056aeef245fd9fc983a7a5322e04');
  assert.equal(covered.audit.model.digest, '5a721eaa695d262725ad3d515c3ff8e098d0858011e55ca4e3a31e84bc6b08a0');
  assert.equal(previous.document.version, '32');
});
