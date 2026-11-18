import { z } from 'zod';
import { digest } from '../../core/identity.js';
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
  const mapJson = () => result.structuredContent ?? JSON.parse(result.content?.find(item => item.type === 'text')?.text ?? 'null');
  if (tool === 'taxi_generate_ride_app_link') {
    const { appLink, miniprogramLink, browserLink } = z.object({
      appLink: z.string(), miniprogramLink: z.string().optional(), browserLink: z.string().optional(),
    }).parse(result.structuredContent);
    return didiDataSchema.parse({ kind: 'app_links', links: { appLink, miniprogramLink, browserLink } });
  }
  if (tool === 'maps_regeocode') {
    const address = z.object({
      status: z.literal('success'), formatted_address: z.string().optional(), address_all: z.string().optional(),
      address: z.string().optional(), city: z.string().optional(), county: z.string().optional(),
    }).parse(mapJson());
    return didiDataSchema.parse({ kind: 'address', address: {
      address: address.formatted_address || address.address_all || address.address,
      city: address.city, district: address.county,
    } });
  }
  if (tool === 'maps_direction_walking' || tool === 'maps_direction_bicycling' || tool === 'maps_direction_transit') {
    const scalar = z.number().int().nonnegative();
    const route = z.object({
      status: z.literal('success'),
      duration: z.object({ value: scalar }).optional(),
      distance: z.object({ value: scalar }).optional(),
      summary: z.string().optional(),
      paths: z.array(z.object({ duration: scalar, distance: scalar, summary: z.string().optional() })).optional(),
    }).parse(mapJson());
    const routes = route.paths?.length
      ? route.paths.slice(0, 5).map(path => ({ durationSeconds: path.duration, distanceMeters: path.distance, summary: path.summary }))
      : [{ durationSeconds: route.duration?.value, distanceMeters: route.distance?.value, summary: route.summary }];
    return didiDataSchema.parse({ kind: 'map_routes', routes });
  }
  if (tool === 'maps_direction_driving') {
    const raw = mapJson();
    const route = z.object({ status:z.literal('success'),duration:z.object({value:z.number().int().positive()}),distance:z.object({value:z.number().int().nonnegative()}) }).parse(raw);
    return didiDataSchema.parse({kind:'driving',durationSeconds:route.duration.value,distanceMeters:route.distance.value});
  }
  if (tool === 'maps_textsearch' || tool === 'maps_place_around') {
    let map = tool === 'maps_place_around' ? result.structuredContent : undefined;
    if (map === undefined) {
      if (result.content?.[0]?.type !== 'text' || !result.content[0].text) throw new Error('Missing map JSON');
      map = JSON.parse(result.content[0].text);
    }
    if (tool === 'maps_place_around' && !Array.isArray(map)) {
      const { pois, data } = z.object({ pois: z.unknown().optional(), data: z.unknown().optional() }).parse(map);
      map = pois ?? data;
    }
    const places = z.array(z.object({ display_name: z.string().min(1).max(500), address: z.string().max(1000), address_all: z.string().max(1500), city: z.string().min(1).max(500), location: z.object({ lng: z.number().finite().min(-180).max(180), lat: z.number().finite().min(-90).max(90) }) })).max(50).parse(map);
    return didiDataSchema.parse({ kind: 'places', places: places.map(p => ({ id: digest(p), name: p.display_name, address: p.address, addressAll: p.address_all, city: p.city, lng: p.location.lng, lat: p.location.lat, coordinateSystem: 'provider_unspecified', identityKind: 'local_snapshot_digest' })) });
  }
  const estimate = z.object({ traceId: z.string().min(1).max(1000), items: z.array(z.object({ productName: z.string().min(1).max(500), productCategory: z.string().min(1).max(500), priceText: z.string().max(500) })).max(50) }).parse(result.structuredContent);
  // traceId authorizes a later provider operation. Keep it in the private raw
  // receipt only; it is never a task/model field or a ride order reference.
  return didiDataSchema.parse({ kind: 'estimate', items: estimate.items.map(item => ({ ...item, priceKind: 'estimate', ...(estimatedMoney(item.priceText) ? { estimatedMoney: estimatedMoney(item.priceText) } : {}), feesComplete: 'unknown' })) });
}
