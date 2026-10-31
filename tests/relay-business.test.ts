// Complete transport/authority loop with synthetic model choices, membership and provider HTTP responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { z } from 'zod';
import { digest } from '../packages/core/delegation.js';
import { DefinitionService } from '../packages/ontology/definition-service.js';
import { parsePipelineIntake } from '../packages/ontology/pipeline/contracts.js';
import { TaskRelayGateway, mountTaskRelay } from '../apps/gateway/relay.js';
import { DidiRelayService } from '../packages/agent-transport/didi-service.js';
import { RelayClient } from '../packages/agent-transport/client.js';
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
  const placesOnly = (ctx.state.input as { mode?: string }).mode === 'places';
  const completed = observations.find(o => o.data.kind === (placesOnly ? 'places' : 'estimate'));
  let steps: AgentStep[];
  if (!observations.length) steps = placesOnly ? [step('search', 'SearchDidiPlaces', { scope: ctx.state.scope, role: 'search', keywords: rideInput.origin })]
    : [step('origin', 'SearchDidiPlaces', { scope: ctx.state.scope, role: 'origin', keywords: rideInput.origin }), step('destination', 'SearchDidiPlaces', { scope: ctx.state.scope, role: 'destination', keywords: rideInput.destination })];
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
    completionJson: completed ? JSON.stringify({ observation: completed.ref, rationale: placesOnly ? 'The requested place has a current synthetic search result' : 'The requested route has a current synthetic estimate' }) : '' };
};

async function fixture(options: { managed?: boolean; placesOnly?: boolean; signal: AbortSignal }) {
  const stop = new AbortController();
  const abort = () => stop.abort(options.signal.reason);
  options.signal.addEventListener('abort', abort, { once: true });
  options.signal.throwIfAborted();
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  const transport = await relayFixture(), source = didiFixture(), base = securityFixture(now, { unified: true });
  const serviceNode = await transport.client('DiDi'), initialGateway = await transport.client('EIGOS'), pa = await transport.client('PA');
  const gatewayId = initialGateway.agentId, serviceConnection = await transport.connect(initialGateway, serviceNode), paConnection = await transport.connect(pa, initialGateway);
  initialGateway.close();
  const input = options.placesOnly ? { mode: 'places', city: rideInput.city, keywords: rideInput.origin } : rideInput;
  const f = securedProgramFixture(() => new DidiAgentProgram(source.binding, { connector: new DidiRelayConnector(base.jobs, serviceNode.agentId, source.binding) }), input, choice, base, { nativeTaskContext: options.managed, leaseMs: options.managed ? 120000 : 30000, signal: stop.signal, renewLease: true });
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
  const failures: unknown[] = [], reads: string[] = [];
  const listening = serviceNode.listen(async message => {
    const request = sourceReadRequestSchema.safeParse(message.content); if (request.success) reads.push(request.data.callId);
    await service.handle(message, stop.signal);
  }, stop.signal, {concurrency:2}).catch(error => { if (!stop.signal.aborted) failures.push(error); });
  await gateway.start();
  async function receive(requestId: string) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      for (const message of await pa.poll({ signal: stop.signal })) {
        const response = taskRelayResponseSchema.safeParse(message.content);
        if (response.success && response.data.requestId === requestId) { pa.markHandled(message.senderId, message.id); return response.data; }
      }
      await delay(20, undefined, { signal: stop.signal });
    }
    throw new Error('Synthetic task response deadline elapsed');
  }
  return { ...f, transport, source, gateway, pa, gatewayId, paConnection, serviceConnection, serviceNode, service, reads, failures, receive, now, placesOnly: options.placesOnly ?? false,
    elapse(milliseconds: number) { clockOffset += milliseconds; },
    beforeAuthorization(fn: () => void) { beforeAuthorization = fn; },
    async close() {
      options.signal.removeEventListener('abort', abort);
      stop.abort(); await listening; await gateway.close(); service.close(); await f.tasks.close();
      server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
      await transport.close(); source.close(); f.close();
    },
  };
}

test('PA → encrypted primary → source Agent → scoped readback → PA preserves the real task and source receipt identities', { timeout: 60000 }, async t => {
  const f = await fixture({ signal: t.signal });
  const readResult=f.jobs.security.relayReads.result.bind(f.jobs.security.relayReads);let resultReads=0;
  t.mock.method(f.jobs.security.relayReads,'result',(id:string)=>{resultReads++;return readResult(id);});
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
    assert.equal(resultReads,3,'Completed payloads are decoded once; pending polls retain account, scope, Worker and Pipeline checks');
    const model = f.modelInputs.join('\n');
    for (const privateValue of [syntheticKey, f.source.keyFile, 'claimToken', 'PRIVATE_TRACE_NEVER_TO_MODEL']) assert(!model.includes(privateValue));
    assert.equal(f.failures.length, 0);
  } finally { await f.close(); }
});

test('independent queued source reads are both dispatched before either delivery completes',{timeout:60000},async t=>{
  const f=await fixture({signal:t.signal});let releasePair!:()=>void,paired=false;
  const pair=new Promise<void>(resolve=>{releasePair=resolve;}),firstPair=new Set<string>(),started=new Set<string>();
  try{
  const pending=f.jobs.security.relayReads.pending.bind(f.jobs.security.relayReads),deliver=RelayClient.prototype.deliver;
  t.mock.method(f.jobs.security.relayReads,'pending',()=>{
    const rows=pending();
    if(!paired){if(rows.length<2)return [];paired=true;for(const row of rows.slice(0,2))firstPair.add(row.request.callId);}
    return rows;
  });
  t.mock.method(RelayClient.prototype,'deliver',async function(this:RelayClient,id:string,options?:Parameters<typeof deliver>[1]){
    if(this.agentId===f.gatewayId&&firstPair.has(id)){
      started.add(id);if(started.size===2)releasePair();await pair;
    }
    return deliver.call(this,id,options);
  });
    const requestId=randomUUID();
    await f.pa.send(f.gatewayId,f.paConnection,{protocol:TASK_RELAY_PROTOCOL,kind:'task.submit',authorityId:f.authority!.id,requestId,
      input:{service:'eigos.delegate',requestId,goal:'查询北京西站到西二旗地铁站的预估车费，不叫车、不付款'}});
    const submitted=await f.receive(requestId);assert(submitted.task,submitted.error);
    const completed=await f.advance(submitted.task.id);
    assert.equal(started.size,2);assert.equal(completed.state,'completed');assert.equal(completed.delegation!.acceptance!.accepted,true);
    assert.deepEqual(f.source.calls.filter(call=>call.name).map(call=>call.name),['maps_textsearch','maps_textsearch','taxi_estimate']);
    assert.equal(f.failures.length,0);
  }finally{releasePair();await f.close();}
});

function manageDidi(f: Awaited<ReturnType<typeof fixture>>) {
  const intake = parsePipelineIntake({ format: 'eigos.ontology.pipeline.v1', serviceId: 'didi.relay.fixture',
    source: { id: 'didi.relay.fixture', revision: '1', digest: digest('synthetic-didi-relay-contract'), observedAt: new Date(f.now() - 60000).toISOString(), reference: 'urn:eigos:synthetic:didi-relay' },
    programRef: f.program.ref, configurationDigest: f.program.configurationDigest, environment: 'live',
    vocabulary: [{ term: '合成估价', aliases: [], objectType: 'RideEstimateTask' }],
    // Production-shaped responses are injected by the fixture; this is never live business evidence.
    actions: f.program.actionIds.map(actionId => ({ actionId, definitionDigest: digest(f.jobs.ontology.model.action(actionId)), requiredEvidence: 'live_readonly' })),
    mappings: [], fixtures: [], conditions: { regions: ['CN'], payment: 'not_required', operatorRequired: false },
  });
  const namespace = f.jobs.definitions.namespace('eigos.business');
  let draft = f.jobs.definitions.createDraft(f.owner, namespace.id, 'Synthetic Relay pipeline validation', true);
  draft = f.jobs.definitions.putPipeline(f.owner, draft.id, draft.revision, intake, true);
  f.jobs.definitions.validatePipeline(f.owner, draft.id, draft.revision, intake.serviceId, new Date(f.now() + 3600000).toISOString(), true);
  const release = f.jobs.definitions.publish(f.owner, draft.id, draft.revision, true).release;
  f.jobs.definitions.activate(f.owner, release, namespace.generation, true);
  const definitions = new DefinitionService(f.jobs, f.tasks, f.catalog);
  const validation = () => f.tasks.preparePipelineValidation(f.p, { ontologyId: namespace.id, release, serviceId: intake.serviceId, requestId: randomUUID(),
    goal: f.placesOnly ? 'Read the synthetic public place information without ordering or payment' : 'Read the synthetic route estimate without ordering or payment', expiresAt: new Date(f.now() + 300000).toISOString() });
  const status = (action = 'SearchDidiPlaces') => f.jobs.ontology.pipelineStatus(f.owner, f.program.ref, f.program.configurationDigest, action);
  const verify = (taskId: string, lifetimeMs = 300000) => {
    const review = f.jobs.definitions.createDraft(f.owner, namespace.id, 'Review synthetic source receipt', true);
    const expiresAt = new Date(f.now() + lifetimeMs).toISOString();
    return { ...z.object({ id: z.string() }).parse(definitions.command(f.p, { operation: 'verify_pipeline_task', ontologyId: namespace.id, draftId: review.id,
      expectedRevision: review.revision, serviceId: intake.serviceId, taskId, expiresAt }).result), expiresAt };
  };
  return { intake, definitions, validation, status, verify };
}

test('Pipeline validation traverses encrypted source dispatch without enabling the service until independent evidence is registered', { timeout: 180000 }, async t => {
  const f = await fixture({ managed: true, signal: t.signal });
  try {
    const pipeline = manageDidi(f); assert.equal(pipeline.status().status, 'verification_required');
    const task = pipeline.validation(), completed = await f.advance(task.id);
    assert.equal(completed.state, 'completed', JSON.stringify(completed.delegation?.agent?.feedback));
    assert.equal(pipeline.status().status, 'verification_required');
    pipeline.verify(task.id); assert.equal(pipeline.status().status, 'verified');
    assert.equal(pipeline.status('EstimateDidiRide').status, 'verified');
    assert.equal(f.source.calls.filter(c => c.name).length, 3);
  } finally { await f.close(); }
});

// The full estimate path above verifies both source actions. Each boundary
// injection below needs one queued read and must not enable the untested action.
for (const invalidation of ['revoked', 'expired'] as const) test(`Pipeline evidence ${invalidation} after Relay dispatch prevents the provider call`, { timeout: 180000 }, async t => {
  const f = await fixture({ managed: true, placesOnly: true, signal: t.signal });
  try {
    const pipeline = manageDidi(f), task = pipeline.validation();
    assert.equal((await f.advance(task.id)).state, 'completed');
    // Keep the short expiry within the 60-second proof window while allowing
    // the full native planning turn to finish on a slower CI runner.
    const verification = pipeline.verify(task.id, invalidation === 'expired' ? 55000 : 300000), originalReads = f.source.calls.filter(c => c.name).length;
    assert.equal(pipeline.status('EstimateDidiRide').status, 'verification_required');
    const ordinary = f.tasks.submit(f.p, { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Read the synthetic public place again; no order or payment' });
    await f.tick(); let invalidated = false, sourceRequestCurrent = false, workerLeaseCurrent = false, pipelineDenial: unknown;
    f.beforeAuthorization(() => {
      const queued = f.jobs.security.relayReads.authorize(f.reads.at(-1)!, f.serviceNode.agentId);
      invalidated = true;
      if (invalidation === 'expired') {
        assert(f.now() < Date.parse(verification.expiresAt), 'Verification must remain current until its queued source request');
        f.coordinator.refresh();
        f.elapse(Date.parse(verification.expiresAt) - f.now() + 1);
      }
      else pipeline.definitions.command(f.p, { operation: 'revoke_pipeline_verification', ontologyId: 'eigos.business', serviceId: pipeline.intake.serviceId, verificationId: verification.id });
      sourceRequestCurrent = queued.expiresAt > f.now(); workerLeaseCurrent = f.jobs.hasActiveClaim(ordinary.id);
      try { f.jobs.security.relayReads.authorize(queued.callId, f.serviceNode.agentId); }
      catch (error) { pipelineDenial = error instanceof Error && 'reason' in error ? error.reason : error; }
    });
    await f.tick();
    assert(invalidated, 'Invalidation must happen at the remote source authorization boundary');
    assert.equal(pipeline.status().status, invalidation);
    assert(sourceRequestCurrent, 'The source request itself must remain unexpired');
    assert(workerLeaseCurrent, 'The Worker lease must remain active; only Pipeline evidence changes');
    assert.equal(pipelineDenial, 'SOURCE_NOT_AUTHORIZED', 'The exact primary authorization guard must reject Pipeline evidence before another fence can revoke the queued read');
    assert(f.jobs.security.taskGrant(f.jobs.security.agentContext(f.p), ordinary.id), 'The task grant remains active; the Pipeline gate must deny this read');
    assert.equal(f.source.calls.filter(c => c.name).length, originalReads, 'No provider call may cross expired or revoked Pipeline evidence');
  } finally { await f.close(); }
});

test('Pipeline revocation during a provider response prevents late source facts from reaching the task', { timeout: 180000 }, async t => {
  const f = await fixture({ managed: true, placesOnly: true, signal: t.signal });
  try {
    const pipeline = manageDidi(f), validation = pipeline.validation();
    assert.equal((await f.advance(validation.id)).state, 'completed');
    const verification = pipeline.verify(validation.id), originalReads = f.source.calls.filter(c => c.name).length;
    assert.equal(pipeline.status('EstimateDidiRide').status, 'verification_required');
    const task = f.tasks.submit(f.p, { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Read the synthetic public place again without ordering' });
    await f.tick(); let invalidated = false;
    f.source.flags.before = async () => {
      if (invalidated) return;
      invalidated = true;
      pipeline.definitions.command(f.p, { operation: 'revoke_pipeline_verification', ontologyId: 'eigos.business', serviceId: pipeline.intake.serviceId, verificationId: verification.id });
    };
    await f.tick();
    assert(invalidated); assert.equal(f.source.calls.filter(c => c.name).length, originalReads + 1);
    const current = f.jobs.get(f.owner, task.id);
    assert.equal(current.delegation?.agent?.observations.length, 0);
    assert.equal(f.jobs.intents(f.owner, task.id).filter(intent => intent.acceptedOutput).length, 0);
    assert.notEqual(current.state, 'completed');
  } finally { await f.close(); }
});

test('source revocation between encrypted dispatch and provider authorization prevents the actual read', { timeout: 30000 }, async t => {
  const f = await fixture({ signal: t.signal });
  try {
    const task = f.tasks.submit(f.p, { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Read a synthetic route estimate only' });
    await f.tick();
    f.beforeAuthorization(() => f.policy.revokeSource(f.owner, f.a.id, f.catalog.securityProfiles(f.owner)[0]!.bindingId, f.policy.revision()));
    await f.tick();
    assert.equal(f.source.calls.filter(c => c.name).length, 0);
    assert.notEqual(f.jobs.get(f.owner, task.id).state, 'completed');
  } finally { await f.close(); }
});

test('cancelling a Relay fixture stops its active Worker and source read before cleanup', { timeout: 30000 }, async t => {
  const cancelled = new AbortController();
  const f = await fixture({ signal: AbortSignal.any([t.signal, cancelled.signal]) });
  try {
    f.tasks.submit(f.p, { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Read a synthetic route estimate only' });
    await f.tick();
    f.beforeAuthorization(() => cancelled.abort());
    await assert.rejects(f.tick(), { name: 'AbortError' });
    assert.equal(cancelled.signal.aborted, true);
    assert.equal(f.source.calls.filter(c => c.name).length, 0);
    await assert.rejects(f.tick(), { name: 'AbortError' });
  } finally { await f.close(); }
});

test('an expired Worker claim rejects its old source message and the original task resumes with a fresh attempt', { timeout: 60000 }, async t => {
  const f = await fixture({ signal: t.signal });
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
