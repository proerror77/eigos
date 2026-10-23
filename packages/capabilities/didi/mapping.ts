import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { didiDataSchema, type DidiData, type DidiTool } from './contracts.js';

/** Only a literal decimal amount is exact enough to convert to minor units.
 * Ranges, approximations and "from" prices remain source text. */
export function estimatedMoney(price: string) {
  const match = /^(?:¥|￥)?(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?(?:元)?$/.exec(price.trim());
  return match ? { minor: String(BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))), currency: 'CNY' as const } : undefined;
}

export function mapDidiResult(tool: DidiTool, value: unknown): DidiData {
  const result = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).max(100).optional(), structuredContent: z.unknown().optional() }).parse(value);
  if (result.isError) throw new Error('Rejected MCP result');
  if (tool === 'maps_textsearch') {
    if (result.content?.[0]?.type !== 'text' || !result.content[0].text) throw new Error('Missing map JSON');
    const places = z.array(z.object({ display_name: z.string().min(1).max(500), address: z.string().max(1000), address_all: z.string().max(1500), city: z.string().min(1).max(500), location: z.object({ lng: z.number().finite().min(-180).max(180), lat: z.number().finite().min(-90).max(90) }) })).max(50).parse(JSON.parse(result.content[0].text));
    return didiDataSchema.parse({ kind: 'places', places: places.map(p => ({ id: digest(p), name: p.display_name, address: p.address, addressAll: p.address_all, city: p.city, lng: p.location.lng, lat: p.location.lat, coordinateSystem: 'provider_unspecified', identityKind: 'local_snapshot_digest' })) });
  }
  const estimate = z.object({ traceId: z.string().min(1).max(1000), items: z.array(z.object({ productName: z.string().min(1).max(500), productCategory: z.string().min(1).max(500), priceText: z.string().max(500) })).max(50) }).parse(result.structuredContent);
  // traceId authorizes a later provider operation. Keep it in the private raw
  // receipt only; it is never a task/model field or a ride order reference.
  return didiDataSchema.parse({ kind: 'estimate', items: estimate.items.map(item => ({ ...item, priceKind: 'estimate', ...(estimatedMoney(item.priceText) ? { estimatedMoney: estimatedMoney(item.priceText) } : {}), feesComplete: 'unknown' })) });
}
