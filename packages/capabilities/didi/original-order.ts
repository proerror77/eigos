import { Conflict } from '../../core/identity.js';
import { immediateOrderLink } from '../../ontology/didi-immediate-ride.js';
import type { ObjectRef } from '../../ontology/schema.js';
import type { FunctionContext } from '../../runtime/functions.js';

export async function originalDidiRide(objects: FunctionContext['objects'], order: ObjectRef) {
  const trips = await objects.follow(order, 'trips');
  const immediate = objects.model.links.has(immediateOrderLink) ? await objects.follow(order, 'immediateRides') : [];
  const sources = [...trips, ...immediate];
  if (sources.length !== 1) throw new Conflict('Original ride authority is unavailable');
  return sources[0]!;
}
