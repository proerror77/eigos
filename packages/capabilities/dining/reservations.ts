import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import {
  diningBookingReceipt, diningMiniProgramCapabilities, diningMiniProgramSource, diningMiniProgramTerms,
  diningMiniProgramTestAttempt, diningMiniProgramTestLookup, diningMiniProgramTestRequest,
  diningReservationData, diningReservationRef, diningReservationType, diningWebQuery, diningWebSource, diningWebTerms,
} from '../../ontology/dining-reservations.js';
import type { Database, Sql } from '../../runtime/database.js';
import { ExternalOperations, UnknownExternalOperation } from '../../runtime/external-operations.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { Objects } from '../../runtime/objects.js';
import { diningSandbox, diningSandboxOrigin } from './sandbox.js';
import { checkPublicDiningPage } from './public-booking.js';
import { askDiningPA, matchesMiniProgram, readDiningMiniProgramAvailability, resolveDiningMiniProgram } from './mini-program.js';

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

export function diningReservationFunctions(db: Database, path?: string, miniPath?: string): ReadonlyMap<string, FunctionHandler> {
  const effects = new ExternalOperations(db);
  async function resolve(owner: string) {
    if (!path) return;
    const read = async () => connection.parse(JSON.parse(await readPrivateSourceFile(path)));
    const binding = await read();
    if (binding.owner !== owner) return;
    const identity = digest(binding);
    return {
      ...binding, identity, channel: 'web' as const,
      async assertCurrent() {
        if (digest(await read()) !== identity) throw new Conflict('The original dining connection changed');
      },
    };
  }
  const resolveChannel = (owner: string, channel: 'web' | 'miniprogram') =>
    channel === 'miniprogram' ? resolveDiningMiniProgram(miniPath, owner) : resolve(owner);
  const sourceFor = (channel: 'web' | 'miniprogram') => channel === 'miniprogram' ? diningMiniProgramSource : diningWebSource;

  async function update(raw: Record<string, unknown>, context: FunctionContext, submit: boolean) {
    if (!context.edit || !context.assertDispatch || context.objects.model.scenario)
      throw new Conflict('Apply a formal test reservation Action');
    const { reservation } = diningReservationRef.parse(raw), owner = context.principal.owner;
    if (reservation.type !== diningReservationType) throw new Conflict('Reference the original reservation');
    const read = async (objects: Pick<Objects, 'read'>) => diningReservationData.parse((await objects.read(reservation)).properties);
    const record = await read(context.objects), binding = await resolveChannel(owner, record.channel);
    context.objects.access.source(context.objects.model, sourceFor(record.channel));
    if (!binding || record.binding !== binding.identity || !match(record.terms, binding))
      throw new Conflict('The original test merchant connection is unavailable');

    const scope = { binding: binding.identity, reservation, terms: record.terms, channel: record.channel };
    const original = new Objects(db, context.objects.model, context.objects.access);
    const guard = async (client: Sql) => {
      await context.assertDispatch!(client);
      context.objects.access.source(context.objects.model, sourceFor(record.channel));
      await binding.assertCurrent();
      const current = await read(new Objects(db, original.model, original.access, client));
      if (current.binding !== record.binding || digest(current.terms) !== digest(record.terms))
        throw new Conflict('The original reservation terms changed');
    };
    const origin = { taskId: context.taskId, requestId: context.operationId };
    const checkDate = () => {
      if (record.terms.date < dayIn(binding.timeZone)) throw new Conflict('The requested date has passed');
    };
    type Receipt = z.infer<typeof diningBookingReceipt>;

    const originalReceipt = async () => {
      try {
        return await effects.recover<Receipt>(owner, reservation.id, scope, original);
      } catch (error) {
        if (!(error instanceof UnknownExternalOperation)) throw error;
        return undefined;
      }
    };
    let receipt = record.receipt ?? await originalReceipt();
    if (!receipt && !submit && !await effects.inspect(owner, reservation.id))
      throw new Conflict('The reservation has no original submission to look up');

    if (!receipt && binding.channel === 'web') {
      if (!binding.sandboxOrigin) throw new Conflict('A loopback test merchant is required');
      const sandbox = diningSandbox(binding.sandboxOrigin, binding.timeZone);
      if (submit && !await effects.inspect(owner, reservation.id)) {
        try {
          receipt = await sandbox.submit(record.terms, reservation.id, context.signal, send => effects.run(
            owner, reservation.id, scope, async client => { await guard(client); checkDate(); },
            async () => { await context.assertCurrent?.(); await binding.assertCurrent(); return send(); },
            original, origin,
          ));
        } catch (error) {
          if (!(error instanceof UnknownExternalOperation)) throw error;
        }
      }
      receipt ??= await effects.reconcile(owner, reservation.id, scope, guard, async () => {
        try { return await sandbox.lookup(record.terms, reservation.id, context.signal); }
        catch { context.signal.throwIfAborted(); return undefined; }
      }, original);
    }

    if (!receipt && binding.channel === 'miniprogram') {
      const terms = diningMiniProgramTerms.parse(record.terms);
      if (!binding.testId || !matchesMiniProgram(terms, binding)) throw new Conflict('A matching PA test merchant is required');
      const input = diningMiniProgramTestRequest.parse({
        environment: 'synthetic', testId: binding.testId, reference: reservation.id, terms,
      });
      if (submit) {
        try {
          // An existing PA request on this task resumes; a second task cannot publish a second submit request.
          await askDiningPA(context, diningMiniProgramCapabilities.submitTest, input, diningMiniProgramTestAttempt,
            reservation.id, async client => {
              await guard(client);
              checkDate();
              await effects.claimDispatch(client, owner, reservation.id, scope, original, origin);
            });
        } catch (error) {
          if (!(error instanceof UnknownExternalOperation)) throw error;
        }
      }
      receipt = await effects.reconcile(owner, reservation.id, scope, guard, async () => {
        const reply = await askDiningPA(context, diningMiniProgramCapabilities.lookupTest, input, diningMiniProgramTestLookup, context.operationId);
        const result = diningMiniProgramTestLookup.parse(reply.response);
        if (result.status === 'unresolved') return;
        const { bookingId: _bookingId, reference, observedAt, verifiedBy, evidence: _evidence, ...observed } = result.receipt;
        const timestamp = Date.parse(observedAt), now = Date.now();
        if (reference === reservation.id && digest(observed) === digest(terms) && verifiedBy === 'original-order-lookup'
          && timestamp >= reply.requestedAt.getTime() - 5000 && timestamp <= now + 5000 && now - timestamp <= 300000)
          return result.receipt;
      }, original);
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

  const prepare = (channel: 'web' | 'miniprogram'): FunctionHandler => async (raw, context) => {
    if (!context.edit || context.objects.model.scenario || !context.operationId)
      throw new Conflict('Apply a formal test reservation Action');
    const binding = await resolveChannel(context.principal.owner, channel);
    const terms = (channel === 'web' ? diningWebTerms : diningMiniProgramTerms).parse(raw);
    if (!binding || !match(terms, binding) || (binding.channel === 'web' ? !binding.sandboxOrigin :
      !binding.testId || !matchesMiniProgram(diningMiniProgramTerms.parse(terms), binding)))
      throw new Conflict('A matching test merchant is required');
    if (terms.date < dayIn(binding.timeZone)) throw new Conflict('Choose a current or future test date');
    const reservation = { type: diningReservationType, id: digest([context.principal.owner, context.operationId, diningReservationType]) };
    return context.edit(reservation, async graph => {
      await binding.assertCurrent();
      await graph.create(reservation, diningReservationData.parse({
        id: reservation.id, name: terms.restaurant, terms, environment: 'synthetic', channel, binding: binding.identity,
        state: 'prepared', receipt: null,
      }));
    });
  };
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
    ['readDiningMiniProgramAvailability', (raw, context) => readDiningMiniProgramAvailability(miniPath, raw, context)],
    ['prepareDiningTestReservation', prepare('web')],
    ['prepareDiningMiniProgramTestReservation', prepare('miniprogram')],
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
