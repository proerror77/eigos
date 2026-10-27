// Complete transport/authority loop with synthetic model choices, membership and provider HTTP responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { TaskRelayGateway, mountTaskRelay } from '../apps/gateway/relay.js';
import { DidiRelayService } from '../packages/agent-transport/didi-service.js';
import { DidiMcpConnector } from '../packages/capabilities/didi/connector.js';
import { DidiAgentProgram } from '../packages/capabilities/didi/program.js';
import { DidiRelayConnector } from '../packages/capabilities/didi/relay-connector.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { DIDI_PROGRAM_REF } from '../packages/capabilities/didi/program.js';
import { ORDER_TEST_REF } from '../packages/ontology/didi-order-test.js';
import { TASK_RELAY_PROTOCOL, taskRelayResponseSchema } from '../packages/agent-transport/task-contracts.js';
import { sourceReadRequestSchema } from '../packages/agent-transport/service-contracts.js';
import type { DidiData } from '../packages/capabilities/didi/contracts.js';
import type { AgentDecision, AgentStep } from '../packages/ontology/agent-actions.js';
import type { AgentPlanningContext, PlanningAccess } from '../packages/coordinator/coordinator.js';
import { relayFixture } from './fixtures/relay.js';
import { securityFixture } from './fixtures/security.js';
import { securedProgramFixture } from './fixtures/secured-program.js';
import { didiFixture, input as rideInput, syntheticKey } from './fixtures/didi.js';
import { createNodeKeys } from '../packages/agent-transport/crypto.js';

test('enabling the read-only Relay route preserves separately configured Mock capabilities', async () => {
  const f = securityFixture(Date.now, { unified: true }), source = didiFixture();
  try {
    const peer = (await createNodeKeys('Synthetic source')).identity.card.agentId;
    const catalog = createExecutionCatalog({ store: f.jobs, personalSourceOwner: f.owner, didi: source.binding, didiRelayAgentId: peer, didiOrderTestEnabled: true });
    const profiles = catalog.securityProfiles(f.owner).map(p => p.programId);
    assert(profiles.includes(DIDI_PROGRAM_REF.id)); assert(profiles.includes(ORDER_TEST_REF.id));
    assert.equal(source.calls.length, 0);
  } finally { source.close(); f.close(); }
});

const choice = (ctx: AgentPlanningContext, access: PlanningAccess): AgentDecision => {
  access.session.call('describe_ontology', { search: 'RideEstimate', limit: 5 });
  access.session.call('query_ontology', { object: ctx.state.scope });
  const observations = ctx.state.observations.map(ref => {
    const result = access.session.call('query_ontology', { object: ref }) as { items: { properties: { observedData: { data: DidiData } } }[] };
    access.session.call('evaluate_ontology', { function: 'rideEstimateStatus', object: ref });
    return { ref, data: result.items[0]!.properties.observedData.data };
  });
  const step = (id: string, action: string, args: object): AgentStep => ({ id, action, argumentsJson: JSON.stringify(args), dependsOn: [], inputRefs: [] });
  const completed = observations.find(o => o.data.kind === 'estimate');
  let steps: AgentStep[];
  if (!observations.length) steps = [step('origin', 'SearchDidiPlaces', { scope: ctx.state.scope, role: 'origin', keywords: rideInput.origin }), step('destination', 'SearchDidiPlaces', { scope: ctx.state.scope, role: 'destination', keywords: rideInput.destination })];
  else if (completed) steps = [];
  else {
    const endpoint = (name: string) => {
      const result = observations.find(o => o.data.kind === 'places' && o.data.places.some(p => p.name === name))!;
      assert(result.data.kind === 'places'); return { ref: result.ref, place: result.data.places.find(p => p.name === name)! };
    };
    const origin = endpoint(rideInput.origin), destination = endpoint(rideInput.destination);
    steps = [step('estimate', 'EstimateDidiRide', { scope: ctx.state.scope, originObservation: origin.ref, originPlaceId: origin.place.id, destinationObservation: destination.ref, destinationPlaceId: destination.place.id })];
  }
  return { kind: completed ? 'complete' : 'execute', requestRevision: ctx.request.revision, message: 'Synthetic choices from independently evaluated source facts', steps,
    completionJson: completed ? JSON.stringify({ observation: completed.ref, rationale: 'The requested route has a current synthetic estimate' }) : '' };
};

async function fixture() {
  const transport = await relayFixture(), source = didiFixture(), base = securityFixture(Date.now, { unified: true });
  const serviceNode = await transport.client('DiDi'), initialGateway = await transport.client('EIGOS'), pa = await transport.client('PA');
  const gatewayId = initialGateway.agentId, serviceConnection = await transport.connect(initialGateway, serviceNode), paConnection = await transport.connect(pa, initialGateway);
  initialGateway.close();
  const f = securedProgramFixture(() => new DidiAgentProgram(source.binding, { connector: new DidiRelayConnector(base.jobs, serviceNode.agentId, source.binding) }), rideInput, choice, base);
  f.jobs.security.relay.bind(f.p, pa.agentId, Date.now() + 600000, { jti: randomUUID(), expiresAt: Date.now() + 60000 });
  const gateway = new TaskRelayGateway(f.jobs, f.tasks, base.authority!.canonicalOrigin, { version: 1, relayUrl: transport.baseUrl, credentialPath: join(transport.directory, 'EIGOS.json'), displayName: 'EIGOS' });
  const app = express(); app.use(express.json());
  mountTaskRelay(app, gateway, f.jobs, (_req, _res, next) => next(), () => f.p);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let beforeAuthorization: (() => void) | undefined;
  const service = new DidiRelayService(serviceNode, { version: 1, authorityId: base.authority!.id, gatewayAgentId: gatewayId, gatewayOrigin: base.authority!.canonicalOrigin, relayUrl: transport.baseUrl,
    credentialPath: join(transport.directory, 'DiDi.json'), ledgerPath: join(transport.directory, 'source-receipts.sqlite'), displayName: 'DiDi fixture', binding: { ...source.binding, environment: 'production' } },
    new DidiMcpConnector(source.binding, source.fetcher), async (url, init) => {
      assert.equal(new URL(String(url)).origin, base.authority!.canonicalOrigin);
      if (beforeAuthorization) { const run = beforeAuthorization; beforeAuthorization = undefined; run(); }
      return fetch(local + new URL(String(url)).pathname, init);
    });
  const stop = new AbortController(), failures: unknown[] = [], reads: string[] = [];
  const listening = serviceNode.listen(async message => {
    const request = sourceReadRequestSchema.safeParse(message.content); if (request.success) reads.push(request.data.callId);
    await service.handle(message, stop.signal);
  }, stop.signal).catch(error => { if (!stop.signal.aborted) failures.push(error); });
  await gateway.start();
  async function receive(requestId: string) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      for (const message of await pa.poll()) {
        const response = taskRelayResponseSchema.safeParse(message.content);
        if (response.success && response.data.requestId === requestId) { pa.markHandled(message.senderId, message.id); return response.data; }
      }
      await delay(20);
    }
    throw new Error('Synthetic task response deadline elapsed');
  }
  return { ...f, transport, source, gateway, pa, gatewayId, paConnection, serviceConnection, serviceNode, service, reads, failures, receive,
    beforeAuthorization(fn: () => void) { beforeAuthorization = fn; },
    async close() {
      stop.abort(); await listening; await gateway.close(); service.close(); await f.tasks.close();
      server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
      await transport.close(); source.close(); f.close();
    },
  };
}

test('PA → encrypted primary → source Agent → scoped readback → PA preserves the real task and source receipt identities', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const requestId = randomUUID();
    await f.pa.send(f.gatewayId, f.paConnection, { protocol: TASK_RELAY_PROTOCOL, kind: 'task.submit', authorityId: f.authority!.id, requestId,
      input: { service: 'eigos.delegate', requestId, goal: '查询北京西站到西二旗地铁站的预估车费，不叫车、不付款' } });
    const submitted = await f.receive(requestId); assert(submitted.task, submitted.error);
    const raw = await f.advance(submitted.task.id);
    assert.equal(raw.state, 'completed', JSON.stringify({ state: raw.state, feedback: raw.delegation?.agent?.feedback, failures: f.failures }));
    const readId = randomUUID();
    await f.pa.send(f.gatewayId, f.paConnection, { protocol: TASK_RELAY_PROTOCOL, kind: 'task.get', authorityId: f.authority!.id, requestId: readId, taskId: raw.id });
    const response = await f.receive(readId); assert(response.task, response.error);
    assert.equal(response.task.id, submitted.task.id); assert.equal(response.task.authorityId, f.authority!.id);
    assert.equal(response.task.accepted, true); assert(JSON.stringify(response.task).includes('73.05'));
    assert.deepEqual(f.source.calls.filter(c => c.name).map(c => c.name), ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    assert.equal(new Set(f.reads).size, 3);
    const model = f.modelInputs.join('\n');
    for (const privateValue of [syntheticKey, f.source.keyFile, 'claimToken', 'PRIVATE_TRACE_NEVER_TO_MODEL']) assert(!model.includes(privateValue));
    assert.equal(f.failures.length, 0);
  } finally { await f.close(); }
});

test('source revocation between encrypted dispatch and provider authorization prevents the actual read', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const task = f.tasks.submit(f.p, { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Read a synthetic route estimate only' });
    await f.tick();
    f.beforeAuthorization(() => f.policy.revokeSource(f.owner, f.a.id, f.catalog.securityProfiles(f.owner)[0]!.bindingId, f.policy.revision()));
    await f.tick();
    assert.equal(f.source.calls.filter(c => c.name).length, 0);
    assert.notEqual(f.jobs.get(f.owner, task.id).state, 'completed');
  } finally { await f.close(); }
});

test('an expired Worker claim rejects its old source message and the original task resumes with a fresh attempt', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const task = f.tasks.submit(f.p, { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Read a synthetic route estimate only' });
    await f.tick();
    f.beforeAuthorization(() => {
      // Simulate an interrupted Worker whose lease expires while its encrypted request is in flight.
      const db = new DatabaseSync(f.database);
      try { db.prepare('UPDATE work_claims SET expires_at=0 WHERE job_id=?').run(task.id); } finally { db.close(); }
    });
    await f.tick();
    assert.equal(f.source.calls.filter(c => c.name).length, 0);
    const completed = await f.advance(task.id);
    assert.equal(completed.state, 'completed', JSON.stringify({ state: completed.state, feedback: completed.delegation?.agent?.feedback }));
    assert.equal(completed.id, task.id);
    assert.equal(f.jobs.security.listGrants(f.owner).filter(g => g.kind === 'task_data').length, 1);
    assert.deepEqual(f.source.calls.filter(c => c.name).map(c => c.name), ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
  } finally { await f.close(); }
});
