import { randomUUID } from 'node:crypto';
import { Conflict, digest } from '../../core/identity.js';
import type { ObjectData } from '../../ontology/schema.js';
import type { FunctionContext } from '../../runtime/functions.js';
import type { SourceResolver } from './functions.js';

export async function readDidiDriving(resolve: SourceResolver, origin: ObjectData, destination: ObjectData, context: FunctionContext) {
  const source = await resolve(context.principal.owner);
  await source.assertCurrent();
  context.objects.access.source(context.objects.model, 'Didi');
  for (const place of [origin, destination])
    if (place.ref.type !== 'Place' || place.properties.sourceBinding !== source.bindingId)
      throw new Conflict('Travel endpoints require this owner source binding');
  const point = (p: ObjectData) => {
    const c = p.properties.coordinates as { lng: number; lat: number };
    if (!c || !Number.isFinite(c.lng) || !Number.isFinite(c.lat))
      throw new Conflict('Location coordinates are unavailable');
    return `${c.lng},${c.lat}`;
  };
  const input = { origin: point(origin), destination: point(destination), need_geo: false };
  const result = await source.connector.invoke(
    { requestId: context.taskId ?? context.operationId ?? randomUUID(), requestRevision: 1 },
    'maps_direction_driving',
    input,
    context.signal,
    async () => {
      await context.assertCurrent?.();
      await source.assertCurrent();
    },
  );
  if (
    result.data.kind !== 'driving' ||
    result.receipt.inputDigest !== digest(input) ||
    result.receipt.resultDigest !== digest(result.data) ||
    result.receipt.bindingId !== source.bindingId
  )
    throw new Conflict('Driving evidence mismatch');
  return {
    durationSeconds: result.data.durationSeconds,
    distanceMeters: result.data.distanceMeters,
    bindingId: source.bindingId,
    authorityId: source.authorityId ?? digest(source.bindingId),
    observedAt: result.receipt.receivedAt,
    expiresAt: new Date(Date.parse(result.receipt.startedAt) + 300000).toISOString(),
    evidence: source.connector.evidenceKind === 'fixture' ? ('synthetic' as const) : source.connector.evidenceKind,
    receiptDigest: digest(result.receipt),
  };
}
