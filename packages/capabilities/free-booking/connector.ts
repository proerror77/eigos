import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import { AgentReadError, AgentOperationRejected, type AgentActionContext, type AgentActionResult } from '../../core/agent-program.js';
import { bookingSourceContextSchema, bookingReceiptSchema } from '../../ontology/booking.js';
import { registrationPayloadSchema, registrationResultSchema, participantServiceUrl } from '../../ontology/free-booking.js';
import type { ParticipantBookingSource } from './program.js';

export interface ParticipantBrowserOptions { endpoint: string; tokenFile: string; bindingId: string; attendeeRef: string }
export function participantBridgeOrigin(value: string) {
  const u = new URL(value);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new DomainError('FORBIDDEN', 'Participant browser bridge must be an explicit 127.0.0.1 origin');
  return u.origin;
}
export const participantCommandSchema = z.strictObject({
  context: bookingSourceContextSchema, bindingId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  attendeeRef: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(['InspectRegistrationPage', 'SubmitFreeRegistration', 'ReadParticipantRegistration']),
  input: z.record(z.string(), z.unknown()), planDigest: z.string().regex(/^[a-f0-9]{64}$/), configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export class ParticipantBrowserConnector implements ParticipantBookingSource {
  readonly environment = 'live' as const;
  readonly identity: string; readonly attendeeRef: string; readonly origin: string; readonly configurationDigest: string;
  constructor(readonly options: ParticipantBrowserOptions) {
    this.origin = participantBridgeOrigin(options.endpoint);
    if (!isAbsolute(options.tokenFile) || !/^[A-Za-z0-9_-]{1,80}$/.test(options.bindingId) || !/^[a-f0-9]{64}$/.test(options.attendeeRef)) throw new DomainError('INVALID_INPUT', 'Participant source needs an absolute private token path and pinned account binding');
    this.identity = `luma-participant:${options.bindingId}`; this.attendeeRef = options.attendeeRef;
    this.configurationDigest = digest({ ...options, endpoint: this.origin, protocol: 'eigos.participant.browser.v1' });
  }
  async call(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal, recovery = false): Promise<AgentActionResult | undefined> {
    if (!ctx.operationKey || ctx.request.executionEnvironment === 'sandbox') throw new DomainError('FORBIDDEN', 'Participant browser requires the original live operation identity');
    let token: string;
    try { token = readFileSync(this.options.tokenFile, 'utf8').trim(); } catch { throw new AgentReadError('Participant browser credentials are unavailable'); }
    if (!/^[a-f0-9]{64}$/.test(token)) throw new AgentReadError('Participant browser credential is invalid');
    const context = bookingSourceContextSchema.parse({ ownerDigest: digest(ctx.owner), requestId: ctx.request.id, requestRevision: ctx.request.revision, action, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId, operationKey: ctx.operationKey, readbackSequence: 0 });
    const command = recovery ? undefined : participantCommandSchema.parse({ context, bindingId: this.options.bindingId, attendeeRef: this.attendeeRef, action, input, planDigest: ctx.state.plans.find(p => p.id === ctx.planId)!.digest, configurationDigest: ctx.state.programDigest });
    if (command) participantServiceUrl.parse((command.input.scope as { serviceUrl: unknown }).serviceUrl);
    signal.throwIfAborted();
    if (!recovery && action === 'SubmitFreeRegistration') { if (!ctx.assertDispatchAllowed) throw new DomainError('FORBIDDEN', 'Participant write has no current grant'); ctx.assertDispatchAllowed(); }
    const method = recovery ? 'GET' : 'POST', path = `/operations/${ctx.operationKey}`, startedAt = new Date().toISOString();
    let response: Response, raw: Buffer;
    try {
      response = await fetch(this.origin + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-eigos-context': Buffer.from(JSON.stringify(context)).toString('base64url') }, ...(command ? { body: JSON.stringify(command) } : {}), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error();
      const bytes = await response.arrayBuffer(); if (bytes.byteLength > 524288) throw new Error(); raw = Buffer.from(bytes);
    } catch { throw new AgentReadError('Participant source outcome is unknown; preserve and read the original operation'); }
    const signature = response.headers.get('x-eigos-participant-signature'), expected = createHmac('sha256', token).update(raw).digest('hex');
    if (!signature || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) throw new AgentReadError('Participant browser response signature is invalid');
    let parsed: unknown; try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new AgentReadError('Participant source returned invalid JSON'); }
    const envelope = z.strictObject({ context: bookingSourceContextSchema, sourceIdentity: z.literal(this.identity), status: z.enum(['pending', 'complete', 'rejected', 'not_found']), result: registrationPayloadSchema.optional(), browserEvidence: registrationResultSchema.shape.browserEvidence.optional(), message: z.string().max(500).optional() }).parse(parsed);
    if (digest(envelope.context) !== digest(context)) throw new AgentReadError('Participant response belongs to another owned attempt');
    if (envelope.status === 'not_found' && recovery) return;
    if (envelope.status === 'pending') {
      const age = Date.now() - Date.parse(ctx.originalDispatchAt ?? startedAt);
      const retryAfterMs = Math.min(30000, 2000 * 2 ** Math.min(4, Math.floor(Math.max(0, age) / 30000)));
      return { value: { operationKey: ctx.operationKey, source: this.identity }, evidenceRefs: [], pending: { retryAfterMs } };
    }
    if (envelope.status === 'rejected') throw new AgentOperationRejected(envelope.message ?? 'Participant source declined the operation', [digest(raw.toString('utf8'))]);
    if (!response.ok || !envelope.result || !envelope.browserEvidence) throw new AgentReadError('Participant source result is incomplete');
    const payload = envelope.result, receivedAt = new Date().toISOString(), responseSha256 = createHash('sha256').update(raw).digest('hex');
    const receipt = bookingReceiptSchema.parse({ ...context, id: digest({ context, responseSha256 }), sourceIdentity: this.identity, method, path, status: 200, responseSha256, payloadDigest: digest(payload), signature, startedAt, receivedAt });
    const result = registrationResultSchema.parse({ payload, receipt, browserEvidence: envelope.browserEvidence, evidenceLevel: action === 'SubmitFreeRegistration' ? 'live_operation' : 'live_readonly' });
    return { value: result, evidenceRefs: [receipt.id] };
  }
}
