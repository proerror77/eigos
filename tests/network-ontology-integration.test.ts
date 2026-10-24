// Local authenticated transports and synthetic source observations only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { networkGatewayFixture } from './fixtures/network-gateway.js';
import { inquiryFixture, quoteBinding, quoteCapability } from './fixtures/network-inquiry.js';
import { programContext, programRead } from './fixtures/paotui-agent.js';
import { PaotuiAgentProgram } from '../packages/capabilities/paotui-agent.js';
import { atomicReceiptSchema, atomicTool, type PaotuiAtomicReader } from '../packages/capabilities/paotui-atomic.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { digest } from '../packages/core/delegation.js';
import { ownerKey } from '../packages/core/domain.js';
import { commands } from '../packages/network/contracts.js';
import { OntologyPlanningSession, validatePlanningSnapshot } from '../packages/coordinator/planning-session.js';
import { readOntologyRequest } from '../packages/ontology/execution-projection.js';
import type { ObjectQuery, OntologyQueryResult } from '../packages/ontology/object-store.js';
import type { ObjectRef } from '../packages/ontology/model.js';

const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
const queryResult = (value: unknown): OntologyQueryResult => {
  assert(value && typeof value === 'object' && 'items' in value, JSON.stringify(value)); return value as OntologyQueryResult;
};
async function gatewayInquiry() {
  const source = inquiryFixture(); let addresses!: PaotuiAgentProgram, sourceReads = 0;
  const connector: PaotuiAtomicReader = { async invoke(operation, input, signal) {
    signal.throwIfAborted(); sourceReads++;
    assert.equal(operation, 'get_address_list');
    const result = { addresses: [{ addressId: 'PRIVATE_ADDRESS_REFERENCE', address: 'PRIVATE_ADDRESS_TEXT', tag: '家里', cityId: '110100', lat: 40019368, lng: 116469191 }] };
    return { result, receipt: atomicReceiptSchema.parse({ id: randomUUID(), version: '1', server: 'eigos-ontology', transport: 'mcp-stdio', operation,
      tool: atomicTool(operation), evidenceKind: 'fixture', inputDigest: digest(input), resultDigest: digest(result), observedAt: new Date().toISOString(), sourceCalls: [operation], readOnly: true }) };
  } };
  const f = await networkGatewayFixture(true, true, store => {
    class FixtureAddressProgram extends PaotuiAgentProgram { override permitted() { return true; } }
    addresses = new FixtureAddressProgram('addresses', { store, directory: '/private/synthetic-not-opened', connector });
    return new ExecutionCatalog([quoteCapability, addresses.capability()], [quoteBinding], [source.catalog.binding(quoteBinding.ref, source.owner).adapter], [], [addresses]);
  }).catch(error => { source.close(); throw error; });
  try {
    const network = f.gateway.network!, owner = ownerKey(f.a.p);
    const control = (input: object, memberId = f.alice.id) => network.control(memberId, { version: 1, requestId: randomUUID(), ...input });
    const createProfile = (name: string) => {
      const id = control({ action: 'profile.create', displayName: name }).refs[0]!.id;
      control({ action: 'profile.bind_installation', profileId: id, installationId: f.a.id, allowedCommands: [...commands] }); return id;
    };
    const buyerProfile = createProfile('Synthetic buyer'), sellerProfile = createProfile('Synthetic publishing representative');
    const command = (profileId: string, input: object) => network.command(f.a.p, f.a.token, { version: 1, requestId: randomUUID(), asProfileId: profileId, ...input });
    const representationId = command(sellerProfile, { operation: 'representation.request', providerId: quoteBinding.providerId, role: 'aggregator', capabilityRefs: [quoteCapability.ref], note: 'PRIVATE_REVIEW_NOTE' }).refs[0]!.id;
    control({ action: 'representation.review', representationId, expectedRevision: 1, decision: 'verified', proofRef: 'PRIVATE_PROOF_REFERENCE', validUntil: new Date(Date.now() + 86400000).toISOString() }, f.bob.id);
    const listingId = command(sellerProfile, { operation: 'listing.create', representationId, capabilityRef: quoteCapability.ref, details: { title: 'Only an approved synthetic quote source', description: 'No transaction authority', coarseAreas: ['110105'] } }).refs[0]!.id;
    command(sellerProfile, { operation: 'listing.submit_review', listingId, expectedRevision: 1 });
    control({ action: 'listing.review', listingId, expectedRevision: 2, decision: 'approved', bindingRef: quoteBinding.ref }, f.bob.id);
    const publish = (profileId: string, content: object) => {
      const draftId = command(profileId, { operation: 'draft.create', content }).refs[0]!.id;
      const approvalId = command(profileId, { operation: 'publication.request_approval', draftId, expectedRevision: 1, recipientMemberIds: [f.alice.id, f.bob.id],
        publishBefore: new Date(Date.now() + 60000).toISOString(), visibleUntil: new Date(Date.now() + 3600000).toISOString() }).refs[0]!.id;
      const approval = network.store.get('approval', approvalId);
      const grantId = control({ action: 'publication.approve', approvalRequestId: approvalId, expectedDraftRevision: 1, reviewDigest: approval.reviewDigest }).refs[0]!.id;
      return command(profileId, { operation: 'publication.publish', draftId, expectedRevision: 1, grantId }).refs[0]!.id;
    };
    const listingPublicationId = publish(sellerProfile, { kind: 'listing', listingId, listingRevision: 3 });
    const postId = publish(buyerProfile, { kind: 'need', body: { title: 'Approved original need', safeGoal: 'PUBLIC_ORIGINAL_NEED', category: 'delivery', coarseArea: '110105', replyDeadline: new Date(Date.now() + 7200000).toISOString() } });
    const choiceId = command(buyerProfile, { operation: 'inquiry.request_conversion', input: { postId, expectedPostRevision: 1, listing: { publicationId: listingPublicationId, revision: 1 },
      request: { kind: 'create', buyerGoal: 'PRIVATE_ORIGINAL_TASK_GOAL', completionTarget: 'quote_only' } } }).refs[0]!.id;
    const choice = network.store.get('choice', choiceId);
    control({ action: 'inquiry.approve_choice', choiceId, expectedRevision: 1, reviewDigest: choice.reviewDigest });
    const inquiryId = command(buyerProfile, { operation: 'inquiry.convert', choiceId }).refs[0]!.id, inquiry = network.store.get('inquiry', inquiryId, owner);
    const post = async (path: string, body: object, token?: string) => {
      const response = await f.call(path, body, token ? { Authorization: `Bearer ${token}` } : {});
      return { status: response.status, value: await response.json() };
    };
    return { ...f, owner, network, inquiry, buyerProfile, sellerProfile, listingId, listingPublicationId, postId, addresses, post, control,
      sourceReads: () => sourceReads, close: async () => { await f.close(); source.close(); } };
  } catch (error) { await f.close(); source.close(); throw error; }
}

test('HTTP and MCP ontology entrypoints navigate the same authorized original network chain and reject missing scope, bearer and cross-owner access', async () => {
  const f = await gatewayInquiry(), clients: Client[] = [];
  const mcp = async (token: string) => {
    const client = new Client({ name: 'network-ontology-transport', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.http), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return client;
  };
  try {
    const root = { type: 'ServiceRequest', id: f.inquiry.taskId }, path: ObjectQuery = { from: root, link: 'networkInquiries' };
    assert.equal((await f.post('/ontology/query', path)).status, 401);
    assert.equal((await f.post('/ontology/query', path, 'invalid-bearer')).status, 401);
    assert.equal((await f.post('/mcp', { jsonrpc: '2.0', id: 'unauthorized', method: 'tools/list' })).status, 401);
    const http = await f.post('/ontology/query', path, f.a.token); assert.equal(http.status, 200); assert.equal(http.value.items[0].ref.id, f.inquiry.id);
    const client = await mcp(f.a.token), result = await client.callTool({ name: 'query_ontology', arguments: path }); assert(!result.isError, JSON.stringify(result));
    assert.deepEqual((result.structuredContent as { result: OntologyQueryResult }).result.items, http.value.items);
    const publication = await client.callTool({ name: 'query_ontology', arguments: { from: { type: 'NetworkInquiry', id: f.inquiry.id }, link: 'listingPublication' } });
    assert(!publication.isError); assert.equal((publication.structuredContent as { result: OntologyQueryResult }).result.items[0]!.ref.id, f.listingPublicationId);
    for (const secret of [f.a.token, 'PRIVATE_PROOF_REFERENCE', 'PRIVATE_REVIEW_NOTE', 'PRIVATE_ORIGINAL_TASK_GOAL']) assert(!JSON.stringify(publication).includes(secret));
    const limited = await f.makeAgent(f.alice, ['tasks:read']), limitedClient = await mcp(limited.token);
    const ordinary = await f.post('/ontology/query', { object: root }, limited.token); assert.equal(ordinary.status, 200); assert.equal(ordinary.value.items[0].properties.originalGoal, 'PRIVATE_ORIGINAL_TASK_GOAL');
    assert.equal((await f.post('/ontology/query', path, limited.token)).status, 403);
    const mcpOrdinary = await limitedClient.callTool({ name: 'query_ontology', arguments: { object: root } }); assert(!mcpOrdinary.isError);
    const mcpDenied = await limitedClient.callTool({ name: 'query_ontology', arguments: path }); assert(mcpDenied.isError); assert(JSON.stringify(mcpDenied).includes('FORBIDDEN'));
    const noTasks = await f.makeAgent(f.alice, ['network:read']); assert.equal((await f.post('/ontology/query', path, noTasks.token)).status, 403);
    assert.equal((await f.post('/ontology/query', path, f.b.token)).status, 404);
    const foreign = await mcp(f.b.token), foreignRead = await foreign.callTool({ name: 'query_ontology', arguments: { object: { type: 'NetworkInquiry', id: f.inquiry.id } } }); assert(foreignRead.isError);
    const empty = await f.post('/ontology/query', { type: 'NetworkInquiry' }, f.b.token); assert.equal(empty.status, 200); assert.deepEqual(empty.value.items, []); assert.equal(empty.value.page.scanned, 0); assert.equal(empty.value.page.hasMore, false);
    f.gateway.members.agents.revoke(f.alice.id, f.a.id);
    assert.equal((await f.post('/ontology/query', path, f.a.token)).status, 403);
    const afterRevoke = await client.callTool({ name: 'query_ontology', arguments: path }).then(value => !!value.isError, () => true); assert.equal(afterRevoke, true);
    assert.equal(f.sourceReads(), 0);
  } finally { for (const client of clients) await client.close(); await f.close(); }
});

test('ordinary owned tasks retain reads and sanitized registered calculations with network configured and only tasks scope', async () => {
  const f = await gatewayInquiry(), client = new Client({ name: 'ordinary-task-ontology', version: '1' });
  try {
    const job = f.gateway.tasks.submit(f.a.p, { goal: 'Read the synthetic address book only', requestId: randomUUID() });
    const context = programContext(f.gateway.store, f.owner, job.delegation!.request, f.addresses), observation = await programRead(f.addresses, context);
    const expected = f.gateway.store.ontology.evaluate(f.owner, { function: 'paotuiObservationStatus', object: observation }); assert.equal(expected.status, 'known');
    const limited = await f.makeAgent(f.alice, ['tasks:read']);
    const ordinary = await f.post('/ontology/query', { object: { type: 'ServiceRequest', id: job.id } }, limited.token); assert.equal(ordinary.status, 200);
    const origin = await f.post('/ontology/query', { from: { type: 'ServiceRequest', id: job.id }, link: 'networkInquiries' }, f.a.token);
    assert.equal(origin.status, 200); assert.deepEqual(origin.value.items, []); assert.equal(origin.value.page.hasMore, false); assert.equal(origin.value.page.scanned, 0);
    const http = await f.post('/ontology/evaluate', { function: 'paotuiObservationStatus', object: observation }, limited.token);
    assert.equal(http.status, 200, JSON.stringify(http.value)); assert.deepEqual(http.value, expected);
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.http), { requestInit: { headers: { Authorization: `Bearer ${limited.token}` } } }));
    const mcp = await client.callTool({ name: 'evaluate_ontology', arguments: { function: 'paotuiObservationStatus', object: observation } }); assert(!mcp.isError, JSON.stringify(mcp));
    assert.deepEqual((mcp.structuredContent as { result: unknown }).result, expected);
    for (const value of [http.value, mcp]) for (const secret of ['PRIVATE_ADDRESS_TEXT', 'PRIVATE_ADDRESS_REFERENCE', 'privateSnapshot', limited.token]) assert(!JSON.stringify(value).includes(secret));
    const hidden = await f.post('/ontology/query', { object: observation, select: ['privateSnapshot'] }, limited.token); assert.equal(hidden.status, 403);
    assert.equal(f.sourceReads(), 1, 'Ontology readback never performs another source call');
  } finally { await client.close(); await f.close(); }
});

function nativeSession(f: ReturnType<typeof inquiryFixture>, taskId: string) {
  const request = readOntologyRequest(f.jobs.ontology, f.owner, taskId);
  const session = new OntologyPlanningSession(f.jobs.ontology, f.owner, request, [], () => {}, () => {}, 'request');
  const definitions = session.call('describe_ontology', { search: 'NetworkInquiry', limit: 1 }); assert(!JSON.stringify(definitions).includes('"error"'));
  queryResult(session.call('query_ontology', { object: { type: 'ServiceRequest', id: taskId } }));
  const inquiry = queryResult(session.call('query_ontology', { from: { type: 'ServiceRequest', id: taskId }, link: 'networkInquiries' })).items[0]!;
  const publication = queryResult(session.call('query_ontology', { from: inquiry.ref, link: 'listingPublication' })).items[0]!;
  return { request, session, inquiry, publication };
}

test('native planning records actual network reads and reconstructs current admission before snapshot reuse', () => {
  for (const invalidation of ['installation', 'publication', 'gateway'] as const) {
    const f = inquiryFixture(); try {
      const inquiry = f.convert(), read = nativeSession(f, inquiry.taskId), snapshot = read.session.finish();
      assert(snapshot.reads.every(receipt => receipt.status === 'ok'));
      assert(snapshot.objects.some(object => object.ref.type === 'NetworkInquiry' && object.ref.id === inquiry.id));
      assert(snapshot.reads.flatMap(receipt => receipt.deliveredObjects ?? []).some(object => object.ref.type === 'NetworkPublication' && object.ref.id === f.listingPublicationId));
      validatePlanningSnapshot(f.jobs.ontology, f.owner, read.request, snapshot, true);
      if (invalidation === 'installation') f.members.agents.revoke(f.a.member.id, f.a.id);
      if (invalidation === 'publication') f.seller({ operation: 'publication.withdraw', publicationId: f.listingPublicationId, expectedRevision: 1 });
      if (invalidation === 'gateway') f.service.close();
      assert.throws(() => validatePlanningSnapshot(f.jobs.ontology, f.owner, read.request, snapshot, true));
      const denied = read.session.call('query_ontology', { object: read.publication.ref }); assert('error' in (denied as object), JSON.stringify(denied));
      assert.equal(read.session.lastReceipt()!.status, 'rejected');
      assert.equal(f.jobs.get(f.owner, inquiry.taskId).state, 'submitted'); assert.equal(f.readCount(), 0);
      // Existing unknown operations may still retain their historical contract;
      // this path does not permit a fresh dispatch or another shared read.
      assert.doesNotThrow(() => validatePlanningSnapshot(f.jobs.ontology, f.owner, read.request, snapshot, false));
    } finally { f.close(); }
  }
});

test('native read_task_context can be followed by network navigation and legacy admission remains unavailable without breaking ordinary owned reads', () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert(), request = readOntologyRequest(f.jobs.ontology, f.owner, inquiry.taskId);
    const session = new OntologyPlanningSession(f.jobs.ontology, f.owner, request, [], () => {}, () => {}, 'request', [], { taskContext: { purpose: 'grounding' } });
    const context = session.call('read_task_context', {}); assert(!('error' in (context as object)), JSON.stringify(context));
    const origins = queryResult(session.call('query_ontology', { from: { type: 'ServiceRequest', id: inquiry.taskId }, link: 'networkInquiries' })); assert.equal(origins.items[0]!.ref.id, inquiry.id);
    session.acceptReceipts(session.receipts().filter(receipt => receipt.status === 'ok').map(receipt => receipt.id));
    const snapshot = session.finish(); validatePlanningSnapshot(f.jobs.ontology, f.owner, request, snapshot, true);
    const stored = f.store.get('inquiry', inquiry.id); delete stored.readAdmission; f.store.put('inquiry', stored);
    const legacy = new OntologyPlanningSession(f.jobs.ontology, f.owner, request, [], () => {}, () => {}, 'request');
    assert.equal(queryResult(legacy.call('query_ontology', { object: { type: 'ServiceRequest', id: inquiry.taskId } })).items.length, 1);
    const denied = legacy.call('query_ontology', { from: { type: 'ServiceRequest', id: inquiry.taskId }, link: 'networkInquiries' }); assert.equal((denied as { error: string }).error, 'FORBIDDEN');
    assert.throws(() => validatePlanningSnapshot(f.jobs.ontology, f.owner, request, snapshot, true), code('FORBIDDEN'));
    const normal = f.tasks.submit(f.a.p, { goal: 'An ordinary task', requestId: randomUUID() });
    const graph = f.jobs.ontology.forRequestReader(f.owner, normal.id);
    assert.equal(graph.read(f.owner, { type: 'ServiceRequest', id: normal.id }).ref.id, normal.id);
    assert.throws(() => graph.query(f.owner, { from: { type: 'ServiceRequest', id: normal.id }, link: 'networkInquiries' }), code('FORBIDDEN'));
  } finally { f.close(); }
});

test('read overlays reject mutation, private raw reads and cross-owner replacement; virtual records and links cannot be durably ingested', () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert(), root = { type: 'ServiceRequest', id: inquiry.taskId }, graph = f.jobs.ontology;
    const before = graph.revision(f.owner), rootDigest = graph.relationshipDigest(f.owner, root, { remaining: 1000 });
    const view = graph.forRequestReader(f.owner, inquiry.taskId), virtual = view.query(f.owner, { from: root, link: 'networkInquiries' }).items[0]!;
    assert.equal(view.relationshipDigest(f.owner, root, { remaining: 1000 }), rootDigest, 'Canonical root digests exclude virtual edges');
    const original = graph.read(f.owner, root), attempted = { objects: [{ ref: root, properties: { ...original.properties, originalGoal: 'must not change' }, expectedRevision: original.revision }] };
    assert.throws(() => view.ingest(f.owner, attempted, original.source), code('FORBIDDEN'));
    assert.throws(() => view.readPrivate(f.owner, root), code('FORBIDDEN'));
    assert.throws(() => view.setReadOverlayFactory(() => undefined), code('FORBIDDEN'));
    assert.throws(() => view.read(ownerKey(f.b.p), root), code('FORBIDDEN'));
    assert.throws(() => view.forRequestReader(f.owner, randomUUID()), code('FORBIDDEN'));
    assert.throws(() => graph.ingest(f.owner, { objects: [{ ref: virtual.ref, properties: virtual.properties }] }, virtual.source), code('FORBIDDEN'));
    for (const field of ['links', 'removeLinks'] as const) assert.throws(() => graph.ingest(f.owner, { objects: [], [field]: [{ type: 'NetworkInquiryRequest', from: virtual.ref, to: root }] }, virtual.source), code('FORBIDDEN'));
    assert.equal(graph.revision(f.owner), before); assert.deepEqual(graph.read(f.owner, root), original);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM ontology_objects WHERE type LIKE 'Network%'").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM ontology_links WHERE type LIKE 'Network%'").get()!.n, 0);
    assert.throws(() => graph.query(f.owner, { type: 'NetworkInquiry' }), code('FORBIDDEN'));
  } finally { f.close(); }
});
