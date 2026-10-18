import { z } from 'zod';
import { moneySchema, refSchema, type ProviderBinding } from './execution.js';

export interface SupplyIdentity { namespace: string; id: string }
export interface ProductVariant {
  sourceProductRef: SupplyIdentity; name: string; specification: Record<string, unknown>;
  specificationDigest: string; globalProductRef?: SupplyIdentity;
}
export interface ProductOfferSnapshot {
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
  requestId: string; requestRevision: number; offers: ProductOfferSnapshot[];
  merchantGroups: { merchant: SupplyIdentity; offerIds: string[]; channels: string[] }[];
  productMatches: { left: string; right: string; kind: 'same_external_product' | 'same_observed_specification' | 'different' | 'unknown'; evidenceRefs: string[] }[];
  coverage: DiscoveryCoverage[];
}
export interface DiscoveredBinding extends ProviderBinding {
  discovery: { sourceId: string; requestId: string; requestRevision: number; observedAt: string; evidenceRefs: string[] };
}
