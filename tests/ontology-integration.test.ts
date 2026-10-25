import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { digest } from '../packages/core/delegation.js';
import { currentKernelImplementation } from '../packages/ontology/definition-store.js';
import { createSeedDefinition, CURRENT_KERNEL_VERSION } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
const businessModel=currentKernelImplementation(), seed=createSeedDefinition(), migrationModel=compileOntologyDocument(seed.document,seed.registry);
const migrationGraph=(db:DatabaseSync)=>new OntologyObjectStore(db,migrationModel);
import { INTEGRATION_PREDECESSORS } from '../packages/ontology/integration-migration.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { FROZEN_V14, integrationPredecessor, parseHistoricalProperties } from '../packages/ontology/history-schema.js';
import pins from './fixtures/ontology-v14-fingerprints.json' with { type: 'json' };

const at = '2026-10-20T15:00:00.000Z';
const source = { kind: 'synthetic' as const, id: 'integration-fixture', observedAt: at };
function seedPredecessors(db: DatabaseSync) {
  migrationGraph(db);
  for (const [type, hashes] of Object.entries(INTEGRATION_PREDECESSORS)) {
    assert.equal(FROZEN_V14.objects[type]!.fingerprint, (pins.objects as Record<string, string>)[type]);
    for (const fingerprint of hashes) assert.equal(digest(integrationPredecessor(type, fingerprint).definition), fingerprint, `${type} must match the actual committed predecessor`);
  }
  const oldReceipt = integrationPredecessor('SourceReceipt', INTEGRATION_PREDECESSORS.SourceReceipt![0]!);
  assert.equal(oldReceipt.definition.version, '4');
  assert.deepEqual(oldReceipt.definition.properties.scope!.schema, FROZEN_V14.objects.SourceReceipt!.definition.properties.scope!.schema);
  for (const row of rows) {
    const old = integrationPredecessor(row.ref.type, INTEGRATION_PREDECESSORS[row.ref.type]![0]!);
    assert.deepEqual(parseHistoricalProperties(old, row.properties), row.properties);
    db.prepare('INSERT INTO ontology_objects VALUES(?,?,?,?,?,?)').run('owner', row.ref.type, row.ref.id, 7, old.fingerprint, JSON.stringify({ properties: row.properties, source, createdAt: at }));
  }
  for (const link of links) db.prepare('INSERT INTO ontology_links VALUES(?,?,?,?,?,?,?)').run('owner', link.type, link.from.type, link.from.id, link.to.type, link.to.id, (pins.links as Record<string, string>)[link.type]!);
  db.prepare('INSERT INTO ontology_revisions VALUES(?,?)').run('owner', 9);
}
const rows = [
  { ref: { type: 'ServiceRequest', id: 'request' }, properties: { requestId: 'request', displayTitle: 'Original request', originalGoal: 'Read only' } },
  { ref: { type: 'SourceReceipt', id: 'receipt' }, properties: { receiptId: 'receipt', displayTitle: 'Original receipt', safeSummary: 'Synthetic observation', evidenceLevel: 'synthetic' } },
  { ref: { type: 'RegisteredActionType', id: 'action' }, properties: { id: 'action', displayTitle: 'Original action', contractKind: 'semantic_definition', actionId: 'ReadSavedAddresses', actionVersion: '1', definitionDigest: digest('original'), description: 'Read only', inputs: {}, effect: 'read', effects: ['read'], resultTypes: [], changes: [], submissionCriteria: [], execution: 'definition_only' } },
  { ref: { type: 'RegisteredCapability', id: 'capability' }, properties: { id: 'capability', name: 'Original capability', capabilityRef: { id: 'test.read', version: '1' }, description: 'Read only', tags: [], inputSchema: {}, predicates: [], outcomePredicates: [], requirementRoles: [], definitionDigest: digest('capability') } },
];

const links = [{ type: 'RegisteredActionTypeRequest', from: { type: 'RegisteredActionType', id: 'action' }, to: { type: 'ServiceRequest', id: 'request' } }];

test('integrated model preserves member, execution, booking, commerce and domain semantics together', () => {
  for (const type of ['RequestingParty', 'Authorization', 'BusinessResult', 'AssessmentFinding', 'ExecutionStep', 'PaotuiTask', 'CatalogTask', 'BookingTask', 'PAPaymentRequest', 'CommerceTask', 'CustomsRuleSet', 'HotelReservation', 'VehicleBooking']) {
    assert(businessModel.hasType(type), type);
  }
  assert.equal(businessModel.action('ReadSavedAddresses').read?.effect, 'read');
  assert.equal(businessModel.action('CreatePendingBooking').operation?.effect, 'reserve');
  assert.equal(businessModel.action('RequestPAPayment').operation?.effect, 'local');
  assert.equal(businessModel.action('CreateCommerceCart').operation?.effect, 'change');
  assert.equal(businessModel.action('AuthorizeProposal').kind, 'decision');
  assert.equal(businessModel.ref.version, CURRENT_KERNEL_VERSION);
});

test('exact additive predecessors retain their original facts, revisions and provenance after integration', () => {
  const db = new DatabaseSync(':memory:');
  try {
    seedPredecessors(db);
    const before = db.prepare('SELECT * FROM ontology_objects ORDER BY type').all();
    const graph = migrationGraph(db);
    for (const row of rows) assert.deepEqual(graph.read('owner', row.ref).properties, row.properties);
    const after = db.prepare('SELECT * FROM ontology_objects ORDER BY type').all();
    assert.deepEqual(after.map(({ definition_digest: _digest, ...row }) => row), before.map(({ definition_digest: _digest, ...row }) => row));
    migrationGraph(db);
    assert.deepEqual(db.prepare('SELECT * FROM ontology_objects ORDER BY type').all(), after);
    assert.throws(() => graph.read('other-owner', rows[0]!.ref), /not found/);
  } finally { db.close(); }
});

test('unknown definitions roll back both integration and business-chain migrations', () => {
  const db = new DatabaseSync(':memory:');
  try {
    seedPredecessors(db);
    db.prepare("UPDATE ontology_objects SET definition_digest=? WHERE type='RegisteredCapability'").run(digest('unknown'));
    const before = db.prepare('SELECT * FROM ontology_objects ORDER BY type').all();
    assert.throws(() => migrationGraph(db), /Unknown predecessor/);
    assert.deepEqual(db.prepare('SELECT * FROM ontology_objects ORDER BY type').all(), before);
  } finally { db.close(); }
});

test('old schema fingerprints cannot be used to add new facts during migration', () => {
  const db = new DatabaseSync(':memory:');
  try {
    seedPredecessors(db);
    const row = db.prepare("SELECT body FROM ontology_objects WHERE type='SourceReceipt'").get()!;
    const body = JSON.parse(String(row.body)); body.properties.evidenceLevel = 'provider_test';
    db.prepare("UPDATE ontology_objects SET body=? WHERE type='SourceReceipt'").run(JSON.stringify(body));
    assert.throws(() => migrationGraph(db), /pinned predecessor/);
  } finally { db.close(); }
});

test('legacy checkout without mandatory cost evidence is never relabeled as a current checkout', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrationGraph(db);
    const definition = 'bc609fb81fe874bebab53a641e6e191964d4783d664219f7cfadbac2a791e77e';
    const body = JSON.stringify({ properties: { id: 'legacy', displayTitle: 'Historical checkout' }, source, createdAt: at });
    db.prepare('INSERT INTO ontology_objects VALUES(?,?,?,?,?,?)').run('owner', 'CheckoutSession', 'legacy', 1, definition, body);
    const graph = migrationGraph(db);
    assert.throws(() => graph.read('owner', { type: 'CheckoutSession', id: 'legacy' }), /historical data cannot be reinterpreted/);
    assert.equal(db.prepare("SELECT definition_digest FROM ontology_objects WHERE type='CheckoutSession'").get()!.definition_digest, definition);
  } finally { db.close(); }
});
