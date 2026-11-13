import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { digest } from '../../core/identity.js';
import { objectRefSchema, type ObjectData } from '../../ontology/schema.js';
import { Functions, type FunctionContext, type FunctionHandler } from '../../runtime/functions.js';
import type { DidiConnector, DidiCallContext, DidiReadResult } from './connector.js';
import { didiDataSchema, didiReceiptSchema } from './contracts.js';

export interface DidiSource { bindingId: string; connector: DidiConnector; assertCurrent(): Promise<void> }
export type SourceResolver = (owner: string) => Promise<DidiSource>;
export const sourceResultSchema = z.strictObject({ data: didiDataSchema, receipt: didiReceiptSchema, evidence: z.enum(['live_readonly', 'provider_mock', 'fixture']) });
export type SourceResult = z.infer<typeof sourceResultSchema>;
const fresh = (time: unknown) => typeof time === 'string' && Number.isFinite(Date.parse(time)) && Date.now() - Date.parse(time) < 300000 && Date.parse(time) <= Date.now() + 5000;

async function endpoints(context: FunctionContext, route: unknown): Promise<[ObjectData, ObjectData]> {
  const ref = objectRefSchema.parse(route);
  await context.objects.read(ref);
  const [origin, destination] = await Promise.all([
    context.objects.follow(ref, 'origin', 'RideEstimatable'), context.objects.follow(ref, 'destination', 'RideEstimatable'),
  ]);
  if (origin.length !== 1 || destination.length !== 1) throw new Error('Route requires exactly one origin and destination');
  return [origin[0]!, destination[0]!];
}
async function locationsReady(context: FunctionContext, places: ObjectData[]) {
  for (const place of places) {
    if (!fresh(place.properties.observedAt)) return false;
    const sources = await context.objects.follow(place.ref, 'sources');
    if (!sources.some(source => source.properties.bindingId === place.properties.sourceBinding && source.properties.observedAt === place.properties.observedAt)) return false;
  }
  return true;
}
export function rideFunctions(resolveSource: SourceResolver) {
  const read = async (context: FunctionContext, tool: 'maps_textsearch' | 'taxi_estimate', input: Record<string, string>): Promise<SourceResult> => {
    const source = await resolveSource(context.principal.owner);
    await source.assertCurrent();
    const call: DidiCallContext = { requestId: context.taskId ?? randomUUID(), requestRevision: 1 };
    const result: DidiReadResult = await source.connector.invoke(call, tool, input, context.signal, () => source.assertCurrent());
    await source.assertCurrent();
    if (result.receipt.bindingId !== source.bindingId || result.receipt.inputDigest !== digest(input) || result.receipt.resultDigest !== digest(result.data) || result.receipt.tool !== tool) throw new Error('Source receipt does not match the invoked function');
    return sourceResultSchema.parse({ ...result, evidence: source.connector.evidenceKind });
  };
  return new Functions(new Map<string, FunctionHandler>([
    ['searchPlaces', async (input, context) => read(context, 'maps_textsearch', { city: String(input.city), keywords: String(input.keywords) })],
    ['estimateRoute', async (input, context) => {
      const request = objectRefSchema.parse(input.request);
      const routes = await context.objects.follow(request, 'route');
      if (routes.length !== 1) throw new Error('Estimate requires a request linked to one route');
      const [origin, destination] = await endpoints(context, routes[0]!.ref), source = await resolveSource(context.principal.owner);
      for (const place of [origin, destination]) if (place.properties.sourceBinding !== source.bindingId || !fresh(place.properties.observedAt)) throw new Error('Route requires current places from this source account');
      const from = origin.properties.coordinates as { lat: number; lng: number }, to = destination.properties.coordinates as { lat: number; lng: number };
      return read(context, 'taxi_estimate', { from_lng: String(from.lng), from_lat: String(from.lat), from_name: String(origin.properties.name), to_lng: String(to.lng), to_lat: String(to.lat), to_name: String(destination.properties.name) });
    }],
    ['locationsReady', async (input, context) => locationsReady(context, await Promise.all([input.origin, input.destination].map(ref => context.objects.read(objectRefSchema.parse(ref)))))],
    ['readRideEstimates', async (input, context) => {
      const request = objectRefSchema.parse(input.request);
      const binding = await resolveSource(context.principal.owner); await binding.assertCurrent();
      const root = await context.objects.read(request);
      const quotes = await context.objects.query({ type: 'PriceEstimate', from: { object: request, link: 'estimates' } });
      if (quotes.cursor || !quotes.items.length || root.properties.status !== 'quoted') throw new Error('Estimate result is incomplete');
      const evidence = new Set<string>();
      for (const quote of quotes.items) {
        if (Date.parse(String(quote.properties.expiresAt)) <= Date.now()) throw new Error('Estimate expired');
        const source = await context.objects.follow(quote.ref, 'source', 'PriceEstimate');
        if (source.length !== 1 || source[0]!.properties.bindingId !== binding.bindingId || !fresh(source[0]!.properties.observedAt)) throw new Error('Quote lacks current source evidence');
        evidence.add(String(source[0]!.properties.evidence));
      }
      const routes = await context.objects.follow(request, 'route');
      if (routes.length !== 1) throw new Error('Quote has no single route');
      const [origin, destination] = await endpoints(context, routes[0]!.ref);
      const estimates = quotes.items.filter(item => !input.serviceClass || item.properties.name === input.serviceClass);
      if (!estimates.length) throw new Error('No estimate for the selected service class');
      await binding.assertCurrent();
      return { request, estimates, evidence: [...evidence], accepted: evidence.size === 1 && evidence.has('live_readonly'), route: { origin: origin.properties, destination: destination.properties } };
    }],
  ]));
}
