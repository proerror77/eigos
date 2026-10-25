import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { Worker } from '../apps/worker/worker.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { DIDI_PROGRAM_REF } from '../packages/capabilities/didi/program.js';
import { DidiMemberAccess, readDidiMemberConnection, type DidiMemberConnection } from '../packages/core/didi-source.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { ownerKey, SCOPES, type Job, type Principal } from '../packages/core/domain.js';
import { JobStore } from '../packages/core/store.js';
import { MemberStore } from '../packages/members/store.js';
import { createCompositionKernelDefinition } from '../packages/ontology/seed-definition.js';
import { normalizeOntologyDocument } from '../packages/ontology/model-compiler.js';
import { digest } from '../packages/core/delegation.js';
import { didiFixture, didiModel, syntheticKey } from './fixtures/didi.js';

function fixture() {
  const f = didiFixture(), path = join(f.directory, 'member-didi.json');
  const principal = (subject: string): Principal => ({ issuer: 'https://identity.example/', tenant: 'personal', subject, clientId: 'native-mcp', scopes: [...SCOPES] });
  const membersPath = join(f.directory, 'members.sqlite'), members = new MemberStore(membersPath);
  const alice = members.login(principal('alice')), bob = members.login(principal('bob'));
  for (const member of [alice, bob]) members.apply(member.id, { displayName: member.subject, locale: 'en', timezone: 'UTC', consent: true }, false);
  members.close();
  const record: DidiMemberConnection = { version: 1, connectionId: randomUUID(), revision: 1, memberId: alice.id,
    owner: { issuer: alice.issuer, tenant: alice.tenant, subject: alice.subject }, localUid: process.getuid!(), purpose: 'ride_estimate_readonly',
    state: 'active', expiresAt: new Date(Date.now() + 3600000).toISOString(), binding: { ...f.binding, environment: 'production', auditDirectory: f.binding.auditDirectory! } };
  const write = (value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); write(record);
  const env: NodeJS.ProcessEnv = { EIGOS_INVITE_BETA: 'true', EIGOS_AUTH_MODE: 'jwt', PUBLIC_URL: 'https://beta.example', OAUTH_AUDIENCE: 'https://beta.example/',
    OAUTH_ISSUER: alice.issuer, OAUTH_JWKS_URL: 'https://identity.example/jwks', OIDC_CLIENT_ID: 'portal', OIDC_AGENT_CLIENT_ID: 'connector', OIDC_MCP_CLIENT_ID: 'native-mcp',
    DATABASE_PATH: join(f.directory, 'tasks.sqlite'), MEMBERSHIP_DATABASE_PATH: membersPath, EIGOS_MEMBERSHIP_APPROVAL: 'invite-only', EIGOS_EXECUTOR: 'codex', EIGOS_DIDI_MEMBER_CONNECTION_FILE: path };
  return { ...f, path, record, write, env, principal, alice, bob };
}

test('public DiDi configuration permits only a private member connection and keeps shared personal keys and all ordering disabled', () => {
  const f = fixture(); try {
    for (const parse of [readConfig, readWorkerConfig]) {
      assert.equal(parse(f.env).EIGOS_DIDI_MEMBER_CONNECTION_FILE, f.path);
      for (const change of [{ EIGOS_INVITE_BETA: 'false' }, { EIGOS_AUTH_MODE: 'development' }, { HOST: '0.0.0.0' },
        { EIGOS_DIDI_MEMBER_CONNECTION_FILE: 'relative.json' }, { EIGOS_DIDI_KEY_FILE: f.keyFile }, { EIGOS_DIDI_ENVIRONMENT: 'mock' },
        { EIGOS_DIDI_ORDERS_ENABLED: 'true' }, { EIGOS_DIDI_ORDERS_ENABLED: 'mock' }, { DATABASE_PATH: ':memory:' }]) assert.throws(() => parse({ ...f.env, ...change }));
    }
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('a pinned v17 registry gains only compatible DiDi read definitions; installation is idempotent and rejects a stale release', () => {
  const f = fixture(), store = new JobStore(f.env.DATABASE_PATH!);
  try {
    // A published historical registry fixture, without real accounts or observations.
    const seed = createCompositionKernelDefinition(), document = normalizeOntologyDocument(seed.document), db = new DatabaseSync(store.databasePath);
    const releaseId = randomUUID();
    db.prepare('INSERT INTO ontology_definition_releases VALUES(?,?,?,?,?,?,?)')
      .run(releaseId, document.id, 100, digest(document), seed.audit.model.digest, JSON.stringify(document), new Date().toISOString());
    db.prepare('UPDATE ontology_namespaces SET active_release_id=?,generation=2 WHERE id=?').run(releaseId, document.id); db.close();
    const before = store.definitions.namespace(), original = store.definitions.resolve(before.active).document;
    const next = store.definitions.installDidiReadonly(before.active, before.generation), installed = store.definitions.resolve(next.active).document;
    for (const key of ['objects', 'interfaces', 'links', 'actions', 'functions'] as const) for (const value of original[key]) {
      assert.deepEqual(installed[key].find(item => item.id === value.id), value);
    }
    assert.equal(installed.objects.length - original.objects.length, 3);
    assert.deepEqual(installed.actions.filter(a => !original.actions.some(old => old.id === a.id)).map(a => a.id).sort(), ['EstimateDidiRide', 'SearchDidiPlaces']);
    assert(installed.functions.some(fn => fn.id === 'rideEstimateStatus'));
    assert.equal(installed.objects.some(type => type.id === 'RideBookingTask'), false);
    assert.deepEqual(store.definitions.installDidiReadonly(next.active, next.generation), next);
    assert.throws(() => store.definitions.installDidiReadonly(before.active, before.generation), /changed/);
    assert.deepEqual(store.definitions.resolve(before.active).document, original, 'Old releases stay immutable and readable');
  } finally { store.close(); f.close(); }
});

test('member source rotation, expiry, private-file integrity and durable revocation fail closed without a local-owner fallback', () => {
  const f = fixture(), store = new JobStore(f.env.DATABASE_PATH!);
  try {
    const access = new DidiMemberAccess(f.path, (record, hash) => store.memberDidiSourceAdmitted(record, hash));
    const owner = ownerKey(f.principal('alice'));
    assert(!access.permitted(owner));
    store.admitMemberDidiSource(f.record, access.configurationDigest);
    assert(access.permitted(owner));
    for (const wrong of [ownerKey(f.principal('bob')), JSON.stringify(['local-development', 'local', 'developer'])]) assert(!access.permitted(wrong));
    chmodSync(f.path, 0o644); assert.throws(() => readDidiMemberConnection(f.path)); assert(!access.permitted(owner)); chmodSync(f.path, 0o600);
    symlinkSync(f.path, join(f.directory, 'link')); assert.throws(() => readDidiMemberConnection(join(f.directory, 'link')));
    f.write({ ...f.record, expiresAt: new Date(0).toISOString() }); assert(!access.permitted(owner));
    f.write({ ...f.record, revision: 2 }); assert(!access.permitted(owner));
    f.write(f.record); store.revokeMemberDidiSource(f.alice.id); store.admitMemberDidiSource(f.record, access.configurationDigest);
    assert(!access.permitted(owner), 'Restart cannot restore an exactly revoked connection');
    f.write({ ...f.record, revision: 2 }); const rotated = new DidiMemberAccess(f.path, (record, hash) => store.memberDidiSourceAdmitted(record, hash));
    store.admitMemberDidiSource(rotated.record, rotated.configurationDigest); assert(rotated.permitted(owner));
    store.admitMemberDidiSource(); assert(!rotated.permitted(owner));
    assert.equal(f.calls.length, 0);
  } finally { store.close(); f.close(); }
});

test('revocation during MCP discovery blocks the provider tool call itself', async () => {
  const f = fixture(); let revoked = false;
  try {
    f.flags.transform = (body, request) => { if (request.method === 'tools/list') revoked = true; return body; };
    await assert.rejects(f.connector.invoke({ requestId: 'fixture', requestRevision: 1, actionInputDigest: 'fixture', planId: 'fixture', intentId: 'fixture', attemptId: 'fixture', modelRunId: 'fixture' },
      'maps_textsearch', { city: '北京市', keywords: '北京西站' }, AbortSignal.timeout(10000), () => { if (revoked) throw new Error('Member source revoked'); }));
    assert(!f.calls.some(call => call.method === 'tools/call'));
  } finally { f.close(); }
});

test('invited member estimate crosses real A2A and MCP transports with a separate Worker store, owner isolation and revocation fencing', async t => {
  const f = fixture(), server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, config = readConfig({ ...f.env, PUBLIC_URL: base.replace('http:', 'https:'), OAUTH_AUDIENCE: base.replace('http:', 'https:') + '/' });
  const gateway = createApp(config, async token => f.principal(token), store => createExecutionCatalog({ store, didiMember: { connectionFile: f.path, connector: f.connector } }));
  server.on('request', gateway.app);
  const workerStore = new JobStore(config.DATABASE_PATH), catalog = createExecutionCatalog({ store: workerStore, didiMember: { connectionFile: f.path, connector: f.connector } });
  const worker = new Worker(workerStore, { coordinator: new Coordinator(workerStore, didiModel(), catalog), pollMs: 10 }); worker.start();
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) await client.close(); await worker.close(); workerStore.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await gateway.close(); f.close(); });
  const aliceOwner = ownerKey(f.principal('alice')), bobOwner = ownerKey(f.principal('bob'));
  assert(gateway.catalog.summaries(aliceOwner).some(c => c.ref.id === DIDI_PROGRAM_REF.id));
  assert(!catalog.summaries(bobOwner).some(c => c.ref.id === DIDI_PROGRAM_REF.id));
  assert.equal(f.calls.length, 0, 'Gateway startup and catalog discovery never touch the provider');
  const rpc = async (method: string, params: object) => {
    const r = await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: 'Bearer alice', 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    assert.equal(r.status, 200); return r.json();
  };
  const submit = async () => {
    const r = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: '只查询滴滴北京西站到西二旗地铁站的车型估价，不下单、不付款' }] } });
    assert(!r.error, JSON.stringify(r)); return r.result.task.id as string;
  };
  const settle = async (id: string) => {
    for (let i = 0; i < 400; i++) { const job = gateway.store.get(aliceOwner, id); if (!['submitted', 'working'].includes(job.state)) return job; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('Synthetic member estimate did not settle');
  };
  const done: Job = await settle(await submit()); assert.equal(done.state, 'completed', JSON.stringify({feedback:done.delegation?.agent?.feedback,grounding:done.delegation?.groundingFeedback,question:done.question,error:done.error}));
  for (const token of ['alice', 'bob']) {
    const client = new Client({ name: 'member-didi-test', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const read = await client.callTool({ name: 'get_task', arguments: { taskId: done.id } });
    if (token === 'alice') {
      assert(!read.isError); assert.deepEqual((read.structuredContent as { result: Job }).result.artifact, done.artifact);
      const ref = done.delegation!.agent!.observations.find(r => r.type === 'RideEstimateObservation')!;
      const evaluated = await client.callTool({ name: 'evaluate_ontology', arguments: { function: 'rideEstimateStatus', object: ref } });
      assert(!evaluated.isError); assert.equal((evaluated.structuredContent as { result: { status: string } }).result.status, 'known');
    } else assert(read.isError);
    assert(!JSON.stringify(read).includes(syntheticKey)); assert(!JSON.stringify(read).includes('PRIVATE_TRACE'));
  }
  f.flags.before = async () => { gateway.members.setStatus(f.alice.id, 'suspended'); };
  const rejected = await settle(await submit()); assert.notEqual(rejected.state, 'completed'); assert(!rejected.artifact);
  assert(!catalog.summaries(aliceOwner).some(c => c.ref.id === DIDI_PROGRAM_REF.id));
  assert(f.calls.filter(c => c.method === 'tools/call').every(c => ['maps_textsearch', 'taxi_estimate'].includes(c.name!)));
});
