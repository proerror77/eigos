import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { createApp } from '../apps/gateway/app.js';
import { Worker } from '../apps/worker/worker.js';
import { readConfig } from '../packages/core/config.js';
import { Conflict, FunctionFailed, PermissionDenied, ResourceExhausted, ServiceUnavailable } from '../packages/core/identity.js';
import type { OntologyDocument } from '../packages/ontology/schema.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { OntologyAgent } from '../packages/runtime/agent.js';
import { ComponentFunctions, type ComponentImplementation } from '../packages/runtime/component-functions.js';
import { FunctionHostClient } from '../packages/runtime/function-host.js';
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
    assert.equal(world, 'eigos:function/handler@0.1.0');
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
    await assert.rejects(publish(echoFunction(sha256, { edits: true })), /cannot read a source or edit objects/);
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
