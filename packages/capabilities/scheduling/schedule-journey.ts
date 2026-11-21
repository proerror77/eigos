import { Conflict, NotFound } from '../../core/identity.js';
import { attachCalendarJourneyInput, calendarJourneyPlanLink, scheduleJourneyInput } from '../../ontology/schedule-journey.js';
import type { ObjectData, ObjectRef } from '../../ontology/schema.js';
import { PermissionDenied } from '../../runtime/access.js';
import type { FunctionHandler } from '../../runtime/functions.js';

export const scheduleJourneyFunctions = new Map<string, FunctionHandler>([
  ['attachCalendarJourneyToPlan', async (raw, context) => {
    const input = attachCalendarJourneyInput.parse(raw);
    if (!context.directAction || !context.edit || context.objects.model.scenario)
      throw new Conflict('Confirm the original plan and calendar journey through the PA');
    return context.edit(input.plan, async graph => {
      const journey = await graph.read(input.journey);
      if (journey.revision !== input.revision) throw new Conflict('Calendar journey changed before attachment');
      const [current] = await graph.follow(input.journey, 'plan');
      if (current && current.ref.id !== input.plan.id) throw new Conflict('Calendar journey already belongs to another plan');
      await graph.link({ type: calendarJourneyPlanLink, from: input.journey, to: input.plan });
    });
  }],
  ['readScheduleJourney', async (raw, { objects }) => {
    const { plan } = scheduleJourneyInput.parse(raw);
    if (plan.type !== 'SchedulePlan') throw new Conflict('Use the original SchedulePlan');
    const original = await objects.read(plan);
    const restricted = new Set<string>();
    const follow = async (from: ObjectRef, link: string) => {
      try {
        return await objects.follow(from, link);
      } catch (error) {
        if (!(error instanceof PermissionDenied || error instanceof NotFound)) throw error;
        restricted.add(from.type + '.' + link);
        return [];
      }
    };
    const [activities, calendar, trips, continuities, hotelReviews] = await Promise.all([
      follow(plan, 'activities'), follow(plan, 'calendarJourneys'), follow(plan, 'trips'),
      follow(plan, 'itineraryContinuity'), follow(plan, 'hotelDependencyReviews'),
    ]);
    const orders = new Map<string, ObjectData>();
    const collect = async (from: ObjectRef, link: string) => {
      for (const order of await follow(from, link)) orders.set(JSON.stringify(order.ref), order);
    };
    const followups = await Promise.all(continuities.map(async item => {
      const [watches, history] = await Promise.all([
        follow(item.ref, 'flightWatch'), follow(item.ref, 'stateLogs'),
        collect(item.ref, 'hotelBooking'), collect(item.ref, 'rideOrder'), collect(item.ref, 'flightBooking'),
      ]);
      await Promise.all(watches.map(watch => collect(watch.ref, 'booking')));
      return {
        ref: item.ref, revision: item.revision, state: item.properties.state,
        nextCheckAt: item.properties.nextCheckAt, automation: item.properties.automation ?? null,
        assessment: item.properties.assessment ?? null, planEdit: item.properties.planEdit ?? null,
        handoff: item.properties.handoff ?? null,
        history: history.sort((a, b) => String(a.properties.timestamp ?? '').localeCompare(String(b.properties.timestamp ?? ''))),
      };
    }));
    await Promise.all(trips.flatMap(item => ['order', 'registration', 'hotelBooking'].map(link => collect(item.ref, link))));
    return {
      plan: { ref: original.ref, revision: original.revision, name: original.properties.name },
      activities, calendarJourneys: calendar.map(item => ({
        ref: item.ref, name: item.properties.name, state: item.properties.state, nextCheckAt: item.properties.nextCheckAt,
      })),
      trips: trips.map(item => ({ ref: item.ref, state: item.properties.state })),
      originalOrders: [...orders.values()].sort((a,b) => JSON.stringify(a.ref).localeCompare(JSON.stringify(b.ref))).map(item => ({
        ref: item.ref, name: item.properties.name, state: item.properties.state ?? item.properties.issuanceState ?? null,
        evidence: item.properties.evidence ?? null, independentRead: item.properties.independentRead ?? null,
        canceled: Boolean(item.properties.cancellationReceipt) ||
          item.ref.type === 'FliggyHotelBooking' && item.properties.state === 'cancelled' && item.properties.independentRead === true,
      })),
      followups, hotelReviews, restricted: [...restricted].sort(),
    };
  }],
]);
