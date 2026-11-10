import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContractClosureKernelDefinition, createDomainVocabularyKernelDefinition } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { digest } from '../packages/core/delegation.js';
import { FUNCTION_RETURN_TYPES, isReviewedCriterion, SUBMISSION_CRITERIA } from '../packages/ontology/contract-vocabulary.js';

const closed = createContractClosureKernelDefinition();
const model = compileOntologyDocument(closed.document, closed.registry);

test('v32 keeps the reviewed v31 release byte-identical', () => {
  const previous = createDomainVocabularyKernelDefinition();
  assert.equal(previous.document.version, '31');
  assert.equal(closed.document.version, '32');
  assert.equal(previous.audit.model.digest, '2eb7c0911c04c38bb0cc0f8316c12d86318f8612f675506436b41d871ce66f51');
  assert.equal(closed.audit.model.digest, '53bdaa43dd60980322180e1a9aafa52a8669056aeef245fd9fc983a7a5322e04');
});

test('every function declares a reviewed result', () => {
  assert.equal(closed.document.functions.length, 54);
  for (const fn of closed.document.functions) {
    const returns = fn.returns ?? [];
    assert.ok(returns.length > 0, `${fn.id} must declare what it returns`);
    for (const value of returns) assert.ok((FUNCTION_RETURN_TYPES as readonly string[]).includes(value), `${fn.id} returns an unreviewed type: ${value}`);
  }
  // A pure predicate must not be published as a structural assessment.
  assert.deepEqual(closed.document.functions.find(fn => fn.id === 'shippingGateStatus')?.returns, ['boolean']);
  assert.deepEqual(closed.document.functions.find(fn => fn.id === 'selectDidiPlace')?.returns, ['string']);
  assert.deepEqual(closed.document.functions.find(fn => fn.id === 'commerceJourneyStatus')?.returns, ['object']);
});

test('every submission criterion is a registered term', () => {
  assert.equal(closed.document.criteriaVersion, '1');
  const used = new Set(closed.document.actions.flatMap(action => action.submissionCriteria));
  assert.ok(used.size > 0);
  for (const criterion of used) assert.ok(isReviewedCriterion(criterion), `unregistered criterion ${criterion}`);
  for (const [name, entry] of Object.entries(SUBMISSION_CRITERIA)) {
    assert.ok(entry.meaning.length > 0, `${name} must say what it means`);
    assert.ok(entry.kind.length > 0, `${name} must be classified`);
  }
});

test('approval is derived from the declared effect, not hand-assigned', () => {
  const requires = closed.document.actions.filter(action => model.approvalRequired(action.id));
  const reads = closed.document.actions.filter(action => !model.approvalRequired(action.id));
  assert.equal(requires.length + reads.length, closed.document.actions.length);
  // Reads and local computation never need an owner's decision.
  for (const action of closed.document.actions) {
    const effect = action.operation?.effect ?? action.read?.effect ?? 'none';
    assert.equal(model.approvalRequired(action.id), !['read', 'local', 'none'].includes(effect), `${action.id} (${effect})`);
  }
  assert.ok(requires.length > 0 && reads.length > 0);
  assert.throws(() => model.approvalRequired('NoSuchAction'), /Unknown action/);
});

test('the closure release changes nothing that was already reviewed', () => {
  const before = createDomainVocabularyKernelDefinition().document;
  assert.equal(digest(closed.document.objects), digest(before.objects));
  assert.equal(digest(closed.document.interfaces), digest(before.interfaces));
  assert.equal(digest(closed.document.links), digest(before.links));
  assert.deepEqual(closed.document.actions.map(action => action.id), before.actions.map(action => action.id));
});

test('v32 exposes which actions operate on a type without moving the fingerprint', () => {
  const described = model.describeType('Order') as { actions?: { writes: { id: string; requiresApproval: boolean }[]; reads: unknown[] } };
  assert.ok(described.actions, 'a v32 projection must say which actions operate on the type');
  assert.equal(described.actions!.writes.length, 12);
  assert.equal(described.actions!.reads.length, 1);
  // Writing a local object is not the same as reaching a provider: approval follows
  // the declared effect, so the projection carries it rather than assuming it.
  for (const entry of [...described.actions!.writes, ...described.actions!.reads as { id: string; requiresApproval: boolean }[]]) {
    assert.equal(entry.requiresApproval, model.approvalRequired(entry.id), `${entry.id} must publish the derived approval`);
  }
  assert.ok(described.actions!.writes.some(entry => entry.requiresApproval), 'at least one write to this type needs an owner');
  // The reviewed release is unaffected: the projection is not part of the digest any more.
  assert.equal(model.ref.digest, '53bdaa43dd60980322180e1a9aafa52a8669056aeef245fd9fc983a7a5322e04');
  const previous = compileOntologyDocument(createDomainVocabularyKernelDefinition().document, createDomainVocabularyKernelDefinition().registry);
  const before = previous.describeType('Order') as { actions?: unknown };
  assert.equal(before.actions, undefined, 'a published v31 projection must stay exactly as it was');
  assert.equal(previous.ref.digest, '2eb7c0911c04c38bb0cc0f8316c12d86318f8612f675506436b41d871ce66f51');
});
