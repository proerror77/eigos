import { objectRefSchema } from '../packages/ontology/model.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../packages/core/delegation.js';
import { businessModel, businessModelV9 } from '../packages/ontology/business-model.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { setup, bookChoice } from './fixtures/paotui-agent.js';
import { owner } from './backend-fixture.js';
import { createSeedDefinition } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { migrateIntegratedOntology } from '../packages/ontology/integration-migration.js';
const seed = createSeedDefinition(), migrationModel = compileOntologyDocument(seed.document, seed.registry);
function migrateGraph(db: DatabaseSync) { const graph = new OntologyObjectStore(db, migrationModel, Date.now, undefined, { skipLegacyMigration: true }); migrateIntegratedOntology(db, businessModelV9, migrationModel); return graph; }

const at = '2026-10-20T03:00:00.000Z';
test('known v9 business definitions migrate atomically and idempotently without rewriting facts or granting authority', () => {
  const db = new DatabaseSync(':memory:');
  try {
    new OntologyObjectStore(db, businessModelV9);
    const rows = [
      { type: 'Proposal', id: 'proposal', properties: { proposalId: 'proposal', displayTitle: 'Old quote selection', requestRevision: 1, selectedAt: at, termsVersion: 'original', decisionReason: 'Original buyer decision' } },
      { type: 'Authorization', id: 'authorization', properties: { authorizationId: 'authorization', displayTitle: 'Historical record', actor: 'original', allowedActions: ['read'], dataScope: ['request'], limits: { minor: '0', currency: 'CNY' }, expiresAt: at, revoked: false } },
      { type: 'OutcomeAssessment', id: 'assessment', properties: { assessmentId: 'assessment', displayTitle: 'Historical verdict', requestRevision: 1, judgment: 'unknown', assessedAt: at, criterionResults: [] } },
      { type: 'RequestSpecification', id: 'specification', properties: { id: 'specification', displayTitle: 'Original request', requestRevision: 1, requestDigest: digest({}), instructionCount: 0, constraintCount: 0, confirmedInputDigests: {} } },
    ];
    for (const row of rows) {
      businessModelV9.parseProperties(row.type, row.properties);
      db.prepare('INSERT INTO ontology_objects VALUES(?,?,?,?,?,?)').run(owner, row.type, row.id, 7, businessModelV9.fingerprint(row.type), JSON.stringify({ properties: row.properties, source: { kind: 'task', id: 'original', observedAt: at }, createdAt: at }));
    }
    db.prepare('INSERT INTO ontology_links VALUES(?,?,?,?,?,?,?)').run(owner, 'ProposalOffer', 'Proposal', 'proposal', 'ProductOffer', 'old-offer', digest(businessModelV9.link('ProposalOffer')));
    const before = db.prepare('SELECT type,id,revision,body FROM ontology_objects ORDER BY type').all();
    const graph = migrateGraph(db);
    assert.deepEqual(db.prepare('SELECT type,id,revision,body FROM ontology_objects ORDER BY type').all(), before);
    for (const row of rows) assert.deepEqual(graph.read(owner, { type: row.type, id: row.id }).properties, row.properties);
    assert.equal(graph.evaluate(owner, { function: 'authorizationStatus', object: { type: 'Authorization', id: 'authorization' } }).value, 'unknown');
    assert.equal(graph.query(owner, { type: 'BusinessDecision' }).items.length, 0, 'Migration invents no past actions');
    assert.equal(graph.query(owner, { type: 'ExecutionAttempt' }).items.length, 0, 'Migration never replays execution');
    const after = db.prepare('SELECT * FROM ontology_objects ORDER BY type').all();
    migrateGraph(db);
    assert.deepEqual(db.prepare('SELECT * FROM ontology_objects ORDER BY type').all(), after);
    assert.equal(db.prepare('SELECT definition_digest FROM ontology_links').get()!.definition_digest, digest(migrationModel.link('ProposalOffer')));
  } finally { db.close(); }
});

test('an unknown predecessor aborts the complete migration, including earlier valid rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    new OntologyObjectStore(db, businessModelV9);
    for (const [type, id, definition] of [['Proposal', 'p', businessModelV9.fingerprint('Proposal')], ['Authorization', 'a', digest('unrecognized-definition')]]) {
      const properties = type === 'Proposal' ? { proposalId: id, displayTitle: 'Original' } : { authorizationId: id, displayTitle: 'Unrecognized' };
      db.prepare('INSERT INTO ontology_objects VALUES(?,?,?,?,?,?)').run(owner, type!, id!, 1, definition!, JSON.stringify({ properties, source: { kind: 'task', id: 'original', observedAt: at }, createdAt: at }));
    }
    const before = db.prepare('SELECT * FROM ontology_objects ORDER BY type').all();
    assert.throws(() => migrateGraph(db), /Unknown predecessor/);
    assert.deepEqual(db.prepare('SELECT * FROM ontology_objects ORDER BY type').all(), before);
  } finally { db.close(); }
});

test('authorization status uses the current clock and preserves revoked and legacy-unknown states', () => {
  const db = new DatabaseSync(':memory:'); let now = Date.parse(at);
  try {
    const graph = new OntologyObjectStore(db, businessModel, () => now);
    const request = { type: 'ServiceRequest', id: 'request' }, proposal = { type: 'Proposal', id: 'proposal' }, authorization = { type: 'Authorization', id: 'grant' };
    const properties = { authorizationId: 'grant', displayTitle: 'Projected sandbox permit', kind: 'plan_grant', approvedAt: at,
      ledgerDigest: digest('original-ledger-record'), revoked: false, expiresAt: new Date(now + 1000).toISOString(), environment: 'sandbox' };
    const source = { kind: 'task' as const, id: 'request', observedAt: at };
    graph.ingest(owner, { objects: [
      { ref: request, properties: { requestId: 'request', displayTitle: 'Request', originalGoal: 'Synthetic goal' } },
      { ref: proposal, properties: { proposalId: 'proposal', displayTitle: 'Unpriced service', kind: 'execution' } },
      { ref: authorization, properties },
    ], links: [{ type: 'ProposalRequest', from: proposal, to: request }, { type: 'AuthorizationProposal', from: authorization, to: proposal }] }, source);
    const status = () => graph.evaluate(owner, { function: 'authorizationStatus', object: authorization }).value;
    assert.equal(status(), 'active'); now += 1001; assert.equal(status(), 'expired');
    graph.ingest(owner, { objects: [{ ref: authorization, properties: { ...properties, revoked: true, revokedAt: new Date(now).toISOString() }, expectedRevision: 1 }] }, source);
    assert.equal(status(), 'revoked');
    assert.throws(() => graph.ingest(owner, { objects: [{ ref: { type: 'Proposal', id: 'missing-offer' }, properties: { proposalId: 'missing-offer', displayTitle: 'Buyer selection', kind: 'offer_selection' } }],
      links: [{ type: 'ProposalRequest', from: { type: 'Proposal', id: 'missing-offer' }, to: request }] }, source), /selected offer/);
  } finally { db.close(); }
});

test('agent-owned read goal connects requester, scope proposal, exact observed results and independent acceptance without a fabricated permit', async () => {
  const f = setup(bookChoice, 'addresses');
  try {
    const job = f.b.submit({ goal: '本人地址簿查询' }); assert.equal((await f.finish(job.id)).state, 'completed');
    const graph = f.store.ontology, request = { type: 'ServiceRequest', id: job.id };
    const related = (ref: typeof request, link: string) => graph.query(owner, { from: ref, link, limit: 50 }).items;
    assert.equal(related(request, 'requester').length, 1);
    const proposal = related(request, 'proposals')[0]!;
    assert.equal(proposal.properties.kind, 'read_scope'); assert.equal(proposal.properties.authorizationMode, 'not_required');
    assert.equal(related(proposal.ref, 'authorizations').length, 0);
    assert.equal(related(proposal.ref, 'executionContext').length, 1);
    const results = related(proposal.ref, 'businessResults'); assert.equal(results.length, 1);
    assert.equal(results[0]!.properties.evidenceLevel, 'synthetic');
    assert.equal(related(results[0]!.ref, 'subjects')[0]!.ref.type, 'PaotuiObservation');
    assert.equal(related(results[0]!.ref, 'sourceReceipts').length, 1);
    const currentAssessment = objectRefSchema.parse(graph.read(owner, request).properties.currentAssessment);
    const assessment = related(proposal.ref, 'assessments').find(value => value.ref.type === currentAssessment.type && value.ref.id === currentAssessment.id); assert(assessment, 'Current assessment must belong to the original proposal');
    assert.equal(assessment.properties.judgment, 'satisfied'); assert(related(assessment.ref, 'findings').length > 0);
    assert.equal(related(assessment.ref, 'acceptedArtifact').length, 1);
    assert.throws(() => graph.query('different-owner', { from: proposal.ref, link: 'businessResults' }), /not found/);
    const before = graph.query(owner, { type: 'BusinessDecision', limit: 50 }).items;
    f.store.save(owner, f.store.get(owner, job.id));
    assert.deepEqual(graph.query(owner, { type: 'BusinessDecision', limit: 50 }).items, before, 'Readback/reprojection does not create another business decision');
  } finally { f.store.close(); }
});
