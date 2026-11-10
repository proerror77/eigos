import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { RollingGoProgram } from '../packages/capabilities/rollinggo/program.js';
import type { AgentActionContext } from '../packages/core/agent-program.js';
import { digest } from '../packages/core/delegation.js';
import { createEffectCoverageKernelDefinition } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { identityFunctionDefinitionsV2, identityTypes } from '../packages/ontology/identity-model.js';
import { entityIdentityAssertionSchema, pinIdentityEndpoint, projectEntityIdentityAssertion } from '../packages/ontology/identity-mapping.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import type { ObjectRef } from '../packages/ontology/model.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';

const previous = createEffectCoverageKernelDefinition();
const historicalModel = compileOntologyDocument(previous.document, previous.registry);
// Exercise the exact forward identity contracts independently of other v34
// features. Historical source definitions, schemas and projections are reused.
const document = structuredClone(previous.document);
for (const definition of identityFunctionDefinitionsV2) {
  document.functions[document.functions.findIndex(value => value.id === definition.id)] = {
    ...definition, handlerRef: previous.registry.registerFunction(definition),
  };
}
previous.registry.protect(document);
const model = compileOntologyDocument(document, previous.registry);
const owner = JSON.stringify(['local-development', 'local', 'developer']);
const baseTime = Date.parse('2026-11-10T01:00:00.000Z');
const hotels = [
  { hotelId: 1, name: 'Synthetic Taipei Hotel', address: 'Synthetic first address', price: { hasPrice: true, lowestPrice: 80, currency: 'USD' } },
  { hotelId: 2, name: 'Synthetic Kaohsiung Hotel', address: 'Synthetic second address', price: { hasPrice: true, lowestPrice: 90, currency: 'USD' } },
];

function fixture() {
  const db = new DatabaseSync(':memory:');
  let now = baseTime;
  const graph = new OntologyObjectStore(db, model, () => now);
  const oldGraph = new OntologyObjectStore(db, historicalModel, () => now);
  const source = () => ({ kind: 'synthetic' as const, id: 'identity-source-fixture', observedAt: new Date(now).toISOString() });
  const request: ServiceRequest = { id: randomUUID(), revision: 1, originalGoal: 'Synthetic hotel identity evidence only', requirements: [], messages: [] };
  const root = { type: 'ServiceRequest', id: request.id };
  graph.ingest(owner, { objects: [{ ref: root, properties: { requestId: root.id, displayTitle: request.originalGoal, originalGoal: request.originalGoal, revision: 1 } }] }, source());
  const input = { originQuery: 'Taiwan hotels', place: 'Taiwan', placeType: 'city', checkInParam: { checkInDate: '2099-01-01', stayNights: 1, adultCount: 2 }, localeParam: { currency: 'USD', language: 'en' }, size: 3 };
  const program = new RollingGoProgram({ keyFile: '/synthetic/key', keySha256: 'a'.repeat(64), evidenceKind: 'fixture', connector: {
    search: async () => ({ hotels: structuredClone(hotels), observedAt: new Date(now).toISOString(), priceKind: 'reference', providerExpiry: 'unknown' }),
  } });
  const initialized = program.initialize(graph, owner, request, input);
  const context: AgentActionContext = {
    graph, owner, request, state: { version: '2', programRef: program.ref, programDigest: program.configurationDigest,
      scope: initialized.scope, input: initialized.input, requestRevision: 1, plans: [], observations: [], feedback: [] },
    planId: randomUUID(), intentId: randomUUID(), attemptId: randomUUID(), modelRunId: randomUUID(),
  };
  const observe = async () => {
    now += 1000;
    const action = 'SearchRollingGoHotels', args = { scope: initialized.scope };
    const result = await program.invoke(context, action, args, new AbortController().signal);
    const observation = program.project(context, action, args, result);
    const subjects = graph.related(owner, observation, 'hotels', { remaining: 1000 })!;
    return { observation, subjects, endpoints: () => subjects.map(subject => pinIdentityEndpoint(graph, owner, subject.ref, observation)) };
  };
  const assertion = (left: ReturnType<typeof pinIdentityEndpoint>, right: ReturnType<typeof pinIdentityEndpoint>) => entityIdentityAssertionSchema.parse({
    schemaVersion: '1', ownerDigest: digest(owner), identityKind: 'hotel_property', left, right,
    relation: 'different', lifecycle: 'active', issuerIdentity: 'synthetic-crosswalk', sourceVersion: 1,
    basis: { kind: 'issuer_verified_identifiers', reference: 'synthetic-distinct-property-identifiers' },
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(), reason: 'Synthetic explicit property distinction',
  });
  const map = (value: ReturnType<typeof assertion>) => projectEntityIdentityAssertion(graph, owner, value, {
    sourceIdentity: value.issuerIdentity, sourceEventId: `identity:${value.sourceVersion}`, assertionDigest: digest(value), observedAt: value.observedAt, evidenceLevel: 'synthetic',
  });
  const status = (object: ObjectRef) => (graph.evaluate(owner, { function: 'entityIdentityStatus', object }).value as { status: string }).status;
  return { db, graph, oldGraph, source, observe, assertion, map, status, advance: (milliseconds: number) => { now += milliseconds; } };
}

test('forward identity discovery advertises only supported types and preserves the v33 contract', () => {
  assert.equal(previous.audit.model.digest, '5a721eaa695d262725ad3d515c3ff8e098d0858011e55ca4e3a31e84bc6b08a0');
  assert.equal(historicalModel.functionDefinitions().find(value => value.id === 'entityIdentityBetween')!.version, '1');
  assert(model.implements('Event', 'IdentitySubject'), 'The generic observation subject contract is retained');
  assert(!model.functionsFor(['Event']).some(value => value.id === 'entityIdentityBetween'));
  for (const type of Object.values(identityTypes)) assert(model.functionsFor([type]).some(value => value.id === 'entityIdentityBetween' && value.version === '2'));
  for (const object of previous.document.objects) assert.equal(model.fingerprint(object.id), historicalModel.fingerprint(object.id));
});

test('actual RollingGo projection supplies a v2 identity endpoint without a fabricated domain observation', async () => {
  const f = fixture();
  try {
    const observed = await f.observe(), endpoint = observed.endpoints()[0]!;
    assert.equal(f.graph.query(owner, { type: 'HotelPropertyObservation' }).items.length, 0);
    assert.deepEqual(f.graph.related(owner, endpoint.object, 'currentObservation', { remaining: 1000 }), []);
    assert.equal(endpoint.sourceIdentity, 'rollinggo-mcp:international');
    assert.equal(endpoint.sourceRecordId, String(observed.subjects[0]!.properties.sourceId));
    const snapshot = f.graph.read(owner, observed.observation).properties.snapshot as { contentDigest: string };
    assert.equal(endpoint.sourceVersion, snapshot.contentDigest, 'Evidence version is the original content digest, not a guessed source revision');
    assert.throws(() => pinIdentityEndpoint(f.oldGraph, owner, endpoint.object, observed.observation), /does not bind the current domain object/);
    assert.throws(() => pinIdentityEndpoint(f.graph, 'another-owner', endpoint.object, observed.observation));
  } finally { f.db.close(); }
});

test('RollingGo identity assertions retain explicit distinction and revocation without merging hotels or transferring terms', async () => {
  const f = fixture();
  try {
    const observed = await f.observe(), [left, right] = observed.endpoints();
    const assertion = f.assertion(left!, right!), first = f.map(assertion);
    assert.equal(f.status(first), 'different');
    assert.equal((f.oldGraph.evaluate(owner, { function: 'entityIdentityStatus', object: first }).value as { status: string }).status, 'unknown', 'A legacy v1 evaluator does not adopt the v2 evidence resolver');
    const between = f.graph.evaluate(owner, { function: 'entityIdentityBetween', object: left!.object, other: right!.object, identityKind: 'hotel_property' });
    assert.equal((between.value as { status: string }).status, 'different');
    assert.equal((between.value as { mergesObjects: boolean }).mergesObjects, false);
    f.advance(1000);
    const revoked = entityIdentityAssertionSchema.parse({ ...assertion, sourceVersion: 2, lifecycle: 'revoked', supersedes: first,
      observedAt: new Date(baseTime + 2000).toISOString(), reason: 'Synthetic issuer withdrew its distinction' });
    const successor = f.map(revoked);
    assert.equal(f.status(successor), 'revoked');
    assert.equal(f.status(first), 'revoked');
    assert.equal(f.graph.query(owner, { type: 'HotelProperty' }).items.length, 2);
    assert.equal(f.graph.query(owner, { type: 'RoomInventory' }).items.length, 0);
    assert.equal(f.graph.query(owner, { type: 'Order' }).items.length, 0);
  } finally { f.db.close(); }
});

test('a newer RollingGo receipt invalidates old identity endpoints even when hotel properties are unchanged', async () => {
  const f = fixture();
  try {
    const first = await f.observe(), [left, right] = first.endpoints(), assertion = f.map(f.assertion(left!, right!));
    const second = await f.observe();
    assert.equal(second.subjects[0]!.revision, first.subjects[0]!.revision);
    assert.throws(() => first.endpoints(), /does not bind the current hotel/);
    assert.equal(f.status(assertion), 'unknown');
    assert.notEqual(second.endpoints()[0]!.sourceVersion, left!.sourceVersion);
  } finally { f.db.close(); }
});

test('changed properties, withdrawn source receipts and expired searches cannot support RollingGo identity', async t => {
  for (const scenario of ['properties', 'resealed_properties', 'receipt', 'expiry'] as const) await t.test(scenario, async () => {
    const f = fixture();
    try {
      const observed = await f.observe(), [left, right] = observed.endpoints(), assertion = f.map(f.assertion(left!, right!));
      if (scenario === 'properties' || scenario === 'resealed_properties') {
        const subject = f.graph.read(owner, left!.object);
        const properties = { ...subject.properties, hotelName: 'Changed without source evidence' };
        f.graph.ingest(owner, { objects: [{ ref: subject.ref, expectedRevision: subject.revision, properties }] }, f.source());
        if (scenario === 'resealed_properties') {
          const receipt = f.graph.read(owner, left!.receipt);
          const subjects = receipt.properties.subjects as { object: ObjectRef; digest: string; linksDigest: string }[];
          f.graph.ingest(owner, { objects: [{ ref: receipt.ref, expectedRevision: receipt.revision,
            properties: { ...receipt.properties, subjects: subjects.map(value => digest(value.object) === digest(subject.ref) ? { ...value, digest: digest(properties) } : value) } }] }, f.source());
        }
      } else if (scenario === 'receipt') {
        f.graph.ingest(owner, { objects: [], removeLinks: [{ type: 'HotelPropertyEvidence', from: left!.object, to: left!.receipt }] }, f.source());
      } else f.advance(300001);
      assert.throws(() => pinIdentityEndpoint(f.graph, owner, left!.object, observed.observation), /stale or out of scope|does not bind the current hotel|changed outside its source observation/);
      assert.equal(f.status(assertion), 'unknown');
    } finally { f.db.close(); }
  });
});
