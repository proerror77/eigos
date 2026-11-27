import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCapabilities } from '../packages/capabilities/index.js';
import { PermissionDenied } from '../packages/core/identity.js';
import type { OntologyDocument } from '../packages/ontology/schema.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { ComponentFunctions, componentWorld } from '../packages/runtime/component-functions.js';
import { ComponentSourceEgress } from '../packages/runtime/component-source-egress.js';
import { Clarification } from '../packages/runtime/clarification.js';
import { Objects } from '../packages/runtime/objects.js';
import { PARequests } from '../packages/runtime/pa.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { fixture, principal } from './fixture.js';

const actionName = 'PublishWarehouseRoute';
const grant = { resource: 'Eigos/source/WarehouseUpdates', permission: 'dispatch_source' as const };

function action(formatter?: string, classification?: 'CONFIDENTIAL'): OntologyDocument['actionTypes'][number] {
  return {
    apiName: actionName, description: 'Record a route and queue the warehouse webhook',
    ...(classification ? { classification: { sensitivity: classification, compartments: [] } } : {}),
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    objectParameters: {}, submissionCriteria: [],
    rules: [{ op: 'createObject', object: { type: 'Route', id: { parameter: 'id' } },
      properties: { id: { parameter: 'id' }, name: { literal: 'Synthetic route' } } }],
    result: { type: 'Route', id: { parameter: 'id' } },
    effects: [{
      name: 'NotifyWarehouse', webhook: { source: 'WarehouseUpdates', method: 'POST', path: '/api/routes', function: formatter },
      payload: formatter ? { answer: { parameter: 'id' } } : { id: { parameter: 'id' } },
    }],
  };
}

function source(transport: NonNullable<ConstructorParameters<typeof ComponentSourceEgress>[1]>, endpoint = 'https://warehouse.example.com/api/') {
  return {
    egress: new ComponentSourceEgress({ WarehouseUpdates: {
      baseUrl: endpoint, methods: ['POST'], bearerSecret: 'warehouse',
      webhooks: [{ method: 'POST', path: '/api/routes', clearance: { sensitivity: 'INTERNAL' } }],
    } }, transport, () => {}),
    secrets: { async get(name: string) { assert.equal(name, 'warehouse'); return 'synthetic-warehouse-auth'; } },
  };
}

test('only a committed and still authorized Action delivers its webhook with a stable request on retry', async () => {
  const f = await fixture();
  try {
    const requests: { id: string; body?: string }[] = [];
    const capabilities = createCapabilities(f.db, f.source, { componentSources: source(async (target, options) => {
      assert.equal(target.href, 'https://warehouse.example.com/api/routes');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization, 'Bearer synthetic-warehouse-auth');
      const { id } = JSON.parse(options.body!);
      const { rows: [committed] } = await f.db.query(`SELECT action FROM ${f.db.schema}.actions WHERE owner=$1 AND request_id=$2`, [principal.owner, id]);
      assert.equal(committed?.action, actionName);
      const { rows: [effect] } = await f.db.query(`SELECT payload FROM ${f.db.schema}.action_effects WHERE id=$1`, [options.headers['idempotency-key']]);
      assert.equal(effect?.payload.body, options.body);
      requests.push({ id: options.headers['idempotency-key']!, body: options.body });
      if (requests.length === 1) throw new Error('synthetic response lost');
      return { status: 204, contentType: null, body: '' };
    }) });
    const definition = structuredClone(f.model.document);
    definition.actionTypes.push(action());
    await assert.rejects(f.metadata.prepare(definition, f.capabilities, f.publisher), /handler is unavailable/);
    const model = await f.metadata.publish(definition, capabilities, f.publisher);
    const grants = businessGrants(model);
    await setGrants(f.db, principal.owner, grants);
    const apply = async (id: string, actor?: { kind: 'workflow'; id: string }) =>
      capabilities.actions.apply(await Access.load(f.db, principal), model, actionName, { id }, id, undefined, undefined, undefined, actor);

    assert(!(await Access.load(f.db, principal)).describe(model, true).actionTypes.some(entry => entry.apiName === actionName));
    await assert.rejects(apply('denied'), PermissionDenied);
    assert.deepEqual(await capabilities.effects.status(await Access.load(f.db, principal), 'denied'), []);
    await assert.rejects(new Objects(f.db, model, await Access.load(f.db, principal)).read({ type: 'Route', id: 'denied' }), /unavailable/);
    await setGrants(f.db, principal.owner, [...grants, grant]);
    assert((await Access.load(f.db, principal)).describe(model, true).actionTypes.some(entry => entry.apiName === actionName));
    await assert.rejects(apply('unapproved-workflow', { kind: 'workflow', id: 'synthetic' }), /requires explicit approval/);
    const access = await Access.load(f.db, principal);
    const scenario = await new Scenarios(f.db).create(access, model, { requestId: 'preview', name: 'Preview only' });
    const view = await new Scenarios(f.db).view(access, model, scenario.id);
    await capabilities.actions.apply(access, view, actionName, { id: 'preview' }, 'preview');
    assert.equal(await capabilities.effects.runOne(), false);

    assert.deepEqual(await apply('committed'), { type: 'Route', id: 'committed' });
    await apply('committed');
    assert.deepEqual(requests, []);
    assert(await capabilities.effects.runOne());
    const [failed] = await capabilities.effects.status(await Access.load(f.db, principal), 'committed');
    assert.equal(failed?.state, 'failed');
    await capabilities.effects.retry(await Access.load(f.db, principal), failed!.id);
    assert(await capabilities.effects.runOne());
    assert.deepEqual(requests, Array(2).fill({ id: failed!.id, body: '{"id":"committed"}' }));
    assert.equal((await capabilities.effects.status(await Access.load(f.db, principal), 'committed'))[0]?.state, 'completed');

    await apply('changed-destination');
    const drift = createCapabilities(f.db, f.source, { componentSources: source(async () => {
      assert.fail('a changed Source binding must not dispatch');
    }, 'https://other-warehouse.example.com/api/') });
    assert(await drift.effects.runOne());
    assert.equal((await capabilities.effects.status(await Access.load(f.db, principal), 'changed-destination'))[0]?.state, 'failed');
    await apply('revoked');
    await setGrants(f.db, principal.owner, grants);
    assert(await capabilities.effects.runOne());
    assert.equal((await capabilities.effects.status(await Access.load(f.db, principal), 'revoked'))[0]?.state, 'failed');
    assert.equal(requests.length, 2);
  } finally { await f.close(); }
});

test('a webhook cannot disclose an Action above its destination clearance', async () => {
  const f = await fixture();
  try {
    const capabilities = createCapabilities(f.db, f.source, { componentSources: source(async () => assert.fail('blocked')) });
    const definition = structuredClone(f.model.document);
    definition.actionTypes.push(action(undefined, 'CONFIDENTIAL'));
    const model = await f.metadata.publish(definition, capabilities, f.publisher);
    await setGrants(f.db, principal.owner, [...businessGrants(model), grant]);
    const access = await Access.load(f.db, principal);
    await assert.rejects(capabilities.actions.apply(access, model, actionName, { id: 'classified' }, 'classified'), /destination policy/);
    assert.equal(await capabilities.effects.runOne(), false);
    await assert.rejects(new Objects(f.db, model, access).read({ type: 'Route', id: 'classified' }), /unavailable/);
  } finally { await f.close(); }
});

test('a published Wasm formatter renders the body only when its Action outbox runs', {
  skip: !process.env.EIGOS_FUNCTION_HOST_BIN || !process.env.EIGOS_FUNCTION_HOST_FIXTURES,
}, async () => {
  const f = await fixture();
  try {
    const seen: Record<string, unknown>[] = [], formatter = 'FormatWarehouseBody';
    const capabilities = createCapabilities(f.db, f.source, { componentSources: source(async (_target, options) => {
      seen.push(JSON.parse(options.body!));
      return { status: 200, contentType: 'application/json', body: '{}' };
    }) });
    const wasm = await readFile(join(process.env.EIGOS_FUNCTION_HOST_FIXTURES!, 'echo_rust.wasm'));
    const { sha256, world } = await new ComponentFunctions(f.db).upload(wasm, principal);
    assert.equal(world, componentWorld);
    const definition = structuredClone(f.model.document), webhook = action(formatter);
    const effect = webhook.effects![0]!;
    effect.payload = { answer: { literal: { event: 'route.created', sample: true } } };
    definition.actionTypes.push(webhook);
    definition.functionTypes.push({
      apiName: formatter, version: '1.0.0', description: 'Format a synthetic webhook',
      parameters: { type: 'object' }, returns: { type: 'object' },
      implementation: { kind: 'component', sha256, limits: { fuel: 10_000_000, memoryMb: 64, deadlineMs: 2000 } },
    });
    const model = await f.metadata.publish(definition, capabilities, f.publisher);
    await setGrants(f.db, principal.owner, [...businessGrants(model), grant]);
    await capabilities.actions.apply(await Access.load(f.db, principal), model, actionName, { id: 'formatted' }, 'formatted');
    assert.deepEqual(seen, []);
    assert(await capabilities.effects.runOne());
    assert.deepEqual(seen, [{ event: 'route.created', sample: true }]);
    assert.equal((await capabilities.effects.status(await Access.load(f.db, principal), 'formatted'))[0]?.state, 'completed');
  } finally { await f.close(); }
});

test('a task resumes its original Action webhook only after the PA approves that exact request', async () => {
  const f = await fixture();
  try {
    const sent: unknown[] = [];
    const capabilities = createCapabilities(f.db, f.source, { componentSources: source(async (_url, options) => {
      sent.push(JSON.parse(options.body!));
      return { status: 204, contentType: null, body: '' };
    }) });
    const definition = structuredClone(f.model.document);
    definition.actionTypes.push(action());
    const model = await f.metadata.publish(definition, capabilities, f.publisher);
    await setGrants(f.db, principal.owner, [...businessGrants(model), grant]);
    const access = () => Access.load(f.db, principal);
    for (const approved of [false, true]) {
      const id = approved ? 'approved-task' : 'declined-task';
      await f.tasks.submit(principal, { requestId: id, message: 'Synthetic warehouse webhook' }, { expectedRelease: model.release });
      const first = await f.tasks.claim();
      assert(first);
      const signal = AbortSignal.timeout(10_000);
      const waiting = await capabilities.actions.complete(await access(), model, { action: actionName, input: { id } }, id,
        undefined, { task: first, tasks: f.tasks }, signal, { allowPause: true }).then(
          () => assert.fail('the Action must wait for authorization'),
          (error: unknown) => { assert(error instanceof Clarification); return error; },
        );
      const choices = waiting.choices as { requestId: string; purpose: string; input: { digest: string; requestId: string } };
      assert.equal(choices.purpose, 'authorization');
      assert.equal(choices.input.requestId, id);
      await f.tasks.finish(first, 'input-required', waiting.choices, waiting.message, waiting.permissions, waiting.continuation);
      assert.equal(await capabilities.effects.runOne(), false);
      const pa = new PARequests(f.tasks);
      await assert.rejects(pa.respond(principal, first.id, { requestId: choices.requestId, response: { approved: true, digest: 'changed' } }));
      await pa.respond(principal, first.id, { requestId: choices.requestId, response: { approved, digest: choices.input.digest } });
      const original = await f.tasks.claim();
      assert(original);
      assert.equal(original.id, first.id);
      const resumed = capabilities.actions.resume(await access(), model, { task: original, tasks: f.tasks }, signal);
      if (approved) {
        const result = await resumed;
        assert.deepEqual(result, { type: 'Route', id });
        await f.tasks.finish(original, 'completed', result);
        assert(await capabilities.effects.runOne());
      } else {
        await assert.rejects(resumed, /declined/);
        await f.tasks.finish(original, 'failed', null, 'Synthetic authorization declined');
        assert.equal(await capabilities.effects.runOne(), false);
      }
    }
    assert.deepEqual(sent, [{ id: 'approved-task' }]);
  } finally { await f.close(); }
});
