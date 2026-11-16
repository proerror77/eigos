import { Conflict, NotFound, SourceReadFailure, digest } from '../../core/identity.js';
import { objectRefSchema, type ObjectData, type ObjectRef } from '../../ontology/schema.js';
import { ActionPARequestRequired, CityConfirmationRequired, Clarification, PARequestRequired, PlaceConfirmationRequired, RideEndpointRequired, SourceRetryRequired } from '../../runtime/clarification.js';
import { ridePickupResult } from '../../ontology/maps.js';
import type { Functions, FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { PermissionDenied } from '../../runtime/access.js';
import type { Sources } from '../../runtime/sources.js';
import { isCurrentDidiObservation, sourceResultSchema, verifiedDidiRead, type SourceResolver } from './functions.js';
import { DidiReadError } from './connector.js';
import { readDidiDriving } from './driving.js';

type Resolution = { status: 'resolved'; origin: ObjectRef; destination: ObjectRef }
  | { status: 'input-required'; origin: ObjectData[]; destination: ObjectData[] };

// Normalize presentation only. Street numbers, entrances and distinct names remain distinct.
const matchName = (value: string) => value.normalize('NFKC').replace(/[\s·・]/gu, '').toLowerCase();

const buildingEndings = ['大厦', '大楼'];
function expandedBuildingName(short: string, official: string) {
  return short.length >= 3 && !buildingEndings.some(ending => short.endsWith(ending)) &&
    buildingEndings.some(ending => official === short + ending);
}

function resumedPlaceInput(context: FunctionContext) {
  const task = context.execution?.task;
  if (task && context.operationId && task.input.placeContinuation?.requestId === context.operationId) return task.input;
}

function addressMatches(place: ObjectData, address: string) {
  const expected = matchName(address);
  if (expected.length < 5) return false;
  const observed = matchName(String(place.properties.address ?? ''));
  if (!observed) return false;
  const city = matchName(String(place.properties.city ?? ''));
  // A city may be stored as a separate field on the provider place.
  const match = (value: string) => {
    const start = value.indexOf(expected);
    if (start < 0) return false;
    const end = start + expected.length;
    return !/\d$/u.test(expected) || !/\d/u.test(value[end] ?? '');
  };
  return match(observed) || match(city + observed);
}

type Endpoint = 'origin' | 'destination';
type LandmarkReceipts = Partial<Record<Endpoint, { name: string; receipt: ObjectRef }>>;
type AddressClues = Partial<Record<Endpoint, string>>;

function quoteEndpoint(actionName: string, submittedName: string | undefined, message: string) {
  if (!submittedName) return { name: actionName };
  const submitted = submittedName.trim();
  if (matchName(actionName) === matchName(submitted)) return { name: submitted };
  const decorated = actionName.normalize('NFKC').match(/^(.+)\(([^()]+)\)$/u);
  if (!decorated || matchName(decorated[1]!) !== matchName(submitted) || !/\d+[弄号]/u.test(decorated[2]!)) {
    return { name: actionName };
  }
  const address = decorated[2]!.trim();
  // A model-added suffix may explain a search, but only a submitted address can select between equal names.
  return { name: submitted, address: matchName(message).includes(matchName(address)) ? address : undefined };
}

const cityKey = (city: unknown) => matchName(String(city ?? '')).replace(/市$/u, '');
const municipalityPrefixes = new Set(['11', '12', '31', '50']);
const pickupEvidenceFrom = ({ provider, fetchedAt, inputCoordinateSystem, coordinateSystem, conversion }:
  ReturnType<typeof ridePickupResult.parse>) => ({ provider, fetchedAt, inputCoordinateSystem, coordinateSystem, conversion });
const siteName = (name: unknown, city: unknown) => {
  const label = matchName(String(name ?? '')), prefix = cityKey(city);
  return prefix && label.startsWith(prefix) ? label.slice(prefix.length).replace(/^市/u, '') : label;
};

function withinLandmark(place: ObjectData, landmark: ObjectData) {
  const { coordinates: a, coordinateSystem: system } = place.properties;
  const { coordinates: b, coordinateSystem: anchorSystem } = landmark.properties;
  if (!a || !b || !system || system !== anchorSystem) return false;
  // Both points came from the same bound DiDi place source. Use only a coarse
  // distance gate within that source; quote coordinates remain unmodified.
  const { lat, lng } = a as {lat: number; lng: number};
  const other = b as {lat: number; lng: number};
  if (![lat, lng, other.lat, other.lng].every(Number.isFinite)) return false;
  const east = (lng - other.lng) * Math.cos((lat + other.lat) * Math.PI / 360);
  return Math.hypot(east, lat - other.lat) * 111_200 <= 800;
}

function embeddedVenue(place: ObjectData, venues: ObjectData[], city: string | undefined) {
  const segments = String(place.properties.name).split(/[·・|]/u);
  if (segments.length < 2) return false;
  const namedVenue = siteName(segments[segments.length - 1], city);
  const streetNumber = (item: ObjectData) => siteName(item.properties.address, city).match(/^.+?\d+(?:弄|号)/u)?.[0];
  const address = streetNumber(place);
  // A shop may include its parent venue after a separator. Suppress that
  // incidental match only when the source also names the parent at that address.
  return Boolean(namedVenue && address && venues.some(other => other !== place &&
    siteName(other.properties.name, city) === namedVenue && streetNumber(other) === address));
}

async function resolvePlaces(
  input: Record<string, unknown>, context: FunctionContext,
  { landmarks = {}, addresses = {}, city, pickupAddress }: {
    landmarks?: LandmarkReceipts; addresses?: AddressClues; city?: string; pickupAddress?: string;
  } = {},
): Promise<Resolution> {
  const resumed = resumedPlaceInput(context);
  const selection = input.selection as { origin: ObjectRef; destination: ObjectRef } | undefined;
  const places = (receipt: ObjectRef) => context.objects.query({
    type: 'Location', from: { object: receipt, link: 'places' }, limit: 100,
  });
  const find = async (role: Endpoint) => {
    const receipt = objectRefSchema.parse(input[role + 'Receipt']);
    const choice = selection?.[role] ?? resumed?.places?.[role];
    const amendment = resumed?.placeAmendments?.[role];
    const hint = landmarks[role];
    const [candidates, nearby] = await Promise.all([places(receipt), hint && places(hint.receipt)]);
    if (candidates.cursor) throw new Clarification('地点候选过多，请补充完整地址。');
    const anchors = !nearby?.cursor && hint ? nearby?.items.filter(item =>
      cityKey(item.properties.city) === cityKey(city) &&
      siteName(item.properties.name, city) === siteName(hint.name, city)) ?? [] : [];
    const rawName = amendment?.name ?? String(input[role]);
    const name = amendment?.address && !amendment.name && !hint ? '' : matchName(rawName);
    const abbreviation = hint ? siteName(rawName, city) : '';
    const allowBuildingExpansion = !hint && !amendment && !choice;
    const matches = candidates.items.filter(item => {
      if (choice) return item.ref.type === choice.type && item.ref.id === choice.id;
      if (role === 'origin' && pickupAddress && !amendment)
        return cityKey(item.properties.city) === cityKey(city) &&
          (addressMatches(item, pickupAddress) || matchName(String(item.properties.name)) === matchName(pickupAddress));
      if (amendment?.address && !addressMatches(item, amendment.address)) return false;
      if (hint) {
        const label = siteName(item.properties.name, city);
        const related = label === abbreviation ||
          (abbreviation.length >= 3 && !amendment?.name && label.endsWith(abbreviation));
        return Boolean(abbreviation && related && anchors.length === 1 &&
          cityKey(item.properties.city) === cityKey(city) && withinLandmark(item, anchors[0]!));
      }
      if (!name) return Boolean(amendment?.address);
      const label = matchName(String(item.properties.name));
      return label === name || (allowBuildingExpansion && expandedBuildingName(name, label));
    });
    const venues = hint && !choice && !amendment?.name
      ? matches.filter(place => !embeddedVenue(place, matches, city)) : matches;
    const address = !choice && !amendment && !hint && addresses[role];
    const byAddress = address && venues.length > 1 ? venues.filter(place =>
      cityKey(place.properties.city) === cityKey(city) && addressMatches(place, address)) : [];
    const eligible = byAddress.length ? byAddress : venues;
    if (eligible.length === 1) {
      const venue = eligible[0]!;
      const expanded = allowBuildingExpansion && expandedBuildingName(name, matchName(String(venue.properties.name)));
      // An abbreviated name or landmark recommends a venue, but only an
      // explicit selection authorizes the quote for that recommendation.
      if ((!hint || choice) && !expanded) return { selected: venue.ref, candidates: eligible };
    }
    return { candidates: eligible.length || (!choice && (hint || amendment?.address)) ? eligible : candidates.items };
  };
  const [origin, destination] = await Promise.all([find('origin'), find('destination')]);
  return origin.selected && destination.selected ? { status: 'resolved', origin: origin.selected, destination: destination.selected }
    : { status: 'input-required', origin: origin.candidates, destination: destination.candidates };
}

export const resolveRideLocations: FunctionHandler = (input, context) => resolvePlaces(input, context);

/** A confirmed ref can reuse only the task's exact, still current place observation. */
async function reusablePlace(
  context: FunctionContext, receipt: ObjectRef, place: ObjectRef, bindingId: string,
): Promise<boolean> {
  try {
    const [proof, selected] = await Promise.all([context.objects.read(receipt), context.objects.read(place)]);
    return receipt.type === 'SourceReceipt' && ['maps_textsearch', 'maps_place_around'].includes(String(proof.properties.tool)) &&
      proof.properties.bindingId === bindingId && selected.properties.sourceBinding === bindingId &&
      isCurrentDidiObservation(proof.properties.observedAt) &&
      selected.properties.observedAt === proof.properties.observedAt;
  } catch (error) {
    if (error instanceof NotFound) return false;
    throw error;
  }
}

async function refreshNearbyQuotePlace(sources: Sources, resolveSource: SourceResolver, context: FunctionContext,
  city: string, keywords: string) {
  const { model, access } = context.objects, execution = context.execution;
  sources.checkReadAccess(model, 'DidiPlaces', access);
  const source = await resolveSource(context.principal.owner);
  const saved = await context.objects.query({
    type: 'Place', where: { name: keywords, sourceBinding: source.bindingId }, limit: 10,
  });
  const seeds = saved.items.filter(place => cityKey(place.properties.city) === cityKey(city));
  if (saved.cursor || seeds.length !== 1) return;
  const seed = seeds[0]!;
  const history = await context.objects.query({ type: 'SourceReceipt', from: { object: seed.ref, link: 'sources' },
    where: { tool: 'maps_textsearch', bindingId: source.bindingId, evidence: source.connector.evidenceKind }, limit: 1 });
  if (!history.items.length) return;
  const coordinate = seed.properties.coordinates as { lng: number; lat: number } | undefined;
  if (!coordinate || !Number.isFinite(coordinate.lng) || !Number.isFinite(coordinate.lat)) return;
  const input = { keywords, location: `${coordinate.lng},${coordinate.lat}`, max_distance: '500' };
  const read = () => verifiedDidiRead(source, context, 'maps_place_around', input, async () => {
    sources.checkReadAccess(model, 'DidiPlaces', access);
    if (execution) await execution.tasks.current(execution.task);
  });
  const result = sourceResultSchema.parse(execution ? await execution.tasks.readSource(execution.task,
    digest({ source: 'DidiPlaces', tool: 'maps_place_around', input, binding: source.bindingId, step: execution.task.execution_step ?? 0 }), input, read) : await read());
  if (result.data.kind !== 'places' || result.receipt.bindingId !== source.bindingId ||
      result.receipt.tool !== 'maps_place_around' || !isCurrentDidiObservation(result.receipt.receivedAt)) return;
  const matches = result.data.places.filter(place => matchName(place.name) === matchName(keywords) &&
    cityKey(place.city) === cityKey(city) && place.lng === coordinate.lng && place.lat === coordinate.lat);
  if (matches.length !== 1) return;
  return (await sources.publishRead(model, 'DidiPlaces',
    { exactPlaceId: matches[0]!.id, savedPlace: seed.ref, keywords }, result,
    access, execution?.task, execution?.tasks, context.signal)).receipt;
}

/** Implementation of the published edit Function backing the RideInquiry Action. */
export function prepareRideInquiry(getSources: () => Sources, getFunctions: () => Functions, resolveSource: SourceResolver,
  interactivePickup = false): FunctionHandler {
  return async (input, context) => {
    if (!context.edit || !context.operationId) throw new Error('Ride inquiry requires an Action edit context');
    const model = context.objects.model, sources = getSources(), functions = getFunctions(), execution = context.execution;
    const selection = execution?.task.input.places;
    const resumed = resumedPlaceInput(context);
    let city = String(resumed?.rideCity ?? input.city ?? '').trim();
    let originName = String(resumed?.rideOrigin ?? input.origin ?? '').trim();
    const destinationName = String(resumed?.rideDestination ?? input.destination ?? '').trim();
    if (interactivePickup && !destinationName)
      throw new RideEndpointRequired('destination', '你要去哪里？请提供目的地名称或地址。');
    let pickup: ReturnType<typeof ridePickupResult.parse> | undefined;
    if (interactivePickup && !originName && !resumed?.placeAmendments?.origin) {
      if (selection?.origin) {
        const selected = await context.objects.read(selection.origin);
        originName = String(selected.properties.name);
        city ||= String(selected.properties.city);
      } else if (typeof input.originLandmark === 'string' && input.originLandmark.trim()) {
        originName = input.originLandmark.trim();
        input = { ...input, originLandmark: undefined };
      } else {
        if (!execution) throw new Clarification('请通过原 PA 任务请求当前手机定位，或提供明确的上车点。');
        try {
          pickup = ridePickupResult.parse(await functions.invoke(model, 'resolveRidePickup', {}, context));
        } catch (error) {
          if (error instanceof PARequestRequired) throw new ActionPARequestRequired(error.message, error.choices, error.permissions);
          if (error instanceof Clarification || error instanceof Conflict || error instanceof PermissionDenied)
            throw new RideEndpointRequired('origin', '无法使用这次手机定位，请提供明确的上车点或地址。');
          throw error;
        }
        const pickupCity = pickup.city ?? (municipalityPrefixes.has(pickup.adcode?.slice(0, 2) ?? '') ? pickup.province : undefined);
        if (city && pickupCity && cityKey(city) !== cityKey(pickupCity))
          throw new RideEndpointRequired('origin', '手机定位与指定城市不一致，请确认上车点。');
        city ||= pickupCity ?? '';
        originName = pickup.address;
      }
    }
    if (!city) throw new CityConfirmationRequired();
    const submitted = execution?.task.input.route;
    const structuredRoute = submitted && cityKey(submitted.city) === cityKey(city) ? submitted : undefined;
    const message = execution?.task.input.message ?? '';
    const originEndpoint = quoteEndpoint(originName, pickup || resumed?.rideOrigin ? undefined : structuredRoute?.origin, message);
    const destinationEndpoint = quoteEndpoint(destinationName, resumed?.rideDestination ? undefined : structuredRoute?.destination, message);
    const endpoints = { origin: originEndpoint.name, destination: destinationEndpoint.name };
    const addresses = { origin: originEndpoint.address, destination: destinationEndpoint.address };
    const pickupEvidence = pickup ? pickupEvidenceFrom(pickup) :
      selection?.origin && !resumed?.placeAmendments?.origin ? resumed?.placeContinuation?.pickup : undefined;
    const saved = resumed?.placeContinuation?.receipts;
    let currentBinding: string | undefined;
    if (saved) {
      sources.checkReadAccess(model, 'DidiPlaces', context.objects.access);
      const source = await resolveSource(context.principal.owner);
      await source.assertCurrent();
      currentBinding = source.bindingId;
    }
    const lookups = new Map<string, Promise<ObjectRef>>();
    const lookup = (keywords: string) => {
      const existing = lookups.get(keywords);
      if (existing) return existing;
      const pending = sources.refresh(model, 'DidiPlaces', { city, keywords },
        context.objects.access, execution?.task, execution?.tasks, context.signal).then(result => result.receipt).catch(async error => {
        if (!(error instanceof DidiReadError) || error.code !== 'RATE_LIMITED') throw error;
        const fallback = await refreshNearbyQuotePlace(sources, resolveSource, context, city, keywords).catch(failure => {
          if (failure instanceof SourceReadFailure) return undefined;
          throw failure;
        });
        if (!fallback) throw error;
        return fallback;
      });
      lookups.set(keywords, pending);
      return pending;
    };
    const findPlaces = async (role: Endpoint) => {
      const receipt = saved?.[role], place = selection?.[role];
      if (receipt && place && currentBinding && await reusablePlace(context, receipt, place, currentBinding)) return receipt;
      const amendment = resumed?.placeAmendments?.[role];
      const keywords = amendment?.name ?? amendment?.address ?? endpoints[role];
      return lookup(keywords);
    };
    const findLandmark = async (role: Endpoint) => {
      if (selection?.[role]) return;
      const clue = resumed?.placeAmendments?.[role];
      const name = clue ? clue.landmark : input[role + 'Landmark'];
      if (typeof name === 'string' && name.trim()) return { name, receipt: await lookup(name.trim()) };
    };
    const sourceFailed = async (error: unknown, stage: 'places' | 'estimate', receipts = saved): Promise<never> => {
      if (!(error instanceof SourceReadFailure)) throw error;
      context.signal.throwIfAborted();
      await context.objects.access.refresh();
      throw new SourceRetryRequired(stage, receipts);
    };
    const pendingReads = [findPlaces('origin'), findPlaces('destination'),
      findLandmark('origin'), findLandmark('destination')] as const;
    const [originReceipt, destinationReceipt, originLandmark, destinationLandmark] =
      await Promise.all(pendingReads).catch(async error => {
        // Finish other scoped reads before persisting the paused state.
        await Promise.allSettled(pendingReads);
        return sourceFailed(error, 'places');
      });
    const resolveInput = { ...endpoints, originReceipt, destinationReceipt,
      ...(selection?.origin && selection.destination ? { selection } : {}) };
    // Landmark receipts are internal inputs to this Action, obtained from the same
    // source; the existing published read Function retains its original contract.
    let resolution: Resolution;
    if (originLandmark || destinationLandmark || pickup || addresses.origin || addresses.destination) {
      context.objects.access.function(model, 'resolveRideLocations');
      resolution = await resolvePlaces(resolveInput, context, {
        landmarks: { origin: originLandmark, destination: destinationLandmark }, addresses, city, pickupAddress: pickup?.address,
      });
    } else {
      resolution = await functions.invoke(model, 'resolveRideLocations', resolveInput, context) as Resolution;
    }
    const receipts = { origin: originReceipt, destination: destinationReceipt };
    if (resolution.status !== 'resolved') {
      const { origin, destination } = resolution;
      const needsAddress = (['origin', 'destination'] as const).filter(side => !resolution[side].length);
      const kind = needsAddress.length ? 'place-address-required' : 'place-selection';
      throw new PlaceConfirmationRequired(
        needsAddress.length ? '未找到该地点，请补充更完整的地址。' : '请选择或确认候选地点的正式名称和地址。',
        { kind, origin, destination, needsAddress, ...(pickupEvidence ? { pickup: pickupEvidence } : {}) }, receipts, pickupEvidence);
    }
    const request = { type: 'RideRequest', id: context.operationId }, route = { type: 'Route', id: context.operationId };
    const quoteInput = { requestId: request.id, origin: resolution.origin, destination: resolution.destination };
    // All provider I/O finishes before opening the business edit transaction.
    const quote = await sources.read(model, 'DidiEstimates', quoteInput, context.objects.access,
      execution?.task, execution?.tasks, context.signal).catch(error => sourceFailed(error, 'estimate', receipts));
    const [origin, destination] = await Promise.all([context.objects.read(resolution.origin), context.objects.read(resolution.destination)]);
    const drivingEstimate = interactivePickup && model.objects.get('Route')?.properties.drivingEstimate
      ? await readDidiDriving(resolveSource, origin, destination, context).catch(error => {
        if (!(error instanceof SourceReadFailure)) throw error;
        context.signal.throwIfAborted();
        return null;
      }) : undefined;
    return context.edit(request, async graph => {
      await graph.create(route, { id: route.id, name: `${origin.properties.name} → ${destination.properties.name}`,
        ...(drivingEstimate !== undefined ? { drivingEstimate } : {}), ...(pickupEvidence ? { pickup: pickupEvidence } : {}) });
      await graph.create(request, { id: request.id, name: 'Ride estimate request', status: 'requested',
        requestedAt: execution?.task.created_at.toISOString() ?? new Date().toISOString(), ...(input.serviceClass ? { serviceClass: input.serviceClass } : {}) });
      await graph.linkBatch([{ type: 'RouteOrigin', from: route, to: origin.ref }, { type: 'RouteDestination', from: route, to: destination.ref }, { type: 'RequestRoute', from: request, to: route }]);
      await sources.project(graph, 'DidiEstimates', quoteInput, quote, context.signal);
    });
  };
}
