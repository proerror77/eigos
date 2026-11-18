import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OntologyDocument } from '../../ontology/schema.js';
import { Conflict, digest } from '../../core/identity.js';
import { objectRefSchema, type ObjectData } from '../../ontology/schema.js';
import { Functions, type FunctionContext, type FunctionHandler, type VersionedFunction } from '../../runtime/functions.js';
import type { DidiConnector, DidiCallContext, DidiReadResult } from './connector.js';
import { didiDataSchema, didiReceiptSchema } from './contracts.js';
import type { RideOrders } from './operations.js';
import type { DidiTool } from './contracts.js';
import { didiAppLinkInput, didiMapRouteInput, didiNearbyInput, didiReverseInput } from '../../ontology/didi-reads.js';

export interface DidiSource { bindingId: string; authorityId?:string; connector: DidiConnector; orders?:RideOrders; assertCurrent(): Promise<void> }
export type SourceResolver = (owner: string, order?: { bindingId: string; orderId: string }) => Promise<DidiSource>;
export const sourceResultSchema = z.strictObject({ data: didiDataSchema, receipt: didiReceiptSchema, evidence: z.enum(['live_readonly', 'provider_mock', 'fixture']) });
export type SourceResult = z.infer<typeof sourceResultSchema>;
export const isCurrentDidiObservation = (time: unknown) => typeof time === 'string' && Number.isFinite(Date.parse(time)) && Date.now() - Date.parse(time) < 300000 && Date.parse(time) <= Date.now() + 5000;

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
    if (!isCurrentDidiObservation(place.properties.observedAt)) return false;
    const { sourceBinding, observedAt } = place.properties;
    if (typeof sourceBinding !== 'string' || typeof observedAt !== 'string') return false;
    const { items } = await context.objects.query({
      type: 'SourceReceipt', from: { object: place.ref, link: 'sources' },
      where: { bindingId: sourceBinding, observedAt }, limit: 1,
    });
    if (!items.length) return false;
  }
  return true;
}
export async function verifiedDidiRead(source: DidiSource, context: FunctionContext, tool: DidiTool,
  input: Record<string, unknown>, guard?: () => Promise<void>): Promise<SourceResult> {
  await source.assertCurrent();
  const call: DidiCallContext = { requestId: context.taskId ?? randomUUID(), requestRevision: 1 };
  const result: DidiReadResult = await source.connector.invoke(call, tool, input, context.signal, async () => {
    await context.objects.access.refresh();
    await guard?.();
    await source.assertCurrent();
  });
  await source.assertCurrent();
  if (result.receipt.bindingId !== source.bindingId || result.receipt.inputDigest !== digest(input) ||
      result.receipt.resultDigest !== digest(result.data) || result.receipt.tool !== tool)
    throw new Error('Source receipt does not match the invoked function');
  return sourceResultSchema.parse({ ...result, evidence: source.connector.evidenceKind });
}

export function rideFunctions(resolveSource: SourceResolver, additional: ReadonlyMap<string, FunctionHandler> = new Map(), definitions?: OntologyDocument['functionTypes'], versions: readonly VersionedFunction[] = []) {
  const read = async (context: FunctionContext, tool: 'maps_textsearch' | 'taxi_estimate', input: Record<string, string>) => {
    const source = await resolveSource(context.principal.owner);
    return verifiedDidiRead(source, context, tool, input);
  };
  const readEstimates = (includeRouteEvidence: boolean): FunctionHandler => async (input, context) => {
    const request = objectRefSchema.parse(input.request);
    const binding = await resolveSource(context.principal.owner); await binding.assertCurrent();
    const root = await context.objects.read(request);
    const quotes = await context.objects.query({ type: 'PriceEstimate', from: { object: request, link: 'estimates' } });
    if (quotes.cursor || !quotes.items.length || root.properties.status !== 'quoted') throw new Error('Estimate result is incomplete');
    const evidence = new Set<string>();
    for (const quote of quotes.items) {
      if (Date.parse(String(quote.properties.expiresAt)) <= Date.now()) throw new Error('Estimate expired');
      const source = await context.objects.follow(quote.ref, 'source', 'PriceEstimate');
      if (source.length !== 1 || source[0]!.properties.bindingId !== binding.bindingId || !isCurrentDidiObservation(source[0]!.properties.observedAt)) throw new Error('Quote lacks current source evidence');
      evidence.add(String(source[0]!.properties.evidence));
    }
    const routes = await context.objects.follow(request, 'route');
    if (routes.length !== 1) throw new Error('Quote has no single route');
    const [origin, destination] = await endpoints(context, routes[0]!.ref);
    const serviceClass = input.serviceClass ?? root.properties.serviceClass;
    const estimates = quotes.items.filter(item => !serviceClass || item.properties.name === serviceClass);
    if (!estimates.length) throw new Error('No estimate for the selected service class');
    await binding.assertCurrent();
    const { pickup, drivingEstimate } = includeRouteEvidence ? routes[0]!.properties : {};
    const currentDrive = drivingEstimate && Date.parse(String((drivingEstimate as Record<string, unknown>).expiresAt)) > Date.now();
    return { request, estimates, evidence: [...evidence], accepted: evidence.size === 1 && evidence.has('live_readonly'),
      route: { origin: origin.properties, destination: destination.properties, ...(pickup ? { pickup } : {}),
        ...(drivingEstimate !== undefined ? { drivingEstimate: currentDrive ? drivingEstimate : null } : {}) } };
  };
  const stamp = (result: SourceResult) => ({
    provider: 'Didi', evidence: result.evidence, observedAt: result.receipt.receivedAt, receiptDigest: digest(result.receipt),
  });
  const coordinatePair = (point: { longitude: number; latitude: number }) => `${point.longitude},${point.latitude}`;
  const providerMaps = {
    walking: 'maps_direction_walking', bicycling: 'maps_direction_bicycling', transit: 'maps_direction_transit',
  } as const;
  return new Functions(new Map<string, FunctionHandler>([
    ['generateDidiRideAppLink', async (input, context) => {
      const { request, estimate } = didiAppLinkInput.parse(input);
      if (request.type !== 'RideRequest') throw new Conflict('Use the resolved ride inquiry');
      const requestRow = await context.objects.read(request);
      const routes = await context.objects.follow(request, 'route');
      if (requestRow.properties.status !== 'quoted' || routes.length !== 1)
        throw new Conflict('Resolve and quote the ride first');
      const source = await resolveSource(context.principal.owner);
      const places = await endpoints(context, routes[0]!.ref);
      if (places.some(place => place.properties.sourceBinding !== source.bindingId) || !await locationsReady(context, places))
        throw new Conflict('Refresh the DiDi quote endpoints');
      const [from, to] = places.map(place => place.properties.coordinates as { lng: number; lat: number });
      const args: Record<string, string> = {
        from_lng: String(from!.lng), from_lat: String(from!.lat), to_lng: String(to!.lng), to_lat: String(to!.lat),
      };
      const serviceClass = requestRow.properties.serviceClass;
      if (estimate || serviceClass) {
        if (estimate && estimate.type !== 'RideEstimate') throw new Conflict('Use the selected quote from this ride');
        const rows = await context.objects.follow(request, 'estimates');
        const matches = rows.filter(row => estimate ? row.ref.id === estimate.id && row.ref.type === estimate.type
          : row.properties.name === serviceClass);
        if (matches.length !== 1) throw new Conflict('Use a current quote from this ride');
        const selected = matches[0]!;
        if (serviceClass && selected.properties.name !== serviceClass) throw new Conflict('The quote differs from the requested vehicle');
        const category = selected?.properties.productCategory;
        if (typeof category !== 'string' || !category ||
            !isCurrentDidiObservation(selected?.properties.observedAt) || Date.parse(String(selected?.properties.expiresAt)) <= Date.now())
          throw new Conflict('Use a current quote from this ride');
        const receipts = await context.objects.follow(selected.ref, 'source', 'PriceEstimate');
        if (receipts.length !== 1 || receipts[0]!.properties.bindingId !== source.bindingId)
          throw new Conflict('Selected quote source does not match the DiDi connection');
        args.product_category = category;
      }
      const result = await verifiedDidiRead(source, context, 'taxi_generate_ride_app_link', args);
      if (result.data.kind !== 'app_links') throw new Conflict('DiDi ride link evidence is unavailable');
      return { ...stamp(result), ...result.data.links };
    }],
    ['reverseGeocodeDidi', async (input, context) => {
      const { point } = didiReverseInput.parse(input);
      const source = await resolveSource(context.principal.owner);
      const result = await verifiedDidiRead(source, context, 'maps_regeocode', { location: coordinatePair(point) });
      if (result.data.kind !== 'address') throw new Conflict('DiDi address evidence is unavailable');
      return { ...stamp(result), ...result.data.address, point };
    }],
    ['searchDidiNearbyPlaces', async (input, context) => {
      const { point, query, radiusMeters } = didiNearbyInput.parse(input);
      const source = await resolveSource(context.principal.owner);
      const result = await verifiedDidiRead(source, context, 'maps_place_around', {
        location: coordinatePair(point), keywords: query, max_distance: String(radiusMeters),
      });
      if (result.data.kind !== 'places') throw new Conflict('DiDi place evidence is unavailable');
      return { ...stamp(result), places: result.data.places.map(place => ({
        name: place.name, address: place.addressAll || place.address, city: place.city,
        point: { latitude: place.lat, longitude: place.lng, coordinateSystem: place.coordinateSystem },
      })) };
    }],
    ['estimateDidiMapRoute', async (input, context) => {
      const { origin, destination, mode, ...options } = didiMapRouteInput.parse(input);
      if (origin.coordinateSystem !== destination.coordinateSystem) throw new Conflict('Use the same coordinate system for both endpoints');
      const source = await resolveSource(context.principal.owner);
      const result = await verifiedDidiRead(source, context, providerMaps[mode], {
        origin: coordinatePair(origin), destination: coordinatePair(destination),
        ...('city' in options ? { city: options.city } : { need_geo: false }),
      });
      if (result.data.kind !== 'map_routes') throw new Conflict('DiDi route evidence is unavailable');
      return { ...stamp(result), mode, routes: result.data.routes };
    }],
    ['searchPlaces', async (input, context) => read(context, 'maps_textsearch', { city: String(input.city), keywords: String(input.keywords) })],
    ['estimateRoute', async (input, context) => {
      const request = objectRefSchema.parse(input.request);
      const routes = await context.objects.follow(request, 'route');
      if (routes.length !== 1) throw new Error('Estimate requires a request linked to one route');
      const [origin, destination] = await endpoints(context, routes[0]!.ref), source = await resolveSource(context.principal.owner);
      for (const place of [origin, destination]) if (place.properties.sourceBinding !== source.bindingId || !isCurrentDidiObservation(place.properties.observedAt)) throw new Error('Route requires current places from this source account');
      const from = origin.properties.coordinates as { lat: number; lng: number }, to = destination.properties.coordinates as { lat: number; lng: number };
      return read(context, 'taxi_estimate', { from_lng: String(from.lng), from_lat: String(from.lat), from_name: String(origin.properties.name), to_lng: String(to.lng), to_lat: String(to.lat), to_name: String(destination.properties.name) });
    }],
    ['estimateLocations', async (input, context) => {
      const [origin, destination] = await Promise.all([input.origin, input.destination].map(ref => context.objects.read(objectRefSchema.parse(ref))));
      const source = await resolveSource(context.principal.owner);
      for (const place of [origin!, destination!]) {
        if (!context.objects.model.implements(place.ref.type, 'Location') || place.properties.sourceBinding !== source.bindingId || !isCurrentDidiObservation(place.properties.observedAt)) throw new Error('Estimate requires current source Location objects');
      }
      const from = origin!.properties.coordinates as { lat: number; lng: number }, to = destination!.properties.coordinates as { lat: number; lng: number };
      return read(context, 'taxi_estimate', { from_lng: String(from.lng), from_lat: String(from.lat), from_name: String(origin!.properties.name), to_lng: String(to.lng), to_lat: String(to.lat), to_name: String(destination!.properties.name) });
    }],
    ['locationsReady', async (input, context) => locationsReady(context, await Promise.all([input.origin, input.destination].map(ref => context.objects.read(objectRefSchema.parse(ref)))))],
    ['readRideEstimates', readEstimates(false)],
    ['readInteractiveRideEstimate', readEstimates(true)],
    ...additional,
  ]), definitions ?? (JSON.parse(readFileSync(new URL('../../ontology/definitions/ride.json', import.meta.url), 'utf8')) as OntologyDocument).functionTypes, versions);
}
