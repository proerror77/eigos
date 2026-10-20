import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { z } from 'zod';
import { digest } from '../packages/core/delegation.js';
import { BUSINESS_MODEL_DEFINITION, businessModel } from '../packages/ontology/business-model.js';
import { INTEGRATION_PREDECESSORS } from '../packages/ontology/integration-migration.js';
import { OntologyModel, type ObjectTypeDefinition } from '../packages/ontology/model.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';

const at = '2026-10-20T15:00:00.000Z';
const source = { kind: 'synthetic' as const, id: 'integration-fixture', observedAt: at };
function predecessor() {
  const objects = BUSINESS_MODEL_DEFINITION.objects.map(type => {
    const properties = { ...type.properties };
    if (type.id === 'ServiceRequest') delete properties.confirmedInputs;
    if (type.id === 'RegisteredCapability') delete properties.constraintEvaluation;
    if (type.id === 'RegisteredActionType') properties.effect = { ...properties.effect!, schema: z.enum(['read', 'definition_only']) };
    if (type.id === 'BusinessResult') properties.evidenceLevel = { ...properties.evidenceLevel!, schema: z.enum(['synthetic', 'internal', 'live_readonly', 'live_operation', 'live_fulfillment', 'unknown']) };
    if (type.id === 'SourceReceipt') properties.evidenceLevel = { ...properties.evidenceLevel!, schema: z.enum(['synthetic', 'user_asserted', 'live_readonly', 'live_operation', 'live_fulfillment']) };
    return { ...type, properties } satisfies ObjectTypeDefinition;
  });
  const model = new OntologyModel({ ...BUSINESS_MODEL_DEFINITION, version: 'test-predecessors', objects });
  for (const [type, hashes] of Object.entries(INTEGRATION_PREDECESSORS)) assert(hashes.includes(model.fingerprint(type)), `${type} must match an actual committed predecessor`);
  return model;
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
  assert.equal(businessModel.ref.version, '14');
});

test('exact additive predecessors retain their original facts, revisions and provenance after integration', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const old = new OntologyObjectStore(db, predecessor());
    old.ingest('owner', { objects: rows, links }, source);
    const before = db.prepare('SELECT * FROM ontology_objects ORDER BY type').all();
    const graph = new OntologyObjectStore(db);
    for (const row of rows) assert.deepEqual(graph.read('owner', row.ref).properties, row.properties);
    const after = db.prepare('SELECT * FROM ontology_objects ORDER BY type').all();
    assert.deepEqual(after.map(({ definition_digest: _digest, ...row }) => row), before.map(({ definition_digest: _digest, ...row }) => row));
    new OntologyObjectStore(db);
    assert.deepEqual(db.prepare('SELECT * FROM ontology_objects ORDER BY type').all(), after);
    assert.throws(() => graph.read('other-owner', rows[0]!.ref), /not found/);
  } finally { db.close(); }
});

test('unknown definitions roll back both integration and business-chain migrations', () => {
  const db = new DatabaseSync(':memory:');
  try {
    new OntologyObjectStore(db, predecessor()).ingest('owner', { objects: rows, links }, source);
    db.prepare("UPDATE ontology_objects SET definition_digest=? WHERE type='RegisteredCapability'").run(digest('unknown'));
    const before = db.prepare('SELECT * FROM ontology_objects ORDER BY type').all();
    assert.throws(() => new OntologyObjectStore(db), /Unknown predecessor/);
    assert.deepEqual(db.prepare('SELECT * FROM ontology_objects ORDER BY type').all(), before);
  } finally { db.close(); }
});

test('old schema fingerprints cannot be used to add new facts during migration', () => {
  const db = new DatabaseSync(':memory:');
  try {
    new OntologyObjectStore(db, predecessor()).ingest('owner', { objects: rows, links }, source);
    const row = db.prepare("SELECT body FROM ontology_objects WHERE type='SourceReceipt'").get()!;
    const body = JSON.parse(String(row.body)); body.properties.evidenceLevel = 'provider_test';
    db.prepare("UPDATE ontology_objects SET body=? WHERE type='SourceReceipt'").run(JSON.stringify(body));
    assert.throws(() => new OntologyObjectStore(db), /pinned predecessor/);
  } finally { db.close(); }
});

test('legacy checkout without mandatory cost evidence is never relabeled as a current checkout', () => {
  const db = new DatabaseSync(':memory:');
  try {
    new OntologyObjectStore(db, predecessor());
    const definition = 'bc609fb81fe874bebab53a641e6e191964d4783d664219f7cfadbac2a791e77e';
    const body = JSON.stringify({ properties: { id: 'legacy', displayTitle: 'Historical checkout' }, source, createdAt: at });
    db.prepare('INSERT INTO ontology_objects VALUES(?,?,?,?,?,?)').run('owner', 'CheckoutSession', 'legacy', 1, definition, body);
    const graph = new OntologyObjectStore(db);
    assert.throws(() => graph.read('owner', { type: 'CheckoutSession', id: 'legacy' }), /historical data cannot be reinterpreted/);
    assert.equal(db.prepare("SELECT definition_digest FROM ontology_objects WHERE type='CheckoutSession'").get()!.definition_digest, definition);
  } finally { db.close(); }
});
