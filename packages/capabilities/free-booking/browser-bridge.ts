import { isFreeRegistration } from '../../ontology/free-booking-functions.js';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { createHmac, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { BACKEND_VERSION } from '../../ontology/execution.js';
import type { Job } from '../../core/domain.js';
import type { PlanGrant } from '../../ontology/actions.js';
import { bookingSourceContextSchema } from '../../ontology/booking.js';
import { registrationInputSchema, registrationOfferSchema, registrationRecordSchema, participantServiceUrl } from '../../ontology/free-booking.js';
import { participantCommandSchema } from './connector.js';

type Command = z.infer<typeof participantCommandSchema>;
type QueueRow = { key: string; state: string; command: Command; result?: object; browserEvidence?: object; message?: string };
const localOwner = JSON.stringify(['local-development', 'local', 'developer']);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
class Rejection extends Error { constructor(readonly safeMessage: string, readonly status = 409) { super(safeMessage); } }
function reject(message: string, status = 409): never { throw new Rejection(message, status); }
async function json(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) reject('Input is too large', 413); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
/** Durable, operator-assisted browser transport, not an attendee API. The
 * operator uses the authorized visible browser and submits fresh page evidence.
 * Worker and operator credentials are separate; model tools possess neither. */
export async function createParticipantBrowserBridge(options: {
  databasePath: string; taskDatabasePath: string; evidenceDirectory: string; bindingId: string; attendeeRef: string;
  workerToken: string; operatorToken: string; port?: number;
}) {
  if (![options.databasePath, options.taskDatabasePath, options.evidenceDirectory].every(isAbsolute) || resolve(options.databasePath) === resolve(options.taskDatabasePath) || !/^[A-Za-z0-9_-]{1,80}$/.test(options.bindingId) || !/^[a-f0-9]{64}$/.test(options.attendeeRef) || !/^[a-f0-9]{64}$/.test(options.workerToken) || !/^[a-f0-9]{64}$/.test(options.operatorToken) || options.workerToken === options.operatorToken) throw new Error('Participant bridge requires distinct private files, credentials and a pinned local account');
  mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 }); mkdirSync(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  const evidenceRoot = realpathSync(options.evidenceDirectory), db = new DatabaseSync(options.databasePath), taskDb = new DatabaseSync(options.taskDatabasePath, { readOnly: true });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY,state TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS observations (version INTEGER PRIMARY KEY AUTOINCREMENT,operation_key TEXT UNIQUE NOT NULL);');
  const identity = `luma-participant:${options.bindingId}`;
  const get = (key: string): QueueRow | undefined => { const row = db.prepare('SELECT body FROM operations WHERE key=?').get(key); return row ? JSON.parse(String(row.body)) : undefined; };
  const save = (row: QueueRow) => db.prepare('INSERT INTO operations VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,body=excluded.body').run(row.key, row.state, JSON.stringify(row));
  const authority = (command: Command, writing = false) => {
    const row = taskDb.prepare('SELECT body,owner FROM jobs WHERE id=?').get(command.context.requestId);
    if (!row || row.owner !== localOwner || command.context.ownerDigest !== digest(localOwner)) reject('The original participant task is unavailable', 403);
    const job = JSON.parse(String(row.body)) as Job, d = job.delegation, state = d?.agent;
    if (d?.backendVersion !== BACKEND_VERSION || !(command.observation ? ['working', 'submitted', 'input-required', 'auth-required'] : ['working', 'submitted']).includes(job.state) || d.request.revision !== command.context.requestRevision || !state) reject('Participant task was canceled, changed or stopped', 403);
    if (command.observation) {
      const selected = command.observation;
      if (writing || command.action !== 'ReadParticipantRegistration' || command.context.planId !== selected.watchId || command.context.intentId !== selected.watchId || command.context.attemptId !== selected.readId || command.context.operationKey !== digest({ watch: selected.watchId, read: selected.readId })) reject('A standing observation cannot dispatch a participant write', 403);
      const watchRow = taskDb.prepare('SELECT body FROM observation_watches WHERE owner=? AND id=? AND job_id=?').get(localOwner, selected.watchId, job.id);
      const readRow = taskDb.prepare('SELECT body FROM observation_reads WHERE owner=? AND id=? AND watch_id=? AND job_id=?').get(localOwner, selected.readId, selected.watchId, job.id);
      if (!watchRow || !readRow) reject('The participant observation has no persisted selection and read attempt', 403);
      const watch = JSON.parse(String(watchRow.body)) as import('../../ontology/situation.js').ObservationWatch;
      const read = JSON.parse(String(readRow.body)) as import('../../ontology/situation.js').ObservationRead & { status: string };
      const participant = watch.selection.componentId ? state.components?.[watch.selection.componentId] : state;
      const selectionPlan = state.plans.find(plan => plan.id === watch.selection.planId);
      if (!d.request.monitoring || watch.contractDigest !== digest(d.request.monitoring) || watch.contractDigest !== selected.contractDigest || watch.status !== 'active' || watch.superseded || watch.revision !== selected.watchRevision
        || watch.requestRevision !== d.request.revision || Date.now() > Date.parse(watch.contract.until) + 1_800_000 || digest(watch.selection) !== selected.selectionDigest || command.planDigest !== selected.selectionDigest
        || watch.selection.action !== command.action || watch.selection.modelRunId !== command.context.modelRunId || !selectionPlan || selectionPlan.modelRunId !== watch.selection.modelRunId
        || !selectionPlan.steps.some(step => ['StartObservationWatch', 'StartTaskObservationWatch'].includes(step.action))
        || watch.selection.programDigest !== state.programDigest || digest(watch.selection.programRef) !== digest(state.programRef)
        || read.watchRevision !== watch.revision || !['started', 'pending'].includes(read.status)
        || !participant || participant.programRef.id !== 'booking.participant.free' || participant.programDigest !== command.configurationDigest || digest(participant.scope) !== digest(watch.selection.scope)
        || watch.selection.componentId && (participant as import('../../ontology/composition.js').ComponentState).generation !== watch.selection.generation
        || watch.selection.source.bindingId !== identity || watch.selection.source.accountRef !== options.attendeeRef || watch.selection.source.bindingDigest !== command.configurationDigest
        || digest(registrationInputSchema.parse(participant.input)) !== digest(registrationInputSchema.parse(command.input.scope))) reject('Participant observation authority, source or generation changed', 403);
      const previous = command.input.previous as { registrationId?: string } | undefined;
      if (previous?.registrationId && previous.registrationId !== watch.selection.source.subjectId) reject('The watched registration identity changed', 403);
      return;
    }
    if (state.pendingPlanId !== command.context.planId) reject('Participant plan is no longer pending', 403);
    const plan = state.plans.find(p => p.id === command.context.planId), step = plan?.steps.find(s => s.intentId === command.context.intentId);
    if (!plan || plan.digest !== command.planDigest || !step || step.action !== command.action || step.operationKey !== command.context.operationKey) reject('The original participant plan changed', 403);
    const { digest: planDigest, ...planBody } = plan;
    if (digest(planBody) !== planDigest || plan.requestId !== job.id || plan.requestRevision !== d.request.revision || digest(plan.programRef) !== digest(state.programRef) || plan.programDigest !== state.programDigest) reject('The participant execution binding changed', 403);
    const components = state.programRef.id === 'services.compose.live' && state.programRef.version === '2'
      ? Object.entries(state.components ?? {}).filter(([, c]) => c.programRef.id === 'booking.participant.free' && c.programRef.version === '1' && c.scope && digest(c.scope) === digest(step.input.scope) && (!c.result || !writing && command.action === 'ReadParticipantRegistration')) : [];
    const participant = state.programRef.id === 'booking.participant.free' && state.programRef.version === '1' ? state : components.length === 1 ? components[0]![1] : undefined;
    if (!participant || participant.programDigest !== command.configurationDigest || digest(registrationInputSchema.parse(participant.input)) !== digest(registrationInputSchema.parse(command.input.scope))) reject('The original participant component or service scope changed', 403);
    if (components.length) {
      const nodes = (state.input as { components?: { id: string; capabilityRef: { id: string; version: string } }[] }).components;
      if (!nodes?.some(n => n.id === components[0]![0] && digest(n.capabilityRef) === digest(participant.programRef))) reject('Participant component was not selected in the original graph', 403);
    }
    if (writing) {
      if (plan.environment !== 'live_free' || step.effect !== 'reserve' || step.additionalEffects?.length || step.cost?.minor !== '0') reject('Only an exact zero-charge participant reservation may be dispatched', 403);
      const grants = taskDb.prepare('SELECT body FROM plan_grants WHERE owner=? AND job_id=?').all(localOwner, job.id).map(r => JSON.parse(String(r.body)) as PlanGrant);
      if (!grants.some(g => !g.revoked && g.planDigest === plan.digest && g.environment === 'live_free' && Date.parse(g.expiresAt) > Date.now() && g.allowedEffects.length === 1 && g.allowedEffects[0] === 'reserve' && g.maxAmount.minor === '0' && g.maxAmount.currency === step.cost!.currency && g.payeeIds.includes(identity) && g.bindingRefs.some(ref => digest(ref) === digest(plan.programRef)))) reject('The zero-charge reservation permit expired or was revoked', 403);
      const offer = registrationOfferSchema.parse(command.input.offer);
      if (!isFreeRegistration(offer) || offer.requiresAdditionalConsent || offer.alreadyRegistered || offer.availability !== 'available' || Date.parse(offer.expiresAt) <= Date.now()) reject('The selected free registration terms expired or changed', 403);
    }
  };
  const evidenceFile = (path: string) => {
    const actual = realpathSync(path), rel = relative(evidenceRoot, actual);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) reject('Browser evidence must stay in the private evidence directory', 403);
    const data = readFileSync(actual); if (!data.length || data.length > 10 * 1024 * 1024) reject('Browser evidence is empty or too large'); return data;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1'); let context: z.infer<typeof bookingSourceContextSchema> | undefined;
    const send = (value: unknown, status = 200) => { const raw = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-eigos-participant-signature': createHmac('sha256', options.workerToken).update(raw).digest('hex') }); res.end(raw); };
    try {
      if (req.headers.origin) reject('Browser-origin requests are not accepted', 403);
      if (url.pathname === '/health' && req.method === 'GET') {
        send({ status: 'ok', backend: BACKEND_VERSION, releaseDigest: process.env.EIGOS_RELEASE_DIGEST, operatorRequired: true, unattended: false }); return;
      }
      if (url.pathname.startsWith('/operator/')) {
        if (req.headers.authorization !== `Bearer ${options.operatorToken}`) reject('Operator authentication required', 403);
        if (url.pathname === '/operator/next' && req.method === 'GET') {
          const rows = db.prepare("SELECT body FROM operations WHERE state IN ('queued','dispatched') ORDER BY rowid LIMIT 10").all().map(r => JSON.parse(String(r.body)) as QueueRow);
          send({ operations: rows }); return;
        }
        const match = /^\/operator\/(dispatch|resolve)\/([a-f0-9]{64})$/.exec(url.pathname);
        if (!match || req.method !== 'POST') reject('Unknown operator action', 404);
        const row = get(match[2]!) ?? reject('Original operation is unavailable', 404);
        if (['complete', 'rejected'].includes(row.state)) reject('The operation already has a terminal result');
        if (match[1] === 'dispatch') {
          if (row.state !== 'queued') reject('This browser operation was already dispatched; inspect its outcome instead of clicking again');
          authority(row.command, row.command.action === 'SubmitFreeRegistration');
          row.state = 'dispatched'; save(row); send({ dispatchAllowed: true, operationKey: row.key, action: row.command.action, serviceUrl: registrationInputSchema.parse(row.command.input.scope).serviceUrl }); return;
        }
        const input = z.union([
          z.strictObject({ rejected: z.string().trim().min(1).max(500) }),
          z.strictObject({ data: z.record(z.string(), z.unknown()), pageUrl: participantServiceUrl, snapshotPath: z.string(), screenshotPath: z.string() }),
        ]).parse(await json(req));
        if ('rejected' in input) { row.state = 'rejected'; row.message = input.rejected; save(row); send({ recorded: true }); return; }
        if (row.state !== 'dispatched') reject('Read or submit through the explicit browser dispatch first');
        const scope = registrationInputSchema.parse(row.command.input.scope), type = row.command.action === 'InspectRegistrationPage' ? 'RegistrationOffer' : 'RegistrationRecord';
        const data = type === 'RegistrationOffer' ? registrationOfferSchema.parse(input.data) : registrationRecordSchema.parse(input.data);
        if (type === 'RegistrationRecord' && /[?&](?:tk|token|key|auth)=/i.test(JSON.stringify(data))) reject('Do not export guest access tokens in registration facts');
        if (input.pageUrl !== scope.serviceUrl || data.serviceUrl !== scope.serviceUrl || data.kind !== scope.kind || data.attendeeRef !== options.attendeeRef || data.participants !== scope.participants || Date.parse(data.observedAt) > Date.now() || Date.parse(data.observedAt) < Date.now() - 300000) reject('Browser observation does not match this event, participant or current time');
        if (type === 'RegistrationRecord' && (data as z.infer<typeof registrationRecordSchema>).independentRead !== (row.command.action === 'ReadParticipantRegistration')) reject('Submission cannot substitute for independent readback');
        const snapshot = evidenceFile(input.snapshotPath), screenshot = evidenceFile(input.screenshotPath);
        const sourceText = snapshot.toString('utf8');
        if (!sourceText.includes(new URL(scope.serviceUrl).pathname.slice(1)) || !sourceText.includes(data.title)) reject('The evidence does not show the original event');
        if (type === 'RegistrationRecord' && (data as z.infer<typeof registrationRecordSchema>).state === 'confirmed' && !/You're In|You're Going|已报名|报名成功|已注册|已登记|你已加入|您已报名|已确认|You are registered/i.test(sourceText)) reject('The browser evidence does not show confirmed participation');
        db.prepare('INSERT INTO observations(operation_key) VALUES(?)').run(row.key);
        const version = Number(db.prepare('SELECT version FROM observations WHERE operation_key=?').get(row.key)!.version);
        row.state = 'complete'; row.result = { type, sourceId: type === 'RegistrationOffer' ? scope.serviceUrl : (data as z.infer<typeof registrationRecordSchema>).registrationId, sourceVersion: version, expiresAt: new Date(Date.now() + 300000).toISOString(), data };
        row.browserEvidence = { pageUrl: input.pageUrl, snapshotSha256: hash(snapshot), screenshotSha256: hash(screenshot), observedAt: data.observedAt };
        save(row); send({ recorded: true, sourceVersion: version }); return;
      }
      if (req.headers.authorization !== `Bearer ${options.workerToken}`) reject('Worker authentication required', 403);
      context = bookingSourceContextSchema.parse(JSON.parse(Buffer.from(String(req.headers['x-eigos-context']), 'base64url').toString('utf8')));
      const match = /^\/operations\/([a-f0-9]{64})$/.exec(url.pathname);
      if (!match || match[1] !== context.operationKey || !['POST', 'GET'].includes(req.method!)) reject('Unknown participant operation', 404);
      let row = get(match[1]!);
      if (req.method === 'POST') {
        const command = participantCommandSchema.parse(await json(req));
        if (digest(command.context) !== digest(context) || command.bindingId !== options.bindingId || command.attendeeRef !== options.attendeeRef) reject('Participant binding or original context changed', 403);
        participantServiceUrl.parse(registrationInputSchema.parse(command.input.scope).serviceUrl);
        if (row && digest(row.command) !== digest(command)) reject('The original operation input changed');
        if (!row) { authority(command, command.action === 'SubmitFreeRegistration'); row = { key: match[1]!, state: 'queued', command }; save(row); }
      }
      if (row && (row.command.context.ownerDigest !== context.ownerDigest || row.command.context.requestId !== context.requestId || row.command.context.requestRevision !== context.requestRevision || row.command.context.intentId !== context.intentId || row.command.action !== context.action)) reject('This operation belongs to another participant task', 403);
      send({ context, sourceIdentity: identity, status: row ? row.state === 'complete' ? 'complete' : row.state === 'rejected' ? 'rejected' : 'pending' : 'not_found', ...(row?.result ? { result: row.result, browserEvidence: row.browserEvidence } : {}), ...(row?.message ? { message: row.message } : {}) });
    } catch (error) {
      const message = error instanceof Rejection ? error.safeMessage : 'Invalid participant operation input';
      send(context ? { context, sourceIdentity: identity, status: 'rejected', message } : { error: message }, error instanceof Rejection ? error.status : 400);
    }
  });
  server.listen(options.port ?? 0, '127.0.0.1'); await once(server, 'listening');
  return { endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); db.close(); taskDb.close(); } };
}
