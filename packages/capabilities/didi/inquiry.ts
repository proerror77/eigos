import { NotFound, SourceReadFailure } from '../../core/identity.js';
import { objectRefSchema, type ObjectData, type ObjectRef } from '../../ontology/schema.js';
import { CityConfirmationRequired, Clarification, PlaceConfirmationRequired, SourceRetryRequired } from '../../runtime/clarification.js';
import type { Functions, FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import type { Sources } from '../../runtime/sources.js';
import { isCurrentDidiObservation, type SourceResolver } from './functions.js';

type Resolution = { status: 'resolved'; origin: ObjectRef; destination: ObjectRef }
  | { status: 'input-required'; origin: ObjectData[]; destination: ObjectData[] };

// Normalize presentation only. Street numbers, entrances and distinct names remain distinct.
const matchName = (value: string) => value.normalize('NFKC').replace(/[\s·・]/gu, '').toLowerCase();

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

const cityKey = (city: unknown) => matchName(String(city ?? '')).replace(/市$/u, '');
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
  input: Record<string, unknown>, context: FunctionContext, landmarks: LandmarkReceipts = {}, city?: string,
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
    const matches = candidates.items.filter(item => {
      if (choice) return item.ref.type === choice.type && item.ref.id === choice.id;
      if (amendment?.address && !addressMatches(item, amendment.address)) return false;
      if (hint) {
        const label = siteName(item.properties.name, city);
        const related = label === abbreviation ||
          (abbreviation.length >= 3 && !amendment?.name && label.endsWith(abbreviation));
        return Boolean(abbreviation && related && anchors.length === 1 &&
          cityKey(item.properties.city) === cityKey(city) && withinLandmark(item, anchors[0]!));
      }
      return name ? matchName(String(item.properties.name)) === name : Boolean(amendment?.address);
    });
    const venues = hint && !choice && !amendment?.name
      ? matches.filter(place => !embeddedVenue(place, matches, city)) : matches;
    // A landmark recommends an address. Wait for explicit selection
    // before quoting a result that depends on the landmark.
    if (venues.length === 1 && (!hint || choice)) {
      return { selected: venues[0]!.ref, candidates: venues };
    }
    return { candidates: venues.length || (!choice && (hint || amendment?.address)) ? venues : candidates.items };
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
    return receipt.type === 'SourceReceipt' && proof.properties.tool === 'maps_textsearch' &&
      proof.properties.bindingId === bindingId && selected.properties.sourceBinding === bindingId &&
      isCurrentDidiObservation(proof.properties.observedAt) &&
      selected.properties.observedAt === proof.properties.observedAt;
  } catch (error) {
    if (error instanceof NotFound) return false;
    throw error;
  }
}

/** Implementation of the published edit Function backing the RideInquiry Action. */
export function prepareRideInquiry(getSources: () => Sources, getFunctions: () => Functions, resolveSource: SourceResolver): FunctionHandler {
  return async (input, context) => {
    if (!context.edit || !context.operationId) throw new Error('Ride inquiry requires an Action edit context');
    const model = context.objects.model, sources = getSources(), functions = getFunctions(), execution = context.execution;
    const selection = execution?.task.input.places;
    const resumed = resumedPlaceInput(context);
    const city = String(resumed?.rideCity ?? input.city ?? '').trim();
    if (!city) throw new CityConfirmationRequired();
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
        context.objects.access, execution?.task, execution?.tasks, context.signal).then(result => result.receipt);
      lookups.set(keywords, pending);
      return pending;
    };
    const findPlaces = async (role: Endpoint) => {
      const receipt = saved?.[role], place = selection?.[role];
      if (receipt && place && currentBinding && await reusablePlace(context, receipt, place, currentBinding)) return receipt;
      const amendment = resumed?.placeAmendments?.[role];
      const keywords = amendment?.name ?? amendment?.address ?? String(input[role]);
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
    const resolveInput = { origin: input.origin, destination: input.destination, originReceipt, destinationReceipt,
      ...(selection?.origin && selection.destination ? { selection } : {}) };
    // Landmark receipts are internal inputs to this Action, obtained from the same
    // source; the existing published read Function retains its original contract.
    let resolution: Resolution;
    if (originLandmark || destinationLandmark) {
      context.objects.access.function(model, 'resolveRideLocations');
      resolution = await resolvePlaces(resolveInput, context, { origin: originLandmark, destination: destinationLandmark }, city);
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
        { kind, origin, destination, needsAddress }, receipts);
    }
    const request = { type: 'RideRequest', id: context.operationId }, route = { type: 'Route', id: context.operationId };
    const quoteInput = { requestId: request.id, origin: resolution.origin, destination: resolution.destination };
    // All provider I/O finishes before opening the business edit transaction.
    const quote = await sources.read(model, 'DidiEstimates', quoteInput, context.objects.access,
      execution?.task, execution?.tasks, context.signal).catch(error => sourceFailed(error, 'estimate', receipts));
    const [origin, destination] = await Promise.all([context.objects.read(resolution.origin), context.objects.read(resolution.destination)]);
    return context.edit(request, async graph => {
      await graph.create(route, { id: route.id, name: `${origin.properties.name} → ${destination.properties.name}` });
      await graph.create(request, { id: request.id, name: 'Ride estimate request', status: 'requested',
        requestedAt: execution?.task.created_at.toISOString() ?? new Date().toISOString(), ...(input.serviceClass ? { serviceClass: input.serviceClass } : {}) });
      await graph.linkBatch([{ type: 'RouteOrigin', from: route, to: origin.ref }, { type: 'RouteDestination', from: route, to: destination.ref }, { type: 'RequestRoute', from: request, to: route }]);
      await sources.project(graph, 'DidiEstimates', quoteInput, quote, context.signal);
    });
  };
}
