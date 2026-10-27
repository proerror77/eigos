import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DidiMcpConnector, type DidiConnector } from '../capabilities/didi/connector.js';
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

/** A source Agent has provider credentials and a local read receipt ledger, never the task database. */
export class DidiRelayService {
  private db;
  constructor(readonly client: RelayClient, private config: DidiServiceConfig, private connector: DidiConnector = new DidiMcpConnector(config.binding), private fetcher: typeof fetch = fetch) {
    didiServiceConfigSchema.parse(config);
    if (connector.evidenceKind !== 'live_readonly') throw new Error('This service accepts production read-only sources only');
    this.db = openPrivateDatabase(config.ledgerPath, 0x45475331);
    this.db.exec('CREATE TABLE IF NOT EXISTS source_relay_reads (id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT)');
  }
  close() { this.db.close(); }
  private async authorize(request: SourceReadRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    if (Date.now() >= request.expiresAt) throw new Error('Read authorization expired');
    const path = `/relay/source-reads/${request.callId}/authorize`, proof = await this.client.sourceReadProof(request.callId, this.config.gatewayOrigin);
    const response = await this.fetcher(this.config.gatewayOrigin + path, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      headers: { DPoP: proof, 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 4096) throw new Error('Read authorization rejected');
    const reader = response.body?.getReader(); if (!reader) throw new Error('Read authorization unavailable');
    let size = 0; const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new Error('Read authorization response too large'); }
      chunks.push(value);
    }
    const result = z.strictObject({ authorized: z.literal(true), authorityId: z.uuid(), callId: z.uuid(), requestDigest: z.string(), expiresAt: z.number().int() }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    signal.throwIfAborted();
    if (result.authorityId !== this.config.authorityId || result.callId !== request.callId || result.requestDigest !== digest(request)
      || result.expiresAt !== request.expiresAt || result.expiresAt <= Date.now()) throw new Error('Read authorization mismatch');
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
      await this.authorize(request, signal);
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
          const observed = await this.connector.invoke(request.context, request.tool, input, signal, () => this.authorize(request, signal));
          await this.authorize(request, signal);
          result = sourceReadResponseSchema.parse({ ...base, result: observed });
        } catch (error) {
          if (signal.aborted) throw error;
          result = { ...base, error: 'SOURCE_UNAVAILABLE' };
        }
        this.db.prepare("UPDATE source_relay_reads SET state='completed',result=? WHERE id=?").run(JSON.stringify(result), request.callId);
      }
      // Permission is rechecked for recovered receipts too.
      await this.authorize(request, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      result = { ...base, error: 'AUTHORIZATION_REJECTED' };
    }
    let id: string;
    try { id = await this.client.queue(message.senderId, message.connectionId, result, { expiresAt: request.expiresAt }); }
    catch (error) {
      if (!(error instanceof RelayError) || error.code !== 'CONTENT_TOO_LARGE') throw error;
      id = await this.client.queue(message.senderId, message.connectionId, { ...base, error: 'RESULT_TOO_LARGE' }, { expiresAt: request.expiresAt });
    }
    await this.client.deliver(id, { signal, beforeSend: async () => {
      if (result.result) await this.authorize(request, signal);
      if (Date.now() >= request.expiresAt) throw new Error('Read expired before result delivery');
    } });
  }
}
