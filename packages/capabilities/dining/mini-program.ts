import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import {
  diningMiniProgramCapabilities, diningMiniProgramObservation, diningMiniProgramQuery, diningMiniProgramRead,
  diningMiniProgramTarget, diningMiniProgramTestRequest,
} from '../../ontology/dining-reservations.js';
import { json } from '../../ontology/service-contracts.js';
import type { Sql } from '../../runtime/database.js';
import type { FunctionContext } from '../../runtime/functions.js';
import { PARequests } from '../../runtime/pa.js';

const connection = diningMiniProgramQuery.pick({ restaurant: true, city: true, branch: true }).extend({
  owner: z.string().min(1).max(200), miniProgram: diningMiniProgramTarget,
  testId: diningMiniProgramTestRequest.shape.testId.optional(),
});
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();

export function matchesMiniProgram(
  query: Pick<z.infer<typeof diningMiniProgramQuery>, 'restaurant' | 'city' | 'branch'>,
  binding: z.infer<typeof connection>,
) {
  return normalize(query.restaurant) === normalize(binding.restaurant) && normalize(query.city) === normalize(binding.city)
    && normalize(query.branch) === normalize(binding.branch);
}

export async function resolveDiningMiniProgram(path: string | undefined, owner: string) {
  if (!path) return;
  const read = async () => connection.parse(JSON.parse(await readPrivateSourceFile(path)));
  const binding = await read();
  if (binding.owner !== owner) return;
  // Validate the configured local date boundary before starting an on-device request.
  new Intl.DateTimeFormat('en', { timeZone: binding.miniProgram.timeZone }).format();
  const identity = digest(binding);
  return { ...binding, channel: 'miniprogram' as const, timeZone: binding.miniProgram.timeZone, identity,
    async assertCurrent() {
      if (digest(await read()) !== identity) throw new Conflict('The original mini-program connection changed');
    },
  };
}

export async function askDiningPA(
  context: FunctionContext, capability: string, input: Record<string, unknown>, output: z.ZodType,
  operation = digest([capability, input]), beforeDispatch?: (client: Sql) => Promise<void>,
) {
  const execution = context.execution;
  if (!execution) throw new Conflict('Use the original PA task for the dining mini program');
  return new PARequests(execution.tasks).requestWithId(
    execution.task, operation, capability, input, json(output), undefined, beforeDispatch,
  );
}

export async function readDiningMiniProgramAvailability(path: string | undefined, raw: unknown, context: FunctionContext) {
  const query = diningMiniProgramQuery.parse(raw), binding = await resolveDiningMiniProgram(path, context.principal.owner);
  if (!binding || !matchesMiniProgram(query, binding)) return { status: 'unavailable', reason: 'venue-not-connected' };
  const today = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: binding.timeZone }).format();
  const days = (Date.parse(query.date) - Date.parse(today)) / 86400000;
  if (days < 0 || days > 60) return { status: 'unavailable', reason: 'date-out-of-range' };
  const input = diningMiniProgramRead.parse({ ...query, miniProgram: binding.miniProgram });
  const reply = await askDiningPA(context, diningMiniProgramCapabilities.availability, input, diningMiniProgramObservation);
  await binding.assertCurrent();
  const result = diningMiniProgramObservation.parse(reply.response);
  if (result.status === 'unavailable') return result;
  const { status: _status, evidence: _evidence, observedAt, availableTimes, ...observed } = result;
  const happenedAt = Date.parse(observedAt), now = Date.now();
  if (digest(observed) !== digest(input) || happenedAt < reply.requestedAt.getTime() - 5000 ||
      happenedAt > now + 5000 || now - happenedAt > 300000)
    throw new Conflict('The mini-program observation does not match the original current request');
  return { ...result, availableTimes: [...new Set(availableTimes)].sort(), paRequestId: reply.requestId };
}
