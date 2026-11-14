import { z } from 'zod';
import { Conflict } from '../core/identity.js';
import {
  locationCapability, locationReference, locationReply, locationRequest, locationUse, taskLocationInput,
} from '../ontology/location.js';
import { json } from '../ontology/service-contracts.js';
import { Clarification } from '../runtime/clarification.js';
import type { FunctionContext, FunctionHandler } from '../runtime/functions.js';
import { PARequests } from '../runtime/pa.js';

const preferredAccuracy = { luckin_pickup: 300, waimai_delivery: 100 };
const maxAgeMs = 120000;
const locationPermissionMs = 300000;
function locationParameters(request: z.infer<typeof locationRequest>, response: unknown, requestedAt: Date) {
  const answer = locationReply.parse(response);
  if (answer.status !== 'available') {
    throw new Clarification('请提供本次查询要使用的地址或门店。');
  }
  const position = answer.location;
  if (request.coordinateSystem !== position.coordinateSystem) {
    throw new Clarification('请提供适用于该服务的地图位置。');
  }
  if (request.selection.source !== 'current') {
    if (position.source !== request.selection.source || request.selection.place !== position.place)
      throw new Clarification('请确认本次要查询的指定地点。');
  } else if (position.source === 'planned') {
    throw new Clarification('请确认是否使用方案中的指定地点。');
  }
  if (position.source === 'device') {
    const observed = Date.parse(position.observedAt), expires = observed + request.maxAgeMs, now = Date.now();
    if (observed > now + 5000 || expires <= now || position.accuracyMeters > request.maxAccuracyMeters)
      throw new Clarification('定位已过期或精度不足，请提供本次查询要使用的地址或门店。');
    return { position, expiresAt: new Date(expires).toISOString() };
  }
  const expires = requestedAt.getTime() + locationPermissionMs;
  if (expires <= Date.now()) throw new Clarification('本次地点授权已过期，请重新确认地址。');
  return { position, expiresAt: new Date(expires).toISOString() };
}

async function requestTaskLocation(input: z.infer<typeof taskLocationInput>, ctx: FunctionContext) {
  const execution = ctx.execution;
  if (!execution || execution.task.input.scheduledAction)
    throw new Conflict('Resolve a location on the original interactive PA task');
  const request = locationRequest.parse({
    ...input, maxAgeMs, maxAccuracyMeters: preferredAccuracy[input.use],
  });
  const reply = await new PARequests(execution.tasks).requestWithId(
    execution.task, locationCapability, locationCapability, request, json(locationReply),
  );
  const location = locationParameters(request, reply.response, reply.requestedAt);
  return { ...location, requestId: reply.requestId };
}

export const resolveTaskLocation: FunctionHandler = async (raw, ctx) => {
  const { requestId, position, expiresAt } = await requestTaskLocation(taskLocationInput.parse(raw), ctx);
  return locationReference.parse({
    requestId, source: position.source, coordinateSystem: position.coordinateSystem, expiresAt,
    ...(position.source === 'device'
      ? { observedAt: position.observedAt, accuracyMeters: position.accuracyMeters }
      : { place: position.place }),
  });
};

export async function locationForService(
  ctx: FunctionContext,
  input: { locationRequestId: string } | { location?: z.infer<typeof taskLocationInput>['selection'] },
  use: z.infer<typeof locationUse>,
  coordinateSystem: z.infer<typeof taskLocationInput>['coordinateSystem'],
) {
  const execution = ctx.execution;
  if (!execution || execution.task.input.scheduledAction || ctx.objects.model.scenario)
    throw new Conflict('Use the original live PA task for its location');
  const { model, access } = ctx.objects;
  access.function(model, 'resolveTaskLocation');
  access.source(model, 'PALocation');
  if (!('locationRequestId' in input)) {
    return requestTaskLocation({
      use, coordinateSystem, selection: input.location ?? { source: 'current' },
    }, ctx);
  }
  const { task, tasks } = execution;
  await tasks.current(task);
  const db = tasks.db;
  const row = (await db.query<{ request: { capability: string; input: unknown }; response: unknown; created_at: Date }>(
    `SELECT request,response,created_at FROM ${db.schema}.pa_requests
      WHERE task_id=$1 AND owner=$2 AND id=$3 AND response IS NOT NULL`,
    [task.id, ctx.principal.owner, input.locationRequestId],
  )).rows[0];
  if (!row || row.request?.capability !== locationCapability) throw new Conflict('This task has no matching authorized location');
  const request = locationRequest.parse(row.request.input);
  if (request.use !== use || request.coordinateSystem !== coordinateSystem)
    throw new Conflict('The task location was authorized for a different use or coordinate system');
  return { ...locationParameters(request, row.response, row.created_at), requestId: input.locationRequestId };
}
