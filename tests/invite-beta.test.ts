import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { SCOPES, TASK_SCOPES, type Job, type Principal } from '../packages/core/domain.js';
import { validateInviteBetaProxy } from '../packages/deployment/invite-beta-proxy.js';

const env = (directory: string, origin = 'https://beta.example'): NodeJS.ProcessEnv => ({
  EIGOS_INVITE_BETA: 'true', EIGOS_AUTH_MODE: 'jwt', PUBLIC_URL: origin, OAUTH_AUDIENCE: origin,
  OAUTH_ISSUER: 'https://identity.example/', OAUTH_JWKS_URL: 'https://identity.example/jwks',
  OIDC_CLIENT_ID: 'portal', OIDC_AGENT_CLIENT_ID: 'device-connector', OIDC_MCP_CLIENT_ID: 'native-mcp',
  DATABASE_PATH: join(directory, 'tasks.sqlite'), MEMBERSHIP_DATABASE_PATH: join(directory, 'members.sqlite'),
  EIGOS_MEMBERSHIP_APPROVAL: 'invite-only', EIGOS_EXECUTOR: 'codex', HOST: '127.0.0.1',
});

test('invite beta rejects self-service, borrowed credentials, supplier sources and transaction configuration for both processes', () => {
  const valid = env(join(tmpdir(), 'invite-beta-config'));
  for (const parse of [readConfig, readWorkerConfig]) {
    assert.equal(parse(valid).EIGOS_INVITE_BETA, 'true');
    for (const change of [
      { EIGOS_MEMBERSHIP_APPROVAL: 'self-service' }, { EIGOS_AUTH_MODE: 'development' }, { OAUTH_AUDIENCE: 'https://private.example' },
      { OIDC_MCP_CLIENT_ID: undefined }, { DATABASE_PATH: ':memory:' }, { EIGOS_EXECUTOR: 'disabled' },
      { EIGOS_DEV_TOKEN: 'x'.repeat(40) }, { EIGOS_PAOTUI_SKILL_DIR: '/private/account' },
      { EIGOS_MEMBER_SOURCE_KEY_FILE: '/private/source.key' }, { EIGOS_PAOTUI_MEMBER_CONNECTION_FILE: '/private/connection.json' },
      { EIGOS_NETWORK_ENABLED: 'true' }, { EIGOS_CSV_PILOT: 'true' }, { EIGOS_ACTION_SANDBOX: 'true' },
      { EIGOS_COMMERCE_SANDBOX_URL: 'http://127.0.0.1:9999' }, { EIGOS_BOOKING_SANDBOX_TOKEN_FILE: '/private/token' },
      { EIGOS_STRIPE_TEST_SECRET_KEY_FILE: '/private/stripe' },
    ]) assert.throws(() => parse({ ...valid, ...change }), Error, JSON.stringify(change));
  }
});

test('public beta deployment verifies its exact proxy without requiring changes to existing private listeners', () => {
  const config = readConfig({ ...env(join(tmpdir(), 'invite-beta-proxy'), 'https://beta.tailnet.ts.net:10000'), PORT: '3212' });
  const snapshot = { TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true }, '10000': { HTTPS: true } },
    Web: { 'beta.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3210' } } }, 'beta.tailnet.ts.net:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3212' } } } },
    AllowFunnel: { 'beta.tailnet.ts.net:443': true, 'beta.tailnet.ts.net:10000': true } };
  validateInviteBetaProxy(config, snapshot);
  assert.throws(() => validateInviteBetaProxy(config, { ...snapshot, AllowFunnel: {} }), /dedicated/);
  assert.throws(() => validateInviteBetaProxy(config, { ...snapshot, Web: { 'beta.tailnet.ts.net:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3210' } } } } }), /dedicated/);
  assert.throws(() => validateInviteBetaProxy(config, { ...snapshot, Web: { 'beta.tailnet.ts.net:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3212' }, '/private': { Proxy: 'http://127.0.0.1:3210' } } } } }), /dedicated/);
});

test('invited native MCP members share protocol access but cannot cross owners, gain modeling scopes or restore a revoked connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-invite-beta-'));
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, config = readConfig(env(directory, `https://127.0.0.1:${address.port}`));
  const principal = (subject: string, clientId = 'native-mcp'): Principal => ({ issuer: 'https://identity.example/', tenant: 'personal', subject, clientId, scopes: [...SCOPES] });
  const gateway = createApp(config, async token => {
    if (!['alice', 'alice-refreshed', 'bob', 'unapproved-client'].includes(token)) throw new Error('Invalid fixture token');
    return token === 'unapproved-client' ? principal('alice', 'different-client') : principal(token.startsWith('alice') ? 'alice' : 'bob');
  });
  server.on('request', gateway.app);
  const request = (path: string, token?: string, body?: object) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json', 'A2A-Version': '1.0' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const clients: Client[] = [];
  try {
    assert.equal((await request('/mcp')).status, 401);
    const metadata = await (await request('/.well-known/oauth-protected-resource')).json();
    assert.deepEqual(metadata.scopes_supported, ['openid', 'offline_access', ...TASK_SCOPES]);
    const landing = await (await request('/')).text();
    assert.match(landing, /client_id = &quot;native-mcp&quot;/);
    assert.match(landing, /callback_port = 64517/);
    assert.match(landing, /http:\/\/127\.0\.0\.1:64517\/callback/);
    assert.equal((await request('/.well-known/eigos-pa-payment')).status, 404);
    assert(!JSON.stringify(await (await request('/.well-known/agent-card.json')).json()).includes('eigos-pa-payment'));
    const alice = gateway.members.login(principal('alice'));
    gateway.members.apply(alice.id, { displayName: 'Alice fixture', locale: 'en', timezone: 'UTC', consent: true }, true);
    assert.equal((await request('/mcp', 'alice')).status, 403);
    const invitation = gateway.members.agents.invite(alice.id);
    const bob = gateway.members.login(principal('bob'));
    gateway.members.apply(bob.id, { displayName: 'Bob fixture', locale: 'en', timezone: 'UTC', consent: true }, true);
    assert.throws(() => gateway.members.agents.redeemForMember(bob.id, invitation.token));
    gateway.members.agents.redeemForMember(alice.id, invitation.token);
    gateway.members.agents.redeemForMember(bob.id, gateway.members.agents.invite(bob.id).token);
    assert.equal((await request('/mcp', 'unapproved-client')).status, 403);
    for (const token of ['alice', 'bob']) {
      const client = new Client({ name: `invite-beta-${token}`, version: '1' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    }
    const tools = (await clients[0]!.listTools()).tools.map(tool => tool.name);
    for (const forbidden of ['manage_ontology_definitions', 'prepare_ontology_action', 'select_payment_route', 'report_payment_result', 'begin_source_connection']) assert(!tools.includes(forbidden), forbidden);
    const response = await clients[0]!.callTool({ name: 'submit_task', arguments: { goal: 'Prepare a task brief for a supplied agenda', requestId: randomUUID() } });
    assert(!response.isError); const job = (response.structuredContent as { result: Job }).result;
    assert((await clients[1]!.callTool({ name: 'get_task', arguments: { taskId: job.id } })).isError);
    const other = await (await request('/a2a', 'bob', { jsonrpc: '2.0', id: 'cross-owner', method: 'GetTask', params: { id: job.id } })).json();
    assert(other.error && !other.result);
    const own = await (await request('/a2a', 'alice', { jsonrpc: '2.0', id: 'own-task', method: 'GetTask', params: { id: job.id } })).json();
    assert.equal(own.result.id, job.id);
    const modeling = await request('/ontology/v1/commands', 'alice', { operation: 'create_ontology', id: 'unauthorized', name: 'Should be denied' });
    assert.equal(modeling.status, 403, 'Even a signed over-scoped identity is limited to the beta task surface');
    const connection = gateway.members.connections(alice.id)[0]!; gateway.members.block(alice.id, connection.id, true);
    assert.equal((await request('/mcp', 'alice')).status, 403);
    assert.equal((await request('/mcp', 'alice-refreshed')).status, 403);
    assert(!(await clients[1]!.callTool({ name: 'list_tasks', arguments: {} })).isError);
  } finally {
    for (const client of clients) await client.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await gateway.close(); rmSync(directory, { recursive: true, force: true });
  }
});
