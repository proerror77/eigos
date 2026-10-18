import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { businessConditionSchema, quantitySchema, type BusinessCondition } from '../ontology/business-model.js';
import type { ServiceRequest } from '../ontology/execution.js';
import type { ObjectRef } from '../ontology/model.js';
import type { OntologyObjectStore, ObjectView, ReadBudget } from '../ontology/object-store.js';
import type { ConditionCheck } from '../ontology/planning-contract.js';
import { serviceDomains } from '../ontology/service-domains.js';
import type { DomainAssessment } from '../ontology/domain-rules.js';

const conditionsSchema = z.array(businessConditionSchema).max(40);
const refEqual = (a: ObjectRef, b: ObjectRef) => a.type === b.type && a.id === b.id;
const aliases: Record<string, string> = { 公斤: 'kg', 千克: 'kg', kg: 'kg', 克: 'g', g: 'g', 杯: 'cup', cup: 'cup', cups: 'cup', 件: 'piece', piece: 'piece', pieces: 'piece', 人: 'person', person: 'person', persons: 'person' };
const scaled = (s: string) => { const [n, fraction = ''] = s.split('.'); return BigInt(n!) * 1_000_000n + BigInt(fraction.padEnd(6, '0')); };
function quantity(value: unknown) {
  const parsed = quantitySchema.safeParse(value); if (!parsed.success) return;
  const q = parsed.data;
  return { dimension: ['kg', 'g'].includes(q.unit) ? 'mass' : q.unit, amount: scaled(q.amount) * (q.unit === 'kg' ? 1000n : 1n) };
}
function sameQuantity(a: unknown, b: unknown) { const x = quantity(a), y = quantity(b); return !!x && !!y && x.dimension === y.dimension && x.amount === y.amount; }
function quotedQuantity(quote: string, expected: unknown) {
  return [...quote.matchAll(/(?<![\d.])(\d+(?:\.\d{1,6})?)\s*(公斤|千克|kg|克|g|杯|cups?|件|pieces?|人|persons?)(?![A-Za-z])/gi)]
    .some(m => sameQuantity({ amount: m[1], unit: aliases[m[2]!.toLowerCase()] }, expected));
}

/** The model proposes interpretations; it cannot replace fixed conditions or their provenance. */
export function groundConditions(request: ServiceRequest, json: string, retrieved: ObjectRef[] = []): ServiceRequest {
  const proposed = conditionsSchema.parse(JSON.parse(json));
  const result = structuredClone(request);
  for (const c of proposed) {
    const message = request.messages.find(m => m.id === c.source.messageId);
    if (!message || !message.text.includes(c.source.quote)) throw new DomainError('CONFLICT', 'Condition requires an exact quote from the current request');
    const id = c.predicateRef.id, expected = c.expected as Record<string, unknown>;
    const verifyReferences = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const ref = value as ObjectRef;
      if (typeof ref.type === 'string' && typeof ref.id === 'string') {
        if (!retrieved.some(r => refEqual(r, ref)) && !JSON.stringify(request.conditions ?? []).includes(JSON.stringify(ref)) && !request.messages.some(m => m.text.includes(ref.id))) throw new DomainError('CONFLICT', 'Condition contains an object reference the model did not retrieve');
        return;
      }
      for (const child of Object.values(value)) verifyReferences(child);
    };
    verifyReferences(c.subject.object); verifyReferences(c.expected);
    const requestedQuantity = id === 'parcel.quote_matches_request' ? expected.weight : id === 'goods.capacity_covers_quantity' ? expected : id === 'delivery.receipt_matches_request' ? expected.quantity : undefined;
    if (requestedQuantity && !quotedQuantity(c.source.quote, requestedQuantity)) throw new DomainError('CONFLICT', 'Condition quantity differs from its quoted instruction');
    if (id === 'parcel.quote_matches_request' && !(expected.serviceLevel === 'ordinary' ? /普通送|ordinary/i : /专送|快送|express/i).test(c.source.quote)) throw new DomainError('CONFLICT', 'Parcel service differs from its quoted instruction');
    if (id === 'reservation.slot_matches_request' && !quotedQuantity(c.source.quote, { amount: String(expected.partySize), unit: 'person' })) throw new DomainError('CONFLICT', 'Party size differs from its quoted instruction');
    if (id === 'offer.total_within_budget') {
      const amount = expected.amount as { minor: string; currency: string };
      const quoted = [...c.source.quote.matchAll(/(?:CNY|￥|¥)\s*(\d+(?:\.\d{1,2})?)(?![\d.])|(?<![\d.])(\d+(?:\.\d{1,2})?)\s*(?:元|CNY)(?![A-Za-z])/gi)];
      if (amount.currency !== 'CNY' || !quoted.some(m => scaled(m[1] ?? m[2]!) / 10000n === BigInt(amount.minor))) throw new DomainError('CONFLICT', 'Condition budget differs from its quoted instruction');
    }
    for (const fixed of request.requirements) {
      if (fixed.kind === 'budget' && (!fixed.role || fixed.role === 'service_total') && id === 'offer.total_within_budget' && (digest(fixed.expected) !== digest(expected.amount) || fixed.strength === 'hard' && c.strength !== 'hard')) throw new DomainError('CONFLICT', 'Condition cannot weaken the fixed budget');
      if (fixed.kind === 'quantity' && (!fixed.role || fixed.role === 'item_quantity') && requestedQuantity && (!sameQuantity({ amount: fixed.expected.amount, unit: aliases[fixed.expected.unit] ?? fixed.expected.unit }, requestedQuantity) || fixed.strength === 'hard' && c.strength !== 'hard')) throw new DomainError('CONFLICT', 'Condition cannot weaken the fixed quantity');
      if (fixed.kind === 'deadline' && (!fixed.role || fixed.role === 'completion' || fixed.role === 'arrival') && id === 'delivery.commitment_covers_deadline' && (Date.parse(fixed.expected.at) !== Date.parse(String(expected.at)) || fixed.strength === 'hard' && c.strength !== 'hard')) throw new DomainError('CONFLICT', 'Condition cannot weaken the fixed deadline');
    }
    const key = (v: BusinessCondition) => digest({ predicate: v.predicateRef.id, subject: v.subject });
    const old = result.conditions?.find(v => v.id === c.id || key(v) === key(c));
    if (old) {
      const { source: _a, ...a } = old, { source: _b, ...b } = c;
      if (digest(a) !== digest(b)) throw new DomainError('CONFLICT', 'Model attempted to replace a fixed business condition');
      continue;
    }
    result.conditions = [...(result.conditions ?? []), c];
  }
  if ((result.conditions?.length ?? 0) > 40) throw new DomainError('INVALID_INPUT', 'Too many business conditions');
  return result;
}

function scopedObjects(graph: OntologyObjectStore, owner: string, requestId: string, type: string, budget: ReadBudget): ObjectView[] | undefined {
  const root = { type: 'ServiceRequest', id: requestId };
  const domain = serviceDomains.find(d => [d.candidateType, d.resultType].includes(type));
  if (domain) return graph.related(owner, root, `${domain.id}${type === domain.candidateType ? 'Options' : 'Results'}`, budget);
  if (['DeliveryQuote', 'ProductOffer', 'ReservationOffer'].includes(type)) return graph.related(owner, root, 'offers', budget)?.filter(o => o.ref.type === type).map(o => graph.read(owner, o.ref, budget));
  if (type === 'Reservation') return graph.related(owner, root, 'reservations', budget);
  if (type === 'OrderLine') {
    const orders = graph.related(owner, root, 'orders', budget); if (!orders) return;
    const lines = orders.map(o => graph.related(owner, o.ref, 'lines', budget));
    return lines.some(v => !v) ? undefined : lines.flatMap(v => v!);
  }
  if (type === 'ReservationSlot') {
    const reservations = graph.related(owner, root, 'reservations', budget), offers = graph.related(owner, root, 'offers', budget);
    if (!reservations || !offers) return;
    const slots = [...reservations, ...offers.filter(o => o.ref.type === 'ReservationOffer')].map(o => graph.related(owner, o.ref, 'slot', budget));
    return slots.some(v => !v) ? undefined : [...new Map(slots.flatMap(v => v!).map(v => [JSON.stringify(v.ref), v])).values()];
  }
  return [];
}

export function assessConditions(graph: OntologyObjectStore, owner: string, request: ServiceRequest, subject?: ObjectRef, phase?: 'precondition' | 'result'): ConditionCheck[] {
  const budget = { remaining: 1000 };
  return (request.conditions ?? []).filter(c => !phase || c.phase === phase).map(c => {
    const check: ConditionCheck = { conditionId: c.id, phase: c.phase as ConditionCheck['phase'], strength: c.strength, result: 'unknown', reason: 'No compatible evidence for this condition', evidenceRefs: [], evidenceLevels: [] };
    const expected = c.expected as Record<string, unknown>, rule = c.predicateRef.id;
    if (rule === 'execution.within_authority') return { ...check, reason: 'Runtime authorization is a separate protected check; a model condition grants no authority' };
    if (rule === 'geo.query_scope_matches') {
      const receipts = graph.related(owner, { type: 'ServiceRequest', id: request.id }, 'sourceReceipts', budget);
      const receipt = receipts?.find(r => r.properties.scope === 'public_locations' && r.properties.evidenceLevel !== 'user_asserted' && r.properties.sourceIdentity && r.properties.contentDigest && r.properties.queryScope && Date.parse(String(r.properties.observedAt)) <= graph.now());
      return receipt ? { ...check, result: digest(receipt.properties.queryScope) === digest(c.expected) ? 'pass' : 'fail', reason: 'Compared actual source query scope; no delivery destination inferred', evidenceRefs: [receipt.ref], evidenceLevels: [String(receipt.properties.evidenceLevel)] } : check;
    }
    const available = scopedObjects(graph, owner, request.id, c.subject.type, budget);
    if (!available) return { ...check, reason: 'Condition object coverage exceeds the read bound' };
    const explicit = c.subject.object ?? (subject?.type === c.subject.type ? subject : undefined);
    const object = explicit ? available.find(o => refEqual(o.ref, explicit)) : available.length === 1 ? available[0] : undefined;
    if (!object) return { ...check, reason: explicit ? 'Condition subject is not evidenced for this request' : 'Condition requires an unambiguous object of the registered type' };
    check.subject = object.ref;
    const apply = (value: ReturnType<OntologyObjectStore['evaluate']>, predicate: (v: unknown) => boolean) => {
      check.evidenceRefs = value.evidenceRefs; check.evidenceLevels = value.evidenceLevels;
      if (value.status === 'known') { check.result = predicate(value.value) ? 'pass' : 'fail'; check.reason = 'Registered function evaluated the fixed condition'; }
      else check.reason = value.reason ?? check.reason;
      return check;
    };
    const evaluate = (input: unknown) => graph.evaluate(owner, input, budget);
    const domain = serviceDomains.find(d => rule === `domain.${d.id}.eligible` || rule === `domain.${d.id}.complete`);
    if (domain) {
      const requirements = graph.related(owner, object.ref, 'requirements', budget);
      if (requirements?.length !== 1 || !refEqual(requirements[0]!.ref, c.expected as ObjectRef)) return { ...check, reason: 'The domain condition refers to different fixed requirements' };
      const value = evaluate({ function: c.phase === 'result' ? domain.outcomeFunction : domain.eligibleFunction, object: object.ref });
      const status = (value.value as DomainAssessment | undefined)?.status;
      if (value.status === 'unknown' || status === 'unknown') return { ...check, reason: value.reason ?? 'Domain evidence is incomplete; no business completion established', evidenceRefs: value.evidenceRefs, evidenceLevels: value.evidenceLevels };
      return apply(value, () => status === 'satisfied');
    }
    if (rule === 'offer.total_within_budget') return apply(evaluate({ function: 'withinBudget', object: object.ref, budget: expected.amount, priceBasis: expected.priceBasis }), v => v === 'pass');
    if (rule === 'parcel.quote_matches_request') {
      const value = evaluate({ function: 'deliveryQuoteMatches', object: object.ref, request: { type: 'ServiceRequest', id: request.id }, serviceLevel: expected.serviceLevel });
      const parcel = graph.related(owner, object.ref, 'parcel', budget), route = graph.related(owner, object.ref, 'route', budget);
      return apply(value, v => v === 'pass' && sameQuantity(object.properties.quotedWeight, expected.weight) && (!expected.parcel || parcel?.length === 1 && refEqual(parcel[0]!.ref, expected.parcel as ObjectRef)) && (!expected.route || route?.length === 1 && refEqual(route[0]!.ref, expected.route as ObjectRef)));
    }
    if (rule === 'reservation.slot_matches_request') return apply(evaluate({ function: 'slotAvailability', object: object.ref, venue: expected.venue, startsAt: expected.startsAt, timeZone: expected.timeZone, partySize: expected.partySize }), v => v === 'pass');
    if (rule === 'reservation.confirmation_effective') {
      const value = evaluate({ function: 'reservationStatus', object: object.ref });
      if (value.status === 'known' && ['pending', 'requested', 'held'].includes(String(value.value))) return { ...check, reason: 'Provider has not confirmed an effective reservation', evidenceRefs: value.evidenceRefs, evidenceLevels: value.evidenceLevels };
      return apply(value, v => v === 'confirmed');
    }
    if (rule === 'delivery.receipt_matches_request') {
      const value = evaluate({ function: 'remainingQuantity', object: object.ref });
      if (value.status !== 'known') return apply(value, () => false);
      if (!sameQuantity(object.properties.quantityOrdered, expected.quantity) || (value.value as { amount: string }).amount !== '0') return apply(value, () => false);
      return { ...check, reason: 'Quantity is covered, but exact destination and deadline still require delivery evidence', evidenceRefs: value.evidenceRefs, evidenceLevels: value.evidenceLevels };
    }
    const validity = object.ref.type === 'ProductOffer' ? evaluate({ function: 'offerFreshness', object: object.ref }) : evaluate({ function: 'remainingQuantity', object: object.ref });
    if (validity.status !== 'known' || validity.value === false) return { ...check, reason: 'Current source evidence is unavailable', evidenceRefs: validity.evidenceRefs, evidenceLevels: validity.evidenceLevels };
    if (rule === 'goods.variant_matches') {
      const variants = graph.related(owner, object.ref, 'productVariant', budget);
      if (object.ref.type === 'ProductOffer' && object.properties.variantRevision !== variants?.[0]?.revision) return { ...check, reason: 'Quoted product specification version changed' };
      return variants?.length === 1 ? apply(validity, () => refEqual(variants[0]!.ref, c.expected as ObjectRef)) : check;
    }
    if (rule === 'goods.capacity_covers_quantity') {
      const offered = quantity(object.properties.offeredQuantity), needed = quantity(c.expected);
      if (!offered || !needed || object.properties.capacity === undefined || object.properties.capacity === 'unknown' || !object.properties.capacityObservationRef) return check;
      return apply(validity, () => object.properties.capacity === 'confirmed' && offered.dimension === needed.dimension && offered.amount >= needed.amount);
    }
    if (rule === 'delivery.commitment_covers_deadline') {
      if (!object.properties.deliveryCommitment) return { ...check, reason: 'An arrival estimate is not a delivery commitment' };
      return apply(validity, () => Date.parse(String(object.properties.deliveryCommitment)) <= Date.parse(String(expected.at)));
    }
    return check;
  });
}
export function hardConditionsPass(checks: ConditionCheck[], phase: 'precondition' | 'result') { return checks.filter(c => c.strength === 'hard' && c.phase === phase).every(c => c.result === 'pass'); }
