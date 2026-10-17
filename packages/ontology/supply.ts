import { z } from 'zod';
import { moneySchema, refSchema, type ProviderBinding } from './execution.js';

export const pickupQuerySchema = z.object({
  city: z.string().trim().min(1).max(50), locationKeyword: z.string().trim().min(1).max(100),
  productQuery: z.string().trim().min(1).max(100).describe('Product search words, e.g. 美式. Quantity is a separate field; actual specifications come from provider detail.'), quantity: z.number().int().min(1).max(100), unit: z.enum(['杯', '份']),
  mode: z.literal('pickup'), allowAlternatives: z.boolean(), maxStores: z.number().int().min(1).max(5).default(3),
}).strict();
export type PickupQuery = z.infer<typeof pickupQuerySchema>;
export interface SupplyIdentity { namespace: string; id: string }
export interface ProductVariant {
  sourceProductRef: SupplyIdentity; name: string; specification: Record<string, unknown>;
  specificationDigest: string; globalProductRef?: SupplyIdentity;
}
export interface Offer {
  id: string; channelId: string; merchant: SupplyIdentity; merchantName: string; merchantAddress: string;
  bindingRef: z.infer<typeof refSchema>; product: ProductVariant; quotedQuantity: { amount: string; unit: string };
  pricing: { currency: 'CNY'; total?: z.infer<typeof moneySchema>; productSubtotal?: string; fees: { delivery?: string; packing?: string; tableware?: string }; kind: 'calculated_quote' | 'display_only' | 'unknown' };
  availability: { storeOpen: boolean | 'unknown'; capacity: 'unknown' | 'confirmed' | 'unavailable'; fulfillmentBy?: string;
    reservation?: { supported: boolean | 'unknown'; options: { date: string; today: boolean; label: string }[] }; businessHours?: { start?: string; end?: string } };
  observedAt: string; expiresAt: string; validityBasis: 'local_refresh_limit' | 'provider_expiry';
  evidenceRefs: string[]; sourceRevision: string; unknowns: string[];
}
export interface DiscoveryCoverage {
  sourceId: string; status: 'returned' | 'empty' | 'timeout' | 'needs_input' | 'needs_authorization' | 'unavailable';
  queriedAt: string; returnedStores: number; queriedStores: number; hasMore: boolean; realSupply: boolean;
  note?: string;
}
export interface Comparison {
  requestId: string; requestRevision: number; offers: Offer[];
  merchantGroups: { merchant: SupplyIdentity; offerIds: string[]; channels: string[] }[];
  productMatches: { left: string; right: string; kind: 'same_external_product' | 'same_observed_specification' | 'different' | 'unknown'; evidenceRefs: string[] }[];
  coverage: DiscoveryCoverage[];
}
export interface DiscoveredBinding extends ProviderBinding {
  discovery: { sourceId: string; requestId: string; requestRevision: number; observedAt: string; evidenceRefs: string[] };
}
