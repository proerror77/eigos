import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/gateway/app.js';
import { readConfig, type Config } from '../packages/core/config.js';
import { PA_SKILL_FILES, paConnectionInfo, paOnboardingAvailable, paSkillArchive, paSkillFiles } from '../packages/members/pa-onboarding.js';

const secret = 'fixture-private-secret-never-publish';
const config = (directory: string, extra: Partial<Config> = {}): Config => ({
  ...readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32), DATABASE_PATH: join(directory, 'tasks.sqlite') }),
  EIGOS_AUTH_MODE: 'jwt', EIGOS_DEV_TOKEN: undefined, PUBLIC_URL: 'https://eigos.example',
  OAUTH_ISSUER: 'https://identity.example/', OAUTH_JWKS_URL: 'https://identity.example/jwks', OAUTH_AUDIENCE: 'https://eigos.example',
  OIDC_CLIENT_ID: 'member-portal', OIDC_CLIENT_SECRET: secret, OIDC_AGENT_CLIENT_ID: 'public-agent', OIDC_MCP_CLIENT_ID: 'public-native',
  ...extra,
});

test('connection metadata publishes configured paths and public client IDs, independently of private configuration', () => {
  const c = config('/private/runtime'), info = paConnectionInfo(c);
  assert.equal(info.transports.mcp?.url, c.PUBLIC_URL + '/mcp');
  assert.equal(info.transports.a2a?.registration, c.PUBLIC_URL + '/.well-known/eigos-agent-registration');
  assert.equal(info.links.permissions, undefined);
  assert.deepEqual(info.transports.mcp?.scopes, ['openid', 'offline_access', 'services:read', 'tasks:read', 'tasks:write']);
  for (const value of [secret, '/private/runtime', 'tasks.sqlite', c.OAUTH_JWKS_URL!]) assert(!JSON.stringify(info).includes(value));
  const a2a = paConnectionInfo({ ...c, OIDC_MCP_CLIENT_ID: undefined, EIGOS_SECURITY_MODE: 'foundation' });
  assert.equal(a2a.transports.mcp, undefined); assert.equal(a2a.links.permissions, c.PUBLIC_URL + '/members/permissions');
  const nativeOnly = { ...c, OIDC_AGENT_CLIENT_ID: undefined };
  assert.equal(paConnectionInfo(nativeOnly).transports.a2a, undefined); assert(paOnboardingAvailable(nativeOnly));
  assert(!paOnboardingAvailable({ ...nativeOnly, EIGOS_SECURITY_MODE: 'foundation' }), 'Unregistered native clients cannot bypass Foundation admission');
  assert(!paOnboardingAvailable({ ...c, OIDC_MCP_CLIENT_ID: undefined, OIDC_AGENT_CLIENT_ID: undefined }));
  assert(!paOnboardingAvailable({ ...c, EIGOS_AUTH_MODE: 'development' }));
});

test('the full downloadable skill round-trips through a standard archive reader with all references and current-origin metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-skill-package-'));
  try {
    const c = config(directory), files = paSkillFiles(paConnectionInfo(c)), archive = join(directory, 'skill.tar.gz');
    writeFileSync(archive, paSkillArchive(files));
    const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(names.sort(), [...PA_SKILL_FILES, 'connection.json'].map(name => `eigos-delegate/${name}`).sort());
    execFileSync('tar', ['-xzf', archive, '-C', directory]);
    const skill = readFileSync(join(directory, 'eigos-delegate/SKILL.md'), 'utf8');
    for (const match of skill.matchAll(/\]\((references\/[^)]+)\)/g)) assert(readFileSync(join(directory, 'eigos-delegate', match[1]!), 'utf8').length > 0);
    const connection = JSON.parse(readFileSync(join(directory, 'eigos-delegate/connection.json'), 'utf8'));
    assert.equal(connection.origin, c.PUBLIC_URL);
    assert(skill.includes(connection.links.guide + '/agent.json'));
    assert(!Buffer.concat(Object.values(files)).includes(Buffer.from(secret)));
    assert.throws(() => paSkillArchive({ '../escape': Buffer.from('bad') }), /Invalid skill asset/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('public onboarding, OAuth and A2A point to the same guide without authenticating, enrolling or granting business access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-pa-guide-'));
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port, http = `http://127.0.0.1:${port}`;
  const c = config(directory, { PUBLIC_URL: `https://127.0.0.1:${port}`, OAUTH_AUDIENCE: `https://127.0.0.1:${port}` });
  let verifications = 0;
  const gateway = createApp(c, async () => { verifications++; throw new Error('No public request should authenticate'); });
  server.on('request', gateway.app);
  const get = (path: string) => fetch(http + path, { headers: { 'X-Forwarded-Host': 'untrusted.example' } });
  try {
    const response = await get('/connect'); assert.equal(response.status, 200);
    assert(response.headers.get('content-security-policy')?.includes("script-src 'self'"));
    const html = await response.text();
    for (const link of ['/members', '/connect/agent.json', '/connect/eigos-delegate.tar.gz', '/connect/onboarding.js']) assert(html.includes(link));
    for (const value of [secret, directory, 'untrusted.example']) assert(!html.includes(value));
    assert.equal((await get('/')).status, 200);
    const guide = await (await get('/connect/agent.json')).json();
    assert.equal(guide.origin, c.PUBLIC_URL);
    const resource = await (await get('/.well-known/oauth-protected-resource')).json();
    assert.equal(resource.eigos_connection_guide, guide.links.guide + '/agent.json');
    const registration = await (await get('/.well-known/eigos-agent-registration')).json();
    assert.equal(registration.connection_guide, resource.eigos_connection_guide);
    const card = await (await get('/.well-known/agent-card.json')).json();
    assert.equal(card.documentationUrl, guide.links.guide);
    assert(card.capabilities.extensions.some((value: { uri: string }) => value.uri === resource.eigos_connection_guide));
    assert.equal((await get('/connect/connection.json')).status, 200);
    assert.equal((await get('/connect/references/a2a.md')).status, 200);
    assert.equal((await get('/connect/not-an-asset')).status, 404);
    assert.equal((await get('/mcp')).status, 401);
    assert.equal((await fetch(http + '/a2a', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'no-auth', method: 'ListTasks', params: {} }) })).status, 401);
    assert.equal(gateway.members.list().length, 0); assert.equal(verifications, 0);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await gateway.close(); rmSync(directory, { recursive: true, force: true });
  }
});
