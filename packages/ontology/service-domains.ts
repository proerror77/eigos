import { z } from 'zod';
import { objectRefSchema, type ActionDefinition, type FunctionDefinition, type InterfaceDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';
import type { RequirementRoleDefinition } from './execution.js';
import { appointmentAdministrationSchema, appointmentCategorySchema, appointmentVisitSchema, cancellationTermsSchema, driverEligibilitySchema, driverQualificationSchema, hotelBreakfastSchema, hotelChildPolicySchema, hotelOccupancySchema, luggageCapacitySchema, menuOptionGroupSchema, menuSelectionsSchema, rentalInsuranceRequirementSchema, rentalInsuranceSchema, sourceLocationSchema, transportAssignmentSchema, vehicleInspectionDetailsSchema } from './domain-schemas.js';
export { domainDataSchemas } from './domain-schemas.js';

const text = z.string().trim().min(1).max(500);
const instant = z.iso.datetime({ offset: true });
const count = z.number().int().min(1).max(100);
const money = z.object({ minor: z.string().regex(/^(0|[1-9]\d{0,17})$/), currency: z.enum(['CNY', 'USD', 'EUR']) }).strict();
const zone = z.string().min(1).max(100).refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } });
const date = z.iso.date();
const foodLine = z.object({ sku: text, quantity: count, specification: text, selections: menuSelectionsSchema.optional() }).strict();
const leg = z.object({ id: text, origin: text, destination: text, startsAt: instant, endsAt: instant, mode: text, transferMinutes: z.number().int().min(0).max(1440), bookingRequired: z.boolean(), dependsOn: z.array(text).max(20).optional() }).strict();
const transportNeeds = { luggageCount: z.number().int().min(0).max(100).optional(), luggageSize: z.enum(['small', 'medium', 'large']).optional(), wheelchairRequired: z.boolean().optional() };
const hotelTerms = { ratePlanId: text.optional(), occupancy: hotelOccupancySchema.optional(), breakfast: hotelBreakfastSchema.optional(), cancellation: cancellationTermsSchema.optional(), paymentTiming: z.enum(['prepaid', 'at_property']).optional() };
const appointmentDetails = { visitType: appointmentVisitSchema.optional(), category: appointmentCategorySchema.optional(), patientAge: z.number().int().min(0).max(120).optional(), referralKey: text.optional() };
export const domainNames = ['ride', 'appointment', 'food', 'hotel', 'itinerary', 'vehicle'] as const;
export type ServiceDomain = typeof domainNames[number];
const role = (kind: RequirementRoleDefinition['kind'], role: string, description: string): RequirementRoleDefinition => ({ kind, role, description });
const totalRole = role('budget', 'service_total', 'All mandatory service fees; a refundable deposit is separate');
const completionRole = role('deadline', 'completion', 'The requested business endpoint deadline, not each scheduled time in the input');
export const domainRequirementRoles: Record<ServiceDomain, RequirementRoleDefinition[]> = {
  ride: [role('quantity', 'passenger_count', 'People riding'), totalRole, completionRole, role('deadline', 'pickup', 'Latest actual pickup'), role('deadline', 'arrival', 'Latest actual arrival'), role('location', 'origin', 'Actual pickup origin'), role('location', 'destination', 'Actual trip destination')],
  appointment: [role('quantity', 'patient_count', 'Explicit number of patients; do not infer a new count constraint'), totalRole, completionRole, role('deadline', 'registration', 'Latest effective registration confirmation'), role('location', 'venue', 'Exact hospital campus identity')],
  food: [role('quantity', 'item_quantity', 'Meal portions; preserve individual SKU quantities in input'), totalRole, completionRole, role('location', 'destination', 'Actual food delivery destination')],
  hotel: [role('quantity', 'room_count', 'Rooms, not people'), role('quantity', 'guest_count', 'Guests, not rooms'), totalRole, completionRole, role('location', 'venue', 'Exact hotel identity; check-in/out dates remain typed schedule fields')],
  itinerary: [role('quantity', 'traveler_count', 'Travelers; leg counts stay in typed input'), totalRole, completionRole, role('location', 'destination', 'Final planned destination; intermediate endpoints stay on each leg')],
  vehicle: [role('quantity', 'passenger_count', 'People using the vehicle'), totalRole, role('budget', 'deposit', 'Maximum deposit separately from service charges'), completionRole, role('location', 'pickup', 'Vehicle pickup location'), role('location', 'return', 'Vehicle return location; scheduled rental times remain typed input')],
};
export const domainCommitmentsSchema = z.object({ completion: instant.optional(), pickup: instant.optional(), arrival: instant.optional(), registration: instant.optional() }).strict();
export const domainParameterSchemas = {
  ride: z.object({ origin: text, destination: text, passengers: count, serviceClass: text, pickupBy: instant, arriveBy: instant, budget: money, mode: z.literal('instant').optional(), timeZone: zone.optional(), originLocation: sourceLocationSchema.optional(), destinationLocation: sourceLocationSchema.optional(), ...transportNeeds }).strict(),
  appointment: z.object({ hospitalId: text, departmentId: text, practitionerId: text, patientKey: text, startsAt: instant, timeZone: zone, registerBy: instant, budget: money, ...appointmentDetails }).strict(),
  food: z.object({ merchantId: text, items: z.array(foodLine).min(1).max(30), destination: text, deliverBy: instant, excludedIngredients: z.array(text).max(30), budget: money, avoidCrossContact: z.boolean().optional(), destinationLocation: sourceLocationSchema.optional() }).strict(),
  hotel: z.object({ hotelId: text, roomTypeId: text, checkIn: date, checkOut: date, timeZone: zone, rooms: count, guests: count, cancellationPolicyRef: text, endpoint: z.enum(['confirmed', 'stay_completed']), budget: money, ...hotelTerms }).strict(),
  itinerary: z.object({ startsAt: instant, endsAt: instant, timeZone: zone, travelers: count, legs: z.array(leg).min(1).max(20), endpoint: z.enum(['plan', 'booked']), budget: money }).strict(),
  vehicle: z.object({ mode: z.enum(['chauffeured', 'self_drive']), pickup: text, returnLocation: text, startsAt: instant, endsAt: instant, timeZone: zone, vehicleClass: text, passengers: count, driverKey: text.optional(), endpoint: z.enum(['confirmed', 'completed']), budget: money, depositLimit: money, ...transportNeeds, pickupLocation: sourceLocationSchema.optional(), returnLocationDetails: sourceLocationSchema.optional(), driverQualification: driverQualificationSchema.optional(), insurance: rentalInsuranceRequirementSchema.optional(), cancellation: cancellationTermsSchema.optional(), inspectionRequired: z.boolean().optional(), transmission: z.enum(['manual', 'automatic']).optional() }).strict(),
};
export type DomainParameters = { [K in ServiceDomain]: z.infer<typeof domainParameterSchemas[K]> };
const payment = z.enum(['not_required', 'pending', 'paid', 'failed', 'unknown']);
const common = { providerReference: text, observedAt: instant, requestDigest: z.string().regex(/^[a-f0-9]{64}$/) };
export const domainResultSchemas = {
  ride: z.object({ ...common, state: z.enum(['requested', 'accepted', 'assigned', 'arriving', 'at_pickup', 'in_progress', 'completed', 'canceled', 'failed', 'unknown']), origin: text.optional(), destination: text.optional(), passengers: count.optional(), serviceClass: text.optional(), pickedUpAt: instant.optional(), arrivedAt: instant.optional(), finalFare: money.optional(), fareComplete: z.boolean().optional(), mode: z.literal('instant').optional(), timeZone: zone.optional(), originLocation: sourceLocationSchema.optional(), destinationLocation: sourceLocationSchema.optional(), ...transportNeeds, assignmentId: text.optional() }).strict(),
  appointment: z.object({ ...common, state: z.enum(['requested', 'pending', 'held', 'confirmed', 'waitlisted', 'canceled', 'expired', 'rejected', 'unknown']), hospitalId: text.optional(), departmentId: text.optional(), practitionerId: text.optional(), patientKey: text.optional(), startsAt: instant.optional(), timeZone: zone.optional(), confirmedAt: instant.optional(), holdExpiresAt: instant.optional(), fee: money.optional(), paymentState: payment.optional(), eligibilityVerified: z.boolean().optional(), ...appointmentDetails, referralVerified: z.boolean().optional() }).strict(),
  food: z.object({ ...common, state: z.enum(['requested', 'accepted', 'preparing', 'delivering', 'partial', 'delivered', 'canceled', 'failed', 'unknown']), merchantId: text.optional(), deliveredItems: z.array(foodLine).max(30).optional(), destination: text.optional(), deliveredAt: instant.optional(), total: money.optional(), feesComplete: z.boolean().optional(), ingredientCheck: z.enum(['verified', 'violated', 'unknown']).optional(), finalDelivery: z.boolean().optional(), crossContactCheck: z.enum(['verified', 'violated', 'unknown']).optional(), destinationLocation: sourceLocationSchema.optional() }).strict(),
  hotel: z.object({ ...common, state: z.enum(['requested', 'held', 'pending', 'confirmed', 'checked_in', 'checked_out', 'canceled', 'expired', 'rejected', 'unknown']), hotelId: text.optional(), roomTypeId: text.optional(), checkIn: date.optional(), checkOut: date.optional(), timeZone: zone.optional(), rooms: count.optional(), guests: count.optional(), cancellationPolicyRef: text.optional(), confirmationCode: text.optional(), confirmedAt: instant.optional(), paymentState: payment.optional(), total: money.optional(), feesComplete: z.boolean().optional(), checkedInAt: instant.optional(), checkedOutAt: instant.optional(), ...hotelTerms }).strict(),
  itinerary: z.object({ ...common, state: z.enum(['draft', 'validated', 'booked', 'invalid', 'canceled', 'unknown']), validatedAt: instant.optional(), legs: z.array(leg.extend({ feasibility: z.enum(['verified', 'impossible', 'unknown']), bookingState: z.enum(['not_required', 'unbooked', 'held', 'confirmed', 'canceled', 'unknown']), bookingReference: text.optional() })).min(1).max(20).optional(), total: money.optional(), feesComplete: z.boolean().optional(), unbookedDisclosed: z.boolean().optional() }).strict(),
  vehicle: z.object({ ...common, state: z.enum(['requested', 'held', 'pending', 'confirmed', 'assigned', 'at_pickup', 'in_use', 'completed', 'returned', 'canceled', 'expired', 'rejected', 'unknown']), mode: z.enum(['chauffeured', 'self_drive']).optional(), pickup: text.optional(), returnLocation: text.optional(), startsAt: instant.optional(), endsAt: instant.optional(), timeZone: zone.optional(), vehicleClass: text.optional(), passengers: count.optional(), driverKey: text.optional(), eligibilityVerified: z.boolean().optional(), confirmationCode: text.optional(), confirmedAt: instant.optional(), total: money.optional(), feesComplete: z.boolean().optional(), deposit: money.optional(), pickedUpAt: instant.optional(), returnedAt: instant.optional(), returnAccepted: z.boolean().optional(), depositState: z.enum(['pending', 'settled', 'disputed', 'unknown']).optional(), ...transportNeeds, pickupLocation: sourceLocationSchema.optional(), returnLocationDetails: sourceLocationSchema.optional(), driverQualification: driverQualificationSchema.optional(), driverEligibility: driverEligibilitySchema.optional(), insurance: rentalInsuranceSchema.optional(), cancellation: cancellationTermsSchema.optional(), transmission: z.enum(['manual', 'automatic', 'unknown']).optional(), assignmentId: text.optional(), pickupInspectionId: text.optional(), returnInspectionId: text.optional() }).strict(),
};
export type DomainResults = { [K in ServiceDomain]: z.infer<typeof domainResultSchemas[K]> };
export interface DomainDefinition {
  id: ServiceDomain; name: string; requestType: string; candidateType: string; resultType: string; action: string;
  eligibleFunction: string; outcomeFunction: string; effect: 'order' | 'reserve' | 'local';
  parameters: z.ZodObject; result: z.ZodObject; objects: string[]; resultObjects: string[]; endpoint: string;
}
const metadata = [
  ['ride', '打车', 'RideRequest', 'RideOption', 'RideTrip', 'RequestRide', 'order', ['RideRoute', 'TransportVehicle'], '实际接送路线、人数、车型、上车及到达时间与最终完整车费；接单不是到达'],
  ['appointment', '医院挂号', 'AppointmentRequest', 'AppointmentOption', 'MedicalAppointment', 'RequestMedicalAppointment', 'reserve', ['Hospital', 'MedicalDepartment', 'Practitioner', 'PatientProfile', 'AppointmentSlot'], '指定就诊人、院区、科室、医生、时段的有效挂号确认；候补、支付或号源列表不是挂号成功'],
  ['food', '外卖', 'FoodRequest', 'FoodOption', 'FoodDelivery', 'RequestFoodOrder', 'order', ['FoodMerchant', 'MenuItem'], '指定商家、菜品规格与数量送达指定地点和期限，核对完整费用及已约定忌口'],
  ['hotel', '酒店', 'HotelRequest', 'HotelOption', 'HotelReservation', 'RequestHotelReservation', 'reserve', ['HotelProperty', 'RoomType', 'RoomInventory', 'HotelRatePlan'], '确认指定酒店、房型、套餐、入住退房日期、间数人数与条款；住宿完成是另一个明确终点'],
  ['itinerary', '行程安排', 'ItineraryRequest', 'ItineraryOption', 'Itinerary', 'BuildItinerary', 'local', ['ItineraryItem', 'TravelLeg'], '方案满足时间、衔接、费用与可行性并披露未预订项；要求订妥时逐项核对确认'],
  ['vehicle', '预约用车与自驾租车', 'VehicleRequest', 'VehicleOption', 'VehicleBooking', 'RequestVehicleBooking', 'reserve', ['VehicleClass', 'RentalPolicy', 'VehicleInspection'], '指定模式、车型、人数、地点、租期与条件的确认；完成租用还需交接、归还及押金结清'],
] as const;
export const serviceDomains: DomainDefinition[] = metadata.map(([id, name, requestType, candidateType, resultType, action, effect, objects, endpoint]) => ({ id, name, requestType, candidateType, resultType, action, effect, objects: [...objects], resultObjects: id === 'ride' ? ['TransportVehicle', 'TransportDriver', 'TransportAssignment'] : id === 'vehicle' ? ['TransportVehicle', 'TransportDriver', 'TransportAssignment', 'VehicleInspection'] : [], endpoint, eligibleFunction: `${id}Eligibility`, outcomeFunction: `${id}Outcome`, parameters: domainParameterSchemas[id], result: domainResultSchemas[id] }));
export function serviceDomain(id: string): DomainDefinition {
  const definition = serviceDomains.find(d => d.id === id);
  if (!definition) throw new Error('Unknown service domain');
  return definition;
}
export function parseDomainParameters<K extends ServiceDomain>(domain: K, value: unknown): DomainParameters[K] {
  const parsed = domainParameterSchemas[domain].parse(value) as DomainParameters[K];
  const p = parsed as Record<string, unknown>;
  const before = (a: string, b: string) => Date.parse(String(p[a])) < Date.parse(String(p[b]));
  if (domain === 'ride' && !before('pickupBy', 'arriveBy') || domain === 'hotel' && !before('checkIn', 'checkOut') || ['vehicle', 'itinerary'].includes(domain) && !before('startsAt', 'endsAt')) throw new Error('Service time range must be strictly increasing');
  if (domain === 'food') {
    const items = (parsed as DomainParameters['food']).items;
    if (new Set(items.map(i => i.sku)).size !== items.length) throw new Error('Food selections require unique source SKU identities');
    if (p.avoidCrossContact === true && !(p.excludedIngredients as string[]).length) throw new Error('Cross-contact restrictions require the exact excluded ingredients');
  }
  if (domain === 'itinerary') {
    const legs = (parsed as DomainParameters['itinerary']).legs;
    if (new Set(legs.map(l => l.id)).size !== legs.length || legs.some(l => Date.parse(l.startsAt) >= Date.parse(l.endsAt))) throw new Error('Itinerary leg identities and time ranges must be valid');
    const byId = new Map(legs.map(leg => [leg.id, leg]));
    const checked = new Set<string>();
    const visit = (id: string, path: Set<string>) => {
      if (path.has(id)) throw new Error('Itinerary dependencies must be acyclic');
      if (checked.has(id)) return;
      const item = byId.get(id)!;
      if (item.dependsOn && new Set(item.dependsOn).size !== item.dependsOn.length) throw new Error('Itinerary dependency identities must be unique');
      for (const dependency of item.dependsOn ?? []) {
        const previous = byId.get(dependency);
        if (!previous) throw new Error('Itinerary dependency must identify a requested leg');
        if (Date.parse(previous.endsAt) + item.transferMinutes * 60000 > Date.parse(item.startsAt)) throw new Error('Itinerary dependency must finish before its dependent leg');
        visit(dependency, new Set([...path, id]));
      }
      checked.add(id);
    };
    for (const item of legs) visit(item.id, new Set());
  }
  if (domain === 'vehicle' && p.mode === 'self_drive' && !p.driverKey) throw new Error('Self-drive rental requires an opaque driver reference');
  if (domain === 'vehicle' && p.mode === 'chauffeured' && (p.driverQualification !== undefined || p.insurance !== undefined || p.inspectionRequired !== undefined || p.transmission !== undefined)) throw new Error('Customer driver, rental insurance, inspection and transmission requirements belong to self-drive rentals');
  if ((domain === 'ride' || domain === 'vehicle') && p.luggageSize !== undefined && p.luggageCount === undefined) throw new Error('Luggage size requires an explicit luggage count');
  if (domain === 'hotel') {
    const hotel = parsed as DomainParameters['hotel'];
    if (hotel.occupancy && hotel.occupancy.adults + hotel.occupancy.childAges.length !== hotel.guests) throw new Error('Hotel adults and children must equal the total guest count');
    if (hotel.cancellation && hotel.cancellation.policyRef !== hotel.cancellationPolicyRef) throw new Error('Structured hotel cancellation terms must identify the requested policy');
  }
  const locations: Record<string, string> = { originLocation: 'origin', destinationLocation: 'destination', pickupLocation: 'pickup', returnLocationDetails: 'returnLocation' };
  for (const [field, role] of Object.entries(locations)) if (p[field] && (p[field] as { placeId: string }).placeId !== p[role]) throw new Error('Source-qualified locations must identify their exact service location role');
  if (domain === 'appointment' && Date.parse(String(p.registerBy)) > Date.parse(String(p.startsAt))) throw new Error('Registration deadline cannot follow the appointment');
  return parsed;
}

const prop = (schema: z.ZodType, description: string, required = false, restricted = false): PropertyDefinition => {
  const json = z.toJSONSchema(schema), kind = json.type === 'string' ? 'string' : json.type === 'integer' ? 'integer' : json.type === 'boolean' ? 'boolean' : json.type === 'array' ? 'array' : json.type === 'number' ? 'decimal' : 'struct';
  return { kind, schema, description, required, restricted, source: 'Versioned task input or verified domain source mapping; never inferred provider success' };
};
const idProp = { ...prop(text, 'Stable namespaced object identity', true), kind: 'string' as const };
const titleProp = { ...prop(text, 'Business display name, never identity', true), kind: 'string' as const };
function object(id: string, name: string, fields: Record<string, z.ZodType>, evidence = false): ObjectTypeDefinition {
  return { id, version: '1', name, aliases: [id, name], description: name, primaryKey: 'objectId', titleKey: 'displayTitle', properties: { objectId: idProp, displayTitle: titleProp, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, prop(v, `${name}: ${k}`)])) }, interfaces: evidence ? [{ id: 'EvidenceBacked' }] : [] };
}
export const domainObjects: ObjectTypeDefinition[] = [];
export const domainLinks: LinkDefinition[] = [];
const link = (id: string, from: string, name: string, to: string, reverse: string, many = false, required = true) => domainLinks.push({ id, description: `${from}.${name} ↔ ${to}.${reverse}`, from: { type: from, name, many, required }, to: { type: to, name: reverse, many: true } });
export const domainEvidenceScopes: Record<string, string> = {};
export const domainEntityObservationType = (entityType: string) => `${entityType}Observation`;
export const domainEntityLinkName = (entityType: string) => entityType[0]!.toLowerCase() + entityType.slice(1);
const sourceEntityObservationProperties: Record<string, PropertyDefinition> = {
  sourceIdentity: prop(text, 'Verified source namespace', true),
  providerIdentity: prop(text, 'Provider identity within the source namespace', true),
  nativeIdentity: prop(text, 'Resource identity within that source and provider', true),
  sourceRevision: prop(text, 'Source-issued resource revision, never a local row revision', true),
  sourceVersion: prop(z.number().int().positive(), 'Monotonic source event version', true),
  sourceEventId: prop(text, 'Original source event identity', true),
  observedAt: { ...prop(instant, 'Source observation time', true), kind: 'timestamp' },
  contentDigest: prop(z.string().regex(/^[a-f0-9]{64}$/), 'Digest of the exact validated source entity including restricted fields', true),
  valuesDigest: prop(z.string().regex(/^[a-f0-9]{64}$/), 'Digest of the public normalized resource properties', true),
  snapshot: prop(z.record(z.string(), z.unknown()), 'Immutable public property observation; restricted source fields are omitted', true),
};
export const domainInterfaces: InterfaceDefinition[] = [{
  id: 'SourceEntityObservation', description: 'Immutable source observations of stable business resources across the six service domains.',
  parents: ['EvidenceBacked'], properties: sourceEntityObservationProperties,
  links: [{ name: 'provider', target: 'Provider', many: false }],
}];
const auxiliaryFields: Record<string, Record<string, z.ZodType>> = {
  RideRoute: { origin: text, destination: text, originLocation: sourceLocationSchema, destinationLocation: sourceLocationSchema, timeZone: zone },
  TransportVehicle: { vehicleClass: text, passengerCapacity: count, vehicleReference: text, luggageCapacity: luggageCapacitySchema, wheelchairAccessible: z.boolean(), transmission: z.enum(['manual', 'automatic', 'unknown']) },
  TransportDriver: { driverAlias: text, eligibility: z.enum(['verified', 'ineligible', 'unknown']), operatorId: text },
  TransportAssignment: { ...transportAssignmentSchema.shape },
  Hospital: { campusName: text, address: text, timeZone: zone },
  MedicalDepartment: { hospitalId: text, departmentName: text },
  Practitioner: { hospitalId: text, departmentId: text, practitionerName: text },
  PatientProfile: { patientAlias: text, eligibility: z.enum(['verified', 'ineligible', 'unknown']), age: z.number().int().min(0).max(120), referralKey: text, referralVerified: z.boolean() },
  AppointmentSlot: { hospitalId: text, departmentId: text, practitionerId: text, startsAt: instant, timeZone: zone, availableCount: z.number().int().min(0).max(10000), expiresAt: instant, administration: appointmentAdministrationSchema },
  FoodMerchant: { merchantName: text, address: text, deliveryLocation: sourceLocationSchema },
  MenuItem: { sku: text, specification: text, ingredients: z.array(text).max(100), ingredientsKnown: z.boolean(), merchantId: text, optionGroups: z.array(menuOptionGroupSchema).max(30), crossContactIngredients: z.array(text).max(100), crossContactKnown: z.boolean() },
  HotelProperty: { hotelName: text, address: text, timeZone: zone, childPolicy: hotelChildPolicySchema },
  RoomType: { roomTypeName: text, guestCapacity: count, bedDescription: text, hotelId: text, maximumAdults: count, maximumChildren: z.number().int().min(0).max(100) },
  RoomInventory: { checkIn: date, checkOut: date, roomsAvailable: z.number().int().min(0).max(10000), observedAt: instant, expiresAt: instant, hotelId: text, roomTypeId: text, ratePlanId: text },
  HotelRatePlan: { hotelId: text, roomTypeId: text, ratePlanName: text, breakfast: hotelBreakfastSchema, cancellation: cancellationTermsSchema, paymentTiming: z.enum(['prepaid', 'at_property', 'unknown']), childPolicy: hotelChildPolicySchema },
  ItineraryItem: { startsAt: instant, endsAt: instant, location: text, bookingRequired: z.boolean(), bookingReference: text },
  TravelLeg: { ...leg.shape, feasibility: z.enum(['verified', 'impossible', 'unknown']) },
  VehicleClass: { className: text, passengerCapacity: count, transmission: z.enum(['manual', 'automatic', 'unknown']), luggageCapacity: luggageCapacitySchema, wheelchairAccessible: z.boolean() },
  RentalPolicy: { driverEligibilityRule: text, cancellationPolicyRef: text, insuranceTerms: text, depositLimit: money, vehicleClassId: text, driverEligibility: driverEligibilitySchema, insurance: rentalInsuranceSchema, cancellation: cancellationTermsSchema, pickupLocation: sourceLocationSchema, returnLocationDetails: sourceLocationSchema },
  VehicleInspection: { stage: z.enum(['pickup', 'return']), occurredAt: instant, accepted: z.boolean(), damageReportRef: text, providerReference: text, vehicleId: text, details: vehicleInspectionDetailsSchema },
};
for (const d of serviceDomains) {
  domainObjects.push(object(d.requestType, `${d.name}要求`, { ...d.parameters.shape, requestRevision: z.number().int().positive(), capturedAt: instant }));
  domainObjects.push(object(d.candidateType, `${d.name}候选方案`, { parametersDigest: z.string().regex(/^[a-f0-9]{64}$/), offeredParameters: d.parameters, commitments: domainCommitmentsSchema.optional(), ...(d.id === 'vehicle' ? { deposit: money } : {}), requestRevision: z.number().int().positive(), availability: z.enum(['available', 'unavailable', 'unknown']), eligibility: z.enum(['verified', 'ineligible', 'unknown']), observedAt: instant, expiresAt: instant, total: money, feesComplete: z.boolean(), commitmentBy: instant.optional(), termsMatch: z.boolean() }, true));
  domainObjects.push(object(d.resultType, `${d.name}结果`, { ...d.result.shape, requestRevision: z.number().int().positive(), sourceVersion: z.number().int().positive() }, true));
  domainObjects.find(o => o.id === d.requestType)!.version = '2';
  domainObjects.find(o => o.id === d.candidateType)!.version = '3';
  domainObjects.find(o => o.id === d.resultType)!.version = '2';
  for (const type of [d.requestType, d.candidateType, d.resultType]) link(`${type}Request`, type, 'request', 'ServiceRequest', `${d.id}${type === d.requestType ? 'Requirements' : type === d.candidateType ? 'Options' : 'Results'}`);
  for (const type of [d.candidateType, d.resultType]) {
    link(`${type}Requirements`, type, 'requirements', d.requestType, type === d.candidateType ? 'options' : 'results');
    link(`${type}Evidence`, type, 'sourceReceipts', 'SourceReceipt', `${type[0]!.toLowerCase()}${type.slice(1)}s`, true);
    link(`${type}Provider`, type, 'provider', 'Provider', `${type[0]!.toLowerCase()}${type.slice(1)}s`);
    domainEvidenceScopes[type] = `domain_${d.id}`;
  }
  link(`${d.resultType}Option`, d.resultType, 'selectedOption', d.candidateType, 'results');
  for (const auxiliary of new Set([...d.objects, ...d.resultObjects])) {
    const names: Record<string, string> = { RideRoute: '乘车路线', TransportVehicle: '接送车辆', TransportDriver: '服务驾驶员', TransportAssignment: '司机车辆分配', Hospital: '医院院区', MedicalDepartment: '科室', Practitioner: '执业医师', PatientProfile: '就诊人引用', AppointmentSlot: '挂号号源', FoodMerchant: '外卖商家', MenuItem: '菜单菜品规格', HotelProperty: '酒店物业', RoomType: '酒店房型', RoomInventory: '客房可用性', HotelRatePlan: '酒店房价套餐', ItineraryItem: '行程事项', TravelLeg: '交通路段', VehicleClass: '用车车型', RentalPolicy: '租用条款', VehicleInspection: '车辆交接检查' };
    const fields: Record<string, z.ZodType> = { sourceId: text, sourceRevision: text, ...auxiliaryFields[auxiliary] };
    const definition = object(auxiliary, names[auxiliary]!, fields);
    if (auxiliary === 'PatientProfile') {
      definition.properties.identityDocument = prop(text, 'Private patient identity; unavailable to agent queries', false, true);
      definition.properties.contact = prop(text, 'Private patient contact; unavailable to agent queries', false, true);
    }
    const existing = domainObjects.some(object => object.id === auxiliary);
    if (!['Hospital', 'MedicalDepartment', 'Practitioner', 'ItineraryItem', 'HotelRatePlan', 'TransportDriver', 'TransportAssignment'].includes(auxiliary)) definition.version = '2';
    if (auxiliary === 'TransportDriver') {
      definition.properties.contact = prop(text, 'Private driver contact; omitted from agent-visible source observations', false, true);
      definition.properties.licenseReference = prop(text, 'Private licensing reference; eligibility is an independent source fact', false, true);
    }
    const requiredFields: Record<string, string[]> = {
      HotelRatePlan: ['sourceId', 'sourceRevision', 'hotelId', 'roomTypeId'],
      TransportDriver: ['sourceId', 'sourceRevision'],
      TransportAssignment: ['sourceId', 'sourceRevision', 'providerReference', 'vehicleId', 'mode', 'state', 'assignedAt'],
    };
    for (const field of requiredFields[auxiliary] ?? []) definition.properties[field]!.required = true;
    if (!existing) domainObjects.push(definition);
    if (d.objects.includes(auxiliary)) link(`${d.requestType}${auxiliary}`, d.requestType, auxiliary[0]!.toLowerCase() + auxiliary.slice(1), auxiliary, 'serviceRequirements', ['MenuItem', 'ItineraryItem', 'TravelLeg'].includes(auxiliary), false);
    // Stable resource subjects and immutable source observations stay separate.
    // Source-derived resources attach to the candidate/result that returned them
    // rather than overwriting user-selected resource links.
    const observationType = domainEntityObservationType(auxiliary), name = domainEntityLinkName(auxiliary);
    const observation = object(observationType, `${names[auxiliary]}来源观察`, {});
    observation.interfaces = [{ id: 'SourceEntityObservation' }];
    Object.assign(observation.properties, sourceEntityObservationProperties);
    if (!existing) domainObjects.push(observation);
    // Shared transport resources retain their original registered receipt scope.
    // Reusing them for a booked vehicle does not create another vehicle identity.
    domainEvidenceScopes[auxiliary] ??= `domain_${d.id}`; domainEvidenceScopes[observationType] ??= `domain_${d.id}`;
    const many = ['MenuItem', 'ItineraryItem', 'TravelLeg'].includes(auxiliary);
    if (d.objects.includes(auxiliary)) {
      link(`${d.candidateType}${auxiliary}`, d.candidateType, name, auxiliary, 'sourceOptions', many, false);
      link(`${d.candidateType}${observationType}`, d.candidateType, `${name}Observations`, observationType, 'options', many, false);
    }
    if (d.resultObjects.includes(auxiliary)) {
      const resultMany = auxiliary === 'VehicleInspection';
      link(`${d.resultType}${auxiliary}`, d.resultType, name, auxiliary, `${d.id}Results`, resultMany, false);
      link(`${d.resultType}${observationType}`, d.resultType, `${name}Observations`, observationType, `${d.id}Results`, resultMany, false);
    }
    if (existing) continue;
    link(`${auxiliary}Evidence`, auxiliary, 'sourceReceipts', 'SourceReceipt', `${name}Entities`, true, false);
    link(`${auxiliary}CurrentObservation`, auxiliary, 'currentObservation', observationType, 'currentEntities', false, false);
    link(`${observationType}Entity`, observationType, 'entity', auxiliary, 'sourceObservations');
    link(`${observationType}Provider`, observationType, 'provider', 'Provider', `${name}Observations`);
    link(`${observationType}Evidence`, observationType, 'sourceReceipts', 'SourceReceipt', `${name}Observations`, true);
  }
}
export const domainBusinessLinks: { domain: ServiceDomain; domains?: ServiceDomain[]; id: string; from: string; name: string; to: string; reverse: string; identityProperty?: string }[] = [
  { domain: 'appointment', id: 'DepartmentHospital', from: 'MedicalDepartment', name: 'hospital', to: 'Hospital', reverse: 'departments' },
  { domain: 'appointment', id: 'PractitionerDepartment', from: 'Practitioner', name: 'department', to: 'MedicalDepartment', reverse: 'practitioners' },
  { domain: 'appointment', id: 'AppointmentSlotPractitioner', from: 'AppointmentSlot', name: 'practitioner', to: 'Practitioner', reverse: 'appointmentSlots' },
  { domain: 'food', id: 'MenuItemMerchant', from: 'MenuItem', name: 'merchant', to: 'FoodMerchant', reverse: 'menuItems' },
  { domain: 'hotel', id: 'RoomTypeHotel', from: 'RoomType', name: 'hotel', to: 'HotelProperty', reverse: 'roomTypes' },
  { domain: 'hotel', id: 'RoomInventoryType', from: 'RoomInventory', name: 'roomType', to: 'RoomType', reverse: 'inventoryObservations' },
  { domain: 'hotel', id: 'HotelRatePlanHotel', from: 'HotelRatePlan', name: 'hotel', to: 'HotelProperty', reverse: 'ratePlans', identityProperty: 'hotelId' },
  { domain: 'hotel', id: 'HotelRatePlanRoomType', from: 'HotelRatePlan', name: 'roomType', to: 'RoomType', reverse: 'ratePlans', identityProperty: 'roomTypeId' },
  { domain: 'hotel', id: 'RoomInventoryRatePlan', from: 'RoomInventory', name: 'ratePlan', to: 'HotelRatePlan', reverse: 'inventoryObservations', identityProperty: 'ratePlanId' },
  { domain: 'itinerary', id: 'ItineraryItemLeg', from: 'ItineraryItem', name: 'travelLeg', to: 'TravelLeg', reverse: 'itineraryItems' },
  { domain: 'vehicle', id: 'RentalPolicyClass', from: 'RentalPolicy', name: 'vehicleClass', to: 'VehicleClass', reverse: 'rentalPolicies' },
  { domain: 'ride', domains: ['ride', 'vehicle'], id: 'TransportAssignmentVehicle', from: 'TransportAssignment', name: 'vehicle', to: 'TransportVehicle', reverse: 'assignments', identityProperty: 'vehicleId' },
  { domain: 'ride', domains: ['ride', 'vehicle'], id: 'TransportAssignmentDriver', from: 'TransportAssignment', name: 'driver', to: 'TransportDriver', reverse: 'assignments', identityProperty: 'driverId' },
  { domain: 'vehicle', id: 'VehicleInspectionVehicle', from: 'VehicleInspection', name: 'vehicle', to: 'TransportVehicle', reverse: 'inspections', identityProperty: 'vehicleId' },
];
export const domainBusinessLinksFor = (domain: ServiceDomain) => domainBusinessLinks.filter(relation => (relation.domains ?? [relation.domain]).includes(domain));
for (const r of domainBusinessLinks) link(r.id, r.from, r.name, r.to, r.reverse, false, false);
for (const r of domainBusinessLinks.filter(relation => ['TransportAssignment', 'VehicleInspection'].includes(relation.from))) {
  link(`${r.id}Observation`, domainEntityObservationType(r.from), r.name, r.to, `${r.reverse}Observations`, false, false);
}
const aliases: Record<ServiceDomain, string[]> = { ride: ['网约车', '出租车', '叫车'], appointment: ['医院预约', '门诊挂号', '号源'], food: ['送餐', '点餐'], hotel: ['订房', '住宿'], itinerary: ['旅行规划', '行程规划'], vehicle: ['订车', '租车', '接送机', '包车', '自驾租车'] };
const meanings: Record<string, string> = { origin: '本次出发地点；不代表搜索区域', destination: '本次实际服务目的地', passengers: '本次乘车人数，单位为人', budget: '包含所有必需费用的预算上限，minor 为币种最小单位整数', pickupBy: '用户最晚上车时刻', arriveBy: '用户最晚到达时刻', registerBy: '挂号取得有效确认的截止时刻', patientKey: '不含姓名或证件号的就诊人不透明引用', driverKey: '自驾资格绑定的不透明驾驶人引用；预约带司机用车无需用户驾照', state: '来源观察的领域状态；未确认和未知不能当作完成', total: '覆盖全部必需费用的总额，完整性另由 feesComplete 标明', termsMatch: '候选条款是否符合固定要求；不授予业务执行权限', sourceVersion: '提供方单调递增的业务对象观察版本', observedAt: '来源观察时间；不能代替实际发生时间', requestDigest: '精确参数快照摘要；不是业务成功证据', parametersDigest: '本次需求参数摘要，用于检查候选适用性', depositState: '押金 pending、settled、disputed、unknown 分别表示不同结果', endpoint: '用户要求的业务终点；预订确认、方案交付与实际使用完成分别核验' };
for (const d of serviceDomains) for (const o of domainObjects.filter(o => [d.requestType, d.candidateType, d.resultType].includes(o.id))) {
  o.aliases.push(...aliases[d.id]); o.description = `${o.name}。${d.endpoint}`;
  for (const [name, property] of Object.entries(o.properties)) {
    property.source = o.id === d.requestType ? 'Authenticated task input, fixed to the business request revision' : 'Validated domain provider observation, bound to the exact request and source receipt';
    if (meanings[name]) property.description = meanings[name];
  }
}
const describeProperty = (type: string, name: string, description: string) => {
  const property = domainObjects.find(object => object.id === type)?.properties[name];
  if (property) property.description = description;
};
const detailedDescriptions: Record<string, string> = {
  HotelRatePlan: '酒店房型下的来源套餐身份，区分早餐、儿童政策、取消及付款方式。报价与实时库存仍属于各自的候选和观察，不能从同一房型推定套餐条款相同。',
  TransportDriver: '来源限定的实际服务司机；区别于自驾顾客的驾驶资格引用。司机姓名或联系方式不构成已派车或已送达证据。',
  TransportAssignment: '一次业务操作实际分配的车辆与司机，附阶段和发生时间。派车、到达上车点、上车和送达分别记录；其不可变观察保留历史分配关系。',
};
for (const [type, description] of Object.entries(detailedDescriptions)) domainObjects.find(object => object.id === type)!.description = description;
describeProperty('TransportVehicle', 'vehicleClass', '来源服务车型或等级；同一等级不代表同一物理车辆。');
describeProperty('TransportVehicle', 'vehicleReference', '来源中的具体物理车辆引用，不能由车型标签或车牌相似性推定跨来源同一性。');
describeProperty('TransportAssignment', 'providerReference', '本次派车所属的原行程或预订号；不能关联到另一个业务操作。');
describeProperty('TransportAssignment', 'atPickupAt', '司机或车辆实际到达上车点的时刻；预计到达时间不能填入。');
describeProperty('TransportAssignment', 'boardedAt', '实际乘客上车或自驾车辆交接时刻，按 mode 区分业务含义。');
describeProperty('TransportAssignment', 'completedAt', '实际送达或租用归还时刻；自驾押金是否结清仍单独核验。');
describeProperty('RoomType', 'maximumAdults', '每间房允许的最多成人数；不能用总客人数替代成人与儿童分配。');
describeProperty('RoomType', 'maximumChildren', '每间房允许的最多儿童数，儿童年龄和是否接待另由来源政策决定。');
describeProperty('RoomInventory', 'ratePlanId', '此房态适用的来源套餐身份；不能把另一个套餐的房态当作本次可用性。');
for (const type of ['VehicleRequest', 'VehicleBooking']) {
  describeProperty(type, 'returnLocation', '预约接送的实际下车目的地；自驾租车的还车网点。含义由 mode 固定，不是同一个业务终点。');
  describeProperty(type, 'returnLocationDetails', '来源限定的接送下车地点或自驾还车网点；必须与 mode 和 returnLocation 一致。');
  describeProperty(type, 'driverKey', '自驾顾客驾驶资格的不透明引用；不等同于提供方派出的司机。');
  describeProperty(type, 'returnedAt', '预约接送实际送达时间；自驾实际归还时间。归还不证明验车同意或押金结清。');
}
for (const type of ['RideRequest', 'VehicleRequest', 'RideTrip', 'VehicleBooking']) {
  describeProperty(type, 'luggageCount', '本次同行行李件数；缺失不能解释为零件。');
  describeProperty(type, 'luggageSize', '需容纳的最大行李尺寸级别；车型名称不能替代具体承载能力。');
}
export const domainActions: ActionDefinition[] = serviceDomains.map(d => ({
  id: d.action, version: '1', kind: 'business', effects: [d.effect], resultTypes: [d.resultType],
  description: `${d.name}的版本化业务决策。${d.endpoint}。来源回执产生独立验证的业务结果及资源观察。定义本身不授予执行权限；当前仅有显式授权的沙箱绑定，真实连接器尚未接通。`,
  inputs: { request: 'ServiceRequest', requirements: d.requestType, option: d.candidateType },
  changes: ['ServiceRequest.progress', 'ServiceEngagement', d.candidateType, d.resultType, 'SourceReceipt', ...new Set([...d.objects, ...d.resultObjects]), ...new Set([...d.objects, ...d.resultObjects].map(domainEntityObservationType))],
  submissionCriteria: ['same_owner', 'current_request_revision', 'same_request', 'current_requirements', 'eligible_option', 'within_authority'],
  providerOperation: `domain.${d.id}.submit`,
}));
export const domainFunctions: FunctionDefinition[] = serviceDomains.flatMap(d => [
  { id: d.eligibleFunction, version: '2', inputTypes: [d.candidateType], description: `${d.name}候选条件：固定需求、来源、时效、资格、费用和条款；未知阻止执行` },
  { id: d.outcomeFunction, version: '1', inputTypes: [d.resultType], description: d.endpoint },
]);
export const domainFunctionCallSchemas = serviceDomains.flatMap(d => [d.eligibleFunction, d.outcomeFunction].map(name => z.object({ function: z.literal(name), object: objectRefSchema }).strict()));
export const domainConditionSchemas = serviceDomains.flatMap(d => (['precondition', 'result'] as const).map(phase => z.object({
  id: z.string().min(1).max(100), predicateRef: z.object({ id: z.literal(`domain.${d.id}.${phase === 'result' ? 'complete' : 'eligible'}`), version: z.literal(phase === 'precondition' ? '2' : '1') }).strict(),
  subject: z.object({ type: z.literal(phase === 'result' ? d.resultType : d.candidateType), role: z.literal(phase === 'result' ? 'domain_outcome' : 'domain_option'), object: objectRefSchema.optional() }).strict(),
  phase: z.literal(phase), strength: z.enum(['hard', 'preference']), operator: z.literal('eq'), expected: objectRefSchema.extend({ type: z.literal(d.requestType) }),
  source: z.object({ messageId: z.string().min(1).max(200), quote: z.string().min(1).max(2000) }).strict(),
}).strict()));
