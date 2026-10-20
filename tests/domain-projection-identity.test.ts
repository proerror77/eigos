import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { domainCapabilityId, projectDomainSnapshot, publicDomainEntities, type DomainSnapshot } from '../packages/ontology/domain-projection.js';
import { domainFixture } from './fixtures/service-domains.js';
import type { ServiceDomain } from '../packages/ontology/service-domains.js';
import { sourceProof } from '../packages/ontology/object-evidence.js';
import { OntologyPlanningSession } from '../packages/coordinator/planning-session.js';
import { projectExecution } from '../packages/ontology/execution-projection.js';
import { BACKEND_VERSION, type ServiceRequest } from '../packages/ontology/execution.js';
import type { Job } from '../packages/core/domain.js';

function fixture(domain: ServiceDomain = 'hotel') {
  const source = domainFixture(domain), db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, undefined, () => source.now);
  const owner = 'domain-identity-owner', request = { id: source.snapshot.requestId, revision: 1 };
  const provenance = { kind: 'synthetic' as const, id: 'fixture', observedAt: new Date(source.now).toISOString() };
  graph.ingest(owner, { objects: [{ ref: { type: 'ServiceRequest', id: request.id }, properties: { requestId: request.id, displayTitle: 'Synthetic request', originalGoal: 'Synthetic domain request', revision: 1 } }] }, provenance);
  const project = (snapshot: DomainSnapshot) => projectDomainSnapshot(graph, owner, domainCapabilityId(domain), request, source.parameters, snapshot);
  return { ...source, db, graph, owner, request, provenance, project };
}

test('provider-native option and resource IDs do not merge across providers, and eligibility uses each candidate resources', () => {
  const f = fixture();
  try {
    const first = structuredClone(f.snapshot), second = structuredClone(f.snapshot);
    first.sourceId = second.sourceId = 'shared-source'; first.option.providerId = 'provider-A'; second.option.providerId = 'provider-B';
    second.entities.find(e => e.type === 'RoomInventory')!.properties.roomsAvailable = 0;
    const a = f.project(first), b = f.project(second);
    assert.equal(a.state, 'typed_result'); assert.equal(b.state, 'typed_result'); assert.notDeepEqual(a.subject, b.subject);
    const options = f.graph.query(f.owner, { type: 'HotelOption' }).items; assert.equal(options.length, 2);
    const observations = f.graph.query(f.owner, { type: 'SourceEntityObservation', where: [{ property: 'providerIdentity', op: 'eq', value: 'provider-A' }] }).items;
    assert.equal(observations.length, 3); assert(observations.every(o => o.properties.providerIdentity === 'provider-A'));
    assert(f.graph.model.implements('RoomInventoryObservation', 'EvidenceBacked'));
    const aEntity = f.graph.related(f.owner, a.subject!, 'roomInventory', { remaining: 1000 })![0]!;
    const bEntity = f.graph.related(f.owner, b.subject!, 'roomInventory', { remaining: 1000 })![0]!;
    assert.notEqual(aEntity.ref.id, bEntity.ref.id); assert.equal(aEntity.properties.roomsAvailable, 1); assert.equal(bEntity.properties.roomsAvailable, 0);
    const aObservation = f.graph.related(f.owner, a.subject!, 'roomInventoryObservations', { remaining: 1000 })![0]!;
    const bObservation = f.graph.related(f.owner, b.subject!, 'roomInventoryObservations', { remaining: 1000 })![0]!;
    assert.equal(aObservation.properties.providerIdentity, 'provider-A'); assert.equal(bObservation.properties.providerIdentity, 'provider-B');
    assert(sourceProof(f.graph, f.owner, aEntity.ref, { remaining: 1000 }));
    assert(sourceProof(f.graph, f.owner, aObservation.ref, { remaining: 1000 }));
    const eligibility = (ref: NonNullable<typeof a.subject>) => (f.graph.evaluate(f.owner, { function: 'hotelEligibility', object: ref }).value as { status: string }).status;
    assert.equal(eligibility(a.subject!), 'unknown', 'bare native IDs cannot select between two source-qualified resource identities');
    assert.equal(eligibility(b.subject!), 'unsatisfied', 'explicit inventory contradiction still fails even when identity is ambiguous');
    const requirement = f.graph.related(f.owner, a.subject!, 'requirements', { remaining: 1000 })![0]!;
    assert.deepEqual(f.graph.related(f.owner, requirement.ref, 'roomInventory', { remaining: 1000 }), [], 'a source does not rewrite explicit user-selected resource links');
  } finally { f.db.close(); }
});

test('stable entities retain immutable observations and reject stale versions, conflicts and older timestamps atomically', () => {
  const f = fixture();
  try {
    const original = f.project(f.snapshot); assert.equal(original.state, 'typed_result');
    const first = f.graph.query(f.owner, { type: 'RoomInventory' }).items[0]!, firstObservation = f.graph.related(f.owner, first.ref, 'currentObservation', { remaining: 1000 })![0]!;
    const newer = structuredClone(f.snapshot); newer.sourceVersion = 2; newer.sourceEventId = 'version-2';
    Object.assign(newer.entities.find(e => e.type === 'RoomInventory')!.properties, { sourceRevision: '2', roomsAvailable: 0 });
    assert.equal(f.project(newer).state, 'typed_result');
    const current = f.graph.read(f.owner, first.ref); assert.equal(current.properties.roomsAvailable, 0); assert.equal(current.properties.sourceRevision, '2');
    assert.deepEqual(f.graph.read(f.owner, firstObservation.ref), firstObservation, 'earlier source observation is immutable');
    assert.equal(f.graph.related(f.owner, first.ref, 'sourceObservations', { remaining: 1000 })!.length, 2);
    const before = f.graph.revision(f.owner);
    assert.equal(f.project(f.snapshot).state, 'invalid_source');
    const conflict = structuredClone(newer); conflict.entities.find(e => e.type === 'RoomInventory')!.properties.roomsAvailable = 4;
    assert.equal(f.project(conflict).state, 'invalid_source');
    const olderTime = structuredClone(newer); olderTime.sourceVersion = 3;
    Object.assign(olderTime.entities.find(e => e.type === 'RoomInventory')!.properties, { sourceRevision: '3', observedAt: new Date(f.now - 10 * 60000).toISOString() });
    assert.equal(f.project(olderTime).state, 'invalid_source');
    assert.equal(f.graph.revision(f.owner), before); assert.deepEqual(f.graph.read(f.owner, first.ref), current);
    const oldEligibility = f.graph.evaluate(f.owner, { function: 'hotelEligibility', object: original.subject! }).value as { status: string };
    assert.equal(oldEligibility.status, 'unknown', 'a previously selected resource snapshot cannot silently consume a changed current entity');
  } finally { f.db.close(); }
});

test('explicit user resource selections are preserved and cannot be substituted by another source candidate', () => {
  const f = fixture();
  try {
    const first = f.project(f.snapshot), requirement = f.graph.related(f.owner, first.subject!, 'requirements', { remaining: 1000 })![0]!;
    const selected = f.graph.related(f.owner, first.subject!, 'hotelProperty', { remaining: 1000 })![0]!;
    f.graph.ingest(f.owner, { objects: [], links: [{ type: 'HotelRequestHotelProperty', from: requirement.ref, to: selected.ref }] }, f.provenance);
    const second = structuredClone(f.snapshot); second.sourceId = 'another-source';
    const projected = f.project(second); assert.equal(projected.state, 'typed_result');
    assert.equal(f.graph.related(f.owner, requirement.ref, 'hotelProperty', { remaining: 1000 })![0]!.ref.id, selected.ref.id);
    const result = f.graph.evaluate(f.owner, { function: 'hotelEligibility', object: projected.subject! }).value as { status: string; criteria: { id: string; result: string }[] };
    assert.equal(result.status, 'unsatisfied'); assert(result.criteria.some(c => c.id === 'hotelProperty_selection' && c.result === 'fail'));
  } finally { f.db.close(); }
});

test('patient resource observations expose provenance without copying private identity or contacts', () => {
  const f = fixture('appointment');
  try {
    const projected = f.project(f.snapshot); assert.equal(projected.state, 'typed_result');
    const patient = f.graph.related(f.owner, projected.subject!, 'patientProfile', { remaining: 1000 })![0]!;
    const observations = f.graph.related(f.owner, projected.subject!, 'patientProfileObservations', { remaining: 1000 })!;
    assert.equal(observations.length, 1); assert(!JSON.stringify(observations).includes('PRIVATE_')); assert(!JSON.stringify(patient).includes('PRIVATE_'));
    assert.equal(f.graph.readPrivate(f.owner, patient.ref).properties.identityDocument, 'PRIVATE_PATIENT_FIXTURE');
    assert(sourceProof(f.graph, f.owner, patient.ref, { remaining: 1000 }));
    assert(sourceProof(f.graph, f.owner, observations[0]!.ref, { remaining: 1000 }));
  } finally { f.db.close(); }
});

test('redacted readback of the same patient revision retains private identity without changing public evidence', () => {
  const f = fixture('appointment');
  try {
    const prepared = f.project(f.snapshot), patient = f.graph.related(f.owner, prepared.subject!, 'patientProfile', { remaining: 1000 })![0]!;
    const original = f.graph.readPrivate(f.owner, patient.ref);
    const followup = { ...f.snapshot, sourceEventId: 'final-readback', entities: publicDomainEntities(f.snapshot.entities), observation: f.result };
    assert.equal(f.project(followup).state, 'typed_result');
    assert.deepEqual(f.graph.readPrivate(f.owner, patient.ref).properties, original.properties);
    assert(sourceProof(f.graph, f.owner, patient.ref, { remaining: 1000 }));
    const snapshots = f.graph.related(f.owner, patient.ref, 'sourceObservations', { remaining: 1000 })!;
    assert(snapshots.length >= 2); assert(!JSON.stringify(snapshots).includes('PRIVATE_'));
    const conflict = structuredClone(followup);
    conflict.entities.find(e => e.type === 'PatientProfile')!.properties.identityDocument = 'changed-identity';
    assert.equal(f.project(conflict).state, 'invalid_source', 'an explicit conflicting private value is not a redaction');
  } finally { f.db.close(); }
});

test('two tasks can use the same cached hotel observation with independent request receipts and no cross-task expansion', () => {
  const f = fixture();
  try {
    const other = { id: `${f.request.id}-B`, revision: 1 }, rootA = { type: 'ServiceRequest', id: f.request.id }, rootB = { type: 'ServiceRequest', id: other.id };
    f.graph.ingest(f.owner, { objects: [{ ref: rootB, properties: { requestId: other.id, displayTitle: 'Second owned request', originalGoal: 'PRIVATE_OTHER_TASK_GOAL', revision: 1 } }] }, f.provenance);
    const a = f.project(f.snapshot); assert.equal(a.state, 'typed_result');
    const inventory = f.graph.related(f.owner, a.subject!, 'roomInventory', { remaining: 1000 })![0]!;
    const originalObservation = f.graph.related(f.owner, inventory.ref, 'currentObservation', { remaining: 1000 })![0]!;
    const originalOption = f.graph.read(f.owner, a.subject!);
    const b = projectDomainSnapshot(f.graph, f.owner, domainCapabilityId('hotel'), other, f.parameters, { ...f.snapshot, requestId: other.id });
    assert.equal(b.state, 'typed_result'); assert.notDeepEqual(a.subject, b.subject);
    assert.deepEqual(f.graph.read(f.owner, inventory.ref), inventory, 'A repeated cached read does not rewrite the shared resource');
    assert.deepEqual(f.graph.read(f.owner, originalObservation.ref), originalObservation);
    assert.deepEqual(f.graph.read(f.owner, a.subject!), originalOption, 'The first task keeps its original candidate');
    const status = (object: NonNullable<typeof a.subject>) => (f.graph.evaluate(f.owner, { function: 'hotelEligibility', object }).value as { status: string }).status;
    assert.equal(status(a.subject!), 'satisfied'); assert.equal(status(b.subject!), 'satisfied');
    assert.equal(f.graph.query(f.owner, { type: 'RoomInventory' }).items.length, 1);
    assert.equal(f.graph.query(f.owner, { type: 'RoomInventoryObservation' }).items.length, 1);

    const receiptsA = f.graph.related(f.owner, rootA, 'sourceReceipts', { remaining: 1000 })!;
    const receiptsB = f.graph.related(f.owner, rootB, 'sourceReceipts', { remaining: 1000 })!;
    assert.equal(receiptsA.length, 1); assert.equal(receiptsB.length, 1);
    assert.notEqual(receiptsA[0]!.ref.id, receiptsB[0]!.ref.id, 'Option evidence is bound to its own task');
    for (const ref of [inventory.ref, originalObservation.ref]) {
      const proof = sourceProof(f.graph, f.owner, ref, { remaining: 1000 }); assert(proof);
      for (const receipt of proof.refs) assert.deepEqual(f.graph.related(f.owner, receipt, 'request', { remaining: 1000 }), [], 'Shared source evidence does not inherit a task owner link');
    }
    const evaluationA = f.graph.evaluate(f.owner, { function: 'hotelEligibility', object: a.subject! });
    assert(!evaluationA.evidenceRefs.some(ref => ref.id === other.id || ref.id === b.subject!.id || receiptsB.some(receipt => receipt.ref.id === ref.id)));

    const current: ServiceRequest = { ...f.request, originalGoal: 'Synthetic domain request', requirements: [], messages: [{ id: 'original-message', text: 'Synthetic domain request', receivedAt: f.provenance.observedAt }] };
    const job: Job = { id: current.id, contextId: current.id, service: 'eigos.delegate', goal: current.originalGoal, state: 'working', revision: 1,
      createdAt: f.provenance.observedAt, updatedAt: f.provenance.observedAt, messages: [],
      delegation: { backendVersion: BACKEND_VERSION, request: current, phase: 'planning', events: [] } };
    projectExecution(f.graph, f.owner, job);
    const session = new OntologyPlanningSession(f.graph, f.owner, current, [], undefined, undefined, 'request', [a.subject!], { taskContext: { purpose: 'planning', refs: [a.subject!] } });
    const context = session.call('read_task_context', {}) as { data: { graph: { objects: { ref: { type: string; id: string } }[] } } };
    assert(context.data, JSON.stringify(context));
    assert(!JSON.stringify(context).includes(other.id)); assert(!JSON.stringify(context).includes('PRIVATE_OTHER_TASK_GOAL'));
    assert(!context.data.graph.objects.some(object => object.ref.type === 'ServiceRequest' && object.ref.id === other.id));
    const reverse = f.graph.model.sides(inventory.ref.type).find(side => side.direction === 'reverse' && side.other.type === 'HotelOption')!;
    assert.equal((session.call('query_ontology', { from: inventory.ref, link: reverse.side.name }) as { error: string }).error, 'FORBIDDEN');

    const updated = structuredClone(f.snapshot); updated.requestId = other.id; updated.sourceVersion = 2; updated.sourceEventId = 'updated-inventory';
    Object.assign(updated.entities.find(entity => entity.type === 'RoomInventory')!.properties, { sourceRevision: '2', roomsAvailable: 0 });
    const next = projectDomainSnapshot(f.graph, f.owner, domainCapabilityId('hotel'), other, f.parameters, updated); assert.equal(next.state, 'typed_result');
    const changed = f.graph.read(f.owner, inventory.ref); assert(changed.revision > inventory.revision); assert.equal(changed.properties.roomsAvailable, 0);
    assert(sourceProof(f.graph, f.owner, changed.ref, { remaining: 1000 })); assert(sourceProof(f.graph, f.owner, originalObservation.ref, { remaining: 1000 }));
    assert.equal(status(a.subject!), 'unknown', 'Shared current-resource updates must still invalidate stale candidate facts');
    assert.equal(status(next.subject!), 'unsatisfied');
  } finally { f.db.close(); }
});

test('cached redacted patient observations can serve another task without moving private data into shared proof', () => {
  const f = fixture('appointment');
  try {
    const a = f.project(f.snapshot); assert.equal(a.state, 'typed_result');
    const patient = f.graph.related(f.owner, a.subject!, 'patientProfile', { remaining: 1000 })![0]!;
    const originalPrivate = f.graph.readPrivate(f.owner, patient.ref), originalObservation = f.graph.related(f.owner, patient.ref, 'currentObservation', { remaining: 1000 })![0]!;
    const other = { id: `${f.request.id}-B`, revision: 1 };
    f.graph.ingest(f.owner, { objects: [{ ref: { type: 'ServiceRequest', id: other.id }, properties: { requestId: other.id, displayTitle: 'Second appointment', originalGoal: 'Second appointment', revision: 1 } }] }, f.provenance);
    const cached = { ...f.snapshot, requestId: other.id, entities: publicDomainEntities(f.snapshot.entities) };
    const b = projectDomainSnapshot(f.graph, f.owner, domainCapabilityId('appointment'), other, f.parameters, cached); assert.equal(b.state, 'typed_result');
    assert.deepEqual(f.graph.readPrivate(f.owner, patient.ref), originalPrivate);
    assert.deepEqual(f.graph.related(f.owner, patient.ref, 'currentObservation', { remaining: 1000 })![0]!.ref, originalObservation.ref);
    for (const object of [a.subject!, b.subject!]) assert.equal((f.graph.evaluate(f.owner, { function: 'appointmentEligibility', object }).value as { status: string }).status, 'satisfied');
    const final = projectDomainSnapshot(f.graph, f.owner, domainCapabilityId('appointment'), other, f.parameters, { ...cached, sourceEventId: 'other-task-final-readback', observation: f.result });
    assert.equal(final.state, 'typed_result');
    assert.deepEqual(f.graph.readPrivate(f.owner, patient.ref).properties, originalPrivate.properties);
    const observations = f.graph.related(f.owner, patient.ref, 'sourceObservations', { remaining: 1000 })!;
    assert(!JSON.stringify(observations).includes('PRIVATE_'));
    for (const ref of [patient.ref, ...observations.map(object => object.ref)]) {
      const proof = sourceProof(f.graph, f.owner, ref, { remaining: 1000 }); assert(proof);
      for (const receipt of proof.refs) {
        assert.deepEqual(f.graph.related(f.owner, receipt, 'request', { remaining: 1000 }), []);
        assert(!JSON.stringify(f.graph.read(f.owner, receipt)).includes('PRIVATE_'));
      }
    }
    assert.equal(f.graph.related(f.owner, a.subject!, 'request', { remaining: 1000 })![0]!.ref.id, f.request.id);
  } finally { f.db.close(); }
});

const resourceCases: { name: string; domain: ServiceDomain; type: string; changes?: Record<string, unknown>; missing?: string[]; outcome: 'unsatisfied' | 'unknown' }[] = [
  { name: 'excluded ingredient contradicts the aggregate food eligibility flag', domain: 'food', type: 'MenuItem', changes: { ingredients: ['peanuts'] }, outcome: 'unsatisfied' },
  { name: 'unknown ingredient coverage cannot prove an exclusion', domain: 'food', type: 'MenuItem', changes: { ingredientsKnown: false, ingredients: [] }, outcome: 'unknown' },
  { name: 'missing requested menu observation stays unknown', domain: 'food', type: 'MenuItem', missing: ['MenuItem'], outcome: 'unknown' },
  { name: 'ride vehicle capacity contradicts the requested passengers', domain: 'ride', type: 'TransportVehicle', changes: { passengerCapacity: 1 }, outcome: 'unsatisfied' },
  { name: 'ride route contradiction is not hidden by generic eligibility', domain: 'ride', type: 'RideRoute', changes: { destination: 'another-destination' }, outcome: 'unsatisfied' },
  { name: 'missing ride vehicle evidence stays unknown', domain: 'ride', type: 'TransportVehicle', missing: ['TransportVehicle'], outcome: 'unknown' },
  { name: 'hotel cannot qualify without its typed resources', domain: 'hotel', type: 'HotelProperty', missing: ['HotelProperty', 'RoomType', 'RoomInventory'], outcome: 'unknown' },
  { name: 'room type must accommodate all guests', domain: 'hotel', type: 'RoomType', changes: { guestCapacity: 1 }, outcome: 'unsatisfied' },
  { name: 'missing dated hotel inventory stays unknown', domain: 'hotel', type: 'RoomInventory', missing: ['RoomInventory'], outcome: 'unknown' },
  { name: 'appointment requires source-backed patient identity', domain: 'appointment', type: 'PatientProfile', missing: ['PatientProfile'], outcome: 'unknown' },
  { name: 'no slot capacity rejects the appointment', domain: 'appointment', type: 'AppointmentSlot', changes: { availableCount: 0 }, outcome: 'unsatisfied' },
  { name: 'patient ineligibility rejects the appointment', domain: 'appointment', type: 'PatientProfile', changes: { eligibility: 'ineligible' }, outcome: 'unsatisfied' },
  { name: 'rental class capacity must accommodate passengers', domain: 'vehicle', type: 'VehicleClass', changes: { passengerCapacity: 1 }, outcome: 'unsatisfied' },
  { name: 'rental policy evidence cannot be omitted', domain: 'vehicle', type: 'RentalPolicy', missing: ['RentalPolicy'], outcome: 'unknown' },
  { name: 'a route feasibility contradiction rejects an itinerary', domain: 'itinerary', type: 'TravelLeg', changes: { feasibility: 'impossible' }, outcome: 'unsatisfied' },
];
for (const scenario of resourceCases) test(scenario.name, () => {
  const f = fixture(scenario.domain);
  try {
    const snapshot = structuredClone(f.snapshot);
    if (scenario.missing) {
      const removed = new Set(snapshot.entities.filter(e => scenario.missing!.includes(e.type)).map(e => e.id));
      snapshot.entities = snapshot.entities.filter(e => !scenario.missing!.includes(e.type));
      snapshot.relationships = snapshot.relationships.filter(r => !removed.has(r.fromId) && !removed.has(r.toId));
    } else Object.assign(snapshot.entities.find(e => e.type === scenario.type)!.properties, scenario.changes);
    const projected = f.project(snapshot); assert.equal(projected.state, 'typed_result');
    const result = f.graph.evaluate(f.owner, { function: `${scenario.domain}Eligibility`, object: projected.subject! }).value as { status: string };
    assert.equal(result.status, scenario.outcome);
  } finally { f.db.close(); }
});

test('every requested itinerary leg needs its own feasibility observation', () => {
  const f = fixture('itinerary');
  try {
    const snapshot = structuredClone(f.snapshot), missing = snapshot.entities.filter(e => e.type === 'TravelLeg')[1]!;
    snapshot.entities = snapshot.entities.filter(e => e !== missing);
    snapshot.relationships = snapshot.relationships.filter(r => r.toId !== missing.id);
    const projected = f.project(snapshot); assert.equal(projected.state, 'typed_result');
    const result = f.graph.evaluate(f.owner, { function: 'itineraryEligibility', object: projected.subject! }).value as { status: string; criteria: { id: string; result: string }[] };
    assert.equal(result.status, 'unknown'); assert(result.criteria.some(c => c.id === 'requested_leg_coverage' && c.result === 'unknown'));
  } finally { f.db.close(); }
});

test('equal native hotel IDs across providers require an exact source-qualified selection', () => {
  const f = fixture();
  try {
    const first = structuredClone(f.snapshot), second = structuredClone(f.snapshot);
    first.sourceId = second.sourceId = 'shared-source'; first.option.providerId = 'provider-A'; second.option.providerId = 'provider-B';
    Object.assign(second.entities.find(e => e.type === 'HotelProperty')!.properties, { hotelName: 'A different hotel', address: 'another address' });
    const a = f.project(first), b = f.project(second);
    const status = (object: NonNullable<typeof a.subject>) => (f.graph.evaluate(f.owner, { function: 'hotelEligibility', object }).value as { status: string }).status;
    assert.equal(status(a.subject!), 'unknown'); assert.equal(status(b.subject!), 'unknown');
    const requirement = f.graph.related(f.owner, a.subject!, 'requirements', { remaining: 1000 })![0]!;
    const selected = f.graph.related(f.owner, a.subject!, 'hotelProperty', { remaining: 1000 })![0]!;
    f.graph.ingest(f.owner, { objects: [], links: [{ type: 'HotelRequestHotelProperty', from: requirement.ref, to: selected.ref }] }, f.provenance);
    assert.equal(status(a.subject!), 'satisfied'); assert.equal(status(b.subject!), 'unsatisfied');
  } finally { f.db.close(); }
});
