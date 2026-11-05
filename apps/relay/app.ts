import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { RelayStore } from '../../packages/relay/store.js';
import type { PostgresRelayStore } from '../../packages/relay/postgres-store.js';
import { agentIdSchema, fail, hashSchema, MAX_CONTENT_BYTES, MAX_ENVELOPE_BYTES, MAX_MESSAGE_MS, ownerKey, RELAY_PROTOCOL, RelayError, uuidSchema } from '../../packages/relay/contracts.js';
import { verifyCard, verifyEnvelope, verifyProof } from '../../packages/agent-transport/crypto.js';
import { createOwnerVerifier, type RelayConfig, type VerifyOwner } from './config.js';
import { MemoryRelayNotifications, type RelayNotifications } from '../../packages/relay/notifications.js';

export function createRelayApp(config: RelayConfig, options: { verifyOwner?: VerifyOwner; store?: RelayStore | PostgresRelayStore; trustedIngressAddress?: string; notifications?: RelayNotifications } = {}) {
  const store = options.store ?? new RelayStore(config.databasePath), verifyOwner = options.verifyOwner ?? createOwnerVerifier(config);
  const app = express(), waits = new Map<string, number>(), ingress = new Map<string, { bucket: number; count: number }>();
  const notifications = options.notifications ?? new MemoryRelayNotifications(), pending = new Set<AbortController>();
  const changed = async <T>(operation: T | Promise<T>): Promise<T> => {
    const result = await operation;
    // The PG commit/SQLite transaction is authoritative. A missed hint is
    // recovered by the next final read, without reporting a committed send as failed.
    await notifications.notify().catch(() => {}); return result;
  };
  let closed = false, storageClosed = false;
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustLoopbackProxy ? 'loopback' : false);
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const address = req.ip ?? req.socket.remoteAddress ?? 'unknown', bucket = Math.floor(store.now() / 60000);
    for (const [key, value] of ingress) if (value.bucket !== bucket) ingress.delete(key);
    if (ingress.size >= 2048 && !ingress.has(address)) { res.status(429).json({ error: 'RATE_LIMITED' }); return; }
    const entry = ingress.get(address) ?? { bucket, count: 0 }; entry.count++; ingress.set(address, entry);
    if (entry.count > 600) { res.status(429).json({ error: 'RATE_LIMITED' }); return; }
    if (closed) { res.status(503).json({ error: 'RELAY_UNAVAILABLE' }); return; }
    if (req.headers.origin && req.headers.origin !== config.publicUrl) { res.status(403).json({ error: 'ORIGIN_NOT_ALLOWED' }); return; }
    next();
  });
  // This value is supplied only by the Cloudflare adapter from its trusted
  // request metadata; arbitrary forwarded headers are never trusted here.
  if (options.trustedIngressAddress && 'rateIngress' in store) app.use((req, res, next) => {
    void store.rateIngress(options.trustedIngressAddress!).then(() => next(), next);
  });
  app.use(express.json({ limit: '128kb', strict: true }));
  const pathId = (value: unknown) => agentIdSchema.parse(value);
  const bearer = (req: Request) => /^Bearer ([A-Za-z0-9._~-]+)$/.exec(req.headers.authorization ?? '')?.[1] ?? fail('OWNER_AUTHENTICATION_REQUIRED', 401);
  const owner = async (req: Request) => {
    try { const identity = await verifyOwner(bearer(req)); await store.rate('owner:' + ownerKey(identity), 30); return identity; }
    catch (error) { if (error instanceof RelayError) throw error; return fail('OWNER_AUTHENTICATION_REQUIRED', 401); }
  };
  const proof = async (req: Request, agentId: string, token: string) => {
    const value = typeof req.headers.dpop === 'string' ? req.headers.dpop : fail('INVALID_DPOP_PROOF', 401);
    const checked = await verifyProof(value, token, req.method, config.publicUrl + req.path, agentId, store.now());
    await store.consumeProof(agentId, checked.jti, checked.expiresAt);
  };
  const node = async (req: Request) => {
    const id = pathId(req.headers['x-eigos-agent-id']), token = /^DPoP ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1] ?? fail('NODE_AUTHENTICATION_REQUIRED', 401);
    await store.authenticate(id, token); await proof(req, id, token); await store.rate('node:' + id);
    // A node can be revoked while asynchronous signature verification is in progress.
    await store.assertActive(id); return id;
  };
  const route = (fn: (req: Request, res: Response) => Promise<void> | void) => (req: Request, res: Response, next: (error?: unknown) => void) => { Promise.resolve().then(() => fn(req, res)).catch(next); };

  app.get('/health', (_req, res) => res.json({ status: closed ? 'unavailable' : 'ok', protocol: RELAY_PROTOCOL, role: 'encrypted-relay' }));
  app.get('/.well-known/eigos-relay', (_req, res) => res.json({ protocol: RELAY_PROTOCOL, origin: config.publicUrl,
    enrollment: { path: '/v1/agents', scope: 'relay:enroll', authentication: config.authMode, ...(config.issuer ? { issuer: config.issuer, audience: config.audience } : {}) },
    limits: { contentBytes: MAX_CONTENT_BYTES, envelopeBytes: MAX_ENVELOPE_BYTES, maxMessageMs: MAX_MESSAGE_MS, maxPollSeconds: 25 },
    cryptography: { signature: 'EdDSA/Ed25519', encryption: 'ECDH-ES/X25519+A256GCM', forwardSecrecy: false, groups: false },
    semantics: { contactApproval: 'communication_only', receipt: 'received_by_connector_not_business_completion', federation: false } }));
  app.post('/v1/agents', route(async (req, res) => {
    const who = await owner(req), input = z.strictObject({ signedCard: z.string().max(4096), credentialHash: hashSchema, requestId: uuidSchema }).parse(req.body);
    const card = await verifyCard(input.signedCard); await proof(req, card.card.agentId, bearer(req));
    res.json(await changed(store.register(who, card, input.credentialHash, input.requestId)));
  }));
  app.get('/v1/owned-agents', route(async (req, res) => { res.json({ agents: await store.owned(await owner(req)) }); }));
  app.post('/v1/agents/:agentId/renew', route(async (req, res) => {
    const who = await owner(req), id = pathId(req.params.agentId), input = z.strictObject({ requestId: uuidSchema }).parse(req.body);
    await proof(req, id, bearer(req)); res.json(await changed(store.renew(who, id, input.requestId)));
  }));
  app.post('/v1/agents/:agentId/revoke', route(async (req, res) => {
    const who = await owner(req); z.strictObject({}).parse(req.body); res.json(await changed(store.revoke(who, pathId(req.params.agentId))));
  }));
  app.get('/v1/agents/:agentId', route(async (req, res) => { await node(req); res.json(await store.publicAgent(pathId(req.params.agentId))); }));
  app.get('/v1/contacts', route(async (req, res) => { res.json({ connections: await store.contacts(await node(req)) }); }));
  app.post('/v1/contacts', route(async (req, res) => {
    const actor = await node(req), input = z.strictObject({ peerId: agentIdSchema, requestId: uuidSchema }).parse(req.body);
    res.json(await changed(store.requestContact(actor, input.peerId, input.requestId)));
  }));
  app.post('/v1/contacts/:id', route(async (req, res) => {
    const actor = await node(req), input = z.strictObject({ action: z.enum(['accept', 'reject', 'revoke']) }).parse(req.body);
    res.json(await changed(store.respondContact(actor, uuidSchema.parse(req.params.id), input.action)));
  }));
  app.post('/v1/messages', route(async (req, res) => {
    const actor = await node(req), input = z.strictObject({ signedEnvelope: z.string().max(MAX_ENVELOPE_BYTES) }).parse(req.body);
    const envelope = await verifyEnvelope(input.signedEnvelope, await store.identity(actor));
    res.json(await changed(store.send(actor, envelope, input.signedEnvelope)));
  }));
  app.get('/v1/inbox', route(async (req, res) => {
    // Take the notification revision before the first authoritative read. A
    // commit between that read and wait registration changes the revision.
    let revision: string | undefined;
    const parsed = z.strictObject({ wait: z.coerce.number().int().min(0).max(25).default(0), limit: z.coerce.number().int().min(1).max(20).default(20) }).safeParse(req.query);
    const query = parsed.success ? parsed.data : { wait: 0, limit: 20 };
    let actor: string, lease: string | undefined, items: Awaited<ReturnType<typeof store.inbox>> | undefined;
    if ('beginIdlePoll' in store) {
      actor = pathId(req.headers['x-eigos-agent-id']);
      const token = /^DPoP ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1] ?? fail('NODE_AUTHENTICATION_REQUIRED', 401);
      await store.authenticate(actor, token);
      const value = typeof req.headers.dpop === 'string' ? req.headers.dpop : fail('INVALID_DPOP_PROOF', 401);
      const checked = await verifyProof(value, token, req.method, config.publicUrl + req.path, actor, store.now());
      revision = await notifications.snapshot().catch(() => undefined);
      // No database transaction or connection survives this call.
      const first = await store.beginIdlePoll(actor, checked, query.limit, !parsed.success);
      if (!parsed.success) fail('INVALID_INPUT');
      lease = first.lease;
      items = first.items;
    } else {
      actor = await node(req);
      if (!parsed.success) throw parsed.error;
      revision = await notifications.snapshot().catch(() => undefined);
      if ((waits.get(actor) ?? 0) >= 2 || [...waits.values()].reduce((a, b) => a + b, 0) >= 100) fail('POLL_LIMIT', 429);
      waits.set(actor, (waits.get(actor) ?? 0) + 1);
    }
    const cancel = new AbortController(), end = Date.now() + query.wait * 1000;
    const disconnect = () => cancel.abort();
    pending.add(cancel); res.once('close', disconnect);
    let finishing = false;
    try {
      items ??= await store.inbox(actor, query.limit);
      if (!items.length && query.wait && !closed && !res.destroyed) {
        if (revision !== undefined) {
          try { await notifications.wait(revision, Math.max(0, end - Date.now()), cancel.signal); }
          catch { if (!cancel.signal.aborted) await sleep(Math.max(0, end - Date.now()), undefined, { signal: cancel.signal }).catch(() => {}); }
        } else await sleep(Math.max(0, end - Date.now()), undefined, { signal: cancel.signal }).catch(() => {});
      }
      if (lease && 'finishIdlePoll' in store) {
        finishing = true; items = await store.finishIdlePoll(actor, lease, query.limit);
      } else items = await store.inbox(actor, query.limit);
      if (!res.destroyed) {
        if (closed) res.status(503).json({ error: 'RELAY_UNAVAILABLE' });
        else res.json({ items });
      }
    } finally {
      pending.delete(cancel); res.removeListener('close', disconnect); cancel.abort();
      // If the final call's outcome is unknown, its PG lease expires. Never
      // retry the same final operation after an uncertain database commit.
      if (lease && !finishing && 'releasePoll' in store) await store.releasePoll(lease);
      if (!lease) { const remaining = (waits.get(actor) ?? 1) - 1; if (remaining) waits.set(actor, remaining); else waits.delete(actor); }
    }
  }));
  app.post('/v1/messages/:sender/:id/ack', route(async (req, res) => {
    const actor = await node(req), input = z.strictObject({ digest: hashSchema }).parse(req.body);
    res.json(await store.acknowledge(actor, pathId(req.params.sender), uuidSchema.parse(req.params.id), input.digest));
  }));
  app.get('/v1/messages/:sender/:id', route(async (req, res) => { res.json(await store.messageReceipt(await node(req), pathId(req.params.sender), uuidSchema.parse(req.params.id))); }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof RelayError) { if (error.status === 401) res.setHeader('WWW-Authenticate', error.code === 'OWNER_AUTHENTICATION_REQUIRED' ? 'Bearer realm="eigos-relay-enrollment"' : 'DPoP realm="eigos-relay"'); if (error.status === 429) res.setHeader('Retry-After', '60'); res.status(error.status).json({ error: error.code }); }
    else if (error instanceof z.ZodError || error instanceof SyntaxError) res.status(400).json({ error: 'INVALID_INPUT' });
    else if (error?.type === 'entity.too.large') res.status(413).json({ error: 'ENVELOPE_TOO_LARGE' });
    else res.status(500).json({ error: 'RELAY_FAILURE' });
  };
  app.use(errors);
  return { app, store, stop: () => { closed = true; for (const cancel of pending) cancel.abort(); }, close: () => { closed = true; for (const cancel of pending) cancel.abort(); if (!options.store && !storageClosed) { storageClosed = true; store.close(); } } };
}
