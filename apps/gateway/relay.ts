import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Express, Request, RequestHandler } from 'express';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import type { Principal } from '../../packages/core/domain.js';
import { digest } from '../../packages/core/delegation.js';
import type { JobStore } from '../../packages/core/store.js';
import type { TaskService } from '../../packages/core/tasks.js';
import { RelayClient } from '../../packages/agent-transport/client.js';
import { verifyCard, verifyProof } from '../../packages/agent-transport/crypto.js';
import { TaskRelayHost } from '../../packages/agent-transport/task-host.js';
import { TASK_RELAY_PROTOCOL, taskRelayMetadataSchema } from '../../packages/agent-transport/task-contracts.js';
import { agentIdSchema, relayOrigin, RelayError } from '../../packages/relay/contracts.js';
import { SecurityError } from '../../packages/security/store.js';
import { sourceReadResponseSchema } from '../../packages/agent-transport/service-contracts.js';
import { RelayEnrollmentIssuer } from '../../packages/agent-transport/enrollment.js';
import { readPrivateJson } from '../../packages/relay/files.js';

const relayConfigSchema = z.strictObject({
  version: z.literal(1), relayUrl: z.string().transform(relayOrigin),
  credentialPath: z.string().refine(isAbsolute), statePath: z.string().refine(isAbsolute).optional(),
  displayName: z.string().min(1).max(80).default('EIGOS'),
  enrollmentKeyFile: z.string().refine(isAbsolute).optional(),
  operatorInstallationId: z.uuid().optional(),
});
export function readTaskRelayConfig(path: string) {
  return relayConfigSchema.parse(readPrivateJson(path, 8192));
}

export class TaskRelayGateway {
  private client?: RelayClient;
  private host?: TaskRelayHost;
  private abort = new AbortController();
  private running?: Promise<void>;
  private dispatching?: Promise<void>;
  private opening?: Promise<void>;
  private state: 'starting' | 'connected' | 'unavailable' | 'stopped' = 'starting';
  readonly enrollment?: RelayEnrollmentIssuer;
  constructor(private store: JobStore, private tasks: TaskService, private gatewayOrigin: string, private config: z.infer<typeof relayConfigSchema>, private sourceAgentId?: string) {
    if (!store.security.enabled || !store.authority || store.authority.canonicalOrigin !== gatewayOrigin) throw new Error('Task Relay requires the canonical primary authority');
    if (config.enrollmentKeyFile) this.enrollment = new RelayEnrollmentIssuer(config.enrollmentKeyFile, gatewayOrigin, config.relayUrl, store.security);
  }
  get status() { return this.state; }
  metadata() {
    if (!this.client) throw new SecurityError('AUTHORITY_UNAVAILABLE');
    return taskRelayMetadataSchema.parse({ protocol: TASK_RELAY_PROTOCOL, authorityId: this.store.authority!.id,
      gatewayOrigin: this.gatewayOrigin, relayUrl: this.config.relayUrl, gatewayAgentId: this.client.agentId, bindingPath: '/relay/bind', ...(this.enrollment ? { enrollmentPath: '/relay/enrollment' } : {}) });
  }
  start(): Promise<void> {
    return this.opening ??= this.open();
  }
  private async open() {
    this.client = await RelayClient.open({ baseUrl: this.config.relayUrl, credentialPath: this.config.credentialPath, statePath: this.config.statePath, displayName: this.config.displayName });
    this.host = new TaskRelayHost(this.store, this.tasks, this.client, this.store.authority!.id);
    this.running = this.run();
    this.dispatching = this.dispatch();
  }
  private async run() {
    while (!this.abort.signal.aborted) {
      try {
        await this.client!.peer(this.client!.agentId);
        if (this.sourceAgentId) {
          const contact = await this.client!.ensureContact(this.sourceAgentId);
          if (contact.state === 'pending' && contact.recipient === this.client!.agentId) await this.client!.respondContact(contact.id, 'accept');
        }
        this.state = 'connected';
        await this.client!.listen(async message => {
          const result = sourceReadResponseSchema.safeParse(message.content);
          if (!result.success) return this.host!.handle(message, this.abort.signal);
          try { this.store.security.relayReads.accept(message.senderId, message.connectionId, result.data); }
          catch (error) { if (!(error instanceof SecurityError)) throw error; }
        }, this.abort.signal);
      } catch {
        if (this.abort.signal.aborted) break;
        this.state = 'unavailable';
        await delay(1000, undefined, { signal: this.abort.signal }).catch(() => {});
      }
    }
    this.state = 'stopped';
  }
  private async dispatch() {
    while (!this.abort.signal.aborted) {
      for (const { peerId, request } of this.store.security.relayReads.pending()) {
        if (this.abort.signal.aborted) break;
        try {
          const contact = (await this.client!.contacts()).find(c => c.state === 'accepted' && [c.requester, c.recipient].includes(peerId));
          if (!contact) continue;
          this.store.security.relayReads.route(request.callId, contact.id);
          const id = await this.client!.queue(peerId, contact.id, request, { id: request.callId, expiresAt: request.expiresAt });
          await this.client!.deliver(id, { signal: this.abort.signal, beforeSend: () => { this.store.security.relayReads.authorize(request.callId, peerId); } });
          this.store.security.relayReads.dispatched(request.callId, contact.id);
        } catch (error) {
          if (error instanceof SecurityError) this.store.security.relayReads.revoke(request.callId);
        }
      }
      await delay(100, undefined, { signal: this.abort.signal }).catch(() => {});
    }
  }
  async bind(principal: Principal, token: string, input: unknown, proof: string) {
    if (!this.client || this.state !== 'connected') throw new SecurityError('AUTHORITY_UNAVAILABLE');
    const body = z.strictObject({ signedCard: z.string().max(4096) }).parse(input);
    const card = await verifyCard(body.signedCard), peer = await this.client.peer(card.card.agentId);
    if (peer.signedCard !== card.signedCard) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const now = this.store.security.now();
    const checkedProof = await verifyProof(proof, token, 'POST', this.gatewayOrigin + '/relay/bind', card.card.agentId, now);
    const tokenExpiry = z.number().int().positive().parse(decodeJwt(token).exp) * 1000;
    const actor = this.store.security.agentContext(principal), parent = this.store.security.agentGrant(actor.installationId);
    const expiresAt = Math.min(tokenExpiry, now + 900000, Date.parse(parent.expiresAt));
    const binding = this.store.security.relay.bind(principal, card.card.agentId, expiresAt, checkedProof);
    // Contact acceptance only follows this installation's authenticated key binding.
    let contact = await this.client.ensureContact(card.card.agentId);
    this.store.security.relay.principal(card.card.agentId);
    if (contact.state === 'pending' && contact.recipient === this.client.agentId) contact = await this.client.respondContact(contact.id, 'accept');
    this.store.security.relay.principal(card.card.agentId);
    return { ...binding, ...this.metadata(), connectionId: contact.id };
  }
  async enroll(principal: Principal, token: string, input: unknown, proof: string) {
    if (!this.enrollment) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const { signedCard } = z.strictObject({ signedCard: z.string().max(4096) }).parse(input);
    const card = await verifyCard(signedCard);
    const checked = await verifyProof(proof, token, 'POST', this.gatewayOrigin + '/relay/enrollment', card.card.agentId, this.store.security.now());
    const result = await this.enrollment.issue(principal, token, card.card.agentId);
    this.store.security.relay.consumeProof(checked);
    return result;
  }
  async enrollPrimary(principal: Principal, token: string, renewRequestId?: string) {
    if (!this.client || !this.enrollment || this.store.security.agentContext(principal).installationId !== this.config.operatorInstallationId) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const assertion = await this.enrollment.issue(principal, token, this.client.agentId);
    return renewRequestId ? this.client.renew(assertion.accessToken, z.uuid().parse(renewRequestId)) : this.client.register(assertion.accessToken);
  }
  async close() {
    this.abort.abort();
    await this.opening?.catch(() => {});
    await this.running;
    await this.dispatching;
    this.client?.close();
    this.state = 'stopped';
  }
}

export function mountTaskRelay(app: Express, relay: TaskRelayGateway, store: JobStore, authenticate: RequestHandler, principal: (req: Request) => Principal) {
  const reject = (res: import('express').Response, error: unknown) => {
    if (error instanceof SecurityError) res.status(error.reason === 'AUTHORITY_UNAVAILABLE' ? 503 : 403).json({ error: error.reason });
    else if (error instanceof RelayError) res.status(error.status).json({ error: 'relay_binding_rejected' });
    else res.status(400).json({ error: 'invalid_relay_binding' });
  };
  app.get('/.well-known/eigos-task-relay', (_req, res) => { try { res.json(relay.metadata()); } catch (error) { reject(res, error); } });
  app.get('/.well-known/eigos-relay-jwks.json', (_req, res) => {
    if (!relay.enrollment) { res.sendStatus(404); return; }
    res.json(relay.enrollment.jwks());
  });
  app.post('/relay/enrollment', authenticate, async (req, res) => {
    try {
      const proof = z.string().min(1).max(4096).parse(req.headers.dpop);
      res.json(await relay.enroll(principal(req), req.headers.authorization!.slice('Bearer '.length), req.body, proof));
    } catch (error) { reject(res, error); }
  });
  app.post('/relay/enroll-primary', authenticate, async (req, res) => {
    try {
      const { renewRequestId } = z.strictObject({ renewRequestId: z.uuid().optional() }).parse(req.body);
      res.json(await relay.enrollPrimary(principal(req), req.headers.authorization!.slice('Bearer '.length), renewRequestId));
    } catch (error) { reject(res, error); }
  });
  app.post('/relay/bind', authenticate, async (req, res) => {
    try {
      const token = req.headers.authorization!.slice('Bearer '.length), proof = z.string().min(1).max(4096).parse(req.headers.dpop);
      res.json(await relay.bind(principal(req), token, req.body, proof));
    } catch (error) { reject(res, error); }
  });
  app.post('/relay/revoke', authenticate, (req, res) => {
    try {
      const { agentId } = z.strictObject({ agentId: agentIdSchema }).parse(req.body);
      store.security.relay.revoke(principal(req), agentId);
      res.json({ revoked: true });
    } catch (error) { reject(res, error); }
  });
  app.post('/relay/source-reads/:id/authorize', async (req, res) => {
    try {
      const id = z.uuid().parse(req.params.id), proof = z.string().min(1).max(4096).parse(req.headers.dpop);
      z.strictObject({}).parse(req.body);
      const peer = store.security.relayReads.peer(id), url = store.authority!.canonicalOrigin + `/relay/source-reads/${id}/authorize`;
      const checked = await verifyProof(proof, id, 'POST', url, peer, store.security.now());
      const request = store.security.relayReads.authorize(id, peer);
      store.security.relay.consumeProof(checked);
      res.json({ authorized: true, authorityId: request.authorityId, callId: id, requestDigest: digest(request), expiresAt: request.expiresAt });
    } catch (error) { reject(res, error); }
  });
}
