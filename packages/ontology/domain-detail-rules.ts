import { digest } from '../core/delegation.js';
import type { DomainCriterion } from './domain-rules.js';
import type { ServiceDomain } from './service-domains.js';

export interface DomainResourceFact { type: string; id: string; properties: Record<string, unknown> }
export interface DomainResourceRelationship { type: string; fromId: string; toId: string }
export interface DomainResultResources { entities: DomainResourceFact[]; relationships: DomainResourceRelationship[]; preparedEntities?: DomainResourceFact[] }
type Values = Record<string, unknown>;
type Money = { minor: string; currency: string };
const values = (value: unknown): Values | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Values : undefined;
const unknownOrEqual = (actual: unknown, expected: unknown) => actual === undefined ? undefined : digest(actual) === digest(expected);
function specifiedMatches(actual: unknown, expected: unknown): boolean | undefined {
  if (actual === undefined) return undefined;
  const wanted = values(expected), observed = values(actual);
  if (!wanted) return unknownOrEqual(actual, expected);
  if (!observed) return false;
  const results = Object.entries(wanted).map(([name, value]) => specifiedMatches(observed[name], value));
  return results.includes(false) ? false : results.includes(undefined) ? undefined : true;
}

function checks() {
  const criteria: DomainCriterion[] = [];
  const check = (id: string, value: boolean | undefined, reason: string) => criteria.push({ id, result: value === undefined ? 'unknown' : value ? 'pass' : 'fail', reason });
  const equal = (id: string, actual: unknown, expected: unknown) => check(id, unknownOrEqual(actual, expected), 'The source must preserve this exact requested domain fact');
  const specified = (id: string, actual: unknown, expected: unknown) => check(id, specifiedMatches(actual, expected), 'Every specified field must be preserved; extra source facts do not change an unspecified requirement');
  const requested = (fields: string[], actual: Values, expected: Values) => {
    for (const field of fields) if (expected[field] !== undefined) {
      if (['originLocation', 'destinationLocation', 'pickupLocation', 'returnLocationDetails'].includes(field)) specified(field, actual[field], expected[field]);
      else equal(field, actual[field], expected[field]);
    }
  };
  return { criteria, check, equal, specified, requested };
}

function cancellationCheck(actual: unknown, expected: unknown, policyRef?: unknown): DomainCriterion[] {
  const { criteria, check, equal, specified } = checks(), terms = values(actual), requested = values(expected);
  if (terms || requested) {
    check('cancellation_known', !terms || terms.kind === 'unknown' || requested?.kind === 'unknown' ? undefined : true, 'The cancellation conditions need explicit source terms');
    if (policyRef !== undefined && terms) equal('cancellation_policy_identity', terms.policyRef, policyRef);
    if (requested && terms && terms.kind !== 'unknown') specified('cancellation_terms', terms, requested);
  }
  return criteria;
}

function breakfastChecks(raw: unknown, expected: unknown): DomainCriterion[] {
  const { criteria, check } = checks(), actual = values(raw), wanted = values(expected);
  if (!wanted) return criteria;
  check('breakfast_inclusion', typeof actual?.included === 'boolean' ? actual.included === wanted.included : undefined, 'Room identity does not establish breakfast inclusion');
  check('breakfast_servings', typeof actual?.servingsPerRoom === 'number' ? actual.servingsPerRoom >= Number(wanted.servingsPerRoom) : undefined, 'Breakfast servings must cover the requested per-room entitlement');
  if (wanted.frequency !== undefined) check('breakfast_frequency', actual?.frequency === undefined ? undefined : actual.frequency === wanted.frequency, 'An explicitly requested daily or once-per-stay entitlement needs the same sourced frequency');
  return criteria;
}

function childPolicyChecks(raw: unknown, expected: Values): DomainCriterion[] {
  const { criteria, check } = checks(), occupancy = values(expected.occupancy), ages = occupancy?.childAges as number[] | undefined;
  if (!ages?.length) return criteria;
  const policy = values(raw);
  check('children_allowed', typeof policy?.childrenAllowed === 'boolean' ? policy.childrenAllowed : undefined, 'Child admission must be evidenced for this property or rate plan');
  check('child_age_policy', typeof policy?.maximumChildAge === 'number' ? ages.every(age => age <= Number(policy.maximumChildAge)) : undefined, 'Every child age must fit the sourced child policy');
  check('child_room_capacity', typeof policy?.maxChildrenPerRoom === 'number' ? ages.length <= policy.maxChildrenPerRoom * Number(expected.rooms) : undefined, 'Child capacity is per room and cannot be inferred from total guest capacity');
  return criteria;
}

function insuranceChecks(raw: unknown, expected: unknown): DomainCriterion[] {
  const { criteria, check } = checks(), actual = values(raw), wanted = values(expected);
  if (!wanted) return criteria;
  const coverages = actual?.coverage as string[] | undefined, required = wanted.coverage as string[];
  check('insurance_coverage', coverages ? required.every(kind => coverages.includes(kind)) : undefined, 'Every requested risk needs explicit insurance coverage');
  const deductible = actual?.deductible as Money | undefined, maximum = wanted.maximumDeductible as Money;
  check('insurance_deductible', !deductible || deductible.currency !== maximum.currency ? undefined : BigInt(deductible.minor) <= BigInt(maximum.minor), 'Insurance deductible must fit its separately requested limit and currency');
  return criteria;
}

function driverChecks(raw: unknown, expected: unknown): DomainCriterion[] {
  const { criteria, check } = checks(), policy = values(raw), driver = values(expected);
  if (!driver) return criteria;
  check('driver_age', typeof policy?.minimumAge === 'number' ? Number(driver.age) >= policy.minimumAge && (policy.maximumAge === undefined || Number(driver.age) <= Number(policy.maximumAge)) : undefined, 'Source rental age limits apply to the referenced self-drive customer');
  check('driver_license_class', Array.isArray(policy?.licenseClasses) ? policy.licenseClasses.includes(driver.licenseClass) : undefined, 'A license name alone does not establish that this class is accepted');
  check('driver_license_country', Array.isArray(policy?.licenseCountries) ? policy.licenseCountries.includes(driver.licenseCountry) : undefined, 'The source must accept the customer license jurisdiction');
  check('driver_experience', typeof policy?.minimumLicenseHeldMonths === 'number' ? Number(driver.licenseHeldMonths) >= policy.minimumLicenseHeldMonths : undefined, 'The documented driving experience must meet the source policy');
  return criteria;
}

export function transportCapacityCriteria(p: Values, expected: Values): DomainCriterion[] {
  const { criteria, check } = checks(), capacity = values(p.luggageCapacity);
  if (typeof expected.luggageCount === 'number' && expected.luggageCount > 0) {
    check('luggage_capacity', typeof capacity?.count === 'number' ? capacity.count >= expected.luggageCount : undefined, 'The actual passenger vehicle/class must accommodate the requested luggage count');
    if (expected.luggageSize !== undefined) {
      const sizes = ['small', 'medium', 'large'];
      check('luggage_size', typeof capacity?.maximumSize === 'string' ? sizes.indexOf(capacity.maximumSize) >= sizes.indexOf(String(expected.luggageSize)) : undefined, 'A count of small bags cannot establish capacity for large suitcases');
    }
  }
  if (expected.wheelchairRequired === true) check('wheelchair_access', typeof p.wheelchairAccessible === 'boolean' ? p.wheelchairAccessible : undefined, 'Wheelchair accessibility needs a specific source fact');
  return criteria;
}

export function detailedResourceCriteria(type: string, p: Values, expected: Values): DomainCriterion[] {
  const { criteria, check, equal, specified, requested } = checks();
  if (type === 'RideRoute') requested(['originLocation', 'destinationLocation', 'timeZone'], p, expected);
  if (type === 'TransportVehicle' || type === 'VehicleClass') {
    criteria.push(...transportCapacityCriteria(p, expected));
    if (expected.transmission !== undefined) equal('transmission', p.transmission, expected.transmission);
  }
  if (type === 'HotelProperty') criteria.push(...childPolicyChecks(p.childPolicy, expected));
  if (type === 'RoomType') {
    if (p.hotelId !== undefined) equal('room_hotel', p.hotelId, expected.hotelId);
    const occupancy = values(expected.occupancy);
    if (occupancy) {
      check('room_adult_capacity', typeof p.maximumAdults === 'number' ? p.maximumAdults * Number(expected.rooms) >= Number(occupancy.adults) : undefined, 'Adult capacity is distinct from total guest capacity');
      const children = (occupancy.childAges as number[]).length;
      if (children) check('room_child_capacity', typeof p.maximumChildren === 'number' ? p.maximumChildren * Number(expected.rooms) >= children : undefined, 'Each child needs space under the room occupancy rules');
    }
  }
  if (type === 'RoomInventory') {
    for (const field of ['hotelId', 'roomTypeId', 'ratePlanId']) if (field === 'ratePlanId' ? expected.ratePlanId !== undefined : p[field] !== undefined) equal(`inventory_${field}`, p[field], expected[field]);
  }
  if (type === 'HotelRatePlan') {
    equal('rate_plan_hotel', p.hotelId, expected.hotelId); equal('rate_plan_room', p.roomTypeId, expected.roomTypeId);
    if (expected.paymentTiming !== undefined) check('payment_timing', p.paymentTiming === undefined || p.paymentTiming === 'unknown' ? undefined : p.paymentTiming === expected.paymentTiming, 'A prepaid rate and pay-at-property rate are distinct commercial terms');
    criteria.push(...breakfastChecks(p.breakfast, expected.breakfast));
    criteria.push(...cancellationCheck(p.cancellation, expected.cancellation, expected.cancellationPolicyRef));
    if (p.childPolicy !== undefined) criteria.push(...childPolicyChecks(p.childPolicy, expected));
  }
  if (type === 'RentalPolicy') {
    if (p.vehicleClassId !== undefined) equal('policy_vehicle_class', p.vehicleClassId, expected.vehicleClass);
    requested(['pickupLocation', 'returnLocationDetails'], p, expected);
    criteria.push(...cancellationCheck(p.cancellation, expected.cancellation, p.cancellationPolicyRef));
    if (expected.mode === 'self_drive') criteria.push(...driverChecks(p.driverEligibility, expected.driverQualification), ...insuranceChecks(p.insurance, expected.insurance));
  }
  if (type === 'FoodMerchant' && expected.destinationLocation !== undefined) specified('delivery_location', p.deliveryLocation, expected.destinationLocation);
  if (type === 'MenuItem') {
    if (p.merchantId !== undefined) equal('menu_merchant', p.merchantId, expected.merchantId);
    const item = (expected.items as Values[]).find(item => item.sku === p.sku), groups = p.optionGroups as Values[] | undefined, selected = item?.selections as { groupId: string; optionId: string }[] | undefined;
    if (selected !== undefined || groups?.some(group => Number(group.minimumSelections) > 0)) {
      check('menu_option_schema', groups === undefined || selected === undefined ? undefined : true, 'Configured menu selections require the source option groups and explicit choices');
      if (groups && selected) {
        check('menu_selected_options', selected.every(selection => groups.some(group => group.groupId === selection.groupId && (group.optionIds as string[]).includes(selection.optionId))), 'Every selected option must exist on this source SKU');
        check('menu_group_cardinality', groups.every(group => { const count = selected.filter(selection => selection.groupId === group.groupId).length; return count >= Number(group.minimumSelections) && count <= Number(group.maximumSelections); }), 'Menu selection counts must satisfy every applicable option group');
      }
    }
    if (expected.avoidCrossContact === true) {
      const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
      const excluded = (expected.excludedIngredients as string[]).map(normalized), cross = p.crossContactIngredients as string[] | undefined;
      check('cross_contact', cross?.some(ingredient => excluded.includes(normalized(ingredient))) ? false : p.crossContactKnown === true && cross ? true : undefined, 'Ingredients and preparation cross-contact are separate source facts');
    }
  }
  if (type === 'PatientProfile') {
    if (expected.patientAge !== undefined) equal('patient_age', p.age, expected.patientAge);
    if (expected.referralKey !== undefined) { equal('referral_identity', p.referralKey, expected.referralKey); check('referral_verified', typeof p.referralVerified === 'boolean' ? p.referralVerified : undefined, 'A referral identifier must be independently accepted by the administrative source'); }
  }
  if (type === 'AppointmentSlot') {
    const admin = values(p.administration);
    for (const [field, list] of [['visitType', 'visitTypes'], ['category', 'categories']] as const) if (expected[field] !== undefined) check(`appointment_${field}`, Array.isArray(admin?.[list]) ? (admin[list] as unknown[]).includes(expected[field]) : undefined, 'The requested visit category must be available on this exact administrative slot');
    if (admin?.referralRequired === true) check('appointment_referral', expected.referralKey !== undefined ? true : undefined, 'A referral-required slot cannot proceed without a referral reference');
    if (admin?.minimumAge !== undefined || admin?.maximumAge !== undefined) check('appointment_age', expected.patientAge === undefined ? undefined : (admin.minimumAge === undefined || Number(expected.patientAge) >= Number(admin.minimumAge)) && (admin.maximumAge === undefined || Number(expected.patientAge) <= Number(admin.maximumAge)), 'Administrative patient age limits require an explicit patient age fact');
  }
  if (type === 'TravelLeg') {
    const selected = (expected.legs as Values[]).find(leg => leg.id === p.id);
    if (selected?.dependsOn !== undefined) equal('travel_leg_dependencies', p.dependsOn, selected.dependsOn);
  }
  return criteria;
}

export function requiresHotelRatePlan(parameters: Values): boolean {
  return parameters.ratePlanId !== undefined || parameters.breakfast !== undefined || parameters.cancellation !== undefined || parameters.paymentTiming !== undefined;
}

export function detailedOutcomeCriteria(domain: ServiceDomain, p: Values, r: Values, resources: DomainResultResources | undefined, now: number): DomainCriterion[] {
  const { criteria, check, equal, specified, requested } = checks();
  if (domain === 'hotel') {
    requested(['ratePlanId', 'occupancy', 'paymentTiming'], r, p);
    criteria.push(...breakfastChecks(r.breakfast, p.breakfast));
    criteria.push(...cancellationCheck(r.cancellation, p.cancellation, r.cancellationPolicyRef));
    if (p.paymentTiming === 'prepaid') check('prepaid_effective', r.paymentState === 'paid' ? true : r.paymentState === 'not_required' || r.paymentState === 'failed' ? false : undefined, 'A prepaid rate requires payment effectiveness as well as booking confirmation');
    if (resources?.preparedEntities) {
      const plans = resources.preparedEntities.filter(entity => entity.type === 'HotelRatePlan');
      if (requiresHotelRatePlan(p)) check('selected_rate_plan_evidence', plans.length === 1 ? true : plans.length > 1 ? false : undefined, 'The result must retain the exact source rate plan selected before dispatch');
      for (const plan of plans) {
        equal('selected_rate_plan', r.ratePlanId, plan.id);
        for (const field of ['breakfast', 'cancellation']) if (plan.properties[field] !== undefined) specified(`selected_rate_${field}`, r[field], plan.properties[field]);
        if (plan.properties.paymentTiming === 'prepaid') check('selected_rate_payment', r.paymentState === 'paid' ? true : r.paymentState === 'not_required' || r.paymentState === 'failed' ? false : undefined, 'The selected source rate requires prepayment; a generic not-required payment flag cannot override it');
      }
    }
  }
  if (domain === 'appointment') {
    requested(['visitType', 'category', 'patientAge', 'referralKey'], r, p);
    if (p.referralKey !== undefined) check('referral_verified', typeof r.referralVerified === 'boolean' ? r.referralVerified : undefined, 'Confirmed administrative registration must retain referral acceptance');
  }
  if (domain === 'food') {
    requested(['destinationLocation'], r, p);
    if (p.avoidCrossContact === true) check('cross_contact', r.crossContactCheck === 'verified' ? true : r.crossContactCheck === 'violated' ? false : undefined, 'Delivery must confirm the requested preparation restriction, independently of ingredient contents');
  }
  if (domain !== 'ride' && domain !== 'vehicle') return criteria;
  requested(['luggageCount', 'luggageSize', 'originLocation', 'destinationLocation', 'pickupLocation', 'returnLocationDetails', 'transmission'], r, p);
  if (domain === 'ride') requested(['mode', 'timeZone'], r, p);
  if (domain === 'vehicle') {
    requested(['driverQualification'], r, p);
    criteria.push(...cancellationCheck(r.cancellation, p.cancellation));
    if (p.mode === 'self_drive') criteria.push(...driverChecks(r.driverEligibility, p.driverQualification), ...insuranceChecks(r.insurance, p.insurance));
  }
  const completedEndpoint = domain === 'ride' || p.endpoint === 'completed';
  const needsActualVehicle = completedEndpoint && (domain === 'ride' && p.mode === 'instant' || Number(p.luggageCount) > 0 || p.wheelchairRequired === true || p.inspectionRequired === true);
  if (!r.assignmentId && !needsActualVehicle && !r.pickupInspectionId && !r.returnInspectionId) return criteria;
  const facts = resources?.entities ?? [], relationships = resources?.relationships ?? [];
  const find = (type: string, id: unknown) => {
    const matches = facts.filter(entity => entity.type === type && entity.id === id);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const assignment = find('TransportAssignment', r.assignmentId);
  check('assignment_evidence', assignment ? true : undefined, 'An actual assignment needs its own provider-bound typed observation, separate from the preflight candidate');
  if (!assignment) return criteria;
  const a = assignment.properties;
  equal('assignment_booking', a.providerReference, r.providerReference); equal('assignment_mode', a.mode, domain === 'ride' ? 'instant' : p.mode);
  const vehicle = find('TransportVehicle', a.vehicleId);
  const linked = (name: string, id: unknown) => relationships.some(relation => relation.type === name && relation.fromId === assignment.id && relation.toId === id);
  check('assigned_vehicle', vehicle && linked('TransportAssignmentVehicle', a.vehicleId) ? true : undefined, 'The source assignment must identify its exact vehicle through a typed relationship');
  if (vehicle) {
    equal('assigned_vehicle_class', vehicle.properties.vehicleClass, domain === 'ride' ? p.serviceClass : p.vehicleClass);
    check('assigned_passenger_capacity', typeof vehicle.properties.passengerCapacity === 'number' ? vehicle.properties.passengerCapacity >= Number(p.passengers) : undefined, 'Actual vehicle passenger capacity must cover the fixed request');
    criteria.push(...transportCapacityCriteria(vehicle.properties, p));
  }
  if (a.mode !== 'self_drive') {
    const driver = find('TransportDriver', a.driverId);
    check('assigned_driver', driver && linked('TransportAssignmentDriver', a.driverId) ? true : undefined, 'A driver assignment needs a distinct sourced driver subject');
    check('assigned_driver_eligibility', driver?.properties.eligibility === 'verified' ? true : driver?.properties.eligibility === 'ineligible' ? false : undefined, 'Driver eligibility must be supplied by the source');
  }
  const assignedAt = typeof a.assignedAt === 'string' ? Date.parse(a.assignedAt) : undefined, observedAt = Date.parse(String(r.observedAt));
  check('assignment_time', assignedAt === undefined || assignedAt > Math.min(now, observedAt) ? undefined : true, 'An assignment must have actually occurred by the observation time');
  if (completedEndpoint) {
    check('assignment_stage', ['completed', 'released'].includes(String(a.state)) ? true : ['canceled'].includes(String(a.state)) ? false : undefined, 'Assigned or arrived vehicles do not establish completed transport');
    const pickup = r.pickedUpAt, arrival = domain === 'ride' ? r.arrivedAt : r.returnedAt;
    check('assignment_pickup', a.boardedAt === undefined || pickup === undefined ? undefined : Date.parse(String(a.boardedAt)) === Date.parse(String(pickup)), 'The actual boarded/pickup event must agree with the trip result');
    check('assignment_completion', a.completedAt === undefined || arrival === undefined ? undefined : Date.parse(String(a.completedAt)) === Date.parse(String(arrival)), 'The assignment endpoint must agree with the actual delivered/returned event');
  }
  if (domain === 'vehicle' && p.mode === 'self_drive' && (p.inspectionRequired === true && p.endpoint === 'completed' || r.pickupInspectionId !== undefined || r.returnInspectionId !== undefined)) {
    const inspections = ['pickup', 'return'].map(stage => {
      const inspection = find('VehicleInspection', r[`${stage}InspectionId`]);
      check(`${stage}_inspection`, inspection ? true : undefined, 'Self-drive handover needs distinct pickup and return inspection observations');
      if (!inspection) return undefined;
      const i = inspection.properties, details = values(i.details);
      equal(`${stage}_inspection_booking`, i.providerReference, r.providerReference); equal(`${stage}_inspection_vehicle`, i.vehicleId, a.vehicleId); equal(`${stage}_inspection_stage`, i.stage, stage);
      check(`${stage}_inspection_link`, relationships.some(relation => relation.type === 'VehicleInspectionVehicle' && relation.fromId === inspection.id && relation.toId === a.vehicleId) ? true : undefined, 'The inspection must identify the actual assigned vehicle');
      check(`${stage}_inspection_acceptance`, i.accepted === false || details?.agreement === 'disputed' ? false : i.accepted === true && details?.agreement === 'accepted' ? true : undefined, 'Physical handover and inspection agreement are separate from deposit settlement');
      const event = stage === 'pickup' ? r.pickedUpAt : r.returnedAt;
      check(`${stage}_inspection_time`, i.occurredAt === undefined || event === undefined ? undefined : Date.parse(String(i.occurredAt)) <= Math.min(now, observedAt) && (stage === 'pickup' ? Date.parse(String(i.occurredAt)) <= Date.parse(String(event)) : Date.parse(String(i.occurredAt)) >= Date.parse(String(event))), 'Inspection time must fit the actual handover stage');
      return details;
    });
    if (inspections[0] && inspections[1]) check('inspection_odometer', Number(inspections[1].odometerKm) >= Number(inspections[0].odometerKm), 'A return odometer cannot precede the pickup reading');
  }
  return criteria;
}
