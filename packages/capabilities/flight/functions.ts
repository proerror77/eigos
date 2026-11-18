import { z } from 'zod';
import { Conflict, NotFound, digest, requireScope } from '../../core/identity.js';
import { bookedFlightWatchConsent, bookedFlightWatchRequest, flightNumberKey, flightPositionSource, flightSource, flightStatusRead, flightWatch, flightWatchInput, flightWatchRead, flightWatchSettings, flightWatchSources, flightWatchType, searchFlight } from '../../ontology/flight.js';
import { flightPositionInput, flightPositionResult } from '../../ontology/flight-position.js';
import { fliggyFlightPublic, fliggyFlightBookingType } from '../../ontology/fliggy-flight-booking.js';
import { ObservationInterests } from '../../runtime/observation-interests.js';
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
  if ((old || previous.bookedLeg) && changedTime(old?.scheduledDeparture ?? previous.bookedLeg?.departure ?? null, status.scheduledDeparture, old?.estimatedDeparture ?? null, status.estimatedDeparture)) changes.push('departure_time');
  if ((old || previous.bookedLeg) && changedTime(old?.scheduledArrival ?? previous.bookedLeg?.arrival ?? null, status.scheduledArrival, old?.estimatedArrival ?? null, status.estimatedArrival)) changes.push('arrival_time');
  if ((previous.knownGate || previous.bookedLeg && old) && status.gate && previous.knownGate !== status.gate) changes.push('gate');
  if ((previous.knownTerminal || previous.bookedLeg && old) && status.departureTerminal && previous.knownTerminal !== status.departureTerminal) changes.push('departure_terminal');
  return changes;
}

type BookedRequest = z.infer<typeof bookedFlightWatchRequest>;
type Booking = z.infer<typeof fliggyFlightPublic>;
const day = 24 * 60 * minute;

// Keep part of the approved read budget for check-in, departure and arrival. Early
// changes get sampled across the booking horizon instead of exhausting 24 checks in six hours.
export function bookedFlightCheckDelay(departure: number, deadline: number, checksLeft: number, now: number) {
  if (checksLeft <= 1) return deadline - minute - now;
  const untilDeparture = departure - now;
  const cadence = untilDeparture > 3 * day ? 2 * day :
    untilDeparture > day ? 12 * 60 * minute : untilDeparture > 6 * 60 * minute ? 3 * 60 * minute : interval;
  const phaseEnd = untilDeparture > 3 * day ? departure - 3 * day :
    untilDeparture > day ? departure - day : untilDeparture > 6 * 60 * minute ? departure - 6 * 60 * minute : deadline;
  const budget = phaseEnd < deadline ? Math.max(1, Math.floor(checksLeft / 2)) : Math.max(1, checksLeft);
  const remaining = Math.min(phaseEnd, deadline) - now;
  return Math.max(2 * minute, Math.min(remaining, Math.max(cadence, remaining / budget)));
}

function bookingSegment(booking: Booking) {
  const leg = booking.quote.segment;
  // Jinghang accepts domestic nonstop adult fares; the partner's local times use UTC+8.
  const local = (value: string) => iso(Date.parse(value.replace(' ', 'T') + '+08:00'));
  return {flightNumber: flightNumberKey(leg.marketing_flight_no), origin: leg.dep_airport, destination: leg.arr_airport,
    departureDate: booking.search.departureDate, departure: local(leg.dep_time), arrival: local(leg.arr_time)};
}

export function flightFunctions(db: Database, functions: () => Functions, variFlight: FlightSourceResolver, fr24: FlightPositionResolver): ReadonlyMap<string, FunctionHandler> {
  const schedules = new ScheduledActions(db);
  const interests = new ObservationInterests(db);
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

  const readBooking = async (ctx: FunctionContext, ref: ObjectRef, objects = ctx.objects) => {
    if (ref.type !== fliggyFlightBookingType) throw new Conflict('Select the original Jinghang booking');
    return fliggyFlightPublic.parse(await functions().invoke(objects.model, 'readFliggyFlightBooking', {booking:ref}, {...ctx,objects}));
  };
  const bookingPin = (ctx: FunctionContext, ref: ObjectRef, booking: Booking) =>
    digest([ctx.principal.owner, ref, booking.approvalDigest, booking.outOrderNo, booking.merchantOrderId, booking.quote.segment]);
  async function checkBooked(ctx: FunctionContext, previous: Watch, watch: ObjectRef, graph: Objects) {
    if (!previous.bookedLeg) return;
    if (Date.parse(previous.settings.monitorUntil) <= Date.now()) throw new Conflict('The booked flight monitoring authorization expired');
    if (previous.bookedLeg.interestId) await interests.assertActive(graph,previous.bookedLeg.interestId,watch);
    const ref = previous.bookedLeg.booking;
    const linked = await graph.follow(watch, 'booking');
    if (linked.length !== 1 || linked[0]!.ref.type !== ref.type || linked[0]!.ref.id !== ref.id)
      throw new Conflict('Flight watch no longer links to the approved booking');
    const booking = await readBooking(ctx,ref,graph);
    if (!booking.paid || !booking.issued || !booking.independentRead || booking.closed ||
        bookingPin(ctx,ref,booking) !== previous.bookedLeg.digest)
      throw new Conflict('Original ticket or segment authorization changed');
  }

  const check = (action: 'CheckFlightWatch' | 'RefreshFlightWatch'): FunctionHandler => async (raw, ctx) => {
    const { watch } = flightWatchInput.parse(raw), { execution, edit } = ctx;
    const call = execution?.task.input.scheduledAction;
    if (!edit || !execution || !call || call.action !== action || ctx.objects.model.scenario)
      throw new Conflict('Use the original scheduled flight check');
    const { row, previous } = await readWatch(ctx.objects, watch);
    if (!active(previous.state) || previous.scheduleId !== call.scheduleId) throw new Conflict('Flight watch stopped');
    await checkBooked(ctx, previous, watch, new Objects(db,ctx.objects.model,ctx.objects.access));
    const { flightNumber, departureDate, origin, destination, maxChecks } = previous.settings;
    const { sourceAuthority, liveTracking } = previous;
    const route = { flightNumber, origin, destination };
    const nearDeparture = !previous.bookedLeg ||
      Math.abs(Date.now() - Date.parse(previous.status?.estimatedDeparture ?? previous.status?.scheduledDeparture ?? previous.bookedLeg.departure)) < 12 * 60 * minute;
    const [statusSample, positionSample] = await Promise.all([
      sample(ctx, flightSource, sourceAuthority, { ...route, departureDate }, flightStatusRead),
      nearDeparture ? sample(ctx, flightPositionSource, liveTracking?.authorityId, route, flightPositionResult) : null,
    ]);
    return edit(watch, async graph => {
      await checkBooked(ctx, previous, watch, graph);
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
      const deadline = Date.parse(call.deadline);
      const bookedDeparture = status?.estimatedDeparture ?? status?.scheduledDeparture ??
        previous.status?.estimatedDeparture ?? previous.status?.scheduledDeparture ?? previous.bookedLeg?.departure;
      const delay = previous.bookedLeg && bookedDeparture
        ? bookedFlightCheckDelay(Date.parse(bookedDeparture), deadline, maxChecks - checks, now) : interval;
      const next = Math.min(now + delay, deadline - minute);
      const nextCheckAt = noSources || terminal || exhausted || next < now + 2 * minute ? null : iso(next);
      const observed = status || matches === 1;
      const changes = status ? changesFrom(previous, status) : [];
      const alertVersion = previous.alertVersion + (changes.length || (!statusAuthority && previous.alert) ? 1 : 0);
      const liveState = !nearDeparture ? 'pending' : !positionAuthority ? 'source_changed' : matches === undefined ? 'source_unavailable' :
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

  async function start(ctx: FunctionContext, edit: NonNullable<FunctionContext['edit']>,
    settings: z.infer<typeof flightWatchSettings>, bound?: z.infer<typeof bookedFlightWatchConsent>) {
    requireScope(ctx.principal, 'tasks:read');
    requireScope(ctx.principal, 'tasks:write');
    const deadline = Date.parse(settings.monitorUntil), now = Date.now();
    if (deadline <= now + minute || deadline > now + (bound ? 31 * day : 48 * 60 * minute))
      throw new Conflict(bound ? 'Set a booked watch deadline in the next 31 days' : 'Set a flight watch deadline in the next 48 hours');
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
    const watch = { type: flightWatchType, id: digest(bound ? [ctx.principal.owner, lookup, bound.booking] : [ctx.principal.owner, lookup]) };
    if (bound && (authorities.get(flightSource) !== bound.sourceAuthorities.VariFlight ||
        positionAuthority !== bound.sourceAuthorities.Flightradar24)) throw new Conflict('Approved flight source bindings changed');
    return edit(watch, async graph => {
      for (const [provider, authorityId] of authorities) {
        if (!await authorized(ctx, provider, authorityId, { execute: true, access: graph.access, client: graph.client }))
          throw new Conflict('Flight source authorization changed before start');
      }
      let bookedLeg: Watch['bookedLeg'];
      if (bound) {
        const booking = await readBooking(ctx,bound.booking,graph);
        if (!booking.independentRead || !booking.paid || !booking.issued || booking.closed || !booking.merchantOrderId ||
            bookingPin(ctx,bound.booking,booking) !== bound.bookingDigest)
          throw new Conflict('The original independently confirmed ticket is required');
        const leg = bookingSegment(booking);
        let interestId: string | undefined;
        if (!ctx.directAction) {
          if (!ctx.execution?.task.input.scheduledAction) throw new Conflict('Use an authorized observation-interest handoff');
          const interest = await interests.assertScheduled(graph,ctx.execution.task);
          if (deadline > Date.parse(interest.deadline)) throw new Conflict('Flight observation exceeds interest authorization');
          interestId = interest.id;
        }
        bookedLeg = {booking:bound.booking,digest:bound.bookingDigest,departure:leg.departure,arrival:leg.arrival,...(interestId?{interestId}:{})};
      }
      const read = await readWatch(graph, watch).catch(error => {
        if (error instanceof NotFound) return null;
        throw error;
      });
      const previous = read?.previous;
      if (previous && active(previous.state) && Date.parse(previous.settings.monitorUntil) > Date.now() &&
          scheduled((await schedules.inspect(ctx.principal, previous.scheduleId, graph.client)).state)) {
        if (digest(previous.bookedLeg ?? null)!==digest(bookedLeg ?? null) || digest(previous.settings) !== digest(settings) || previous.sourceAuthority !== (authorities.get(flightSource) ?? null) ||
            previous.liveTracking?.authorityId !== positionAuthority) throw new Conflict('Cancel the current watch before changing it');
        return;
      }
      const scheduleId = digest([watch.id, ctx.operationId]), runAt = iso(Date.now());
      const fields = {
        ...(bookedLeg ? {bookedLeg} : {}), settings, scheduleId, sourceAuthority: authorities.get(flightSource) ?? null, checks: 0, state: 'pending', reason: 'waiting',
        checkedAt: null, nextCheckAt: runAt, status: null, observedAt: null, knownGate: null, knownTerminal: null,
        alert: null, alertVersion: (previous?.alertVersion ?? 0) + (previous?.alert ? 1 : 0),
        liveTracking: positionAuthority ? { provider: flightPositionSource, authorityId: positionAuthority, state: 'pending', checkedAt: null } : null,
      };
      if (read) await graph.edit(watch, read.row.revision, fields);
      else await graph.create(watch, { ...fields, id: watch.id, name: `${settings.flightNumber} ${settings.origin}–${settings.destination}` });
      if (bound && !read) await graph.link({type:'FliggyFlightBookingWatch',from:bound.booking,to:watch});
      await schedules.enqueue(graph, { id: scheduleId, action, arguments: { watch }, runAt, deadline: settings.monitorUntil });
      if (bookedLeg?.interestId && ctx.execution) await interests.attach(graph,bookedLeg.interestId,ctx.execution.task,{target:watch,scheduleId});
    });
  }

  function checkHorizon(request: BookedRequest, booking: Booking) {
    const deadline = Date.parse(request.monitorUntil), arrival = Date.parse(bookingSegment(booking).arrival);
    if (deadline <= Date.now()+minute || deadline > Date.now()+31*day || deadline > arrival+day || arrival+day <= Date.now())
      throw new Conflict('Use a future observation window within 31 days and at most one day after the booked arrival');
  }

  return new Map<string, FunctionHandler>([
    ['readFlightStatus', async (raw, ctx) => {
      if (ctx.objects.model.scenario) throw new Conflict('Read operational flight status on the live Ontology');
      return (await variFlight(ctx)).read(searchFlight.parse(raw));
    }],
    ['readLiveFlightPosition', async (raw, ctx) => {
      return (await fr24(ctx)).read(flightPositionInput.parse(raw));
    }],
    ['startFlightWatch', (raw,ctx) => start(ctx,direct(ctx),flightWatchSettings.parse(raw))],
    ['prepareBookedFlightWatch',async(raw,ctx)=>{
      const request=bookedFlightWatchRequest.parse(raw);
      const booking=await readBooking(ctx,request.booking);
      if (!booking.merchantOrderId || !booking.independentRead || booking.closed)
        throw new Conflict('Prepare monitoring against a verified original open Jinghang order');
      const sources=request.sources??[flightSource];
      if (!sources.includes(flightSource) || new Set(sources).size!==sources.length)
        throw new Conflict('Select VariFlight for the booked segment and optionally one live position source');
      const sourceAuthorities:Partial<Record<Provider,string>>={};
      for(const source of sources){
        ctx.objects.access.function(ctx.objects.model,reads[source]);
        sourceAuthorities[source]=(await resolve[source](ctx)).authorityId;
      }
      checkHorizon(request,booking);
      return bookedFlightWatchConsent.parse({...request,sources,sourceAuthorities,bookingDigest:bookingPin(ctx,request.booking,booking)});
    }],
    ['startBookedFlightWatch',async(raw,ctx)=>{
      const bound=bookedFlightWatchConsent.parse(raw);
      if (!ctx.edit || ctx.objects.model.scenario || (!ctx.directAction && !ctx.execution?.task.input.scheduledAction))
        throw new Conflict('Use the explicit booked flight watch Action or its authorized handoff');
      const booking=await readBooking(ctx,bound.booking);
      checkHorizon(bound,booking);
      const segment=bookingSegment(booking);
      return start(ctx,ctx.edit,flightWatchSettings.parse({flightNumber:segment.flightNumber,departureDate:segment.departureDate,
        origin:segment.origin,destination:segment.destination,monitorUntil:bound.monitorUntil,maxChecks:bound.maxChecks,sources:bound.sources}),bound);
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
      if (previous.bookedLeg) {
        try { await checkBooked(ctx,previous,watch,new Objects(db,model,access)); }
        catch(error) {
          if (!(error instanceof Conflict || error instanceof PermissionDenied || error instanceof NotFound)) throw error;
          return flightWatchRead.parse({watch,revision:row.revision,state:'ended',reason:Date.parse(previous.settings.monitorUntil)<=Date.now()?'deadline':'source_changed',checks:previous.checks,
            nextCheckAt:null,checkedAt:previous.checkedAt,status:null,observedAt:null,monitorUntil:previous.settings.monitorUntil,
            sources:previous.settings.sources,alertVersion:previous.alertVersion,alert:null});
        }
      }
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
      if (active(state) || previous.bookedLeg) {
        const expired = Date.parse(settings.monitorUntil) <= Date.now();
        const [statusCurrent, positionCurrent] = expired ? [null, null] : await Promise.all([
          readStatus && sourceAuthority && authorized(ctx, flightSource, sourceAuthority),
          readPosition && liveTracking && authorized(ctx, flightPositionSource, liveTracking.authorityId),
        ]);
        if (!expired && !statusCurrent) readStatus = false;
        if (!expired && !positionCurrent) readPosition = false;
        if (!statusCurrent) alert = null;
        if (liveTracking && !expired && !positionCurrent) positionState = 'source_changed';
        const job = active(state) && (statusCurrent || positionCurrent) ? await schedules.inspect(ctx.principal, previous.scheduleId) : null;
        if (active(state) && (!job || !scheduled(job.state))) {
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
