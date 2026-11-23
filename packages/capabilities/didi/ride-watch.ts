import { Conflict, digest, NotFound, PermissionDenied } from '../../core/identity.js';
import {
  ridePosition, rideProgress, rideWatchClosed, rideWatchFields, rideWatchRead,
  rideWatchRef, rideWatchStart, rideWatchType, type rideWatchState,
} from '../../ontology/ride-watch.js';
import { rideCancellationReceipt } from '../../ontology/travel.js';
import type { ObjectData, ObjectRef } from '../../ontology/schema.js';
import type { Database } from '../../runtime/database.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import type { Objects } from '../../runtime/objects.js';
import { ScheduledActions } from '../../runtime/scheduled-actions.js';
import { originalDidiOrderAuthority } from './original-order.js';
import type { DidiFollowup, SourceResolver } from './functions.js';
import type { z } from 'zod';

type State = z.infer<typeof rideWatchState>;
type Watch = z.infer<typeof rideWatchFields>;
type Progress = z.infer<typeof rideProgress>;

const minute = 60_000;
const iso = (value: number) => new Date(value).toISOString();
const providerStates = new Map<number, State>([
  [0, 'matching'], [1, 'driver_assigned'], [2, 'driver_arrived'], [4, 'in_trip'], [5, 'completed'],
]);
const ranks: Partial<Record<State, number>> = {
  watching: -1, matching: 0, driver_assigned: 1, driver_arrived: 2, in_trip: 3,
};

function nextCheck(now: number, delay: number, expiresAt: string) {
  return iso(Math.min(now + delay, Date.parse(expiresAt)));
}

function withdrawal(watch: Watch) {
  return { arrival: null, arrivalVersion: watch.arrivalVersion + (watch.arrival ? 1 : 0) };
}

function observedUpdate(watch: Watch, progress: Progress, now: number): Partial<Watch> {
  const observedState = providerStates.get(progress.statusCode) ?? 'provider_terminal';
  if ((ranks[observedState] ?? Infinity) < (ranks[watch.state] ?? -1)) {
    // An older phase cannot reset an arrival or regress the user's status.
    return { failures: 0, nextCheckAt: nextCheck(now, watch.state === 'in_trip' || watch.state === 'driver_arrived' ? minute : minute / 2, watch.expiresAt) };
  }
  const firstArrival = observedState === 'driver_arrived' && watch.arrivalAt === null;
  const arrivalVersion = watch.arrivalVersion + 1;
  const arrival = firstArrival
    ? { arrivalAt: progress.observedAt, arrivalVersion, arrival: watch.notifyArrival ? {
      version: arrivalVersion, observedAt: progress.observedAt, validUntil: iso(Math.min(now + 2 * minute, Date.parse(watch.expiresAt))),
    } : null }
    : observedState !== 'driver_arrived' ? withdrawal(watch) : {};
  return {
    state: observedState, statusCode: progress.statusCode, observedAt: progress.observedAt,
    contentDigest: progress.contentDigest,
    driver: rideWatchClosed.has(observedState) ? null : progress.driver,
    distanceKm: rideWatchClosed.has(observedState) ? null : progress.distanceKm,
    etaMinutes: rideWatchClosed.has(observedState) ? null : progress.etaMinutes,
    reason: observedState === 'provider_terminal' ? 'provider_terminal' : 'provider_status', failures: 0,
    nextCheckAt: rideWatchClosed.has(observedState) ? null : nextCheck(now,
      observedState === 'matching' || observedState === 'driver_assigned' ? minute / 2 : minute, watch.expiresAt),
    ...arrival,
  };
}

function sourceFailure(watch: Watch, now: number): Partial<Watch> {
  const failures = watch.failures + 1;
  const retryAt = failures < 3 ? nextCheck(now, minute * 2 ** (failures - 1), watch.expiresAt) : null;
  if (retryAt) return { failures, nextCheckAt: retryAt, reason: 'source_retry' };
  return { state: 'unavailable', reason: 'source_unavailable', failures, nextCheckAt: null,
    driver: null, distanceKm: null, etaMinutes: null, ...withdrawal(watch) };
}

async function watchRow(objects: FunctionContext['objects'], watch: ObjectRef) {
  if (watch.type !== rideWatchType) throw new Conflict('Use an original DiDi ride watch');
  const row = await objects.read(watch);
  return { row, value: rideWatchFields.parse(row.properties) };
}

async function linkedOrder(objects: FunctionContext['objects'], watch: ObjectRef) {
  const orders = await objects.follow(watch, 'order');
  if (orders.length !== 1) throw new Conflict('Watch lacks one original order');
  return orders[0]!;
}

const isCanceled = (order: ObjectData) => rideCancellationReceipt.safeParse(order.properties.cancellationReceipt).success;
const canceledWatch = (watch: Watch) => ({
  state: 'provider_terminal' as const, reason: 'provider_terminal' as const, nextCheckAt: null,
  driver: null, distanceKm: null, etaMinutes: null, ...withdrawal(watch),
});

export function didiRideWatchFunctions(db: Database, resolveSource: SourceResolver): Map<string, FunctionHandler> {
  const schedules = new ScheduledActions(db);
  async function sourceFor(order: ObjectRef, ctx: FunctionContext, followup?: DidiFollowup) {
    if (order.type !== 'DidiRideOrder') throw new Conflict('Use a linked DiDi order');
    const row = await ctx.objects.read(order);
    const authorityId = await originalDidiOrderAuthority(ctx.objects, row);
    const { bindingId, orderId } = row.properties;
    if (typeof bindingId !== 'string' || !bindingId || typeof orderId !== 'string' || !orderId)
      throw new Conflict('Original ride authority is unavailable');
    const source = await resolveSource(ctx.principal.owner, { bindingId, orderId, authorityId,
      ...(followup ? { followup, db, execution: ctx.execution } : {}) });
    const authority = source.authorityId ?? digest(source.bindingId);
    await source.assertCurrent();
    if ((!source.followup && bindingId !== source.bindingId) || authorityId !== authority || !source.orders?.observe) {
      throw new Conflict('Original ride source authority is unavailable');
    }
    return { source, orders: source.orders, authority, orderId };
  }

  return new Map<string, FunctionHandler>([
    ['startDidiRideWatch', async (raw, ctx) => {
      const { order, expiresAt, notifyArrival } = rideWatchStart.parse(raw);
      if (!ctx.edit || ctx.objects.model.scenario) throw new Conflict('Start tracking through a live Action');
      const now = Date.now(), end = Date.parse(expiresAt);
      if (end < now + minute || end > now + 4 * 60 * minute) throw new Conflict('Ride tracking needs a window of one minute to four hours');
      if (isCanceled(await ctx.objects.read(order))) throw new Conflict('The original ride is canceled');
      const { authority, source } = await sourceFor(order, ctx);
      if (source.followup && Date.parse(source.followup.expiresAt) < end)
        throw new Conflict('The PA follow-up authorization must cover the requested tracking window');
      const watch = { type: rideWatchType, id: digest([rideWatchType, order.id]) };
      const prior = await watchRow(ctx.objects, watch).catch(error => {
        if (error instanceof NotFound) return null;
        throw error;
      });
      const same = (value: Watch) => value.expiresAt === expiresAt &&
        value.notifyArrival === notifyArrival && value.sourceAuthority === authority;
      if (prior && !same(prior.value)) throw new Conflict('This original order already has a tracking authorization');
      return ctx.edit(watch, async graph => {
        if (isCanceled(await graph.read(order))) throw new Conflict('The original ride is canceled');
        const existing = await watchRow(graph, watch).catch(error => {
          if (error instanceof NotFound) return null;
          throw error;
        });
        if (existing) {
          if (!same(existing.value)) throw new Conflict('This original order already has a tracking authorization');
          return;
        }
        const value: Watch = { id: watch.id, name: 'DiDi ride tracking', state: 'watching', reason: 'awaiting_provider',
          statusCode: null, observedAt: null, contentDigest: null, driver: null, distanceKm: null, etaMinutes: null,
          expiresAt, nextCheckAt: iso(now), scheduleId: watch.id, sourceAuthority: authority, notifyArrival,
          failures: 0, arrivalAt: null, arrivalVersion: 0, arrival: null,
          ...(source.followup ? { followup: source.followup } : {}) };
        await graph.create(watch, value);
        await graph.link({ type: 'RideWatchOrder', from: watch, to: order });
        await schedules.enqueue(graph, { id: value.scheduleId, action: 'CheckDidiRideWatch',
          arguments: { watch }, runAt: value.nextCheckAt!, deadline: iso(end + minute), sourceTaskId: ctx.taskId });
      });
    }],
    ['checkDidiRideWatch', async (raw, ctx) => {
      const { watch } = rideWatchRef.parse(raw);
      const { row, value } = await watchRow(ctx.objects, watch), task = ctx.execution?.task;
      const scheduled = task?.input.scheduledAction;
      if (!ctx.edit || !scheduled || !task || scheduled.scheduleId !== value.scheduleId) throw new Conflict('Use the original scheduled observation');
      if (rideWatchClosed.has(value.state)) return ctx.edit(watch, async () => {});
      const ended = () => Date.now() >= Date.parse(value.expiresAt);
      const expired = { state: 'expired', reason: 'expired', nextCheckAt: null,
        driver: null, distanceKm: null, etaMinutes: null, ...withdrawal(value) };
      if (ended()) return ctx.edit(watch, graph => graph.edit(watch, row.revision, expired));
      const order = await linkedOrder(ctx.objects, watch);
      if (isCanceled(order)) return ctx.edit(watch, graph => graph.edit(watch, row.revision, canceledWatch(value)));
      let progress: Progress | null;
      try {
        const { source, orders, authority, orderId } = await sourceFor(order.ref, ctx, value.followup);
        if (authority !== value.sourceAuthority) throw new Conflict('Original ride source authority changed');
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, Date.parse(value.expiresAt) - Date.now()))]);
        progress = rideProgress.parse(await ctx.execution!.tasks.readSource(task, 'ride-observation:' + (task.execution_step ?? 0),
          { order: order.ref, authority, orderId }, () => orders.observe!(orderId, signal)));
        await source.assertCurrent();
        if (progress.orderId !== orderId) throw new Conflict('Original provider order identity changed');
      } catch (error) {
        if (error instanceof PermissionDenied) throw error;
        progress = null;
      }
      ctx.signal.throwIfAborted();
      const now = Date.now();
      return ctx.edit(watch, async graph => {
        const changes = isCanceled(await graph.read(order.ref)) ? canceledWatch(value)
          : ended() ? expired : progress ? observedUpdate(value, progress, now) : sourceFailure(value, now);
        await graph.edit(watch, row.revision, changes);
        if (changes.nextCheckAt) await schedules.continueAt(graph, task, changes.nextCheckAt);
      });
    }],
    ['stopDidiRideWatch', async (raw, ctx) => {
      const { watch } = rideWatchRef.parse(raw);
      const { row, value } = await watchRow(ctx.objects, watch);
      if (!ctx.edit) throw new Conflict('Stop tracking through an Action');
      return ctx.edit(watch, async graph => {
        if (rideWatchClosed.has(value.state)) return;
        const job = await schedules.inspect(ctx.principal, value.scheduleId, graph.client);
        if (['scheduled', 'submitted', 'working', 'input-required', 'blocked'].includes(job.state))
          await schedules.cancel(graph, value.scheduleId);
        await graph.edit(watch, row.revision, { state: 'stopped', reason: 'stopped', nextCheckAt: null, ...withdrawal(value) });
      });
    }],
    ['readDidiRideWatch', async (raw, ctx) => {
      const { watch } = rideWatchRef.parse(raw), { row, value } = await watchRow(ctx.objects, watch);
      const order = await linkedOrder(ctx.objects, watch);
      let { state, reason, nextCheckAt, arrival, driver, distanceKm, etaMinutes } = value;
      if (!rideWatchClosed.has(state) && isCanceled(order)) {
        ({ state, reason, nextCheckAt, arrival, driver, distanceKm, etaMinutes } = canceledWatch(value));
      }
      if (!rideWatchClosed.has(state) && Date.now() >= Date.parse(value.expiresAt)) {
        state = 'expired'; reason = 'expired'; nextCheckAt = null; arrival = null;
        driver = null; distanceKm = null; etaMinutes = null;
      }
      if (arrival && Date.now() >= Date.parse(arrival.validUntil)) arrival = null;
      if (!rideWatchClosed.has(state) && nextCheckAt) {
        const job = await schedules.inspect(ctx.principal, value.scheduleId);
        if (['failed', 'blocked', 'canceled', 'expired'].includes(job.state)) {
          state = 'unavailable'; reason = 'source_unavailable'; nextCheckAt = null; arrival = null;
          driver = null; distanceKm = null; etaMinutes = null;
        }
      }
      if (arrival) {
        ctx.objects.access.source(ctx.objects.model, 'Didi');
        const { authority } = await sourceFor(order.ref, ctx, value.followup);
        if (authority !== value.sourceAuthority) throw new Conflict('Original ride source authority changed');
      }
      if (!value.observedAt || Date.now() - Date.parse(value.observedAt) >= 2 * minute) {
        distanceKm = null; etaMinutes = null;
      }
      return rideWatchRead.parse({ watch, order: order.ref, revision: row.revision, state, reason, nextCheckAt, arrival,
        driver, distanceKm, etaMinutes, statusCode: value.statusCode, observedAt: value.observedAt,
        contentDigest: value.contentDigest, expiresAt: value.expiresAt, arrivalAt: value.arrivalAt,
        arrivalVersion: value.arrivalVersion, settlement: 'unverified' });
    }],
    ['readDidiDriverPosition', async (raw, ctx) => {
      const { watch } = rideWatchRef.parse(raw), { value } = await watchRow(ctx.objects, watch);
      if (!['driver_assigned', 'driver_arrived', 'in_trip'].includes(value.state) || Date.now() >= Date.parse(value.expiresAt))
        throw new Conflict('Driver position requires a current ride');
      const order = await linkedOrder(ctx.objects, watch);
      if (isCanceled(order)) throw new Conflict('The original ride is canceled');
      const { source, orders, orderId, authority } = await sourceFor(order.ref, ctx, value.followup);
      if (authority !== value.sourceAuthority || !orders.driverPosition) throw new Conflict('Current driver position is unavailable');
      const point = ridePosition.parse(await orders.driverPosition(orderId, ctx.signal));
      await source.assertCurrent();
      return point;
    }],
  ]);
}
