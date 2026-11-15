import { NotFound } from '../../core/identity.js';
import { objectRefSchema, type ObjectData, type ObjectRef } from '../../ontology/schema.js';
import { Clarification, PlaceConfirmationRequired } from '../../runtime/clarification.js';
import type { Functions, FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import type { Sources } from '../../runtime/sources.js';
import { isCurrentDidiObservation, type SourceResolver } from './functions.js';

type Resolution = { status: 'resolved'; origin: ObjectRef; destination: ObjectRef }
  | { status: 'input-required'; origin: ObjectData[]; destination: ObjectData[] };

// Normalize presentation only. Street numbers, entrances and distinct names remain distinct.
const matchName = (value: string) => value.normalize('NFKC').replace(/[\s·・]/gu, '').toLowerCase();

export const resolveRideLocations: FunctionHandler = async (input, context): Promise<Resolution> => {
  const selection = input.selection as { origin: ObjectRef; destination: ObjectRef } | undefined;
  const find = async (role: 'origin' | 'destination') => {
    const receipt = objectRefSchema.parse(input[role + 'Receipt']), choice = selection?.[role];
    const candidates = await context.objects.query({ type: 'Location', from: { object: receipt, link: 'places' }, limit: 100 });
    if (candidates.cursor) throw new Clarification('地点候选过多，请补充完整地址。');
    const name = matchName(String(input[role]));
    const matches = candidates.items.filter(item => choice
      ? item.ref.type === choice.type && item.ref.id === choice.id
      : name && matchName(String(item.properties.name)) === name);
    if (matches.length === 1) return { selected: matches[0]!.ref, candidates: matches };
    return { candidates: matches.length ? matches : candidates.items };
  };
  const [origin, destination] = await Promise.all([find('origin'), find('destination')]);
  return origin.selected && destination.selected ? { status: 'resolved', origin: origin.selected, destination: destination.selected }
    : { status: 'input-required', origin: origin.candidates, destination: destination.candidates };
};

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
    const pending = execution?.task.input.placeContinuation;
    const saved = pending?.requestId === context.operationId && selection ? pending.receipts : undefined;
    let currentBinding: string | undefined;
    if (saved) {
      sources.checkReadAccess(model, 'DidiPlaces', context.objects.access);
      const source = await resolveSource(context.principal.owner);
      await source.assertCurrent();
      currentBinding = source.bindingId;
    }
    const findPlaces = async (role: 'origin' | 'destination') => {
      const receipt = saved?.[role], place = selection?.[role];
      if (receipt && place && currentBinding && await reusablePlace(context, receipt, place, currentBinding)) return receipt;
      const result = await sources.refresh(model, 'DidiPlaces', { city: input.city, keywords: input[role] },
        context.objects.access, execution?.task, execution?.tasks, context.signal);
      return result.receipt;
    };
    const [originReceipt, destinationReceipt] = await Promise.all([findPlaces('origin'), findPlaces('destination')]);
    const resolution = await functions.invoke(model, 'resolveRideLocations', {
      origin: input.origin, destination: input.destination, originReceipt, destinationReceipt,
      ...(selection ? { selection } : {}),
    }, context) as Resolution;
    if (resolution.status !== 'resolved') {
      throw new PlaceConfirmationRequired('请确认未能唯一匹配的场所名称或完整地址。',
        { origin: resolution.origin, destination: resolution.destination },
        { origin: originReceipt, destination: destinationReceipt });
    }
    const request = { type: 'RideRequest', id: context.operationId }, route = { type: 'Route', id: context.operationId };
    const quoteInput = { requestId: request.id, origin: resolution.origin, destination: resolution.destination };
    // All provider I/O finishes before opening the business edit transaction.
    const quote = await sources.read(model, 'DidiEstimates', quoteInput, context.objects.access, execution?.task, execution?.tasks, context.signal);
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
