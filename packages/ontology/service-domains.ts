import { z } from 'zod';
import { objectRefSchema, type ActionDefinition, type FunctionDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';
import type { RequirementRoleDefinition } from './execution.js';

const text = z.string().trim().min(1).max(500);
const instant = z.iso.datetime({ offset: true });
const count = z.number().int().min(1).max(100);
const money = z.object({ minor: z.string().regex(/^(0|[1-9]\d{0,17})$/), currency: z.enum(['CNY', 'USD', 'EUR']) }).strict();
const zone = z.string().min(1).max(100).refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } });
const date = z.iso.date();
const foodLine = z.object({ sku: text, quantity: count, specification: text }).strict();
const leg = z.object({ id: text, origin: text, destination: text, startsAt: instant, endsAt: instant, mode: text, transferMinutes: z.number().int().min(0).max(1440), bookingRequired: z.boolean() }).strict();
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
  ride: z.object({ origin: text, destination: text, passengers: count, serviceClass: text, pickupBy: instant, arriveBy: instant, budget: money }).strict(),
  appointment: z.object({ hospitalId: text, departmentId: text, practitionerId: text, patientKey: text, startsAt: instant, timeZone: zone, registerBy: instant, budget: money }).strict(),
  food: z.object({ merchantId: text, items: z.array(foodLine).min(1).max(30), destination: text, deliverBy: instant, excludedIngredients: z.array(text).max(30), budget: money }).strict(),
  hotel: z.object({ hotelId: text, roomTypeId: text, checkIn: date, checkOut: date, timeZone: zone, rooms: count, guests: count, cancellationPolicyRef: text, endpoint: z.enum(['confirmed', 'stay_completed']), budget: money }).strict(),
  itinerary: z.object({ startsAt: instant, endsAt: instant, timeZone: zone, travelers: count, legs: z.array(leg).min(1).max(20), endpoint: z.enum(['plan', 'booked']), budget: money }).strict(),
  vehicle: z.object({ mode: z.enum(['chauffeured', 'self_drive']), pickup: text, returnLocation: text, startsAt: instant, endsAt: instant, timeZone: zone, vehicleClass: text, passengers: count, driverKey: text.optional(), endpoint: z.enum(['confirmed', 'completed']), budget: money, depositLimit: money }).strict(),
};
export type DomainParameters = { [K in ServiceDomain]: z.infer<typeof domainParameterSchemas[K]> };
const payment = z.enum(['not_required', 'pending', 'paid', 'failed', 'unknown']);
const common = { providerReference: text, observedAt: instant, requestDigest: z.string().regex(/^[a-f0-9]{64}$/) };
export const domainResultSchemas = {
  ride: z.object({ ...common, state: z.enum(['requested', 'accepted', 'arriving', 'in_progress', 'completed', 'canceled', 'failed', 'unknown']), origin: text.optional(), destination: text.optional(), passengers: count.optional(), serviceClass: text.optional(), pickedUpAt: instant.optional(), arrivedAt: instant.optional(), finalFare: money.optional(), fareComplete: z.boolean().optional() }).strict(),
  appointment: z.object({ ...common, state: z.enum(['requested', 'pending', 'held', 'confirmed', 'waitlisted', 'canceled', 'expired', 'rejected', 'unknown']), hospitalId: text.optional(), departmentId: text.optional(), practitionerId: text.optional(), patientKey: text.optional(), startsAt: instant.optional(), timeZone: zone.optional(), confirmedAt: instant.optional(), holdExpiresAt: instant.optional(), fee: money.optional(), paymentState: payment.optional(), eligibilityVerified: z.boolean().optional() }).strict(),
  food: z.object({ ...common, state: z.enum(['requested', 'accepted', 'preparing', 'delivering', 'partial', 'delivered', 'canceled', 'failed', 'unknown']), merchantId: text.optional(), deliveredItems: z.array(foodLine).max(30).optional(), destination: text.optional(), deliveredAt: instant.optional(), total: money.optional(), feesComplete: z.boolean().optional(), ingredientCheck: z.enum(['verified', 'violated', 'unknown']).optional(), finalDelivery: z.boolean().optional() }).strict(),
  hotel: z.object({ ...common, state: z.enum(['requested', 'held', 'pending', 'confirmed', 'checked_in', 'checked_out', 'canceled', 'expired', 'rejected', 'unknown']), hotelId: text.optional(), roomTypeId: text.optional(), checkIn: date.optional(), checkOut: date.optional(), timeZone: zone.optional(), rooms: count.optional(), guests: count.optional(), cancellationPolicyRef: text.optional(), confirmationCode: text.optional(), confirmedAt: instant.optional(), paymentState: payment.optional(), total: money.optional(), feesComplete: z.boolean().optional(), checkedInAt: instant.optional(), checkedOutAt: instant.optional() }).strict(),
  itinerary: z.object({ ...common, state: z.enum(['draft', 'validated', 'booked', 'invalid', 'canceled', 'unknown']), validatedAt: instant.optional(), legs: z.array(leg.extend({ feasibility: z.enum(['verified', 'impossible', 'unknown']), bookingState: z.enum(['not_required', 'unbooked', 'held', 'confirmed', 'canceled', 'unknown']), bookingReference: text.optional() })).min(1).max(20).optional(), total: money.optional(), feesComplete: z.boolean().optional(), unbookedDisclosed: z.boolean().optional() }).strict(),
  vehicle: z.object({ ...common, state: z.enum(['requested', 'held', 'pending', 'confirmed', 'in_use', 'completed', 'returned', 'canceled', 'expired', 'rejected', 'unknown']), mode: z.enum(['chauffeured', 'self_drive']).optional(), pickup: text.optional(), returnLocation: text.optional(), startsAt: instant.optional(), endsAt: instant.optional(), timeZone: zone.optional(), vehicleClass: text.optional(), passengers: count.optional(), driverKey: text.optional(), eligibilityVerified: z.boolean().optional(), confirmationCode: text.optional(), confirmedAt: instant.optional(), total: money.optional(), feesComplete: z.boolean().optional(), deposit: money.optional(), pickedUpAt: instant.optional(), returnedAt: instant.optional(), returnAccepted: z.boolean().optional(), depositState: z.enum(['pending', 'settled', 'disputed', 'unknown']).optional() }).strict(),
};
export type DomainResults = { [K in ServiceDomain]: z.infer<typeof domainResultSchemas[K]> };
export interface DomainDefinition {
  id: ServiceDomain; name: string; requestType: string; candidateType: string; resultType: string; action: string;
  eligibleFunction: string; outcomeFunction: string; effect: 'order' | 'reserve' | 'local';
  parameters: z.ZodObject; result: z.ZodObject; objects: string[]; endpoint: string;
}
const metadata = [
  ['ride', '打车', 'RideRequest', 'RideOption', 'RideTrip', 'RequestRide', 'order', ['RideRoute', 'TransportVehicle'], '实际接送路线、人数、车型、上车及到达时间与最终完整车费；接单不是到达'],
  ['appointment', '医院挂号', 'AppointmentRequest', 'AppointmentOption', 'MedicalAppointment', 'RequestMedicalAppointment', 'reserve', ['Hospital', 'MedicalDepartment', 'Practitioner', 'PatientProfile', 'AppointmentSlot'], '指定就诊人、院区、科室、医生、时段的有效挂号确认；候补、支付或号源列表不是挂号成功'],
  ['food', '外卖', 'FoodRequest', 'FoodOption', 'FoodDelivery', 'RequestFoodOrder', 'order', ['FoodMerchant', 'MenuItem'], '指定商家、菜品规格与数量送达指定地点和期限，核对完整费用及已约定忌口'],
  ['hotel', '酒店', 'HotelRequest', 'HotelOption', 'HotelReservation', 'RequestHotelReservation', 'reserve', ['HotelProperty', 'RoomType', 'RoomInventory'], '确认指定酒店、房型、入住退房日期、间数人数与条款；住宿完成是另一个明确终点'],
  ['itinerary', '行程安排', 'ItineraryRequest', 'ItineraryOption', 'Itinerary', 'BuildItinerary', 'local', ['ItineraryItem', 'TravelLeg'], '方案满足时间、衔接、费用与可行性并披露未预订项；要求订妥时逐项核对确认'],
  ['vehicle', '预约用车与自驾租车', 'VehicleRequest', 'VehicleOption', 'VehicleBooking', 'RequestVehicleBooking', 'reserve', ['VehicleClass', 'RentalPolicy', 'VehicleInspection'], '指定模式、车型、人数、地点、租期与条件的确认；完成租用还需交接、归还及押金结清'],
] as const;
export const serviceDomains: DomainDefinition[] = metadata.map(([id, name, requestType, candidateType, resultType, action, effect, objects, endpoint]) => ({ id, name, requestType, candidateType, resultType, action, effect, objects: [...objects], endpoint, eligibleFunction: `${id}Eligibility`, outcomeFunction: `${id}Outcome`, parameters: domainParameterSchemas[id], result: domainResultSchemas[id] }));
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
  }
  if (domain === 'itinerary') {
    const legs = (parsed as DomainParameters['itinerary']).legs;
    if (new Set(legs.map(l => l.id)).size !== legs.length || legs.some(l => Date.parse(l.startsAt) >= Date.parse(l.endsAt))) throw new Error('Itinerary leg identities and time ranges must be valid');
  }
  if (domain === 'vehicle' && p.mode === 'self_drive' && !p.driverKey) throw new Error('Self-drive rental requires an opaque driver reference');
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
const auxiliaryFields: Record<string, Record<string, z.ZodType>> = {
  RideRoute: { origin: text, destination: text },
  TransportVehicle: { vehicleClass: text, passengerCapacity: count, vehicleReference: text },
  Hospital: { campusName: text, address: text, timeZone: zone },
  MedicalDepartment: { hospitalId: text, departmentName: text },
  Practitioner: { hospitalId: text, departmentId: text, practitionerName: text },
  PatientProfile: { patientAlias: text, eligibility: z.enum(['verified', 'ineligible', 'unknown']) },
  AppointmentSlot: { hospitalId: text, departmentId: text, practitionerId: text, startsAt: instant, timeZone: zone, availableCount: z.number().int().min(0).max(10000), expiresAt: instant },
  FoodMerchant: { merchantName: text, address: text },
  MenuItem: { sku: text, specification: text, ingredients: z.array(text).max(100), ingredientsKnown: z.boolean() },
  HotelProperty: { hotelName: text, address: text, timeZone: zone },
  RoomType: { roomTypeName: text, guestCapacity: count, bedDescription: text },
  RoomInventory: { checkIn: date, checkOut: date, roomsAvailable: z.number().int().min(0).max(10000), observedAt: instant, expiresAt: instant },
  ItineraryItem: { startsAt: instant, endsAt: instant, location: text, bookingRequired: z.boolean(), bookingReference: text },
  TravelLeg: { ...leg.shape, feasibility: z.enum(['verified', 'impossible', 'unknown']) },
  VehicleClass: { className: text, passengerCapacity: count, transmission: z.enum(['manual', 'automatic', 'unknown']) },
  RentalPolicy: { driverEligibilityRule: text, cancellationPolicyRef: text, insuranceTerms: text, depositLimit: money },
  VehicleInspection: { stage: z.enum(['pickup', 'return']), occurredAt: instant, accepted: z.boolean(), damageReportRef: text },
};
for (const d of serviceDomains) {
  domainObjects.push(object(d.requestType, `${d.name}要求`, { ...d.parameters.shape, requestRevision: z.number().int().positive(), capturedAt: instant }));
  domainObjects.push(object(d.candidateType, `${d.name}候选方案`, { parametersDigest: z.string().regex(/^[a-f0-9]{64}$/), offeredParameters: d.parameters, commitments: domainCommitmentsSchema.optional(), ...(d.id === 'vehicle' ? { deposit: money } : {}), requestRevision: z.number().int().positive(), availability: z.enum(['available', 'unavailable', 'unknown']), eligibility: z.enum(['verified', 'ineligible', 'unknown']), observedAt: instant, expiresAt: instant, total: money, feesComplete: z.boolean(), commitmentBy: instant.optional(), termsMatch: z.boolean() }, true));
  domainObjects.push(object(d.resultType, `${d.name}结果`, { ...d.result.shape, requestRevision: z.number().int().positive(), sourceVersion: z.number().int().positive() }, true));
  domainObjects.find(o => o.id === d.candidateType)!.version = '2';
  for (const type of [d.requestType, d.candidateType, d.resultType]) link(`${type}Request`, type, 'request', 'ServiceRequest', `${d.id}${type === d.requestType ? 'Requirements' : type === d.candidateType ? 'Options' : 'Results'}`);
  for (const type of [d.candidateType, d.resultType]) {
    link(`${type}Requirements`, type, 'requirements', d.requestType, type === d.candidateType ? 'options' : 'results');
    link(`${type}Evidence`, type, 'sourceReceipts', 'SourceReceipt', `${type[0]!.toLowerCase()}${type.slice(1)}s`, true);
    link(`${type}Provider`, type, 'provider', 'Provider', `${type[0]!.toLowerCase()}${type.slice(1)}s`);
    domainEvidenceScopes[type] = `domain_${d.id}`;
  }
  link(`${d.resultType}Option`, d.resultType, 'selectedOption', d.candidateType, 'results');
  for (const auxiliary of d.objects) {
    const names: Record<string, string> = { RideRoute: '乘车路线', TransportVehicle: '接送车辆', Hospital: '医院院区', MedicalDepartment: '科室', Practitioner: '执业医师', PatientProfile: '就诊人引用', AppointmentSlot: '挂号号源', FoodMerchant: '外卖商家', MenuItem: '菜单菜品规格', HotelProperty: '酒店物业', RoomType: '酒店房型', RoomInventory: '客房可用性', ItineraryItem: '行程事项', TravelLeg: '交通路段', VehicleClass: '用车车型', RentalPolicy: '租用条款', VehicleInspection: '车辆交接检查' };
    const fields: Record<string, z.ZodType> = { sourceId: text, sourceRevision: text, ...auxiliaryFields[auxiliary] };
    const definition = object(auxiliary, names[auxiliary]!, fields);
    if (auxiliary === 'PatientProfile') {
      definition.properties.identityDocument = prop(text, 'Private patient identity; unavailable to agent queries', false, true);
      definition.properties.contact = prop(text, 'Private patient contact; unavailable to agent queries', false, true);
    }
    domainObjects.push(definition);
    link(`${d.requestType}${auxiliary}`, d.requestType, auxiliary[0]!.toLowerCase() + auxiliary.slice(1), auxiliary, 'serviceRequirements', ['MenuItem', 'ItineraryItem', 'TravelLeg'].includes(auxiliary), false);
  }
}
export const domainBusinessLinks: { domain: ServiceDomain; id: string; from: string; name: string; to: string; reverse: string }[] = [
  { domain: 'appointment', id: 'DepartmentHospital', from: 'MedicalDepartment', name: 'hospital', to: 'Hospital', reverse: 'departments' },
  { domain: 'appointment', id: 'PractitionerDepartment', from: 'Practitioner', name: 'department', to: 'MedicalDepartment', reverse: 'practitioners' },
  { domain: 'appointment', id: 'AppointmentSlotPractitioner', from: 'AppointmentSlot', name: 'practitioner', to: 'Practitioner', reverse: 'appointmentSlots' },
  { domain: 'food', id: 'MenuItemMerchant', from: 'MenuItem', name: 'merchant', to: 'FoodMerchant', reverse: 'menuItems' },
  { domain: 'hotel', id: 'RoomTypeHotel', from: 'RoomType', name: 'hotel', to: 'HotelProperty', reverse: 'roomTypes' },
  { domain: 'hotel', id: 'RoomInventoryType', from: 'RoomInventory', name: 'roomType', to: 'RoomType', reverse: 'inventoryObservations' },
  { domain: 'itinerary', id: 'ItineraryItemLeg', from: 'ItineraryItem', name: 'travelLeg', to: 'TravelLeg', reverse: 'itineraryItems' },
  { domain: 'vehicle', id: 'RentalPolicyClass', from: 'RentalPolicy', name: 'vehicleClass', to: 'VehicleClass', reverse: 'rentalPolicies' },
];
for (const r of domainBusinessLinks) link(r.id, r.from, r.name, r.to, r.reverse, false, false);
const aliases: Record<ServiceDomain, string[]> = { ride: ['网约车', '出租车', '叫车'], appointment: ['医院预约', '门诊挂号', '号源'], food: ['送餐', '点餐'], hotel: ['订房', '住宿'], itinerary: ['旅行规划', '行程规划'], vehicle: ['订车', '租车', '接送机', '包车', '自驾租车'] };
const meanings: Record<string, string> = { origin: '本次出发地点；不代表搜索区域', destination: '本次实际服务目的地', passengers: '本次乘车人数，单位为人', budget: '包含所有必需费用的预算上限，minor 为币种最小单位整数', pickupBy: '用户最晚上车时刻', arriveBy: '用户最晚到达时刻', registerBy: '挂号取得有效确认的截止时刻', patientKey: '不含姓名或证件号的就诊人不透明引用', driverKey: '自驾资格绑定的不透明驾驶人引用；预约带司机用车无需用户驾照', state: '来源观察的领域状态；未确认和未知不能当作完成', total: '覆盖全部必需费用的总额，完整性另由 feesComplete 标明', termsMatch: '候选条款是否符合固定要求；不授予业务执行权限', sourceVersion: '提供方单调递增的业务对象观察版本', observedAt: '来源观察时间；不能代替实际发生时间', requestDigest: '精确参数快照摘要；不是业务成功证据', parametersDigest: '本次需求参数摘要，用于检查候选适用性', depositState: '押金 pending、settled、disputed、unknown 分别表示不同结果', endpoint: '用户要求的业务终点；预订确认、方案交付与实际使用完成分别核验' };
for (const d of serviceDomains) for (const o of domainObjects.filter(o => [d.requestType, d.candidateType, d.resultType].includes(o.id))) {
  o.aliases.push(...aliases[d.id]); o.description = `${o.name}。${d.endpoint}`;
  for (const [name, property] of Object.entries(o.properties)) {
    property.source = o.id === d.requestType ? 'Authenticated task input, fixed to the business request revision' : 'Validated domain provider observation, bound to the exact request and source receipt';
    if (meanings[name]) property.description = meanings[name];
  }
}
export const domainActions: ActionDefinition[] = serviceDomains.map(d => ({ id: d.action, description: `${d.name}的版本化业务决策。${d.endpoint}。提交决策更新委托进度及沟通记录；来源回执另行产生业务结果。真实连接器尚未接通，模型调用只提案。`, inputs: { request: 'ServiceRequest', requirements: d.requestType, option: d.candidateType }, changes: ['ServiceRequest.progress', 'ServiceEngagement'], submissionCriteria: ['same_owner', 'current_request_revision', 'same_request', 'current_requirements', 'eligible_option', 'within_authority'], providerOperation: `domain.${d.id}.submit` }));
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
