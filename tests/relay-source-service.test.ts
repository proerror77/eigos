// Synthetic provider and authorization responses isolate source process crash/replay behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { digest } from '../packages/core/delegation.js';
import { DidiRelayService, type DidiServiceConfig } from '../packages/agent-transport/didi-service.js';
import { sourceReadRequestSchema, sourceReadResponseSchema, SOURCE_RELAY_PROTOCOL } from '../packages/agent-transport/service-contracts.js';
import { DidiMcpConnector, type DidiConnector } from '../packages/capabilities/didi/connector.js';
import { relayFixture } from './fixtures/relay.js';
import { didiFixture } from './fixtures/didi.js';

async function fixture(loseResponse = false) {
  const transport = await relayFixture(), source = didiFixture(), gateway = await transport.client('EIGOS');
  let lose = loseResponse, node = await transport.client('DiDi', async (url, init) => {
    const response = await fetch(url, init);
    if (lose && String(url).endsWith('/v1/messages') && init?.method === 'POST') { lose = false; throw new Error('Synthetic lost response'); }
    return response;
  });
  const connectionId = await transport.connect(gateway, node), authorityId = randomUUID();
  const request = sourceReadRequestSchema.parse({ protocol: SOURCE_RELAY_PROTOCOL, kind: 'source.read', callId: randomUUID(), authorityId, gatewayOrigin: 'https://primary.example', expiresAt: Date.now() + 60000,
    context: { requestId: randomUUID(), requestRevision: 1, planId: randomUUID(), intentId: randomUUID(), attemptId: randomUUID(), modelRunId: randomUUID(), programId: 'didi.ride.estimate', programDigest: 'a'.repeat(64), action: 'SearchDidiPlaces', actionInputDigest: 'b'.repeat(64) },
    source: { bindingId: source.binding.bindingId, keySha256: source.binding.keySha256, environment: 'production' }, tool: 'maps_textsearch', input: { city: '北京市', keywords: '北京西站' } });
  const config: DidiServiceConfig = { version: 1, authorityId, gatewayAgentId: gateway.agentId, gatewayOrigin: 'https://primary.example', relayUrl: transport.baseUrl,
    credentialPath: join(transport.directory, 'DiDi.json'), ledgerPath: join(transport.directory, 'source.sqlite'), displayName: 'DiDi synthetic', binding: { ...source.binding, environment: 'production' } };
  let authorized = true;
  const authorize: typeof fetch = async () => new Response(JSON.stringify(authorized ? { authorized: true, authorityId, callId: request.callId, requestDigest: digest(request), expiresAt: request.expiresAt } : { error: 'ACCESS_REVOKED' }), { status: authorized ? 200 : 403, headers: { 'content-type': 'application/json' } });
  await gateway.send(node.agentId, connectionId, request, { expiresAt: request.expiresAt });
  const message = (await node.poll())[0]!;
  return { transport, source, gateway, connectionId, request, config, message, authorize, node: () => node,
    revoke() { authorized = false; },
    async reopen() { node.close(); node = await transport.client('DiDi'); return node; },
    async close() { await transport.close(); source.close(); },
  };
}

test('source restart returns the same durable provider receipt without repeating a completed read', async () => {
  const f = await fixture(true); let service = new DidiRelayService(f.node(), f.config, new DidiMcpConnector(f.source.binding, f.source.fetcher), f.authorize);
  try {
    await assert.rejects(service.handle(f.message, AbortSignal.timeout(10000)), /lost response/);
    const first = sourceReadResponseSchema.parse((await f.gateway.poll())[0]!.content); assert(first.result);
    service.close(); service = new DidiRelayService(await f.reopen(), f.config, new DidiMcpConnector(f.source.binding, f.source.fetcher), f.authorize);
    await service.handle((await f.node().pending())[0]!, AbortSignal.timeout(10000));
    const responses = (await f.gateway.poll()).map(m => sourceReadResponseSchema.parse(m.content));
    assert(responses.every(response => response.result?.receipt.id === first.result!.receipt.id));
    assert.equal(f.source.calls.filter(c => c.name).length, 1);
  } finally { service.close(); await f.close(); }
});

test('source interruption during a read reports an unknown outcome without replaying that call ID', async () => {
  const f = await fixture(), stop = new AbortController(); let calls = 0;
  const connector: DidiConnector = { evidenceKind: 'live_readonly', invoke: async () => { calls++; stop.abort(); stop.signal.throwIfAborted(); throw new Error('unreachable'); } };
  let service = new DidiRelayService(f.node(), f.config, connector, f.authorize);
  try {
    await assert.rejects(service.handle(f.message, stop.signal));
    service.close(); service = new DidiRelayService(await f.reopen(), f.config, connector, f.authorize);
    await service.handle((await f.node().pending())[0]!, AbortSignal.timeout(10000));
    const response = sourceReadResponseSchema.parse((await f.gateway.poll())[0]!.content);
    assert.equal(response.error, 'READ_OUTCOME_UNKNOWN'); assert.equal(response.result, undefined); assert.equal(calls, 1);
  } finally { service.close(); await f.close(); }
});

test('revocation after provider response withholds source facts from the return envelope', async () => {
  const f = await fixture(), underlying = new DidiMcpConnector(f.source.binding, f.source.fetcher);
  const connector: DidiConnector = { evidenceKind: 'live_readonly', invoke: async (...args) => { const result = await underlying.invoke(...args); f.revoke(); return result; } };
  const service = new DidiRelayService(f.node(), f.config, connector, f.authorize);
  try {
    await service.handle(f.message, AbortSignal.timeout(10000));
    const response = sourceReadResponseSchema.parse((await f.gateway.poll())[0]!.content);
    assert.equal(response.error, 'AUTHORIZATION_REJECTED'); assert.equal(response.result, undefined);
    assert.equal(f.source.calls.filter(c => c.name).length, 1);
  } finally { service.close(); await f.close(); }
});
