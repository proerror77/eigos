import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { businessDescriptions } from '../packages/ontology/business-descriptions.js';
import { createCurrentKernelDefinition, createPaymentCommerceKernelDefinition, PAYMENT_COMMERCE_KERNEL_MODEL_REF } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { OntologyModel, type ModelDefinition } from '../packages/ontology/model.js';
import { JobStore } from '../packages/core/store.js';
import { digest } from '../packages/core/delegation.js';
import { persistentConsentPolicyContracts } from '../packages/security/policy-store.js';
import { upgradeBusinessDescriptionsPolicy } from '../packages/security/business-descriptions-upgrade.js';
import { securityFixture } from './fixtures/security.js';
import { DatabaseSync } from 'node:sqlite';
import { businessTransaction } from '../packages/core/transaction.js';

test('all 68 previously label-only business types expose explanations without changing any v27 data, action or function contract', () => {
  const previous = createPaymentCommerceKernelDefinition(), next = createCurrentKernelDefinition();
  const before = compileOntologyDocument(previous.document, previous.registry), after = compileOntologyDocument(next.document, next.registry);
  assert.deepEqual(before.ref, PAYMENT_COMMERCE_KERNEL_MODEL_REF);
  assert.equal(after.ref.version, '28'); assert.notEqual(after.ref.digest, before.ref.digest);
  const missing = previous.document.objects.filter(type => type.visibility !== 'technical' && [type.name, type.id].includes(type.description));
  assert.equal(missing.length, 68);
  assert.deepEqual(Object.keys(businessDescriptions).sort(), missing.map(type => type.id).sort());
  for (const type of previous.document.objects) {
    assert.equal(after.fingerprint(type.id), before.fingerprint(type.id), type.id);
    assert.deepEqual((after.describeType(type.id) as { properties: unknown }).properties, (before.describeType(type.id) as { properties: unknown }).properties);
    const description = (after.describeType(type.id) as { description: string }).description;
    assert.equal(description, businessDescriptions[type.id] ?? type.description);
    if (businessDescriptions[type.id]) assert(description.length > 40 && ![type.name, type.id].includes(description));
  }
  assert.deepEqual(next.document.links, previous.document.links);
  assert.deepEqual(next.document.interfaces, previous.document.interfaces);
  assert.deepEqual(next.document.actions, previous.document.actions);
  assert.deepEqual(next.document.functions, previous.document.functions);
  assert.equal((before.describeType('HotelProperty') as { description: string }).description, '酒店物业');
});

test('discovery searches the published explanation and model digests retain both display and underlying data contracts', () => {
  const field = { kind: 'string' as const, schema: z.string().min(1), source: 'test', description: 'Identity', required: true };
  const definition: ModelDefinition = { id: 'description.test', version: '1', objects: [{ id: 'Asset', version: '1', name: 'Asset', aliases: [], description: 'Original contract',
    businessDescription: 'A source-scoped business resource with a discoverable explanation', primaryKey: 'id', titleKey: 'id', properties: { id: field } }], interfaces: [], links: [], actions: [], functions: [] };
  const before = new OntologyModel(definition);
  assert.equal(before.describe({ search: 'discoverable' }).types.length, 1);
  const changed = { ...definition, objects: [{ ...definition.objects[0]!, description: 'Different original contract' }] };
  const other = new OntologyModel(changed);
  assert.notEqual(other.fingerprint('Asset'), before.fingerprint('Asset'));
  assert.notEqual(other.ref.digest, before.ref.digest, 'A display override must never conceal a writer contract change');
});

test('description activation preserves exact releases and rejects stale installation preconditions', () => {
  const store = new JobStore(':memory:');
  try {
    const namespace = store.definitions.namespace();
    const current = store.definitions.resolve(namespace.active);
    assert.equal(current.model.ref.version, '28');
    assert.deepEqual(store.definitions.installBusinessDescriptions(namespace.active, namespace.generation), namespace);
    assert.throws(() => store.definitions.installBusinessDescriptions(namespace.active, namespace.generation + 1), /Active ontology changed/);
    const old = createPaymentCommerceKernelDefinition();
    const resolved = compileOntologyDocument(old.document, old.registry);
    assert.equal(resolved.ref.digest, PAYMENT_COMMERCE_KERNEL_MODEL_REF.digest);
    assert.equal(current.model.fingerprint('ServiceRequest'), resolved.fingerprint('ServiceRequest'));
  } finally { store.close(); }
});

test('offline description policy upgrade preserves grants, bindings, consent and source permissions and is retryable', () => {
  const f = securityFixture(), db = new DatabaseSync(f.database);
  try {
    const installation = f.installation('Description-only upgrade'); f.approve(installation.id);
    f.coordinator.close();
    const old = createPaymentCommerceKernelDefinition(), model = compileOntologyDocument(old.document, old.registry);
    const before = persistentConsentPolicyContracts(model).after;
    db.prepare('UPDATE security_policy_definitions SET digest=? WHERE slot=1').run(before);
    const revision = Number(db.prepare('SELECT revision FROM security_policy WHERE slot=1').get()!.revision);
    const tables = ['security_grants', 'security_sources', 'security_bindings', 'security_labels'];
    const rows = () => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const original = digest(rows()), expected = { digest: before, revision };
    assert.equal(upgradeBusinessDescriptionsPolicy(db, expected).applied, false);
    assert.throws(() => businessTransaction(db, () => { upgradeBusinessDescriptionsPolicy(db, expected, true); throw new Error('Ontology activation failed'); }), /Ontology activation failed/);
    assert.equal(db.prepare('SELECT digest FROM security_policy_definitions WHERE slot=1').get()!.digest, before);
    assert.equal(Number(db.prepare('SELECT revision FROM security_policy WHERE slot=1').get()!.revision), revision);
    const upgraded = upgradeBusinessDescriptionsPolicy(db, expected, true);
    assert.equal(upgraded.actionsAdded, 0); assert.equal(upgraded.functionsAdded, 0); assert.equal(upgraded.expiryExtended, false);
    assert.equal(digest(rows()), original);
    assert.equal(upgradeBusinessDescriptionsPolicy(db, expected, true).alreadyApplied, true);
    const reopened = new JobStore(f.database, { securityMode: 'foundation' });
    try {
      assert.equal(reopened.security.policies.definitionDigest, upgraded.after);
      reopened.security.policies.assertModel(model);
      assert.equal(reopened.security.policies.fieldPolicy('ServiceRequest', 'originalGoal'), f.jobs.security.policies.fieldPolicy('ServiceRequest', 'originalGoal'));
    } finally { reopened.close(); }
  } finally { db.close(); f.close(); }
});
