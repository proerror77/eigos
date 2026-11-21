import { z } from 'zod';
import { Conflict, NotFound, SourceReadFailure, digest } from '../../core/identity.js';
import { readPrivateSourceFile, yuanToFen } from '../../core/private-source.js';
import {
  approveFlightBookingInput, fliggyFlightBooking, fliggyFlightBookingType, fliggyFlightPublic,
  flightBookingRef, partnerFlightQuote, partnerFlightSearch, prepareFlightBookingInput,
} from '../../ontology/fliggy-flight-booking.js';
import type { ObjectRef } from '../../ontology/schema.js';
import type { Database, Sql } from '../../runtime/database.js';
import { ExternalOperations } from '../../runtime/external-operations.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import type { Objects } from '../../runtime/objects.js';
import type { Task } from '../../runtime/tasks.js';
import { OrderObservation } from './order-observation.js';
import { topIdentifier, topNumber, type FliggyFlightResolver } from './top.js';

type Partner = Awaited<ReturnType<FliggyFlightResolver>>;
type Search = z.infer<typeof partnerFlightSearch>;
type Booking = z.infer<typeof fliggyFlightBooking>;
const nonnegative = z.number().int().nonnegative().safe();
const person = z.strictObject({
  name: z.string().trim().min(1).max(100), mobile_phone_number: z.string().regex(/^\d{7,20}$/),
  mobile_country_code: z.string().regex(/^\d{1,4}$/),
});
const profiles = z.array(z.strictObject({
  id: prepareFlightBookingInput.shape.profileId, expiresAt: z.iso.datetime(), contact: person.extend({ email: z.email().optional() }),
  passenger: person.extend({
    birthday: z.iso.date(),
    credential_type: z.literal(0),
    credential_no: z.string().regex(/^\d{17}[0-9X]$/),
  }),
})).max(100);
const price = z.object({ sell_price: nonnegative, build_price: nonnegative, oil_price: nonnegative, tax: nonnegative });
const flightRoute = z.object({ trip_type: z.literal(1),
  flight_journey_list: z.object({ flight_journey: z.array(z.object({
    flight_segment_list: z.object({ flight_segment: z.array(partnerFlightQuote.shape.segment.strip().extend({
      id: z.string().min(1),
    })).length(1) }),
  })).length(1) }),
});
const offer = z.object({
  item_id: partnerFlightQuote.shape.itemId, refund_change_details: partnerFlightQuote.shape.refundTerms,
  search_extra_attribute: z.object({ standard_product: z.literal(true) }),
  flight_route: flightRoute,
  passenger_price_list: z.object({ flight_passenger_item: z.array(z.object({
    passenger_type: z.string(),
    flight_segment_item_list: z.object({ flight_segment_item: z.array(z.object({
      cabin: partnerFlightQuote.shape.cabin, flight_segment_id: z.string(),
    })).length(1) }),
    flight_price: price,
  })).max(10) }),
});
const dateTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ticketList = z.array(z.string().regex(/^\d{10,15}$/)).max(4);
const detail = z.object({
  flight_route: flightRoute, pay_status: z.string().nullish(),
  order_id: topIdentifier, out_order_no: z.string(), order_status: z.string().min(1).max(160),
  total_price: nonnegative, real_pay_price: nonnegative.optional(), pay_time: z.string().regex(dateTime).nullish(),
  trade_no: z.string().nullish(), alipay_trade_no: z.string().nullish(),
  flight_book_order_detail_list: z.object({ flight_book_order_detail: z.array(z.object({
    ticket_nos: z.union([ticketList, z.object({ string: ticketList })]).nullish(),
  })).max(1) }).nullish(),
});

async function loadProfile(partner: Partner, profileId: string, departureDate: string) {
  const selected = profiles.parse(JSON.parse(await readPrivateSourceFile(partner.profilesFile)))
    .filter(profile => profile.id === profileId && Date.parse(profile.expiresAt) > Date.now());
  const [profile] = selected;
  const adultCutoff = String(Number(departureDate.slice(0, 4)) - 18).padStart(4, '0') + departureDate.slice(4);
  if (selected.length !== 1 || !profile || profile.passenger.birthday > adultCutoff)
    throw new Conflict('Provide one current adult passenger profile for this fare');
  return profile;
}

async function readQuotes(partner: Partner, search: Search, signal: AbortSignal) {
  if (search.origin === search.destination || search.departureDate < new Date(Date.now() + 28800000).toISOString().slice(0, 10))
    throw new Conflict('Use a future domestic flight with distinct airports or cities');
  const body = await partner.call('search', {
    trip_type: 1, search_mode: 1, cabin_class: 'ALL_CABIN', has_child: false, has_infant: false,
    external_agent_name: partner.channelName,
    search_od_info_list: [{ dep_city_code: search.origin, arr_city_code: search.destination, dep_date: search.departureDate }],
  }, signal);
  const list = z.object({ flight_group_item_list: z.object({ flight_group_item: z.array(z.unknown()).max(500) }) }).parse(body);
  const quotes = new Map<string, z.infer<typeof partnerFlightQuote>>();
  for (const value of list.flight_group_item_list.flight_group_item) {
    const decoded = offer.safeParse(value);
    if (!decoded.success) continue;
    const item = decoded.data, raw = item.flight_route.flight_journey_list.flight_journey[0]!.flight_segment_list.flight_segment[0]!;
    const matches = item.passenger_price_list.flight_passenger_item.filter(row => row.passenger_type === 'ADT');
    const adult = matches[0];
    if (matches.length !== 1 || !adult || adult.flight_segment_item_list.flight_segment_item[0]!.flight_segment_id !== raw.id ||
        raw.dep_time.slice(0, 10) !== search.departureDate || Date.parse(raw.dep_time.replace(' ', 'T') + '+08:00') <= Date.now())
      continue;
    const { sell_price, oil_price, build_price, tax } = adult.flight_price;
    if (tax !== oil_price + build_price) continue;
    const segment = { dep_airport: raw.dep_airport, arr_airport: raw.arr_airport, marketing_flight_no: raw.marketing_flight_no,
      dep_time: raw.dep_time, arr_time: raw.arr_time };
    const quote = partnerFlightQuote.parse({
      itemId: item.item_id, segment, cabin: adult.flight_segment_item_list.flight_segment_item[0]!.cabin,
      fareYuan: sell_price, constructionYuan: build_price, fuelYuan: oil_price, taxYuan: tax,
      amountMinor: yuanToFen(sell_price + tax), currency: 'CNY', refundTerms: item.refund_change_details,
    });
    const previous = quotes.get(quote.itemId);
    if (previous && digest(previous) !== digest(quote)) throw new Conflict('Jinghang returned conflicting identities for a fare');
    quotes.set(quote.itemId, quote);
  }
  return [...quotes.values()];
}

function stage(ctx: FunctionContext) {
  if (!ctx.edit || ctx.objects.model.scenario) throw new Conflict('Use a formal Fliggy flight Action');
  return ctx.edit;
}
export function fliggyFlightBookingFunctions(db: Database, resolve: FliggyFlightResolver): ReadonlyMap<string, FunctionHandler> {
  const operations = new ExternalOperations(db);
  const followup = new OrderObservation(db, 'RefreshFliggyFlightBooking');
  const tracksIssuance = (ctx: FunctionContext) =>
    Boolean(ctx.objects.model.object(fliggyFlightBookingType).properties.issuanceState);
  const current = async (ctx: FunctionContext, ref: ObjectRef) => {
    if (ref.type !== fliggyFlightBookingType) throw new Conflict('Reference the original Fliggy flight booking');
    const partner = await resolve(ctx.principal.owner), row = await ctx.objects.read(ref);
    const booking = fliggyFlightBooking.parse(row.properties);
    if (booking.authority !== partner.authority || booking.evidence !== partner.evidence)
      throw new Conflict('The Fliggy flight connection does not match the original booking');
    return { partner, row, booking };
  };
  const readProvider = async (partner: Partner, booking: Booking, signal: AbortSignal) => {
    const facts = detail.parse(await partner.call('detail', {
      channel_name: partner.channelName, out_order_no: booking.outOrderNo,
    }, signal));
    const returned = facts.flight_route.flight_journey_list.flight_journey[0]!.flight_segment_list.flight_segment[0]!;
    const { id: _segmentId, ...segment } = returned;
    if (facts.out_order_no !== booking.outOrderNo || booking.merchantOrderId && facts.order_id !== booking.merchantOrderId ||
      digest(segment) !== digest(booking.quote.segment) || yuanToFen(facts.total_price) !== booking.quote.amountMinor)
      throw new Conflict('Jinghang order identity or price differs from the approved booking');
    const paid = Boolean(['PAID', 'TRANSFERRED'].includes(facts.pay_status ?? '') && facts.pay_time && (facts.trade_no || facts.alipay_trade_no)
      && facts.real_pay_price !== undefined && yuanToFen(facts.real_pay_price) === booking.quote.amountMinor);
    const rawTickets = facts.flight_book_order_detail_list?.flight_book_order_detail[0]?.ticket_nos;
    const tickets = Array.isArray(rawTickets) ? rawTickets : rawTickets?.string;
    const closed = ['CLOSED', 'ORDER_CLOSED', '订单关闭', '已关闭'].includes(facts.order_status);
    const paymentStarted = !!(facts.pay_time || facts.trade_no || facts.alipay_trade_no ||
      facts.pay_status && facts.pay_status !== 'UNPAID');
    const issued = paid && !closed && Boolean(tickets?.length);
    if ((booking.paid && !paid) || (booking.issued && !issued) || (booking.closed && !closed))
      throw new Conflict('Jinghang readback contradicts previously confirmed booking evidence');
    return {
      merchantOrderId: facts.order_id, supplierStatus: facts.order_status, paid,
      issued, closed, paymentStarted,
      observedAt: new Date().toISOString(), independentRead: true,
    };
  };
  // A manual refresh can commit while the Worker waits for Jinghang. Keep that newer
  // observation and decide continuation under the same booking lock as the Action edit.
  const advancedConcurrently = async (graph: Objects, ref: ObjectRef, revision: number, task?: Task) => {
    if (!task) return false;
    const currentRow = await graph.read(ref);
    if (currentRow.revision === revision) return false;
    const latest = fliggyFlightBooking.parse(currentRow.properties);
    const terminal = latest.independentRead && (latest.issued || latest.closed);
    const status = await followup.advance(graph, task, terminal ? 'terminal' : 'pending');
    await graph.edit(ref, currentRow.revision, { issuanceObservation: status });
    return true;
  };
  type ProviderFacts = Awaited<ReturnType<typeof readProvider>>;
  const project = (ctx: FunctionContext, ref: ObjectRef, revision: number, partner: Partner, facts: ProviderFacts,
    paymentClaimed = false, observationTask?: Task) => stage(ctx)(ref, async graph => {
    await partner.assertCurrent();
    if (await advancedConcurrently(graph, ref, revision, observationTask)) return;
    const { paymentStarted, ...publicFacts } = facts;
    const progress: Partial<Booking> = {};
    if (tracksIssuance(ctx)) {
      if (facts.closed) progress.issuanceState = 'closed';
      else if (facts.issued) progress.issuanceState = 'issued';
      else if (facts.paid) progress.issuanceState = 'awaiting_issuance';
      else if (!paymentClaimed && !paymentStarted && ['BOOK_SUCCEEDED', '生单预定成功'].includes(facts.supplierStatus))
        progress.issuanceState = 'unpaid';
      else progress.issuanceState = 'payment_unverified';

      if (observationTask) progress.issuanceObservation = await followup.advance(graph, observationTask,
        facts.issued || facts.closed ? 'terminal' : 'pending');
    }
    await graph.edit(ref, revision, { ...publicFacts, ...progress });
  });
  const settlement = (booking: Booking, action: string) => ({
    key: digest(['fliggy-flight', booking.outOrderNo, action]),
    scope: { approval: booking.approvalDigest, authority: booking.authority, order: booking.outOrderNo, action },
  });
  const approve = (ctx: FunctionContext, input: z.infer<typeof approveFlightBookingInput>,
    ref: ObjectRef, partner: Partner, booking: Booking, revision: number, opposing?: string) => {
    if (!ctx.directAction || !ctx.assertDispatch || input.amountMinor !== booking.quote.amountMinor || input.approvedDigest !== booking.approvalDigest)
      throw new Conflict('The authenticated PA must explicitly approve the exact flight offer and amount');
    const assertDispatch = ctx.assertDispatch;
    return async (client: Sql) => {
      await assertDispatch(client);
      await partner.assertCurrent();
      const result = await db.query(
        `SELECT revision FROM ${db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`,
        [ctx.objects.model.projection, ctx.principal.owner, ref.type, ref.id], client,
      );
      if (Number(result.rows[0]?.revision) !== revision) throw new Conflict('The original flight booking changed');
      if (opposing && (await db.query(
        `SELECT 1 FROM ${db.schema}.external_operations WHERE owner=$1 AND operation_key=$2`,
        [ctx.principal.owner, settlement(booking, opposing).key], client,
      )).rowCount) throw new Conflict('Reconcile the opposing Jinghang operation before this action');
    };
  };
  return new Map<string, FunctionHandler>([
    ['readFliggyFlightQuotes', async (raw, ctx) => {
      const partner = await resolve(ctx.principal.owner);
      return { quotes: (await readQuotes(partner, partnerFlightSearch.parse(raw), ctx.signal)).slice(0, 20), complete: false };
    }],
    ['prepareFliggyFlightBooking', async (raw, ctx) => {
      const edit = stage(ctx), { bookingKey, search, itemId, profileId } = prepareFlightBookingInput.parse(raw);
      const partner = await resolve(ctx.principal.owner);
      const [quotes, profile] = await Promise.all([readQuotes(partner, search, ctx.signal), loadProfile(partner, profileId, search.departureDate)]);
      const quote = quotes.find(item => item.itemId === itemId);
      if (!quote) throw new Conflict('The selected Jinghang offer was not returned by the current search');
      const ref = { type: fliggyFlightBookingType, id: digest([ctx.principal.owner, partner.authority, bookingKey]) };
      const profileDigest = digest(profile), approvalDigest = digest([search, quote, profileDigest, partner.authority]);
      return edit(ref, async graph => {
        await partner.assertCurrent();
        const prior = await graph.read(ref).catch(error => { if (!(error instanceof NotFound)) throw error; });
        if (prior) {
          if (prior.properties.approvalDigest !== approvalDigest) throw new Conflict('This flight booking key already binds different terms');
          return;
        }
        await graph.create(ref, {
          id: ref.id, name: quote.segment.marketing_flight_no, approvalDigest, search, quote, profileId, profileDigest,
          outOrderNo: BigInt('0x' + ref.id.slice(0, 15)).toString(), merchantOrderId: null, supplierStatus: null,
          paid: false, issued: false, closed: false, independentRead: false, authority: partner.authority, evidence: partner.evidence,
          observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(),
        });
      });
    }],
    ['createFliggyFlightBooking', async (raw, ctx) => {
      stage(ctx);
      const input = approveFlightBookingInput.parse(raw), ref = input.booking;
      const { row, partner, booking } = await current(ctx, ref);
      const verify = approve(ctx, input, ref, partner, booking, row.revision), operation = settlement(booking, 'create');
      const guard = async (client: Sql) => {
        await verify(client);
        if (Date.parse(booking.expiresAt) <= Date.now()) throw new Conflict('The reviewed Jinghang fare expired before dispatch');
      };
      let receipt = await operations.recover<{ merchantOrderId: string }>(ctx.principal.owner, operation.key, operation.scope, ctx.objects);
      if (!receipt) {
        if (Date.parse(booking.expiresAt) <= Date.now() || booking.merchantOrderId) throw new Conflict('Obtain a fresh flight preview');
        const [quotes, profile] = await Promise.all([
          readQuotes(partner, booking.search, ctx.signal), loadProfile(partner, booking.profileId, booking.search.departureDate),
        ]);
        const quote = quotes.find(item => item.itemId === booking.quote.itemId);
        if (!quote || digest([booking.search, quote, digest(profile), partner.authority]) !== booking.approvalDigest)
          throw new Conflict('Jinghang changed the fare, flight, terms or passenger');
        receipt = await operations.run(ctx.principal.owner, operation.key, operation.scope, guard, async () => {
          const result = z.object({ order_id: topIdentifier, out_order_no: z.string() }).parse(await partner.call('create', {
            channel_name: partner.channelName, out_order_no: booking.outOrderNo, item_id: quote.itemId,
            total_price: quote.amountMinor / 100, adt_flight_item_price: quote.fareYuan,
            adt_build_fee: quote.constructionYuan, adt_oil_fee: quote.fuelYuan, adt_total_fee: String(quote.taxYuan),
            contact: profile.contact, passenger_list: [{ ...profile.passenger, birthday: profile.passenger.birthday + ' 00:00:00', type: 0 }],
            allow_register_or_query_member: false,
          }, ctx.signal));
          if (result.out_order_no !== booking.outOrderNo) throw new Conflict('Jinghang returned a different external order number');
          return { merchantOrderId: result.order_id };
        }, ctx.objects, { requestId: ctx.operationId, taskId: ctx.taskId });
      }
      return project(ctx, ref, row.revision, partner, await readProvider(partner, { ...booking, ...receipt }, ctx.signal));
    }],
    ...(['pay', 'close'] as const).map((action): [string, FunctionHandler] => [
      action === 'pay' ? 'payFliggyFlightBooking' : 'closeFliggyFlightBooking',
      async (raw, ctx) => {
        stage(ctx);
        const input = approveFlightBookingInput.parse(raw), ref = input.booking;
        const { row, partner, booking } = await current(ctx, ref);
        if (!booking.merchantOrderId) throw new Conflict('Read the original Jinghang order first');
        const verify = approve(ctx, input, ref, partner, booking, row.revision, action === 'pay' ? 'close' : 'pay');
        const guard = async (client: Sql) => {
          await verify(client);
          if (action === 'pay' && tracksIssuance(ctx)) await followup.enqueue(ctx, ref, client);
        };
        const operation = settlement(booking, action), original = await readProvider(partner, booking, ctx.signal);
        if (!await operations.recover(ctx.principal.owner, operation.key, operation.scope, ctx.objects)) {
          if (original.paymentStarted || original.closed || !['BOOK_SUCCEEDED', '生单预定成功'].includes(original.supplierStatus))
            throw new Conflict('The original Jinghang flight order is not in a verified unpaid, open state');
          await operations.run(ctx.principal.owner, operation.key, operation.scope, guard, async () => {
            const result = z.object({ order_id: topIdentifier }).parse(await partner.call(action, {
              order_id: topNumber(original.merchantOrderId), channel_name: partner.channelName,
            }, ctx.signal));
            if (result.order_id !== original.merchantOrderId) throw new Conflict('Jinghang returned a different original order');
            return { acknowledged: true };
          }, ctx.objects, { requestId: ctx.operationId, taskId: ctx.taskId });
        }
        return project(ctx, ref, row.revision, partner, await readProvider(partner, booking, ctx.signal), action === 'pay');
      },
    ]),
    ['refreshFliggyFlightBooking', async (raw, ctx) => {
      stage(ctx);
      const { booking: ref } = flightBookingRef.parse(raw);
      const { booking, partner, row } = await current(ctx, ref);
      const created = settlement(booking, 'create'), payment = settlement(booking, 'pay');
      if (!booking.merchantOrderId && !await operations.inspect(ctx.principal.owner, created.key))
        throw new Conflict('The flight preview has no submitted order');
      const observationTask = tracksIssuance(ctx) ? followup.task(ctx, ref) : undefined;
      if (observationTask && booking.independentRead && (booking.issued || booking.closed)) {
        // Pay or a manual read may have confirmed the terminal state before this check was due.
        return stage(ctx)(ref, async graph => {
          await partner.assertCurrent();
          if (await advancedConcurrently(graph, ref, row.revision, observationTask)) return;
          await graph.edit(ref, row.revision, { issuanceState: booking.closed ? 'closed' : 'issued',
            issuanceObservation: await followup.advance(graph, observationTask, 'terminal') });
        });
      }
      const execution = ctx.execution;
      const paymentClaimed = Boolean(await operations.inspect(ctx.principal.owner, payment.key));
      const read = () => readProvider(partner, booking, ctx.signal);
      let facts: ProviderFacts;
      let readRevision = row.revision;
      try {
        if (observationTask && execution) {
          const receipt = await execution.tasks.readSource(observationTask,
            'flight-issuance:' + (observationTask.execution_step ?? 0),
            { outOrderNo: booking.outOrderNo, authority: booking.authority }, async () => {
              try { return { revision: row.revision, facts: await read() }; }
              catch (cause) { throw new SourceReadFailure('Original Jinghang order readback unavailable', { cause }); }
            });
          facts = receipt.facts;
          readRevision = receipt.revision;
        } else {
          facts = await read();
        }
      } catch (error) {
        if (!observationTask || !(error instanceof SourceReadFailure)) throw error;
        return stage(ctx)(ref, async graph => {
          await partner.assertCurrent();
          if (await advancedConcurrently(graph, ref, row.revision, observationTask)) return;
          const status = await followup.advance(graph, observationTask, 'unavailable');
          await graph.edit(ref, row.revision, { issuanceObservation: status,
            ...(paymentClaimed && !booking.paid && !booking.closed ? { issuanceState: 'payment_unverified' } : {}) });
        });
      }
      const guard = async (client: Sql) => { await ctx.assertCurrent?.(client); await partner.assertCurrent(); };
      await operations.reconcile(ctx.principal.owner, created.key, created.scope,
        guard, async () => ({ merchantOrderId: facts.merchantOrderId }), ctx.objects);
      if (facts.paid) await operations.reconcile(ctx.principal.owner, payment.key, payment.scope,
        guard, async () => ({ acknowledged: true }), ctx.objects);
      if (facts.closed) {
        const closed = settlement(booking, 'close');
        await operations.reconcile(ctx.principal.owner, closed.key, closed.scope,
          guard, async () => ({ acknowledged: true }), ctx.objects);
      }
      return project(ctx, ref, readRevision, partner, facts, paymentClaimed, observationTask);
    }],
    ['readFliggyFlightBooking', async (raw, ctx) => {
      const { booking: ref } = flightBookingRef.parse(raw);
      return fliggyFlightPublic.parse((await current(ctx, ref)).booking);
    }],
  ]);
}
