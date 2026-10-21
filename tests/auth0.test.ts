import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { auth0Plan, ensureAuth0ConnectionClients } from '../packages/members/auth0.js';

const { onExecutePostLogin } = createRequire(import.meta.url)('../integrations/auth0/post-login.cjs');

test('Auth0 blueprint binds two distinct clients and a short-lived, consented RFC 9068 resource', () => {
  const plan = auth0Plan('https://eigos.example');
  assert.equal(plan.api.token_dialect, 'rfc9068_profile'); assert.equal(plan.api.token_lifetime, 900);
  assert.equal(plan.api.skip_consent_for_verifiable_first_party_clients, false); assert.equal(plan.api.allow_offline_access, true);
  assert.equal(plan.portal.token_endpoint_auth_method, 'client_secret_post'); assert.equal(plan.agent.token_endpoint_auth_method, 'none');
  assert.notDeepEqual(plan.portal.callbacks, plan.agent.callbacks);
  assert.equal(plan.agent.is_first_party, true); assert.equal(plan.portal.is_first_party, true);
  assert.equal(plan.connector.token_endpoint_auth_method, 'none');
  assert(plan.connector.grant_types.includes('refresh_token')); assert(plan.connector.grant_types.includes('urn:ietf:params:oauth:grant-type:device_code'));
  assert.equal(plan.connector.refresh_token.rotation_type, 'rotating'); assert.equal(plan.connector.refresh_token.infinite_token_lifetime, false);
  assert.deepEqual(plan.agent.grant_types, ['authorization_code']);
  assert.equal(plan.tenantClaim, 'https://eigos.example/claims/tenant_id');
  assert(!plan.api.scopes.some(s => s.value.startsWith('sources:')));
  assert(!plan.api.scopes.some(s => s.value === 'ontology:admin'), 'Self-service OAuth setup cannot provision global ontology administration');
  assert.deepEqual(plan.api.scopes.filter(scope => scope.value.startsWith('ontology:')).map(scope => scope.value), ['ontology:read', 'ontology:write', 'ontology:publish', 'ontology:object_write']);
  assert.match(plan.api.scopes.find(scope => scope.value === 'ontology:object_write')!.description, /exact preview/);
  assert.match(plan.api.scopes.find(scope => scope.value === 'ontology:publish')!.description, /your own ontology/);
  assert.deepEqual(auth0Plan('https://eigos.example', undefined, { memberSources: true }).api.scopes.filter(s => s.value.startsWith('sources:')).map(s => s.value), ['sources:read', 'sources:write']);
  assert.throws(() => auth0Plan('http://eigos.example'));
  assert.throws(() => auth0Plan('https://eigos.example/path'));
  assert.throws(() => auth0Plan('https://eigos.example', 'https://attacker.example/callback'));
  assert.throws(() => auth0Plan('https://eigos.example', 'http://127.0.0.1/callback'));
});

test('Auth0 connector refresh grants cannot authorize fresh installation enrollment', async () => {
  for (const [protocol, allowed] of [['oauth2-device-code', true], ['oauth2-refresh-token', false], ['unknown', false]] as const) {
    const claims = new Map();
    await onExecutePostLogin({ client: { client_id: 'connector' }, resource_server: { identifier: 'https://eigos.example' }, transaction: { protocol }, secrets: {
      EIGOS_RESOURCE: 'https://eigos.example', EIGOS_TENANT_CLAIM: 'https://eigos.example/claims/tenant_id', EIGOS_TENANT_ID: 'personal', EIGOS_AGENT_CONNECTOR_CLIENT_ID: 'connector',
    } }, { idToken: { setCustomClaim: () => {} }, accessToken: { setCustomClaim: (key: string, value: unknown) => claims.set(key, value) }, access: { deny: () => assert.fail('Identity mapping should be valid') } });
    assert.equal(claims.get('https://eigos.example/claims/agent_enrollment'), allowed);
  }
});

test('the invite beta provisions only task scopes and a public native MCP authorization-code client with rotation', () => {
  const plan = auth0Plan('https://beta.example', undefined, { inviteBeta: true });
  assert.deepEqual(plan.api.scopes.map(scope => scope.value), ['services:read', 'tasks:read', 'tasks:write', 'members:write']);
  assert(plan.mcp); assert.equal(plan.mcp.token_endpoint_auth_method, 'none');
  assert.deepEqual(plan.mcp.callbacks, ['http://127.0.0.1/callback']);
  assert.deepEqual(plan.mcp.grant_types, ['authorization_code', 'refresh_token']);
  assert.equal(plan.mcp.refresh_token.rotation_type, 'rotating');
  assert.equal(plan.mcp.client_metadata.eigos_resource, 'https://beta.example');
  assert.notEqual(plan.mcp.client_metadata.eigos_component, plan.connector.client_metadata.eigos_component);
  assert.throws(() => auth0Plan('https://beta.example', undefined, { inviteBeta: true, memberSources: true }), /private supplier/);
});

async function action(clientId: string, resource?: string, configured = true) {
  const id = new Map(), access = new Map(); let denied = false;
  await onExecutePostLogin({ client: { client_id: clientId }, resource_server: resource ? { identifier: resource } : undefined,
    user: { user_metadata: { tenant_id: 'attacker' } }, secrets: {
      EIGOS_RESOURCE: 'https://eigos.example', EIGOS_MEMBER_CLIENT_ID: 'portal',
      EIGOS_TENANT_CLAIM: configured ? 'https://eigos.example/claims/tenant_id' : undefined, EIGOS_TENANT_ID: 'personal',
    } }, { idToken: { setCustomClaim: (key: string, value: string) => id.set(key, value) },
      accessToken: { setCustomClaim: (key: string, value: string) => access.set(key, value) }, access: { deny: () => { denied = true; } } });
  return { id, access, denied };
}

test('Auth0 Action preserves unrelated applications and uses only administrator-controlled tenant identity', async () => {
  const unrelated = await action('other', 'https://other.example'); assert.equal(unrelated.id.size, 0); assert.equal(unrelated.access.size, 0); assert(!unrelated.denied);
  const portal = await action('portal'); assert.equal(portal.id.get('https://eigos.example/claims/tenant_id'), 'personal'); assert.equal(portal.access.size, 0);
  const agent = await action('agent', 'https://eigos.example'); assert.equal(agent.id.get('https://eigos.example/claims/tenant_id'), 'personal'); assert.equal(agent.access.get('https://eigos.example/claims/tenant_id'), 'personal');
  const missing = await action('portal', undefined, false); assert(missing.denied); assert.equal(missing.id.size, 0);
});

test('Auth0 connection migration reads checkpoint pages and adds only missing clients', () => {
  const enabled = new Set(['unrelated-app', 'portal']);
  let patches = 0;
  const api = (method: 'get' | 'patch', path: string, body?: unknown) => {
    if (method === 'get') {
      if (!path.includes('&from=')) return { clients: [{ client_id: 'unrelated-app' }], next: 'page/2+token' };
      assert(path.endsWith('&from=page%2F2%2Btoken'));
      return { clients: [...enabled].filter(id => id !== 'unrelated-app').map(client_id => ({ client_id })) };
    }
    assert.equal(path, 'connections/con_test/clients');
    assert.deepEqual(body, [{ client_id: 'agent', status: true }]);
    patches++; enabled.add('agent');
  };
  ensureAuth0ConnectionClients(api, 'con_test', ['portal', 'agent']);
  ensureAuth0ConnectionClients(api, 'con_test', ['portal', 'agent']);
  assert.equal(patches, 1); assert(enabled.has('unrelated-app'));
});

test('Auth0 connection setup fails when enablement is not confirmed or pagination repeats', () => {
  assert.throws(() => ensureAuth0ConnectionClients(() => ({ clients: [] }), 'con_test', ['portal', 'agent']), /readback/);
  assert.throws(() => ensureAuth0ConnectionClients(() => ({ clients: [], next: 'same' }), 'con_test', ['portal', 'agent']), /repeated a cursor/);
});
