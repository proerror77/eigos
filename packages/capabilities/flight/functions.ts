import type { z } from 'zod';
import { Conflict, NotFound, digest, requireScope } from '../../core/identity.js';
import { flightNumberKey, flightPositionSource, flightSource, flightStatusRead, flightWatch, flightWatchInput, flightWatchRead, flightWatchSettings, flightWatchSources, flightWatchType, searchFlight } from '../../ontology/flight.js';
import { flightPositionInput, flightPositionResult } from '../../ontology/flight-position.js';
import type { ObjectRef } from '../../ontology/schema.js';
import { Access, PermissionDenied, resource } from '../../runtime/access.js';
import type { Database, Sql } from '../../runtime/database.js';
import type { FunctionContext, FunctionHandler, Functions } from '../../runtime/functions.js';
import { Objects } from '../../runtime/objects.js';
import { ScheduledActions } from '../../runtime/scheduled-actions.js';
import type { FlightPositionResolver } from './flightradar24.js';
import type { FlightSourceResolver } from './variflight.js';

type Watch = z.infer<typeof flightWatch>;
type Status = NonNullable<Watch['status']>;
type Change = NonNullable<Watch['alert']>['changes'][number];
type Provider = (typeof flightWatchSources)[number];
const reads = { [flightSource]: 'readFlightStatus', [flightPositionSource]: 'readLiveFlightPosition' } as const;
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

export function flightFunctions(db: Database, functions: () => Functions, variFlight: FlightSourceResolver, fr24: FlightPositionResolver): ReadonlyMap<string, FunctionHandler> {
  const schedules = new ScheduledActions(db);
  const resolve = { [flightSource]: variFlight, [flightPositionSource]: fr24 };

  async function authorized(ctx: FunctionContext, provider: Provider, authorityId: string,
    options: { access?: Access; client?: Sql; execute?: boolean } = {}) {
    const { client, execute } = options;
    const access = options.access ?? await Access.load(db, ctx.principal, client);
    const model = ctx.objects.model;
    const sourceCtx = { ...ctx, objects: new Objects(db, model, access, client),
      assertCurrent: async () => { await ctx.assertCurrent?.(client); } };
    try {
      if (execute) access.function(model, reads[provider]);
      return (await resolve[provider](sourceCtx)).authorityId === authorityId ? access : null;
    } catch (error) {
      if (error instanceof Conflict || error instanceof PermissionDenied) return null;
      throw error;
    }
  }

  async function sample<T>(ctx: FunctionContext, provider: Provider, authorityId: string | null | undefined,
    input: Record<string, unknown>, schema: z.ZodType<T>) {
    if (!authorityId) return null;
    // A revoked grant must not taint another source's reads or the whole Action.
    const access = await authorized(ctx, provider, authorityId, { execute: true });
    if (!access) return null;
    const assertCurrent: NonNullable<FunctionContext['assertCurrent']> = async () => {
      if (!await authorized(ctx, provider, authorityId, { access, execute: true }))
        throw new Conflict('Original flight source changed');
    };
    const objects = new Objects(db, ctx.objects.model, access);
    try {
      const result = schema.parse(await functions().invoke(objects.model, reads[provider], input, { ...ctx, objects, assertCurrent }));
      return { result };
    } catch (error) {
      ctx.signal.throwIfAborted();
      if (error instanceof Conflict || error instanceof PermissionDenied) return { result: null };
      throw error;
    }
  }

  const check = (action: 'CheckFlightWatch' | 'RefreshFlightWatch'): FunctionHandler => async (raw, ctx) => {
    const { watch } = flightWatchInput.parse(raw), { execution, edit } = ctx;
    const call = execution?.task.input.scheduledAction;
    if (!edit || !execution || !call || call.action !== action || ctx.objects.model.scenario)
      throw new Conflict('Use the original scheduled flight check');
    const { row, previous } = await readWatch(ctx.objects, watch);
    if (!active(previous.state) || previous.scheduleId !== call.scheduleId) throw new Conflict('Flight watch stopped');
    const { flightNumber, departureDate, origin, destination, maxChecks } = previous.settings;
    const { sourceAuthority, liveTracking } = previous;
    const route = { flightNumber, origin, destination };
    const [statusSample, positionSample] = await Promise.all([
      sample(ctx, flightSource, sourceAuthority, { ...route, departureDate }, flightStatusRead),
      sample(ctx, flightPositionSource, liveTracking?.authorityId, route, flightPositionResult),
    ]);
    return edit(watch, async graph => {
      const currentSource = async (provider: Provider, authorityId: string | null | undefined) =>
        authorityId ? authorized(ctx, provider, authorityId, { execute: true, client: graph.client }) : null;
      const [statusAuthority, positionAuthority] = await Promise.all([
        statusSample && currentSource(flightSource, sourceAuthority),
        positionSample && currentSource(flightPositionSource, liveTracking?.authorityId),
      ]);
      const observation = statusAuthority ? statusSample?.result : null;
      const position = positionAuthority ? positionSample?.result : null;
      if (observation && statusAuthority) graph.access.adoptReads(statusAuthority);
      if (position && positionAuthority) graph.access.adoptReads(positionAuthority);

      const now = Date.now(), checkedAt = iso(now);
      const seen = observation ? Date.parse(observation.observedAt) : NaN;
      const current = seen <= now + minute && seen > now - interval && seen > Date.parse(previous.observedAt ?? '1970-01-01');
      const status = current && observation?.flights.length === 1 ? observation.flights[0]! : null;
      const matches = position?.positions.length;
      const noSources = !statusAuthority && !positionAuthority;
      const checks = previous.checks + (statusSample || positionSample ? 1 : 0);
      const terminal = status && finished(status.status), exhausted = checks >= maxChecks;
      const next = Math.min(now + interval, Date.parse(call.deadline) - minute);
      const nextCheckAt = noSources || terminal || exhausted || next < now + 2 * minute ? null : iso(next);
      const observed = status || matches === 1;
      const changes = status ? changesFrom(previous, status) : [];
      const alertVersion = previous.alertVersion + (changes.length ? 1 : 0);
      const liveState = !positionAuthority ? 'source_changed' : matches === undefined ? 'source_unavailable' :
        matches === 1 ? 'tracked' : matches === 0 ? 'no_match' : 'ambiguous';
      await graph.edit(watch, row.revision, {
        checks, checkedAt, nextCheckAt,
        state: terminal ? 'completed' : nextCheckAt ? (observed ? 'monitoring' : 'unavailable') : 'ended',
        reason: noSources ? 'source_changed' : terminal ? 'flight_finished' : exhausted ? 'check_limit' :
          !nextCheckAt ? 'deadline' : observed ? 'checked' : current || position ? 'no_match' : 'source_unavailable',
        ...(status ? { status, observedAt: observation!.observedAt, knownGate: status.gate ?? previous.knownGate,
          knownTerminal: status.departureTerminal ?? previous.knownTerminal } :
          statusAuthority ? {} : { status: null, observedAt: null, knownGate: null, knownTerminal: null }),
        ...(liveTracking ? { liveTracking: { ...liveTracking, state: liveState, checkedAt } } : {}),
        alertVersion,
        alert: status && changes.length ? { version: alertVersion, createdAt: checkedAt, changes, flight: status } : statusAuthority ? previous.alert : null,
      });
      if (nextCheckAt) await schedules.continueAt(graph, execution.task, nextCheckAt);
    });
  };

  return new Map<string, FunctionHandler>([
    ['readFlightStatus', async (raw, ctx) => {
      if (ctx.objects.model.scenario) throw new Conflict('Read operational flight status on the live Ontology');
      return (await variFlight(ctx)).read(searchFlight.parse(raw));
    }],
    ['readLiveFlightPosition', async (raw, ctx) => {
      return (await fr24(ctx)).read(flightPositionInput.parse(raw));
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
      const selected = settings.sources ?? [flightSource];
      if (new Set(selected).size !== selected.length) throw new Conflict('Select each flight source once');
      // An explicit VariFlight-only selection is equivalent to the existing default.
      settings.sources = selected.includes(flightPositionSource) ? flightWatchSources.filter(provider => selected.includes(provider)) : undefined;
      const authorities = new Map<Provider, string>();
      for (const provider of selected) {
        ctx.objects.access.function(ctx.objects.model, reads[provider]);
        authorities.set(provider, (await resolve[provider](ctx)).authorityId);
      }
      const positionAuthority = authorities.get(flightPositionSource);
      const action = positionAuthority ? 'RefreshFlightWatch' : 'CheckFlightWatch';
      if (positionAuthority) ctx.objects.access.function(ctx.objects.model, 'refreshFlightWatch');
      const watch = { type: flightWatchType, id: digest([ctx.principal.owner, lookup]) };
      return edit(watch, async graph => {
        for (const [provider, authorityId] of authorities) {
          if (!await authorized(ctx, provider, authorityId, { execute: true, access: graph.access, client: graph.client }))
            throw new Conflict('Flight source authorization changed before start');
        }
        const read = await readWatch(graph, watch).catch(error => {
          if (error instanceof NotFound) return null;
          throw error;
        });
        const previous = read?.previous;
        if (previous && active(previous.state) && Date.parse(previous.settings.monitorUntil) > Date.now() &&
            scheduled((await schedules.inspect(ctx.principal, previous.scheduleId, graph.client)).state)) {
          if (digest(previous.settings) !== digest(settings) || previous.sourceAuthority !== (authorities.get(flightSource) ?? null) ||
              previous.liveTracking?.authorityId !== positionAuthority) throw new Conflict('Cancel the current watch before changing it');
          return;
        }
        const scheduleId = digest([watch.id, ctx.operationId]), runAt = iso(Date.now());
        const fields = {
          settings, scheduleId, sourceAuthority: authorities.get(flightSource) ?? null, checks: 0, state: 'pending', reason: 'waiting',
          checkedAt: null, nextCheckAt: runAt, status: null, observedAt: null, knownGate: null, knownTerminal: null,
          alert: null, alertVersion: previous?.alertVersion ?? 0,
          liveTracking: positionAuthority ? { provider: flightPositionSource, authorityId: positionAuthority, state: 'pending', checkedAt: null } : null,
        };
        if (read) await graph.edit(watch, read.row.revision, fields);
        else await graph.create(watch, { ...fields, id: watch.id, name: `${settings.flightNumber} ${settings.origin}–${settings.destination}` });
        await schedules.enqueue(graph, { id: scheduleId, action, arguments: { watch }, runAt, deadline: settings.monitorUntil });
      });
    }],
    ['checkFlightWatch', check('CheckFlightWatch')],
    ['refreshFlightWatch', check('RefreshFlightWatch')],
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
      if (ctx.objects.model.scenario) throw new Conflict('Read flight watches on the live Ontology');
      const { watch } = flightWatchInput.parse(raw), { row, previous } = await readWatch(ctx.objects, watch);
      let { state, reason, nextCheckAt, alert } = previous;
      const { access, model } = ctx.objects;
      const canRead = (provider: Provider) => {
        const permission = { ontology: model.document.id, permission: 'read_source' as const, resource: resource(model.document.id, 'source', provider) };
        if (!access.allows(permission)) return false;
        access.source(model, provider);
        return true;
      };
      const { liveTracking, sourceAuthority, settings } = previous;
      let readStatus = Boolean(sourceAuthority && canRead(flightSource));
      let readPosition = Boolean(liveTracking && canRead(flightPositionSource));
      if (!readStatus && !readPosition) access.source(model, liveTracking ? flightPositionSource : flightSource);
      let positionState = liveTracking?.state;
      if (!readStatus) alert = null;
      if (liveTracking && !readPosition) positionState = 'source_changed';
      if (active(state)) {
        const expired = Date.parse(settings.monitorUntil) <= Date.now();
        const [statusCurrent, positionCurrent] = expired ? [null, null] : await Promise.all([
          readStatus && sourceAuthority && authorized(ctx, flightSource, sourceAuthority),
          readPosition && liveTracking && authorized(ctx, flightPositionSource, liveTracking.authorityId),
        ]);
        if (!expired && !statusCurrent) readStatus = false;
        if (!expired && !positionCurrent) readPosition = false;
        if (!statusCurrent) alert = null;
        if (liveTracking && !expired && !positionCurrent) positionState = 'source_changed';
        const job = statusCurrent || positionCurrent ? await schedules.inspect(ctx.principal, previous.scheduleId) : null;
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
        observedAt: readStatus ? previous.observedAt : null, status: readStatus ? previous.status : null, monitorUntil: settings.monitorUntil,
        sources: settings.sources,
        ...(liveTracking ? { liveTracking: { provider: flightPositionSource, state: positionState,
          checkedAt: readPosition ? liveTracking.checkedAt : null } } : {}),
        alertVersion: previous.alertVersion, alert,
      });
    }],
  ]);
}
