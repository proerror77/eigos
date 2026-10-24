import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../packages/core/delegation.js';
import { businessModel } from '../packages/ontology/business-model.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { domainNames, domainDataSchemas, parseDomainParameters, serviceDomain, type ServiceDomain } from '../packages/ontology/service-domains.js';
import { assessDomain, type DomainAssessment } from '../packages/ontology/domain-rules.js';
import { domainCapabilityId, parseDomainResultResources, projectDomainSnapshot, type DomainSnapshot } from '../packages/ontology/domain-projection.js';
import { sourceProof } from '../packages/ontology/object-evidence.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { domainCapability, type DomainOperation, type DomainSandboxProvider } from '../packages/capabilities/domain-service.js';
import { domainFixture } from './fixtures/service-domains.js';
import { acknowledgeReads, backend, evidence, interpretation, observePlanning, observeTaskContext, owner, principal, proposal } from './backend-fixture.js';

type Data = Record<string, unknown>;
function scenario(domain: ServiceDomain) {
  const fixture = domainFixture(domain);
  return { ...fixture, domain, parameters: fixture.parameters as Data, result: fixture.result as Data };
}
type Scenario = ReturnType<typeof scenario>;
function bind(f: Scenario, patch: Data = {}) {
  f.parameters = parseDomainParameters(f.domain, { ...f.parameters, ...patch });
  f.snapshot.parameters = f.parameters;
  f.snapshot.option.parametersDigest = digest(f.parameters);
  f.snapshot.option.offeredParameters = f.parameters;
  f.result.requestDigest = digest(f.parameters);
}
function entity(type: string, id: string, properties: Data, revision = '1'): DomainSnapshot['entities'][number] {
  return { type, id, title: `Synthetic ${type}`, properties: { sourceId: id, sourceRevision: revision, ...properties } };
}
function patchResource(f: Scenario, type: string, patch: Data) {
  Object.assign(f.snapshot.entities.find(entity => entity.type === type)!.properties, patch);
}
function graphScenario(f: Scenario) {
  const db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, undefined, () => f.now), request = { id: f.snapshot.requestId, revision: 1 };
  graph.ingest(owner, { objects: [{ ref: { type: 'ServiceRequest', id: request.id }, properties: { requestId: request.id, displayTitle: 'Synthetic domain requirements', originalGoal: 'Domain schema validation', revision: 1 } }] }, { kind: 'synthetic', id: 'domain-schema-fixture', observedAt: f.at(-5) });
  const project = (snapshot: DomainSnapshot) => projectDomainSnapshot(graph, owner, domainCapabilityId(f.domain), request, f.parameters, snapshot);
  const prepared = project(f.snapshot);
  assert.equal(prepared.state, 'typed_result');
  const evaluate = (object = prepared.subject!, phase: 'Eligibility' | 'Outcome' = 'Eligibility') => {
    const evaluated = graph.evaluate(owner, { function: `${f.domain}${phase}`, object });
    assert.equal(evaluated.status, 'known', JSON.stringify(evaluated));
    return evaluated.value as DomainAssessment;
  };
  return { db, graph, project, prepared, evaluate };
}
function candidateStatus(f: Scenario) {
  const g = graphScenario(f);
  try { return g.evaluate(); } finally { g.db.close(); }
}
function resultSnapshot(f: Scenario, entities: DomainSnapshot['entities'], relationships: DomainSnapshot['relationships'], version = 2): DomainSnapshot {
  return { ...f.snapshot, observation: f.result, sourceVersion: version, sourceEventId: `result-${version}`, preparedSource: { eventId: f.snapshot.sourceEventId, version: f.snapshot.sourceVersion }, resultEntities: entities, resultRelationships: relationships };
}
function resources(snapshot: DomainSnapshot) { return parseDomainResultResources(snapshot.domain, snapshot.observation!, snapshot.resultEntities, snapshot.resultRelationships); }

function hotelScenario() {
  const f = scenario('hotel'), cancellation = { policyRef: 'flexible-v1', kind: 'free_until', freeUntil: f.at(60) }, breakfast = { included: true, servingsPerRoom: 2 }, occupancy = { adults: 2, childAges: [8] };
  bind(f, { guests: 3, ratePlanId: 'rate-breakfast', occupancy, breakfast, cancellation });
  Object.assign(f.result, { guests: 3, ratePlanId: 'rate-breakfast', occupancy, breakfast, cancellation });
  patchResource(f, 'HotelProperty', { childPolicy: { childrenAllowed: true, maximumChildAge: 17, maxChildrenPerRoom: 1 } });
  patchResource(f, 'RoomType', { hotelId: f.parameters.hotelId, guestCapacity: 3, maximumAdults: 2, maximumChildren: 1 });
  patchResource(f, 'RoomInventory', { hotelId: f.parameters.hotelId, roomTypeId: f.parameters.roomTypeId, ratePlanId: 'rate-breakfast' });
  f.snapshot.entities.push(entity('HotelRatePlan', 'rate-breakfast', { hotelId: f.parameters.hotelId, roomTypeId: f.parameters.roomTypeId, ratePlanName: 'Synthetic breakfast plan', breakfast, cancellation, paymentTiming: 'at_property' }));
  f.snapshot.relationships.push({ type: 'HotelRatePlanHotel', fromId: 'rate-breakfast', toId: String(f.parameters.hotelId) }, { type: 'HotelRatePlanRoomType', fromId: 'rate-breakfast', toId: String(f.parameters.roomTypeId) }, { type: 'RoomInventoryRatePlan', fromId: 'RoomInventory-synthetic', toId: 'rate-breakfast' });
  return f;
}
function rideScenario() {
  const f = scenario('ride'), originLocation = { sourceId: 'synthetic-map', placeId: String(f.parameters.origin), meetingPoint: 'Gate A' }, destinationLocation = { sourceId: 'synthetic-map', placeId: String(f.parameters.destination), meetingPoint: 'Gate B' };
  bind(f, { mode: 'instant', timeZone: 'Asia/Shanghai', luggageCount: 2, luggageSize: 'large', originLocation, destinationLocation });
  patchResource(f, 'RideRoute', { originLocation, destinationLocation, timeZone: 'Asia/Shanghai' });
  patchResource(f, 'TransportVehicle', { luggageCapacity: { count: 2, maximumSize: 'large' } });
  Object.assign(f.result, { mode: 'instant', timeZone: 'Asia/Shanghai', luggageCount: 2, luggageSize: 'large', originLocation, destinationLocation, assignmentId: 'assignment-A' });
  return f;
}
function transportSnapshot(f: Scenario, driverId = 'driver-A', version = 2) {
  const mode = f.domain === 'ride' ? 'instant' : String(f.parameters.mode), vehicleId = 'actual-vehicle', isSelfDrive = mode === 'self_drive', boardedAt = String(f.result.pickedUpAt), completedAt = String(f.domain === 'ride' ? f.result.arrivedAt : f.result.returnedAt);
  const entities = [entity('TransportVehicle', vehicleId, { vehicleClass: f.domain === 'ride' ? f.parameters.serviceClass : f.parameters.vehicleClass, passengerCapacity: 4, vehicleReference: vehicleId, luggageCapacity: { count: 2, maximumSize: 'large' }, transmission: 'automatic' }), entity('TransportAssignment', 'assignment-A', { providerReference: f.result.providerReference, vehicleId, ...(isSelfDrive ? {} : { driverId }), mode, state: isSelfDrive ? 'released' : 'completed', assignedAt: f.at(-150), atPickupAt: f.at(-130), boardedAt, completedAt }, String(version - 1))];
  const relationships = [{ type: 'TransportAssignmentVehicle', fromId: 'assignment-A', toId: vehicleId }];
  if (!isSelfDrive) {
    entities.push(entity('TransportDriver', driverId, { driverAlias: driverId, eligibility: 'verified', operatorId: 'synthetic-operator', contact: 'PRIVATE_DRIVER_CONTACT', licenseReference: 'PRIVATE_DRIVER_LICENSE' }));
    relationships.push({ type: 'TransportAssignmentDriver', fromId: 'assignment-A', toId: driverId });
  }
  return resultSnapshot(f, entities, relationships, version);
}
function vehicleScenario(mode: 'chauffeured' | 'self_drive' = 'self_drive') {
  const f = scenario('vehicle'), pickupLocation = { sourceId: 'synthetic-map', placeId: String(f.parameters.pickup), meetingPoint: 'Depot gate' }, returnLocationDetails = { sourceId: 'synthetic-map', placeId: String(f.parameters.returnLocation), meetingPoint: 'Return desk' };
  bind(f, { mode, startsAt: f.at(-120), endsAt: f.at(60), endpoint: 'completed', luggageCount: 2, luggageSize: 'large', pickupLocation, returnLocationDetails, ...(mode === 'self_drive' ? { driverQualification: { age: 30, licenseClass: 'C1', licenseCountry: 'CN', licenseHeldMonths: 60 }, insurance: { coverage: ['collision', 'third_party'], maximumDeductible: { minor: '10000', currency: 'CNY' } }, cancellation: { policyRef: 'synthetic-policy-v1', kind: 'free_until', freeUntil: f.at(30) }, inspectionRequired: true, transmission: 'automatic' } : { driverKey: undefined }) });
  const driverEligibility = { minimumAge: 21, maximumAge: 75, licenseClasses: ['C1'], licenseCountries: ['CN'], minimumLicenseHeldMonths: 12 }, insurance = { policyRef: 'insurance-v1', coverage: ['collision', 'third_party'], deductible: { minor: '5000', currency: 'CNY' } };
  patchResource(f, 'VehicleClass', { luggageCapacity: { count: 2, maximumSize: 'large' } });
  patchResource(f, 'RentalPolicy', { vehicleClassId: f.parameters.vehicleClass, driverEligibility, insurance, cancellation: f.parameters.cancellation, pickupLocation, returnLocationDetails });
  Object.assign(f.result, { mode, startsAt: f.parameters.startsAt, endsAt: f.parameters.endsAt, state: mode === 'self_drive' ? 'returned' : 'completed', pickedUpAt: f.at(-100), returnedAt: f.at(-10), returnAccepted: true, depositState: 'settled', luggageCount: 2, luggageSize: 'large', pickupLocation, returnLocationDetails, assignmentId: 'assignment-A', ...(mode === 'self_drive' ? { driverQualification: f.parameters.driverQualification, driverEligibility, insurance, cancellation: f.parameters.cancellation, transmission: 'automatic', pickupInspectionId: 'inspection-pickup', returnInspectionId: 'inspection-return' } : { driverKey: undefined }) });
  return f;
}
function inspectedVehicleSnapshot(f: Scenario) {
  const snapshot = transportSnapshot(f);
  for (const stage of ['pickup', 'return']) {
    const id = `inspection-${stage}`;
    snapshot.resultEntities!.push(entity('VehicleInspection', id, { stage, occurredAt: f.at(stage === 'pickup' ? -110 : -9), accepted: true, damageReportRef: id, providerReference: f.result.providerReference, vehicleId: 'actual-vehicle', details: { odometerKm: stage === 'pickup' ? 100 : 150, fuelPercent: 80, damage: [], agreement: 'accepted' } }));
    snapshot.resultRelationships!.push({ type: 'VehicleInspectionVehicle', fromId: id, toId: 'actual-vehicle' });
  }
  return snapshot;
}

test('legacy inputs retain exact data while new domain contracts reject impossible shapes and incompatible variants', () => {
  for (const domain of domainNames) { const f = domainFixture(domain); assert.deepEqual(parseDomainParameters(domain, f.parameters), f.parameters); assert.equal(digest(parseDomainParameters(domain, f.parameters)), digest(f.parameters)); }
  const r = domainFixture('ride'), h = domainFixture('hotel'), v = domainFixture('vehicle');
  assert.throws(() => parseDomainParameters('ride', { ...r.parameters, luggageCount: -1 }));
  assert.throws(() => parseDomainParameters('ride', { ...r.parameters, luggageSize: 'large' }));
  assert.throws(() => parseDomainParameters('ride', { ...r.parameters, mode: 'self_drive' }));
  assert.throws(() => parseDomainParameters('ride', { ...r.parameters, originLocation: { sourceId: 'map', placeId: 'another-place' } }));
  assert.throws(() => parseDomainParameters('hotel', { ...h.parameters, occupancy: { adults: 2, childAges: [8] } }));
  assert.throws(() => parseDomainParameters('vehicle', { ...v.parameters, mode: 'chauffeured', driverQualification: { age: 30, licenseClass: 'C1', licenseCountry: 'CN', licenseHeldMonths: 60 } }));
  assert.throws(() => domainDataSchemas.cancellationTerms.parse({ policyRef: 'policy', kind: 'free_until' }));
  assert.throws(() => domainDataSchemas.hotelBreakfast.parse({ included: false, servingsPerRoom: 1 }));
  assert.throws(() => domainDataSchemas.transportAssignment.parse({ providerReference: 'trip', vehicleId: 'vehicle', mode: 'instant', state: 'assigned', assignedAt: r.at(-1) }));
  const description = businessModel.describeType('HotelRatePlan') as { properties: Record<string, unknown> };
  assert(description.properties.breakfast); assert(description.properties.cancellation);
  assert.equal((z.toJSONSchema(serviceDomain('ride').parameters).properties!.luggageCount as { type: string }).type, 'integer');
});

test('hotel rate plans, child admission and breakfast have positive, missing and contradictory controls', () => {
  const positive = hotelScenario(); assert.equal(candidateStatus(positive).status, 'satisfied'); assert.equal(assessDomain('hotel', positive.parameters, positive.result, positive.now).status, 'satisfied');
  const missingPlan = hotelScenario(); missingPlan.snapshot.entities = missingPlan.snapshot.entities.filter(entity => entity.type !== 'HotelRatePlan'); missingPlan.snapshot.relationships = missingPlan.snapshot.relationships.filter(relation => !relation.type.includes('RatePlan'));
  assert.equal(candidateStatus(missingPlan).status, 'unknown');
  const missingBreakfast = hotelScenario(); delete missingBreakfast.snapshot.entities.find(entity => entity.type === 'HotelRatePlan')!.properties.breakfast;
  assert.equal(candidateStatus(missingBreakfast).status, 'unknown');
  const noBreakfast = hotelScenario(); patchResource(noBreakfast, 'HotelRatePlan', { breakfast: { included: false, servingsPerRoom: 0 } }); assert.equal(candidateStatus(noBreakfast).status, 'unsatisfied');
  const extraBreakfast = hotelScenario(); patchResource(extraBreakfast, 'HotelRatePlan', { breakfast: { included: true, servingsPerRoom: 3 } }); extraBreakfast.result.breakfast = { included: true, servingsPerRoom: 3 };
  assert.equal(candidateStatus(extraBreakfast).status, 'satisfied'); assert.equal(assessDomain('hotel', extraBreakfast.parameters, extraBreakfast.result, extraBreakfast.now).status, 'satisfied');
  const childrenForbidden = hotelScenario(); patchResource(childrenForbidden, 'HotelProperty', { childPolicy: { childrenAllowed: false, maximumChildAge: 17, maxChildrenPerRoom: 1 } }); assert.equal(candidateStatus(childrenForbidden).status, 'unsatisfied');
  const unknownChildPolicy = hotelScenario(); delete unknownChildPolicy.snapshot.entities.find(entity => entity.type === 'HotelProperty')!.properties.childPolicy; assert.equal(candidateStatus(unknownChildPolicy).status, 'unknown');
  const incompleteResult = { ...positive.result }; delete incompleteResult.breakfast; assert.equal(assessDomain('hotel', positive.parameters, incompleteResult, positive.now).status, 'unknown');
  const wrongTerms = { ...positive.result, cancellation: { policyRef: 'flexible-v1', kind: 'non_refundable' } }; assert.equal(assessDomain('hotel', positive.parameters, wrongTerms, positive.now).status, 'unsatisfied');
  const g = graphScenario(positive);
  try {
    const plan = g.graph.related(owner, g.prepared.subject!, 'hotelRatePlan', { remaining: 1000 })![0]!;
    assert.equal(g.graph.related(owner, plan.ref, 'roomType', { remaining: 1000 })![0]!.properties.sourceId, positive.parameters.roomTypeId);
    const malformed = structuredClone(positive.snapshot); malformed.entities.find(entity => entity.type === 'HotelRatePlan')!.properties.roomTypeId = 'another-room';
    const before = g.graph.revision(owner); assert.equal(g.project(malformed).state, 'invalid_source'); assert.equal(g.graph.revision(owner), before);
  } finally { g.db.close(); }
  const prepaid = hotelScenario(); patchResource(prepaid, 'HotelRatePlan', { paymentTiming: 'prepaid' });
  const paidGraph = graphScenario(prepaid);
  try {
    const projected = paidGraph.project({ ...prepaid.snapshot, observation: prepaid.result }); assert.equal(projected.state, 'typed_result');
    assert.equal(paidGraph.evaluate(projected.subject!, 'Outcome').status, 'unsatisfied', 'A selected prepaid rate cannot become paid by returning not_required');
  } finally { paidGraph.db.close(); }
});

test('explicit breakfast frequency requires source and result evidence without defaulting legacy inputs', () => {
  const legacy = hotelScenario(), before = digest(legacy.parameters), legacyBreakfast = { included: true, servingsPerRoom: 2 };
  assert.deepEqual(domainDataSchemas.hotelBreakfast.parse(legacyBreakfast), legacyBreakfast);
  assert.equal(digest(parseDomainParameters('hotel', legacy.parameters)), before);
  assert(!Object.hasOwn(parseDomainParameters('hotel', legacy.parameters).breakfast!, 'frequency'));
  assert.throws(() => domainDataSchemas.hotelBreakfast.parse({ ...legacyBreakfast, frequency: 'per_booking_day' }));

  for (const [frequency, status] of [['daily', 'satisfied'], [undefined, 'unknown'], ['once_per_stay', 'unsatisfied']] as const) {
    const f = hotelScenario();
    bind(f, { breakfast: { ...legacyBreakfast, frequency: 'daily' } });
    const actual = { ...legacyBreakfast, ...(frequency === undefined ? {} : { frequency }) };
    patchResource(f, 'HotelRatePlan', { breakfast: actual }); f.result.breakfast = actual;
    const g = graphScenario(f);
    try {
      const candidate = g.evaluate(); assert.equal(candidate.status, status);
      assert.equal(candidate.criteria.find(criterion => criterion.id === 'breakfast_frequency')!.result, status === 'satisfied' ? 'pass' : status === 'unknown' ? 'unknown' : 'fail');
      const projected = g.project({ ...f.snapshot, observation: f.result }); assert.equal(projected.state, 'typed_result');
      assert.equal(g.evaluate(projected.subject!, 'Outcome').status, status);
    } finally { g.db.close(); }
  }

  const unspecified = hotelScenario(); patchResource(unspecified, 'HotelRatePlan', { breakfast: { ...legacyBreakfast, frequency: 'once_per_stay' } });
  const unspecifiedAssessment = candidateStatus(unspecified); assert.equal(unspecifiedAssessment.status, 'satisfied');
  assert(!unspecifiedAssessment.criteria.some(criterion => criterion.id === 'breakfast_frequency'));
  const fixed = hotelScenario(); bind(fixed, { breakfast: { ...legacyBreakfast, frequency: 'daily' } });
  patchResource(fixed, 'HotelRatePlan', { breakfast: { ...legacyBreakfast, frequency: 'once_per_stay' } }); fixed.result.breakfast = { ...legacyBreakfast, frequency: 'daily' };
  const assessment = assessDomain('hotel', fixed.parameters, fixed.result, fixed.now, { entities: [], relationships: [], preparedEntities: fixed.snapshot.entities });
  assert.equal(assessment.status, 'unsatisfied');
  assert.equal(assessment.criteria.find(criterion => criterion.id === 'selected_rate_breakfast')!.result, 'fail', 'A result cannot rewrite the frequency of the selected source rate plan');
});

test('ride capacity and exact pickup identity cannot hide behind an available service-class label', () => {
  const f = rideScenario(); assert.equal(candidateStatus(f).status, 'satisfied');
  const missing = rideScenario(); delete missing.snapshot.entities.find(entity => entity.type === 'TransportVehicle')!.properties.luggageCapacity; assert.equal(candidateStatus(missing).status, 'unknown');
  const small = rideScenario(); patchResource(small, 'TransportVehicle', { luggageCapacity: { count: 2, maximumSize: 'small' } }); assert.equal(candidateStatus(small).status, 'unsatisfied');
  const ambiguous = rideScenario(); patchResource(ambiguous, 'RideRoute', { originLocation: { ...(ambiguous.parameters.originLocation as Data), sourceId: 'unrelated-map' } }); assert.equal(candidateStatus(ambiguous).status, 'unsatisfied');
  const additionalAddress = rideScenario(); patchResource(additionalAddress, 'RideRoute', { originLocation: { ...(additionalAddress.parameters.originLocation as Data), address: 'Source address metadata' } }); assert.equal(candidateStatus(additionalAddress).status, 'satisfied');
  assert.equal(assessDomain('ride', f.parameters, f.result, f.now).status, 'unknown', 'Completed status without actual assignment evidence does not prove the requested vehicle capacity');
  const actual = transportSnapshot(f); assert.equal(assessDomain('ride', f.parameters, f.result, f.now, resources(actual)).status, 'satisfied');
  const unsupportedField = structuredClone(actual); unsupportedField.resultEntities!.find(entity => entity.type === 'TransportDriver')!.properties.unknownAuthorization = true;
  assert.throws(() => resources(unsupportedField), /Unrecognized key/);
  actual.resultEntities!.find(entity => entity.type === 'TransportVehicle')!.properties.luggageCapacity = { count: 1, maximumSize: 'large' };
  assert.equal(assessDomain('ride', f.parameters, f.result, f.now, resources(actual)).status, 'unsatisfied');
});

test('old selected hotel observations do not replay stale parent relationships into current resources', () => {
  const f = hotelScenario(), g = graphScenario(f);
  try {
    const plan = g.graph.related(owner, g.prepared.subject!, 'hotelRatePlan', { remaining: 1000 })![0]!, newer = structuredClone(f.snapshot), oldHotelId = String(f.parameters.hotelId);
    newer.sourceVersion = 2; newer.sourceEventId = 'corrected-resource-parent';
    for (const resource of newer.entities) {
      resource.properties.sourceRevision = '2';
      if (resource.type === 'HotelProperty') { resource.id = 'another-hotel'; resource.properties.sourceId = 'another-hotel'; }
      if (resource.properties.hotelId !== undefined) resource.properties.hotelId = 'another-hotel';
    }
    for (const relation of newer.relationships) if (relation.toId === oldHotelId) relation.toId = 'another-hotel';
    assert.equal(g.project(newer).state, 'typed_result');
    assert.equal(g.graph.related(owner, plan.ref, 'hotel', { remaining: 1000 })![0]!.properties.sourceId, 'another-hotel');
    const completed = g.project({ ...f.snapshot, observation: f.result, sourceVersion: 3, sourceEventId: 'original-plan-confirmed', preparedSource: { eventId: f.snapshot.sourceEventId, version: 1 } });
    assert.equal(completed.state, 'typed_result');
    assert.equal(g.graph.related(owner, plan.ref, 'hotel', { remaining: 1000 })![0]!.properties.sourceId, 'another-hotel');
    assert.equal(g.evaluate(completed.subject!, 'Outcome').status, 'satisfied', 'Original committed rate-plan facts are assessed from the immutable selected observation');
  } finally { g.db.close(); }
});

test('post-dispatch assignment graph preserves the sealed candidate and immutable driver history', () => {
  const f = rideScenario(), g = graphScenario(f), actual = transportSnapshot(f);
  try {
    const candidate = g.graph.read(owner, g.prepared.subject!);
    assert.equal(g.project({ ...f.snapshot, sourceEventId: 'a-later-identical-read', sourceVersion: 2 }).state, 'typed_result');
    const projected = g.project(actual); assert.equal(projected.state, 'typed_result');
    assert.equal(g.evaluate(projected.subject!, 'Outcome').status, 'satisfied');
    assert.deepEqual(g.graph.read(owner, candidate.ref), candidate, 'Dispatch facts do not replace approved candidate properties or revision');
    assert.deepEqual(g.graph.related(owner, projected.subject!, 'selectedOption', { remaining: 1000 })![0]!.ref, candidate.ref);
    const assignment = g.graph.related(owner, projected.subject!, 'transportAssignment', { remaining: 1000 })![0]!;
    const originalObservation = g.graph.related(owner, projected.subject!, 'transportAssignmentObservations', { remaining: 1000 })![0]!;
    const originalDriver = g.graph.related(owner, originalObservation.ref, 'driver', { remaining: 1000 })![0]!;
    assert.equal(originalDriver.properties.sourceId, 'driver-A'); assert(!JSON.stringify(originalDriver).includes('PRIVATE_'));
    assert.equal(g.graph.readPrivate(owner, originalDriver.ref).properties.contact, 'PRIVATE_DRIVER_CONTACT');
    const next = transportSnapshot(f, 'driver-B', 3); assert.equal(g.project(next).state, 'typed_result');
    assert.equal(g.graph.related(owner, assignment.ref, 'driver', { remaining: 1000 })![0]!.properties.sourceId, 'driver-B');
    assert.equal(g.graph.related(owner, originalObservation.ref, 'driver', { remaining: 1000 })![0]!.properties.sourceId, 'driver-A');
    assert(sourceProof(g.graph, owner, originalObservation.ref, { remaining: 1000 }));
    assert.deepEqual(g.graph.read(owner, candidate.ref), candidate);
    const malformed = structuredClone(next); malformed.resultRelationships!.find(relation => relation.type === 'TransportAssignmentDriver')!.toId = 'driver-A';
    const before = g.graph.revision(owner); assert.equal(g.project(malformed).state, 'invalid_source'); assert.equal(g.graph.revision(owner), before);
  } finally { g.db.close(); }
});

test('chauffeured completion and self-drive return use distinct sourced subjects and endpoint checks', () => {
  const chauffeur = vehicleScenario('chauffeured'), chauffeurResult = transportSnapshot(chauffeur);
  assert.equal(candidateStatus(chauffeur).status, 'satisfied');
  assert.equal(assessDomain('vehicle', chauffeur.parameters, chauffeur.result, chauffeur.now, resources(chauffeurResult)).status, 'satisfied');
  assert.equal(assessDomain('vehicle', chauffeur.parameters, chauffeur.result, chauffeur.now, resources(chauffeurResult)).variantEndpoint, 'passenger_delivered');
  assert.equal(assessDomain('vehicle', chauffeur.parameters, { ...chauffeur.result, state: 'assigned', pickedUpAt: undefined, returnedAt: undefined }, chauffeur.now, resources(chauffeurResult)).status, 'unknown');
  const selfDrive = vehicleScenario(), final = inspectedVehicleSnapshot(selfDrive);
  assert.equal(candidateStatus(selfDrive).status, 'satisfied');
  assert.equal(assessDomain('vehicle', selfDrive.parameters, selfDrive.result, selfDrive.now, resources(final)).status, 'satisfied');
  assert.equal(assessDomain('vehicle', selfDrive.parameters, selfDrive.result, selfDrive.now, resources(final)).variantEndpoint, 'vehicle_returned_and_deposit_settled');
  assert(!final.resultEntities!.some(entity => entity.type === 'TransportDriver'), 'A self-drive customer is not an invented hired driver');
  for (const [depositState, expected] of [['pending', 'unknown'], ['disputed', 'unsatisfied']] as const) assert.equal(assessDomain('vehicle', selfDrive.parameters, { ...selfDrive.result, depositState }, selfDrive.now, resources(final)).status, expected);
  const noReturnInspection = structuredClone(final); noReturnInspection.resultEntities = noReturnInspection.resultEntities!.filter(entity => entity.id !== 'inspection-return'); noReturnInspection.resultRelationships = noReturnInspection.resultRelationships!.filter(relation => relation.fromId !== 'inspection-return');
  assert.equal(assessDomain('vehicle', selfDrive.parameters, selfDrive.result, selfDrive.now, resources(noReturnInspection)).status, 'unknown');
  const disputed = structuredClone(final); (disputed.resultEntities!.find(entity => entity.id === 'inspection-return')!.properties.details as Data).agreement = 'disputed';
  assert.equal(assessDomain('vehicle', selfDrive.parameters, selfDrive.result, selfDrive.now, resources(disputed)).status, 'unsatisfied');
  const g = graphScenario(selfDrive);
  try { const projected = g.project(final); assert.equal(projected.state, 'typed_result'); assert.equal(g.evaluate(projected.subject!, 'Outcome').status, 'satisfied'); assert.equal(g.graph.related(owner, projected.subject!, 'vehicleInspectionObservations', { remaining: 1000 })!.length, 2); } finally { g.db.close(); }
});

test('self-drive eligibility evaluates license, insurance and deposit as separate domain facts', () => {
  const young = vehicleScenario(); bind(young, { driverQualification: { ...(young.parameters.driverQualification as Data), age: 18 } }); assert.equal(candidateStatus(young).status, 'unsatisfied');
  const missing = vehicleScenario(); delete missing.snapshot.entities.find(entity => entity.type === 'RentalPolicy')!.properties.driverEligibility; assert.equal(candidateStatus(missing).status, 'unknown');
  const unaccepted = vehicleScenario(); patchResource(unaccepted, 'RentalPolicy', { driverEligibility: { minimumAge: 21, licenseClasses: ['A'], licenseCountries: ['US'], minimumLicenseHeldMonths: 120 } }); assert.equal(candidateStatus(unaccepted).status, 'unsatisfied');
  const uninsured = vehicleScenario(); patchResource(uninsured, 'RentalPolicy', { insurance: { policyRef: 'insurance-v1', coverage: ['collision'], deductible: { minor: '5000', currency: 'CNY' } } }); assert.equal(candidateStatus(uninsured).status, 'unsatisfied');
  const missingInsurance = vehicleScenario(); delete missingInsurance.snapshot.entities.find(entity => entity.type === 'RentalPolicy')!.properties.insurance; assert.equal(candidateStatus(missingInsurance).status, 'unknown');
  const highDeductible = vehicleScenario(); patchResource(highDeductible, 'RentalPolicy', { insurance: { policyRef: 'insurance-v1', coverage: ['collision', 'third_party'], deductible: { minor: '20000', currency: 'CNY' } } }); assert.equal(candidateStatus(highDeductible).status, 'unsatisfied');
});

test('food selections and cross-contact claims require their own source facts and final readback', () => {
  const build = () => {
    const f = scenario('food'), selections = [{ groupId: 'sauce', optionId: 'plain' }], items = (f.parameters.items as Data[]).map(item => ({ ...item, selections }));
    bind(f, { items, avoidCrossContact: true }); Object.assign(f.result, { deliveredItems: items, crossContactCheck: 'verified' });
    patchResource(f, 'MenuItem', { merchantId: f.parameters.merchantId, optionGroups: [{ groupId: 'sauce', optionIds: ['plain', 'spicy'], minimumSelections: 1, maximumSelections: 1 }], crossContactKnown: true, crossContactIngredients: [] });
    return f;
  };
  const f = build(); assert.equal(candidateStatus(f).status, 'satisfied'); assert.equal(assessDomain('food', f.parameters, f.result, f.now).status, 'satisfied');
  const unavailable = build(); patchResource(unavailable, 'MenuItem', { optionGroups: [{ groupId: 'sauce', optionIds: ['spicy'], minimumSelections: 1, maximumSelections: 1 }] }); assert.equal(candidateStatus(unavailable).status, 'unsatisfied');
  const unknown = build(); delete unknown.snapshot.entities.find(entity => entity.type === 'MenuItem')!.properties.optionGroups; assert.equal(candidateStatus(unknown).status, 'unknown');
  const contaminated = build(); patchResource(contaminated, 'MenuItem', { crossContactIngredients: ['Peanuts'] }); assert.equal(candidateStatus(contaminated).status, 'unsatisfied');
  const absent = { ...f.result, deliveredItems: (f.result.deliveredItems as Data[]).map(({ selections: _selection, ...item }) => item) }; assert.equal(assessDomain('food', f.parameters, absent, f.now).status, 'unknown');
  const substituted = { ...f.result, deliveredItems: (f.result.deliveredItems as Data[]).map(item => ({ ...item, selections: [{ groupId: 'sauce', optionId: 'spicy' }] })) }; assert.equal(assessDomain('food', f.parameters, substituted, f.now).status, 'unsatisfied');
});

test('appointment administrative eligibility is typed and does not assert medical suitability', () => {
  const build = () => {
    const f = scenario('appointment'); bind(f, { visitType: 'first_visit', category: 'general', patientAge: 30, referralKey: 'referral-A' });
    patchResource(f, 'PatientProfile', { age: 30, referralKey: 'referral-A', referralVerified: true });
    patchResource(f, 'AppointmentSlot', { administration: { visitTypes: ['first_visit'], categories: ['general'], referralRequired: true, minimumAge: 18, maximumAge: 65 } });
    Object.assign(f.result, { visitType: 'first_visit', category: 'general', patientAge: 30, referralKey: 'referral-A', referralVerified: true }); return f;
  };
  const f = build(); assert.equal(candidateStatus(f).status, 'satisfied'); assert.equal(assessDomain('appointment', f.parameters, f.result, f.now).status, 'satisfied');
  const unknown = build(); delete unknown.snapshot.entities.find(entity => entity.type === 'AppointmentSlot')!.properties.administration; assert.equal(candidateStatus(unknown).status, 'unknown');
  const wrongCategory = build(); patchResource(wrongCategory, 'AppointmentSlot', { administration: { visitTypes: ['follow_up'], categories: ['specialist'], referralRequired: false } }); assert.equal(candidateStatus(wrongCategory).status, 'unsatisfied');
  const rejectedReferral = build(); patchResource(rejectedReferral, 'PatientProfile', { referralVerified: false }); assert.equal(candidateStatus(rejectedReferral).status, 'unsatisfied');
  assert.equal(assessDomain('appointment', f.parameters, { ...f.result, referralVerified: undefined }, f.now).status, 'unknown');
});

test('itinerary dependencies validate existence, ordering and final preservation', () => {
  const f = scenario('itinerary'), legs = structuredClone(f.parameters.legs as Data[]); legs[1]!.dependsOn = ['leg-1']; bind(f, { legs });
  const actualLegs = structuredClone(f.result.legs as Data[]); actualLegs[1]!.dependsOn = ['leg-1']; f.result.legs = actualLegs;
  f.snapshot.entities.find(entity => entity.type === 'TravelLeg' && entity.id === 'leg-2')!.properties.dependsOn = ['leg-1'];
  assert.equal(candidateStatus(f).status, 'satisfied'); assert.equal(assessDomain('itinerary', f.parameters, f.result, f.now).status, 'satisfied');
  const absent = structuredClone(f.result); delete (absent.legs as Data[])[1]!.dependsOn; assert.equal(assessDomain('itinerary', f.parameters, absent, f.now).status, 'unknown');
  assert.throws(() => parseDomainParameters('itinerary', { ...f.parameters, legs: legs.map((leg, index) => ({ ...leg, dependsOn: index ? ['missing-leg'] : [] })) }));
  assert.throws(() => parseDomainParameters('itinerary', { ...f.parameters, legs: legs.map((leg, index) => ({ ...leg, dependsOn: [index ? 'leg-1' : 'leg-2'] })) }));
});

test('sandbox transport readback adds actual assignment subjects without another dispatch or public driver data', async () => {
  const f = rideScenario(), finalSnapshot = transportSnapshot(f), ledger = new Map<string, DomainOperation>();
  let complete = false, submits = 0, lookups = 0;
  const read = (key: string): DomainOperation => {
    const result = structuredClone(finalSnapshot), assignment = result.resultEntities!.find(entity => entity.type === 'TransportAssignment')!;
    assignment.properties.sourceRevision = complete ? '2' : '1';
    if (!complete) { Object.assign(result.observation!, { state: 'assigned', pickedUpAt: undefined, arrivedAt: undefined }); Object.assign(assignment.properties, { state: 'assigned', atPickupAt: undefined, boardedAt: undefined, completedAt: undefined }); }
    const operation: DomainOperation = { key, inputDigest: digest(f.parameters), eventId: `${key}:${complete ? 2 : 1}`, version: complete ? 2 : 1, observation: result.observation!, entities: result.resultEntities, relationships: result.resultRelationships };
    ledger.set(key, operation); return operation;
  };
  const provider: DomainSandboxProvider = { domain: 'ride', id: 'synthetic-domain-provider', configurationDigest: digest({ fixture: 'typed-assignment-v1' }), environment: 'sandbox', prepare: async input => ({ option: { ...f.snapshot.option, parametersDigest: digest(input), offeredParameters: input }, entities: f.snapshot.entities, relationships: f.snapshot.relationships }), submit: async key => { submits++; return read(key); }, lookup: async key => { lookups++; return ledger.has(key) ? read(key) : undefined; } };
  const capability = domainCapability('ride'), b = backend(createExecutionCatalog({ domainSandboxProviders: [provider] }), { ground: async (request, _caps, _signal, access) => ({ decision: { ...interpretation(observeTaskContext(access) ?? request, capability.ref.id, f.parameters), capabilityRef: capability.ref }, evidence: evidence() }), plan: async (context, _signal, access) => { observePlanning(context, access); const option = context.resolution.candidates[0]!.ontologySubject!; assert.equal((access.session.call('evaluate_ontology', { function: 'rideEligibility', object: option }) as { value: DomainAssessment }).value.status, 'satisfied'); acknowledgeReads(access); return { decision: proposal(context), evidence: evidence() }; } }, undefined, { allowSandbox: true });
  try {
    b.submit({ executionEnvironment: 'sandbox' }); const ready = await b.run(), authorization = ready.delegation!.authorizationRequest!;
    b.tasks.authorize(principal, ready.id, { action: 'approve_plan', requestId: randomUUID(), planDigest: authorization.planDigest, allowedEffects: authorization.effects, maxAmount: authorization.maxAmount, payeeIds: authorization.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' });
    const pending = await b.run(); assert.equal(pending.state, 'working'); assert.equal(submits, 1);
    const assigned = b.store.ontology.query(owner, { type: 'TransportAssignment' }).items; assert.equal(assigned.length, 1); assert.equal(assigned[0]!.properties.state, 'assigned');
    complete = true;
    const nextAt = Math.max(pending.delegation!.nextAt ?? 0, ...b.store.intents(owner, ready.id).map(intent => intent.nextAt));
    await new Promise(resolve => setTimeout(resolve, Math.max(0, nextAt - Date.now()) + 20));
    const done = await b.run(); assert.equal(done.state, 'completed', done.question); assert.equal(submits, 1); assert.equal(lookups, 1); assert.equal(done.delegation!.outcome!.status, 'satisfied');
    assert.equal(b.store.ontology.query(owner, { type: 'TransportAssignment' }).items[0]!.properties.state, 'completed'); assert(!JSON.stringify(done.artifact).includes('PRIVATE_DRIVER'));
  } finally { b.store.close(); }
});
