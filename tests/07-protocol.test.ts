import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { fixture, route, principal } from './fixture.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Ontology } from '../packages/ontology/model.js';
import { OntologyClient } from '../packages/sdk/client.js';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { jwtVerifier } from '../apps/gateway/auth.js';

test('MCP and A2A share the same authenticated PostgreSQL task and ontology', async () => {
  const f = await fixture(), token = 'synthetic-token-'.repeat(3);
  const config = readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token });
  const gateway = createApp(config, f.db, f.source), server = gateway.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: 'test-agent', version: '1' });
  try {
    assert.equal((await fetch(url + '/ontology')).status, 401);
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const result = await client.callTool({ name: 'submit_task', arguments: { requestId: 'protocol', message: '只询价', route } });
    const content = result.content as { text: string }[]; const task = JSON.parse(content[0]!.text);
    await f.worker.runOne();
    const response = await fetch(url + '/a2a', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: task.id } }) });
    const body = await response.json() as { result?: { id: string }; error?: unknown };
    assert.equal(body.result?.id, task.id, JSON.stringify(body));
  } finally { await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

test('JWT identity, audience and expiry are verified before owner queries', async () => {
  const keys = await generateKeyPair('ES256'), publicKey = await exportJWK(keys.publicKey);
  const verify = jwtVerifier('https://issuer.example', 'eigos', createLocalJWKSet({ keys: [{ ...publicKey, kid: 'test' }] }));
  const sign = (audience: string, expiry: string) => new SignJWT({ tenant_id: 'test', scope: 'tasks:read' }).setProtectedHeader({ alg: 'ES256', kid: 'test' }).setIssuer('https://issuer.example').setAudience(audience).setSubject('owner').setIssuedAt().setExpirationTime(expiry).sign(keys.privateKey);
  const actor = await verify(await sign('eigos', '1m'));
  assert.deepEqual(actor.scopes, ['tasks:read']);
  await assert.rejects(verify(await sign('another-audience', '1m')));
  await assert.rejects(verify(await sign('eigos', '-1m')));
});

test('production issuer tenant claims resolve the same owner without a fallback identity', async () => {
  const keys = await generateKeyPair('ES256'), publicKey = await exportJWK(keys.publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...publicKey, kid: 'test' }] }), claim = 'https://eigos.example/claims/tenant_id';
  const token = await new SignJWT({ [claim]: 'personal', scope: 'tasks:read tasks:write' }).setProtectedHeader({ alg: 'ES256', kid: 'test' })
    .setIssuer('https://issuer.example').setAudience('eigos').setSubject('owner').setIssuedAt().setExpirationTime('1m').sign(keys.privateKey);
  const actor = await jwtVerifier('https://issuer.example', 'eigos', jwks, claim)(token);
  assert.deepEqual(actor.scopes, ['tasks:read', 'tasks:write']);
  await assert.rejects(jwtVerifier('https://issuer.example', 'eigos', jwks)(token));
});

test('MCP publishes a model proposal and executes isolated, revision-checked scenarios in the selected Ontology', async () => {
  const f = await fixture(), token = 'model-acceptance-token-'.repeat(3), ontology = 'Alternate';
  const config = readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token });
  const server = createApp(config, f.db, f.source).app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const client = new Client({ name: 'ontology-model-acceptance', version: '1' });
  try {
    await setGrants(f.db, 'deployment', [{ resource: 'Eigos', permission: 'manage_definition' }, { resource: ontology, permission: 'manage_definition' }]);
    const document = structuredClone(f.model.document); document.id = ontology;
    const initial = await f.metadata.publish(document, f.capabilities, await Access.load(f.db, { owner: 'deployment', scopes: [] }));
    const reference = { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false };
    document.actionTypes.push({ apiName: 'CreateRoute', description: 'Create an acceptance route', parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'], additionalProperties: false }, objectParameters: {}, submissionCriteria: [], rules: [{ op: 'createObject', object: { type: 'Route', id: { parameter: 'id' } }, properties: { id: { parameter: 'id' }, name: { parameter: 'name' } } }], result: { type: 'Route', id: { parameter: 'id' } } });
    document.actionTypes.push({ apiName: 'RenameRoute', description: 'Rename an acceptance route', parameters: { type: 'object', properties: { route: reference, revision: { type: 'integer' }, name: { type: 'string' } }, required: ['route', 'revision', 'name'], additionalProperties: false }, objectParameters: { route: 'Route' }, submissionCriteria: [], rules: [{ op: 'editObject', object: { parameter: 'route' }, expectedRevision: { parameter: 'revision' }, properties: { name: { parameter: 'name' } } }], result: { type: 'Route', id: { parameter: 'route', path: ['id'] } } });
    document.actionTypes.push({ apiName: 'MergeRoute', description: 'Merge a reviewed acceptance route', parameters: { type: 'object', properties: { route: reference, scenarioId: { type: 'string' }, revision: { type: 'integer' } }, required: ['route', 'scenarioId', 'revision'], additionalProperties: false }, objectParameters: { route: 'Route' }, submissionCriteria: [], rules: [{ op: 'applyScenario', scenario: { parameter: 'scenarioId' }, expectedRevision: { parameter: 'revision' }, objectTypes: ['Route'], linkTypes: [] }], result: { type: 'Route', id: { parameter: 'route', path: ['id'] } } });
    const create = document.actionTypes.find(action => action.apiName === 'CreateRoute')!;
    const rename = document.actionTypes.find(action => action.apiName === 'RenameRoute')!;
    document.interfaceTypes.push({ apiName: 'EditableRoute', description: 'Routes with shared create and rename capabilities',
      properties: {}, optionalProperties: [], links: {}, actions: {
        create: { parameters: create.parameters, objectParameters: {}, required: true },
        rename: { parameters: rename.parameters, objectParameters: { route: 'EditableRoute' }, required: true },
      } });
    document.objectTypes.find(type => type.apiName === 'Route')!.interfaces.EditableRoute = {
      properties: {}, links: {}, actions: {
        create: { action: 'CreateRoute', parameters: { id: 'id', name: 'name' } },
        rename: { action: 'RenameRoute', parameters: { route: 'route', revision: 'revision', name: 'name' } },
      } };
    await setGrants(f.db, principal.owner, [...memberGrants(f.model), ...memberGrants(new Ontology(document)), { resource: ontology, permission: 'manage_definition' }]);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      assert(!response.isError, JSON.stringify(response));
      return JSON.parse((response.content as { text: string }[])[0]!.text);
    };
    const branch = await call('ontology_create_branch', { ontology, name: 'Runnable model proposal', body: document });
    const prepared = await call('ontology_prepare_branch', { id: branch.id, revision: branch.revision });
    assert.equal((await f.metadata.active(ontology)).release, initial.release);
    const reviewed = await call('ontology_review_branch', { id: prepared.id, revision: prepared.revision, release: prepared.release });
    await call('ontology_merge_branch', { id: reviewed.id, revision: reviewed.revision, release: reviewed.release });
    const active = await f.metadata.active(ontology);
    assert.equal(active.release, prepared.release);
    assert.equal((await f.metadata.active()).release, f.model.release);
    assert((await call('describe_ontology', { ontology })).actionTypes.some((item: { apiName: string }) => item.apiName === 'RenameRoute'));
    const sdk = new OntologyClient({ baseUrl: `http://127.0.0.1:${address.port}`, token, ontology });
    const creation = { implementation: 'Route', type: 'EditableRoute', action: 'create' };
    const ref = await sdk.apply({ requestId: 'create-route', interface: creation, input: { id: 'selected-route', name: 'Before' } });
    assert.deepEqual(await call('apply_ontology_action', { ontology, requestId: 'create-route', action: 'CreateRoute', input: { id: 'selected-route', name: 'Before' } }), ref);
    for (const target of [
      {}, { action: 'CreateRoute', interface: creation },
      { interface: { ...creation, object: ref } },
      { interface: { type: 'EditableRoute', action: 'create' } },
    ]) {
      const invalid = await client.callTool({ name: 'apply_ontology_action', arguments: {
        ontology, requestId: 'invalid-target', input: { id: 'invalid-route', name: 'Invalid' }, ...target,
      } });
      assert(invalid.isError, JSON.stringify(invalid));
    }
    const scene = await call('create_scenario', { ontology, requestId: 'model-scenario', name: 'Proposed route' });
    assert.equal(scene.release, active.release);
    assert.equal(typeof scene.revision, 'number'); assert(Number.isFinite(Date.parse(scene.expiresAt)));
    const listed = (await call('list_scenarios', { ontology })).items[0];
    assert.equal(listed.id, scene.id); assert.equal(listed.revision, scene.revision); assert.equal(listed.expiresAt, scene.expiresAt);
    assert.equal((await sdk.listScenarios()).items[0]!.expiresAt, scene.expiresAt);
    assert.deepEqual((await call('list_scenarios', {})).items, []);
    assert((await client.callTool({ name: 'inspect_scenario', arguments: { scenarioId: scene.id } })).isError);
    await sdk.scenario(scene.id).apply({ requestId: 'rename-route',
      interface: { object: ref, type: 'EditableRoute', action: 'rename' }, input: { route: ref, revision: 1, name: 'After' } });
    assert.deepEqual(await call('apply_ontology_action', { ontology, scenarioId: scene.id, requestId: 'rename-route', action: 'RenameRoute', input: { route: ref, revision: 1, name: 'After' } }), ref);
    await assert.rejects(sdk.scenario(scene.id).apply({ requestId: 'wrong-interface-object',
      interface: { object: { type: 'Route', id: 'another-route' }, type: 'EditableRoute', action: 'rename' },
      input: { route: ref, revision: 1, name: 'Unbound' } }), /bind the selected object/);
    const query = { type: 'Route', where: { id: ref.id } };
    assert.equal((await call('query_ontology', { ontology, query })).items[0].properties.name, 'Before');
    assert.equal((await call('query_ontology', { ontology, scenarioId: scene.id, query })).items[0].properties.name, 'After');
    assert.equal((await call('query_ontology', { query })).items.length, 0);
    const inspected = await call('inspect_scenario', { ontology, scenarioId: scene.id });
    const stale = await client.callTool({ name: 'apply_ontology_action', arguments: { ontology, requestId: 'stale-merge', action: 'MergeRoute', input: { route: ref, scenarioId: scene.id, revision: inspected.revision - 1 } } });
    assert(stale.isError);
    assert.equal((await call('query_ontology', { ontology, query })).items[0].properties.name, 'Before');
    await call('apply_ontology_action', { ontology, requestId: 'reviewed-merge', action: 'MergeRoute', input: { route: ref, scenarioId: scene.id, revision: inspected.revision } });
    assert.equal((await call('query_ontology', { ontology, query })).items[0].properties.name, 'After');
    const row = (await f.db.query(`SELECT properties,revision FROM ${f.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [active.projection, principal.owner, ref.type, ref.id])).rows[0]!;
    assert.equal(row.properties.name, 'After'); assert.equal(Number(row.revision), 2);
    const discarded = await call('create_scenario', { ontology, requestId: 'discard-model-scenario', name: 'Discarded alternative' });
    await call('discard_scenario', { ontology, scenarioId: discarded.id, revision: discarded.revision });
    assert.deepEqual((await call('list_scenarios', { ontology })).items, []);
    await setGrants(f.db, principal.owner, [...memberGrants(f.model), ...memberGrants(active)
      .filter(grant => !(grant.resource === ontology && grant.permission === 'view_definition')),
      { resource: `${ontology}/object/Route`, permission: 'view_definition' },
      { resource: `${ontology}/action/CreateRoute`, permission: 'view_definition' }]);
    await assert.rejects(sdk.apply({ requestId: 'revoked-interface', interface: creation,
      input: { id: 'revoked-route', name: 'Revoked' } }), /Permission/);
    assert.deepEqual((await sdk.query({ type: 'Route', where: { id: 'revoked-route' } })).items, []);
    assert.deepEqual(await sdk.apply({ requestId: 'concrete-still-authorized', action: 'CreateRoute',
      input: { id: 'direct-route', name: 'Direct' } }), { type: 'Route', id: 'direct-route' });
  } finally { await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});
