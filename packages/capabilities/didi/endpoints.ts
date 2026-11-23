import { Conflict, InvalidInput } from '../../core/identity.js';
import { rideEndpoints, ridePersonalPlaceLinks, savedRideEndpoint, type ResolvedRideEndpoints } from '../../ontology/didi-ride-endpoints.js';
import { personalPlaceRecord, privateLocation } from '../../ontology/personal-places.js';
import type { LinkData, ObjectRef } from '../../ontology/schema.js';
import type { FunctionContext } from '../../runtime/functions.js';
import type { Objects } from '../../runtime/objects.js';

export async function readSavedRideEndpoints(input: Record<string, unknown>, context: FunctionContext) {
  const read = async (side: typeof rideEndpoints[number]) => {
    const raw = input[side + 'PersonalPlace'];
    if (raw === undefined) return;
    if (input[side] !== undefined || input[side + 'Landmark'] !== undefined)
      throw new InvalidInput('Supply one named endpoint or one confirmed personal place for each side');
    context.objects.access.useModelData(privateLocation);
    const selected = savedRideEndpoint.parse(raw);
    const row = await context.objects.read(selected.place);
    if (row.revision !== selected.revision)
      throw new Conflict('The saved ride endpoint changed; confirm the new address before using it');
    const { address, city } = personalPlaceRecord.parse(row.properties);
    return { selected, address, city };
  };
  const [origin, destination] = await Promise.all(rideEndpoints.map(read));
  return { origin, destination };
}

export async function assertSavedRideEndpoints(objects: Pick<Objects, 'read'>, endpoints: ResolvedRideEndpoints) {
  for (const selected of [endpoints.originPersonalPlace, endpoints.destinationPersonalPlace]) {
    if (selected && (await objects.read(selected.place)).revision !== selected.revision)
      throw new Conflict('The saved ride endpoint changed; confirm the new address before using it');
  }
}

export function rideEndpointLinks(route: ObjectRef, endpoints: ResolvedRideEndpoints): LinkData[] {
  const { origin, destination, originPersonalPlace, destinationPersonalPlace } = endpoints;
  return [
    { type: 'RouteOrigin', from: route, to: origin },
    { type: 'RouteDestination', from: route, to: destination },
    ...(originPersonalPlace ? [{ type: ridePersonalPlaceLinks[0]!.apiName, from: route, to: originPersonalPlace.place }] : []),
    ...(destinationPersonalPlace ? [{ type: ridePersonalPlaceLinks[1]!.apiName, from: route, to: destinationPersonalPlace.place }] : []),
  ];
}

export function savedRideRevisions(endpoints: ResolvedRideEndpoints) {
  const { originPersonalPlace, destinationPersonalPlace } = endpoints;
  if (originPersonalPlace || destinationPersonalPlace) return {
    ...(originPersonalPlace ? { origin: originPersonalPlace.revision } : {}),
    ...(destinationPersonalPlace ? { destination: destinationPersonalPlace.revision } : {}),
  };
}
