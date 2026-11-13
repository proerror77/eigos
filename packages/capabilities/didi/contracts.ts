import { z } from 'zod';

export const DIDI_TOOLS = ['maps_textsearch', 'taxi_estimate'] as const;
export type DidiTool = typeof DIDI_TOOLS[number];
const text = z.string().min(1).max(500);
export const didiBindingSchema = z.strictObject({
  bindingId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  keyFile: z.string().min(1), keySha256: z.string().regex(/^[a-f0-9]{64}$/), environment: z.enum(['production', 'mock']), auditDirectory: z.string().optional(),
});
export type DidiBinding = z.infer<typeof didiBindingSchema>;
const coordinate = (limit: number) => z.string().regex(/^-?\d+(?:\.\d+)?$/).refine(v => Number.isFinite(Number(v)) && Math.abs(Number(v)) <= limit);
export const didiToolInputs = {
  maps_textsearch: z.strictObject({ keywords: text, city: text }),
  taxi_estimate: z.strictObject({ from_lng: coordinate(180), from_lat: coordinate(90), from_name: text, to_lng: coordinate(180), to_lat: coordinate(90), to_name: text }),
};
export const didiPlaceSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/), name: text, address: z.string().max(1000), addressAll: z.string().max(1500), city: text,
  lng: z.number().finite().min(-180).max(180), lat: z.number().finite().min(-90).max(90),
  coordinateSystem: z.literal('provider_unspecified'), identityKind: z.literal('local_snapshot_digest'),
});
export type DidiPlace = z.infer<typeof didiPlaceSchema>;
export const didiPriceSchema = z.strictObject({
  productName: text, productCategory: text, priceText: z.string().max(500), priceKind: z.literal('estimate'),
  estimatedMoney: z.strictObject({ minor: z.string().regex(/^(0|[1-9]\d{0,17})$/), currency: z.literal('CNY') }).optional(),
  feesComplete: z.literal('unknown'),
});
export const didiDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('places'), places: z.array(didiPlaceSchema).max(50) }),
  z.strictObject({ kind: z.literal('estimate'), items: z.array(didiPriceSchema).max(50) }),
]);
export type DidiData = z.infer<typeof didiDataSchema>;
export const didiReceiptSchema = z.strictObject({
  id: z.uuid(), bindingId: didiBindingSchema.shape.bindingId, environment: didiBindingSchema.shape.environment,
  endpoint: z.enum(['https://mcp.didichuxing.com/mcp-servers', 'https://mcp.didichuxing.com/mcp-servers-sandbox']),
  tool: z.enum(DIDI_TOOLS), inputDigest: z.string().regex(/^[a-f0-9]{64}$/), resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/), toolSchemaDigest: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.iso.datetime(), receivedAt: z.iso.datetime(),
});
export type DidiReceipt = z.infer<typeof didiReceiptSchema>;
export type DidiEvidenceKind = 'live_readonly' | 'provider_mock' | 'fixture';
export const didiEndpoint = (environment: DidiBinding['environment']) => environment === 'production' ? 'https://mcp.didichuxing.com/mcp-servers' : 'https://mcp.didichuxing.com/mcp-servers-sandbox';
