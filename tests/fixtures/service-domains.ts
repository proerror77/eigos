import { digest } from '../../packages/core/delegation.js';
import type { DomainOperation, DomainSandboxProvider } from '../../packages/capabilities/domain-service.js';
import type { DomainSnapshot } from '../../packages/ontology/domain-projection.js';
import { domainBusinessLinks, serviceDomain, type DomainParameters, type DomainResults, type ServiceDomain } from '../../packages/ontology/service-domains.js';

/** Entirely synthetic administrative/business records; no real identity, address or provider. */
export function domainFixture<K extends ServiceDomain>(domain: K, now = Date.now()) {
  const at = (minutes: number) => new Date(now + minutes * 60000).toISOString();
  const budget = { minor: '50000', currency: 'CNY' as const }, total = { minor: '12000', currency: 'CNY' as const };
  const parameters: DomainParameters = {
    ride: { origin: 'synthetic-home', destination: 'synthetic-office', passengers: 2, serviceClass: 'standard', pickupBy: at(60), arriveBy: at(120), budget },
    appointment: { hospitalId: 'synthetic-campus', departmentId: 'synthetic-department', practitionerId: 'synthetic-practitioner', patientKey: 'patient-alias-A', startsAt: at(1440), timeZone: 'Asia/Shanghai', registerBy: at(60), budget },
    food: { merchantId: 'synthetic-kitchen', items: [{ sku: 'meal-A', quantity: 2, specification: 'large-no-peanuts' }], destination: 'synthetic-office', deliverBy: at(60), excludedIngredients: ['peanuts'], budget },
    hotel: { hotelId: 'synthetic-hotel', roomTypeId: 'synthetic-twin', checkIn: at(1440).slice(0, 10), checkOut: at(4320).slice(0, 10), timeZone: 'Asia/Shanghai', rooms: 1, guests: 2, cancellationPolicyRef: 'flexible-v1', endpoint: 'confirmed', budget },
    itinerary: { startsAt: at(1440), endsAt: at(2160), timeZone: 'Asia/Shanghai', travelers: 2, endpoint: 'plan', legs: [{ id: 'leg-1', origin: 'synthetic-station', destination: 'synthetic-hotel', startsAt: at(1500), endsAt: at(1560), mode: 'rail', transferMinutes: 0, bookingRequired: true }, { id: 'leg-2', origin: 'synthetic-hotel', destination: 'synthetic-venue', startsAt: at(1600), endsAt: at(1630), mode: 'walk', transferMinutes: 20, bookingRequired: false }], budget },
    vehicle: { mode: 'self_drive', pickup: 'synthetic-depot', returnLocation: 'synthetic-depot', startsAt: at(1440), endsAt: at(2880), timeZone: 'Asia/Shanghai', vehicleClass: 'compact', passengers: 2, driverKey: 'driver-alias-A', endpoint: 'confirmed', budget, depositLimit: { minor: '200000', currency: 'CNY' } },
  };
  const common = { providerReference: `synthetic-${domain}-record`, observedAt: at(-0.01), requestDigest: digest(parameters[domain]) };
  const results: DomainResults = {
    ride: { ...common, state: 'completed', origin: parameters.ride.origin, destination: parameters.ride.destination, passengers: 2, serviceClass: 'standard', pickedUpAt: at(-20), arrivedAt: at(-1), finalFare: total, fareComplete: true },
    appointment: { ...common, state: 'confirmed', hospitalId: parameters.appointment.hospitalId, departmentId: parameters.appointment.departmentId, practitionerId: parameters.appointment.practitionerId, patientKey: parameters.appointment.patientKey, startsAt: parameters.appointment.startsAt, timeZone: 'Asia/Shanghai', confirmedAt: at(-1), fee: total, paymentState: 'paid', eligibilityVerified: true },
    food: { ...common, state: 'delivered', merchantId: parameters.food.merchantId, deliveredItems: parameters.food.items, destination: parameters.food.destination, deliveredAt: at(-1), total, feesComplete: true, ingredientCheck: 'verified', finalDelivery: true },
    hotel: { ...common, state: 'confirmed', hotelId: parameters.hotel.hotelId, roomTypeId: parameters.hotel.roomTypeId, checkIn: parameters.hotel.checkIn, checkOut: parameters.hotel.checkOut, timeZone: 'Asia/Shanghai', rooms: 1, guests: 2, cancellationPolicyRef: 'flexible-v1', confirmationCode: 'synthetic-hotel-confirmation', confirmedAt: at(-1), paymentState: 'not_required', total, feesComplete: true },
    itinerary: { ...common, state: 'validated', validatedAt: at(-1), legs: parameters.itinerary.legs.map(l => ({ ...l, feasibility: 'verified', bookingState: l.bookingRequired ? 'unbooked' : 'not_required' })), total, feesComplete: true, unbookedDisclosed: true },
    vehicle: { ...common, state: 'confirmed', mode: 'self_drive', pickup: parameters.vehicle.pickup, returnLocation: parameters.vehicle.returnLocation, startsAt: parameters.vehicle.startsAt, endsAt: parameters.vehicle.endsAt, timeZone: 'Asia/Shanghai', vehicleClass: 'compact', passengers: 2, driverKey: 'driver-alias-A', eligibilityVerified: true, confirmationCode: 'synthetic-vehicle-confirmation', confirmedAt: at(-1), total, feesComplete: true, deposit: { minor: '100000', currency: 'CNY' } },
  };
  const entityValues: Record<string, { id?: string; properties: Record<string, unknown> }> = {
    RideRoute: { properties: { origin: parameters.ride.origin, destination: parameters.ride.destination } },
    TransportVehicle: { properties: { vehicleClass: parameters.ride.serviceClass, passengerCapacity: 4, vehicleReference: 'synthetic-vehicle' } },
    Hospital: { id: parameters.appointment.hospitalId, properties: { campusName: '合成医院院区', address: 'synthetic-campus-address', timeZone: 'Asia/Shanghai' } },
    MedicalDepartment: { id: parameters.appointment.departmentId, properties: { hospitalId: parameters.appointment.hospitalId, departmentName: '合成门诊科室' } },
    Practitioner: { id: parameters.appointment.practitionerId, properties: { hospitalId: parameters.appointment.hospitalId, departmentId: parameters.appointment.departmentId, practitionerName: '合成医师' } },
    PatientProfile: { id: parameters.appointment.patientKey, properties: { patientAlias: parameters.appointment.patientKey, eligibility: 'verified' } },
    AppointmentSlot: { properties: { hospitalId: parameters.appointment.hospitalId, departmentId: parameters.appointment.departmentId, practitionerId: parameters.appointment.practitionerId, startsAt: parameters.appointment.startsAt, timeZone: 'Asia/Shanghai', availableCount: 1, expiresAt: at(30) } },
    FoodMerchant: { id: parameters.food.merchantId, properties: { merchantName: '合成餐厅', address: 'synthetic-kitchen-address' } },
    MenuItem: { id: parameters.food.items[0]!.sku, properties: { sku: parameters.food.items[0]!.sku, specification: parameters.food.items[0]!.specification, ingredients: ['rice'], ingredientsKnown: true } },
    HotelProperty: { id: parameters.hotel.hotelId, properties: { hotelName: '合成酒店', address: 'synthetic-hotel-address', timeZone: 'Asia/Shanghai' } },
    RoomType: { id: parameters.hotel.roomTypeId, properties: { roomTypeName: '合成双床房', guestCapacity: 2, bedDescription: 'twin' } },
    RoomInventory: { properties: { checkIn: parameters.hotel.checkIn, checkOut: parameters.hotel.checkOut, roomsAvailable: 1, observedAt: at(-2), expiresAt: at(30) } },
    ItineraryItem: { properties: { startsAt: parameters.itinerary.legs[0]!.startsAt, endsAt: parameters.itinerary.legs[0]!.endsAt, location: parameters.itinerary.legs[0]!.destination, bookingRequired: true } },
    TravelLeg: { id: parameters.itinerary.legs[0]!.id, properties: { ...parameters.itinerary.legs[0]!, feasibility: 'verified' } },
    VehicleClass: { id: parameters.vehicle.vehicleClass, properties: { className: '合成紧凑车型', passengerCapacity: 4, transmission: 'automatic' } },
    RentalPolicy: { properties: { driverEligibilityRule: 'synthetic-eligibility-rule', cancellationPolicyRef: 'synthetic-policy-v1', insuranceTerms: 'synthetic-insurance', depositLimit: parameters.vehicle.depositLimit } },
    VehicleInspection: { properties: { stage: 'pickup', occurredAt: at(-1), accepted: true, damageReportRef: 'synthetic-inspection' } },
  };
  const entities: DomainSnapshot['entities'] = serviceDomain(domain).objects.map(type => { const value = entityValues[type]!; const id = value.id ?? `${type}-synthetic`; return { type, id, title: `${type} 合成对象`, properties: { sourceId: id, sourceRevision: '1', ...value.properties } }; });
  if (domain === 'appointment') Object.assign(entities.find(e => e.type === 'PatientProfile')!.properties, { patientAlias: 'patient-alias-A', identityDocument: 'PRIVATE_PATIENT_FIXTURE', contact: 'PRIVATE_CONTACT_FIXTURE' });
  const snapshot: DomainSnapshot = { domain, environment: 'sandbox', requestId: 'domain-request', requestRevision: 1, parameters: parameters[domain], option: { id: 'option-1', providerId: 'synthetic-domain-provider', parametersDigest: digest(parameters[domain]), offeredParameters: parameters[domain], availability: 'available', eligibility: 'verified', observedAt: at(-2), expiresAt: at(30), total, feesComplete: true, commitmentBy: at(10), commitments: domain === 'ride' ? { pickup: at(10), arrival: at(10), completion: at(10) } : domain === 'appointment' ? { registration: at(10), completion: at(10) } : domain === 'food' ? { completion: at(10) } : { completion: at(10) }, ...(domain === 'vehicle' ? { deposit: results.vehicle.deposit } : {}), termsMatch: true }, sourceId: 'synthetic-domain-provider', sourceEventId: 'event-1', sourceVersion: 1, entities, relationships: domainBusinessLinks.filter(r => r.domain === domain).map(r => ({ type: r.id, fromId: entities.find(e => e.type === r.from)!.id, toId: entities.find(e => e.type === r.to)!.id })) };
  return { now, at, parameters: parameters[domain], result: results[domain], snapshot };
}

export function domainProvider(domain: ServiceDomain, options: { pending?: boolean; wrongInput?: boolean; failAfterSubmit?: boolean } = {}) {
  const f = domainFixture(domain), ledger = new Map<string, DomainOperation>();
  let submits = 0, lookups = 0, pending = options.pending ?? false, disconnect = options.failAfterSubmit ?? false;
  const provider: DomainSandboxProvider = {
    domain, id: 'synthetic-domain-provider', configurationDigest: digest({ domain, source: 'fixture-v1' }), environment: 'sandbox',
    prepare: async input => ({ option: { ...f.snapshot.option, parametersDigest: digest(input), offeredParameters: input }, entities: f.snapshot.entities, relationships: f.snapshot.relationships }),
    submit: async (key, input) => {
      submits++;
      if (!ledger.has(key)) ledger.set(key, { key, inputDigest: options.wrongInput ? '0'.repeat(64) : digest(input), eventId: `${key}:1`, version: 1, observation: { ...f.result, requestDigest: digest(input), ...(pending ? { state: domain === 'itinerary' ? 'draft' : domain === 'food' ? 'preparing' : domain === 'ride' ? 'in_progress' : 'pending' } : {}) } });
      if (disconnect) { disconnect = false; throw new Error('Synthetic disconnect after durable acceptance'); }
      return structuredClone(ledger.get(key)!);
    },
    lookup: async key => { lookups++; return structuredClone(ledger.get(key)); },
  };
  return { ...f, provider, ledger, counters: () => ({ submits, lookups }), complete: () => { pending = false; for (const [key, op] of ledger) ledger.set(key, { ...op, version: op.version + 1, eventId: `${key}:${op.version + 1}`, observation: { ...f.result, requestDigest: op.inputDigest } }); } };
}
