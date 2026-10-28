import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { addLocationContext, locationContextSchema, locationAliases, locationMatchesSource, prepareLocationContext, requestLocations } from '../packages/core/location-context.js';
import { readOntologyRequest } from '../packages/ontology/execution-projection.js';
import { DidiAgentProgram, routeLocationFacts } from '../packages/capabilities/didi/program.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { readConfig } from '../packages/core/config.js';
import { createApp } from '../apps/gateway/app.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { Worker } from '../apps/worker/worker.js';
import { backend, owner, principal, observeTaskContext, acknowledgeReads, evidence } from './backend-fixture.js';
import { didiFixture, didiModel, chooseDidi, input, sourcePlace } from './fixtures/didi.js';
import { componentContext } from '../packages/core/composed-actions.js';
import { digest } from '../packages/core/delegation.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import type { ActionDiscoveryPage } from '../packages/core/action-bindings.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';
import type { Job } from '../packages/core/domain.js';

const context = { city: '北京市', origin: { name: input.origin, address: sourcePlace(input.origin, 2).address_all, label: '家', source: 'saved_address' as const },
  destination: { name: input.destination, address: sourcePlace(input.destination, 2).address_all, label: '拳馆', source: 'user_provided' as const } };
const goal = '从家到拳馆，只查滴滴估价，不下单、不付款。';
const requirements = [{ id: 'origin', kind: 'location', role: 'origin', strength: 'hard', expected: { ref: '家' } },
  { id: 'destination', kind: 'location', role: 'destination', strength: 'hard', expected: { ref: '拳馆' } },
  { id: 'noorder', kind: 'condition', strength: 'hard', expected: { predicate: 'execution.no_order' } }];

test('PA address context is a current, owner-scoped Ontology fact before any model or provider call', () => {
  const f = didiFixture(), store = new JobStore(':memory:'), b = backend(createExecutionCatalog({ store, didi: { ...f.binding, connector: f.connector } }), didiModel(), store);
  try {
    const job = b.submit({ goal, locationContext: context });
    assert.equal(job.goal, goal); assert.equal(job.delegation!.request.originalGoal, goal);
    const request = readOntologyRequest(store.ontology, owner, job.id);
    assert.deepEqual(requestLocations(request), context);
    const facts = store.ontology.query(owner, { type: 'RequestFact', where: [{ property: 'namespace', op: 'eq', value: 'location' }] }).items;
    assert.equal(facts.length, 3);
    for (const fact of facts) {
      const source = store.ontology.related(owner, fact.ref, 'sourceInstruction', { remaining: 100 });
      assert.equal(source?.length, 1); assert(String(source![0]!.properties.text).includes(String(fact.properties.quote)));
    }
    assert.equal(f.calls.length, 0); assert.equal(job.runs!.length, 0);
    assert.throws(() => new DidiAgentProgram(f.binding).initialize(store.ontology, owner, request, { mode: 'estimate', city: '天津市', origin: '家', destination: '拳馆' }), /already provided task city/);
    const cityAddress = context.city + context.origin.address;
    const prepared = new DidiAgentProgram(f.binding).initialize(store.ontology, owner, request, { mode: 'estimate', origin: cityAddress, destination: '拳馆' }).input;
    assert(prepared.mode === 'estimate'); assert.equal(prepared.origin, cityAddress);
    assert.throws(() => b.tasks.get({ ...principal, subject: 'other' }, job.id));
    const amended = b.tasks.amend(principal, { taskId: job.id, expectedRevision: job.revision!, requestId: randomUUID(), answer: '只展示快车和专车。' });
    assert.deepEqual(requestLocations(readOntologyRequest(store.ontology, owner, amended.id)), context, 'An unrelated continuation does not discard addresses or ask for them again');
    const changed = b.tasks.amend(principal, { taskId: job.id, expectedRevision: amended.revision!, requestId: randomUUID(), answer: '起点改为公司，终点不变。',
      locationContext: { city: '北京市', origin: { name: '合成办公楼', label: '公司', source: 'user_provided' } } });
    const current = readOntologyRequest(store.ontology, owner, changed.id);
    assert.equal(requestLocations(current).origin!.name, '合成办公楼'); assert.deepEqual(requestLocations(current).destination, context.destination);
    assert.equal(current.confirmedInputs!.location!.fields.destination!.source.messageId, request.confirmedInputs!.location!.fields.destination!.source.messageId);
  } finally { store.close(); f.close(); }
});

test('the whole-goal Ontology planner consumes the address facts and verifies the original aliases in one task revision', async () => {
  const f = didiFixture({ booking: true }), store = new JobStore(':memory:'), catalog = createExecutionCatalog({ store, didi: { ...f.binding, connector: f.connector } });
  const program = catalog.agentProgram({ id: 'ride.estimate.query', version: '1' }, owner)!;
  const model: Reasoner = {
    ground: async (request, _caps, _signal, access) => {
      const read = observeTaskContext(access)!; assert.deepEqual(requestLocations(read), context);
      const decision = { kind: 'compose' as const, requestRevision: request.revision, message: 'The supplied address facts identify the original user route', requirementsJson: '[]', conditionsJson: '[]',
        criteriaJson: JSON.stringify([{ id: 'estimate', predicate: 'ride.estimate_observed', phase: 'quote', description: 'Source estimate for the original route only',
          messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: request.requirements.map(requirement => requirement.id) }]) };
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
    plan: async () => { throw new Error('The route must stay in the whole-goal Ontology flow'); },
    act: async (ctx, _signal, access) => {
      observeTaskContext(access);
      const pin = (actionId: string) => (access.session.call('discover_actions', { actionId, programRef: program.ref }) as ActionDiscoveryPage).items[0]!.bindings[0]!.pin;
      let decision: AgentDecision;
      if (!ctx.state.composition!.contexts.length) decision = { kind: 'prepare', requestRevision: ctx.request.revision, message: 'Bind the already known city and addresses', steps: [], completionJson: '',
        contexts: [{ id: 'ride', bindingDigest: pin('SearchDidiPlaces').digest, inputJson: JSON.stringify({ mode: 'estimate', city: context.city, origin: '家', destination: '拳馆' }) }] };
      else {
        const scoped = componentContext({ ...ctx, graph: store.ontologyForJob(owner, ctx.request.id), owner, intents: store.intents(owner, ctx.request.id), modelRuns: store.get(owner, ctx.request.id).runs }, ctx.state.composition!.contexts[0]!, program);
        const selected = chooseDidi({ ...ctx, ...scoped, capability: program.capability(), actionIds: [...program.actionIds] }, access);
        decision = selected.kind === 'complete' ? { ...selected, completionJson: JSON.stringify({ components: [{ contextId: 'ride', proposalJson: selected.completionJson }], criteria: [{ id: 'estimate', contextIds: ['ride'] }], conditions: [] }) }
          : { ...selected, steps: selected.steps.map(step => ({ ...step, bindingDigest: pin(step.action).digest, contextId: 'ride', contributesTo: ['estimate'] })) };
      }
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
  };
  const b = backend(catalog, model, store);
  try {
    const job = b.submit({ goal, locationContext: context, requirements, executionEnvironment: 'sandbox' }); let done = job;
    for (let i = 0; i < 12 && ['submitted', 'working'].includes(done.state); i++) done = await b.run();
    assert.equal(done.state, 'completed', JSON.stringify({ error: done.error, grounding: done.delegation?.groundingFeedback, feedback: done.delegation?.agent?.feedback, assessment: { criteria: done.delegation?.agent?.composition?.assessment?.criteria, requirements: done.delegation?.agent?.composition?.assessment?.requirements } }));
    assert.equal(done.delegation!.agent!.programRef.id, 'eigos.goal'); assert.equal(done.delegation!.agent!.composition!.assessment!.accepted, true);
    assert(done.delegation!.agent!.plans.every(plan => plan.version === '3' && plan.steps.every(step => step.binding?.programRef.id === program.ref.id)));
    assert.equal(done.delegation!.request.revision, 1); assert.equal(done.messages.filter(message => message.role === 'user').length, 1);
  } finally { store.close(); f.close(); }
});

test('only explicit task location instructions update the family; clearing cannot revive the old address', () => {
  const now = new Date().toISOString(), request: ServiceRequest = { id: randomUUID(), revision: 1, originalGoal: goal, requirements: [], messages: [{ id: 'goal', text: goal, receivedAt: now }] };
  addLocationContext(request, context, 'submitted', now);
  assert.equal(requestLocations(request).origin!.label, '家');
  assert(locationAliases(context.origin, context.city).includes('我家'));
  assert(!locationAliases(context.origin, context.city).includes('当前位置'), 'Home must not become the device location');
  addLocationContext(request, { city: '北京市', origin: null }, 'corrected', now);
  request.messages.push({ id: 'ordinary', text: '还是按原来的要求继续。', receivedAt: now }); prepareLocationContext(request);
  assert.equal(requestLocations(request).origin, undefined); assert.deepEqual(requestLocations(request).destination, context.destination);
  assert(request.confirmedInputs!.location!.history.some(fact => fact.field === 'origin' && fact.status === 'confirmed'));
  assert(!locationContextSchema.safeParse({ ...context, owner: 'another-owner' }).success);
  assert(!locationContextSchema.safeParse({ city: '北京市', origin: { name: '现在的位置', source: 'current_location' } }).success);
});

test('known address aliases enter the ordinary ontology action loop and pass source-backed route requirements without another user statement', async () => {
  const f = didiFixture(), store = new JobStore(':memory:'), b = backend(createExecutionCatalog({ store, didi: { ...f.binding, connector: f.connector } }),
    didiModel(undefined, { mode: 'estimate', origin: '家', destination: '拳馆' }), store);
  f.flags.ambiguous = true;
  try {
    const job = b.submit({ goal, locationContext: context, requirements });
    let done = job;
    for (let i = 0; i < 10 && ['submitted', 'working'].includes(done.state); i++) done = await b.run();
    assert.equal(done.state, 'completed', JSON.stringify({ question: done.question, error: done.error, feedback: done.delegation?.agent?.feedback }));
    assert.equal(done.delegation!.acceptance!.accepted, true);
    assert.equal(done.messages.filter(message => message.role === 'user').length, 1);
    assert.equal(done.delegation!.request.revision, 1, 'No address re-confirmation or amended task was needed');
    assert.deepEqual(f.calls.filter(call => call.method === 'tools/call').map(call => call.name).sort(), ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    assert.deepEqual(done.delegation!.agent!.input, { mode: 'estimate', city: context.city, origin: input.origin, destination: input.destination });
    assert(done.delegation!.ontologyReads?.some(read => read.tool === 'read_task_context'));
    const wrong = { ...context, origin: { ...context.origin, address: '另一个不匹配的地址' } }, request = structuredClone(job.delegation!.request);
    addLocationContext(request, wrong, 'mismatch', new Date().toISOString());
    const artifact = done.artifact!.data.result as { didiAnswer: { route: Parameters<typeof routeLocationFacts>[1] } };
    assert.notEqual(routeLocationFacts(request, artifact.didiAnswer.route, context.city).origin, '家', 'A label cannot override a conflicting provider address');
  } finally { store.close(); f.close(); }
});

test('a confirmed full address remains the prepared search query and reaches the source within the same task', async () => {
  const f = didiFixture(), store = new JobStore(':memory:');
  f.flags.ambiguous = true;
  f.flags.transform = (body, request) => {
    if (request.params?.name === 'maps_textsearch' && request.params.arguments.keywords === context.origin.address) {
      const places = JSON.parse(body.result.content[0].text);
      places[1] = sourcePlace(input.origin, 2); places[2] = sourcePlace(input.origin, 3);
      body.result.content[0].text = JSON.stringify(places);
    }
    return body;
  };
  const model = didiModel((ctx, access) => {
    const decision = chooseDidi(ctx, access);
    return { ...decision, steps: decision.steps.map(step => {
      if (step.action !== 'SearchDidiPlaces') return step;
      const args = JSON.parse(step.argumentsJson), prepared = ctx.state.input as { origin: string; destination: string };
      return { ...step, argumentsJson: JSON.stringify({ ...args, keywords: args.role === 'origin' ? prepared.origin : prepared.destination }) };
    }) };
  }, { mode: 'estimate', origin: context.origin.address, destination: '拳馆' });
  const b = backend(createExecutionCatalog({ store, didi: { ...f.binding, connector: f.connector } }), model, store);
  try {
    let done = b.submit({ goal, locationContext: context, requirements });
    for (let i = 0; i < 10 && ['submitted', 'working'].includes(done.state); i++) done = await b.run();
    assert.equal(done.state, 'completed', JSON.stringify({ error: done.error, feedback: done.delegation?.agent?.feedback }));
    assert.equal(done.delegation!.agent!.input.origin, context.origin.address);
    assert(f.calls.some(call => call.name === 'maps_textsearch' && call.args?.keywords === context.origin.address));
    assert.equal(done.delegation!.acceptance!.accepted, true);
    assert.equal(done.delegation!.request.revision, 1);
    assert.equal(done.messages.filter(message => message.role === 'user').length, 1);
  } finally { store.close(); f.close(); }
});

test('MCP and A2A carry the same address context through the existing delegate interface', async t => {
  const f = didiFixture(), server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, token = 'synthetic-location-context-protocol-token';
  const app = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, DATABASE_PATH: ':memory:', PUBLIC_URL: base }), undefined,
    store => createExecutionCatalog({ store, didi: { ...f.binding, connector: f.connector } }));
  server.on('request', app.app);
  const worker = new Worker(app.store, { coordinator: new Coordinator(app.store, didiModel(), app.catalog), pollMs: 10 }); worker.start();
  const client = new Client({ name: 'location-context-test', version: '1' });
  t.after(async () => { await client.close(); await worker.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); f.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const tools = await client.listTools(); assert(!tools.tools.some(tool => tool.name === 'estimate_ride'));
  const submitted = await client.callTool({ name: 'submit_task', arguments: { service: 'eigos.delegate', goal, locationContext: context, requestId: randomUUID() } });
  assert(!submitted.isError);
  const id = (submitted.structuredContent as { result: Job }).result.id;
  const request = readOntologyRequest(app.store.ontology, owner, id); assert.deepEqual(requestLocations(request), context);
  const deadline = Date.now() + 30000;
  let done: Job = app.store.get(owner, id);
  while (['submitted', 'working'].includes(done.state) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); done = app.store.get(owner, id); }
  assert.equal(done.state, 'completed');
  const a2a = await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'context-submit', method: 'SendMessage', params: { configuration: { returnImmediately: true },
      message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { service: 'eigos.delegate', goal, locationContext: context } }] } } }) });
  const result = await a2a.json(); assert(!result.error, JSON.stringify(result));
  const otherId = result.result.task.id;
  assert.deepEqual(requestLocations(readOntologyRequest(app.store.ontology, owner, otherId)), context);
});

test('saved street addresses match the primary provider place without requiring the user to repeat administrative prefixes', () => {
  const supplied = { name: '合成云林小区', address: '合成路257弄 合成云林小区', label: '家', source: 'saved_address' as const };
  const place = { name: '合成云林小区257弄', address: '测试区测试镇合成路257弄', addressAll: '测试区测试镇合成路257弄合成云林小区257弄', city: '合成市' };
  assert(locationMatchesSource(supplied, '合成市', place));
  assert(locationMatchesSource({ ...supplied, name: '合成·云林小区', address: '合成市合成路257弄，合成·云林小区' }, '合成市', place));
  assert(!locationMatchesSource(supplied, '另一市', place));
  assert(!locationMatchesSource({ ...supplied, name: '另一个小区' }, '合成市', place));
  assert(!locationMatchesSource(supplied, '合成市', { ...place, name: '合成云林小区258弄', address: '测试区测试镇合成路258弄' }));
  assert(!locationMatchesSource(supplied, '合成市', { ...place, name: '合成云林小区257弄3号', address: place.address + '3号' }));
  assert(!locationMatchesSource(supplied, '合成市', { ...place, name: '合成云林小区', address: place.address + '、258弄' }));
  assert(!locationMatchesSource(supplied, '合成市', { ...place, address: '测试区测试镇新合成路257弄' }));
  assert(!locationMatchesSource({ ...supplied, address: '另一市合成路257弄' }, '合成市', { ...place, address: '合成路257弄' }));
});

test('airport terminal spellings match without merging terminals, entrances or other places', () => {
  const supplied = { name: '合成国际机场 T2 航站楼', source: 'user_provided' as const };
  const place = { name: '合成国际机场2号航站楼', address: '测试区机场路900号', addressAll: '测试区机场路900号合成国际机场2号航站楼', city: '合成市' };
  assert(locationMatchesSource(supplied, '合成市', place));
  assert(locationMatchesSource({ ...supplied, name: place.name }, '合成市', { ...place, name: supplied.name }));
  assert(locationMatchesSource({ ...supplied, name: '合成市合成国际机场Ｔ２航站楼' }, '合成市', place));
  for (const name of ['合成国际机场1号航站楼', '另一国际机场2号航站楼', '合成国际机场2号航站楼-23号门', '合成国际机场T2航站楼停车场', '合成国际机场T20航站楼']) {
    assert(!locationMatchesSource(supplied, '合成市', { ...place, name, addressAll: place.address + name }), name);
  }
  assert(!locationMatchesSource(supplied, '另一市', place));
  assert(!locationMatchesSource({ ...supplied, address: '机场路901号' }, '合成市', place));
  assert(!locationMatchesSource({ ...supplied, name: '合成T2大楼' }, '合成市', { ...place, name: '合成2号大楼' }));
});
