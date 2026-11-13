import { digest } from '../packages/core/identity.js';
import { serviceObservation, type ServiceName } from '../packages/ontology/service-contracts.js';
import type { ServiceResolver } from '../packages/capabilities/services/sources.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';

export function serviceProvider() {
  const flags = {
    active: true,
    eventStatus: 'active' as 'active' | 'canceled' | 'unknown',
    start: new Date(Date.now() + 3600000).toISOString(),
    coarse: false,
    calls: [] as ServiceName[],
    stale: false,
    observedAt: undefined as string | undefined,
  };
  const resolve: ServiceResolver = async (owner, provider) => {
    if (owner !== principal.owner) throw new Error('Wrong source owner');
    const assertCurrent = async () => {
      if (!flags.active) throw new Error('Service connection revoked');
    };
    return {
      provider,
      bindingId: 'synthetic-' + provider,
      assertCurrent,
      async read(input) {
        await assertCurrent();
        flags.calls.push(provider);
        const items =
          provider === 'Luma'
            ? [
                {
                  nativeId: 'evt-fixture',
                  name: 'Synthetic event',
                  url: 'https://luma.com/synthetic-event',
                  status: flags.eventStatus,
                  start: flags.start,
                  end: new Date(Date.parse(flags.start) + 1800000).toISOString(),
                  timeZone: 'Asia/Shanghai',
                  address: '前滩太古里',
                  locationPrecision: flags.coarse ? 'coarse' : 'exact',
                  registrationOpen: true,
                  approvalRequired: false,
                  startingPrice: 0,
                  currency: 'CNY',
                },
              ]
            : provider === 'RollingGo'
              ? [
                  {
                    nativeId: 'hotel-1',
                    name: 'Synthetic hotel',
                    address: '上海',
                    checkIn: input.checkIn,
                    nights: input.nights,
                    adults: input.adults,
                    amount: 100,
                    currency: 'CNY',
                    priceKind: 'reference',
                  },
                ]
              : [
                  {
                    nativeId: 'shop-1/variant-1',
                    name: 'Synthetic product',
                    productId: 'product-1',
                    variantId: 'variant-1',
                    sellerId: 'shop-1',
                    merchantDomain: 'fixture.myshopify.com',
                    amountMinor: 1000,
                    currency: 'CNY',
                    available: null,
                    deliveryTime: 'unknown',
                  },
                ];
        const page = { items, complete: provider === 'Luma', cursor: null },
          observedAt = flags.observedAt ?? new Date(Date.now() - (flags.stale ? 600000 : 0)).toISOString();
        return serviceObservation.parse({
          provider,
          bindingId: 'synthetic-' + provider,
          ...page,
          observedAt,
          expiresAt: new Date(Date.parse(observedAt) + 240000).toISOString(),
          evidence: 'synthetic',
          inputDigest: digest(input),
          contentDigest: digest(page),
        });
      },
    };
  };
  return { flags, resolve };
}
export async function seedPlan(f: Awaited<ReturnType<typeof fixture>>) {
  const graph = new Objects(f.db, f.model, f.access),
    plan = { type: 'SchedulePlan', id: 'service-plan' },
    resource = { type: 'ScheduleResource', id: 'personal' },
    availability = { type: 'CalendarAvailability', id: 'service-calendar' };
  const input = {
    title: 'Synthetic service plan',
    start: new Date(Date.now() - 3600000).toISOString(),
    end: new Date(Date.now() + 3 * 3600000).toISOString(),
    timeZone: 'Asia/Shanghai',
    durationMinutes: 30,
  };
  const calendar = {
    complete: true,
    start: input.start,
    end: input.end,
    timeZone: input.timeZone,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 240000).toISOString(),
    sourceVersion: 'fixture-calendar',
    evidence: 'synthetic',
    calendars: ['synthetic-personal'],
    windows: [{ start: input.start, end: input.end }],
    busy: [] as { start: string; end: string }[],
  };
  await graph.create(resource, { id: resource.id, name: 'Synthetic calendar' });
  await graph.create(availability, { id: availability.id, name: 'Synthetic availability', ...calendar });
  await graph.create(plan, {
    id: plan.id,
    name: input.title,
    start: input.start,
    end: input.end,
    timeZone: input.timeZone,
    durationMinutes: input.durationMinutes,
  });
  await graph.linkBatch([
    { type: 'PlanResource', from: plan, to: resource },
    { type: 'PlanAvailability', from: plan, to: availability },
    { type: 'ResourceAvailability', from: resource, to: availability },
  ]);
  return {
    plan,
    resource,
    availability,
    input,
    answer: () => ({
      status: 'available' as const,
      ...calendar,
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 240000).toISOString(),
    }),
  };
}
