import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import { AgentReadError, AgentOperationRejected, type AgentActionContext } from '../../core/agent-program.js';
import { commerceActionMetadata, commerceEntityTypeSchema, commerceSourceReceiptSchema, parseCommerceEntity, type CommerceJourneyAction } from '../../ontology/commerce-journey.js';
import { sourcePayloadDigest } from '../../ontology/commerce-journey-functions.js';
import type { CommerceSourceResult } from '../../ontology/commerce-journey-projection.js';

export const sandboxRequestContextSchema = z.strictObject({ ownerDigest: z.string().regex(/^[a-f0-9]{64}$/), requestId: z.string().min(1).max(200), requestRevision: z.number().int().positive(), action: z.string().min(1).max(80), planId: z.string().min(1).max(200), intentId: z.string().min(1).max(200), attemptId: z.string().min(1).max(200), modelRunId: z.string().min(1).max(200), operationKey: z.string().min(1).max(200) });
export const sandboxPayloadSchema = z.strictObject({ type: commerceEntityTypeSchema, sourceId: z.string().min(1).max(200), sourceVersion: z.number().int().positive(), data: z.record(z.string(), z.unknown()), expiresAt: z.iso.datetime({ offset: true }) });
export const sandboxResponseSchema = z.strictObject({ environment: z.literal('sandbox'), sourceIdentity: z.string().min(1).max(200), source: commerceSourceReceiptSchema.shape.source, context: sandboxRequestContextSchema, operationId: z.string().min(1).max(200), operationVersion: z.number().int().positive(), result: sandboxPayloadSchema });
export interface CommerceSandboxOptions { endpoint: string; tokenFile: string; auditDirectory?: string }
export interface CommerceSandboxConnector {
  readonly configurationDigest: string;
  call(ctx: AgentActionContext, action: CommerceJourneyAction, payload: Record<string, unknown>, signal: AbortSignal): Promise<CommerceSourceResult>;
  recover(ctx: AgentActionContext, signal: AbortSignal): Promise<CommerceSourceResult | undefined>;
}
export function commerceSandboxOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !url.port) throw new DomainError('FORBIDDEN', 'Commerce sandbox requires an explicit 127.0.0.1 origin and port');
  return url.origin;
}
/** Exactly one authenticated loopback request per invocation. No business
 * selection, discovery chain, retries or implicit refresh occurs here. */
export class HttpCommerceSandboxConnector implements CommerceSandboxConnector {
  readonly configurationDigest: string; readonly origin: string;
  constructor(private options: CommerceSandboxOptions, private fetcher: typeof fetch = fetch) {
    this.origin = commerceSandboxOrigin(options.endpoint);
    if (!isAbsolute(options.tokenFile) || options.auditDirectory && !isAbsolute(options.auditDirectory)) throw new DomainError('INVALID_INPUT', 'Sandbox credentials and private audit paths must be absolute');
    this.configurationDigest = digest({ protocol: 'eigos.commerce.sandbox.v1', origin: this.origin, tokenFile: options.tokenFile });
  }
  private metadata(ctx: AgentActionContext, action: string) {
    if (ctx.request.executionEnvironment !== 'sandbox' || !ctx.operationKey) throw new DomainError('FORBIDDEN', 'An owned sandbox operation context is required');
    return sandboxRequestContextSchema.parse({ ownerDigest: digest(ctx.owner), requestId: ctx.request.id, requestRevision: ctx.request.revision, action, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId, operationKey: ctx.operationKey });
  }
  call(ctx: AgentActionContext, action: CommerceJourneyAction, payload: Record<string, unknown>, signal: AbortSignal) {
    if (!Object.hasOwn(commerceActionMetadata, action)) throw new DomainError('FORBIDDEN', 'Unregistered commerce operation');
    return this.request(ctx, action, 'POST', `/actions/${action}`, payload, signal, false) as Promise<CommerceSourceResult>;
  }
  recover(ctx: AgentActionContext, signal: AbortSignal) { return this.request(ctx, ctx.state.plans.find(p => p.id === ctx.planId)!.steps.find(s => s.intentId === ctx.intentId)!.action, 'GET', `/operations/${encodeURIComponent(ctx.operationKey!)}`, undefined, signal, true); }
  private async request(ctx: AgentActionContext, action: string, method: 'GET' | 'POST', path: string, payload: Record<string, unknown> | undefined, signal: AbortSignal, recovery: boolean): Promise<CommerceSourceResult | undefined> {
    const context = this.metadata(ctx, action), token = readFileSync(this.options.tokenFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new AgentReadError('Sandbox credential is unavailable or invalid');
    const requestBody = payload === undefined ? undefined : JSON.stringify({ context, payload });
    // Local simulators restart between isolated runs. Do not retain a pooled
    // socket to a prior process that happened to own the same loopback port.
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', connection: 'close', 'x-eigos-context': Buffer.from(JSON.stringify(context)).toString('base64url') };
    signal.throwIfAborted(); const startedAt = new Date().toISOString();
    const response = await this.fetcher(`${this.origin}${path}`, { method, headers, ...(requestBody ? { body: requestBody } : {}), redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400 || !response.headers.get('content-type')?.includes('application/json') || Number(response.headers.get('content-length') ?? 0) > 524288) throw new AgentReadError('Sandbox response is redirected, non-JSON or oversized');
    const reader = response.body?.getReader(); if (!reader) throw new AgentReadError('Sandbox response has no body');
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 524288) { await reader.cancel(); throw new AgentReadError('Sandbox response is oversized'); } chunks.push(next.value); }
    const raw = Buffer.concat(chunks), signature = response.headers.get('x-eigos-sandbox-signature'), expected = createHmac('sha256', token).update(raw).digest('hex');
    if (!signature || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) throw new AgentReadError('Sandbox response signature does not match the configured source');
    const receivedAt = new Date().toISOString(), responseSha256 = createHash('sha256').update(raw).digest('hex'), inputDigest = digest({ method, path, context, payload: payload ?? null });
    const receiptId = digest({ context, inputDigest, responseSha256 });
    const audit = { id: receiptId, ...context, method, path, recovery, startedAt, receivedAt, status: response.status, inputDigest, responseSha256, responseBytes: length, signature, environment: 'sandbox', transportInput: { context, payload: payload ?? null } };
    if (this.options.auditDirectory) { mkdirSync(this.options.auditDirectory, { recursive: true, mode: 0o700 }); writeFileSync(join(this.options.auditDirectory, `${receiptId}.json`), raw, { mode: 0o600, flag: 'wx' }); appendFileSync(join(this.options.auditDirectory, 'http.jsonl'), JSON.stringify(audit) + '\n', { mode: 0o600 }); }
    let parsed: unknown; try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new AgentReadError('Sandbox response is invalid JSON'); }
    if (!response.ok) {
      const rejected = z.strictObject({ environment: z.literal('sandbox'), context: sandboxRequestContextSchema, error: z.strictObject({ code: z.string().regex(/^[A-Z_]{1,80}$/), applied: z.literal(false) }) }).safeParse(parsed);
      if (rejected.success && digest(rejected.data.context) === digest(context)) {
        if (recovery && response.status === 404 && rejected.data.error.code === 'OPERATION_NOT_FOUND') return;
        throw new AgentOperationRejected(`Sandbox rejected the operation without applying it: ${rejected.data.error.code}`, [receiptId]);
      }
      throw new AgentReadError(`Sandbox request failed with HTTP ${response.status}; its business outcome is unconfirmed`);
    }
    const envelope = sandboxResponseSchema.parse(parsed);
    if (digest(envelope.context) !== digest(context)) throw new AgentReadError('Sandbox response belongs to a different task or attempt');
    parseCommerceEntity(envelope.result.type, envelope.result.data);
    const { recovery: _recovery, transportInput: _transport, ...safeAudit } = audit;
    const receipt = commerceSourceReceiptSchema.parse({ ...safeAudit, source: envelope.source, sourceIdentity: envelope.sourceIdentity, operationId: envelope.operationId, operationVersion: envelope.operationVersion, payloadDigest: sourcePayloadDigest(envelope.result) });
    return { payload: envelope.result, receipt };
  }
}
