import { z } from 'zod';
import { Conflict, digest, NotFound } from '../../core/identity.js';
import { cancelCommitmentInput, commitmentInput, confirmCommitmentInput, tableReservationTerms } from '../../ontology/network-contract.js';
import { restaurantVenueRecord, restaurantVisitRecord } from '../../ontology/restaurant-services.js';
import type { ObjectRef } from '../../ontology/schema.js';
import {
  prepareTableCheckInput, tableCheckReadInput, tableCheckRecord, tableCheckReservationType, tableCheckVenueLink, tableCheckVisitLink,
} from '../../ontology/tablecheck-reservations.js';
import type { Database, Sql } from '../../runtime/database.js';
import { ExternalOperations, UnknownExternalOperation } from '../../runtime/external-operations.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { Objects } from '../../runtime/objects.js';
import { askDiningPA } from './mini-program.js';
import { configuredTableCheck, tableCheckLocal, type TableCheckReservationResult } from './tablecheck.js';

type Booking = z.infer<typeof tableCheckRecord>;
type TableCheck = Awaited<ReturnType<typeof configuredTableCheck>>;
type Step = 'confirm' | 'cancel';
type Receipt = { bookingId: string; confirmationCode?: string; manageUrl?: string; observedAt: string };
const phone = z.string().regex(/^\+[1-9][0-9]{6,14}$/);
const approval = z.discriminatedUnion('approved', [
  z.strictObject({ approved: z.literal(true), termsDigest: tableCheckRecord.shape.termsDigest }),
  z.strictObject({ approved: z.literal(false) }),
]);

function terms(booking: Booking) {
  return tableReservationTerms.parse(Object.fromEntries(Object.keys(tableReservationTerms.shape).map(key =>
    [key, booking[key as keyof Booking]])));
}
function verified(row: TableCheckReservationResult | undefined, booking: Booking, step: Step): Receipt | undefined {
  if (!row || row.ref !== booking.id || (booking.bookingId && row.id !== booking.bookingId) || row.shop_id !== booking.shopId ||
      Date.parse(row.start_at) !== Date.parse(booking.startsAt) || row.pax !== booking.partySize ||
      (step === 'cancel' ? row.status !== 'cancelled' : row.status !== 'confirmed')) return;
  const manageUrl = z.url({ protocol: /^https$/ }).safeParse(row.url);
  const approvedUrl = manageUrl.success && (() => {
    const url = new URL(manageUrl.data);
    return !url.username && !url.password && ['www.tablecheck.com', 'tablecheck.com', 'tblc.hk'].includes(url.host);
  })();
  return { bookingId: row.id, ...(row.code ? { confirmationCode: row.code } : {}),
    ...(approvedUrl ? { manageUrl: manageUrl.data } : {}), observedAt: new Date().toISOString() };
}
function ref(id: string): ObjectRef { return { type: tableCheckReservationType, id }; }
function key(booking: Booking, step: Step) { return digest([tableCheckReservationType, booking.id, step]); }
function scope(booking: Booking, step: Step) { return { step, termsDigest: booking.termsDigest, binding: booking.binding, id: booking.id }; }
function exactTerms(booking: Booking) { return digest([terms(booking), booking.shopId, booking.startsAt, booking.binding]); }
function assertOffered(booking: Booking) {
  if (booking.state !== 'offered' || Date.parse(booking.expiresAt) <= Date.now() || Date.parse(booking.startsAt) <= Date.now())
    throw new Conflict('Review current TableCheck availability before confirming');
}
async function explicitApproval(ctx: FunctionContext, booking: Booking, step: Step, details: Record<string, unknown>) {
  if (ctx.directAction) return;
  const digestToApprove = step === 'confirm' ? booking.termsDigest : digest([booking.termsDigest, booking.bookingId, details]);
  const reply = await askDiningPA(ctx, 'dining.tablecheck.' + step + '.approval', {
    ...details, reservation: ref(booking.id), terms: terms(booking), termsDigest: digestToApprove,
  }, approval, digest([booking.id, step, digestToApprove]));
  const result = approval.parse(reply.response);
  if (!result.approved || result.termsDigest !== digestToApprove ||
      Date.now() - reply.requestedAt.getTime() > 5 * 60 * 1000) throw new Conflict('The original user must approve the current exact terms');
}

export function tableCheckReservationFunctions(db: Database, filepath?: string, mockFetch?: typeof fetch): ReadonlyMap<string, FunctionHandler> {
  const effects = new ExternalOperations(db);
  const supplier = (ctx: FunctionContext) => configuredTableCheck(filepath, ctx, mockFetch);
  async function read(ctx: Pick<FunctionContext, 'objects'>, booking: ObjectRef) {
    if (booking.type !== tableCheckReservationType) throw new Conflict('Select the original TableCheck reservation');
    const row = await ctx.objects.read(booking);
    const record = tableCheckRecord.parse(row.properties);
    if (record.id !== booking.id || exactTerms(record) !== record.termsDigest) throw new Conflict('Stored booking terms changed');
    return { record, revision: row.revision };
  }
  function requireAction(ctx: FunctionContext) {
    if (!ctx.edit || !ctx.assertDispatch || !ctx.operationId || ctx.objects.model.scenario)
      throw new Conflict('Use a live TableCheck reservation Action');
    return ctx.edit;
  }
  function update(ctx: FunctionContext, booking: Booking, step: Step, result: Receipt | undefined, source: TableCheck) {
    const object = ref(booking.id);
    return requireAction(ctx)(object, async graph => {
      await source.assertCurrent();
      const current = await read({ objects: graph }, object);
      if (current.record.termsDigest !== booking.termsDigest) throw new Conflict('The original TableCheck terms changed');
      if (current.record.state === 'canceled') return;
      if (step === 'confirm' && (current.record.state === 'confirmed' ||
          await effects.inspect(ctx.principal.owner, key(booking, 'cancel')))) return;
      if (result) {
        await graph.edit(object, current.revision, { state: step === 'confirm' ? 'confirmed' : 'canceled',
          bookingId: result.bookingId, ...(result.confirmationCode ? { confirmationCode: result.confirmationCode } : {}),
          ...(result.manageUrl ? { manageUrl: result.manageUrl } : {}),
          receipts: [...current.record.receipts, { step, merchantRef: result.bookingId, termsDigest: booking.termsDigest,
            observedAt: result.observedAt, evidence: mockFetch ? 'synthetic' : 'connector_receipt' }] });
      } else if (current.record.state !== 'unknown') await graph.edit(object, current.revision, { state: 'unknown' });
    });
  }
  function guard(ctx: FunctionContext, booking: Booking, source: TableCheck, check?: (current: Booking) => void) {
    return async (client: Sql) => {
      await ctx.assertDispatch!(client);
      await source.assertCurrent();
      const original = new Objects(db, ctx.objects.model, ctx.objects.access, client);
      const { record } = await read({ objects: original }, ref(booking.id));
      if (record.termsDigest !== booking.termsDigest) throw new Conflict('The original TableCheck terms changed');
      check?.(record);
    };
  }
  async function reconcile(ctx: FunctionContext, booking: Booking, step: Step, source: TableCheck) {
    return effects.reconcile<Receipt>(ctx.principal.owner, key(booking, step), scope(booking, step), guard(ctx, booking, source),
      async () => verified(await source.lookup(booking.id), booking, step), ctx.objects);
  }
  const slot = (booking: Booking) => ({ nativeId: booking.shopId, startsAt: booking.startsAt, partySize: booking.partySize });
  async function connection(ctx: FunctionContext, booking: Booking) {
    const source = await supplier(ctx);
    if (booking.binding !== source.binding) throw new Conflict('The original TableCheck connection changed');
    return source;
  }
  function ensureWritable(source: TableCheck, booking: Booking) {
    if (!source.bookingEnabled(booking.shopId))
      throw new Conflict('Use the hosted booking page until TableCheck enables this venue for deposit-free reservations');
  }
  async function dispatch(ctx: FunctionContext, booking: Booking, step: Step, source: TableCheck,
    check: (current: Booking) => void, send: () => Promise<unknown>) {
    try {
      const result = await effects.run<Receipt>(
        ctx.principal.owner, key(booking, step), scope(booking, step), guard(ctx, booking, source, check),
        async () => {
          await ctx.assertCurrent?.();
          await send();
          const observation = verified(await source.lookup(booking.id), booking, step);
          if (!observation) throw new Conflict('The original TableCheck order did not have a terminal provider status');
          return observation;
        }, ctx.objects, { taskId: ctx.taskId, requestId: ctx.operationId },
      );
      return update(ctx, booking, step, result, source);
    } catch (error) {
      if (!(error instanceof UnknownExternalOperation)) throw error;
      let result: Receipt | undefined;
      try { result = await reconcile(ctx, booking, step, source); }
      catch (lookupError) {
        if (lookupError instanceof Conflict) throw lookupError;
        ctx.signal.throwIfAborted();
      }
      return update(ctx, booking, step, result, source);
    }
  }
  return new Map<string, FunctionHandler>([
    ['prepareTableCheckReservation', async (raw, ctx) => {
      const edit = requireAction(ctx);
      const { visit, startsAt } = prepareTableCheckInput.parse(raw);
      const requested = new Date(startsAt).toISOString();
      const page = restaurantVisitRecord.parse((await ctx.objects.read(visit)).properties);
      const [venueLink] = await ctx.objects.follow(visit, 'venue');
      if (!venueLink) throw new Conflict('The dated restaurant observation has no venue');
      const venue = restaurantVenueRecord.parse(venueLink.properties);
      if (venue.provider !== 'TableCheck' || page.channel !== 'provider' || page.status !== 'observed' ||
          Date.parse(page.expiresAt) <= Date.now() || !page.timeZone || !page.availableInstants?.includes(requested))
        throw new Conflict('Refresh TableCheck availability and select an exact observed time');
      const source = await supplier(ctx), observed = await source.venue(venue.nativeId, venue.city);
      if (observed.name !== venue.name || observed.city !== venue.city || observed.timeZone !== page.timeZone)
        throw new Conflict('The selected branch changed; review it again');
      const clock = tableCheckLocal(requested, page.timeZone);
      if (clock.date !== page.date || Date.parse(requested) <= Date.now()) throw new Conflict('Choose a future local appointment');
      const exact = tableReservationTerms.parse({ restaurant: venue.name, city: venue.city, branch: venue.branch,
        date: page.date, time: clock.time, partySize: page.partySize });
      const binding = source.binding, termsDigest = digest([exact, venue.nativeId, requested, binding]);
      const booking = ref(digest([tableCheckReservationType, ctx.principal.owner, venue.nativeId, requested, page.partySize]));
      const expiresAt = new Date(Math.min(Date.now() + 5 * 60 * 1000, Date.parse(requested))).toISOString();
      return edit(booking, async graph => {
        await source.assertCurrent();
        let current: Awaited<ReturnType<typeof read>> | undefined;
        try { current = await read({ objects: graph }, booking); }
        catch (error) { if (!(error instanceof NotFound)) throw error; }
        if (current) {
          if (current.record.termsDigest !== termsDigest) throw new Conflict('This original offer is bound to different terms');
          if (current.record.state === 'offered' && !await effects.inspect(ctx.principal.owner, key(current.record, 'confirm')))
            await graph.edit(booking, current.revision, { expiresAt });
          return;
        }
        await graph.create(booking, tableCheckRecord.parse({ id: booking.id, name: exact.restaurant, ...exact, termsDigest, startsAt: requested,
          shopId: venue.nativeId, binding, state: 'offered', expiresAt, receipts: [] }));
        await graph.linkBatch([{ type: tableCheckVisitLink, from: booking, to: visit },
          { type: tableCheckVenueLink, from: booking, to: venueLink.ref }]);
      });
    }],
    ['confirmTableCheckReservation', async (raw, ctx) => {
      requireAction(ctx);
      const input = confirmCommitmentInput.parse(raw), { record } = await read(ctx, input.commitment);
      const source = await connection(ctx, record);
      if (record.state === 'confirmed') return update(ctx, record, 'confirm', undefined, source);
      if (await effects.inspect(ctx.principal.owner, key(record, 'confirm'))) {
        if (record.state === 'canceled') throw new Conflict('The original reservation was canceled');
        if (await effects.inspect(ctx.principal.owner, key(record, 'cancel'))) throw new Conflict('Reconcile the original cancellation');
        return update(ctx, record, 'confirm', await reconcile(ctx, record, 'confirm', source), source);
      }
      ensureWritable(source, record);
      assertOffered(record);
      const approvedAt = Date.parse(input.approval.approvedAt);
      if (input.approval.termsDigest !== record.termsDigest || approvedAt > Date.now() + 5000 || Date.now() - approvedAt > 5 * 60 * 1000)
        throw new Conflict('Confirm the current exact TableCheck terms');
      const contact = { name: input.contact.name, phone: phone.parse(input.contact.phone) };
      await explicitApproval(ctx, record, 'confirm', { contact });
      const venue = await source.venue(record.shopId, record.city);
      const local = venue.timeZone && tableCheckLocal(record.startsAt, venue.timeZone);
      if (venue.name !== record.restaurant || venue.city !== record.city || !venue.timeZone ||
          !local || local.date !== record.date || local.time !== record.time)
        throw new Conflict('The original TableCheck venue terms changed');
      const available = await source.times(record.shopId, record.date, record.partySize, venue.timeZone);
      if (!available.availableInstants.includes(record.startsAt)) throw new Conflict('The exact TableCheck time is no longer available');
      return dispatch(ctx, record, 'confirm', source, assertOffered, async () => {
        const held = await source.hold(slot(record));
        await ctx.assertCurrent?.();
        if (Date.parse(held.expiresAt) <= Date.now()) throw new Conflict('The TableCheck hold expired');
        return source.create(slot(record), record.id, held.id, contact);
      });
    }],
    ['cancelTableCheckReservation', async (raw, ctx) => {
      requireAction(ctx);
      const input = cancelCommitmentInput.parse(raw), { record } = await read(ctx, input.commitment);
      const source = await connection(ctx, record);
      if (record.state === 'canceled') return update(ctx, record, 'cancel', undefined, source);
      if (await effects.inspect(ctx.principal.owner, key(record, 'cancel')))
        return update(ctx, record, 'cancel', await reconcile(ctx, record, 'cancel', source), source);
      const bookingId = record.bookingId;
      if (record.state !== 'confirmed' || !bookingId) throw new Conflict('Reconcile the original TableCheck booking before cancellation');
      await explicitApproval(ctx, record, 'cancel', { reason: input.reason, bookingId });
      return dispatch(ctx, record, 'cancel', source, current => {
        if (current.state !== 'confirmed' || current.bookingId !== bookingId) throw new Conflict('The original TableCheck booking changed');
      }, () => source.cancel(bookingId, input.reason));
    }],
    ['reconcileTableCheckReservation', async (raw, ctx) => {
      requireAction(ctx);
      const { record } = await read(ctx, commitmentInput.parse(raw).commitment);
      const source = await connection(ctx, record);
      const step = await effects.inspect(ctx.principal.owner, key(record, 'cancel')) ? 'cancel' : 'confirm';
      if (!await effects.inspect(ctx.principal.owner, key(record, step))) throw new Conflict('The booking has no original attempt to reconcile');
      return update(ctx, record, step, await reconcile(ctx, record, step, source), source);
    }],
    ['readTableCheckReservation', async (raw, ctx) => {
      const { reservation } = tableCheckReadInput.parse(raw), { record } = await read(ctx, reservation);
      const [venue, visit] = await Promise.all([ctx.objects.follow(reservation, 'venue'), ctx.objects.follow(reservation, 'visit')]);
      if (venue.length !== 1 || visit.length !== 1) throw new Conflict('The original TableCheck booking links are unavailable');
      const { binding: _binding, ...view } = record;
      return { ...view, venue: venue[0]!.ref, visit: visit[0]!.ref };
    }],
  ]);
}
