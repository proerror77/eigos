import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { auth0Plan } from '../packages/members/auth0.js';

const { onExecutePostLogin } = createRequire(import.meta.url)('../integrations/auth0/post-login.cjs');

test('Auth0 blueprint binds two distinct clients and a short-lived, consented RFC 9068 resource', () => {
  const plan = auth0Plan('https://eigos.example');
  assert.equal(plan.api.token_dialect, 'rfc9068_profile'); assert.equal(plan.api.token_lifetime, 900);
  assert.equal(plan.api.skip_consent_for_verifiable_first_party_clients, false); assert.equal(plan.api.allow_offline_access, false);
  assert.equal(plan.portal.token_endpoint_auth_method, 'client_secret_post'); assert.equal(plan.agent.token_endpoint_auth_method, 'none');
  assert.notDeepEqual(plan.portal.callbacks, plan.agent.callbacks);
  assert.equal(plan.agent.is_first_party, false); assert.deepEqual(plan.agent.grant_types, ['authorization_code']);
  assert.equal(plan.tenantClaim, 'https://eigos.example/claims/tenant_id');
  assert.throws(() => auth0Plan('http://eigos.example'));
  assert.throws(() => auth0Plan('https://eigos.example/path'));
  assert.throws(() => auth0Plan('https://eigos.example', 'https://attacker.example/callback'));
  assert.throws(() => auth0Plan('https://eigos.example', 'http://127.0.0.1/callback'));
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
