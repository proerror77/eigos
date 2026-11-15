import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { Conflict, digest } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import { journeyReadResult, journeyReminder, journeyType } from '../../ontology/calendar-journey.js';
import { flightAlert, flightWatchRead, flightWatchType } from '../../ontology/flight.js';
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
  endpoint: z.string().trim().regex(/^https:\/\/api2\.cursor\.sh\/automations\/webhook\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i),
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
function readyJourney(value: unknown) {
  const reminder = journeyReminder.safeParse(value);
  return reminder.success && reminder.data.state !== 'scheduled';
}
const localTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const flightStatusLabels = {
  scheduled: '计划中', delayed: '延误', cancelled: '取消', airborne: '已起飞',
  arrived: '已到达', diverted: '备降', returned: '返航', unknown: '状态待确认',
};
const formatTime = (value: string) => localTime.format(new Date(value)) + '（上海时间）';

function flightUpdateText({ flight, changes }: z.infer<typeof flightAlert>) {
  const details = [flight.flightNumber + ' 航班动态：' + flightStatusLabels[flight.status]];
  if (flight.departureTerminal) details.push('航站楼 ' + flight.departureTerminal);
  if (flight.gate) details.push('登机口 ' + flight.gate);
  if (changes.includes('departure_time')) details.push('预计起飞 ' + formatTime(flight.estimatedDeparture ?? flight.scheduledDeparture));
  const arrival = flight.estimatedArrival ?? flight.scheduledArrival;
  if (changes.includes('arrival_time') && arrival) details.push('预计到达 ' + formatTime(arrival));
  return details.join('，') + '。';
}

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
      // A future departure stays on the EIGOS schedule until due. Report transitions away from
      // an actionable reminder so the PA can withdraw it.
      const actionable = calendar ? readyJourney(current) : Boolean(current);
      const wasActionable = calendar ? readyJourney(previous) : Boolean(previous);
      if (!actionable && !wasActionable) return [];
      if (actionable && version.data === before?.properties[versionKey]) return [];
      return [{ object: ref, version: version.data, operation: actionable ? 'update' : 'withdraw' }];
    });
    if (!notices.length) return [];
    const connection = await readTarget(targetPath).catch(() => {
      console.error('Travel PA connection could not be read');
      return null;
    });
    if (connection?.owner !== owner) return [];
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
    const reminder = journey?.reminder?.state === 'scheduled' ? null : journey?.reminder;
    const alert = flight?.alert;
    if (version !== job.version || (job.operation === 'update') !== Boolean(reminder || alert)) return 'canceled';
    if (alert && Date.now() >= Date.parse(alert.createdAt) + 60 * 60000) return 'canceled';
    let text = calendar ? '出发提醒已撤回。' : '航班提醒已撤回。';
    if (journey && reminder) {
      const advice = journey.timing ? ' 建议出发时间为 ' + formatTime(journey.timing.departAt) + '。' : '';
      text = (reminder.state === 'risk' ? '当前行程有冲突或迟到风险。' : '该准备出发了。') + advice;
    }
    if (alert) text = flightUpdateText(alert);
    const message = {
      type: 'travel_reminder', operation: job.operation, idempotencyKey,
      object: job.object, version, state, reason: journey?.reason ?? flight!.reason, text,
      calendar: journey ? { reminder: reminder ?? null, validUntil: journey.validUntil,
        departureAt: journey.timing?.departAt ?? null, arrivalBy: journey.timing?.arriveBy ?? null } : null,
      flight: alert ? { changes: alert.changes, status: alert.flight.status,
        number: alert.flight.flightNumber, departureAirport: alert.flight.origin,
        arrivalAirport: alert.flight.destination, gate: alert.flight.gate,
        terminal: alert.flight.departureTerminal, scheduledDeparture: alert.flight.scheduledDeparture,
        estimatedDeparture: alert.flight.estimatedDeparture, estimatedArrival: alert.flight.estimatedArrival } : null,
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
      const acceptedAt = new Date().toISOString();
      const receipt = z.object({ runUuid: z.uuid().optional() }).safeParse(await response.json().catch(() => null));
      return { acceptedAt, runId: receipt.data?.runUuid ?? null };
    }, objects);
  };

  return { handlers: new Map([[handlerName, dispatch]]), committed };
}
