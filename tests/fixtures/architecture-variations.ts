// New synthetic source facts for a separate blind retest. Participants receive
// only each ordinary business question and its ServiceRequest starting point.
// This file contains no answer prose, evaluation rubric, or suggested query path.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DrillDataset } from '../../examples/ontology-drill.js';
import { digest } from '../../packages/core/delegation.js';
import type { Job } from '../../packages/core/domain.js';
import { BACKEND_VERSION, type RequirementInput, type ServiceRequest } from '../../packages/ontology/execution.js';
import { businessModel } from '../../packages/ontology/business-model.js';
import { projectTask } from '../../packages/ontology/task-projection.js';
import { projectExecution } from '../../packages/ontology/execution-projection.js';
import { projectBusinessChain } from '../../packages/ontology/business-chain-projection.js';
import { domainCapabilityId, projectDomainSnapshot, type DomainSnapshot } from '../../packages/ontology/domain-projection.js';
import { OntologyObjectStore } from '../../packages/ontology/object-store.js';
import { parseDomainParameters, type ServiceDomain } from '../../packages/ontology/service-domains.js';
import { domainFixture } from './service-domains.js';

export const architectureVariationQuestionIds = ['U01', 'U02', 'U03', 'U04', 'U05', 'U06'] as const;
const at = (now: number, minutes = 0) => new Date(now + minutes * 60000).toISOString();
const day = (now: number, days: number) => new Date(now + days * 86400000).toISOString().slice(0, 10);
const resource = (type: string, id: string, properties: Record<string, unknown>) => ({ type, id, title: `合成${type}`, properties: { sourceId: id, sourceRevision: '1', ...properties } });
function request(id: string, goal: string, now: number, requirements: RequirementInput[] = []): ServiceRequest {
  const messageId = `variation-instruction-${id}`, receivedAt = at(now, -20);
  return { id: `architecture-variation-${id}`, revision: 1, originalGoal: goal, executionEnvironment: 'sandbox',
    requirements: requirements.map(requirement => ({ ...requirement, provenance: { source: 'pa', interpretation: 'structured', messageId, receivedAt } })),
    messages: [{ id: messageId, text: goal, receivedAt }] };
}
function projectRequest(graph: OntologyObjectStore, owner: string, request: ServiceRequest, now: number) {
  const job: Job = { id: request.id, contextId: request.id, service: 'eigos.delegate', goal: request.originalGoal, state: 'working', messages: [],
    createdAt: request.messages[0]!.receivedAt, updatedAt: at(now), delegation: { backendVersion: BACKEND_VERSION, request, phase: 'planning', events: [] } };
  projectTask(graph, owner, job); projectExecution(graph, owner, job);
  projectBusinessChain(graph, owner, job, { intents: [], attempts: [], observations: [], grants: [], cases: [] });
}
function snapshot(domain: ServiceDomain, request: ServiceRequest, now: number, parameters: Record<string, unknown>, optionId: string): DomainSnapshot {
  const source = domainFixture(domain, now).snapshot;
  source.requestId = request.id; source.requestRevision = request.revision; source.parameters = parseDomainParameters(domain, parameters);
  source.option.id = optionId; source.sourceEventId = `${optionId}-prepared`;
  source.option.parametersDigest = digest(source.parameters); source.option.offeredParameters = structuredClone(source.parameters);
  return source;
}
function projectSnapshot(graph: OntologyObjectStore, owner: string, request: ServiceRequest, source: DomainSnapshot) {
  const projected = projectDomainSnapshot(graph, owner, domainCapabilityId(source.domain), request, source.parameters, source);
  if (projected.state !== 'typed_result') throw new Error(`${request.id}: the synthetic source snapshot violates the production projection contract`);
  return projected.subject!;
}
function patch(source: DomainSnapshot, type: string, values: Record<string, unknown>) {
  Object.assign(source.entities.find(entity => entity.type === type)!.properties, values);
}
function hotelResources(source: DomainSnapshot) {
  patch(source, 'HotelProperty', { childPolicy: { childrenAllowed: true, maximumChildAge: 17, maxChildrenPerRoom: 1 } });
  patch(source, 'RoomType', { hotelId: source.parameters.hotelId, guestCapacity: 3, maximumAdults: 2, maximumChildren: 1 });
  patch(source, 'RoomInventory', { hotelId: source.parameters.hotelId, roomTypeId: source.parameters.roomTypeId, checkIn: source.parameters.checkIn, checkOut: source.parameters.checkOut, roomsAvailable: 3 });
}

/** Only the ignored directory receives independent source facts. No provider,
 * Worker, model, payment, reservation or other business operation is invoked. */
export function architectureVariationDatasets(directory: string, now = Date.now()): DrillDataset[] {
  const destination = resolve(directory), withinData = relative(resolve('data'), destination);
  if (withinData.startsWith('..') || isAbsolute(withinData)) throw new Error('Independent variation facts must remain under the ignored data directory');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const datasets: DrillDataset[] = [], facts: Record<string, unknown> = {};
  const register = (id: typeof architectureVariationQuestionIds[number], question: string, current: ServiceRequest, inputFacts: unknown, initialize: DrillDataset['initialize']) => {
    facts[id] = { request: structuredClone(current), sourceFacts: structuredClone(inputFacts) };
    datasets.push({ id, question, request: current, asOf: at(now), datasetVersion: id === 'U02' ? 'architecture-variation-2' : 'architecture-variation-1', datasetDigest: digest({ request: current, sourceFacts: inputFacts }), initialize });
  };

  const oldHotel = domainFixture('hotel', now).parameters;
  const oldU01 = request('U01', `在合成酒店订${day(now, 1)}入住、${day(now, 2)}退房的两间双床房，三位成人，总预算900元，只需要确认预订。`, now, [
    { id: 'rooms', kind: 'quantity', role: 'room_count', strength: 'hard', expected: { amount: '2', unit: 'room' } },
    { id: 'guests', kind: 'quantity', role: 'guest_count', strength: 'hard', expected: { amount: '3', unit: 'person' } },
    { id: 'budget', kind: 'budget', role: 'service_total', strength: 'hard', expected: { minor: '90000', currency: 'CNY' } },
  ]);
  const oldSource = snapshot('hotel', oldU01, now, { ...oldHotel, checkIn: day(now, 1), checkOut: day(now, 2), rooms: 2, guests: 3, occupancy: { adults: 3, childAges: [] }, budget: { minor: '90000', currency: 'CNY' } }, 'U01-original');
  oldSource.option.total = { minor: '80000', currency: 'CNY' }; oldSource.option.observedAt = at(now, -12); hotelResources(oldSource);
  patch(oldSource, 'RoomInventory', { observedAt: at(now, -12) });
  const u01 = structuredClone(oldU01), correction = { id: 'variation-correction-U01', text: `改到${day(now, 2)}入住、${day(now, 4)}退房，只要一间；入住是一位成人和7岁孩子，总预算改为600元，其余仍按原要求办理。`, receivedAt: at(now, -4) };
  u01.revision = 2; u01.messages.push(correction);
  u01.requirements = u01.requirements.map(requirement => ({ ...requirement, expected: requirement.id === 'rooms' ? { amount: '1', unit: 'room' } : requirement.id === 'guests' ? { amount: '2', unit: 'person' } : { minor: '60000', currency: 'CNY' }, provenance: { source: 'pa', interpretation: 'structured', messageId: correction.id, receivedAt: correction.receivedAt } } as ServiceRequest['requirements'][number]));
  const currentSource = snapshot('hotel', u01, now, { ...oldHotel, checkIn: day(now, 2), checkOut: day(now, 4), rooms: 1, guests: 2, occupancy: { adults: 1, childAges: [7] }, budget: { minor: '60000', currency: 'CNY' } }, 'U01-current');
  currentSource.sourceVersion = 2; currentSource.option.total = { minor: '59000', currency: 'CNY' }; hotelResources(currentSource);
  for (const entity of currentSource.entities) entity.properties.sourceRevision = '2';
  register('U01', '这笔酒店委托现在应按什么日期、间数、入住人数和预算办理？哪些最初要求已经被后续消息替换？', u01, { priorRequest: oldU01, snapshots: [oldSource, currentSource] }, (graph, actor) => {
    projectRequest(graph, actor, oldU01, now - 12 * 60000); projectSnapshot(graph, actor, oldU01, oldSource);
    projectRequest(graph, actor, u01, now); projectSnapshot(graph, actor, u01, currentSource);
  });

  const u02 = request('U02', '两位成人和一位9岁孩子在合成酒店住两晚，一间房；每天每房至少含两份早餐，按明确的可免费取消期限办理，总费用不超过700元。', now);
  // U02 v2 explicitly records daily breakfast in both the request and source
  // rate plans; v1 facts and the first blind answer remain separate evidence.
  const parametersU02 = { ...oldHotel, checkIn: day(now, 3), checkOut: day(now, 5), rooms: 1, guests: 3, occupancy: { adults: 2, childAges: [9] }, breakfast: { included: true, servingsPerRoom: 2, frequency: 'daily' }, cancellation: { policyRef: oldHotel.cancellationPolicyRef, kind: 'free_until', freeUntil: at(now, 720) }, budget: { minor: '70000', currency: 'CNY' } };
  const hotelOffers = ['morning', 'courtyard'].map((label, index) => {
    const source = snapshot('hotel', u02, now, parametersU02, `U02-${label}`); hotelResources(source);
    source.option.total = { minor: index === 0 ? '62000' : '54000', currency: 'CNY' };
    const ratePlanId = `U02-rate-${label}`, inventory = source.entities.find(entity => entity.type === 'RoomInventory')!, oldInventory = inventory.id;
    inventory.id = `U02-inventory-${label}`; Object.assign(inventory.properties, { sourceId: inventory.id, ratePlanId });
    for (const relation of source.relationships) if (relation.fromId === oldInventory) relation.fromId = inventory.id;
    source.entities.push(resource('HotelRatePlan', ratePlanId, { hotelId: source.parameters.hotelId, roomTypeId: source.parameters.roomTypeId, ratePlanName: index === 0 ? '晨光套餐' : '庭院套餐',
      breakfast: { included: index === 0, servingsPerRoom: index === 0 ? 2 : 0, frequency: 'daily' }, cancellation: source.parameters.cancellation, paymentTiming: 'at_property', childPolicy: { childrenAllowed: true, maximumChildAge: index === 0 ? 17 : 7, maxChildrenPerRoom: 1 } }));
    source.relationships.push({ type: 'HotelRatePlanHotel', fromId: ratePlanId, toId: String(source.parameters.hotelId) }, { type: 'HotelRatePlanRoomType', fromId: ratePlanId, toId: String(source.parameters.roomTypeId) }, { type: 'RoomInventoryRatePlan', fromId: inventory.id, toId: ratePlanId });
    return source;
  });
  register('U02', '这两份酒店方案都写着同一酒店和房型。它们是否适合这次一家三口的入住要求，能否直接互换？请分别说明能够确认的条件。', u02, { snapshots: hotelOffers }, (graph, actor) => {
    projectRequest(graph, actor, u02, now); for (const source of hotelOffers) projectSnapshot(graph, actor, u02, source);
  });

  const u03 = request('U03', '马上从合成港湾站P3入口把三位乘客和两个大箱子送到合成剧院东门，全部费用不超过260元，要求实际送达。', now);
  const ride = domainFixture('ride', now), originLocation = { sourceId: 'synthetic-map-U03', placeId: 'harbour-P3', meetingPoint: 'P3入口' }, destinationLocation = { sourceId: 'synthetic-map-U03', placeId: 'theatre-east', meetingPoint: '剧院东门' };
  const rideSource = snapshot('ride', u03, now, { ...ride.parameters, mode: 'instant', timeZone: 'Asia/Shanghai', origin: 'harbour-P3', destination: 'theatre-east', passengers: 3, serviceClass: 'comfort', pickupBy: at(now, 20), arriveBy: at(now, 60), luggageCount: 2, luggageSize: 'large', originLocation, destinationLocation, budget: { minor: '26000', currency: 'CNY' } }, 'U03-ride');
  patch(rideSource, 'RideRoute', { origin: 'harbour-P3', destination: 'theatre-east', originLocation, destinationLocation, timeZone: 'Asia/Shanghai' });
  patch(rideSource, 'TransportVehicle', { vehicleClass: 'comfort', passengerCapacity: 4, luggageCapacity: { count: 2, maximumSize: 'large' } });
  rideSource.option.total = { minor: '18000', currency: 'CNY' }; rideSource.option.observedAt = at(now, -12);
  const rideReadback: DomainSnapshot = { ...structuredClone(rideSource), sourceVersion: 2, sourceEventId: 'U03-at-pickup', preparedSource: { eventId: rideSource.sourceEventId, version: 1 },
    observation: { providerReference: 'synthetic-trip-U03', observedAt: at(now, -1), requestDigest: digest(rideSource.parameters), state: 'at_pickup', mode: 'instant', timeZone: 'Asia/Shanghai', origin: 'harbour-P3', destination: 'theatre-east', passengers: 3, serviceClass: 'comfort', originLocation, destinationLocation, luggageCount: 2, luggageSize: 'large', assignmentId: 'assignment-U03' },
    resultEntities: [resource('TransportVehicle', 'allocated-vehicle-U03', { vehicleClass: 'comfort', passengerCapacity: 4, vehicleReference: 'allocated-vehicle-U03', luggageCapacity: { count: 2, maximumSize: 'large' } }), resource('TransportDriver', 'driver-U03', { driverAlias: '合成司机72', eligibility: 'verified', operatorId: 'synthetic-operator-U03' }), resource('TransportAssignment', 'assignment-U03', { providerReference: 'synthetic-trip-U03', vehicleId: 'allocated-vehicle-U03', driverId: 'driver-U03', mode: 'instant', state: 'at_pickup', assignedAt: at(now, -8), atPickupAt: at(now, -2) })],
    resultRelationships: [{ type: 'TransportAssignmentVehicle', fromId: 'assignment-U03', toId: 'allocated-vehicle-U03' }, { type: 'TransportAssignmentDriver', fromId: 'assignment-U03', toId: 'driver-U03' }] };
  register('U03', '司机消息说车辆已经到上车点。这辆车能满足本次人数和行李要求吗？这笔接送现在进行到哪一步，能否作为已送达交付？', u03, { snapshots: [rideSource, rideReadback] }, (graph, actor) => {
    projectRequest(graph, actor, u03, now); projectSnapshot(graph, actor, u03, rideSource); projectSnapshot(graph, actor, u03, rideReadback);
  });

  const u04 = request('U04', '为两人办理明天开始的两天自驾租车，只要求拿到准确有效的预订确认。本次不以实际用车、还车或押金结清作为委托终点。租费不超过1000元，押金不超过2000元。', now);
  const vehicle = domainFixture('vehicle', now), qualification = { age: 31, licenseClass: 'C1', licenseCountry: 'CN', licenseHeldMonths: 84 }, eligibility = { minimumAge: 21, maximumAge: 75, licenseClasses: ['C1'], licenseCountries: ['CN'], minimumLicenseHeldMonths: 12 }, insurance = { policyRef: 'U04-insurance', coverage: ['collision', 'third_party'], deductible: { minor: '50000', currency: 'CNY' } };
  const vehicleSource = snapshot('vehicle', u04, now, { ...vehicle.parameters, startsAt: at(now, 1440), endsAt: at(now, 4320), endpoint: 'confirmed', driverQualification: qualification, insurance: { coverage: ['collision', 'third_party'], maximumDeductible: { minor: '150000', currency: 'CNY' } }, transmission: 'automatic', budget: { minor: '100000', currency: 'CNY' }, depositLimit: { minor: '200000', currency: 'CNY' } }, 'U04-rental');
  patch(vehicleSource, 'RentalPolicy', { driverEligibility: eligibility, insurance });
  vehicleSource.entities = vehicleSource.entities.filter(entity => entity.type !== 'VehicleInspection');
  vehicleSource.option.total = { minor: '88000', currency: 'CNY' }; vehicleSource.option.deposit = { minor: '100000', currency: 'CNY' }; vehicleSource.option.observedAt = at(now, -10);
  vehicleSource.observation = { ...vehicle.result, requestDigest: digest(vehicleSource.parameters), startsAt: vehicleSource.parameters.startsAt, endsAt: vehicleSource.parameters.endsAt, confirmedAt: at(now, -5), total: { minor: '88000', currency: 'CNY' }, deposit: { minor: '100000', currency: 'CNY' }, depositState: 'pending', driverQualification: qualification, driverEligibility: eligibility, insurance, transmission: 'automatic' };
  register('U04', '这次自驾委托只要求取得预订确认。现在还没取车，押金也尚未结清，能否说明本次委托已达到终点？哪些后续状态仍不能据此确认？', u04, { snapshot: vehicleSource }, (graph, actor) => {
    projectRequest(graph, actor, u04, now); projectSnapshot(graph, actor, u04, vehicleSource);
  });

  const u05 = request('U05', '订两份大份香菇饭，酱汁单独放，不能含花生且要避免花生交叉接触，45分钟内送到合成影棚C入口，总预算120元。', now);
  const food = domainFixture('food', now), items = [{ sku: 'meal-A', quantity: 2, specification: 'large-mushroom-rice', selections: [{ groupId: 'sauce', optionId: 'separate' }] }], foodLocation = { sourceId: 'synthetic-map-U05', placeId: 'studio-C', meetingPoint: '影棚C入口' };
  const foodSource = snapshot('food', u05, now, { ...food.parameters, items, destination: 'studio-C', destinationLocation: foodLocation, excludedIngredients: ['peanuts'], avoidCrossContact: true, deliverBy: at(now, 45), budget: { minor: '12000', currency: 'CNY' } }, 'U05-meal');
  patch(foodSource, 'FoodMerchant', { deliveryLocation: foodLocation });
  patch(foodSource, 'MenuItem', { specification: 'large-mushroom-rice', merchantId: foodSource.parameters.merchantId, ingredients: ['rice', 'mushroom'], ingredientsKnown: true, optionGroups: [{ groupId: 'sauce', optionIds: ['mixed', 'none'], minimumSelections: 1, maximumSelections: 1 }], crossContactKnown: false, crossContactIngredients: [] });
  foodSource.option.total = { minor: '9800', currency: 'CNY' };
  register('U05', '这份外卖方案可以按用户所选的酱汁方式和忌口要求直接提交吗？哪些条件已经明确，哪些仍需核实？', u05, { snapshot: foodSource }, (graph, actor) => {
    projectRequest(graph, actor, u05, now); projectSnapshot(graph, actor, u05, foodSource);
  });

  const u06 = request('U06', '为8岁孩子预约合成医疗中心明天下午的普通首诊，只接受行政年龄条件允许儿童的号源；医疗适配性另请医生判断。挂号费不超过300元。', now);
  const appointment = domainFixture('appointment', now), appointmentSource = snapshot('appointment', u06, now, { ...appointment.parameters, startsAt: `${day(now + 8 * 3600000, 1)}T14:30:00+08:00`, patientAge: 8, visitType: 'first_visit', category: 'general', budget: { minor: '30000', currency: 'CNY' } }, 'U06-registration');
  patch(appointmentSource, 'PatientProfile', { age: 8 });
  patch(appointmentSource, 'AppointmentSlot', { startsAt: appointmentSource.parameters.startsAt, administration: { visitTypes: ['follow_up'], categories: ['general'], referralRequired: false, minimumAge: 18, maximumAge: 65 } });
  appointmentSource.option.total = { minor: '18000', currency: 'CNY' };
  register('U06', '这次给孩子选的号源能满足年龄和首诊要求吗？有号、医生名字匹配、来源显示可预约是否足够，下一步需要处理什么？', u06, { snapshot: appointmentSource }, (graph, actor) => {
    projectRequest(graph, actor, u06, now); projectSnapshot(graph, actor, u06, appointmentSource);
  });

  // Exercise actual production parsing, projection and root readback before a
  // case can reach the blind host. This does not generate a participant answer.
  for (const data of datasets) {
    const database = new DatabaseSync(':memory:');
    try {
      const graph = new OntologyObjectStore(database, undefined, () => now), actor = data.owner ?? data.id;
      data.initialize(graph, actor, database);
      if (graph.read(actor, { type: 'ServiceRequest', id: data.request.id }).properties.revision !== data.request.revision) throw new Error(`${data.id}: current request projection was not retained`);
    } finally { database.close(); }
  }
  writeFileSync(join(destination, 'reference-variation-facts.json'), JSON.stringify({ model: businessModel.ref, asOf: at(now), scope: 'synthetic source facts; no participant answers or business calls', facts }, null, 2), { mode: 0o600 });
  return datasets;
}
