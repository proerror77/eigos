import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { createApp } from '../apps/gateway/app.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { Worker } from '../apps/worker/worker.js';
import { readConfig } from '../packages/core/config.js';
import { Conflict, FunctionFailed, PermissionDenied, ResourceExhausted, ServiceUnavailable } from '../packages/core/identity.js';
import type { OntologyDocument } from '../packages/ontology/schema.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { OntologyAgent } from '../packages/runtime/agent.js';
import { ComponentFunctions, type ComponentImplementation } from '../packages/runtime/component-functions.js';
import { FunctionInvocations, functionInvocationsQuery } from '../packages/runtime/function-invocations.js';
import { setTimeout as delay } from 'node:timers/promises';
import { FunctionHostClient } from '../packages/runtime/function-host.js';
import { ComponentSourceEgress } from '../packages/runtime/component-source-egress.js';
import { ComponentOAuthGrants } from '../packages/runtime/component-source-oauth.js';
import { ComponentSourceSecrets, sealSourceSecrets } from '../packages/runtime/component-source-secrets.js';
import { ObjectSets } from '../packages/runtime/object-sets.js';
import { SemanticSearch } from '../packages/runtime/semantic.js';
import { enablePgvector } from '../packages/runtime/semantic-pgvector.js';
import { Objects } from '../packages/runtime/objects.js';
import { FixtureAgent } from './agent-driver.js';
import { fixture, principal } from './fixture.js';

// Suite 49's workflow step builds both; see tests/49-function-host.test.ts. The runtime starts its own host from
// EIGOS_FUNCTION_HOST_BIN on first use.
const binary = process.env.EIGOS_FUNCTION_HOST_BIN;
const fixtures = process.env.EIGOS_FUNCTION_HOST_FIXTURES;
const skip = !binary || !fixtures;
const component = (name: 'echo_rust' | 'net_rust') => readFile(join(fixtures!, `${name}.wasm`));
const limits = { fuel: 100_000_000, memoryMb: 64, deadlineMs: 2000 };
const implementation = (sha256: string, overrides: Partial<typeof limits> = {}): ComponentImplementation =>
  ({ kind: 'component', sha256, limits: { ...limits, ...overrides } });
type FunctionType = OntologyDocument['functionTypes'][number];
const echoFunction = (sha256: string, overrides: Partial<FunctionType> = {}): FunctionType => ({
  apiName: 'EchoPayload', description: 'Echo a payload through a component', version: '1.0.0',
  parameters: { type: 'object' }, returns: { type: 'object', required: ['echo'] }, implementation: implementation(sha256), ...overrides,
});
const failed = (code: string, message?: RegExp) => (error: unknown) =>
  error instanceof FunctionFailed && error.code === code && (!message || message.test(error.message));

test('a definition editor uploads a component, and a release runs it for calls, Action criteria and the Agent', { skip }, async () => {
  const f = await fixture(), token = 'component-functions-token';
  const gateway = createApp(readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token.repeat(2) }),
    f.db, f.source, async incoming => incoming === token ? principal : { ...principal, scopes: [] });
  const server = gateway.app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const upload = (bytes: Uint8Array<ArrayBuffer>) => fetch(`http://127.0.0.1:${address.port}/ontology/function-artifacts`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/wasm' }, body: bytes,
    });
    const echo = await component('echo_rust');
    // Uploading needs edit_definition, and the function host refuses components that import the network.
    assert.equal((await upload(echo)).status, 403);
    await setGrants(f.db, principal.owner, [...businessGrants(f.model), { resource: 'Eigos', permission: 'edit_definition' }]);
    const refused = await upload(await component('net_rust'));
    assert.equal(refused.status, 400);
    assert.match(JSON.stringify(await refused.json()), /refused the component: .*wasi:sockets/);
    const uploaded = await upload(echo);
    assert.equal(uploaded.status, 200);
    const { sha256, world } = await uploaded.json() as { sha256: string; world: string };
    assert.equal(world, 'eigos:function/handler@0.2.0');
    assert.equal((await f.db.query(`SELECT size FROM ${f.db.schema}.function_artifacts WHERE sha256=$1`, [sha256])).rows[0]!.size, echo.length);

    const document = structuredClone(f.model.document);
    const object = { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false };
    document.functionTypes.push(echoFunction(sha256), {
      apiName: 'AnswerOf', description: 'Return the answer a component is given', version: '1.0.0',
      parameters: { type: 'object', properties: { answer: { type: 'boolean' } }, required: ['answer'], additionalProperties: false },
      returns: { type: 'boolean' }, implementation: implementation(sha256),
    });
    document.actionTypes.push({
      apiName: 'RenameWhenAllowed', description: 'Rename a route when a component allows it',
      parameters: { type: 'object', properties: { route: object, revision: { type: 'integer' }, allowed: { type: 'boolean' } },
        required: ['route', 'revision', 'allowed'], additionalProperties: false },
      objectParameters: { route: 'Route' },
      submissionCriteria: [{ function: 'AnswerOf', arguments: { answer: { parameter: 'allowed' } }, message: 'The component did not allow it' }],
      rules: [{ op: 'editObject', object: { parameter: 'route' }, expectedRevision: { parameter: 'revision' }, properties: { name: { literal: 'Renamed' } } }],
      result: { type: 'Route', id: { parameter: 'route', path: ['id'] } },
    });
    const model = await f.metadata.publish(document, f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const access = await Access.load(f.db, principal);
    const context = (as = access) => ({ principal: as.principal, objects: new Objects(f.db, model, as), signal: AbortSignal.timeout(30_000) });
    const call = (input: Record<string, unknown>) => f.capabilities.functions.invoke(model, 'EchoPayload', input, context());

    assert.deepEqual(await call({ values: [1, 2] }), { echo: { values: [1, 2] } });
    await assert.rejects(call({ fail: true }), failed('asked', /^asked to fail$/));
    await assert.rejects(call({ panic: true }), failed('trap', /^EchoPayload failed: /));
    await assert.rejects(call({ spin: 1_000_000_000 }), error =>
      error instanceof ResourceExhausted && error.limit === 'fuel' && error.message === 'EchoPayload exceeded its fuel limit');
    // The output is JSON, but not the object the contract promises.
    await assert.rejects(call({ repeat: 10 }), failed('contract', /does not match its published contract/));
    await assert.rejects(f.capabilities.functions.invoke(model, 'AnswerOf', { answer: 'yes' }, context()), error => error instanceof z.ZodError);
    const stranger = await Access.load(f.db, { ...principal, owner: 'component-stranger' });
    await assert.rejects(f.capabilities.functions.invoke(model, 'EchoPayload', {}, context(stranger)), PermissionDenied);

    const live = new Objects(f.db, model, access), route = { type: 'Route', id: 'component-route' };
    await live.create(route, { id: route.id, name: 'Before' });
    await assert.rejects(f.capabilities.actions.apply(access, model, 'RenameWhenAllowed', { route, revision: 1, allowed: false }, 'component-denied'),
      /The component did not allow it/);
    await f.capabilities.actions.apply(await Access.load(f.db, principal), model, 'RenameWhenAllowed', { route, revision: 1, allowed: true }, 'component-allowed');
    assert.equal((await live.read(route)).properties.name, 'Renamed');

    const driver = new FixtureAgent();
    const agent = new OntologyAgent(f.db, f.metadata, f.tasks, f.capabilities, {
      model: driver.model,
      async run(_prompt, tools) {
        assert.deepEqual(await tools.get('evaluate_function')!.invoke({ function: 'EchoPayload', input: { values: [3] } }), { echo: { values: [3] } });
        await tools.get('complete_with_object_set')!.invoke({ set: { op: 'refs', objects: [] } });
      },
    });
    const task = await f.tasks.submit(principal, { requestId: 'component-agent', message: 'Echo through a component' });
    assert(await new Worker(f.tasks, agent).runOne());
    const done = await f.tasks.get(principal, task.id);
    assert.equal(done.state, 'completed', done.error ?? undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await f.close();
  }
});

test('a release with component Functions needs a function host, their components and a new version for each change', { skip }, async () => {
  const f = await fixture();
  try {
    const { sha256 } = await new ComponentFunctions(f.db).upload(await component('echo_rust'), principal);
    const publish = (fn: FunctionType) => {
      const document = structuredClone(f.model.document);
      document.functionTypes.push(fn);
      return f.metadata.publish(document, f.capabilities, f.publisher);
    };
    await assert.rejects(publish(echoFunction(sha256, { version: '1' })), /A component Function needs a semantic version/);
    await assert.rejects(publish(echoFunction(sha256, { source: 'Didi' })), /Component HTTP Sources are unavailable/);
    await assert.rejects(publish(echoFunction(sha256, { implementation: { ...implementation(sha256), limits: { ...limits, memoryMb: 1024 } } })), /memoryMb/);
    await assert.rejects(publish(echoFunction('a'.repeat(64))), error => error instanceof Conflict && /has not been uploaded/.test(error.message));
    const configured = process.env.EIGOS_FUNCTION_HOST_BIN;
    delete process.env.EIGOS_FUNCTION_HOST_BIN;
    try {
      await assert.rejects(publish(echoFunction(sha256)), error => error instanceof ServiceUnavailable && /need a function host/.test(error.message));
    } finally {
      process.env.EIGOS_FUNCTION_HOST_BIN = configured;
    }

    await publish(echoFunction(sha256));
    // Republishing the same version unchanged is fine; changing it is not.
    await publish(echoFunction(sha256));
    await assert.rejects(publish(echoFunction(sha256, { implementation: implementation(sha256, { fuel: 200_000_000 }) })),
      error => error instanceof Conflict && /Function versions are immutable: release EchoPayload as a new version/.test(error.message));
    await assert.rejects(publish(echoFunction(sha256, { description: 'Echo a payload, described anew' })), /immutable/);
    const next = await publish(echoFunction(sha256, { version: '1.0.1', implementation: implementation(sha256, { fuel: 200_000_000 }) }));
    assert.notEqual(next.bindings.functions.EchoPayload, f.model.bindings.functions.EchoPayload);
  } finally {
    await f.close();
  }
});

test('the runtime gives the function host a stored component it does not have', { skip }, async () => {
  const f = await fixture();
  const host = await FunctionHostClient.start(binary!);
  try {
    const { sha256 } = await new ComponentFunctions(f.db).upload(await component('echo_rust'), principal);
    // A host that never saw the component, as after a restart without a data directory.
    const fresh = new ComponentFunctions(f.db, () => Promise.resolve(host));
    assert.equal((await host.health()).components, 0);
    assert.deepEqual(await fresh.invoke('EchoPayload', implementation(sha256), { values: [4] }, AbortSignal.timeout(30_000)), { echo: { values: [4] } });
    assert.equal((await host.health()).components, 1);
    await assert.rejects(fresh.invoke('Missing', implementation('b'.repeat(64)), {}, AbortSignal.timeout(30_000)),
      error => error instanceof Conflict && error.message === `The component of Missing has not been uploaded: ${'b'.repeat(64)}`);
    await assert.rejects(new ComponentFunctions(f.db, () => undefined).invoke('EchoPayload', implementation(sha256), {}, AbortSignal.timeout(30_000)),
      ServiceUnavailable);
  } finally {
    await host.stop();
    await f.close();
  }
});

test('a new component Function version follows the active one, with a new major version for a breaking change', { skip }, async () => {
  const f = await fixture();
  try {
    const { sha256 } = await new ComponentFunctions(f.db).upload(await component('echo_rust'), principal);
    const values = { type: 'array', items: { type: 'integer' } }, label = { type: 'string' };
    const publish = (version: string, properties: Record<string, unknown>, required: string[] = []) => {
      const document = structuredClone(f.model.document);
      document.functionTypes.push(echoFunction(sha256, { version, parameters: { type: 'object', properties, required } }));
      return f.metadata.publish(document, f.capabilities, f.publisher);
    };
    await publish('1.0.0', { values });
    await publish('1.1.0', { values, label });
    await assert.rejects(publish('1.2.0', { values, label }, ['label']), error => error instanceof Conflict &&
      error.message === 'EchoPayload 1.2.0 is not backward compatible with 1.1.0 (input label became required): release it as 2.0.0 or later');
    await publish('2.0.0', { values, label }, ['label']);
    await assert.rejects(publish('1.5.0', { values }), error => error instanceof Conflict && error.message === 'Release EchoPayload as a version above 2.0.0');
    // A version released before can come back unchanged, as in a rollback.
    await publish('1.0.0', { values });
  } finally {
    await f.close();
  }
});

test('a component Function reads the Ontology as its caller would, within its limits', { skip }, async () => {
  const f = await fixture();
  try {
    const { sha256 } = await new ComponentFunctions(f.db).upload(await component('echo_rust'), principal);
    const document = structuredClone(f.model.document);
    // Reach the callback-count limit even when 1,001 sequential PostgreSQL reads take more than the default deadline.
    document.functionTypes.push(echoFunction(sha256, { apiName: 'ReadOntology', description: 'Read the Ontology through the function host',
      returns: { type: 'object' }, implementation: implementation(sha256, { deadlineMs: 30_000 }) }));
    const model = await f.metadata.publish(document, f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const access = await Access.load(f.db, principal), live = new Objects(f.db, model, access), sets = new ObjectSets(f.db);
    const route = { type: 'Route', id: 'read-route' }, request = { type: 'RideRequest', id: 'read-request' };
    await live.create(route, { id: route.id, name: 'Readable' });
    await live.create(request, { id: request.id, name: 'Request', status: 'quoted', requestedAt: new Date().toISOString() });
    await live.link({ type: 'RequestRoute', from: request, to: route });
    const call = async (as: typeof principal, op: string, args: unknown[], times?: number) =>
      ((await f.capabilities.functions.invoke(model, 'ReadOntology', { ontology: { op, args, ...(times ? { times } : {}) } },
        { principal: as, objects: new Objects(f.db, model, await Access.load(f.db, as)), signal: AbortSignal.timeout(60_000) })) as { result: unknown }).result;
    const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
    const set = { set: { op: 'refs', objects: [route] } } as const;
    const count = { set: { op: 'query', query: { type: 'Route' } }, metrics: { n: { op: 'count' } } } as const;
    // Inside the Function each read returns what the same caller reads directly.
    assert.deepEqual(await call(principal, 'get', ['Route', route.id]), json(await live.read(route)));
    assert.equal(await call(principal, 'get', ['Route', 'missing-route']), null);
    assert.deepEqual(await call(principal, 'follow', [JSON.stringify(request), 'route']), json(await live.follow(request, 'route')));
    assert.deepEqual(await call(principal, 'query', [JSON.stringify({ type: 'Route' })]), json(await live.query({ type: 'Route' })));
    assert.deepEqual(await call(principal, 'evaluate', [JSON.stringify(set)]), json(await sets.evaluate(access, model, set)));
    assert.deepEqual(await call(principal, 'aggregate', [JSON.stringify(count)]), json(await sets.aggregate(access, model, count)));
    // A caller who may not read routes gets the Function's failure, as a direct read would refuse.
    const reader = { ...principal, owner: 'component-reader' };
    await setGrants(f.db, reader.owner, businessGrants(model).filter(grant => grant.resource !== 'Eigos/object/Route'));
    await assert.rejects(call(reader, 'get', ['Route', route.id]), failed('permission-denied'));
    // The runtime bounds how often one call reads.
    await assert.rejects(call(principal, 'get', ['Route', route.id], 1001), failed('limit', /at most 1000 times/));
    await assert.rejects(call(principal, 'query', ['not JSON']), failed('invalid'));
  } finally {
    await f.close();
  }
});

test('an Action runs a component edit Function: its reads see its edits, and they commit together or not at all', { skip }, async () => {
  const f = await fixture();
  try {
    const { sha256 } = await new ComponentFunctions(f.db).upload(await component('echo_rust'), principal);
    const reference = { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false };
    const document = structuredClone(f.model.document);
    document.functionTypes.push(
      echoFunction(sha256, { apiName: 'PlanRoute', description: 'Create, rename and link a route', edits: true, returns: reference }),
      echoFunction(sha256, { apiName: 'ReadOnlyScript', description: 'A read-only Function that tries to edit', returns: { type: 'null' } }));
    document.actionTypes.push({ apiName: 'PlanRouteAction', description: 'Plan a route through a component edit Function',
      parameters: { type: 'object' }, objectParameters: {}, submissionCriteria: [], function: 'PlanRoute' });
    const model = await f.metadata.publish(document, f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const access = () => Access.load(f.db, principal);
    const live = new Objects(f.db, model, await access());
    const request = { type: 'RideRequest', id: 'plan-request' };
    await live.create(request, { id: request.id, name: 'Request', status: 'quoted', requestedAt: new Date().toISOString() });
    type Step = { op: string; args: string[]; expect?: { pointer: string; equals: unknown } };
    const plan = (id: string, last: Step[] = []): { script: Step[]; return: unknown } => ({ script: [
      { op: 'create', args: ['Route', id, JSON.stringify({ id, name: 'Draft' })] },
      { op: 'update', args: [JSON.stringify({ type: 'Route', id }), JSON.stringify({ name: 'Planned' })] },
      // Reads by key, searches and links all see the call's own edits before the Action commits.
      { op: 'get', args: ['Route', id], expect: { pointer: '/properties/name', equals: 'Planned' } },
      { op: 'query', args: [JSON.stringify({ type: 'Route', where: { name: 'Planned' } })], expect: { pointer: '/items/0/ref/id', equals: id } },
      { op: 'link', args: ['RequestRoute', JSON.stringify(request), JSON.stringify({ type: 'Route', id })] },
      { op: 'follow', args: [JSON.stringify(request), 'route'], expect: { pointer: '/0/ref/id', equals: id } },
      ...last,
    ], return: { type: 'Route', id } });
    assert.deepEqual(await f.capabilities.actions.apply(await access(), model, 'PlanRouteAction', plan('planned-route'), 'plan-route'),
      { type: 'Route', id: 'planned-route' });
    assert.equal((await live.read({ type: 'Route', id: 'planned-route' })).properties.name, 'Planned');
    assert.deepEqual((await live.follow(request, 'route')).map(item => item.ref.id), ['planned-route']);
    // A failure after edits leaves nothing behind.
    const other = { type: 'RideRequest', id: 'failed-request' };
    await live.create(other, { id: other.id, name: 'Other', status: 'quoted', requestedAt: new Date().toISOString() });
    const failing = plan('failed-route', [{ op: 'fail', args: [] }]);
    failing.script[4]!.args[1] = JSON.stringify(other);
    failing.script[5]!.args[0] = JSON.stringify(other);
    await assert.rejects(f.capabilities.actions.apply(await access(), model, 'PlanRouteAction', failing, 'plan-failed'), failed('asked'));
    await assert.rejects(live.read({ type: 'Route', id: 'failed-route' }), /not found|unavailable/i);
    assert.deepEqual(await live.follow(other, 'route'), []);
    const invocations = new FunctionInvocations(f.db), monitor = await access();
    const listInput = functionInvocationsQuery.parse({ function: 'PlanRoute' });
    const telemetryDeadline = Date.now() + 3000;
    let history = await invocations.list(monitor, model, listInput);
    while (!history.items.some(row => row.errorCode === 'asked') && Date.now() < telemetryDeadline) {
      await delay(15);
      history = await invocations.list(monitor, model, listInput);
    }
    assert(history.items.some(row => row.errorCode === 'asked' && row.callbacks.update?.count === 1));
    // Outside an Action an edit Function does not run, and a read-only Function cannot edit.
    const context = async () => ({ principal, objects: new Objects(f.db, model, await access()), signal: AbortSignal.timeout(60_000) });
    await assert.rejects(f.capabilities.functions.invoke(model, 'PlanRoute', plan('direct-route'), await context()), /must be invoked through an Action/);
    await assert.rejects(f.capabilities.functions.invoke(model, 'ReadOnlyScript', { script: [{ op: 'create', args: ['Route', 'sneaky', '{}'] }] }, await context()),
      failed('conflict', /Edits need an edit Function that an Action runs/));
  } finally {
    await f.close();
  }
});

test('Function invocation history records host costs and errors by caller and expires after 30 days', { skip }, async () => {
  const f = await fixture();
  try {
    const { sha256 } = await new ComponentFunctions(f.db).upload(await component('echo_rust'), principal);
    const document = structuredClone(f.model.document);
    document.functionTypes.push(echoFunction(sha256, { apiName: 'InvocationProbe', returns: { type: 'object' } }));
    const model = await f.metadata.publish(document, f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const access = await Access.load(f.db, principal);
    const graph = new Objects(f.db, model, access);
    const route = { type: 'Route', id: 'private-telemetry-route' };
    await graph.create(route, { id: route.id, name: 'Private fixture payload' });
    const opts = { principal, objects: graph, signal: AbortSignal.timeout(15_000) };
    const name = 'InvocationProbe';
    await f.capabilities.functions.invoke(model, name, { ontology: { op: 'get', args: ['Route', route.id] } }, opts);
    await assert.rejects(f.capabilities.functions.invoke(model, name, { fail: true }, opts), failed('asked'));
    const reporter = new FunctionInvocations(f.db);
    const input = functionInvocationsQuery.parse({ function: name, limit: 1 });
    let page = await reporter.list(access, model, input);
    const deadline = Date.now() + 3000;
    while (!page.cursor && Date.now() < deadline) {
      await delay(15);
      page = await reporter.list(access, model, input);
    }
    assert(page.cursor);
    const earlier = await reporter.list(access, model, { ...input, before: page.cursor });
    const items = [...page.items, ...earlier.items];
    assert.equal(items.length, 2);
    const returned = items.find(item => item.status === 'returned');
    const rejected = items.find(item => item.status === 'failed');
    assert.equal(returned?.callbacks.get?.count, 1);
    assert((returned?.callbacks.get?.durationMs ?? -1) >= 0);
    assert((returned?.fuelUsed ?? 0) > 0);
    assert((returned?.hostMs ?? -1) >= 0);
    assert.equal(rejected?.errorCode, 'asked');
    assert.equal(rejected?.version, '1.0.0');
    assert(!JSON.stringify(items).includes(route.id));
    const other = { ...principal, owner: 'invocation-other-owner' };
    await setGrants(f.db, other.owner, businessGrants(model));
    const otherAccess = await Access.load(f.db, other);
    assert.deepEqual(await reporter.list(otherAccess, model, input), { items: [] });
    const token = 'function-invocation-fixture-token'.repeat(2);
    const gateway = createApp(readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token }),
      f.db, f.source, async incoming => incoming === token ? principal : other);
    const server = gateway.app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const path = `http://127.0.0.1:${address.port}/ontology/function-invocations?function=${name}`;
      const history = await fetch(path, { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(history.status, 200);
      assert.equal((await history.json()).items.length, 2);
      assert.equal((await fetch(path)).status, 401);
    } finally { await new Promise(resolve => server.close(resolve)); }
    await f.db.query(`UPDATE ${f.db.schema}.function_invocations SET started_at=now()-interval '31 days' WHERE function_name=$1`, [name]);
    assert.deepEqual(await reporter.list(access, model, input), { items: [] });
    assert.equal(await reporter.prune(), 2);
  } finally { await f.close(); }
});

test('a component reads through its declared Source with caller permission and receives no credential', { skip }, async () => {
  const requests: { path: string; header?: string }[] = [];
  const secret = 'synthetic-inventory-token';
  const egress = new ComponentSourceEgress({
    Inventory: { baseUrl: 'https://inventory.example.com/v1/', methods: ['GET'], bearerSecret: 'inventory' },
  }, async (url, options) => {
    requests.push({ path: url.pathname, header: options.headers.authorization });
    return { status: 200, contentType: 'application/json', body: '{"available":true}' };
  }, () => {});
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, {
    componentSources: { egress, secrets: { async get(name) { assert.equal(name, 'inventory'); return secret; } } },
  });
  try {
    const { sha256 } = await new ComponentFunctions(f.db).upload(await component('echo_rust'), principal);
    const document = structuredClone(f.model.document);
    document.functionTypes.push(
      echoFunction(sha256, { apiName: 'InventoryLookup', source: 'Inventory', returns: { type: 'object' } }),
      echoFunction(sha256, { apiName: 'UndeclaredLookup', returns: { type: 'object' } }),
    );
    const model = await f.metadata.publish(document, f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const other = { ...principal, owner: 'component-source-without-grant' };
    await setGrants(f.db, other.owner, businessGrants(model).filter(grant => grant.permission !== 'read_source'));
    const call = async (caller: typeof principal, name: string, path = '/v1/items') => {
      const access = await Access.load(f.db, caller);
      return f.capabilities.functions.invoke(model, name, { ontology: { op: 'outgoing', args: [{ path }] } },
        { principal: caller, objects: new Objects(f.db, model, access), signal: AbortSignal.timeout(10000) });
    };
    await assert.rejects(call(other, 'InventoryLookup'), PermissionDenied);
    await assert.rejects(call(principal, 'UndeclaredLookup'), failed('permission-denied'));
    await assert.rejects(call(principal, 'InventoryLookup', '/outside'), failed('permission-denied'));
    assert.deepEqual(requests, []);
    const result = await call(principal, 'InventoryLookup');
    assert.deepEqual(result, { result: { status: 200, contentType: 'application/json', body: '{"available":true}' } });
    assert.deepEqual(requests, [{ path: '/v1/items', header: 'Bearer ' + secret }]);
    assert(!JSON.stringify(result).includes(secret));
    const access = await Access.load(f.db, principal);
    const reporter = new FunctionInvocations(f.db);
    const input = functionInvocationsQuery.parse({ function: 'InventoryLookup' });
    let history = await reporter.list(access, model, input);
    const deadline = Date.now() + 3000;
    while (!history.items.some(item => item.status === 'returned') && Date.now() < deadline) {
      await delay(15);
      history = await reporter.list(access, model, input);
    }
    assert.equal(history.items.find(item => item.status === 'returned')?.callbacks.outgoing?.count, 1);
    assert(!JSON.stringify(history.items).includes(secret));
  } finally { await f.close(); }
});

test('a native component receives a stable error for a Source grant that must be renewed', { skip }, async () => {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), 'eigos-component-refresh-'));
  try {
    const key = join(directory, 'key'), bundle = join(directory, 'credentials'), encryptionKey = randomBytes(32);
    await writeFile(key, encryptionKey, { mode: 0o600 });
    await writeFile(bundle, JSON.stringify(sealSourceSecrets({ client: 'synthetic-client', seed: 'synthetic-refresh' }, encryptionKey)), { mode: 0o600 });
    encryptionKey.fill(0);
    const secrets = new ComponentSourceSecrets(bundle, key);
    let exchanges = 0;
    const egress = new ComponentSourceEgress({ Inventory: {
      baseUrl: 'https://inventory.example.com/v1/', methods: ['GET'], oauth: { grant: 'refresh_token',
        tokenUrl: 'https://tokens.example.com/token', clientId: 'fixture', clientSecret: 'client', refreshTokenSecret: 'seed' },
    } }, async url => {
      assert.equal(url.hostname, 'tokens.example.com');
      exchanges++;
      return { status: 400, contentType: 'application/json', body: '{"error":"invalid_grant","error_description":"synthetic-refresh"}' };
    }, () => {}, new ComponentOAuthGrants(f.db, secrets));
    const capabilities = createCapabilities(f.db, f.source, { componentSources: { egress, secrets } });
    const { sha256 } = await new ComponentFunctions(f.db).upload(await component('echo_rust'), principal);
    const document = structuredClone(f.model.document);
    const functionName = 'RefreshInventoryFixture';
    document.functionTypes.push(echoFunction(sha256, { apiName: functionName, source: 'Inventory', returns: { type: 'object' } }));
    const model = await f.metadata.publish(document, capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const call = async () => capabilities.functions.invoke(model, functionName, { ontology: { op: 'outgoing', args: [{ path: '/v1/items' }] } },
      { principal, objects: new Objects(f.db, model, await Access.load(f.db, principal)), signal: AbortSignal.timeout(15_000) });
    for (let index = 0; index < 2; index++)
      await assert.rejects(call(), failed('source-reauthorization-required', /^Source OAuth authorization must be renewed$/));
    assert.equal(exchanges, 1);
  } finally { try { await f.close(); } finally { await rm(directory, { recursive: true }); } }
});

test('a published component embedding Function indexes and ranks the caller’s objects', { skip }, async () => {
  const f = await fixture();
  try {
    const { sha256 } = await new ComponentFunctions(f.db).upload(await component('echo_rust'), principal);
    const embeddingFunction = 'EmbedComponentFixture';
    const document = structuredClone(f.model.document);
    document.functionTypes.push(echoFunction(sha256, {
      apiName: embeddingFunction,
      description: 'Embed synthetic test text in the local component host',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      returns: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    }));
    const model = await f.metadata.publish(document, f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const access = await Access.load(f.db, principal), graph = new Objects(f.db, model, access);
    const semantic = new SemanticSearch(f.db, f.capabilities.functions);
    const name = 'ComponentVectors';
    const north = { type: 'Route', id: 'test-north' }, south = { type: 'Route', id: 'test-south' };
    await graph.create(north, { id: north.id, name: 'f5-vector: north avenue' });
    await graph.create(south, { id: south.id, name: 'f5-vector: south avenue' });
    await semantic.configure(f.publisher, model, { name, type: 'Route', property: 'name', embeddingFunction, dimensions: 2 });
    if (process.env.EIGOS_TEST_PGVECTOR === 'true') await enablePgvector(f.db);
    const indexed = await semantic.index(access, model, { name, objects: [south, north] });
    assert.equal(indexed.indexed, 2);
    assert.equal(indexed.binding, model.bindings.functions[embeddingFunction]);
    const result = await semantic.search(access, model, { name, text: 'f5-vector: north', limit: 2 });
    assert.equal(result.backend, process.env.EIGOS_TEST_PGVECTOR === 'true' ? 'pgvector' : 'jsonb');
    assert.deepEqual(result.items.map(hit => hit.object.ref), [north, south]);
    assert(result.items[0]!.score > result.items[1]!.score);
  } finally { await f.close(); }
});

test('a published component streams authorized model chunks to the PA before completion and records actual tokens', { skip }, async () => {
  const { ComponentModels } = await import('../packages/runtime/component-models.js');
  const { setModelClearance } = await import('../packages/runtime/model-egress.js');
  const { OntologyClient } = await import('../packages/sdk/client.js');
  const config = { Writer: {provider:'Synthetic',model:'fixture-v1',endpoint:'https://models.example.invalid/v1/chat/completions',
    secret:'writer',maxTokens:24} };
  let releaseSecond!: () => void;
  let allowSecond = new Promise<void>(resolve => { releaseSecond = resolve; });
  const calls: string[] = [];
  const extensions = { componentModels: (db:typeof f.db) => new ComponentModels(db,config,{get:async ()=>'synthetic-model-key'},async (url,init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-model-key');
    const body=JSON.parse(String(init?.body));
    assert.equal(body.model,'fixture-v1');
    assert.equal(body.stream,true);
    assert.deepEqual(body.messages,[{role:'user',content:'synthetic input'}]);
    const encoder=new TextEncoder();
    const part=(value:unknown)=>encoder.encode('data: '+JSON.stringify(value)+'\r\n\r\n');
    return new Response(new ReadableStream<Uint8Array>({async start(controller) {
      controller.enqueue(part({choices:[{delta:{content:'first'}}],usage:{prompt_tokens:7,completion_tokens:1}}));
      await allowSecond;
      controller.enqueue(part({choices:[{delta:{content:'second'}}]}));
      controller.enqueue(part({choices:[],usage:{prompt_tokens:7,completion_tokens:2}}));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));controller.close();
    }}),{headers:{'content-type':'text/event-stream'}});
  }) };
  const f: Awaited<ReturnType<typeof fixture>> = await fixture(undefined,undefined,undefined,undefined,undefined,extensions);
  const token='synthetic-model-streaming-token-access';
  const gateway=createApp(readConfig({DATABASE_URL:process.env.EIGOS_TEST_DATABASE_URL,EIGOS_AUTH_MODE:'development',EIGOS_DEV_TOKEN:token}),
    f.db,f.source,async () => principal,extensions);
  const server=gateway.app.listen(0,'127.0.0.1');
  try {
    await new Promise<void>(resolve=>server.once('listening',resolve));
    const port=(server.address() as {port:number}).port;
    const client=new OntologyClient({baseUrl:`http://127.0.0.1:${port}/`,token});
    const {sha256}=await new ComponentFunctions(f.db).upload(await component('echo_rust'),principal);
    const document=structuredClone(f.model.document);
    document.functionTypes.push(echoFunction(sha256,{apiName:'ModelWriter',returns:{type:'object'},
      implementation:{...implementation(sha256),limits:{...limits,deadlineMs:15000},models:['Writer'],stream:'text'}}));
    const model=await f.metadata.publish(document,f.capabilities,f.publisher);
    await setGrants(f.db,principal.owner,businessGrants(model));
    const input={ontology:{op:'generate',args:['Writer',[{role:'user',content:'synthetic input'}]]}};
    await assert.rejects(client.evaluateStream('ModelWriter',input).next());
    assert.deepEqual(calls,[]);
    await setModelClearance(f.db,{owner:principal.owner,provider:'Synthetic',model:'fixture-v1',clearance:{sensitivity:'INTERNAL',compartments:[]}});
    const stream=client.evaluateStream<{result:string}>('ModelWriter',input,{signal:AbortSignal.timeout(20000)});
    assert.deepEqual((await stream.next()).value,{type:'chunk',text:'first'});
    releaseSecond();
    assert.deepEqual((await stream.next()).value,{type:'chunk',text:'second'});
    assert.deepEqual((await stream.next()).value,{type:'result',value:{result:'firstsecond'}});
    assert((await stream.next()).done);
    assert.equal(calls.length,1);
    const reporter=new FunctionInvocations(f.db);
    const access=await Access.load(f.db,principal);
    const read=async ()=>(await reporter.list(access,model,functionInvocationsQuery.parse({function:'ModelWriter'}))).items.find(i=>i.status==='returned');
    let success=await read();
    const until=Date.now()+3000;
    while (!success && Date.now()<until) {await delay(20);success=await read();}
    assert.deepEqual(success?.modelUsage,[{alias:'Writer',provider:'Synthetic',model:'fixture-v1',calls:1,reportedCalls:1,inputTokens:7,outputTokens:2}]);
    allowSecond = new Promise<void>(resolve => { releaseSecond = resolve; });
    const revoked=client.evaluateStream('ModelWriter',input,{signal:AbortSignal.timeout(20000)});
    assert.deepEqual((await revoked.next()).value,{type:'chunk',text:'first'});
    await setModelClearance(f.db,{owner:principal.owner,provider:'Synthetic',model:'fixture-v1',active:false,clearance:{sensitivity:'INTERNAL',compartments:[]}});
    releaseSecond();
    await assert.rejects(revoked.next(),/stream failed/i);
    assert.equal(calls.length,2);
    const otherInput={ontology:{op:'generate',args:['Undeclared',[{role:'user',content:'synthetic input'}]]}};
    await assert.rejects(client.evaluateStream('ModelWriter',otherInput).next());
    assert.equal(calls.length,2);
    await setModelClearance(f.db,{owner:principal.owner,provider:'Synthetic',model:'fixture-v1',clearance:{sensitivity:'INTERNAL',compartments:[]}});
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const pa=new Client({name:'function-stream-test',version:'1'});
    const received:string[]=[];
    allowSecond = new Promise<void>(resolve=>{releaseSecond=resolve;});
    try {
      await pa.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
        {requestInit:{headers:{Authorization:'Bearer '+token}}}));
      const reply=await pa.callTool({name:'stream_ontology_function',arguments:{function:'ModelWriter',input}},
        {signal:AbortSignal.timeout(20000),onprogress:({message})=>{
          if (message) received.push(message);
          if (message==='first') releaseSecond();
        }});
      assert(!reply.isError,JSON.stringify(reply.content));
      assert.deepEqual(received,['first','second']);
      assert.match(JSON.stringify(reply.content),/firstsecond/);
    } finally {releaseSecond();await pa.close();}
  } finally {releaseSecond();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});
