import { commands } from '../packages/network/contracts.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, symlinkSync, unlinkSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { networkGatewayFixture } from './fixtures/network-gateway.js';
import { personalSourceFixture } from './fixtures/personal-source.js';
import { readConfig } from '../packages/core/config.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { PersonalSourceAccess, readPersonalSource, personalSourceActive } from '../packages/core/personal-source.js';
import { ownerKey } from '../packages/core/domain.js';
import { createWorker } from '../apps/worker/runtime.js';
import { setTimeout as delay } from 'node:timers/promises';
import { interpretation, reasoner, proposal } from './backend-fixture.js';
import { DELIVERY_REQUEST_CAPABILITY, DELIVERY_REQUEST_BINDING } from '../packages/capabilities/paotui-request.js';

async function fixture() {
  let source!: ReturnType<typeof personalSourceFixture>;
  const f = await networkGatewayFixture(true, true, undefined, false, (config, context) => { source = personalSourceFixture(config, context); });
  const workerStore = new JobStore(f.config.DATABASE_PATH);
  const workerCatalog = () => createExecutionCatalog({ store: workerStore, paotuiSkillDirectory: source.directory, paotuiMemberConnectionFile: source.connectionFile, executionHost: 'worker' });
  return { ...f, source, workerStore, workerCatalog, close: async () => { workerStore.close(); await f.close(); } };
}
const signal = () => new AbortController().signal;
const request = () => ({ id: randomUUID(), revision: 1, originalGoal: '只查价', requirements: [], messages: [] });
const missing = { sender: null, recipient: null, goodsName: '文件', category: '文件', weightKg: 1, service: 'ordinary' };

test('member source is exact-owner only on discovery, direct adapter calls and Worker; Gateway never launches the reader', async () => {
  const f = await fixture(); const previousPath = process.env.PATH; process.env.PATH = f.source.bin + ':' + previousPath;
  try {
    const owner = ownerKey(f.a.p), other = ownerKey(f.b.p), catalog = f.workerCatalog();
    assert(catalog.summaries(owner).some(c => c.ref.id === 'delivery.quote'));
    assert(!catalog.summaries(other).some(c => c.ref.id === 'delivery.quote'));
    assert(!catalog.summaries(JSON.stringify(['local-development', 'local', 'developer'])).some(c => c.ref.id === 'delivery.quote'));
    assert(!catalog.summaries(owner).some(c => c.ref.id === 'geo.search'), 'No public query permission added');
    assert.throws(() => catalog.binding(DELIVERY_REQUEST_BINDING.ref, other));
    const adapter = catalog.binding(DELIVERY_REQUEST_BINDING.ref, owner).adapter;
    await assert.rejects(adapter.prepare({ owner: other, request: request() }, missing, signal()));
    const job = f.gateway.tasks.submit(f.a.p, { goal: '仅查询一公斤文件普通送', requestId: randomUUID() });
    await assert.rejects(f.gateway.catalog.binding(DELIVERY_REQUEST_BINDING.ref, owner).adapter.prepare({ owner, request: job.delegation!.request }, missing, signal()), /only in the Worker/);
    assert.equal(f.source.calls().length, 0);
    const prepared = await adapter.prepare({ owner, request: job.delegation!.request }, missing, signal());
    assert.equal(prepared.kind, 'needs_input'); if (prepared.kind === 'needs_input') assert(prepared.question.includes('PRIVATE_TEST_ORIGIN'));
    assert.deepEqual(f.source.calls().map(c => c.command), ['passport', 'get_address_list']);
    const serialized = JSON.stringify(f.gateway.tasks.get(f.a.p, job.id)); assert(!serialized.includes('TEST_ONLY_SECRET')); assert(!serialized.includes(f.source.connectionFile));
    const foreignTask = f.gateway.tasks.submit(f.b.p, { goal: 'Borrow Alice credential', requestId: randomUUID() });
    await assert.rejects(adapter.prepare({ owner: other, request: foreignTask.delegation!.request }, missing, signal()));
    assert.equal(f.source.calls().length, 2);
  } finally { process.env.PATH = previousPath; await f.close(); }
});

test('actual stdio transport rejects revoked or changed connections and drops a result revoked inside the CLI', async () => {
  const f = await fixture(); const previousPath = process.env.PATH; process.env.PATH = f.source.bin + ':' + previousPath;
  try {
    const owner = ownerKey(f.a.p), catalog = f.workerCatalog(), adapter = catalog.binding(DELIVERY_REQUEST_BINDING.ref, owner).adapter;
    const job = f.gateway.tasks.submit(f.a.p, { goal: '仅查询', requestId: randomUUID() });
    f.source.behavior({ revokeOn: 'get_address_list' });
    await assert.rejects(adapter.prepare({ owner, request: job.delegation!.request }, missing, signal()), /Ontology MCP read failed/);
    assert.equal(f.source.calls().filter(c => c.command === 'delivery_preview').length, 0);
    assert.equal(f.workerStore.preparationContext(owner, job.id, `delivery-addresses:${catalog.configuredBinding(DELIVERY_REQUEST_BINDING.ref)!.configurationDigest}`), undefined);
    assert(!adapter.permitted(owner));
    await assert.rejects(adapter.prepare({ owner, request: job.delegation!.request }, missing, signal()));
    assert.equal(f.source.calls().length, 2);
    f.source.write({ ...f.source.connection, owner: { ...f.source.connection.owner, subject: f.b.p.subject } });
    assert(!adapter.permitted(owner)); assert(!f.workerCatalog().summaries(ownerKey(f.b.p)).some(c => c.ref.id === 'delivery.quote'), 'Changed owner requires fresh Gateway identity validation');
  } finally { process.env.PATH = previousPath; await f.close(); }
});

test('member suspension is observed through the existing durable fence in a separate Worker database connection', async () => {
  const f = await fixture(); try {
    const owner = ownerKey(f.a.p), adapter = f.workerCatalog().binding(DELIVERY_REQUEST_BINDING.ref, owner).adapter;
    f.gateway.members.setStatus(f.alice.id, 'suspended');
    assert(!adapter.permitted(owner));
    await assert.rejects(adapter.prepare({ owner, request: request() }, missing, signal()));
    assert.equal(f.source.calls().length, 0);
    f.gateway.members.setStatus(f.alice.id, 'active'); assert(!adapter.permitted(owner), 'Reapproval does not silently clear the durable revocation');
  } finally { await f.close(); }
});

test('private connection files fail closed for malformed, world-readable, symlinked, expired, missing or unadmitted metadata', async () => {
  const f = await fixture(); try {
    const access = new PersonalSourceAccess(f.source.connectionFile, (c, hash) => f.workerStore.personalSourceAdmitted(c, hash), f.source.directory), owner = ownerKey(f.a.p);
    assert(access.permitted(owner));
    const changedDirectory = new PersonalSourceAccess(f.source.connectionFile, (c, hash) => f.workerStore.personalSourceAdmitted(c, hash), f.source.bin);
    assert(!changedDirectory.permitted(owner), 'Worker cannot substitute a different reader directory');
    assert(!personalSourceActive(f.source.connection, Date.parse(f.source.connection.expiresAt)));
    chmodSync(f.source.connectionFile, 0o644); assert(!access.permitted(owner)); chmodSync(f.source.connectionFile, 0o600);
    f.source.write({ ...f.source.connection, credential: 'member_supplied_token', token: 'TEST_ONLY_SECRET' }); assert(!access.permitted(owner));
    assert.throws(() => readPersonalSource(f.source.connectionFile), e => e instanceof Error && !e.message.includes('TEST_ONLY_SECRET'));
    f.source.write({ ...f.source.connection, expiresAt: '2000-01-01T00:00:00.000Z' }); assert(!access.permitted(owner));
    f.source.write(f.source.connection); const link = f.source.connectionFile + '.link'; symlinkSync(f.source.connectionFile, link); assert.throws(() => readPersonalSource(link)); unlinkSync(link);
    f.gateway.store.admitPersonalSource(); assert(!access.permitted(owner));
    unlinkSync(f.source.connectionFile); assert(!access.permitted(owner));
  } finally { await f.close(); }
});

test('JWT personal source requires the explicit single-member bridge; public or legacy shared credential configurations remain denied', () => {
  const memberId = randomUUID();
  const env = { EIGOS_AUTH_MODE: 'jwt', PUBLIC_URL: 'https://localhost', OAUTH_ISSUER: 'https://issuer.test', OAUTH_JWKS_URL: 'https://issuer.test/jwks', OAUTH_AUDIENCE: 'https://localhost', OIDC_CLIENT_ID: 'browser', OIDC_AGENT_CLIENT_ID: 'agent', EIGOS_NETWORK_ENABLED: 'true', EIGOS_NETWORK_MEMBER_IDS: JSON.stringify([memberId]), DATABASE_PATH: '/tmp/member-source-config.sqlite', EIGOS_PAOTUI_SKILL_DIR: '/private/skill' };
  assert.throws(() => readConfig(env));
  const enabled = { ...env, EIGOS_PAOTUI_MEMBER_CONNECTION_FILE: '/private/connection.json' };
  assert.equal(readConfig(enabled).EIGOS_PAOTUI_MEMBER_CONNECTION_FILE, enabled.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE);
  for (const changed of [{ HOST: '0.0.0.0' }, { PUBLIC_URL: 'https://public.test' }, { EIGOS_NETWORK_ENABLED: 'false' }, { EIGOS_AUTH_MODE: 'development' }, { NODE_ENV: 'production' }, { EIGOS_PAOTUI_ORDERS_ENABLED: 'true' }, { EIGOS_PAOTUI_MEMBER_CONNECTION_FILE: 'relative.json' }, { EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES: '[{"city":"北京市","keyword":"天安门"}]' }]) assert.throws(() => readConfig({ ...enabled, ...changed }));
});

test('JWT network inquiry uses the existing real reader path, preserves one Task across MCP/A2A, and never lends its source to another member', async () => {
  const f = await fixture(); const previousPath = process.env.PATH; process.env.PATH = f.source.bin + ':' + previousPath;
  const client = new Client({ name: 'member-source-test', version: '1' });
  let worker: ReturnType<typeof createWorker> | undefined;
  try {
    const { profileId } = await f.init(), bs = f.gateway.members.createSession(f.bob.id);
    const bobControl = (input: object) => f.call('/members/network/commands', { version: 1, requestId: randomUUID(), _csrf: bs.csrf, ...input }, { Cookie: `__Host-eigos-member=${bs.token}`, Origin: f.origin });
    const rep = await f.command(profileId, { operation: 'representation.request', providerId: DELIVERY_REQUEST_BINDING.providerId, role: 'aggregator', capabilityRefs: [DELIVERY_REQUEST_CAPABILITY.ref], note: 'Synthetic connection integration' });
    assert.equal(rep.status, 200); const representationId = (await rep.json()).refs[0].id;
    assert.equal((await bobControl({ action: 'representation.review', representationId, expectedRevision: 1, decision: 'verified', proofRef: 'fixture', validUntil: new Date(Date.now() + 3600000).toISOString() })).status, 200);
    const listing = await f.command(profileId, { operation: 'listing.create', representationId, capabilityRef: DELIVERY_REQUEST_CAPABILITY.ref, details: { title: 'Member-owned delivery lookup', description: 'Fixture identity only', coarseAreas: ['110105'] } }); assert.equal(listing.status, 200); const listingId = (await listing.json()).refs[0].id;
    assert.equal((await f.command(profileId, { operation: 'listing.submit_review', listingId, expectedRevision: 1 })).status, 200);
    assert.equal((await bobControl({ action: 'listing.review', listingId, expectedRevision: 2, decision: 'approved', bindingRef: DELIVERY_REQUEST_BINDING.ref })).status, 200);
    const bp = await bobControl({ action: 'profile.create', displayName: 'Other member' }); assert.equal(bp.status, 200); const bobProfile = (await bp.json()).refs[0].id;
    assert.equal((await bobControl({ action: 'profile.bind_installation', profileId: bobProfile, installationId: f.b.id, allowedCommands: [...commands] })).status, 200);
    const publish = async (content: object, forBob = false) => {
      const command = (input: object) => f.command(forBob ? bobProfile : profileId, input, forBob ? f.b.token : f.a.token);
      const control = forBob ? bobControl : f.control;
      const d = await command({ operation: 'draft.create', content }); assert.equal(d.status, 200); const draftId = (await d.json()).refs[0].id;
      const r = await command({ operation: 'publication.request_approval', draftId, expectedRevision: 1, recipientMemberIds: [f.alice.id, f.bob.id], publishBefore: new Date(Date.now() + 600000).toISOString(), visibleUntil: new Date(Date.now() + 3600000).toISOString() }); assert.equal(r.status, 200); const a = (await r.json()).result[0];
      const grant = await control({ action: 'publication.approve', approvalRequestId: a.id, expectedDraftRevision: 1, reviewDigest: a.reviewDigest }); assert.equal(grant.status, 200);
      const pub = await command({ operation: 'publication.publish', draftId, expectedRevision: 1, grantId: (await grant.json()).refs[0].id }); assert.equal(pub.status, 200); return (await pub.json()).refs[0].id;
    };
    const listingPublicationId = await publish({ kind: 'listing', listingId, listingRevision: 3 });
    const postId = await publish({ kind: 'need', body: { title: 'Read-only delivery', safeGoal: 'Only quote', category: 'delivery', coarseArea: '110105', replyDeadline: new Date(Date.now() + 7200000).toISOString() } });
    const visible = await f.api('query', { version: 1, kind: 'get', publicationId: listingPublicationId }, f.b.token); assert.equal(visible.status, 200);
    assert.equal((await visible.json()).capabilityState.candidateEligible, false, 'Seeing a listing never grants its personal credential');
    const bobPost = await publish({ kind: 'need', body: { title: 'Other member need', safeGoal: 'Only quote', category: 'delivery', coarseArea: '110105', replyDeadline: new Date(Date.now() + 7200000).toISOString() } }, true);
    const borrowed = await f.command(bobProfile, { operation: 'inquiry.request_conversion', input: { postId: bobPost, expectedPostRevision: 1, listing: { publicationId: listingPublicationId, revision: 1 }, request: { kind: 'create', buyerGoal: 'Use the listed source', completionTarget: 'quote_only' } } }, f.b.token);
    assert.equal(borrowed.status, 409); assert.equal((await borrowed.json()).error.code, 'SOURCE_NOT_AVAILABLE');
    assert.equal(f.source.calls().length, 0);

    const chosen = await f.command(profileId, { operation: 'inquiry.request_conversion', input: { postId, expectedPostRevision: 1, listing: { publicationId: listingPublicationId, revision: 1 }, request: { kind: 'create', buyerGoal: '只查询1公斤文件普通送运费，先让我选地址', completionTarget: 'quote_only' } } });
    assert.equal(chosen.status, 200); const choice = f.gateway.network!.store.get('choice', (await chosen.json()).refs[0].id);
    assert.equal((await f.control({ action: 'inquiry.approve_choice', choiceId: choice.id, expectedRevision: 1, reviewDigest: choice.reviewDigest })).status, 200);
    const converted = await f.command(profileId, { operation: 'inquiry.convert', choiceId: choice.id }); assert.equal(converted.status, 200); const taskId = (await converted.json()).result[0].taskId;
    assert.equal(f.source.calls().length, 0, 'Gateway only admitted the source and created the private task');
    const model = reasoner(r => ({ ...interpretation(r, 'delivery.quote', { ...missing, ...(r.revision > 1 ? { sender: '地址1', recipient: '地址2' } : {}) }), capabilityRef: DELIVERY_REQUEST_CAPABILITY.ref }), ctx => {
      assert(!JSON.stringify(ctx).includes('PRIVATE_TEST_ORIGIN')); assert(!JSON.stringify(ctx).includes('TEST_ONLY_SECRET')); return proposal(ctx);
    });
    worker = createWorker(f.config, { store: f.workerStore, reasoner: model, timing: { leaseMs: 30000, pollMs: 10, timeoutMs: 30000 } });
    const run = async () => {
      const deadline = Date.now() + 30000;
      while (['working', 'submitted'].includes(f.gateway.tasks.get(f.a.p, taskId).state) && Date.now() < deadline) await delay(25);
      assert(!['working', 'submitted'].includes(f.gateway.tasks.get(f.a.p, taskId).state), 'Worker must reach an observable state');
    };
    await run(); assert.equal(f.gateway.tasks.get(f.a.p, taskId).state, 'input-required');
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.http), { requestInit: { headers: { Authorization: `Bearer ${f.a.token}` } } }));
    const asked = await client.callTool({ name: 'get_task', arguments: { taskId } }); assert(!asked.isError); assert(JSON.stringify(asked).includes('PRIVATE_TEST_ORIGIN'));
    const denied = await f.call('/a2a', { jsonrpc: '2.0', id: 'foreign', method: 'GetTask', params: { id: taskId } }, { Authorization: `Bearer ${f.b.token}`, 'A2A-Version': '1.0' }); assert((await denied.json()).error);
    const reply = await f.call('/a2a', { jsonrpc: '2.0', id: 'reply', method: 'SendMessage', params: { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), taskId, role: 'ROLE_USER', parts: [{ text: '1寄到2，只查价，不下单' }] } } }, { Authorization: `Bearer ${f.a.token}`, 'A2A-Version': '1.0' });
    assert.equal((await reply.json()).result.task.id, taskId); await run();
    const done = f.gateway.tasks.get(f.a.p, taskId); assert.equal(done.state, 'completed'); assert(done.delegation?.acceptance?.accepted);
    assert.equal((done.artifact!.data.result as { ontologyReceipt: { sourceConnectionDigest?: string } }).ontologyReceipt.sourceConnectionDigest?.length, 64);
    assert.equal(f.source.calls().filter(c => c.command === 'delivery_preview').length, 2);
    assert.equal(f.gateway.store.list(ownerKey(f.a.p), { limit: 20, offset: 0 }).total, 1);
    assert.equal(f.gateway.store.list(ownerKey(f.b.p), { limit: 20, offset: 0 }).total, 0);
    const readback = await client.callTool({ name: 'get_task', arguments: { taskId } }); assert(!readback.isError); assert(JSON.stringify(readback).includes('12.50'));
    for (const secret of ['TEST_ONLY_SECRET_NEVER_PERSIST', f.source.connectionFile, f.source.directory]) assert(!JSON.stringify(readback).includes(secret));
    assert(!readFileSync(f.config.DATABASE_PATH).includes(Buffer.from('TEST_ONLY_SECRET_NEVER_PERSIST')));
    assert(f.gateway.tasks.queryOntology(f.a.p, { type: 'DeliveryQuote' }).items.length > 0);
    assert.equal(f.gateway.tasks.queryOntology(f.b.p, { type: 'DeliveryQuote' }).items.length, 0);
  } finally { await worker?.close(); await client.close(); process.env.PATH = previousPath; await f.close(); }
});

test('Gateway refuses an operator record whose member ID and authenticated owner do not match', async () => {
  for (const change of ['subject', 'memberId'] as const) {
    await assert.rejects(networkGatewayFixture(true, true, undefined, false, (config, context) => {
      const source = personalSourceFixture(config, context);
      source.write(change === 'subject' ? { ...source.connection, owner: { ...source.connection.owner, subject: context.bob.subject } } : { ...source.connection, memberId: context.bob.id });
    }), /exact active enrolled member/);
  }
});
