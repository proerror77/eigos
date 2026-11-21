import { z } from 'zod';
import { Conflict, NotFound, SourceReadFailure, digest } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import {
  fliggyHotelBooking, fliggyHotelBookingApproval, fliggyHotelBookingInput, fliggyHotelBookingRef,
  fliggyHotelBookingType, fliggyHotelPublic, hotelRate, hotelRateInput, hotelSelection,
} from '../../ontology/fliggy-hotel.js';
import type { ObjectRef } from '../../ontology/schema.js';
import type { Database, Sql } from '../../runtime/database.js';
import { ExternalOperations } from '../../runtime/external-operations.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { OrderObservation } from '../../runtime/order-observation.js';
import { topIdentifier, topNumber, type FliggyHotelResolver } from './top.js';

type Hotel = Awaited<ReturnType<FliggyHotelResolver>>;
type Selection = z.infer<typeof hotelSelection>;
type Booking = z.infer<typeof fliggyHotelBooking>;
const minor = z.number().int().nonnegative().safe();
const dateTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const time = /^([01]\d|2[0-3]):[0-5]\d$/;
const name = z.string().trim().min(1).max(100);
const cancellation = fliggyHotelBooking.shape.cancellation;
const quoteResponse = z.object({
  hid: topIdentifier, rate_plan_id: topIdentifier, create_key: z.string().min(1).max(4096),
  rate_plan_info: z.object({
    display_name: name, total_room_price: minor, after_promotion_price: minor.optional(),
    earliest_check_in_time: z.string().regex(time), latest_check_out_time: z.string().regex(time),
    max_booking_num: z.number().int().nonnegative(), max_occupancy_num: z.number().int().nonnegative(),
    cancel_policy_do: z.object({
      cancel_policy_type: z.number().int(),
      policy_info: z.union([cancellation.shape.policy_info.unwrap(), z.object({
        cancel_policy_info_d_o: cancellation.shape.policy_info.unwrap(),
      })]).optional(),
    }),
  }),
});
const detailResponse = z.object({
  order_base_info: z.object({
    fliggy_order_id: topIdentifier, dis_order_id: z.string(), order_status: z.number().int(),
    total_room_price: minor, total_actual_price: minor.optional(),
    settle_currency_code: z.string().optional(), is_checked_in: z.boolean().optional(),
  }),
  hotel_info: z.object({ hid: topIdentifier }),
  order_fulfill_info: z.object({
    check_in: z.string().regex(dateTime), check_out: z.string().regex(dateTime),
    room_number: z.number().int().positive(),
  }),
});
const guestProfiles = z.array(z.strictObject({
  id: hotelSelection.shape.profileId, expiresAt: z.iso.datetime(),
  contact: z.strictObject({ name, phone: z.string().regex(/^\+?[0-9]{7,20}$/), email: z.email().optional() }),
  rooms: z.array(z.array(name).min(1).max(4)).min(1).max(8),
})).max(100);
const receivedPayments = z.array(z.strictObject({
  orderId: z.string(), outOrderId: z.string(), receiptId: z.string().min(1).max(256),
  amountMinor: minor, currency: z.literal('CNY'), receivedAt: z.iso.datetime(),
})).max(500);
const states: Partial<Record<number, Booking['state']>> = {
  1: 'awaiting_payment', 2: 'pending_confirmation', 3: 'confirmed', 4: 'completed',
  5: 'refund_pending', 6: 'refund_rejected', 7: 'closed', 8: 'cancelled',
};

async function profile(hotel: Hotel, selection: Selection) {
  const matches = guestProfiles.parse(JSON.parse(await readPrivateSourceFile(hotel.profilesFile)))
    .filter(guest => guest.id === selection.profileId && Date.parse(guest.expiresAt) > Date.now());
  const [guest] = matches;
  if (matches.length !== 1 || !guest || guest.rooms.length !== selection.rooms
    || guest.rooms.some(room => room.length !== selection.adultsPerRoom))
    throw new Conflict('The private guest profile does not match the specified adult occupancy');
  return guest;
}

function terms(selection: Selection, hotel: Hotel) {
  return {
    rate_plan_id: topNumber(selection.ratePlanId), item_id: topNumber(selection.itemId),
    distributor: hotel.distributor, number_of_rooms: selection.rooms, number_of_adults_per_room: selection.adultsPerRoom,
    check_in: selection.checkIn + ' ' + selection.arrivalTime + ':00', check_out: selection.checkOut + ' ' + selection.checkOutTime + ':00',
  };
}

const ratesResponse = z.object({ error_code: z.literal(0), module: z.object({
  hotel_prices: z.object({ hotel_price: z.array(z.object({
    shid: topIdentifier, name, room_prices: z.object({ room_price: z.array(z.object({
      name, rate_prices: z.object({ rate_price: z.array(z.unknown()).max(250) }),
    })).max(250) }),
  })).max(1) }).optional(),
}) });
const rateItem = z.object({
  item_id: topIdentifier, rateplan_id: topIdentifier, currency_code: z.literal('CNY'),
  checkin_checkout_prices: z.object({ check_in_check_out_price: z.array(z.object({
    checkin_date: z.iso.date(), checkout_date: z.iso.date(), price: minor,
  })).max(60) }),
  cancel_policy_desc: z.string().max(1000).optional(),
});

async function readRates(hotel: Hotel, input: z.infer<typeof hotelRateInput>, signal: AbortSignal) {
  if (input.checkOut <= input.checkIn || input.checkIn < new Date(Date.now() + 28800000).toISOString().slice(0, 10))
    throw new Conflict('Select a future overnight stay for the Fliggy rate');
  const response = ratesResponse.parse(await hotel.call('rates', {
    shids: input.standardHotelId, checkin_date: input.checkIn, checkout_date: input.checkOut, is_calendar: 'false',
  }, signal));
  const property = response.module.hotel_prices?.hotel_price[0];
  if (!property) return [];
  if (property.shid !== input.standardHotelId) throw new Conflict('Fliggy returned a different hotel');
  return property.room_prices.room_price.flatMap(room => room.rate_prices.rate_price.flatMap(candidate => {
    const result = rateItem.safeParse(candidate);
    if (!result.success) return [];
    const rate = result.data;
    const prices = rate.checkin_checkout_prices.check_in_check_out_price.filter(price =>
      price.checkin_date === input.checkIn && price.checkout_date === input.checkOut);
    if (prices.length !== 1) return [];
    return [hotelRate.parse({
      itemId: rate.item_id, ratePlanId: rate.rateplan_id, hotelName: property.name, roomName: room.name,
      displayAmountMinor: prices[0]!.price, currency: rate.currency_code, cancellationDescription: rate.cancel_policy_desc,
    })];
  }));
}

async function quote(selection: Selection, hotel: Hotel, signal: AbortSignal) {
  const chinaToday = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
  if (selection.checkIn < chinaToday || selection.checkOut <= selection.checkIn)
    throw new Conflict('Hotel dates must describe a future overnight stay');
  const raw = quoteResponse.parse(await hotel.call('validate', terms(selection, hotel), signal));
  const rate = raw.rate_plan_info;
  if (raw.rate_plan_id !== selection.ratePlanId
    || rate.max_booking_num < selection.rooms || rate.max_occupancy_num < selection.adultsPerRoom
    || rate.earliest_check_in_time > selection.arrivalTime || rate.latest_check_out_time < selection.checkOutTime)
    throw new Conflict('Fliggy rate does not match the selected hotel, occupancy or arrival window');
  const rules = rate.cancel_policy_do.policy_info;
  const policy = cancellation.parse({
    cancel_policy_type: rate.cancel_policy_do.cancel_policy_type,
    policy_info: Array.isArray(rules) ? rules : rules?.cancel_policy_info_d_o,
  });
  const amountMinor = rate.after_promotion_price ?? rate.total_room_price;
  if (amountMinor !== rate.total_room_price)
    throw new Conflict('This distribution booking requires a non-promotional rate');
  return {
    createKey: raw.create_key, merchantHotelId: raw.hid, name: rate.display_name, totalRoomPrice: rate.total_room_price,
    amountMinor, cancellation: policy, checkOutTime: rate.latest_check_out_time,
  };
}

function stage(ctx: FunctionContext) {
  if (!ctx.edit || ctx.objects.model.scenario) throw new Conflict('Use a formal Fliggy hotel Action');
  return ctx.edit;
}

export function fliggyHotelFunctions(db: Database, resolve: FliggyHotelResolver): ReadonlyMap<string, FunctionHandler> {
  const operations = new ExternalOperations(db);
  const observation = new OrderObservation(db, 'RefreshFliggyHotelBooking');
  const supportsObservation = (ctx: FunctionContext) =>
    Boolean(ctx.objects.model.object(fliggyHotelBookingType).properties.cancellationObservation);
  const cancellationTerminal = (state: Booking['state']) =>
    ['cancelled', 'closed', 'refund_rejected', 'completed'].includes(state);
  const current = async (ctx: FunctionContext, ref: ObjectRef) => {
    if (ref.type !== fliggyHotelBookingType) throw new Conflict('Reference the original Fliggy hotel booking');
    const hotel = await resolve(ctx.principal.owner), row = await ctx.objects.read(ref);
    const booking = fliggyHotelBooking.parse(row.properties);
    if (booking.authority !== hotel.authority || booking.evidence !== hotel.evidence)
      throw new Conflict('The Fliggy hotel booking uses a different connection');
    return { hotel, row, booking };
  };
  const readProvider = async (hotel: Hotel, booking: Booking, signal: AbortSignal) => {
    const result = detailResponse.parse(await hotel.call('detail', {
      distributor: hotel.distributor, dis_order_id: booking.outOrderId,
    }, signal));
    const base = result.order_base_info, stay = result.order_fulfill_info;
    if (base.dis_order_id !== booking.outOrderId || (booking.merchantOrderId && base.fliggy_order_id !== booking.merchantOrderId)
      || result.hotel_info.hid !== booking.merchantHotelId || base.total_room_price !== booking.totalRoomPrice || base.settle_currency_code && base.settle_currency_code !== 'CNY'
      || (base.total_actual_price ?? 0) > 0 && base.total_actual_price !== booking.amountMinor
      || !stay.check_in.startsWith(booking.selection.checkIn) || !stay.check_out.startsWith(booking.selection.checkOut)
      || stay.room_number !== booking.selection.rooms)
      throw new Conflict('Fliggy order details differ from the approved original booking');
    const state = states[base.order_status] ?? 'unknown';
    const earlierFulfilmentState = ['awaiting_payment', 'pending_confirmation', 'confirmed'].includes(state);
    if (booking.independentRead && earlierFulfilmentState && ['refund_pending', 'cancelled', 'closed'].includes(booking.state))
      throw new Conflict('Fliggy detail contradicts the previously observed order state');
    return { merchantOrderId: base.fliggy_order_id, state,
      checkedIn: base.is_checked_in, observedAt: new Date().toISOString() };
  };
  const project = (ctx: FunctionContext, ref: ObjectRef, row: { revision: number }, hotel: Hotel,
    details: Awaited<ReturnType<typeof readProvider>>) => {
    const { checkedIn: _checkedIn, ...facts } = details;
    return stage(ctx)(ref, async graph => {
      await hotel.assertCurrent();
      await graph.edit(ref, row.revision, { ...facts, independentRead: true });
    });
  };
  const approve = (ctx: FunctionContext, input: z.infer<typeof fliggyHotelBookingApproval>, booking: Booking) => {
    if (!ctx.directAction || !ctx.assertDispatch || booking.approvalDigest !== input.approvedDigest
      || input.amountMinor !== booking.amountMinor)
      throw new Conflict('The authenticated PA must explicitly approve the exact Fliggy hotel booking and amount');
    return ctx.assertDispatch;
  };
  const operationKey = (booking: Booking, action: string) => digest(['fliggy-hotel', booking.outOrderId, action]);
  const scope = (booking: Booking, action: string) =>
    ({ approved: booking.approvalDigest, authority: booking.authority, outOrderId: booking.outOrderId, action });
  const dispatchGuard = (ctx: FunctionContext, booking: Booking, ref: ObjectRef, revision: number, hotel: Hotel,
    assertDispatch: (client: Sql) => Promise<void>, opposingAction?: string) => async (client: Sql) => {
    await assertDispatch(client);
    await hotel.assertCurrent();
    const rows = await db.query(
      `SELECT revision FROM ${db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`,
      [ctx.objects.model.projection, ctx.principal.owner, ref.type, ref.id], client,
    );
    if (Number(rows.rows[0]?.revision) !== revision) throw new Conflict('The Fliggy hotel booking changed');
    if (opposingAction && (await db.query(
      `SELECT 1 FROM ${db.schema}.external_operations WHERE owner=$1 AND operation_key=$2`,
      [ctx.principal.owner, operationKey(booking, opposingAction)], client,
    )).rowCount) throw new Conflict('Reconcile the original Fliggy operation before this action');
  };
  return new Map<string, FunctionHandler>([
    ['readFliggyHotelRates', async (raw, ctx) => {
      const hotel = await resolve(ctx.principal.owner);
      return { rates: (await readRates(hotel, hotelRateInput.parse(raw), ctx.signal)).slice(0, 20), complete: false };
    }],
    ['prepareFliggyHotelBooking', async (raw, ctx) => {
      const edit = stage(ctx), { bookingKey, selection } = fliggyHotelBookingInput.parse(raw);
      const hotel = await resolve(ctx.principal.owner);
      const [guests, rates, quoteResult] = await Promise.all([
        profile(hotel, selection), readRates(hotel, selection, ctx.signal), quote(selection, hotel, ctx.signal),
      ]);
      if (!rates.some(rate => rate.itemId === selection.itemId && rate.ratePlanId === selection.ratePlanId))
        throw new Conflict('This distribution rate is unavailable for the selected standard hotel and dates');
      const { createKey: _createKey, ...reviewed } = quoteResult;
      const ref = { type: fliggyHotelBookingType, id: digest([ctx.principal.owner, hotel.authority, bookingKey]) };
      const profileDigest = digest(guests), approvalDigest = digest([selection, reviewed, profileDigest, hotel.authority]);
      return edit(ref, async graph => {
        await hotel.assertCurrent();
        const existing = await graph.read(ref).catch(error => { if (!(error instanceof NotFound)) throw error; });
        if (existing) {
          if (existing.properties.approvalDigest !== approvalDigest) throw new Conflict('The booking key is already bound to different terms');
          return;
        }
        await graph.create(ref, {
          id: ref.id, selection, authority: hotel.authority, profileDigest, approvalDigest,
          name: reviewed.name, merchantHotelId: reviewed.merchantHotelId, totalRoomPrice: reviewed.totalRoomPrice,
          amountMinor: reviewed.amountMinor, currency: 'CNY', cancellation: reviewed.cancellation,
          outOrderId: BigInt('0x' + ref.id.slice(0, 15)).toString(), merchantOrderId: null,
          expiresAt: new Date(Date.now() + 300000).toISOString(), observedAt: new Date().toISOString(),
          state: 'previewed', independentRead: false, evidence: hotel.evidence,
        });
      });
    }],
    ['createFliggyHotelBooking', async (raw, ctx) => {
      stage(ctx);
      const input = fliggyHotelBookingApproval.parse(raw), { booking: ref } = input;
      const { booking, row, hotel } = await current(ctx, ref);
      const verify = dispatchGuard(ctx, booking, ref, row.revision, hotel, approve(ctx, input, booking));
      const guard = async (client: Sql) => {
        await verify(client);
        if (Date.parse(booking.expiresAt) <= Date.now()) throw new Conflict('The reviewed hotel rate expired before dispatch');
      };
      const key = operationKey(booking, 'create'), approved = scope(booking, 'create');
      if (!await operations.recover(ctx.principal.owner, key, approved, ctx.objects)) {
        if (booking.state !== 'previewed' || Date.parse(booking.expiresAt) <= Date.now())
          throw new Conflict('Obtain a fresh hotel rate preview before creating this order');
        const guests = await profile(hotel, booking.selection);
        const { createKey, ...fresh } = await quote(booking.selection, hotel, ctx.signal);
        if (digest([booking.selection, fresh, digest(guests), hotel.authority]) !== booking.approvalDigest)
          throw new Conflict('Fliggy hotel price, terms or guests changed after review');
        const request = terms(booking.selection, hotel);
        await operations.run(ctx.principal.owner, key, approved, guard, async () => {
          const response = z.object({ out_order_id: z.string(), tid: topIdentifier }).parse(await hotel.call('create', {
            ...request,
            out_order_id: booking.outOrderId, create_key: createKey, total_room_price: booking.totalRoomPrice,
            hotel_order_validate_do: { promotion_total_price: 0 }, hotel_contact: guests.contact,
            hotel_arrival_time: { earliest_arrival_time: request.check_in, latest_arrival_time: request.check_in },
            customers: JSON.stringify(Object.fromEntries(guests.rooms.map((room, i) =>
              [i + 1, room.map(name => ({ name, customerType: 1 }))]))),
          }, ctx.signal));
          if (response.out_order_id !== booking.outOrderId) throw new Conflict('Fliggy returned a different distributor order');
          return { merchantOrderId: response.tid };
        }, ctx.objects, { requestId: ctx.operationId, taskId: ctx.taskId });
      }
      const receipt = await operations.recover<{ merchantOrderId: string }>(ctx.principal.owner, key, approved, ctx.objects);
      if (!receipt) throw new Conflict('The original Fliggy booking has no creation receipt');
      return project(ctx, ref, row, hotel, await readProvider(hotel, { ...booking, ...receipt }, ctx.signal));
    }],
    ['refreshFliggyHotelBooking', async (raw, ctx) => {
      stage(ctx);
      const { booking: ref } = fliggyHotelBookingRef.parse(raw);
      const { booking, row, hotel } = await current(ctx, ref);
      const key = operationKey(booking, 'create');
      if (!booking.merchantOrderId && !await operations.inspect(ctx.principal.owner, key))
        throw new Conflict('The hotel preview has no submitted order');
      const task = observation.task(ctx, ref);
      const read = () => readProvider(hotel, booking, ctx.signal);
      let provider: Awaited<ReturnType<typeof read>>;
      try {
        provider = task
          ? await ctx.execution!.tasks.readSource(task, 'hotel-order-detail:' + (task.execution_step ?? 0),
            { booking: ref, authority: booking.authority, outOrderId: booking.outOrderId }, async () => {
              try { return await read(); }
              catch (cause) {
                ctx.signal.throwIfAborted();
                await hotel.assertCurrent();
                throw new SourceReadFailure('Original hotel order could not be verified', { cause });
              }
            })
          : await read();
      } catch (error) {
        if (!task || !(error instanceof SourceReadFailure)) throw error;
        ctx.signal.throwIfAborted();
        await hotel.assertCurrent();
        return stage(ctx)(ref, async graph => {
          await hotel.assertCurrent();
          const latest = await graph.read(ref);
          const value = fliggyHotelBooking.parse(latest.properties);
          const outcome = value.independentRead && cancellationTerminal(value.state) ? 'terminal' : 'unavailable';
          const status = await observation.advance(graph, task, outcome);
          if (latest.properties.cancellationObservation !== status)
            await graph.edit(ref, latest.revision, { cancellationObservation: status });
        });
      }
      const reconcileGuard = async (client: Sql) => { await ctx.assertCurrent?.(client); await hotel.assertCurrent(); };
      await operations.reconcile(ctx.principal.owner, key, scope(booking, 'create'),
        reconcileGuard, async () => ({ merchantOrderId: provider.merchantOrderId }), ctx.objects);
      if (['pending_confirmation', 'confirmed', 'completed'].includes(provider.state))
        await operations.reconcile(ctx.principal.owner, operationKey(booking, 'pay'), scope(booking, 'pay'),
          reconcileGuard, async () => ({ acknowledged: true }), ctx.objects);
      if (provider.state === 'cancelled')
        await operations.reconcile(ctx.principal.owner, operationKey(booking, 'cancel'), scope(booking, 'cancel'),
          reconcileGuard, async () => ({ acknowledged: true }), ctx.objects);
      if (!task) return project(ctx, ref, row, hotel, provider);
      return stage(ctx)(ref, async graph => {
        await hotel.assertCurrent();
        const latest = await graph.read(ref);
        const last = fliggyHotelBooking.parse(latest.properties);
        // Another refresh may have committed since this read (or while its Worker lease was being recovered).
        const useReceipt = latest.revision === row.revision && Date.parse(provider.observedAt) >= Date.parse(last.observedAt)
          && !(last.independentRead && cancellationTerminal(last.state));
        const state = useReceipt ? provider.state : last.state;
        const status = await observation.advance(graph, task, cancellationTerminal(state) ? 'terminal' : 'pending');
        const { checkedIn: _checkedIn, ...facts } = provider;
        if (useReceipt || latest.properties.cancellationObservation !== status)
          await graph.edit(ref, latest.revision, {
            ...(useReceipt ? { ...facts, independentRead: true } : {}), cancellationObservation: status,
          });
      });
    }],
    ['readFliggyHotelBooking', async (raw, ctx) => {
      const { booking: ref } = fliggyHotelBookingRef.parse(raw);
      return fliggyHotelPublic.parse((await current(ctx, ref)).booking);
    }],
    ...(['pay', 'cancel'] as const).map((action): [string, FunctionHandler] => [
      action === 'pay' ? 'confirmFliggyHotelPayment' : 'cancelFliggyHotelBooking',
      async (raw, ctx) => {
        stage(ctx);
        const input = fliggyHotelBookingApproval.parse(raw), { booking: ref } = input;
        const { booking, row, hotel } = await current(ctx, ref);
        const approval = approve(ctx, input, booking);
        if (!booking.merchantOrderId) throw new Conflict('Read the original Fliggy order before payment or cancellation');
        const key = operationKey(booking, action), approved = scope(booking, action);
        const original = await readProvider(hotel, booking, ctx.signal);
        if (!await operations.recover(ctx.principal.owner, key, approved, ctx.objects)) {
          if (action === 'pay') {
            if (original.state !== 'awaiting_payment' || !hotel.paymentsFile)
              throw new Conflict('The original order must be payable and have verified buyer-payment evidence');
            const payments = receivedPayments.parse(JSON.parse(await readPrivateSourceFile(hotel.paymentsFile)));
            const matched = payments.filter(payment => payment.orderId === booking.merchantOrderId &&
              payment.outOrderId === booking.outOrderId && payment.amountMinor === booking.amountMinor &&
              Date.parse(payment.receivedAt) <= Date.now());
            if (matched.length !== 1) throw new Conflict('Verified buyer payment does not match this Fliggy order');
          } else if (!['awaiting_payment', 'pending_confirmation', 'confirmed'].includes(original.state) ||
            booking.cancellation.cancel_policy_type !== 1 || original.checkedIn !== false ||
            Date.parse(booking.selection.checkIn + 'T' + booking.selection.arrivalTime + ':00+08:00') <= Date.now()) {
            throw new Conflict('This action requires an unoccupied booking with free cancellation');
          }
          // Pay and cancellation of an unpaid order must not race. Paid
          // cancellations may proceed once the supplier confirms payment.
          const opposing = action === 'pay' ? 'cancel' : original.state === 'awaiting_payment' ? 'pay' : undefined;
          const verify = dispatchGuard(ctx, booking, ref, row.revision, hotel, approval, opposing);
          const guard = async (client: Sql) => {
            await verify(client);
            if (action === 'cancel' && supportsObservation(ctx))
              await observation.enqueue(ctx, ref, client);
          };
          await operations.run(ctx.principal.owner, key, approved, guard, async () => {
            const result = await hotel.call(action, { distributor: hotel.distributor, dis_order_id: booking.outOrderId }, ctx.signal);
            if (action === 'pay') z.literal(true).parse(result);
            else z.object({ cancel_success: z.literal(true), forfeit_fee: z.literal(0) }).parse(result);
            return { acknowledged: true };
          }, ctx.objects, { requestId: ctx.operationId, taskId: ctx.taskId });
        }
        return project(ctx, ref, row, hotel, await readProvider(hotel, booking, ctx.signal));
      },
    ]),
  ]);
}
