import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import {
  diningBookingReceipt, diningReservationData, diningReservationRef, diningReservationTerms,
  diningReservationType, diningWebQuery,
} from '../../ontology/dining-reservations.js';
import type { Database, Sql } from '../../runtime/database.js';
import { ExternalOperations, UnknownExternalOperation } from '../../runtime/external-operations.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { Objects } from '../../runtime/objects.js';
import { diningSandbox, diningSandboxOrigin } from './sandbox.js';
import { checkPublicDiningPage } from './public-booking.js';

const timeZone = z.string().max(100).refine(zone => {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; }
  catch { return false; }
});
const connection = z.strictObject({
  owner: z.string().min(1).max(200),
  restaurant: diningWebQuery.shape.restaurant,
  city: diningWebQuery.shape.city,
  timeZone,
  officialPage: z.url({ protocol: /^https$/ }).max(1000).optional(),
  sandboxOrigin: diningSandboxOrigin.optional(),
});
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
const dayIn = (zone: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short' }).format();

function match(terms: { restaurant: string; city: string }, binding: z.infer<typeof connection>) {
  return normalize(terms.restaurant) === normalize(binding.restaurant) && normalize(terms.city) === normalize(binding.city);
}

export function diningReservationFunctions(db: Database, path?: string): ReadonlyMap<string, FunctionHandler> {
  const effects = new ExternalOperations(db);
  async function resolve(owner: string) {
    if (!path) return;
    const read = async () => connection.parse(JSON.parse(await readPrivateSourceFile(path)));
    const binding = await read();
    if (binding.owner !== owner) return;
    const identity = digest(binding);
    return {
      ...binding, identity,
      async assertCurrent() {
        if (digest(await read()) !== identity) throw new Conflict('The original dining connection changed');
      },
    };
  }

  async function update(raw: Record<string, unknown>, context: FunctionContext, submit: boolean) {
    if (!context.edit || !context.assertDispatch || context.objects.model.scenario)
      throw new Conflict('Apply a formal test reservation Action');
    const { reservation } = diningReservationRef.parse(raw), owner = context.principal.owner;
    if (reservation.type !== diningReservationType) throw new Conflict('Reference the original reservation');
    const read = async (objects: Pick<Objects, 'read'>) => diningReservationData.parse((await objects.read(reservation)).properties);
    const record = await read(context.objects), binding = await resolve(owner);
    if (!binding?.sandboxOrigin || record.binding !== binding.identity || !match(record.terms, binding))
      throw new Conflict('The original test merchant connection is unavailable');

    const scope = { binding: binding.identity, reservation, terms: record.terms, channel: record.channel };
    const original = new Objects(db, context.objects.model, context.objects.access);
    const sandbox = diningSandbox(binding.sandboxOrigin, binding.timeZone);
    const guard = async (client: Sql) => {
      await context.assertDispatch!(client);
      await binding.assertCurrent();
      const current = await read(new Objects(db, original.model, original.access, client));
      if (current.binding !== record.binding || digest(current.terms) !== digest(record.terms))
        throw new Conflict('The original reservation terms changed');
    };
    const reconcile = () => effects.reconcile(owner, reservation.id, scope, guard, async () => {
      try { return await sandbox.lookup(record.terms, reservation.id, context.signal); }
      catch { context.signal.throwIfAborted(); return undefined; }
    }, original);

    let receipt: z.infer<typeof diningBookingReceipt> | undefined;
    if (record.receipt) receipt = record.receipt;
    else if (!submit) {
      if (!await effects.inspect(owner, reservation.id)) throw new Conflict('The reservation has no original submission to look up');
      receipt = await reconcile();
    } else {
      try {
        receipt = await effects.recover(owner, reservation.id, scope, original);
        receipt ??= await sandbox.submit(record.terms, reservation.id, context.signal, send => effects.run(
          owner, reservation.id, scope, async client => {
            await guard(client);
            if (record.terms.date < dayIn(binding.timeZone)) throw new Conflict('The requested date has passed');
          }, async () => {
            await context.assertCurrent?.();
            await binding.assertCurrent();
            return send();
          }, original, { taskId: context.taskId, requestId: context.operationId },
        ));
      } catch (error) {
        if (!(error instanceof UnknownExternalOperation)) throw error;
        receipt = await reconcile();
      }
    }

    return context.edit(reservation, async graph => {
      const latest = await graph.read(reservation), current = diningReservationData.parse(latest.properties);
      if (current.binding !== record.binding || digest(current.terms) !== digest(record.terms))
        throw new Conflict('The original reservation terms changed');
      if (current.state === 'confirmed' || (!receipt && current.state === 'unknown')) return;
      await graph.edit(reservation, latest.revision, {
        state: receipt ? 'confirmed' : 'unknown', receipt: receipt ?? null,
      });
    });
  }

  return new Map<string, FunctionHandler>([
    ['readDiningWebAvailability', async (raw, context) => {
      const query = diningWebQuery.parse(raw), binding = await resolve(context.principal.owner);
      if (!binding?.officialPage || !match(query, binding)) return { status: 'unavailable', reason: 'venue-not-connected' };
      const today = dayIn(binding.timeZone);
      const days = (Date.parse(query.date) - Date.parse(today)) / 86400000;
      if (days < 0 || days > 60) return { status: 'unavailable', reason: 'date-out-of-range' };
      try {
        const observed = await checkPublicDiningPage(binding.officialPage, binding.timeZone, query, context.signal);
        await binding.assertCurrent();
        return { ...query, ...observed, status: 'observed', evidence: 'live', timeZone: binding.timeZone, observedAt: new Date().toISOString() };
      } catch {
        context.signal.throwIfAborted();
        return { status: 'unavailable', reason: 'page-unavailable' };
      }
    }],
    ['prepareDiningTestReservation', async (raw, context) => {
      if (!context.edit || context.objects.model.scenario || !context.operationId)
        throw new Conflict('Apply a formal test reservation Action');
      const terms = diningReservationTerms.parse(raw), binding = await resolve(context.principal.owner);
      if (!binding?.sandboxOrigin || !match(terms, binding)) throw new Conflict('A matching loopback test merchant is required');
      if (terms.date < dayIn(binding.timeZone)) throw new Conflict('Choose a current or future test date');
      const reservation = { type: diningReservationType, id: digest([context.principal.owner, context.operationId, diningReservationType]) };
      return context.edit(reservation, async graph => {
        await binding.assertCurrent();
        await graph.create(reservation, diningReservationData.parse({
          id: reservation.id, name: terms.restaurant, terms, environment: 'synthetic', channel: 'web', binding: binding.identity,
          state: 'prepared', receipt: null,
        }));
      });
    }],
    ['submitDiningTestReservation', (raw, context) => update(raw, context, true)],
    ['refreshDiningTestReservation', (raw, context) => update(raw, context, false)],
    ['readDiningReservation', async (raw, context) => {
      const { reservation } = diningReservationRef.parse(raw);
      if (reservation.type !== diningReservationType) throw new Conflict('Reference a dining reservation');
      const { binding: _binding, ...record } = diningReservationData.parse((await context.objects.read(reservation)).properties);
      return record;
    }],
  ]);
}
