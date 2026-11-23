import { Conflict } from '../../core/identity.js';
import { immediateOrderLink } from '../../ontology/didi-immediate-ride.js';
import type { ObjectData, ObjectRef } from '../../ontology/schema.js';
import type { FunctionContext } from '../../runtime/functions.js';

export async function originalDidiRide(objects: FunctionContext['objects'], order: ObjectRef) {
  const trips = await objects.follow(order, 'trips');
  const immediate = objects.model.links.has(immediateOrderLink) ? await objects.follow(order, 'immediateRides') : [];
  const sources = [...trips, ...immediate];
  if (sources.length !== 1) throw new Conflict('Original ride authority is unavailable');
  return sources[0]!;
}


/** The verified order can carry opaque authority without disclosing the original route. */
export async function originalDidiOrderAuthority(objects: FunctionContext['objects'], order: ObjectData) {
  if (typeof order.properties.sourceAuthority === 'string') return order.properties.sourceAuthority;
  const original = await originalDidiRide(objects, order.ref);
  if (typeof original.properties.sourceAuthority !== 'string')
    throw new Conflict('Original ride authority is unavailable');
  return original.properties.sourceAuthority;
}
