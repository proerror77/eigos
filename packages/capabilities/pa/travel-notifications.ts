import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { Conflict, digest } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import { journeyReadResult, journeyType } from '../../ontology/calendar-journey.js';
import { flightWatchRead, flightWatchType } from '../../ontology/flight.js';
import { objectRefSchema } from '../../ontology/schema.js';
import { Access } from '../../runtime/access.js';
import type { CommittedEffects } from '../../runtime/actions.js';
import type { Database } from '../../runtime/database.js';
import type { EffectHandler } from '../../runtime/effects.js';
import { ExternalOperations } from '../../runtime/external-operations.js';
import type { Functions } from '../../runtime/functions.js';
import { Metadata } from '../../runtime/metadata.js';
import { Objects } from '../../runtime/objects.js';

const target = z.strictObject({
  owner: z.string().min(1).max(200),
  endpoint: z.string().regex(/^https:\/\/api2\.cursor\.sh\/automations\/webhook\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i),
  keyFile: z.string().min(1).max(1024).refine(isAbsolute),
});
const request = z.strictObject({
  object: objectRefSchema,
  version: z.number().int().positive(),
  recipient: z.string().regex(/^[a-f0-9]{64}$/),
  operation: z.enum(['update', 'withdraw']),
});
const handlerName = 'NotifyTravelPA';
const readTarget = (path: string) => readPrivateSourceFile(path).then(raw => target.parse(JSON.parse(raw)));

export function configuredTravelNotifications(
  db: Database, getFunctions: () => Functions, path?: string, send: typeof fetch = fetch,
): { handlers: ReadonlyMap<string, EffectHandler>; committed?: CommittedEffects } {
  if (!path) return { handlers: new Map() };
  const targetPath = path;
  const metadata = new Metadata(db), operations = new ExternalOperations(db);
  const committed: CommittedEffects = async (model, owner, changes) => {
    if (model.document.id !== 'Eigos') return [];
    const notices = changes.flatMap(({ ref, before, after }) => {
      if (ref.type !== journeyType && ref.type !== flightWatchType) return [];
      const calendar = ref.type === journeyType;
      const value = calendar ? 'reminder' : 'alert', versionKey = calendar ? 'reminderVersion' : 'alertVersion';
      const previous = before?.properties[value], current = after?.properties[value];
      const version = request.shape.version.safeParse(after?.properties[versionKey]);
      if (!version.success || (!current && !previous)) return [];
      if (current && version.data === before?.properties[versionKey]) return [];
      return [{ object: ref, version: version.data, operation: current ? 'update' : 'withdraw' }];
    });
    if (!notices.length) return [];
    const connection = await readTarget(targetPath);
    if (connection.owner !== owner) return [];
    const recipient = digest(connection);
    return notices.map(notice => ({
      name: 'Travel' + digest(notice), handler: handlerName,
      payload: request.parse({ ...notice, recipient }),
    }));
  };

  const dispatch: EffectHandler = async (raw, { principal, idempotencyKey, signal }) => {
    const job = request.parse(raw), connection = await readTarget(targetPath);
    if (connection.owner !== principal.owner || digest(connection) !== job.recipient) return 'canceled';
    if (job.object.type !== journeyType && job.object.type !== flightWatchType) return 'canceled';

    const model = await metadata.active(), access = await Access.load(db, principal);
    const objects = new Objects(db, model, access);
    const context = { principal, objects, signal };
    const calendar = job.object.type === journeyType;
    const reply = await getFunctions().invoke(model, calendar ? 'readCalendarJourney' : 'readFlightWatch',
      calendar ? { journey: job.object } : { watch: job.object }, context);
    if (!await access.canReturn(access.dataRequirements()))
      throw new Conflict('Travel reminder permissions changed');
    const journey = calendar ? journeyReadResult.parse(reply) : null;
    const flight = calendar ? null : flightWatchRead.parse(reply);
    const version = journey?.reminderVersion ?? flight!.alertVersion;
    const state = journey?.state ?? flight!.state;
    const item = journey?.reminder ?? flight?.alert;
    if (version !== job.version || (job.operation === 'update' ? !item : Boolean(item))) return 'canceled';
    if (flight?.alert && Date.now() >= Date.parse(flight.alert.createdAt) + 60 * 60000) return 'canceled';
    const message = {
      type: 'travel_reminder', operation: job.operation, idempotencyKey,
      object: job.object, version, state, reason: journey?.reason ?? flight!.reason,
      calendar: journey ? { reminder: journey.reminder, validUntil: journey.validUntil,
        departureAt: journey.timing?.departAt ?? null, arrivalBy: journey.timing?.arriveBy ?? null } : null,
      flight: flight?.alert ? { changes: flight.alert.changes, status: flight.alert.flight.status,
        number: flight.alert.flight.flightNumber, departureAirport: flight.alert.flight.origin,
        arrivalAirport: flight.alert.flight.destination, gate: flight.alert.flight.gate,
        terminal: flight.alert.flight.departureTerminal, scheduledDeparture: flight.alert.flight.scheduledDeparture,
        estimatedDeparture: flight.alert.flight.estimatedDeparture, estimatedArrival: flight.alert.flight.estimatedArrival } : null,
    };
    const key = (await readPrivateSourceFile(connection.keyFile)).trim();
    if (!/^[\x21-\x7e]{16,8192}$/.test(key)) throw new Conflict('Invalid PA delivery credential');
    signal.throwIfAborted();
    await operations.run(principal.owner, idempotencyKey, { ...job }, async client => {
      await access.refresh(client);
      if (!await access.canReturn(access.dataRequirements(), client))
        throw new Conflict('Travel reminder permissions changed');
      const current = await new Objects(db, model, access, client).read(job.object);
      if (current.revision !== (journey?.revision ?? flight!.revision))
        throw new Conflict('Travel reminder changed before dispatch');
      if (await metadata.active(model.document.id, client, true).then(active => active.release) !== model.release)
        throw new Conflict('Ontology publication changed before dispatch');
      if (digest(await readTarget(targetPath)) !== job.recipient) throw new Conflict('PA connection changed');
      signal.throwIfAborted();
    }, async () => {
      const response = await send(connection.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(message),
      });
      if (response.status !== 200) throw new Conflict('PA webhook did not confirm admission');
      // The documented 200 is admission. Preserve the optional run identity when supplied.
      const raw = await response.text();
      if (raw.length > 16384) throw new Conflict('PA receipt is too large');
      const receipt = z.object({ success: z.literal(true).optional(), runUuid: z.uuid().optional(), error: z.null().optional() })
        .parse(raw ? JSON.parse(raw) : {});
      return { acceptedAt: new Date().toISOString(), runId: receipt.runUuid ?? null };
    }, objects);
  };

  return { handlers: new Map([[handlerName, dispatch]]), committed };
}
