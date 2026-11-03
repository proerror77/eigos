import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleReadKernelDefinition, createCurrentKernelDefinition, SINGLE_READ_KERNEL_MODEL_REF } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { commerceReadDefinition } from '../packages/ontology/payment-commerce.js';
import { singleReadPolicyContracts, paymentCommercePolicyContracts, persistentConsentPolicyContracts } from '../packages/security/policy-store.js';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../packages/core/delegation.js';
import { JobStore } from '../packages/core/store.js';
import { upgradePaymentCommercePolicy } from '../packages/security/payment-commerce-upgrade.js';
import { securityFixture } from './fixtures/security.js';

test('v27 adds only provider query definitions and keeps the exact v26 model and policy predecessor', { timeout: 300000 }, () => {
  const previous = createSingleReadKernelDefinition(), next = createCurrentKernelDefinition();
  const before = compileOntologyDocument(previous.document, previous.registry), after = compileOntologyDocument(next.document, next.registry);
  assert.deepEqual(before.ref, SINGLE_READ_KERNEL_MODEL_REF); assert.equal(after.ref.version, '27');
  for (const type of previous.document.objects) assert.equal(after.fingerprint(type.id), before.fingerprint(type.id));
  for (const action of previous.document.actions) assert.deepEqual(after.action(action.id), before.action(action.id));
  for (const fn of previous.document.functions) assert.deepEqual(after.function(fn.id), before.function(fn.id));
  assert.equal(next.document.actions.length - previous.document.actions.length, 5);
  for (const definition of commerceReadDefinition.actions) {
    const action = after.action(definition.id);
    assert.equal(action.read?.effect, 'read'); assert.deepEqual(action.read?.mcp, definition.mcp);
    assert.deepEqual(action.composition?.effectScope.effects, ['read']);
  }
  assert.equal(paymentCommercePolicyContracts(after).before, singleReadPolicyContracts(before).after);
  assert.equal(paymentCommercePolicyContracts(after, true).before, persistentConsentPolicyContracts(before).after);
  assert.equal(paymentCommercePolicyContracts(after, true).after, persistentConsentPolicyContracts(after).after);
});

test('v26 persistent-consent migration preserves null expiry, source grants and existing action permissions', { timeout: 300000 }, () => {
  const f = securityFixture(), db = new DatabaseSync(f.database), policy = f.jobs.security.policies;
  try {
    const install = f.installation('Synthetic persistent payment migration', 3600000);
    f.coordinator.approveAgentGrant(f.member.id, { installationId: install.id, capabilityIds: ['ride.estimate.query'],
      resources: [{ type: 'ServiceRequest', fields: ['requestId'] }], sourceBindingIds: ['program:ride.estimate.query'], channels: ['agent_response', 'registered_model'] });
    policy.setSource(f.owner, { installationId: install.id, bindingId: 'program:ride.estimate.query', programId: 'ride.estimate.query', programDigest: 'a'.repeat(64),
      operations: ['SearchDidiPlaces'], outputTypes: ['DidiPlaceObservation'], expiresAt: null }, policy.revision());
    const role = { subjectKind: 'installation' as const, subjectId: install.id, resource: { kind: 'namespace' as const, id: policy.model.ref.id, version: policy.model.ref.digest },
      role: 'Viewer' as const, executeActions: ['SearchDidiPlaces'], invokeFunctions: ['rideEstimateStatus'], expiresAt: null };
    const current = policy.setRole(role, policy.revision()), revision = policy.revision();
    f.coordinator.close();
    const contracts = paymentCommercePolicyContracts(policy.model, true), old = { ...role, resource: { ...role.resource, version: SINGLE_READ_KERNEL_MODEL_REF.digest } };
    db.prepare('DELETE FROM security_roles WHERE id=?').run(current.id);
    db.prepare('INSERT INTO security_roles VALUES(?,?,?)').run(digest([old.subjectKind, old.subjectId, old.resource]), old.subjectId, JSON.stringify(old));
    db.prepare('UPDATE security_policy_definitions SET digest=? WHERE slot=1').run(contracts.before);
    const grants = db.prepare('SELECT * FROM security_grants ORDER BY id').all(), sources = db.prepare('SELECT * FROM security_sources ORDER BY installation_id').all();
    const expected = { digest: contracts.before, revision };
    assert.equal(upgradePaymentCommercePolicy(db, expected).applied, false);
    const applied = upgradePaymentCommercePolicy(db, expected, true);
    assert.equal(applied.expiryExtended, false); assert.equal(applied.actionsAdded, 0); assert.equal(applied.functionsAdded, 0);
    assert.equal(upgradePaymentCommercePolicy(db, expected, true).alreadyApplied, true);
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT body FROM security_roles WHERE id=?').get(current.id)!.body)), role);
    assert.deepEqual(db.prepare('SELECT * FROM security_grants ORDER BY id').all(), grants);
    assert.deepEqual(db.prepare('SELECT * FROM security_sources ORDER BY installation_id').all(), sources);
    const reopened = new JobStore(f.database, { securityMode: 'foundation' });
    try { assert.equal(reopened.security.policies.persistentConsentEnabled, true); assert.equal(reopened.security.policies.definitionDigest, contracts.after); }
    finally { reopened.close(); }
  } finally { db.close(); f.close(); }
});
