import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import type { CommerceSnapshot } from '../../ontology/commerce.js';
import { authoritativeTotal, type UcpCheckout, type UcpOrder } from './contracts.js';
import type { UcpResponse } from './client.js';
import { z } from 'zod';

const addressSchema = z.looseObject({ address_country: z.string().min(2).max(3), postal_code: z.string().nullish(), address_region: z.string().nullish(), address_locality: z.string().nullish(), street_address: z.string().nullish(), extended_address: z.string().nullish(), first_name: z.string().nullish(), last_name: z.string().nullish(), phone_number: z.string().nullish() });
export function addressDigest(value: unknown): string | undefined {
  const address = addressSchema.safeParse(value);
  if (!address.success) return;
  return digest(Object.fromEntries(Object.keys(addressSchema.shape).flatMap(key => address.data[key] ? [[key, address.data[key]]] : [])));
}
export function usableAddressStructure(value: unknown): boolean {
  const address = addressSchema.safeParse(value);
  return !!(address.success && address.data.street_address?.trim() && (address.data.postal_code?.trim() || address.data.address_locality?.trim()));
}
const costBreakdown = (value: Pick<UcpCheckout, 'totals' | 'currency'>) => value.totals.map(t => ({ type: t.type, amount: { minor: String(t.amount), currency: value.currency }, ...(typeof t.display_text === 'string' && t.display_text ? { displayText: t.display_text } : {}) }));
const costTermsDigest = (value: Pick<UcpCheckout, 'totals' | 'line_items'> | Pick<UcpOrder, 'totals' | 'line_items'>) => digest({ totals: value.totals, lines: value.line_items.map(l => ({ id: l.item.id, totals: l.totals })).sort((a, b) => a.id.localeCompare(b.id)) });

function countUnit(line: Record<string, unknown>, item: Record<string, unknown>) {
  for (const raw of [line.quantity_unit, item.quantity_unit]) if (raw !== undefined) {
    const descriptor = z.looseObject({ unit: z.literal('C62'), scale: z.literal(0), increment: z.literal(1).optional() }).safeParse(raw);
    if (!descriptor.success) throw new DomainError('CONFLICT', 'This UCP integration supports integer each-counts only; do not reinterpret measured quantities');
  }
}
export function checkoutSnapshot(response: UcpResponse<UcpCheckout>): CommerceSnapshot['checkout'] {
  const c = response.value, items = c.line_items.map(l => ({ id: l.item.id, lineId: l.id, title: l.item.title, quantity: l.quantity, unitPrice: { minor: String(l.item.price), currency: c.currency } }));
  for (const line of c.line_items) countUnit(line, line.item);
  if (new Set(items.map(i => i.id)).size !== items.length || new Set(c.line_items.map(i => i.id)).size !== items.length) throw new DomainError('CONFLICT', 'Ambiguous duplicate UCP item or line identities');
  const total = authoritativeTotal(c), fulfillmentDigest = digest(c.fulfillment ?? null), buyerDigest = digest(c.buyer ?? null);
  const methods = z.array(z.looseObject({ type: z.string(), line_item_ids: z.array(z.string()), selected_destination_id: z.string().optional(), destinations: z.array(z.record(z.string(), z.unknown())).optional(), groups: z.array(z.looseObject({ selected_option_id: z.string().optional() })).optional() })).safeParse(c.fulfillment?.methods);
  let destinationDigest: string | undefined, destinationComplete = false;
  if (methods.success && methods.data.length === 1) {
    const m = methods.data[0]!;
    if (m.type === 'shipping' && m.groups?.length && m.groups.every(g => g.selected_option_id) && digest([...m.line_item_ids].sort()) === digest(c.line_items.map(l => l.id).sort())) {
      const destination = m.destinations?.find(d => d.id === m.selected_destination_id);
      destinationDigest = addressDigest(destination); destinationComplete = usableAddressStructure(destination);
    }
  }
  const costs = costBreakdown(c), costDigest = costTermsDigest(c);
  return { id: c.id, state: c.status, items, total, costBreakdown: costs, costTermsDigest: costDigest, fulfillmentDigest, buyerDigest, destinationComplete,
    quoteDigest: digest({ items, total, costTermsDigest: costDigest, fulfillmentDigest, buyerDigest, links: c.links }),
    ...(destinationDigest ? { destinationDigest } : {}), ...(c.expires_at ? { expiresAt: c.expires_at } : {}), ...(c.continue_url ? { continueUrl: c.continue_url } : {}), ...(c.order ? { orderId: c.order.id } : {}),
    messageCodes: c.messages?.filter(m => m.type === 'error').map(m => String(m.code ?? 'unspecified').slice(0, 200)) ?? [], receipt: response.receipt };
}
export function orderSnapshot(response: UcpResponse<UcpOrder>): NonNullable<CommerceSnapshot['order']> {
  const o = response.value;
  for (const line of o.line_items) countUnit(line, line.item);
  if (new Set(o.line_items.map(i => i.id)).size !== o.line_items.length || new Set(o.line_items.map(i => i.item.id)).size !== o.line_items.length) throw new DomainError('CONFLICT', 'Ambiguous UCP order line identities');
  if (o.messages?.some(m => m.type === 'error')) throw new DomainError('CONFLICT', 'Order observation contains unresolved business errors');
  const events = (o.fulfillment.events ?? []).map(event => ({ id: event.id, type: event.type, occurredAt: event.occurred_at, allocations: event.line_items.map(line => {
    const item = o.line_items.find(l => l.id === line.id); if (!item) throw new DomainError('CONFLICT', 'Fulfillment event references an unknown order line');
    return { lineId: line.id, itemId: item.item.id, quantity: line.quantity };
  }) }));
  if (new Set(events.map(e => e.id)).size !== events.length) throw new DomainError('CONFLICT', 'Duplicate fulfillment event identities');
  const actual = new Map<string, number>();
  for (const e of events.filter(e => e.type === 'delivered')) {
    if (Date.parse(e.occurredAt) > Date.parse(response.receipt.receivedAt)) throw new DomainError('CONFLICT', 'A future event cannot prove delivery');
    for (const allocation of e.allocations) actual.set(allocation.itemId, (actual.get(allocation.itemId) ?? 0) + allocation.quantity);
  }
  if (o.line_items.some(l => (actual.get(l.item.id) ?? 0) > l.quantity.total || l.quantity.fulfilled > l.quantity.total)) throw new DomainError('CONFLICT', 'Delivered quantities exceed the order');
  // A fulfilled count or a shipped event alone is not evidence of arrival.
  const fulfillment = events.some(e => ['undeliverable', 'returned_to_sender'].includes(e.type)) ? 'failed' : o.line_items.every(l => l.quantity.total > 0 && actual.get(l.item.id) === l.quantity.total) ? 'delivered' : actual.size ? 'partial' : 'pending';
  if (o.line_items.some(l => l.quantity.total === 0)) throw new DomainError('CONFLICT', 'Removed order items require explicit change handling');
  const destinations = new Set<string>(), coverage = new Map<string, number>(); let completeCoverage = !!o.fulfillment.expectations?.length;
  for (const raw of o.fulfillment.expectations ?? []) {
    const e = z.looseObject({ method_type: z.literal('shipping'), destination: z.unknown(), line_items: z.array(z.looseObject({ id: z.string(), quantity: z.number().int().nonnegative() })) }).safeParse(raw);
    if (!e.success) { completeCoverage = false; continue; }
    const address = addressDigest(e.data.destination); if (!address) { completeCoverage = false; continue; } destinations.add(address);
    for (const l of e.data.line_items) { if (!o.line_items.some(i => i.id === l.id)) completeCoverage = false; coverage.set(l.id, (coverage.get(l.id) ?? 0) + l.quantity); }
  }
  const destinationDigest = completeCoverage && destinations.size === 1 && o.line_items.every(l => coverage.get(l.id) === l.quantity.total) ? [...destinations][0] : undefined;
  return { id: o.id, checkoutId: o.checkout_id, items: o.line_items.map(l => ({ id: l.item.id, lineId: l.id, title: l.item.title, quantity: l.quantity.total, unitPrice: { minor: String(l.item.price), currency: o.currency } })), total: authoritativeTotal(o), costBreakdown: costBreakdown(o), costTermsDigest: costTermsDigest(o), permalinkUrl: o.permalink_url, fulfillment, events, adjustmentCount: o.adjustments?.length ?? 0, ...(destinationDigest ? { destinationDigest } : {}), receipt: response.receipt };
}
