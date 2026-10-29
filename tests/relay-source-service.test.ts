// Synthetic provider and authorization responses isolate source process crash/replay behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../packages/core/delegation.js';
import { DidiRelayService, type DidiServiceConfig, type SourceAuthorizationEvent } from '../packages/agent-transport/didi-service.js';
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

test('provider rate limits retain their bounded error code instead of encouraging another immediate read', async () => {
  const f = await fixture();
  f.source.flags.transform = () => new Response('rate limited', { status: 429 });
  const service = new DidiRelayService(f.node(), f.config, new DidiMcpConnector(f.source.binding, f.source.fetcher), f.authorize);
  try {
    await service.handle(f.message, AbortSignal.timeout(10000));
    const response = sourceReadResponseSchema.parse((await f.gateway.poll())[0]!.content);
    assert.equal(response.error, 'RATE_LIMITED'); assert.equal(response.result, undefined);
    assert.equal(f.source.calls.filter(c => c.name).length, 0);
  } finally { service.close(); await f.close(); }
});

for (const failure of ['network', 'timeout', 'http'] as const) for (const failedCheck of [3, 4]) test(`${failure} at authorization check ${failedCheck} preserves the original provider receipt for a source restart`, async () => {
  const f = await fixture(); let checks = 0; const events: SourceAuthorizationEvent[] = [];
  const authorize: typeof fetch = async (...args) => {
    if (++checks === failedCheck) {
      if (failure === 'http') return new Response('synthetic-private-upstream-body', { status: 503 });
      if (failure === 'timeout') throw new DOMException('synthetic-private-timeout', 'TimeoutError');
      throw new TypeError('synthetic-private-network-failure');
    }
    return f.authorize(...args);
  };
  let service = new DidiRelayService(f.node(), f.config, new DidiMcpConnector(f.source.binding, f.source.fetcher), authorize, event => events.push(event));
  try {
    await assert.rejects(service.handle(f.message, AbortSignal.timeout(10000)), /authorization.*unavailable/i);
    assert.equal((await f.gateway.poll()).length, 0, 'An unavailable permission check cannot deliver a result or claim permission was denied');
    assert.equal(f.source.calls.filter(c => c.name).length, 1);
    const saved = JSON.parse(readFileSync(join(f.source.binding.auditDirectory!, 'reads.jsonl'), 'utf8').trim()).receipt;
    const unavailable = events.find(event => event.outcome === 'unavailable'); assert(unavailable);
    assert.equal(unavailable.callId, f.request.callId); assert.equal(unavailable.reason, failure);
    assert.equal(unavailable.stage, failedCheck === 3 ? 'result' : 'delivery');
    assert.equal(unavailable.status, failure === 'http' ? 503 : undefined); assert(unavailable.elapsedMs >= 0);
    assert(!JSON.stringify(events).includes('synthetic-private'));
    service.close(); service = new DidiRelayService(await f.reopen(), f.config, new DidiMcpConnector(f.source.binding, f.source.fetcher), f.authorize);
    await service.handle((await f.node().pending())[0]!, AbortSignal.timeout(10000));
    const response = sourceReadResponseSchema.parse((await f.gateway.poll())[0]!.content);
    assert(response.result); assert.equal(response.error, undefined);
    assert.equal(response.callId, f.request.callId); assert.equal(response.requestDigest, digest(f.request));
    assert.deepEqual(response.result.receipt, saved);
    assert.equal(f.source.calls.filter(c => c.name).length, 1, 'Recover the saved receipt without another provider read');
  } finally { service.close(); await f.close(); }
});

test('a source receipt retained after an unavailable authorization is withheld when the task is revoked before retry', async () => {
  const f = await fixture(); let checks = 0;
  const authorize: typeof fetch = async (...args) => ++checks === 3 ? new Response(null, { status: 503 }) : f.authorize(...args);
  let service = new DidiRelayService(f.node(), f.config, new DidiMcpConnector(f.source.binding, f.source.fetcher), authorize);
  try {
    await assert.rejects(service.handle(f.message, AbortSignal.timeout(10000)), /authorization.*unavailable/i);
    f.revoke(); service.close();
    const events: SourceAuthorizationEvent[] = [];
    service = new DidiRelayService(await f.reopen(), f.config, new DidiMcpConnector(f.source.binding, f.source.fetcher), f.authorize, event => events.push(event));
    await service.handle((await f.node().pending())[0]!, AbortSignal.timeout(10000));
    const response = sourceReadResponseSchema.parse((await f.gateway.poll())[0]!.content);
    assert.equal(response.error, 'AUTHORIZATION_REJECTED'); assert.equal(response.result, undefined);
    assert.equal(f.source.calls.filter(c => c.name).length, 1);
    assert.equal(events.at(-1)?.outcome, 'denied'); assert.equal(events.at(-1)?.status, 403);
  } finally { service.close(); await f.close(); }
});

test('an invalid authorization response never releases a saved provider receipt', async () => {
  const f = await fixture(); let checks = 0; const events: SourceAuthorizationEvent[] = [];
  const authorize: typeof fetch = async (...args) => ++checks === 3 ? new Response('synthetic-private-invalid-json') : f.authorize(...args);
  const service = new DidiRelayService(f.node(), f.config, new DidiMcpConnector(f.source.binding, f.source.fetcher), authorize, event => events.push(event));
  try {
    await service.handle(f.message, AbortSignal.timeout(10000));
    const response = sourceReadResponseSchema.parse((await f.gateway.poll())[0]!.content);
    assert.equal(response.error, 'AUTHORIZATION_REJECTED'); assert.equal(response.result, undefined);
    assert.equal(f.source.calls.filter(c => c.name).length, 1);
    assert.equal(events.at(-1)?.outcome, 'denied'); assert.equal(events.at(-1)?.reason, 'invalid_response');
    assert(!JSON.stringify(events).includes('synthetic-private'));
  } finally { service.close(); await f.close(); }
});

test('authorization unavailable before a source read leaves the original message retryable without a provider call', async () => {
  const f = await fixture();
  let service = new DidiRelayService(f.node(), f.config, new DidiMcpConnector(f.source.binding, f.source.fetcher), async () => new Response(null, { status: 503 }));
  try {
    await assert.rejects(service.handle(f.message, AbortSignal.timeout(10000)), /authorization.*unavailable/i);
    assert.equal(f.source.calls.filter(c => c.name).length, 0); assert.equal((await f.gateway.poll()).length, 0);
    service.close(); service = new DidiRelayService(await f.reopen(), f.config, new DidiMcpConnector(f.source.binding, f.source.fetcher), f.authorize);
    await service.handle((await f.node().pending())[0]!, AbortSignal.timeout(10000));
    const response = sourceReadResponseSchema.parse((await f.gateway.poll())[0]!.content);
    assert(response.result); assert.equal(response.callId, f.request.callId); assert.equal(response.requestDigest, digest(f.request));
    assert.equal(f.source.calls.filter(c => c.name).length, 1);
  } finally { service.close(); await f.close(); }
});

test('a saved source receipt cannot outlive its original message deadline', async t => {
  const f = await fixture(); let checks = 0;
  const authorize: typeof fetch = async (...args) => ++checks === 3 ? new Response(null, { status: 503 }) : f.authorize(...args);
  const service = new DidiRelayService(f.node(), f.config, new DidiMcpConnector(f.source.binding, f.source.fetcher), authorize);
  try {
    await assert.rejects(service.handle(f.message, AbortSignal.timeout(10000)), /authorization.*unavailable/i);
    t.mock.method(Date, 'now', () => f.request.expiresAt + 1);
    assert.equal((await f.node().pending()).length, 0);
    await service.handle(f.message, AbortSignal.timeout(10000));
    assert.equal(checks, 3); assert.equal(f.source.calls.filter(c => c.name).length, 1);
    assert.equal(f.node().outbox().length, 0);
  } finally { t.mock.restoreAll(); service.close(); await f.close(); }
});

test('source reads retain request, actual dispatch, result and delivery authorization without duplicate preparation checks',async()=>{
  const f=await fixture(),events:SourceAuthorizationEvent[]=[];
  const service=new DidiRelayService(f.node(),f.config,new DidiMcpConnector(f.source.binding,f.source.fetcher),f.authorize,event=>events.push(event));
  try{
    await service.handle(f.message,AbortSignal.timeout(10000));
    assert.deepEqual(events.map(event=>event.stage),['request','provider_dispatch','result','delivery']);
    assert(events.every(event=>event.outcome==='authorized'));
    assert.equal(f.source.calls.filter(call=>call.name).length,1);
    assert(sourceReadResponseSchema.parse((await f.gateway.poll())[0]!.content).result);
  }finally{service.close();await f.close();}
});

test('revocation during connection preparation still blocks the actual provider call',async()=>{
  const f=await fixture(),events:SourceAuthorizationEvent[]=[];
  const fetcher:typeof fetch=async(target,init)=>{
    const response=await f.source.fetcher(target,init);
    if(init?.method==='POST'&&JSON.parse(String(init.body)).method==='tools/list')f.revoke();
    return response;
  };
  const service=new DidiRelayService(f.node(),f.config,new DidiMcpConnector(f.source.binding,fetcher),f.authorize,event=>events.push(event));
  try{
    await service.handle(f.message,AbortSignal.timeout(10000));
    assert.equal(f.source.calls.filter(call=>call.name).length,0);
    assert(events.some(event=>event.stage==='provider_dispatch'&&event.outcome==='denied'));
    const response=sourceReadResponseSchema.parse((await f.gateway.poll())[0]!.content);
    assert.equal(response.result,undefined);assert.equal(response.error,'AUTHORIZATION_REJECTED');
  }finally{service.close();await f.close();}
});
