import { digest } from '../../core/identity.js';
import { objectRefSchema, type ObjectData, type ObjectRef } from '../../ontology/schema.js';
import { Clarification } from '../../runtime/clarification.js';
import type { Functions, FunctionHandler } from '../../runtime/functions.js';
import type { Sources } from '../../runtime/sources.js';

type Resolution = { status: 'resolved'; origin: ObjectRef; destination: ObjectRef }
  | { status: 'input-required'; origin: ObjectData[]; destination: ObjectData[] };

/** Named-place resolution is an Interface query, not another model decision. */
export const resolveRideLocations: FunctionHandler = async (input, context): Promise<Resolution> => {
  const selection = input.selection as { origin: ObjectRef; destination: ObjectRef } | undefined;
  const find = async (role: 'origin' | 'destination') => {
    const receipt = objectRefSchema.parse(input[role + 'Receipt']), choice = selection?.[role];
    const query = { type: 'Location', from: { object: receipt, link: 'places' }, limit: 100 };
    const exact = await context.objects.query({ ...query, where: choice ? {} : { name: String(input[role]) } });
    const matches = choice ? exact.items.filter(item => digest(item.ref) === digest(choice)) : exact.items;
    if (!exact.cursor && matches.length === 1) return { selected: matches[0]!.ref, candidates: matches };
    const candidates = exact.items.length ? exact : await context.objects.query(query);
    if (candidates.cursor) throw new Clarification('地点候选过多，请补充完整地址。');
    return { candidates: candidates.items };
  };
  const [origin, destination] = await Promise.all([find('origin'), find('destination')]);
  return origin.selected && destination.selected ? { status: 'resolved', origin: origin.selected, destination: destination.selected }
    : { status: 'input-required', origin: origin.candidates, destination: destination.candidates };
};

/** Implementation of the published edit Function backing the RideInquiry Action. */
export function prepareRideInquiry(getSources: () => Sources, getFunctions: () => Functions): FunctionHandler {
  return async (input, context) => {
    if (!context.edit || !context.operationId) throw new Error('Ride inquiry requires an Action edit context');
    const model = context.objects.model, sources = getSources(), functions = getFunctions(), execution = context.execution;
    const results = await Promise.all(['origin', 'destination'].map(role => sources.refresh(model, 'DidiPlaces',
      { city: input.city, keywords: input[role] }, context.objects.access, execution?.task, execution?.tasks, context.signal)));
    const resolution = await functions.invoke(model, 'resolveRideLocations', {
      origin: input.origin, destination: input.destination, originReceipt: results[0]!.receipt, destinationReceipt: results[1]!.receipt,
      ...(execution?.task.input.places ? { selection: execution.task.input.places } : {}),
    }, context) as Resolution;
    if (resolution.status !== 'resolved') throw new Clarification('请确认未能唯一匹配的场所名称或完整地址。', { origin: resolution.origin, destination: resolution.destination });
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
