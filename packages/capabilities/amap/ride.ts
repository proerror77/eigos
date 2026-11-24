import { z } from 'zod';
import { Conflict, digest, SourceReadFailure } from '../../core/identity.js';
import { yuanToFen } from '../../core/private-source.js';
import {
  amapRide, amapRideInput, amapRidePlanData, amapRidePlanRecord, amapRidePlanRef,
} from '../../ontology/amap-ride.js';
import type { FunctionHandler } from '../../runtime/functions.js';
import type { configuredAmapRide } from './client.js';

const name = z.string().trim().min(1).max(250);
const point = z.object({ name, address: z.string().trim().min(1).max(600).optional() });
const choices = z.array(point.required()).min(1).max(100);
const farePlan = z.object({
  startPoint: point, endPoint: point,
  transportTypeInfoList: z.array(z.object({
    name, minPrice: z.union([z.number(), z.string()]), maxPrice: z.union([z.number(), z.string()]),
  })).min(1).max(50),
});
const entity = z.object({
  cardScene: z.string(), cardSubScene: z.string().optional(), modelInput: z.unknown(),
});
const cardResponse = z.object({ entities: z.array(entity).min(1).max(20) });
const fallback = z.string().trim().min(1).max(2000);

function project(raw: unknown): z.infer<typeof amapRidePlanData> {
  if (typeof raw === 'string') return { status: 'no_quote', message: fallback.parse(raw) };
  const cards = cardResponse.parse(raw).entities;
  const active = cards.filter(card => ['amap_car_point', 'amap_car_plan'].includes(card.cardScene));
  if (active.length > 1) throw new SourceReadFailure('高德返回了多个打车场景，无法确认当前报价。');
  const card = active[0];
  if (card?.cardScene === 'amap_car_point') {
    const side = z.enum(['start_point', 'end_point']).parse(card.cardSubScene);
    const { points } = z.object({ points: choices }).parse(card.modelInput);
    return { status: 'place_required', side: side === 'start_point' ? 'origin' : 'destination', candidates: points.slice(0, 30) };
  }
  if (card?.cardScene === 'amap_car_plan') {
    const value = farePlan.parse(card.modelInput);
    const offers = value.transportTypeInfoList.map(({ name: vehicle, minPrice, maxPrice }) => {
      const minMinor = yuanToFen(minPrice), maxMinor = yuanToFen(maxPrice);
      if (minMinor > maxMinor) throw new SourceReadFailure('高德返回了无效的车费区间。');
      return { vehicle, minMinor, maxMinor };
    });
    return { status: 'quoted', pickup: value.startPoint, dropoff: value.endPoint, currency: 'CNY', offers };
  }
  if (cards.every(item => item.cardScene === 'amap_car_abnormal' || item.cardScene === 'amap_car_default')) {
    return { status: 'no_quote', message: '高德未返回可用车费。请核对起终点后重新询价。' };
  }
  throw new SourceReadFailure('高德返回了未知的打车场景。');
}

export function amapRideFunctions(source: ReturnType<typeof configuredAmapRide>, mocked: boolean): ReadonlyMap<string, FunctionHandler> {
  return new Map<string, FunctionHandler>([
    [amapRide.prepare, async (raw, context) => {
      if (!context.edit || !context.operationId) throw new Conflict('Run the published Amap ride inquiry Action');
      const input = amapRideInput.parse(raw);
      const connection = await source(context);
      const args = {
        agent_name: 'EIGOS', origin: input.origin, origin_city: input.originCity,
        destination: input.destination, destination_city: input.destinationCity,
        vehicle_type: input.vehicleTypes ?? [], departure_time: '', arrival_time: '', businessData: '',
      };
      const reply = await connection.plan(args, context.signal);
      let result;
      try { result = amapRidePlanData.parse(project(reply)); }
      catch (error) {
        if (error instanceof SourceReadFailure) throw error;
        throw new SourceReadFailure('高德打车响应与询价契约不匹配。');
      }
      const plan = { type: amapRide.object, id: digest([context.operationId, amapRide.object]) };
      const record = amapRidePlanRecord.parse({
        id: plan.id, name: '高德打车估价', provider: 'Amap', input,
        observedAt: new Date().toISOString(), inputDigest: digest(args),
        resultDigest: digest(result), evidence: mocked ? 'provider_mock' : 'live_readonly', result,
      });
      return context.edit(plan, async graph => {
        await connection.assertCurrent();
        await graph.create(plan, record);
      });
    }],
    [amapRide.read, async (raw, context) => {
      const { plan } = amapRidePlanRef.parse(raw);
      if (plan.type !== amapRide.object) throw new Conflict('Use the original Amap ride plan reference');
      const observation = amapRidePlanRecord.parse((await context.objects.read(plan)).properties);
      return { plan, observation };
    }],
  ]);
}
