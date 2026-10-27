import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { RelayStore } from '../../packages/relay/store.js';
import { agentIdSchema, fail, hashSchema, MAX_CONTENT_BYTES, MAX_ENVELOPE_BYTES, MAX_MESSAGE_MS, ownerKey, RELAY_PROTOCOL, RelayError, uuidSchema } from '../../packages/relay/contracts.js';
import { verifyCard, verifyEnvelope, verifyProof } from '../../packages/agent-transport/crypto.js';
import { createOwnerVerifier, type RelayConfig, type VerifyOwner } from './config.js';

export function createRelayApp(config: RelayConfig, options: { verifyOwner?: VerifyOwner; store?: RelayStore } = {}) {
  const store = options.store ?? new RelayStore(config.databasePath), verifyOwner = options.verifyOwner ?? createOwnerVerifier(config);
  const app = express(), waits = new Map<string, number>(), ingress = new Map<string, { bucket: number; count: number }>();
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
  app.use(express.json({ limit: '128kb', strict: true }));
  const pathId = (value: unknown) => agentIdSchema.parse(value);
  const bearer = (req: Request) => /^Bearer ([A-Za-z0-9._~-]+)$/.exec(req.headers.authorization ?? '')?.[1] ?? fail('OWNER_AUTHENTICATION_REQUIRED', 401);
  const owner = async (req: Request) => {
    try { const identity = await verifyOwner(bearer(req)); store.rate('owner:' + ownerKey(identity), 30); return identity; }
    catch (error) { if (error instanceof RelayError) throw error; return fail('OWNER_AUTHENTICATION_REQUIRED', 401); }
  };
  const proof = async (req: Request, agentId: string, token: string) => {
    const value = typeof req.headers.dpop === 'string' ? req.headers.dpop : fail('INVALID_DPOP_PROOF', 401);
    const checked = await verifyProof(value, token, req.method, config.publicUrl + req.path, agentId, store.now());
    store.consumeProof(agentId, checked.jti, checked.expiresAt);
  };
  const node = async (req: Request) => {
    const id = pathId(req.headers['x-eigos-agent-id']), token = /^DPoP ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1] ?? fail('NODE_AUTHENTICATION_REQUIRED', 401);
    store.authenticate(id, token); await proof(req, id, token); store.rate('node:' + id);
    // A node can be revoked while asynchronous signature verification is in progress.
    store.assertActive(id); return id;
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
    res.json(store.register(who, card, input.credentialHash, input.requestId));
  }));
  app.get('/v1/owned-agents', route(async (req, res) => { res.json({ agents: store.owned(await owner(req)) }); }));
  app.post('/v1/agents/:agentId/renew', route(async (req, res) => {
    const who = await owner(req), id = pathId(req.params.agentId), input = z.strictObject({ requestId: uuidSchema }).parse(req.body);
    await proof(req, id, bearer(req)); res.json(store.renew(who, id, input.requestId));
  }));
  app.post('/v1/agents/:agentId/revoke', route(async (req, res) => {
    const who = await owner(req); z.strictObject({}).parse(req.body); res.json(store.revoke(who, pathId(req.params.agentId)));
  }));
  app.get('/v1/agents/:agentId', route(async (req, res) => { await node(req); res.json(store.publicAgent(pathId(req.params.agentId))); }));
  app.get('/v1/contacts', route(async (req, res) => { res.json({ connections: store.contacts(await node(req)) }); }));
  app.post('/v1/contacts', route(async (req, res) => {
    const actor = await node(req), input = z.strictObject({ peerId: agentIdSchema, requestId: uuidSchema }).parse(req.body);
    res.json(store.requestContact(actor, input.peerId, input.requestId));
  }));
  app.post('/v1/contacts/:id', route(async (req, res) => {
    const actor = await node(req), input = z.strictObject({ action: z.enum(['accept', 'reject', 'revoke']) }).parse(req.body);
    res.json(store.respondContact(actor, uuidSchema.parse(req.params.id), input.action));
  }));
  app.post('/v1/messages', route(async (req, res) => {
    const actor = await node(req), input = z.strictObject({ signedEnvelope: z.string().max(MAX_ENVELOPE_BYTES) }).parse(req.body);
    const envelope = await verifyEnvelope(input.signedEnvelope, store.identity(actor));
    res.json(store.send(actor, envelope, input.signedEnvelope));
  }));
  app.get('/v1/inbox', route(async (req, res) => {
    const actor = await node(req), query = z.strictObject({ wait: z.coerce.number().int().min(0).max(25).default(0), limit: z.coerce.number().int().min(1).max(20).default(20) }).parse(req.query);
    if ((waits.get(actor) ?? 0) >= 2 || [...waits.values()].reduce((a, b) => a + b, 0) >= 100) fail('POLL_LIMIT', 429);
    waits.set(actor, (waits.get(actor) ?? 0) + 1);
    const end = Date.now() + query.wait * 1000;
    try {
      while (!closed && !res.destroyed) {
        const items = store.inbox(actor, query.limit);
        if (items.length || Date.now() >= end) { res.json({ items }); return; }
        await sleep(Math.min(250, Math.max(1, end - Date.now())));
      }
      if (!res.destroyed) res.status(503).json({ error: 'RELAY_UNAVAILABLE' });
    } finally { const remaining = (waits.get(actor) ?? 1) - 1; if (remaining) waits.set(actor, remaining); else waits.delete(actor); }
  }));
  app.post('/v1/messages/:sender/:id/ack', route(async (req, res) => {
    const actor = await node(req), input = z.strictObject({ digest: hashSchema }).parse(req.body);
    res.json(store.acknowledge(actor, pathId(req.params.sender), uuidSchema.parse(req.params.id), input.digest));
  }));
  app.get('/v1/messages/:sender/:id', route(async (req, res) => { res.json(store.messageReceipt(await node(req), pathId(req.params.sender), uuidSchema.parse(req.params.id))); }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof RelayError) { if (error.status === 401) res.setHeader('WWW-Authenticate', error.code === 'OWNER_AUTHENTICATION_REQUIRED' ? 'Bearer realm="eigos-relay-enrollment"' : 'DPoP realm="eigos-relay"'); if (error.status === 429) res.setHeader('Retry-After', '60'); res.status(error.status).json({ error: error.code }); }
    else if (error instanceof z.ZodError || error instanceof SyntaxError) res.status(400).json({ error: 'INVALID_INPUT' });
    else if (error?.type === 'entity.too.large') res.status(413).json({ error: 'ENVELOPE_TOO_LARGE' });
    else res.status(500).json({ error: 'RELAY_FAILURE' });
  };
  app.use(errors);
  return { app, store, stop: () => { closed = true; }, close: () => { closed = true; if (!options.store && !storageClosed) { storageClosed = true; store.close(); } } };
}
