import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/gateway/app.js';
import { readConfig, type Config } from '../packages/core/config.js';
import { PA_SKILL_FILES, PA_SKILL_VERSION, PA_SKILL_MARKER, paConnectionInfo, paOnboardingAvailable, paSkillArchive, paSkillFiles } from '../packages/members/pa-onboarding.js';

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
  assert.equal(info.skillContract.version, PA_SKILL_VERSION);
  assert.equal(info.accountCustody.owner, 'pa');
  assert.equal(info.accountCustody.customerFlowCredentialsAccepted, false);
  assert.equal(info.accountCustody.paymentCredentialsAccepted, false);
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
    assert.deepEqual(names.sort(), [...PA_SKILL_FILES, 'connection.json', 'manifest.json'].map(name => `eigos-delegate/${name}`).sort());
    execFileSync('tar', ['-xzf', archive, '-C', directory]);
    const skill = readFileSync(join(directory, 'eigos-delegate/SKILL.md'), 'utf8');
    for (const match of skill.matchAll(/\]\((references\/[^)]+)\)/g)) assert(readFileSync(join(directory, 'eigos-delegate', match[1]!), 'utf8').length > 0);
    const connection = JSON.parse(readFileSync(join(directory, 'eigos-delegate/connection.json'), 'utf8'));
    assert.equal(connection.origin, c.PUBLIC_URL);
    assert(skill.includes(connection.links.guide + '/agent.json'));
    assert(skill.includes(PA_SKILL_MARKER));
    const manifest = JSON.parse(readFileSync(join(directory, 'eigos-delegate/manifest.json'), 'utf8'));
    assert.equal(manifest.version, connection.skillContract.version);
    assert.equal(manifest.hostActivation, 'not_attested_by_file_integrity');
    assert(!Buffer.concat(Object.values(files)).includes(Buffer.from(secret)));
    assert.throws(() => paSkillArchive({ '../escape': Buffer.from('bad') }), /Invalid skill asset/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('installed Skill verification separates current files from host activation and rejects tampered or outdated packages', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-skill-verify-'));
  let current: Buffer, requests = 0;
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET'); assert.equal(req.url, '/connect/manifest.json');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['user-agent'], 'EIGOS-Connection-Check/1.0'); requests++;
    res.setHeader('Content-Type', 'application/json'); res.end(current);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const files = paSkillFiles(paConnectionInfo(config(directory, { PUBLIC_URL: origin })));
  current = files['manifest.json']!;
  const archive = join(directory, 'skill.tar.gz'); writeFileSync(archive, paSkillArchive(files));
  execFileSync('tar', ['-xzf', archive, '-C', directory]);
  const installed = join(directory, 'eigos-delegate'), script = join(installed, 'scripts/check_connection.py');
  const check = async (...extra: string[]) => {
    try {
      const r = await promisify(execFile)('python3', [script, '--directory', installed, '--origin', origin, '--allow-loopback-http', ...extra], { env: { PATH: process.env.PATH }, timeout: 20000 });
      return { code: 0, body: JSON.parse(r.stdout) };
    } catch (e) {
      const r = e as { code: number; stdout: string };
      return { code: r.code, body: JSON.parse(r.stdout) };
    }
  };
  try {
    const noHost = await check();
    assert.equal(noHost.code, 0); assert.equal(noHost.body.filesCurrent, true);
    assert.equal(noHost.body.hostActivation, 'unconfirmed'); assert.equal(noHost.body.nextAction, 'confirm_loaded_in_host');
    const loaded = await check('--loaded-marker', PA_SKILL_MARKER);
    assert.equal(loaded.body.hostActivation, 'self_reported_current'); assert.equal(loaded.body.hostActivationIsSelfReport, true);
    const old = await check('--loaded-marker', 'eigos-delegate@0.0.1');
    assert.equal(old.code, 2); assert.equal(old.body.nextAction, 'refresh_skill_in_host');
    writeFileSync(join(installed, 'SKILL.md'), 'modified local instructions');
    const tampered = await check('--loaded-marker', PA_SKILL_MARKER);
    assert.equal(tampered.code, 2); assert.equal(tampered.body.fileIntegrity, 'modified');
    rmSync(join(installed, 'SKILL.md'));
    symlinkSync(archive, join(installed, 'SKILL.md'));
    const linked = await check(); assert.equal(linked.code, 2); assert.equal(linked.body.error, 'SKILL_FILE_UNSAFE');
    rmSync(join(installed, 'SKILL.md'));
    writeFileSync(join(installed, 'SKILL.md'), files['SKILL.md']!);
    const newer = JSON.parse(current.toString()); newer.version = '9.0.0'; newer.marker = 'eigos-delegate@9.0.0';
    current = Buffer.from(JSON.stringify(newer));
    assert.equal((await check()).body.filesCurrent, false);
    assert.equal(requests, 6);
    assert.equal(loaded.body.credentialsRead, false); assert.equal(loaded.body.taskCreated, false);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
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
    const guideResponse = await get('/connect/agent.json'); assert.equal(guideResponse.headers.get('cache-control'), 'no-store');
    const guide = await guideResponse.json();
    assert.equal(guide.origin, c.PUBLIC_URL);
    const resource = await (await get('/.well-known/oauth-protected-resource')).json();
    assert.equal(resource.eigos_connection_guide, guide.links.guide + '/agent.json');
    const registration = await (await get('/.well-known/eigos-agent-registration')).json();
    assert.equal(registration.connection_guide, resource.eigos_connection_guide);
    const card = await (await get('/.well-known/agent-card.json')).json();
    assert.equal(card.documentationUrl, guide.links.guide);
    assert(card.capabilities.extensions.some((value: { uri: string }) => value.uri === resource.eigos_connection_guide));
    assert.equal((await get('/connect/connection.json')).status, 200);
    const manifestResponse = await get('/connect/manifest.json'); assert.equal(manifestResponse.headers.get('cache-control'), 'no-store');
    const manifest = await manifestResponse.json(); assert.equal(manifest.version, guide.skillContract.version);
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
