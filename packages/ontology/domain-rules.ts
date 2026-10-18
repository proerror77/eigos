import { digest } from '../core/delegation.js';
import { domainResultSchemas, parseDomainParameters, type DomainParameters, type DomainResults, type ServiceDomain } from './service-domains.js';

export interface DomainCriterion { id: string; result: 'pass' | 'fail' | 'unknown'; reason: string }
export interface DomainAssessment { status: 'satisfied' | 'unsatisfied' | 'unknown'; criteria: DomainCriterion[]; endpoint: string }
type Money = { minor: string; currency: string };
export function assessDomain<K extends ServiceDomain>(domain: K, input: unknown, raw: unknown, now: number): DomainAssessment {
  const expected = parseDomainParameters(domain, input), observed = domainResultSchemas[domain].parse(raw) as DomainResults[K];
  const checks: DomainCriterion[] = [];
  const check = (id: string, result: boolean | undefined, reason: string) => checks.push({ id, result: result === undefined ? 'unknown' : result ? 'pass' : 'fail', reason });
  const equal = (id: string, actual: unknown, value: unknown) => check(id, actual === undefined ? undefined : id.endsWith('At') && typeof actual === 'string' && typeof value === 'string' ? Date.parse(actual) === Date.parse(value) : digest(actual) === digest(value), 'Compare the observed business value with the fixed request');
  const localDate = (value: string, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
  const within = (id: string, amount: Money | undefined, maximum: Money, complete?: boolean) => check(id, !amount || complete !== true || amount.currency !== maximum.currency ? undefined : BigInt(amount.minor) <= BigInt(maximum.minor), 'Requires a complete scoped amount in the requested currency');
  const happened = (id: string, at: string | undefined, deadline?: string) => check(id, !at || Date.parse(at) > Math.min(now, Date.parse(observed.observedAt)) ? undefined : deadline ? Date.parse(at) <= Date.parse(deadline) : true, 'Actual occurrence time is required; estimates and future timestamps do not establish completion');
  const failed = ['canceled', 'failed', 'rejected', 'expired', 'invalid'].includes(observed.state);
  if (observed.requestDigest !== digest(expected) || Date.parse(observed.observedAt) > now) return { status: 'unknown', endpoint: domain, criteria: [{ id: 'source_binding', result: 'unknown', reason: 'Observation is not bound to the current parameters and observation time' }] };
  check('business_state', failed ? false : undefined, 'A request, payment, hold or provider acknowledgement alone does not complete the business goal');
  const complete = (value: boolean) => { checks[0] = { id: 'business_state', result: value ? 'pass' : failed ? 'fail' : 'unknown', reason: value ? 'Required domain state is evidenced' : 'The required business endpoint is not yet evidenced' }; };
  let endpoint = domain as string;
  if (domain === 'ride') {
    const p = expected as DomainParameters['ride'], r = observed as DomainResults['ride']; endpoint = 'ride_completed';
    complete(r.state === 'completed');
    equal('origin', r.origin, p.origin); equal('destination', r.destination, p.destination); equal('passengers', r.passengers, p.passengers); equal('service_class', r.serviceClass, p.serviceClass);
    happened('pickup_deadline', r.pickedUpAt, p.pickupBy); happened('arrival_deadline', r.arrivedAt, p.arriveBy);
    check('trip_chronology', r.pickedUpAt && r.arrivedAt ? Date.parse(r.pickedUpAt) <= Date.parse(r.arrivedAt) : undefined, 'Arrival must follow actual pickup');
    within('final_fare', r.finalFare, p.budget, r.fareComplete);
  } else if (domain === 'appointment') {
    const p = expected as DomainParameters['appointment'], r = observed as DomainResults['appointment']; endpoint = 'appointment_confirmed';
    complete(r.state === 'confirmed');
    for (const key of ['hospitalId', 'departmentId', 'practitionerId', 'patientKey', 'startsAt', 'timeZone'] as const) equal(key, r[key], p[key]);
    happened('confirmation_deadline', r.confirmedAt, p.registerBy);
    check('patient_eligibility', r.eligibilityVerified, 'Administrative eligibility must come from the appointment source; no diagnosis or clinical suitability is inferred');
    check('registration_payment', r.paymentState === undefined || r.paymentState === 'unknown' || r.paymentState === 'pending' ? undefined : ['paid', 'not_required'].includes(r.paymentState), 'Confirmation and any required fee must both be evidenced');
    within('registration_fee', r.fee, p.budget, true);
    if (r.state === 'held' && r.holdExpiresAt && Date.parse(r.holdExpiresAt) <= now) check('hold_expired', false, 'A holding window has expired without confirmation');
  } else if (domain === 'food') {
    const p = expected as DomainParameters['food'], r = observed as DomainResults['food']; endpoint = 'food_delivered';
    complete(r.state === 'delivered'); equal('merchant', r.merchantId, p.merchantId); equal('destination', r.destination, p.destination);
    const delivered = r.deliveredItems;
    if (!delivered) check('items', undefined, 'Actual delivered SKU, specification and quantity are missing');
    else {
      const unique = new Set(delivered.map(i => i.sku)).size === delivered.length;
      const exact = unique && p.items.length === delivered.length && p.items.every(i => delivered.some(a => a.sku === i.sku && a.quantity === i.quantity && a.specification === i.specification));
      const wrong = !unique || delivered.some(a => !p.items.some(i => i.sku === a.sku && i.specification === a.specification && a.quantity <= i.quantity));
      check('items', exact ? true : wrong || r.finalDelivery === true || failed ? false : undefined, 'Partial delivery stays unresolved until final delivery is evidenced; duplicate or substituted lines never count as success');
    }
    happened('delivery_deadline', r.deliveredAt, p.deliverBy); within('complete_total', r.total, p.budget, r.feesComplete);
    if (p.excludedIngredients.length) check('excluded_ingredients', r.ingredientCheck === 'unknown' || r.ingredientCheck === undefined ? undefined : r.ingredientCheck === 'verified', 'Only source-backed verification of the stated ingredient constraints is accepted');
  } else if (domain === 'hotel') {
    const p = expected as DomainParameters['hotel'], r = observed as DomainResults['hotel']; endpoint = p.endpoint === 'confirmed' ? 'hotel_confirmed' : 'hotel_stay_completed';
    complete(p.endpoint === 'confirmed' ? ['confirmed', 'checked_in', 'checked_out'].includes(r.state) : r.state === 'checked_out');
    for (const key of ['hotelId', 'roomTypeId', 'checkIn', 'checkOut', 'timeZone', 'rooms', 'guests', 'cancellationPolicyRef'] as const) equal(key, r[key], p[key]);
    check('hotel_confirmation', r.confirmationCode ? true : undefined, 'A hotel or authorized booking source confirmation code is required');
    check('payment_effective', r.paymentState === undefined || ['pending', 'unknown'].includes(r.paymentState) ? undefined : ['paid', 'not_required'].includes(r.paymentState), 'Payment evidence cannot substitute for hotel confirmation');
    within('hotel_total', r.total, p.budget, r.feesComplete);
    if (p.endpoint === 'stay_completed') {
      happened('checked_in', r.checkedInAt); happened('checked_out', r.checkedOutAt);
      check('stay_chronology', r.checkedInAt && r.checkedOutAt ? Date.parse(r.checkedInAt) < Date.parse(r.checkedOutAt) : undefined, 'A completed stay needs ordered check-in and check-out observations');
      check('actual_stay_dates', r.checkedInAt && r.checkedOutAt ? localDate(r.checkedInAt, p.timeZone) === p.checkIn && localDate(r.checkedOutAt, p.timeZone) === p.checkOut : undefined, 'Actual local stay dates must match the booked dates');
    }
  } else if (domain === 'itinerary') {
    const p = expected as DomainParameters['itinerary'], r = observed as DomainResults['itinerary']; endpoint = p.endpoint === 'plan' ? 'itinerary_planned' : 'itinerary_booked';
    complete(p.endpoint === 'plan' ? ['validated', 'booked'].includes(r.state) : r.state === 'booked');
    if (!r.legs) check('legs', undefined, 'The actual itinerary is missing');
    else {
      const actual = r.legs, unique = new Set(actual.map(l => l.id)).size === actual.length;
      check('leg_coverage', unique && actual.length === p.legs.length && p.legs.every(l => actual.some(a => a.id === l.id && digest({ id: a.id, origin: a.origin, destination: a.destination, startsAt: a.startsAt, endsAt: a.endsAt, mode: a.mode, transferMinutes: a.transferMinutes, bookingRequired: a.bookingRequired }) === digest(l))), 'Every fixed leg and dependency must be represented without substitutions');
      const sorted = [...actual].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
      check('time_windows', sorted.every(l => Date.parse(l.startsAt) < Date.parse(l.endsAt) && Date.parse(l.startsAt) >= Date.parse(p.startsAt) && Date.parse(l.endsAt) <= Date.parse(p.endsAt)), 'Each leg must fit the absolute itinerary window');
      check('connections', sorted.every((l, i) => !i || sorted[i - 1]!.destination === l.origin && Date.parse(sorted[i - 1]!.endsAt) + l.transferMinutes * 60000 <= Date.parse(l.startsAt)), 'Adjacent endpoints and transfer buffers must connect');
      check('feasibility', actual.some(l => l.feasibility === 'impossible') ? false : actual.some(l => l.feasibility === 'unknown') ? undefined : true, 'Scheduling alone does not prove transportation feasibility');
      const unbooked = actual.some(l => l.bookingRequired && (l.bookingState !== 'confirmed' || !l.bookingReference));
      check('booking_endpoint', p.endpoint === 'booked' ? unbooked ? undefined : true : !unbooked || r.unbookedDisclosed === true, 'Planning may finish with disclosed unbooked legs; a booked itinerary requires every confirmation');
    }
    within('itinerary_total', r.total, p.budget, r.feesComplete);
  } else {
    const p = expected as DomainParameters['vehicle'], r = observed as DomainResults['vehicle']; endpoint = p.endpoint === 'confirmed' ? 'vehicle_confirmed' : 'vehicle_use_completed';
    complete(p.endpoint === 'confirmed' ? ['confirmed', 'in_use', 'completed', 'returned'].includes(r.state) : p.mode === 'self_drive' ? r.state === 'returned' : r.state === 'completed');
    for (const key of ['mode', 'pickup', 'returnLocation', 'startsAt', 'endsAt', 'timeZone', 'vehicleClass', 'passengers'] as const) equal(key, r[key], p[key]);
    if (p.mode === 'self_drive') equal('driverKey', r.driverKey, p.driverKey);
    check('vehicle_confirmation', r.confirmationCode ? true : undefined, 'A specific booking reference is required');
    check('eligibility', r.eligibilityVerified, 'Driver/passenger eligibility is verified by the source, not inferred from a name or profile');
    within('vehicle_total', r.total, p.budget, r.feesComplete); within('deposit_limit', r.deposit, p.depositLimit, true);
    if (p.endpoint === 'completed') {
      happened('vehicle_pickup', r.pickedUpAt); happened('vehicle_return', r.returnedAt, p.endsAt);
      check('use_chronology', r.pickedUpAt && r.returnedAt ? Date.parse(r.pickedUpAt) < Date.parse(r.returnedAt) : undefined, 'Actual use or chauffeur trip must have ordered endpoints');
      check('actual_use_window', r.pickedUpAt && r.returnedAt ? Date.parse(r.pickedUpAt) >= Date.parse(p.startsAt) && Date.parse(r.returnedAt) <= Date.parse(p.endsAt) : undefined, 'Actual use must fit the agreed service interval');
      if (p.mode === 'self_drive') { check('return_acceptance', r.returnAccepted, 'Physical return needs source acceptance'); check('deposit_settled', r.depositState === 'settled' ? true : r.depositState === 'disputed' ? false : undefined, 'Pending deposit release remains unknown after a vehicle return'); }
    }
  }
  return { status: checks.some(c => c.result === 'fail') ? 'unsatisfied' : checks.some(c => c.result === 'unknown') ? 'unknown' : 'satisfied', criteria: checks, endpoint };
}
