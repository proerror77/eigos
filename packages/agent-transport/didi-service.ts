import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DidiMcpConnector, DidiReadError, type DidiConnector } from '../capabilities/didi/connector.js';
import { didiBindingSchema, didiToolInputs } from '../capabilities/didi/contracts.js';
import { agentIdSchema, relayOrigin, RelayError } from '../relay/contracts.js';
import { openPrivateDatabase, transaction } from '../relay/files.js';
import { RelayClient, type ReceivedMessage } from './client.js';
import { SOURCE_RELAY_PROTOCOL, sourceReadRequestSchema, sourceReadResponseSchema, type SourceReadRequest, type SourceReadResponse } from './service-contracts.js';

export const didiServiceConfigSchema = z.strictObject({
  version: z.literal(1), authorityId: z.uuid(), gatewayAgentId: agentIdSchema,
  gatewayOrigin: z.url().refine(v => new URL(v).protocol === 'https:' && new URL(v).origin === v),
  relayUrl: z.string().transform(relayOrigin), credentialPath: z.string().refine(isAbsolute),
  statePath: z.string().refine(isAbsolute).optional(), ledgerPath: z.string().refine(isAbsolute),
  displayName: z.string().min(1).max(80).default('DiDi read-only service'),
  binding: didiBindingSchema.extend({ environment: z.literal('production') }),
});
export type DidiServiceConfig = z.infer<typeof didiServiceConfigSchema>;

type AuthorizationStage = 'request' | 'provider_dispatch' | 'provider_result' | 'result' | 'delivery';
export interface SourceAuthorizationEvent {
  callId: string; stage: AuthorizationStage; elapsedMs: number; status?: number;
  outcome: 'authorized' | 'denied' | 'unavailable' | 'canceled';
  reason?: 'expired' | 'http' | 'network' | 'timeout' | 'invalid_response';
}
class SourceAuthorizationError extends Error {
  constructor(readonly outcome: 'denied' | 'unavailable', readonly reason: NonNullable<SourceAuthorizationEvent['reason']>) {
    super(`Read authorization ${outcome}`);
  }
}

/** A source Agent has provider credentials and a local read receipt ledger, never the task database. */
export class DidiRelayService {
  private db;
  constructor(readonly client: RelayClient, private config: DidiServiceConfig, private connector: DidiConnector = new DidiMcpConnector(config.binding), private fetcher: typeof fetch = fetch,
    private diagnostic?: (event: SourceAuthorizationEvent) => void) {
    didiServiceConfigSchema.parse(config);
    if (connector.evidenceKind !== 'live_readonly') throw new Error('This service accepts production read-only sources only');
    this.db = openPrivateDatabase(config.ledgerPath, 0x45475331);
    this.db.exec('CREATE TABLE IF NOT EXISTS source_relay_reads (id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT)');
  }
  close() { this.db.close(); }
  private async authorize(request: SourceReadRequest, signal: AbortSignal, stage: AuthorizationStage) {
    const started = performance.now(); let status: number | undefined;
    const report = (outcome: SourceAuthorizationEvent['outcome'], reason?: SourceAuthorizationEvent['reason']) => {
      // Diagnostics contain only fixed classifications and correlation IDs, never proofs or response bodies.
      try { this.diagnostic?.({ callId: request.callId, stage, elapsedMs: performance.now() - started, outcome, ...(status === undefined ? {} : { status }), ...(reason ? { reason } : {}) }); } catch { /* Logging cannot change permission decisions. */ }
    };
    try {
      signal.throwIfAborted();
      if (Date.now() >= request.expiresAt) throw new SourceAuthorizationError('denied', 'expired');
      const path = `/relay/source-reads/${request.callId}/authorize`, proof = await this.client.sourceReadProof(request.callId, this.config.gatewayOrigin);
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      let response: Response; const chunks: Uint8Array[] = [];
      try {
        response = await this.fetcher(this.config.gatewayOrigin + path, {
          method: 'POST', redirect: 'error', signal: bounded,
          headers: { DPoP: proof, 'Content-Type': 'application/json' }, body: '{}',
        });
        status = response.status;
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new SourceAuthorizationError(status >= 500 || status === 408 || status === 429 ? 'unavailable' : 'denied', 'http');
        }
        if (Number(response.headers.get('content-length') ?? 0) > 4096) {
          await response.body?.cancel().catch(() => {});
          throw new SourceAuthorizationError('denied', 'invalid_response');
        }
        const reader = response.body?.getReader(); if (!reader) throw new SourceAuthorizationError('denied', 'invalid_response');
        let size = 0;
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 4096) { await reader.cancel(); throw new SourceAuthorizationError('denied', 'invalid_response'); }
          chunks.push(value);
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof SourceAuthorizationError) throw error;
        throw new SourceAuthorizationError('unavailable', bounded.aborted || error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
      }
      const result = z.strictObject({ authorized: z.literal(true), authorityId: z.uuid(), callId: z.uuid(), requestDigest: z.string(), expiresAt: z.number().int() }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      signal.throwIfAborted();
      if (result.authorityId !== this.config.authorityId || result.callId !== request.callId || result.requestDigest !== digest(request)
        || result.expiresAt !== request.expiresAt || result.expiresAt <= Date.now()) throw new SourceAuthorizationError('denied', 'invalid_response');
      report('authorized');
    } catch (error) {
      if (signal.aborted) { report('canceled'); throw error; }
      const failure = error instanceof SourceAuthorizationError ? error : new SourceAuthorizationError('denied', 'invalid_response');
      report(failure.outcome, failure.reason); throw failure;
    }
  }
  async handle(message: ReceivedMessage, signal: AbortSignal) {
    const parsed = sourceReadRequestSchema.safeParse(message.content);
    if (!parsed.success || message.senderId !== this.config.gatewayAgentId) return;
    const request = parsed.data;
    if (request.authorityId !== this.config.authorityId || request.gatewayOrigin !== this.config.gatewayOrigin
      || request.expiresAt > message.expiresAt || message.expiresAt <= Date.now()) return;
    const base = { protocol: SOURCE_RELAY_PROTOCOL, kind: 'source.result' as const, callId: request.callId, authorityId: request.authorityId, requestDigest: digest(request) };
    let result: SourceReadResponse;
    try {
      await this.authorize(request, signal, 'request');
      if (request.source.bindingId !== this.config.binding.bindingId || request.source.keySha256 !== this.config.binding.keySha256 || request.source.environment !== this.config.binding.environment) throw new Error('Source binding mismatch');
      const input = didiToolInputs[request.tool].parse(request.input);
      if (digest(input) !== digest(request.input)) throw new Error('Source input mismatch');
      const previous = this.db.prepare('SELECT * FROM source_relay_reads WHERE id=?').get(request.callId);
      if (previous && previous.request_digest !== base.requestDigest) return;
      if (previous?.result) result = sourceReadResponseSchema.parse(JSON.parse(String(previous.result)));
      else if (previous) result = { ...base, error: 'READ_OUTCOME_UNKNOWN' };
      else {
        // A crash after dispatch cannot silently replay the same provider read.
        transaction(this.db, () => this.db.prepare("INSERT INTO source_relay_reads VALUES(?,?,'processing',NULL)").run(request.callId, base.requestDigest));
        try {
          // Request authorization already covers connection preparation. Keep
          // a fresh authorization immediately before the actual tools/call.
          const observed = await this.connector.invoke(request.context, request.tool, input, signal, phase => phase==='prepare'?undefined:this.authorize(request, signal, 'provider_dispatch'));
          result = sourceReadResponseSchema.parse({ ...base, result: observed });
        } catch (error) {
          if (signal.aborted) throw error;
          result = { ...base, error: error instanceof DidiReadError && error.code === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'SOURCE_UNAVAILABLE' };
        }
        // Keep the private receipt before a fallible authorization round trip. A
        // retry must recheck permission and return this receipt, never reread the provider.
        this.db.prepare("UPDATE source_relay_reads SET state='completed',result=? WHERE id=?").run(JSON.stringify(result), request.callId);
      }
      // One current result check follows receipt persistence, including after
      // recovery. Delivery still rechecks immediately before sending facts.
      await this.authorize(request, signal, 'result');
    } catch (error) {
      if (signal.aborted) throw error;
      // Leave the durable inbox pending until its original deadline. The host's
      // bounded backoff will retry, with fresh permission checks on every attempt.
      if (error instanceof SourceAuthorizationError && error.outcome === 'unavailable') throw error;
      result = { ...base, error: 'AUTHORIZATION_REJECTED' };
    }
    let id: string;
    try { id = await this.client.queue(message.senderId, message.connectionId, result, { expiresAt: request.expiresAt }); }
    catch (error) {
      if (!(error instanceof RelayError) || error.code !== 'CONTENT_TOO_LARGE') throw error;
      id = await this.client.queue(message.senderId, message.connectionId, { ...base, error: 'RESULT_TOO_LARGE' }, { expiresAt: request.expiresAt });
    }
    await this.client.deliver(id, { signal, beforeSend: async () => {
      if (result.result) await this.authorize(request, signal, 'delivery');
      if (Date.now() >= request.expiresAt) throw new Error('Read expired before result delivery');
    } });
  }
}
