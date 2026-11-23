import { z } from 'zod';
import { Conflict, digest, SourceReadFailure } from '../../core/identity.js';
import {
  amapAreaType, amapCityCode, amapDistanceInput, amapDistanceLegRecord, amapDistanceLegType, amapDistanceRecord, amapGeocodeInput,
  amapGeocodeRecord, amapObservationLinks as links, amapObservationRef, amapObservations as types, amapPointRecord,
  amapPointType, amapRouteInput, amapRouteOptionRecord, amapRouteOptionType, amapRouteRecord, amapTrafficAreaRecord,
  amapTrafficInput, amapTrafficRecord,
} from '../../ontology/amap-observations.js';
import type { ObjectData, ObjectRef } from '../../ontology/schema.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import type { Objects } from '../../runtime/objects.js';
import type { AmapResolver } from './client.js';
import { geocodeAmapPoints, pointText } from './functions.js';

type Graph = FunctionContext['objects'];
type Point = z.infer<typeof amapPointRecord>;
type Endpoint = z.infer<typeof amapRouteInput>['origin'];
type ConfirmedPoint = { point: Omit<Point, 'id'>; original?: ObjectData };
const number = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number)]).pipe(z.number().nonnegative());
const whole = number.transform(Math.round);
const dereference = (row: ObjectData) => ({ ...amapPointRecord.parse(row.properties), ref: row.ref });
const id = (ref: ObjectRef, type: string, role: string | number) => ({ type, id: digest([ref.id, type, role]) });
const relation = (type: string, from: ObjectRef, to: ObjectRef) => ({ type, from, to });

async function endpoint(graph: Graph, value: Endpoint): Promise<ConfirmedPoint> {
  if ('point' in value) return { point: { point: value.point, evidence: 'caller_provided',
    name: value.name ?? pointText(value.point), cityCode: value.cityCode, adcode: value.adcode } };
  if (value.place.type !== amapPointType) throw new Conflict('Use a point returned by the original Amap observation');
  const original = await graph.read(value.place);
  const { id: _id, ...point } = amapPointRecord.parse(original.properties);
  return { original, point: { ...point, cityCode: value.cityCode ?? point.cityCode, adcode: value.adcode ?? point.adcode } };
}
async function savePoint(graph: Pick<Objects, 'read' | 'create'>, observation: ObjectRef, role: string | number, value: ConfirmedPoint) {
  if (value.original) {
    const current = await graph.read(value.original.ref);
    if (current.revision !== value.original.revision) throw new Conflict('The selected Amap point changed before saving');
    return current.ref;
  }
  const ref = id(observation, amapPointType, role);
  await graph.create(ref, { id: ref.id, ...value.point });
  return ref;
}

function edit(ctx: FunctionContext, type: string) {
  if (!ctx.edit || !ctx.operationId) throw new Conflict('Run the published Amap Action');
  return { stage: ctx.edit, ref: { type, id: digest([ctx.operationId, type]) } };
}
const receipt = (ref: ObjectRef, name: string, input: unknown, result: unknown) => ({
  id: ref.id, name, provider: 'Amap' as const, observedAt: new Date().toISOString(),
  inputDigest: digest(input), resultDigest: digest(result),
});
const busLines = z.object({ buslines: z.array(z.object({ name: z.string().trim().min(1).max(250) })) });
const routeFields = z.object({ distance: whole, duration: whole.optional(), cost: z.object({ duration: whole }).optional(),
  segments: z.array(z.object({ bus: z.unknown().optional() })).optional(),
});

export function amapObservationFunctions(source: AmapResolver): ReadonlyMap<string, FunctionHandler> {
  const handlers = new Map<string, FunctionHandler>([
    [types.route.fn, async (raw, ctx) => {
      const input = amapRouteInput.parse(raw), { stage, ref } = edit(ctx, types.route.type);
      const [origin, destination] = await Promise.all([endpoint(ctx.objects, input.origin), endpoint(ctx.objects, input.destination)]);
      const args = { origin: pointText(origin.point.point), destination: pointText(destination.point.point) };
      const client = await source(ctx);
      let rawOptions: unknown;
      if (input.mode === 'transit') {
        const city1 = origin.point.cityCode, city2 = destination.point.cityCode;
        if (!city1 || !city2) throw new Conflict('请提供公交起终点的高德城市代码（如上海 021），或选择已解析的地点。');
        const ad1 = origin.point.adcode, ad2 = destination.point.adcode;
        rawOptions = z.object({ route: z.object({ transits: z.array(z.unknown()) }) }).parse(
          await client.web('/v5/direction/transit/integrated', { ...args, city1, city2, show_fields: 'cost',
            ...(ad1 ? { ad1 } : {}), ...(ad2 ? { ad2 } : {}) }, ctx.signal)).route.transits;
      } else if (input.mode === 'bicycling') {
        rawOptions = z.object({ route: z.object({ paths: z.array(z.unknown()) }) }).parse(
          await client.web('/v5/direction/bicycling', args, ctx.signal)).route.paths;
      } else {
        const reply = z.object({ route: z.object({ paths: z.array(z.unknown()) }).optional(), paths: z.array(z.unknown()).optional() })
          .parse(await client.mcp(input.mode === 'walking' ? 'maps_direction_walking' : 'maps_direction_driving', args, ctx.signal));
        rawOptions = reply.route?.paths ?? reply.paths;
      }
      const options = z.array(routeFields).max(100).parse(rawOptions).slice(0, 5).map(({ distance, duration, cost, segments }, index) => ({
        rank: index + 1, distanceMeters: distance, durationSeconds: z.number().parse(cost?.duration ?? duration),
        ...(segments ? { lines: [...new Set(segments.flatMap(segment =>
          busLines.safeParse(segment.bus).data?.buslines.map(line => line.name) ?? []))].slice(0, 20) } : {}),
      }));
      return stage(ref, async graph => {
        const start = await savePoint(graph, ref, 'origin', origin), end = await savePoint(graph, ref, 'destination', destination);
        await graph.create(ref, amapRouteRecord.parse({ ...receipt(ref, '高德路线', input, options), mode: input.mode }));
        await graph.linkBatch([relation(links.routeOrigin, ref, start), relation(links.routeDestination, ref, end)]);
        for (const option of options) {
          const child = id(ref, amapRouteOptionType, option.rank);
          await graph.create(child, { id: child.id, name: `路线 ${option.rank}`, ...option });
          await graph.link(relation(links.routeOptions, ref, child));
        }
      });
    }],
    [types.distance.fn, async (raw, ctx) => {
      const input = amapDistanceInput.parse(raw), { stage, ref } = edit(ctx, types.distance.type);
      const points = await Promise.all([...input.origins, input.destination].map(value => endpoint(ctx.objects, value)));
      const destination = points.pop()!;
      const client = await source(ctx);
      const reply = z.object({ results: z.array(z.object({ origin_id: whole, dest_id: whole, distance: whole,
        duration: whole.optional() })).max(10) }).parse(await client.web('/v3/distance', {
        origins: points.map(value => pointText(value.point.point)).join('|'), destination: pointText(destination.point.point),
        type: { straight: '0', driving: '1', walking: '3' }[input.mode],
      }, ctx.signal));
      const legs = reply.results.sort((a, b) => a.origin_id - b.origin_id);
      if (legs.length !== points.length || legs.some((entry, index) => entry.origin_id !== index + 1 || entry.dest_id !== 1))
        throw new SourceReadFailure('高德距离结果与原始起终点不匹配。');
      return stage(ref, async graph => {
        await graph.create(ref, amapDistanceRecord.parse({ ...receipt(ref, '高德距离测量', input, legs), mode: input.mode }));
        await graph.link(relation(links.distanceDestination, ref, await savePoint(graph, ref, 'destination', destination)));
        for (const leg of legs) {
          const child = id(ref, amapDistanceLegType, leg.origin_id);
          const origin = await savePoint(graph, ref, leg.origin_id, points[leg.origin_id - 1]!);
          await graph.create(child, { id: child.id, name: `起点 ${leg.origin_id}`, originIndex: leg.origin_id,
            distanceMeters: leg.distance, durationSeconds: input.mode === 'straight' ? null : leg.duration ?? null });
          await graph.linkBatch([relation(links.distanceLegs, ref, child), relation(links.legOrigin, child, origin)]);
        }
      });
    }],
    [types.traffic.fn, async (raw, ctx) => {
      const input = amapTrafficInput.parse(raw), { stage, ref } = edit(ctx, types.traffic.type);
      const { southwest, northeast, level } = input, east = northeast.longitude - southwest.longitude, north = northeast.latitude - southwest.latitude;
      const diagonal = Math.hypot(north, east * Math.cos((southwest.latitude + northeast.latitude) * Math.PI / 360)) * 111_320;
      if (east <= 0 || north <= 0 || diagonal > 10_000) throw new Conflict('请提供对角线在 10 公里内、方向正确的路况区域。');
      const client = await source(ctx);
      const { trafficinfo: report } = z.object({ trafficinfo: z.object({
        evaluation: z.object({ status: z.coerce.string().pipe(z.enum(['0', '1', '2', '3'])) }),
        description: z.string().max(2000).optional(), roads: z.array(z.unknown()).max(3000).optional(),
      }) }).parse(await client.web('/v3/traffic/status/rectangle', {
        rectangle: pointText(southwest) + ';' + pointText(northeast), level: String(level), extensions: 'all',
      }, ctx.signal));
      const status = { '0': 'unknown', '1': 'clear', '2': 'slow', '3': 'congested' }[report.evaluation.status];
      return stage(ref, async graph => {
        const area = id(ref, amapAreaType, 'area');
        await graph.create(ref, amapTrafficRecord.parse({ ...receipt(ref, '高德区域路况', input, report),
          status, description: report.description ?? null, roadCount: report.roads?.length ?? 0 }));
        await graph.create(area, { id: area.id, name: '路况查询矩形', southwest, northeast });
        await graph.link(relation(links.trafficArea, ref, area));
      });
    }],
    [types.geocode.fn, async (raw, ctx) => {
      const input = amapGeocodeInput.parse(raw), { stage, ref } = edit(ctx, types.geocode.type);
      const candidates = await geocodeAmapPoints(await source(ctx), input, ctx.signal);
      return stage(ref, async graph => {
        await graph.create(ref, receipt(ref, '高德地址解析', input, candidates));
        for (const [index, { point: candidate, cityCode }] of candidates.entries()) {
          const point = await savePoint(graph, ref, index, { point: { name: candidate.address ?? input.address,
            point: candidate.point, cityCode: amapCityCode.safeParse(cityCode).data, adcode: candidate.adcode,
            address: candidate.address, evidence: 'amap_geocode' } });
          await graph.link(relation(links.geocodeCandidates, ref, point));
        }
      });
    }],
    ['readAmapObservation', async (raw, ctx) => {
      const { observation } = amapObservationRef.parse(raw), graph = ctx.objects;
      const data = (await graph.read(observation)).properties;
      const one = async (ref: ObjectRef, name: string) => {
        const [row] = await graph.follow(ref, name);
        if (!row) throw new Conflict('原高德观察记录的关联对象不可用。');
        return row;
      };
      if (observation.type === types.route.type) return { observation, kind: 'route', data: amapRouteRecord.parse(data),
        origin: dereference(await one(observation, 'origin')), destination: dereference(await one(observation, 'destination')),
        options: (await graph.follow(observation, 'options')).map(row => amapRouteOptionRecord.parse(row.properties)).sort((a, b) => a.rank - b.rank) };
      if (observation.type === types.distance.type) return { observation, kind: 'distance', data: amapDistanceRecord.parse(data),
        destination: dereference(await one(observation, 'destination')),
        legs: (await Promise.all((await graph.follow(observation, 'legs')).map(async row => ({
          ...amapDistanceLegRecord.parse(row.properties), origin: dereference(await one(row.ref, 'origin')),
        })))).sort((a, b) => a.originIndex - b.originIndex) };
      if (observation.type === types.traffic.type) return { observation, kind: 'traffic', data: amapTrafficRecord.parse(data),
        area: amapTrafficAreaRecord.parse((await one(observation, 'area')).properties) };
      if (observation.type === types.geocode.type) return { observation, kind: 'geocode', data: amapGeocodeRecord.parse(data),
        candidates: (await graph.follow(observation, 'candidates')).map(dereference) };
      throw new Conflict('请引用原高德观察记录。');
    }],
  ]);
  return new Map([...handlers].map(([name, run]) => [name, async (raw, ctx) => {
    try { return await run(raw, ctx); }
    catch (error) {
      if (error instanceof z.ZodError) throw new SourceReadFailure('高德返回的数据格式不受支持。');
      throw error;
    }
  }]));
}
