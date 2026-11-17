import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { developmentSandboxEnabled } from '../packages/core/sandbox-mode.js';
import { sandboxAgentCapability } from '../packages/ontology/agent-profiles.js';
import { businessGrants, setGrants } from '../packages/runtime/access.js';
import { document, fixture, principal } from './fixture.js';

test('sandbox opt-in is available in loopback development only', () => {
  const enabled = { EIGOS_AUTH_MODE: 'development', EIGOS_AGENT_SANDBOX_ENABLED: 'true' };
  assert.equal(developmentSandboxEnabled(enabled), true);
  assert.equal(developmentSandboxEnabled({ ...enabled, EIGOS_AUTH_MODE: 'jwt' }), false);
  assert.equal(developmentSandboxEnabled({ ...enabled, NODE_ENV: 'production' }), false);
  assert.equal(developmentSandboxEnabled({ ...enabled, HOST: '0.0.0.0' }), false);
  assert.equal(developmentSandboxEnabled({ EIGOS_AUTH_MODE: 'development' }), false);
});

test('HTTP and MCP deny tagged and legacy sandbox capabilities even with stored grants', async () => {
  const definition = structuredClone(document);
  const legacyAction = definition.actionTypes.find(action => action.apiName === 'CreateStripeSandboxOrder')!;
  const legacyFunction = definition.functionTypes.find(fn => fn.apiName === legacyAction.function)!;
  delete legacyAction.typeClasses;
  delete legacyFunction.typeClasses;
  const tagged = definition.actionTypes.find(action => action.apiName === 'RegisterGeometry')!;
  tagged.typeClasses = [sandboxAgentCapability];
  const f = await fixture(undefined, undefined, undefined, definition);

  const token = 'synthetic-jwt-fixture';
  const config = readConfig({
    DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL,
    OAUTH_ISSUER: 'https://issuer.example.test',
    OAUTH_AUDIENCE: 'synthetic-audience',
    OAUTH_JWKS_URL: 'https://issuer.example.test/.well-known/jwks.json',
  });
  const gateway = createApp(config, f.db, f.source, async received => {
    assert.equal(received, token);
    return principal;
  });
  const server = gateway.app.listen(0, '127.0.0.1');
  const client = new Client({ name: 'sandbox-admission-test', version: '1' });
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const url = 'http://127.0.0.1:' + address.port;
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const resources = [legacyAction.apiName, legacyFunction.apiName, 'readDiningReservation', tagged.apiName, 'StripeSandboxOrder', 'StripeSandbox'];
    const deniedByDefault = (name: string) => !businessGrants(f.model).some(grant => grant.resource.endsWith('/' + name));
    assert(resources.every(deniedByDefault));
    // Preserve the pre-upgrade grant rows to verify runtime admission also checks the environment.
    const legacyGrants = businessGrants(f.model, true);
    assert(resources.every(name => legacyGrants.some(grant => grant.resource.endsWith('/' + name))));
    await setGrants(f.db, principal.owner, legacyGrants);

    const post = (path: string, input: unknown) => fetch(url + path, {
      method: 'POST', headers, body: JSON.stringify(input),
    });
    const sandboxAction = { requestId: randomUUID(), action: legacyAction.apiName, input: { orderKey: randomUUID() } };
    const sandboxRead = {
      function: 'readDiningReservation',
      input: { reservation: { type: 'DiningReservation', id: 'synthetic-reservation' } },
    };
    const calls = [
      ['/ontology/actions', sandboxAction],
      ['/ontology/actions', { requestId: randomUUID(), action: tagged.apiName, input: {} }],
      ['/ontology/functions', sandboxRead],
      ['/ontology/functions', { function: legacyFunction.apiName, input: sandboxAction.input }],
      ['/ontology/services/validate_action', { action: legacyAction.apiName, input: sandboxAction.input }],
    ] as const;
    for (const [path, input] of calls) {
      const response = await post(path, input);
      assert.equal(response.status, 403, path);
      assert.match((await response.json() as { error: string }).error, /requires explicit sandbox development mode/);
    }

    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
      requestInit: { headers: { Authorization: headers.Authorization } },
    }));
    for (const [name, args] of [['apply_ontology_action', sandboxAction], ['evaluate_ontology', sandboxRead]] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.equal((result.structuredContent as {status: number}).status, 403);
    }
    const description = await fetch(url + '/ontology', { headers }).then(response => response.text());
    for (const name of resources) assert(!description.includes(name), name);
    assert(description.includes('EstimateRide'));
    const query = await post('/ontology/query', { query: { type: 'Route' } });
    assert.equal(query.status, 200);

    const {rows: [counts]} = await f.db.query('SELECT (SELECT count(*)::int FROM ' + f.db.schema + '.actions) AS actions,' +
      '(SELECT count(*)::int FROM ' + f.db.schema + '.external_operations) AS operations');
    assert.deepEqual(counts, { actions: 0, operations: 0 });
  } finally {
    await client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
});
