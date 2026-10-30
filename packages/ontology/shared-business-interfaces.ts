import { z } from 'zod';
import type { InterfaceDefinition, PropertyDefinition } from './model.js';

const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string, required = true): PropertyDefinition =>
  ({ kind, schema, description, required, source: "The object's validated business source; a shared definition is not shared authority" });
/** Canonical property semantics, reused by interfaces and source mappings.
 * Concrete names can differ; units and price basis remain explicit values. */
export const sharedBusinessProperties = {
  observedAt: p('timestamp', z.iso.datetime({ offset: true }), 'When the source fact was observed'),
  expiresAt: p('timestamp', z.iso.datetime({ offset: true }), 'The observation freshness deadline'),
  revision: p('integer', z.number().int().positive(), 'The exact related business revision', false),
  amount: p('decimal', z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,6})?$/), 'Numeric amount in the explicitly declared amount unit', false),
  currency: p('string', z.string().regex(/^[A-Z]{3}$/), 'Source currency; no implicit exchange conversion', false),
  amountUnit: p('string', z.enum(['major', 'minor']), 'Major or minor currency units; unlike units must not be directly compared'),
  priceKind: p('string', z.enum(['estimate', 'reference', 'display_price', 'firm_quote']), 'The source strength of this price'),
  priceBasis: p('string', z.enum(['total', 'unit', 'unknown']), 'The quantity or service basis; unknown is not a comparable total'),
  pricingCompleteness: p('string', z.enum(['complete', 'partial', 'unknown']), 'Coverage of mandatory charges'),
  startsAt: p('timestamp', z.iso.datetime({ offset: true }), 'Start of the represented business interval'),
  endsAt: p('timestamp', z.iso.datetime({ offset: true }), 'End of the represented business interval'),
  timeZone: p('string', z.string().min(1).max(2000), 'Explicit source time zone; not inferred from the server'),
};
const view = { propertyCompatibility: 'structural_v1' as const, projectionOnly: true };
export const sharedBusinessInterfaces: InterfaceDefinition[] = [
  { ...view, id: 'ObservedFact', description: 'A source-backed observation with reusable freshness and optional request/subject version checks.', parents: ['EvidenceBacked'],
    properties: { observedAt: sharedBusinessProperties.observedAt, expiresAt: sharedBusinessProperties.expiresAt,
      requestRevision: sharedBusinessProperties.revision, subjectRevision: sharedBusinessProperties.revision }, optionalProperties: ['requestRevision', 'subjectRevision'],
    links: [{ name: 'request', target: 'ServiceRequest', many: false, optional: true }, { name: 'subject', target: 'IdentitySubject', many: false, optional: true }] },
  { ...view, id: 'MonetaryFact', description: 'Read prices through one interface while retaining currency, units, basis, completeness and source strength. A price is not payment authority.', parents: ['ObservedFact'],
    properties: { amount: sharedBusinessProperties.amount, currency: sharedBusinessProperties.currency, amountUnit: sharedBusinessProperties.amountUnit,
      priceKind: sharedBusinessProperties.priceKind, priceBasis: sharedBusinessProperties.priceBasis, pricingCompleteness: sharedBusinessProperties.pricingCompleteness } },
  { ...view, id: 'Located', description: 'A business object whose explicit location relationship can be navigated without searching its name again.', properties: {},
    links: [{ name: 'location', target: 'Place', many: false }] },
  { ...view, id: 'Scheduled', description: 'Read the represented time interval consistently. Its start is not automatically an arrival, boarding or delivery deadline.',
    properties: { startsAt: { ...sharedBusinessProperties.startsAt, required: false }, endsAt: { ...sharedBusinessProperties.endsAt, required: false }, timeZone: { ...sharedBusinessProperties.timeZone, required: false } }, optionalProperties: ['timeZone'] },
  { ...view, id: 'OriginDestination', description: 'Two distinct route roles. An airport departure point is not the user location and an arrival point is not a delivery authorization.', properties: {},
    links: [{ name: 'origin', target: 'Place', many: false }, { name: 'destination', target: 'Place', many: false }] },
];
