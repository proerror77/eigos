import { z } from 'zod';
import type { ObjectRef } from '../model.js';

export const text = z.string().min(1).max(200);
export const minor = z.string().regex(/^(0|[1-9]\d{0,17})$/);
export const date = z.iso.date();
export const instant = z.iso.datetime({ offset: true });
export const guestSchema = z.strictObject({ adults: z.number().int().min(1).max(8), childrenAges: z.array(z.number().int().min(0).max(17)).max(6) });
export const requirementSchema = z.strictObject({ code: text, date, roomIndex: z.number().int().min(0).max(3), quantity: z.number().int().min(1).max(32) });
export const requestSchema = z.strictObject({
  checkIn: date, checkOut: date, currency: z.string().regex(/^[A-Z]{3}$/), rooms: z.array(guestSchema).min(1).max(4),
  benefits: z.array(requirementSchema).max(50), allowSplitStay: z.boolean(), allowRoomTypeChange: z.boolean(),
  allowQualificationPurchases: z.boolean(),
  cancellationAt: instant.nullable(), maxTotalMinor: minor.nullable(), maxPurchases: z.number().int().min(1).max(12),
});
export const skuSchema = z.strictObject({
  version: text, category: z.enum(['room','bundle','benefit','activation']), maxUnits: z.number().int().min(0).max(12).nullable(),
  saleState: z.enum(['available','unavailable','unknown']), eligibility: z.enum(['eligible','ineligible','unknown']), termsKnown: z.boolean(),
  platformCommissionMinor: minor.nullable(),
});
export const componentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('stay'), rooms: z.number().int().min(1).max(4).nullable(), nights: z.number().int().min(1).max(7).nullable(), conditionsKnown: z.boolean() }),
  z.strictObject({ kind: z.literal('benefit'), quantity: z.number().int().min(1).max(32).nullable(), repeat: z.enum(['per_night','per_stay','per_package','unknown']),
    dayOffset: z.number().int().min(0).max(7).nullable(), optional: z.boolean().nullable(), conditionsKnown: z.boolean() }),
]);
export const quoteSchema = z.strictObject({
  skuVersion: text, variantRevision: z.number().int().positive(), anchorDate: date, currency: z.string().regex(/^[A-Z]{3}$/),
  priceKind: z.enum(['exact','from','masked','unknown']), amountMinor: minor.nullable(), feesKnown: z.boolean(),
  fees: z.array(z.strictObject({ code: text, amountMinor: minor })).max(20),
  discount: z.strictObject({ state: z.enum(['none','confirmed','unknown']), amountMinor: minor.nullable(), limited: z.boolean() }),
  guest: guestSchema.nullable(), availability: z.enum(['available','unavailable','unknown']),
  cancellation: z.strictObject({ state: z.enum(['known','unknown']), freeUntil: instant.nullable() }), expiresAt: instant,
});
export const inventorySchema = z.strictObject({
  kind: z.enum(['sale','room','benefit','promotion']), unit: z.enum(['package','room_night','person_use','ride','coupon_use']),
  state: z.enum(['known','unknown','unavailable']), capacity: z.number().int().min(0).max(10000).nullable(), date: date.nullable(), expiresAt: instant,
});
export const entitlementSchema = z.strictObject({ code: text, unit: z.enum(['person_use','ride']), inventoryRequired: z.boolean() });
export const resourceSchema = z.strictObject({ quantity: z.number().int().min(1).max(1000), condition: z.enum(['always','with_component']) });
export const prerequisiteSchema = z.strictObject({ quantity: z.number().int().min(1).max(12), basis: z.enum(['per_plan','per_unit']),
  scope: z.enum(['study','same_room']), anchor: z.enum(['any','same_date','covers_date']), dayOffset: z.number().int().min(-1).max(7), phase: z.enum(['purchase','redemption']) });
export const boundsSchema = z.strictObject({
  maxNodes: z.number().int().min(1).max(1000000).default(50000),
  maxRealizations: z.number().int().min(1).max(5000).default(500),
  maxPlans: z.number().int().min(1).max(10).default(3),
});
export type Request = z.infer<typeof requestSchema>;
export type Sku = z.infer<typeof skuSchema>;
export type Component = z.infer<typeof componentSchema>;
export type Quote = z.infer<typeof quoteSchema>;
export type Inventory = z.infer<typeof inventorySchema>;
export type Entitlement = z.infer<typeof entitlementSchema>;
export type Prerequisite = z.infer<typeof prerequisiteSchema> & {sku:ObjectRef};
export type Bounds = z.infer<typeof boundsSchema>;
export interface Demand { key: string; kind: 'room'|'benefit'; roomIndex: number; date: string; code?: string; unit: string; quantity: number }
export interface Diagnostic { object: ObjectRef; state: 'rejected'|'unknown'; reason: string }
export interface Realization {
  id: string; sku: ObjectRef; variant: ObjectRef; quote: ObjectRef; roomIndex: number; roomType?: ObjectRef; anchorDate: string;
  components: ObjectRef[]; coverage: number[]; resources: Record<string,number>; totalMinor: string;
  breakdown: { baseMinor: string; feesMinor: string; customerDiscountMinor: string };
}
export interface Plan {
  id: string; totalMinor: string; currency: string; purchases: Realization[];
  path: { id: string; kind: 'purchase_simulation'|'redemption_simulation'; sku: ObjectRef; quote: ObjectRef; roomIndex: number; date?: string; dependsOn: string[] }[];
  covered: { demand: string; required: number; supplied: number }[]; resourceUsage: { pool: ObjectRef; quantity: number; capacity: number }[];
}
export interface OptimizationResult {
  evidenceLevel: 'synthetic'; bookable: false; executed: false; modelDigest: string; inputDigest: string;
  request: ObjectRef; status: 'optimal'|'best_known'|'no_solution'|'inconclusive'; plans: Plan[];
  search: { complete: boolean; visitedNodes: number; generatedRealizations: number; scope: 'supplied_synthetic_catalog'; catalogComplete: boolean; unknownCandidates: number };
  diagnostics: Diagnostic[];
}
