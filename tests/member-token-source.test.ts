import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { networkGatewayFixture } from './fixtures/network-gateway.js';
import { memberTokenSource, sourceTokens } from './fixtures/member-token-source.js';
import { SCOPES, ownerKey } from '../packages/core/domain.js';
import { SOURCE_SCOPES, SourceAuthorizationRequired, MemberSourceVault } from '../packages/core/member-source.js';
import { commands } from '../packages/network/contracts.js';
import { createWorker } from '../apps/worker/runtime.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { assertPersonalSourceConfig } from '../packages/core/config.js';
import { PAOTUI_AGENT_REFS } from '../packages/capabilities/paotui-agent.js';
import { paotuiModel, programContext, programRead, quoteChoice, observe, decide, step } from './fixtures/paotui-agent.js';
import { digest } from '../packages/core/delegation.js';
import type { TaskSummary } from '../packages/core/task-summary.js';
const DELIVERY_REQUEST_CAPABILITY = { ref: PAOTUI_AGENT_REFS.quote };
const DELIVERY_REQUEST_BINDING = { ref: { id: 'meituan:delivery.quote', version: PAOTUI_AGENT_REFS.quote.version }, providerId: 'meituan-paotui' };

async function fixture() {
  let source!: ReturnType<typeof memberTokenSource>;
  const f = await networkGatewayFixture(true, true, undefined, false, (config, { dir }) => { source = memberTokenSource(config, dir); });
  const scopes = [...SCOPES, ...SOURCE_SCOPES, 'network:read', 'network:write'];
  const a = await f.makeAgent(f.alice, scopes), b = await f.makeAgent(f.bob, scopes), a2 = await f.makeAgent(f.alice, scopes);
  const call = (path = '', body?: unknown, who = a) => f.call('/sources/meituan-paotui' + path, body, { Authorization: `Bearer ${who.token}` });
  const connect = async (token = sourceTokens.alice, who = a, expectedRevision = 0, ttlMs = 3600000) => {
    const requestId = randomUUID(), expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const begin = await call('/begin', { requestId, expectedRevision }, who); assert.equal(begin.status, 200, await begin.text());
    const body = { requestId, token, expiresAt }, upload = await call('/credential', body, who); assert.equal(upload.status, 200, await upload.clone().text());
    return { body, status: await upload.json() };
  };
  const vault = f.gateway.store.memberSources(source.keyFile, source.directory);
  return { ...f, a, b, a2, source, sourceCall: call, connect, vault };
}
const model = paotuiModel();

test('private source upload binds verified identity and installation; scopes, CAS, replay, expiry and cross-user token reuse fail closed', async () => {
  const f = await fixture();
  try {
    assert.equal((await (await f.sourceCall()).json()).state, 'authorization_required');
    assert.equal((await f.sourceCall('/begin', { requestId: randomUUID(), expectedRevision: 0 }, { ...f.a, token: f.session.token })).status, 401);
    const unscoped = await f.makeAgent(f.alice, [...SCOPES]);
    assert.equal((await f.sourceCall('/begin', { requestId: randomUUID(), expectedRevision: 0 }, unscoped)).status, 403);
    const first = await f.connect(); assert.equal(first.status.credentialValidation, 'not_provider_verified');
    const acknowledged = await f.sourceCall('/begin', { requestId: first.body.requestId, expectedRevision: 0 }); assert.equal(acknowledged.status, 200); assert.equal((await acknowledged.json()).completed, true);
    assert.equal(f.vault.token(f.vault.grant(ownerKey(f.a.p))), sourceTokens.alice);
    assert.equal((await f.sourceCall('/credential', first.body)).status, 200, 'Identical lost-ack retry');
    assert.equal((await f.sourceCall('/credential', first.body, f.b)).status, 404);
    assert.equal((await f.sourceCall('/credential', first.body, f.a2)).status, 403, 'Ticket belongs to the initiating installation');
    const rotated = await f.connect(sourceTokens.rotated, f.a, 1); assert.equal(rotated.status.revision, 2);
    assert.equal((await f.sourceCall('/credential', first.body)).status, 409, 'Old ticket cannot restore the old account');
    assert.equal((await f.sourceCall('/begin', { requestId: randomUUID(), expectedRevision: 1 })).status, 409);
    const reused = randomUUID(); assert.equal((await f.sourceCall('/begin', { requestId: reused, expectedRevision: 0 }, f.b)).status, 200);
    assert.equal((await f.sourceCall('/credential', { ...first.body, requestId: reused }, f.b)).status, 403, 'Retired token fingerprint remains bound to its original member');
    const expired = await f.sourceCall('/credential', { ...rotated.body, expiresAt: '2000-01-01T00:00:00.000Z' }); assert.equal(expired.status, 409);
    assert.equal((await f.sourceCall('/revoke', { expectedRevision: 2 })).status, 200);
    assert.equal((await f.sourceCall('/credential', rotated.body)).status, 403);
    assert.throws(() => f.vault.grant(ownerKey(f.a.p)), SourceAuthorizationRequired);
    assert.equal((await f.sourceCall('/revoke', { expectedRevision: 2 })).status, 200, 'Repeat revoke cannot restore a connection');
    const malicious = await f.sourceCall('/begin', { requestId: randomUUID(), expectedRevision: 3, owner: ownerKey(f.b.p), token: sourceTokens.alice });
    assert.equal(malicious.status, 400); assert(!(await malicious.text()).includes(sourceTokens.alice));
    for (const path of [f.config.DATABASE_PATH, f.config.DATABASE_PATH + '-wal', f.config.EIGOS_AUDIT_PATH!]) if (existsSync(path)) for (const token of Object.values(sourceTokens)) assert(!readFileSync(path).includes(Buffer.from(token)), path);
    assert.equal(f.source.calls().length, 0, 'Credential acceptance never launches a provider read');
  } finally { await f.close(); }
});

test('MCP/A2A with real Worker and stdio transport: two members connect their own credentials and resume their SAME tasks', async () => {
  const f = await fixture(), previous = process.env.PATH; process.env.PATH = f.source.bin + ':' + previous;
  const client = new Client({ name: 'own-source-test', version: '1' });
  let worker: ReturnType<typeof createWorker> | undefined;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.http), { requestInit: { headers: { Authorization: `Bearer ${f.a.token}` } } }));
    const discovered = await client.callTool({ name: 'list_source_connections', arguments: {} }); assert(!discovered.isError); assert(JSON.stringify(discovered).includes('authorization_required'));
    const tools = await client.listTools(); assert(!JSON.stringify(tools).includes('"token"'), 'No secret argument in MCP tools');
    assert(f.gateway.catalog.summaries(ownerKey(f.b.p)).some(c => c.ref.id === 'delivery.quote' && c.sourceAuthorization?.state === 'authorization_required'));
    const jobs = [f.a, f.b].map(who => ({ who, job: f.gateway.tasks.submit(who.p, { goal: '查询一公斤文件普通送费用', requestId: randomUUID() }) }));
    worker = createWorker(f.config, { reasoner: model, timing: { pollMs: 10, leaseMs: 30000, timeoutMs: 30000 } });
    const wait = async (who: typeof f.a, id: string) => {
      const deadline = Date.now() + 30000;
      while (['submitted', 'working'].includes(f.gateway.tasks.get(who.p, id).state) && Date.now() < deadline) await delay(20);
      return f.gateway.tasks.get(who.p, id);
    };
    for (const { who, job } of jobs) { const paused = await wait(who, job.id); assert.equal(paused.state, 'auth-required'); assert.equal(paused.delegation?.sourceAuthorization?.resumeAction, 'resume_source_task'); }
    assert.equal(f.source.calls().length, 0);
    await f.connect(); await f.connect(sourceTokens.bob, f.b);
    for (const { who, job } of jobs) {
      const resume = { taskId: job.id, expectedRevision: job.revision!, requestId: randomUUID() };
      const res = who === f.a ? await client.callTool({ name: 'resume_source_task', arguments: resume }) : await (await f.sourceCall('/resume', resume, who)).json();
      assert(!res.isError); assert(!res.error); const question = await wait(who, job.id); assert.equal(question.state, 'input-required', JSON.stringify(question));
      assert(question.question?.includes(who === f.a ? 'ALICE_PRIVATE_ORIGIN' : 'BOB_PRIVATE_ORIGIN'));
      assert(!question.question?.includes(who === f.a ? 'BOB_PRIVATE' : 'ALICE_PRIVATE'));
      const reply = await f.call('/a2a', { jsonrpc: '2.0', id: 'reply', method: 'SendMessage', params: { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), taskId: job.id, metadata: { expectedRevision: question.revision }, role: 'ROLE_USER', parts: [{ text: '1寄到2，只查价，不下单' }] } } }, { Authorization: `Bearer ${who.token}`, 'A2A-Version': '1.0' });
      assert.equal((await reply.json()).result.task.id, job.id);
      const done = await wait(who, job.id); assert.equal(done.state, 'completed', JSON.stringify(done)); assert(done.delegation?.acceptance?.accepted);
      const text = JSON.stringify(done); assert(text.includes(who === f.a ? '1250' : '2350')); for (const token of Object.values(sourceTokens)) assert(!text.includes(token));
      assert.equal(f.gateway.tasks.list(who.p, { limit: 10, offset: 0 }).total, 1);
    }
    assert(!f.source.calls().some(c => c.command === 'FORBIDDEN_PASSPORT'));
    assert.deepEqual([...new Set(f.source.calls().map(c => c.account))].sort(), ['alice', 'bob']);
    assert.throws(() => f.gateway.tasks.get(f.b.p, jobs[0]!.job.id));
    const unauthorizedReply = await f.sourceCall('/resume', { taskId: jobs[0]!.job.id, expectedRevision: 1, requestId: randomUUID() }, f.b); assert.equal(unauthorizedReply.status, 404);
    assert.equal((await f.sourceCall('/resume', { taskId: jobs[0]!.job.id, expectedRevision: 3, requestId: randomUUID() })).status, 409, 'Completed work is never restarted');
    assert.equal((await f.sourceCall('/revoke', { expectedRevision: 1 })).status, 200);
    const canceled = f.gateway.tasks.submit(f.a.p, { goal: '待授权后取消', requestId: randomUUID() }); assert.equal((await wait(f.a, canceled.id)).state, 'auth-required');
    f.gateway.tasks.cancel(f.a.p, canceled.id); await f.connect(sourceTokens.rotated, f.a, 2);
    assert.equal((await f.sourceCall('/resume', { taskId: canceled.id, expectedRevision: canceled.revision!, requestId: randomUUID() })).status, 409);
    assert.equal(f.gateway.tasks.get(f.a.p, canceled.id).state, 'canceled');
  } finally { await worker?.close(); await client.close(); process.env.PATH = previous; await f.close(); }
});

test('revocation during atomic CLI reads drops output; rotation requires fresh source scope and choices', async () => {
  const f = await fixture(), previous = process.env.PATH; process.env.PATH = f.source.bin + ':' + previous;
  const store = new JobStore(f.config.DATABASE_PATH);
  try {
    await f.connect(); const owner = ownerKey(f.a.p), old = f.vault.grant(owner);
    const catalog = createExecutionCatalog({ store, memberSourceKeyFile: f.source.keyFile, paotuiSkillDirectory: f.source.directory, executionHost: 'worker' });
    const program = catalog.agentProgram(PAOTUI_AGENT_REFS.quote, owner)!, job = f.gateway.tasks.submit(f.a.p, { goal: '查价', requestId: randomUUID() });
    const ctx = programContext(store, owner, job.delegation!.request, program);
    f.source.behavior({ owner, revokeOn: 'get_address_list' }); await assert.rejects(programRead(program, ctx), SourceAuthorizationRequired);
    assert.equal(store.ontology.query(owner, { type: 'PaotuiObservation' }).items.length, 0);
    f.source.behavior({}); await f.connect(sourceTokens.rotated, f.a, 2); assert.throws(() => f.vault.assert(old), /changed/);
    await assert.rejects(programRead(program, ctx), SourceAuthorizationRequired);
    const fresh = programContext(store, owner, job.delegation!.request, program); await programRead(program, fresh);
    const choices = program.clarify!(fresh, '[[saved_addresses]]'); assert(choices.includes('ROTATED_PRIVATE_ORIGIN')); assert(!choices.includes('ALICE_PRIVATE_ORIGIN'));
    f.source.behavior({ failOn: 'get_address_list' }); await assert.rejects(programRead(program, fresh), e => e instanceof Error && Object.values(sourceTokens).every(token => !e.message.includes(token)));
    f.gateway.members.agents.revoke(f.alice.id, f.a.id); assert.throws(() => f.vault.grant(owner), SourceAuthorizationRequired);
    assert.equal(f.source.calls().filter(c => c.command === 'delivery_preview').length, 0);
  } finally { store.close(); process.env.PATH = previous; await f.close(); }
});

for (const rotateToken of [false, true]) test(`input completion and actual source expiry resume ONE task with confirmed choices (different token: ${rotateToken})`, async () => {
  const f = await fixture(), previous = process.env.PATH; process.env.PATH = f.source.bin + ':' + previous;
  let worker: ReturnType<typeof createWorker> | undefined, interpretations = 0;
  const choice = paotuiModel((ctx, access) => {
    if (!ctx.request.messages.some(m => m.text.includes('1寄到2'))) return quoteChoice(ctx, access);
    if (ctx.request.messages.some(m => m.text.includes('重量1公斤'))) return quoteChoice(ctx, access);
    const items = observe(ctx, access);
    if (!items.length) return decide(ctx, [step('book', 'ReadSavedAddresses', { scope: ctx.state.scope })]);
    return { ...decide(ctx), kind: 'clarify', message: '请补充物品重量；寄收地址和普通送已保留。' };
  });
  const ground = choice.ground; choice.ground = async (...args) => { interpretations++; return ground(...args); };
  const wait = async (id: string) => {
    const deadline = Date.now() + 30000;
    while (['submitted', 'working'].includes(f.gateway.tasks.get(f.a.p, id).state) && Date.now() < deadline) await delay(20);
    return f.gateway.tasks.get(f.a.p, id);
  };
  try {
    f.source.behavior({ accountProof: true, sameAccount: true });
    await f.connect();
    const firstGrant = f.vault.grant(ownerKey(f.a.p));
    const originalAccountIdentity = f.vault.accountIdentity(firstGrant, '10001');
    const job = f.gateway.tasks.submit(f.a.p, { goal: '文件普通送查价，先列地址', requestId: randomUUID(), executionBudget: 'extended' });
    worker = createWorker(f.config, { reasoner: choice, timing: { pollMs: 10, leaseMs: 30000, timeoutMs: 30000 } });
    const addressQuestion = await wait(job.id); assert.equal(addressQuestion.state, 'input-required');
    f.gateway.tasks.reply(f.a.p, { taskId: job.id, requestId: randomUUID(), answer: '1寄到2' });
    const weightQuestion = await wait(job.id); assert.equal(weightQuestion.state, 'input-required'); assert(weightQuestion.question?.includes('重量'));
    const renewal = await f.connect(sourceTokens.alice, f.a, 1, 1600);
    assert.equal(f.vault.grant(ownerKey(f.a.p)).selectionContext, firstGrant.selectionContext);
    await delay(Math.max(0, Date.parse(renewal.body.expiresAt) - Date.now() + 20));
    assert.equal((await (await f.sourceCall()).json()).state, 'expired');
    f.gateway.tasks.reply(f.a.p, { taskId: job.id, requestId: randomUUID(), answer: '重量1公斤' });
    const waiting = await wait(job.id); assert.equal(waiting.state, 'auth-required'); assert(waiting.delegation!.suspendedAgent);
    const retainedRuns = waiting.runs!.map(r => r.id), groundingBeforeResume = interpretations;
    await f.connect(rotateToken ? sourceTokens.rotated : sourceTokens.alice, f.a, 2);
    if (rotateToken) assert.notEqual(f.vault.grant(ownerKey(f.a.p)).selectionContext, firstGrant.selectionContext, 'Continuity must be proven by the new authenticated read, not by the upload');
    const resume = { taskId: job.id, expectedRevision: waiting.revision!, requestId: randomUUID() };
    const resumed = await f.sourceCall('/resume', resume); assert.equal(resumed.status, 200); const response = await resumed.json() as TaskSummary;
    const retry = await f.sourceCall('/resume', resume); assert.equal(retry.status, 200, 'An identical retry does not allocate another window');
    const retried = await retry.json() as TaskSummary;
    assert.deepEqual(retried.delegation!.executionBudgetStatus!.window, response.delegation!.executionBudgetStatus!.window, 'The public retry reports the same execution window');
    const done = await wait(job.id); assert.equal(done.state, 'completed', JSON.stringify(done)); assert.equal(done.id, job.id);
    assert.equal(interpretations, groundingBeforeResume, 'A credential-only continuation retains the validated interpretation');
    assert.deepEqual(done.runs!.slice(0, retainedRuns.length).map(r => r.id), retainedRuns);
    assert.deepEqual(done.delegation!.executionBudget!.window, response.delegation!.executionBudgetStatus!.window, 'The public execution window matches the stored task ledger');
    assert.equal(Object.hasOwn(response.delegation!, 'executionBudget'), false, 'Internal execution state is not restored to the public response');
    assert.equal(done.messages.filter(m => m.role === 'agent' && m.text.includes('本人保存地址')).length, 1, 'No repeated address confirmation');
    assert.equal(f.gateway.tasks.list(f.a.p, { limit: 10, offset: 0 }).total, 1);
    assert.equal(f.source.calls().filter(c => c.command === 'delivery_preview').length, 1);
    const books = done.delegation!.agent!.observations.map(ref => f.gateway.store.ontology.readPrivate(ownerKey(f.a.p), ref).properties.privateSnapshot as any).filter(o => o.action === 'ReadSavedAddresses');
    assert(books.length > 0 && books.every(o => o.result.accountIdentity === originalAccountIdentity));
    assert(!JSON.stringify(done).includes(originalAccountIdentity), 'Account correlation remains in private source evidence');
    assert(f.gateway.store.intents(ownerKey(f.a.p), job.id).every(i => i.state === 'effect_confirmed'), 'Confirmed historical reads remain confirmed');
    assert(done.delegation!.acceptance!.accepted);
  } finally { await worker?.close(); process.env.PATH = previous; await f.close(); }
});

test('credential renewal preserves legacy choice context; credential replacement, installation change and revoke isolate it', async () => {
  const f = await fixture();
  try {
    await f.connect(); const owner = ownerKey(f.a.p), db = new DatabaseSync(f.config.DATABASE_PATH);
    let legacyDigest: string;
    try {
      const row = JSON.parse(String(db.prepare('SELECT body FROM member_source_credentials WHERE owner=?').get(owner)!.body));
      const grant = f.vault.grant(owner); delete grant.selectionContext; delete row.selectionContext; delete grant.authorizationEpoch; delete row.authorizationEpoch;
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', readFileSync(f.source.keyFile), iv);
      cipher.setAAD(Buffer.from(digest({ grant, expiresAt: row.expiresAt, fingerprint: row.fingerprint })));
      row.ciphertext = Buffer.concat([cipher.update(sourceTokens.alice, 'utf8'), cipher.final()]).toString('base64'); row.iv = iv.toString('base64'); row.tag = cipher.getAuthTag().toString('base64');
      db.prepare('UPDATE member_source_credentials SET body=? WHERE owner=?').run(JSON.stringify(row), owner); legacyDigest = digest(grant);
    } finally { db.close(); }
    assert.equal(f.vault.token(f.vault.grant(owner)), sourceTokens.alice, 'Pre-change encrypted credentials still decrypt');
    await f.connect(sourceTokens.alice, f.a, 1); const renewed = f.vault.grant(owner); assert.equal(renewed.selectionContext, legacyDigest);
    await f.connect(sourceTokens.alice, f.a, 2); assert.equal(f.vault.grant(owner).selectionContext, renewed.selectionContext);
    await f.connect(sourceTokens.rotated, f.a, 3); const replaced = f.vault.grant(owner); assert.notEqual(replaced.selectionContext, renewed.selectionContext);
    assert.equal(replaced.authorizationEpoch, renewed.authorizationEpoch, 'Different tokens may compare trusted provider identities within the same authorization');
    await f.connect(sourceTokens.rotated, f.a2, 4); const otherInstallation = f.vault.grant(owner); assert.notEqual(otherInstallation.selectionContext, replaced.selectionContext);
    assert.notEqual(otherInstallation.authorizationEpoch, replaced.authorizationEpoch);
    assert.equal((await f.sourceCall('/revoke', { expectedRevision: 5 }, f.a2)).status, 200);
    await f.connect(sourceTokens.rotated, f.a2, 6); assert.notEqual(f.vault.grant(owner).selectionContext, otherInstallation.selectionContext);
    assert.notEqual(f.vault.grant(owner).authorizationEpoch, otherInstallation.authorizationEpoch);
    assert.equal(f.source.calls().length, 0, 'Connection lifecycle and identity checks never call the supplier');
  } finally { await f.close(); }
});

test('vault authentication detects modified ciphertext and private key permissions; HTTP rejects browser token uploads', async () => {
  const f = await fixture();
  try {
    const upload = await f.connect(); const owner = ownerKey(f.a.p), grant = f.vault.grant(owner);
    for (const changed of [{ HOST: '0.0.0.0' }, { PUBLIC_URL: 'https://public.test' }, { PUBLIC_URL: 'http://localhost' }, { EIGOS_NETWORK_ENABLED: 'false' as const }, { EIGOS_AUTH_MODE: 'development' as const }, { EIGOS_PAOTUI_MEMBER_CONNECTION_FILE: '/private/legacy.json' }, { EIGOS_MEMBER_SOURCE_KEY_FILE: 'relative.key' }]) assert.throws(() => assertPersonalSourceConfig({ ...f.config, ...changed }));
    assert.throws(() => assertPersonalSourceConfig(f.config, 'production'));
    chmodSync(f.source.keyFile, 0o644); assert.throws(() => f.vault.token(grant)); chmodSync(f.source.keyFile, 0o600);
    const originalKey = readFileSync(f.source.keyFile); writeFileSync(f.source.keyFile, Buffer.alloc(32));
    assert.throws(() => f.vault.token(grant));
    assert.throws(() => f.gateway.store.memberSources(f.source.keyFile, f.source.directory));
    writeFileSync(f.source.keyFile, originalKey);
    assert.throws(() => f.gateway.store.memberSources(f.source.keyFile, f.source.bin), 'Different Gateway/Worker reader directory cannot share a vault');
    const db = new DatabaseSync(f.config.DATABASE_PATH);
    try {
      const row = db.prepare('SELECT body FROM member_source_credentials WHERE owner=?').get(owner)!; const body = JSON.parse(String(row.body)); body.tag = Buffer.alloc(16).toString('base64');
      db.prepare('UPDATE member_source_credentials SET body=? WHERE owner=?').run(JSON.stringify(body), owner);
    } finally { db.close(); }
    assert.throws(() => f.vault.token(grant), /unavailable/);
    const response = await f.call('/sources/meituan-paotui/credential', upload.body, { Authorization: `Bearer ${f.a.token}`, Origin: f.origin }); assert.equal(response.status, 403);
    assert(!(await response.text()).includes(sourceTokens.alice));
  } finally { await f.close(); }
});

test('a visible network listing asks the buyer for their own connection and converts into the buyer-owned task before authorization', async () => {
  const f = await fixture();
  try {
    const { profileId } = await f.init(), session = f.gateway.members.createSession(f.bob.id);
    const bobControl = (input: object) => f.call('/members/network/commands', { version: 1, requestId: randomUUID(), _csrf: session.csrf, ...input }, { Cookie: `__Host-eigos-member=${session.token}`, Origin: f.origin });
    const rep = await f.command(profileId, { operation: 'representation.request', providerId: DELIVERY_REQUEST_BINDING.providerId, role: 'aggregator', capabilityRefs: [DELIVERY_REQUEST_CAPABILITY.ref], note: 'Synthetic per-user connection test' }); assert.equal(rep.status, 200);
    const representationId = (await rep.json()).refs[0].id;
    assert.equal((await bobControl({ action: 'representation.review', representationId, expectedRevision: 1, decision: 'verified', proofRef: 'fixture', validUntil: new Date(Date.now() + 3600000).toISOString() })).status, 200);
    const listing = await f.command(profileId, { operation: 'listing.create', representationId, capabilityRef: DELIVERY_REQUEST_CAPABILITY.ref, details: { title: 'Own-account quote', description: 'Each buyer connects their own source', coarseAreas: ['110105'] } }); assert.equal(listing.status, 200); const listingId = (await listing.json()).refs[0].id;
    assert.equal((await f.command(profileId, { operation: 'listing.submit_review', listingId, expectedRevision: 1 })).status, 200);
    assert.equal((await bobControl({ action: 'listing.review', listingId, expectedRevision: 2, decision: 'approved', bindingRef: DELIVERY_REQUEST_BINDING.ref })).status, 200);
    const bp = await bobControl({ action: 'profile.create', displayName: 'Buyer PA' }); assert.equal(bp.status, 200); const buyer = (await bp.json()).refs[0].id;
    assert.equal((await bobControl({ action: 'profile.bind_installation', profileId: buyer, installationId: f.b.id, allowedCommands: [...commands] })).status, 200);
    const publish = async (content: object, bob = false) => {
      const command = (input: object) => bob ? f.command(buyer, input, f.b.token) : f.command(profileId, input), control = bob ? bobControl : f.control;
      const d = await command({ operation: 'draft.create', content }); assert.equal(d.status, 200); const draftId = (await d.json()).refs[0].id;
      const asked = await command({ operation: 'publication.request_approval', draftId, expectedRevision: 1, recipientMemberIds: [f.alice.id, f.bob.id], publishBefore: new Date(Date.now() + 600000).toISOString(), visibleUntil: new Date(Date.now() + 3600000).toISOString() }); assert.equal(asked.status, 200); const a = (await asked.json()).result[0];
      const grant = await control({ action: 'publication.approve', approvalRequestId: a.id, expectedDraftRevision: 1, reviewDigest: a.reviewDigest }); assert.equal(grant.status, 200);
      const p = await command({ operation: 'publication.publish', draftId, expectedRevision: 1, grantId: (await grant.json()).refs[0].id }); assert.equal(p.status, 200); return (await p.json()).refs[0].id;
    };
    const listingPublicationId = await publish({ kind: 'listing', listingId, listingRevision: 3 });
    const postId = await publish({ kind: 'need', body: { title: 'Own quote', safeGoal: 'Query only', category: 'delivery', coarseArea: '110105', replyDeadline: new Date(Date.now() + 7200000).toISOString() } }, true);
    const readListing = async () => (await (await f.api('query', { version: 1, kind: 'get', publicationId: listingPublicationId }, f.b.token)).json()).capabilityState;
    assert.equal((await readListing()).mode, 'requires_own_authorization');
    const requested = await f.command(buyer, { operation: 'inquiry.request_conversion', input: { postId, expectedPostRevision: 1, listing: { publicationId: listingPublicationId, revision: 1 }, request: { kind: 'create', buyerGoal: '查价', completionTarget: 'quote_only' } } }, f.b.token);
    assert.equal(requested.status, 200); const choice = f.gateway.network!.store.get('choice', (await requested.json()).refs[0].id);
    assert.equal((await bobControl({ action: 'inquiry.approve_choice', choiceId: choice.id, expectedRevision: 1, reviewDigest: choice.reviewDigest })).status, 200);
    const converted = await f.command(buyer, { operation: 'inquiry.convert', choiceId: choice.id }, f.b.token); assert.equal(converted.status, 200); const id = (await converted.json()).result[0].taskId;
    assert.equal(f.gateway.tasks.get(f.b.p, id).id, id); assert.throws(() => f.gateway.tasks.get(f.a.p, id));
    await f.connect(sourceTokens.bob, f.b); assert.equal((await readListing()).candidateEligible, true);
    assert.equal(f.vault.status(ownerKey(f.a.p)).state, 'authorization_required', 'Publisher never lent a credential');
    assert.equal(f.source.calls().length, 0, 'Gateway discovers and binds, never executes queries');
  } finally { await f.close(); }
});

test('credential and upload expiry, pending-ticket revocation and persisted member fences remain effective after reopening', async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.config.DATABASE_PATH);
  try {
    const pending = randomUUID(); assert.equal((await f.sourceCall('/begin', { requestId: pending, expectedRevision: 0 })).status, 200);
    assert.equal((await f.sourceCall('/revoke', { expectedRevision: 0 })).status, 200);
    assert.equal((await f.sourceCall('/credential', { requestId: pending, token: sourceTokens.alice, expiresAt: new Date(Date.now() + 60000).toISOString() })).status, 403);
    const id = randomUUID(); assert.equal((await f.sourceCall('/begin', { requestId: id, expectedRevision: 0 })).status, 200);
    for (const expiresAt of ['2000-01-01T00:00:00.000Z', new Date(Date.now() + 172800000).toISOString()]) assert.equal((await f.sourceCall('/credential', { requestId: id, token: sourceTokens.alice, expiresAt })).status, 400);
    const ticket = JSON.parse(String(db.prepare('SELECT body FROM member_source_requests WHERE id=?').get(id)!.body)); ticket.expiresAt = 1;
    db.prepare('UPDATE member_source_requests SET body=? WHERE id=?').run(JSON.stringify(ticket), id);
    assert.equal((await f.sourceCall('/credential', { requestId: id, token: sourceTokens.alice, expiresAt: new Date(Date.now() + 60000).toISOString() })).status, 403);
    await f.connect(); const owner = ownerKey(f.a.p), reopened = new MemberSourceVault(db, f.source.keyFile, f.source.directory);
    assert.equal(reopened.token(reopened.grant(owner)), sourceTokens.alice);
    const future = new MemberSourceVault(db, f.source.keyFile, f.source.directory, () => Date.now() + 3600001); assert.equal(future.status(owner).state, 'expired'); assert.throws(() => future.grant(owner), SourceAuthorizationRequired);
    f.gateway.members.setStatus(f.alice.id, 'suspended'); assert.equal(reopened.status(owner).state, 'unavailable');
    f.gateway.members.setStatus(f.alice.id, 'active'); assert.throws(() => reopened.grant(owner), SourceAuthorizationRequired);
  } finally { db.close(); await f.close(); }
});

test('Worker pauses a started agent task on source revocation and resumes it with a new scope without replaying the old plan', async () => {
  const f = await fixture(), previous = process.env.PATH; process.env.PATH = f.source.bin + ':' + previous;
  let worker: ReturnType<typeof createWorker> | undefined;
  try {
    await f.connect(); const owner = ownerKey(f.a.p), job = f.gateway.tasks.submit(f.a.p, { goal: '查询1公斤文件普通送费用', requestId: randomUUID() });
    f.source.behavior({ owner, revokeOn: 'get_address_list' });
    worker = createWorker(f.config, { reasoner: model, timing: { pollMs: 10, leaseMs: 30000, timeoutMs: 30000 } });
    const settle = async () => { const deadline = Date.now() + 30000; while (['working', 'submitted'].includes(f.gateway.tasks.get(f.a.p, job.id).state) && Date.now() < deadline) await delay(20); return f.gateway.tasks.get(f.a.p, job.id); };
    const paused = await settle(); assert.equal(paused.state, 'auth-required', JSON.stringify(paused)); assert(paused.delegation!.agent);
    assert.equal(paused.delegation!.agent!.observations.length, 0); const oldScope = paused.delegation!.agent!.scope;
    assert.equal(f.gateway.store.intents(owner, job.id).filter(i => i.state === 'rejected').length, 1);
    f.source.behavior({}); await f.connect(sourceTokens.rotated, f.a, 2);
    const resume = await f.sourceCall('/resume', { taskId: job.id, expectedRevision: paused.revision, requestId: randomUUID() }); assert.equal(resume.status, 200);
    const asked = await settle(); assert.equal(asked.state, 'input-required', JSON.stringify(asked)); assert(asked.question?.includes('ROTATED_PRIVATE_ORIGIN')); assert(!asked.question?.includes('ALICE_PRIVATE_ORIGIN'));
    assert.notDeepEqual(asked.delegation!.agent!.scope, oldScope); assert.equal(asked.delegation!.agentHistory!.length, 1);
    assert.deepEqual(f.source.calls().map(c => [c.command, c.account]), [['get_address_list', 'alice'], ['get_address_list', 'rotated']]);
    f.gateway.tasks.reply(f.a.p, { taskId: job.id, requestId: randomUUID(), answer: '1寄到2' });
    const done = await settle(); assert.equal(done.state, 'completed', JSON.stringify(done)); assert.equal(done.id, job.id); assert.equal(f.source.calls().filter(c => c.command === 'delivery_preview').length, 1);
    assert.equal(done.delegation!.agentHistory!.length, 2, 'Budgets and abandoned plans remain auditable');
  } finally { await worker?.close(); process.env.PATH = previous; await f.close(); }
});
