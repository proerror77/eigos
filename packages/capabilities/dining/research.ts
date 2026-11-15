import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import {
  diningAnswer, diningEvidence, diningQuery, historyQuery, historyResult, noteSearch, paNotesResult,
} from '../../ontology/dining.js';
import { json } from '../../ontology/service-contracts.js';
import type { Database, Sql } from '../../runtime/database.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { PARequests } from '../../runtime/pa.js';
import { configuredNoteSearch } from './xiaohongshu.js';

async function ask(ctx: FunctionContext, capability: string, input: Record<string, unknown>, schema: z.ZodType, dataScope = input) {
  const execution = ctx.execution;
  if (!execution) throw new Conflict('Request this information through the original PA task');
  return new PARequests(execution.tasks).requestWithId(execution.task, digest([capability, input]), capability, input, json(schema), dataScope);
}
const day = 86400000;
const fresh = (observedAt: string, expiresAt: string) => {
  const now = Date.now(), observed = Date.parse(observedAt), expires = Date.parse(expiresAt);
  return observed <= now + 5000 && expires > now && expires > observed && expires - observed <= day;
};
const sameTime = (a: string, b: string) => Date.parse(a) === Date.parse(b);
const availableReply = diningAnswer.options[0];

export function diningResearch(path?: string, fetcher?: typeof fetch): ReadonlyMap<string, FunctionHandler> {
  const search = path ? configuredNoteSearch(path, fetcher) : undefined;
  return new Map<string, FunctionHandler>([
    ['searchRestaurantNotes', async (raw, ctx) => {
      const input = noteSearch.parse(raw);
      const result = search ? await search(ctx, input) : paNotesResult.parse(
        (await ask(ctx, 'xiaohongshu.notes.search', input, paNotesResult)).response,
      );
      if (result.status === 'available' && result.notes.length > input.limit) throw new Conflict('Restaurant search exceeds the requested result limit');
      return result;
    }],
    ['readWeatherHistory', async (raw, ctx) => {
      const input = historyQuery.parse(raw), first = Date.parse(input.startDate), last = Date.parse(input.endDate);
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format();
      if (first > last || last - first >= 14 * day || input.endDate >= today) throw new Conflict('Select up to fourteen past dates');
      const result = historyResult.parse((await ask(ctx, 'weather.history', input, historyResult)).response);
      if (result.status === 'available') {
        const days = new Set(result.days.map(entry => entry.date));
        const complete = days.size === 1 + (last - first) / day;
        if (result.city !== input.city || Date.parse(result.observedAt) > Date.now() + 5000 ||
            days.size !== result.days.length || result.complete !== complete ||
            result.days.some(entry => entry.date < input.startDate || entry.date > input.endDate)) {
          throw new Conflict('Historical weather does not match the requested location and dates');
        }
      }
      return result;
    }],
    ['readDiningAvailability', async (raw, ctx) => {
      const parsed = diningQuery.parse(raw), input = { ...parsed,
        start: new Date(parsed.start).toISOString(), end: new Date(parsed.end).toISOString() };
      if (Date.parse(input.end) <= Date.parse(input.start) || Date.parse(input.start) <= Date.now()) throw new Conflict('Select a future meal window');
      let replaces: string | undefined;
      for (;;) {
        ctx.signal.throwIfAborted();
        const response = await ask(ctx, 'dining.availability', input, diningAnswer, replaces ? { ...input, replaces } : input);
        const answer = diningAnswer.parse(response.response);
        if (answer.status !== 'available') return answer;
        if (fresh(answer.observedAt, answer.expiresAt) && Date.parse(answer.observedAt) >= response.requestedAt.getTime() - 5000) {
          return { ...input, ...answer, requestId: response.requestId };
        }
        // Reissue the exact meal request without replacing its immutable earlier reply.
        replaces = response.requestId;
      }
    }],
  ]);
}

export async function diningProof(db: Database, client: Sql, scope: { owner: string; taskId: string; requestId: string; start: string; end: string }) {
  const row = (await db.query(`SELECT response,request,created_at FROM ${db.schema}.pa_requests WHERE owner=$1 AND task_id=$2 AND id=$3`,
    [scope.owner, scope.taskId, scope.requestId], client)).rows[0];
  const input = diningQuery.safeParse(row?.request?.input), answer = availableReply.safeParse(row?.response);
  if (row?.request?.capability !== 'dining.availability' || !input.success || !answer.success ||
      !sameTime(input.data.start, scope.start) || !sameTime(input.data.end, scope.end) ||
      !fresh(answer.data.observedAt, answer.data.expiresAt) || Date.parse(answer.data.observedAt) < row.created_at.getTime() - 5000) {
    throw new Conflict('The proposed meal needs current availability evidence from the original PA task');
  }
  const { status: _status, ...facts } = answer.data;
  return diningEvidence.parse({ ...input.data, ...facts, requestId: scope.requestId, taskId: scope.taskId });
}
