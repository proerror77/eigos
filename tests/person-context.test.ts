import { DefinitionService } from '../packages/ontology/definition-service.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { securityFixture } from './fixtures/security.js';
import { TaskService } from '../packages/core/tasks.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { DynamicOntologyProgram } from '../packages/capabilities/dynamic-ontology.js';
import { Coordinator, type Reasoner } from '../packages/coordinator/coordinator.js';
import { Worker } from '../apps/worker/worker.js';
import { taskContextFields } from '../packages/security/task-context-contract.js';
import { personalActionIds, selfPersonRef, personalPreferenceRef } from '../packages/ontology/personal-context.js';
import { OntologyObjectStore, type ObjectWrite, type LinkWrite } from '../packages/ontology/object-store.js';
import { OntologyPlanningSession, validatePlanningSnapshot } from '../packages/coordinator/planning-session.js';
import type { TaskContextPayload } from '../packages/coordinator/task-context.js';

const noModel: Reasoner = { ground: async () => { throw new Error('No implicit planning'); }, plan: async () => { throw new Error('No implicit planning'); }, act: async () => { throw new Error('Caller actions retain their caller origin'); } };
function fixture() {
  const f = securityFixture(), graph = f.jobs.ontology, program = new DynamicOntologyProgram(graph.model, graph.releaseRef!, f.owner), catalog = createExecutionCatalog({ store: f.jobs });
  const policy = f.jobs.security.policies, expiresAt = new Date(Date.now() + 3600000).toISOString(), sourceBindingId = `program:${program.ref.id}`;
  const types = ['ServiceRequest', 'Person', 'PersonalPreference', 'SavedAddress', 'RequestingParty', 'Place', 'Event', 'TravelLeg', 'HotelProperty', 'ProductVariant', 'RideRoute', ...Object.keys(taskContextFields)];
  const resources = [...new Set(types)].map(type => ({ type, fields: Object.keys(policy.fields(type)).filter(field => policy.fieldPolicy(type, field) !== 'internal_only') }));
  const install = (name: string) => {
    const installation = f.installation(name, 3600000);
    f.coordinator.approveAgentGrant(f.member.id, { installationId: installation.id, capabilityIds: [program.ref.id], resources, sourceBindingIds: [sourceBindingId], channels: ['agent_response', 'registered_model'], expiresAt });
    policy.setRole({ subjectKind: 'installation', subjectId: installation.id, resource: { kind: 'namespace', id: graph.model.ref.id, version: graph.model.ref.digest }, role: 'Viewer', executeActions: [...personalActionIds], invokeFunctions: graph.model.functionIds(), expiresAt }, policy.revision());
    policy.setRecipient(installation.id, { classification: 'sensitive', markings: ['member_private','personal_data','precise_location','financial','health','account_private'], channels: ['agent_response','registered_model'], expiresAt }, policy.revision());
    policy.setSource(f.owner, { installationId: installation.id, bindingId: sourceBindingId, programId: program.ref.id, programDigest: program.configurationDigest, operations: [...personalActionIds], outputTypes: ['Person','PersonalPreference'], expiresAt }, policy.revision());
    return { ...installation, principal: { ...f.principal, access: f.coordinator.authenticate(f.principal, installation.token) } };
  };
  const failures: string[] = [], commands = new Map<string, { action: string; input: Record<string, unknown>; requestId: string }>();
  class CheckedCoordinator extends Coordinator { override async run(...args: Parameters<Coordinator['run']>) { try { return await super.run(...args); } catch (error) { failures.push(error instanceof Error ? error.stack ?? error.message : String(error)); throw error; } } }
  const a = install('Personal PA A'), b = install('Personal PA B'), tasks = new TaskService(f.jobs, { catalog }), coordinator = new CheckedCoordinator(f.jobs, noModel, catalog);
  const write = async (action: string, input: Record<string, unknown>, selected = a) => {
    const command = { action, input, requestId: randomUUID() }, waiting = tasks.prepareOntologyAction(selected.principal, command);
    commands.set(waiting.id, structuredClone(command));
    assert.equal(waiting.state, 'auth-required');
    const raw = f.jobs.get(f.owner, waiting.id), approval = raw.delegation!.authorizationRequest!;
    assert('objectWrite' in approval); assert.equal(f.jobs.intents(f.owner, waiting.id)[0]!.state, 'ready');
    assert.equal(tasks.prepareOntologyAction(selected.principal, command).id, waiting.id);
    tasks.authorize(selected.principal, waiting.id, { action: 'approve_object_write', requestId: randomUUID(), planDigest: approval.planDigest, objectWrite: approval.objectWrite, expiresAt, environment: 'managed' });
    const worker = new Worker(f.jobs, { coordinator, pollMs: 10, leaseMs: 30000 });
    try {
      worker.start(); const deadline = Date.now() + 30000;
      while (['submitted','working'].includes(f.jobs.get(f.owner, waiting.id).state) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      const done = f.jobs.get(f.owner, waiting.id);
      assert.equal(done.state, 'completed', JSON.stringify({ failures, state: done.state, error: done.error, feedback: done.delegation?.agent?.feedback, intents: f.jobs.intents(f.owner, done.id).map(intent => ({ state: intent.state, message: intent.lastResult?.message })) }));
      assert.equal(done.delegation!.acceptance!.accepted, true); assert.equal(done.runs?.length, 0);
      return done;
    } finally { await worker.close(); }
  };
  const rawDb = new DatabaseSync(f.database), rawGraph = new OntologyObjectStore(rawDb, graph.model, Date.now, undefined, { skipLegacyMigration: true });
  return { ...f, a, b, tasks, graph, rawGraph, write, catalog, expiresAt, install, commands, close: () => { rawDb.close(); f.close(); } };
}

test('Foundation personal actions use exact previews, real Worker commits and independent task grants', { timeout: 120000 }, async () => {
  const f = fixture();
  try {
    await f.write('BindSelfPerson', { self: true, displayTitle: 'Synthetic self' });
    assert.equal(f.rawGraph.read(f.owner, selfPersonRef(f.owner)).revision, 1);
    await f.write('CreatePersonalPreference', { key: 'rideClass', value: { kind: 'rideClass', value: 'comfort' } });
    const first = f.tasks.submit(f.a.principal, { requestId: randomUUID(), goal: '参加活动并安排交通', personalContext: { self: true, preferences: ['rideClass'] } });
    const second = f.tasks.submit(f.b.principal, { requestId: randomUUID(), goal: '去东京旅行并安排机场交通', personalContext: { self: true, preferences: ['rideClass'] } });
    for (const [job, actor] of [[first, f.a], [second, f.b]] as const) {
      const request = f.jobs.get(f.owner, job.id).delegation!.request;
      assert.equal(request.confirmedInputs!.personal!.fields.rideClass!.value, 'comfort');
      assert.deepEqual(request.confirmedInputs!.personal!.fields.subject!.value, selfPersonRef(f.owner));
      f.jobs.security.withAgent(actor.principal, job.id, 'task.query', () => {
        const session = new OntologyPlanningSession(f.graph, f.owner, request, [], () => {}, () => {}, 'request', [], { taskContext: { purpose: 'grounding' } });
        const output = session.call('read_task_context', {}) as { data: TaskContextPayload };
        assert(output.data, JSON.stringify(output)); assert.deepEqual(output.data.personal!.person, selfPersonRef(f.owner));
      });
    }
    const grant = f.jobs.security.taskGrant(f.jobs.security.agentContext(f.a.principal), first.id);
    f.jobs.security.revokeGrant(f.owner, grant.id, grant.revision);
    assert.throws(() => f.tasks.queryOntology(f.a.principal, { version: 2, taskId: first.id, query: { object: personalPreferenceRef(f.owner, 'rideClass') } }));
    assert.equal(f.tasks.queryOntology(f.b.principal, { version: 2, taskId: second.id, query: { object: personalPreferenceRef(f.owner, 'rideClass'), select: ['status'] } }).items[0]!.properties.status, 'active');
    for (const id of [first.id, second.id]) { const job = f.jobs.get(f.owner, id); job.state = 'input-required'; job.question = 'Synthetic scenario waiting'; f.jobs.save(f.owner, job); }
    await f.write('ClearPersonalPreference', { key: 'rideClass', expectedRevision: 1 }, f.b);
    const empty = f.tasks.submit(f.b.principal, { requestId: randomUUID(), goal: '默认值清除后的新任务', personalContext: { self: true, preferences: ['rideClass'] } });
    assert.equal(f.jobs.get(f.owner, empty.id).delegation!.request.confirmedInputs!.personal!.fields.rideClass, undefined);
  } finally { f.close(); }
});

test('activities, Tokyo travel and shopping share typed person context; defaults never override explicit choices', { timeout: 120000 }, async t => {
  const f = fixture(); let externalCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { externalCalls++; throw new Error('No provider call is needed for already authorized context'); });
  try {
    await f.write('BindSelfPerson', { self: true, displayTitle: 'Synthetic self' });
    const objects: ObjectWrite[] = [
      { ref: { type: 'SavedAddress', id: 'home' }, properties: { savedAddressId: 'home', displayTitle: 'Home', address: { text: 'Synthetic home' }, contactInstructions: 'NEVER_INCLUDE_CONTACT' } },
      { ref: { type: 'SavedAddress', id: 'office' }, properties: { savedAddressId: 'office', displayTitle: 'Office', address: { text: 'Synthetic office' } } },
      { ref: { type: 'Place', id: 'airport' }, properties: { placeId: 'airport', displayTitle: 'Airport', name: 'Departure airport' } },
      { ref: { type: 'Place', id: 'venue' }, properties: { placeId: 'venue', displayTitle: 'Venue', name: 'Event venue' } },
      { ref: { type: 'Place', id: 'hotel-place' }, properties: { placeId: 'hotel-place', displayTitle: 'Hotel place', name: 'Tokyo hotel location' } },
      { ref: { type: 'Event', id: 'event' }, properties: { id: 'event', displayTitle: 'Event', serviceUrl: 'https://example.test/event', title: 'Activity', kind: 'event_registration', startsAt: '2030-01-01T12:00:00Z', endsAt: '2030-01-01T14:00:00Z', timeZone: 'UTC' } },
      { ref: { type: 'TravelLeg', id: 'flight' }, properties: { objectId: 'flight', displayTitle: 'Flight to Tokyo', startsAt: '2030-01-02T03:00:00Z', endsAt: '2030-01-02T06:00:00Z' } },
      { ref: { type: 'HotelProperty', id: 'hotel' }, properties: { objectId: 'hotel', displayTitle: 'Hotel', hotelName: 'Tokyo hotel' } },
      { ref: { type: 'RideRoute', id: 'airport-ride' }, properties: { objectId: 'airport-ride', displayTitle: 'Airport transport', origin: 'Confirmed pickup', destination: 'Departure airport' } },
      { ref: { type: 'ProductVariant', id: 'product' }, properties: { variantId: 'product', displayTitle: 'Product', name: 'Selected product', specification: [{ name: 'size', value: 'M' }], specificationRevision: '1' } },
    ];
    const ref = (id: string) => objects.find(object => object.ref.id === id)!.ref;
    const evidence: LinkWrite[] = [];
    for (const object of [...objects].filter(object => ['Place','Event'].includes(object.ref.type))) {
      const receipt = { type: 'SourceReceipt', id: `receipt:${object.ref.id}` };
      objects.push({ ref: receipt, properties: { receiptId: receipt.id, displayTitle: 'Synthetic source', safeSummary: 'Synthetic personal-context fixture', evidenceLevel: 'synthetic' } });
      evidence.push({ type: `${object.ref.type}Evidence`, from: object.ref, to: receipt });
    }
    f.rawGraph.ingest(f.owner, { objects, links: [...evidence,
      { type: 'EventVenue', from: ref('event'), to: ref('venue') },
      { type: 'TravelLegOriginPlace', from: ref('flight'), to: ref('airport') },
      { type: 'RideRouteDestinationPlace', from: ref('airport-ride'), to: ref('airport') },
      { type: 'HotelPropertyLocation', from: ref('hotel'), to: ref('hotel-place') },
    ] }, { kind: 'synthetic', id: 'person-three-scenarios', observedAt: new Date().toISOString() });
    await f.write('CreatePersonalPreference', { key: 'rideClass', value: { kind: 'rideClass', value: 'comfort' } });
    await f.write('CreatePersonalPreference', { key: 'deliveryAddress', value: { kind: 'deliveryAddress', address: ref('home') } });
    const activity = f.tasks.submit(f.a.principal, { requestId: randomUUID(), goal: '参加活动，今天使用 standard 车型', personalContext: { self: true, preferences: ['rideClass'], overrides: { rideClass: 'standard' }, resources: [{ object: ref('event'), revision: 1, fields: ['title','startsAt'], role: 'activity' }] } });
    const tokyo = f.tasks.submit(f.b.principal, { requestId: randomUUID(), goal: '去东京旅行，沿已选航班安排机场交通和酒店接送', personalContext: { self: true, preferences: ['rideClass'], resources: [
      { object: ref('flight'), revision: 1, fields: ['startsAt','endsAt'], role: 'travel' }, { object: ref('airport-ride'), revision: 1, fields: ['origin','destination'], role: 'transport' },
      { object: ref('hotel'), revision: 1, fields: ['hotelName'], role: 'lodging' }, { object: ref('airport'), revision: 1, fields: ['name'], role: 'destination' },
    ] } });
    const shopping = f.tasks.submit(f.a.principal, { requestId: randomUUID(), goal: '网购已选商品，本次送公司', personalContext: { self: true, preferences: ['deliveryAddress'], overrides: { deliveryAddress: ref('office') }, resources: [{ object: ref('product'), revision: 1, fields: ['name','specification'], role: 'product' }] } });
    const cleared = f.tasks.submit(f.b.principal, { requestId: randomUUID(), goal: '这次先清除配送地址', personalContext: { self: true, preferences: ['deliveryAddress'], overrides: { deliveryAddress: null } } });
    const read = (id: string, actor = f.a) => f.jobs.security.withAgent(actor.principal, id, 'task.query', () => {
      const request = f.jobs.get(f.owner, id).delegation!.request, session = new OntologyPlanningSession(f.graph, f.owner, request, [], () => {}, () => {}, 'request', [], { taskContext: { purpose: 'grounding' } });
      const output = session.call('read_task_context', {}) as { data: TaskContextPayload; receipt: { id: string } };
      assert(output.data, JSON.stringify(output)); session.acceptReceipts([output.receipt.id]);
      return { data: output.data, snapshot: session.finish(), request };
    });
    const activityPlan = read(activity.id);
    assert.equal(activityPlan.data.request.confirmedInputs!.personal!.fields.rideClass!.value, 'standard');
    const travel = read(tokyo.id, f.b);
    assert.equal(travel.data.request.confirmedInputs!.personal!.fields.rideClass!.value, 'comfort');
    assert(travel.data.graph.links.some(link => link.type === 'RequestTravelContext'));
    assert(travel.data.graph.links.some(link => link.type === 'RequestTransportContext'));
    f.jobs.security.withAgent(f.b.principal, tokyo.id, 'task.query', () => {
      const flightAirport = f.graph.query(f.owner, { from: ref('flight'), as: 'OriginDestination', link: 'origin', select: ['name'] }).items[0]!.ref;
      assert.deepEqual(f.graph.query(f.owner, { from: ref('airport-ride'), as: 'OriginDestination', link: 'destination', select: ['name'] }).items[0]!.ref, flightAirport);
    });
    const cart = read(shopping.id).data;
    assert.deepEqual(cart.request.confirmedInputs!.personal!.fields.deliveryAddress!.value, ref('office'));
    assert(!JSON.stringify(cart).includes('NEVER_INCLUDE_CONTACT'));
    assert.equal(read(cleared.id, f.b).data.request.confirmedInputs!.personal!.fields.deliveryAddress!.status, 'cleared');
    assert.equal(f.rawGraph.read(f.owner, personalPreferenceRef(f.owner, 'deliveryAddress')).revision, 1, 'Task choices never update long-term defaults');
    const paDefault = { value: { kind: 'rideClass', value: 'standard' }, sourceReference: 'pa-profile:travel', sourceVersion: 'v1', observedAt: '2026-01-01T00:00:00Z', userConfirmed: true };
    const paOnly = f.tasks.submit(f.a.principal, { requestId: randomUUID(), goal: '使用 PA 已确认的个人默认值', personalContext: { self: true, paDefaults: [paDefault] } });
    assert.equal(read(paOnly.id).data.request.confirmedInputs!.personal!.fields.rideClass!.value, 'standard');
    assert.equal(read(paOnly.id).data.personal!.defaults[0]!.sources[0]!.authority, 'pa');
    const conflict = f.tasks.submit(f.a.principal, { requestId: randomUUID(), goal: '检查两个个人资料来源的冲突', personalContext: { self: true, preferences: ['rideClass'], paDefaults: [paDefault] } });
    assert.equal(read(conflict.id).data.request.confirmedInputs!.personal!.fields.rideClass!.status, 'ambiguous');
    assert.equal(f.rawGraph.read(f.owner, personalPreferenceRef(f.owner, 'rideClass')).properties.value && (f.rawGraph.read(f.owner, personalPreferenceRef(f.owner, 'rideClass')).properties.value as { value: string }).value, 'comfort', 'PA snapshots never overwrite EIGOS-managed preferences');
    assert.throws(() => f.tasks.submit(f.a.principal, { requestId: randomUUID(), goal: '未确认的推测不能作为默认', personalContext: { self: true, paDefaults: [{ ...paDefault, userConfirmed: false }] } }));
    const unbound = f.tasks.submit(f.a.principal, { requestId: randomUUID(), goal: '没有声明服务对象的任务' });
    assert.equal(f.rawGraph.query(f.owner, { from: { type: 'ServiceRequest', id: unbound.id }, link: 'servedPerson' }).items.length, 0);
    // Leave the scenario tasks waiting while a different task updates the default.
    for (const id of [activity.id, tokyo.id, shopping.id, cleared.id, unbound.id, paOnly.id, conflict.id]) { const job = f.jobs.get(f.owner, id); job.state = 'input-required'; job.question = 'Synthetic scenario waiting for its next decision'; f.jobs.save(f.owner, job); }
    await f.write('SetPersonalPreference', { key: 'rideClass', value: { kind: 'rideClass', value: 'premium' }, expectedRevision: 1 });
    assert.throws(() => f.jobs.security.withAgent(f.b.principal, tokyo.id, 'task.query', () => validatePlanningSnapshot(f.graph, f.owner, travel.request, travel.snapshot, true)));
    f.jobs.security.withAgent(f.a.principal, activity.id, 'task.query', () => validatePlanningSnapshot(f.graph, f.owner, activityPlan.request, activityPlan.snapshot, true));
    assert.equal(f.jobs.get(f.owner, tokyo.id).delegation!.request.confirmedInputs!.personal!.fields.rideClass!.value, 'comfort', 'The historical task choice retains its old version');
    const refresh = (job: typeof tokyo, actor: typeof f.a) => f.tasks.amend(actor.principal, { taskId: job.id, requestId: randomUUID(), expectedRevision: f.jobs.get(f.owner, job.id).revision!, answer: '重新核对已选个人事实，保留原任务和明确要求', personalContext: { self: true } });
    refresh(tokyo, f.b); refresh(activity, f.a); refresh(cleared, f.b);
    assert.throws(() => f.tasks.amend(f.a.principal, { taskId: paOnly.id, requestId: randomUUID(), expectedRevision: f.jobs.get(f.owner, paOnly.id).revision!, answer: '拒绝迟到的旧资料', personalContext: { self: true, paDefaults: [{ ...paDefault, observedAt: '2025-01-01T00:00:00Z', sourceVersion: 'v0' }] } }), /older|inconsistent/);
    assert.equal(read(tokyo.id, f.b).data.request.confirmedInputs!.personal!.fields.rideClass!.value, 'premium');
    assert.equal(read(activity.id).data.request.confirmedInputs!.personal!.fields.rideClass!.value, 'standard', 'Refreshing defaults must preserve an earlier explicit override');
    assert.deepEqual(read(activity.id).data.request.confirmedInputs!.personal!.fields.rideClass!.source, activityPlan.request.confirmedInputs!.personal!.fields.rideClass!.source, 'Unchanged choices keep their original confirmation source');
    assert.equal(read(cleared.id, f.b).data.request.confirmedInputs!.personal!.fields.deliveryAddress!.status, 'cleared');
    assert.equal(read(tokyo.id, f.b).data.personal!.resources.length, 4, 'Unchanged travel references survive personal updates');
    f.tasks.amend(f.a.principal, { taskId: activity.id, requestId: randomUUID(), expectedRevision: f.jobs.get(f.owner, activity.id).revision!, answer: '本次不再关联该活动，保持其他要求', personalContext: { self: true, resources: [] } });
    assert.equal(f.rawGraph.query(f.owner, { from: { type: 'ServiceRequest', id: activity.id }, link: 'activityContext' }).items.length, 0);
    assert.equal(f.rawGraph.read(f.owner, ref('event')).revision, 1, 'Removing a personal relation does not mutate the shared event');
    const privateHistory = f.tasks.queryOntology(f.b.principal, { version: 2, taskId: tokyo.id, query: { from: selfPersonRef(f.owner), link: 'serviceRequests', limit: 1 } });
    assert.deepEqual(privateHistory.items.map(item => item.ref.id), [tokyo.id]); assert.equal(privateHistory.page.hasMore, false);
    f.coordinator.revokeInstallation(f.member.id, f.a.id);
    assert.throws(() => read(activity.id));
    assert.equal(read(tokyo.id, f.b).data.personal!.person.id, selfPersonRef(f.owner).id);
    assert.equal(externalCalls, 0);
  } finally { f.close(); }
});

test('personal previews reject foreign identity, stale versions and unavailable field or effect authority', { timeout: 60000 }, async () => {
  const f = fixture();
  try {
    const count = f.jobs.list(f.owner, { limit: 50, offset: 0 }).total;
    assert.throws(() => f.tasks.prepareOntologyAction(f.a.principal, { action: 'BindSelfPerson', requestId: randomUUID(), input: { self: true, personId: 'another-person', displayTitle: 'Wrong identity' } }), /another service subject/);
    assert.equal(f.jobs.list(f.owner, { limit: 50, offset: 0 }).total, count);
    assert.throws(() => f.tasks.prepareOntologyAction(f.a.principal, { action: 'SubmitServiceRequest', requestId: randomUUID(), input: {} }), /limited to reviewed personal actions/);
    await f.write('BindSelfPerson', { self: true, displayTitle: 'Synthetic self' });
    const createdPreference = await f.write('CreatePersonalPreference', { key: 'rideClass', value: { kind: 'rideClass', value: 'comfort' } });
    const definitions = new DefinitionService(f.jobs, f.tasks, f.catalog);
    assert.equal((definitions.prepare(f.a.principal, f.commands.get(createdPreference.id)!).result as { preview: { status: string } }).preview.status, 'committed');
    assert.throws(() => f.tasks.prepareOntologyAction(f.a.principal, { action: 'SetPersonalPreference', requestId: randomUUID(), input: { key: 'rideClass', value: { kind: 'rideClass', value: 'premium' }, expectedRevision: 2 } }), /revision|changed/i);
    const waiting = f.tasks.prepareOntologyAction(f.a.principal, { action: 'ClearPersonalPreference', requestId: randomUUID(), input: { key: 'rideClass', expectedRevision: 1 } });
    const approval = f.jobs.get(f.owner, waiting.id).delegation!.authorizationRequest!; assert('objectWrite' in approval);
    assert.throws(() => f.tasks.authorize({ ...f.a.principal, scopes: f.a.principal.scopes.filter(scope => scope !== 'ontology:object_write') }, waiting.id, { action: 'approve_object_write', requestId: randomUUID(), planDigest: approval.planDigest, objectWrite: approval.objectWrite, expiresAt: f.expiresAt, environment: 'managed' }), /scope|AUTHORIZATION_REQUIRED/);
    f.tasks.cancel(f.a.principal, waiting.id);
    assert.equal(f.rawGraph.read(f.owner, personalPreferenceRef(f.owner, 'rideClass')).properties.status, 'active');
    f.jobs.security.policies.restrictObject({ ownerKey: f.owner, object: personalPreferenceRef(f.owner, 'rideClass'), expectedObjectRevision: 1, field: 'value', classification: 'internal', requiredMarkings: ['personal_data'], channels: [] }, f.jobs.security.policies.revision());
    assert.throws(() => f.tasks.submit(f.b.principal, { requestId: randomUUID(), goal: '不能恢复被隐藏的默认值', personalContext: { self: true, preferences: ['rideClass'] } }));
    assert.throws(() => definitions.prepare(f.a.principal, f.commands.get(createdPreference.id)!), /not available|INSUFFICIENT_ACCESS|OUTPUT_NOT_ALLOWED/, 'Idempotent preparation cannot reveal a now-restricted historical value');
  } finally { f.close(); }
});
