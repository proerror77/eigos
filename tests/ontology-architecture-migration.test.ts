import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { BUSINESS_MODEL_DEFINITION, businessModel, businessModelV9 } from '../packages/ontology/business-model.js';
import { digest } from '../packages/core/delegation.js';
import { ownerKey, SCOPES } from '../packages/core/domain.js';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';
import { OntologyModel } from '../packages/ontology/model.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { FROZEN_V14, integrationPredecessor, parseHistoricalProperties } from '../packages/ontology/history-schema.js';
import { INTEGRATION_PREDECESSORS, migrateIntegratedOntology } from '../packages/ontology/integration-migration.js';
import pins from './fixtures/ontology-v14-fingerprints.json' with { type: 'json' };
import examples from './fixtures/ontology-v14-migration-objects.json' with { type: 'json' };

const at = '2026-10-20T10:00:00.000Z';
const source = { kind: 'synthetic' as const, id: 'frozen-v14-original-observation', observedAt: at };
type OldRow = { type: string; id: string; properties: Record<string, unknown> };
const oldRows = examples.rows as OldRow[];
const rowFor = (type: string): OldRow => structuredClone(oldRows.find(row => row.type === type)!);
function insert(db: DatabaseSync, row: OldRow, fingerprint = FROZEN_V14.objects[row.type]!.fingerprint, owner = 'original-owner') {
  db.prepare('INSERT INTO ontology_objects VALUES(?,?,?,?,?,?)').run(owner, row.type, row.id, 7, fingerprint,
    JSON.stringify({ properties: row.properties, source, createdAt: at }, null, 2));
}
const objects = (db: DatabaseSync) => db.prepare('SELECT * FROM ontology_objects ORDER BY owner,type,id').all();
const links = (db: DatabaseSync) => db.prepare('SELECT * FROM ontology_links ORDER BY owner,type,from_id,to_id').all();
const revisions = (db: DatabaseSync) => db.prepare('SELECT * FROM ontology_revisions ORDER BY owner').all();
const unchangedFacts = (rows: ReturnType<typeof objects>) => rows.map(({ definition_digest: _definition, ...record }) => record);
function database() { const db = new DatabaseSync(':memory:'); new OntologyObjectStore(db); return db; }

test('the v14 migration uses actual frozen schemas and independent pins for every changed old object/link', () => {
  assert.equal(pins.model.version, '14'); assert.equal(Object.keys(pins.objects).length, 137); assert.equal(Object.keys(pins.links).length, 575);
  assert.deepEqual(FROZEN_V14.model, pins.model); assert.deepEqual(examples.model, pins.model);
  const changed = Object.entries(pins.objects).filter(([type, pin]) => businessModel.fingerprint(type) !== pin);
  assert(changed.length >= 46);
  for (const [type, pin] of changed) {
    assert.equal(FROZEN_V14.objects[type]?.fingerprint, pin, `Missing frozen schema for ${type}`);
    assert.equal(digest(FROZEN_V14.objects[type]!.definition), pin);
    const row = rowFor(type); assert(row, `Missing fixed old facts for ${type}`);
    assert.deepEqual(parseHistoricalProperties(FROZEN_V14.objects[type]!, row.properties), row.properties);
  }
  for (const [type, pin] of Object.entries(pins.links)) {
    if (digest(businessModel.link(type)) !== pin) assert.equal(FROZEN_V14.links[type]?.digest, pin, `Missing frozen link for ${type}`);
  }
  for (const [type, object] of Object.entries(FROZEN_V14.objects)) assert.equal(object.fingerprint, (pins.objects as Record<string, string>)[type]);
  assert.equal(FROZEN_V14.objects.SourceReceipt!.definition.version, '4');
  assert(!(FROZEN_V14.objects.SourceReceipt!.definition.properties.scope!.schema.enum as string[]).includes('identity_mapping'));
  assert(!Object.hasOwn(FROZEN_V14.objects.RideRequest!.definition.properties, 'luggageCount'));
  assert(!Object.hasOwn(FROZEN_V14.objects.ExecutionInput!.definition.properties, 'candidateId'));
});

test('all affected v14 object definitions migrate atomically, preserving every fact/source byte, revision, owner and existing link', () => {
  const db = database();
  try {
    for (const row of oldRows) { parseHistoricalProperties(FROZEN_V14.objects[row.type]!, row.properties); insert(db, row); }
    insert(db, rowFor('Provider'), FROZEN_V14.objects.Provider!.fingerprint, 'second-owner');
    db.prepare('INSERT INTO ontology_revisions VALUES(?,?)').run('original-owner', 41);
    db.prepare('INSERT INTO ontology_revisions VALUES(?,?)').run('second-owner', 72);
    for (const [type, fromType, toType] of [['OfferRequest', 'DeliveryQuote', 'ServiceRequest'], ['OrderLineVariant', 'OrderLine', 'ProductVariant']] as const) {
      db.prepare('INSERT INTO ontology_links VALUES(?,?,?,?,?,?,?)').run('original-owner', type, fromType, rowFor(fromType).id, toType, rowFor(toType).id, (pins.links as Record<string, string>)[type]!);
    }
    const before = objects(db), beforeLinks = links(db), beforeRevisions = revisions(db), graph = new OntologyObjectStore(db);
    const after = objects(db);
    assert.deepEqual(unchangedFacts(after), unchangedFacts(before)); assert.deepEqual(links(db), beforeLinks); assert.deepEqual(revisions(db), beforeRevisions);
    for (const row of oldRows) {
      assert.equal(after.find(record => record.type === row.type && record.owner === 'original-owner')!.definition_digest, businessModel.fingerprint(row.type));
      assert.deepEqual(graph.read('original-owner', { type: row.type, id: row.id }).properties, row.properties);
    }
    new OntologyObjectStore(db); assert.deepEqual(objects(db), after); assert.deepEqual(links(db), beforeLinks); assert.deepEqual(revisions(db), beforeRevisions);
    assert.throws(() => graph.read('third-owner', { type: 'Provider', id: rowFor('Provider').id }), /not found/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM ontology_objects WHERE type LIKE 'Network%'").get()!.n, 0, 'Migration creates no network authority or facts');
  } finally { db.close(); }
});

test('a v14 fingerprint cannot smuggle new optional fields, nested product attributes or new source-scope enum values', () => {
  const additions: [string, Record<string, unknown>][] = [
    ['RideRequest', { luggageCount: 2 }], ['VehicleRequest', { wheelchairRequired: true }],
    ['ExecutionInput', { candidateId: 'new-candidate-under-old-pin' }],
    ['ProductVariant', { typedAttributes: { schemaVersion: '1', profile: 'general_goods', condition: 'new' } }],
    ['SourceReceipt', { scope: 'identity_mapping' }],
  ];
  for (const [type, fields] of additions) {
    const db = database(); try {
      const old = rowFor(type); old.properties = { ...old.properties, ...fields };
      assert.deepEqual(businessModel.parseProperties(type, old.properties), old.properties, `${type}: new facts are valid only under a new definition`);
      insert(db, rowFor('Provider')); insert(db, old); const before = objects(db);
      assert.throws(() => new OntologyObjectStore(db), /pinned predecessor schema/); assert.deepEqual(objects(db), before);
    } finally { db.close(); }
  }
  const db = database(); try {
    const old = rowFor('CatalogObservation'), snapshot = old.properties.snapshot as Record<string, unknown>;
    snapshot.items = [{ productId: 'original-product', variantId: 'gid://shopify/ProductVariant/1', title: 'Original title', typedAttributes: { schemaVersion: '1', profile: 'general_goods', color: 'black' } }];
    businessModel.parseProperties(old.type, old.properties); insert(db, old); const before = objects(db);
    assert.throws(() => new OntologyObjectStore(db), /pinned predecessor schema/); assert.deepEqual(objects(db), before);
  } finally { db.close(); }
});

test('known pre-integration pins also reject fields and scopes added after their real frozen schema', () => {
  const db = database(); try {
    const old = rowFor('SourceReceipt'); old.properties.scope = 'identity_mapping';
    const pin = INTEGRATION_PREDECESSORS.SourceReceipt![0]!;
    assert.equal(integrationPredecessor('SourceReceipt', pin).definition.version, '4');
    businessModel.parseProperties(old.type, old.properties); insert(db, rowFor('Provider')); insert(db, old, pin);
    const before = objects(db); assert.throws(() => new OntologyObjectStore(db), /pinned predecessor schema/); assert.deepEqual(objects(db), before);
  } finally { db.close(); }
});

test('unknown v14 predecessors, primary-key mismatches and invalid old bodies never bless earlier valid rows', () => {
  for (const mode of ['unknown', 'primary-key', 'old-schema', 'body'] as const) {
    const db = database(); try {
      insert(db, rowFor('AppointmentRequest')); const record = rowFor('SourceReceipt');
      if (mode === 'primary-key') record.properties.receiptId = 'another-row-identity';
      if (mode === 'old-schema') record.properties.unregisteredOldFact = 'not in v14';
      insert(db, record, mode === 'unknown' ? digest('unknown-schema') : FROZEN_V14.objects.SourceReceipt!.fingerprint);
      if (mode === 'body') db.prepare("UPDATE ontology_objects SET body='not-json' WHERE type='SourceReceipt'").run();
      const before = objects(db); assert.throws(() => new OntologyObjectStore(db), /Unknown predecessor|change recorded facts|pinned predecessor schema|Invalid historical object body/);
      assert.deepEqual(objects(db), before);
    } finally { db.close(); }
  }
});

test('frozen old validity is insufficient when the new schema would reject or transform the original facts', () => {
  const db = database(); try {
    const old = rowFor('Provider'); parseHistoricalProperties(FROZEN_V14.objects.Provider!, old.properties); insert(db, old);
    const stricter = new OntologyModel({ ...BUSINESS_MODEL_DEFINITION, objects: BUSINESS_MODEL_DEFINITION.objects.map(type => type.id === 'Provider'
      ? { ...type, properties: { ...type.properties, displayTitle: { ...type.properties.displayTitle!, schema: z.literal('new-only-title') } } } : type) });
    const before = objects(db); assert.throws(() => migrateIntegratedOntology(db, businessModelV9, stricter), /properties violate/); assert.deepEqual(objects(db), before);
    const addsDefault = new OntologyModel({ ...BUSINESS_MODEL_DEFINITION, objects: BUSINESS_MODEL_DEFINITION.objects.map(type => type.id === 'Provider'
      ? { ...type, properties: { ...type.properties, newDefault: { kind: 'string' as const, schema: z.string().default('invented'), description: 'Must not be invented for historical facts', source: 'test only', required: true } } } : type) });
    assert.throws(() => migrateIntegratedOntology(db, businessModelV9, addsDefault), /change recorded facts/); assert.deepEqual(objects(db), before);
  } finally { db.close(); }
});

test('a later integration or business-chain error rolls back the prior architecture pass and every earlier definition update', () => {
  for (const later of ['integration', 'business-chain', 'link'] as const) {
    const db = database(); try {
      insert(db, rowFor('Provider'));
      const request = { type: 'ServiceRequest', id: 'earlier-request', properties: { requestId: 'earlier-request', displayTitle: 'Old request', originalGoal: 'Original private instruction' } };
      insert(db, request, INTEGRATION_PREDECESSORS.ServiceRequest![0]!);
      const proposal = { type: 'Proposal', id: 'old-proposal', properties: { proposalId: 'old-proposal', displayTitle: 'Earlier valid proposal' } };
      insert(db, proposal, businessModelV9.fingerprint('Proposal'));
      if (later === 'integration') insert(db, rowFor('RegisteredCapability'), digest('unknown-integration-definition'));
      if (later === 'business-chain') insert(db, { type: 'Authorization', id: 'unknown-authorization', properties: { authorizationId: 'unknown-authorization', displayTitle: 'Unknown historical authorization' } }, digest('unknown-business-chain-definition'));
      if (later === 'link') db.prepare('INSERT INTO ontology_links VALUES(?,?,?,?,?,?,?)').run('original-owner', 'ProposalOffer', 'Proposal', proposal.id, 'ProductOffer', 'historical-target', digest('unknown-link-definition'));
      const before = objects(db), beforeLinks = links(db);
      assert.throws(() => new OntologyObjectStore(db), /Unknown predecessor/);
      assert.deepEqual(objects(db), before); assert.deepEqual(links(db), beforeLinks);
    } finally { db.close(); }
  }
});

test('metadata migration leaves historical backend-v15 tasks byte-identical and unclaimable by the new Worker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-architecture-history-')), path = join(dir, 'business.sqlite');
  let store: JobStore | undefined, db: DatabaseSync | undefined;
  try {
    assert.notEqual(BACKEND_VERSION, 'ontology-execution-v15');
    store = new JobStore(path); const catalog = new ExecutionCatalog([], [], []), tasks = new TaskService(store, { catalog });
    const principal = { issuer: 'local-development', tenant: 'local', subject: 'developer', clientId: 'historical-fixture', scopes: [...SCOPES] }, owner = ownerKey(principal);
    const task = tasks.submit(principal, { goal: 'Historical v15 task must not replay', requestId: 'historical-migration-fixture' });
    store.close(); store = undefined; db = new DatabaseSync(path);
    db.prepare("UPDATE jobs SET body=json_set(body,'$.delegation.backendVersion','ontology-execution-v15') WHERE id=?").run(task.id);
    const root = db.prepare("SELECT * FROM ontology_objects WHERE owner=? AND type='ServiceRequest' AND id=?").get(owner, task.id)!;
    const oldProperties = JSON.parse(String(root.body)).properties; parseHistoricalProperties(FROZEN_V14.objects.ServiceRequest!, oldProperties);
    db.prepare("UPDATE ontology_objects SET definition_digest=? WHERE owner=? AND type='ServiceRequest' AND id=?").run(FROZEN_V14.objects.ServiceRequest!.fingerprint, owner, task.id);
    const before = db.prepare('SELECT * FROM jobs WHERE id=?').get(task.id), beforeObjects = unchangedFacts(objects(db));
    store = new JobStore(path); const current = new TaskService(store, { catalog });
    assert.equal(current.get(principal, task.id).id, task.id); assert.equal(store.claim(['eigos.delegate'], 15000), undefined);
    assert.throws(() => current.cancel(principal, task.id), /Historical backend tasks are read-only/);
    assert.deepEqual(db.prepare('SELECT * FROM jobs WHERE id=?').get(task.id), before); assert.deepEqual(unchangedFacts(objects(db)), beforeObjects);
    assert.equal(db.prepare('SELECT count(*) AS n FROM action_intents').get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM action_attempts').get()!.n, 0);
  } finally { store?.close(); db?.close(); rmSync(dir, { recursive: true, force: true }); }
});
