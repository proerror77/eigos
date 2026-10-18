import { z } from 'zod';

// The official reference merchant used by this integration declares this pin.
// A later UCP version must be negotiated and validated explicitly.
export const UCP_VERSION = '2026-04-08' as const;
export const ucpId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const total = z.looseObject({ type: z.string().min(1).max(80), amount });
const totals = z.array(total).min(1).max(30).refine(rows => rows.filter(r => r.type === 'total').length === 1, 'One authoritative total is required');
const metadata = z.looseObject({ version: z.literal(UCP_VERSION), capabilities: z.record(z.string(), z.array(z.looseObject({ version: z.string() })).max(20)), status: z.string().optional() });
const itemId = z.string().min(1).max(200);
const item = z.looseObject({ id: itemId, title: z.string().max(500), price: amount });
export const requestedItemsSchema = z.array(z.object({ id: itemId, quantity: z.number().int().min(1).max(1000) }).strict()).min(1).max(20).refine(items => new Set(items.map(i => i.id)).size === items.length, 'Item IDs must be unique');
export type RequestedItem = z.infer<typeof requestedItemsSchema>[number];
export const checkoutSchema = z.looseObject({
  ucp: metadata, id: ucpId,
  status: z.enum(['incomplete', 'requires_escalation', 'ready_for_complete', 'complete_in_progress', 'completed', 'canceled']),
  currency: z.enum(['CNY', 'USD', 'EUR']),
  line_items: z.array(z.looseObject({ id: ucpId, item, quantity: z.number().int().min(1).max(1000), totals })).min(1).max(20),
  totals, links: z.array(z.looseObject({ type: z.string(), url: z.url() })).max(30),
  continue_url: z.url().nullish(), expires_at: z.iso.datetime({ offset: true }).nullish(),
  order: z.looseObject({ id: ucpId, permalink_url: z.url() }).nullish(),
  fulfillment: z.record(z.string(), z.unknown()).nullish(), buyer: z.record(z.string(), z.unknown()).nullish(),
  payment: z.record(z.string(), z.unknown()).nullish(), messages: z.array(z.record(z.string(), z.unknown())).max(30).nullish(),
});
export type UcpCheckout = z.infer<typeof checkoutSchema>;
export const orderSchema = z.looseObject({
  ucp: metadata, id: ucpId, checkout_id: ucpId, permalink_url: z.url(), currency: z.enum(['CNY', 'USD', 'EUR']), totals,
  line_items: z.array(z.looseObject({ id: ucpId, item, quantity: z.looseObject({ total: z.number().int().nonnegative().max(1000), fulfilled: z.number().int().nonnegative().max(1000) }), totals, status: z.string().max(100).optional() })).min(1).max(20),
  fulfillment: z.looseObject({
    expectations: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
    events: z.array(z.looseObject({ id: ucpId, type: z.string().min(1).max(100), occurred_at: z.iso.datetime({ offset: true }), line_items: z.array(z.object({ id: ucpId, quantity: z.number().int().nonnegative().max(1000) }).passthrough()).max(20) })).max(100).optional(),
  }),
  adjustments: z.array(z.record(z.string(), z.unknown())).max(100).optional(), messages: z.array(z.record(z.string(), z.unknown())).max(30).nullish(),
});
export type UcpOrder = z.infer<typeof orderSchema>;
export const profileSchema = z.looseObject({ ucp: metadata.extend({ services: z.record(z.string(), z.array(z.looseObject({ version: z.string(), transport: z.string(), endpoint: z.url() })).max(20)) }) });
export function authoritativeTotal(value: { totals: { type: string; amount: number }[]; currency: string }) {
  return { minor: String(value.totals.find(t => t.type === 'total')!.amount), currency: value.currency };
}
