import type { z } from 'zod';
import { Conflict, NotFound, digest, requireScope } from '../../core/identity.js';
import { flightNumberKey, flightStatusRead, flightWatch, flightWatchInput, flightWatchRead, flightWatchSettings, flightWatchType, searchFlight } from '../../ontology/flight.js';
import type { ObjectRef } from '../../ontology/schema.js';
import type { Database } from '../../runtime/database.js';
import type { FunctionContext, FunctionHandler, Functions } from '../../runtime/functions.js';
import { ScheduledActions } from '../../runtime/scheduled-actions.js';
import type { FlightSourceResolver } from './variflight.js';

type Watch = z.infer<typeof flightWatch>;
type Status = NonNullable<Watch['status']>;
type Change = NonNullable<Watch['alert']>['changes'][number];
const minute = 60000;
const interval = 15 * minute;
const iso = (instant: number) => new Date(instant).toISOString();
const active = (state: Watch['state']) => ['pending', 'monitoring', 'unavailable'].includes(state);
const finished = (status: Status['status']) => ['arrived', 'cancelled', 'returned', 'diverted'].includes(status);
const scheduled = (state: string) => ['submitted', 'working', 'input-required', 'scheduled'].includes(state);

function direct(ctx: FunctionContext) {
  if (!ctx.edit || !ctx.directAction || ctx.objects.model.scenario)
    throw new Conflict('Use an explicit live flight watch Action');
  return ctx.edit;
}

async function readWatch(objects: FunctionContext['objects'], watch: ObjectRef) {
  if (watch.type !== flightWatchType) throw new Conflict('Expected a flight watch');
  const row = await objects.read(watch);
  return { row, previous: flightWatch.parse(row.properties) };
}

function changesFrom(previous: Watch, status: Status): Change[] {
  const changes: Change[] = [];
  const old = previous.status;
  const changedTime = (oldSchedule: string | null, newSchedule: string | null, estimate: string | null, newEstimate: string | null) => {
    const before = estimate ?? oldSchedule, after = newEstimate ?? newSchedule;
    return Boolean(before && after && Math.abs(Date.parse(after) - Date.parse(before)) >= 5 * minute);
  };
  if (status.status !== 'unknown' && (old?.status !== status.status) &&
      (old || ['delayed', 'cancelled', 'diverted', 'returned'].includes(status.status))) changes.push('status');
  if (old && changedTime(old.scheduledDeparture, status.scheduledDeparture, old.estimatedDeparture, status.estimatedDeparture)) changes.push('departure_time');
  if (old && changedTime(old.scheduledArrival, status.scheduledArrival, old.estimatedArrival, status.estimatedArrival)) changes.push('arrival_time');
  if (previous.knownGate && status.gate && previous.knownGate !== status.gate) changes.push('gate');
  if (previous.knownTerminal && status.departureTerminal && previous.knownTerminal !== status.departureTerminal) changes.push('departure_terminal');
  return changes;
}

export function flightFunctions(db: Database, functions: () => Functions, resolve: FlightSourceResolver): ReadonlyMap<string, FunctionHandler> {
  const schedules = new ScheduledActions(db);
  return new Map<string, FunctionHandler>([
    ['readFlightStatus', async (raw, ctx) => {
      if (ctx.objects.model.scenario) throw new Conflict('Read operational flight status on the live Ontology');
      return (await resolve(ctx)).read(searchFlight.parse(raw));
    }],
    ['startFlightWatch', async (raw, ctx) => {
      const edit = direct(ctx), settings = flightWatchSettings.parse(raw);
      settings.flightNumber = flightNumberKey(settings.flightNumber);
      requireScope(ctx.principal, 'tasks:read');
      requireScope(ctx.principal, 'tasks:write');
      const deadline = Date.parse(settings.monitorUntil), now = Date.now();
      if (deadline <= now + minute || deadline > now + 48 * 60 * minute)
        throw new Conflict('Set a flight watch deadline in the next 48 hours');
      const lookup = searchFlight.parse({
        flightNumber: settings.flightNumber, departureDate: settings.departureDate,
        origin: settings.origin, destination: settings.destination,
      });
      const authority = (await resolve(ctx)).authorityId;
      ctx.objects.access.function(ctx.objects.model, 'readFlightStatus');
      const watch = { type: flightWatchType, id: digest([ctx.principal.owner, lookup]) };
      return edit(watch, async graph => {
        const read = await readWatch(graph, watch).catch(error => {
          if (error instanceof NotFound) return null;
          throw error;
        });
        const previous = read?.previous;
        if (previous && active(previous.state) && Date.parse(previous.settings.monitorUntil) > Date.now() &&
            scheduled((await schedules.inspect(ctx.principal, previous.scheduleId, graph.client)).state)) {
          if (digest(previous.settings) !== digest(settings)) throw new Conflict('Cancel the current watch before changing it');
          return;
        }
        const scheduleId = digest([watch.id, ctx.operationId]), runAt = iso(Date.now());
        const fields = {
          settings, scheduleId, sourceAuthority: authority, checks: 0, state: 'pending', reason: 'waiting',
          checkedAt: null, nextCheckAt: runAt, status: null, observedAt: null, knownGate: null, knownTerminal: null,
          alert: null, alertVersion: previous?.alertVersion ?? 0,
        };
        if (read) await graph.edit(watch, read.row.revision, fields);
        else await graph.create(watch, { ...fields, id: watch.id, name: `${settings.flightNumber} ${settings.origin}–${settings.destination}` });
        await schedules.enqueue(graph, { id: scheduleId, action: 'CheckFlightWatch', arguments: { watch }, runAt, deadline: settings.monitorUntil });
      });
    }],
    ['checkFlightWatch', async (raw, ctx) => {
      const { watch } = flightWatchInput.parse(raw), { execution, edit } = ctx;
      const call = execution?.task.input.scheduledAction;
      if (!edit || !execution || !call || call.action !== 'CheckFlightWatch' || ctx.objects.model.scenario)
        throw new Conflict('Use the original scheduled flight check');
      const { row, previous } = await readWatch(ctx.objects, watch);
      if (!active(previous.state) || previous.scheduleId !== call.scheduleId) throw new Conflict('Flight watch stopped');
      const { flightNumber, departureDate, origin, destination, maxChecks } = previous.settings;
      const source = await resolve(ctx).catch(error => {
        if (error instanceof Conflict) return null;
        throw error;
      });
      if (!source || source.authorityId !== previous.sourceAuthority) return edit(watch, async graph => {
        await graph.edit(watch, row.revision, { state: 'ended', reason: 'source_changed', alert: null, nextCheckAt: null });
      });
      const assertCurrent: NonNullable<FunctionContext['assertCurrent']> = async client => {
        await ctx.assertCurrent?.(client);
        if ((await resolve(ctx)).authorityId !== previous.sourceAuthority) throw new Conflict('Original flight source changed');
      };
      // Count failed queries against the same user's per-watch request budget.
      const observation = await functions().invoke(ctx.objects.model, 'readFlightStatus',
        { flightNumber, departureDate, origin, destination }, { ...ctx, assertCurrent }).then(flightStatusRead.parse).catch(error => {
          if (error instanceof Conflict) return null;
          throw error;
        });
      const now = Date.now();
      const seen = observation ? Date.parse(observation.observedAt) : NaN;
      const current = seen <= now + minute && seen > now - interval && seen > Date.parse(previous.observedAt ?? '1970-01-01');
      const status = current && observation?.flights.length === 1 ? observation.flights[0]! : null;
      const checkedAt = iso(now), checks = previous.checks + 1;
      const terminal = status && finished(status.status), exhausted = checks >= maxChecks;
      const next = Math.min(now + interval, Date.parse(call.deadline) - minute);
      const nextCheckAt = terminal || exhausted || next < now + 2 * minute ? null : iso(next);
      const changes = status ? changesFrom(previous, status) : [];
      const alertVersion = previous.alertVersion + (changes.length ? 1 : 0);
      await assertCurrent();
      return edit(watch, async graph => {
        await graph.edit(watch, row.revision, {
          checks, checkedAt, nextCheckAt,
          state: terminal ? 'completed' : nextCheckAt ? (status ? 'monitoring' : 'unavailable') : 'ended',
          reason: terminal ? 'flight_finished' : exhausted ? 'check_limit' : !nextCheckAt ? 'deadline' :
            status ? 'checked' : current && observation ? 'no_match' : 'source_unavailable',
          ...(status ? { status, observedAt: observation!.observedAt, knownGate: status.gate ?? previous.knownGate,
            knownTerminal: status.departureTerminal ?? previous.knownTerminal } : {}),
          alertVersion, alert: status && changes.length ? { version: alertVersion, createdAt: checkedAt, changes, flight: status } : previous.alert,
        });
        if (nextCheckAt) await schedules.continueAt(graph, execution.task, nextCheckAt);
      });
    }],
    ['cancelFlightWatch', async (raw, ctx) => {
      const edit = direct(ctx), { watch } = flightWatchInput.parse(raw);
      return edit(watch, async graph => {
        const { row, previous } = await readWatch(graph, watch);
        if (previous.state === 'cancelled') return;
        if (active(previous.state)) {
          const job = await schedules.inspect(ctx.principal, previous.scheduleId, graph.client);
          if (scheduled(job.state) || job.state === 'blocked') await schedules.cancel(graph, previous.scheduleId);
        }
        await graph.edit(watch, row.revision, {
          state: 'cancelled', reason: 'user_cancelled', nextCheckAt: null, alert: null,
          alertVersion: previous.alertVersion + (previous.alert ? 1 : 0),
        });
      });
    }],
    ['readFlightWatch', async (raw, ctx) => {
      const { watch } = flightWatchInput.parse(raw), { row, previous } = await readWatch(ctx.objects, watch);
      let { state, reason, nextCheckAt, alert } = previous;
      if (active(state)) {
        const expired = Date.parse(previous.settings.monitorUntil) <= Date.now();
        const source = expired ? null : await resolve(ctx).catch(error => {
          if (error instanceof Conflict) return null;
          throw error;
        });
        const job = source?.authorityId === previous.sourceAuthority ? await schedules.inspect(ctx.principal, previous.scheduleId) : null;
        if (!job || !scheduled(job.state)) {
          state = 'ended';
          reason = expired ? 'deadline' : job ? 'check_failed' : 'source_changed';
          nextCheckAt = null;
          alert = null;
        }
      }
      return flightWatchRead.parse({
        watch, revision: row.revision, state, reason, nextCheckAt,
        checks: previous.checks, checkedAt: previous.checkedAt,
        observedAt: previous.observedAt, status: previous.status, monitorUntil: previous.settings.monitorUntil,
        alertVersion: previous.alertVersion, alert,
      });
    }],
  ]);
}
