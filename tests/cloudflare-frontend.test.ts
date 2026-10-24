import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../packages/core/config.js';
import { readCloudflareFrontend, validateCloudflareFrontend, type CloudflareFrontend } from '../packages/deployment/cloudflare-frontend.js';

const frontend: CloudflareFrontend = {
  version: 1, kind: 'cloudflare-tunnel', accountId: 'a'.repeat(32),
  tunnelId: '87945afb-dca8-48eb-8a5c-38092da36a9b', tunnelName: 'eigos-invite-beta', hostname: 'beta.example.com',
};
const config = readConfig({
  EIGOS_INVITE_BETA: 'true', EIGOS_AUTH_MODE: 'jwt', PUBLIC_URL: 'https://beta.example.com', OAUTH_AUDIENCE: 'https://beta.example.com',
  OAUTH_ISSUER: 'https://identity.example/', OAUTH_JWKS_URL: 'https://identity.example/jwks',
  OIDC_CLIENT_ID: 'portal', OIDC_AGENT_CLIENT_ID: 'connector', OIDC_MCP_CLIENT_ID: 'mcp',
  DATABASE_PATH: '/private/beta/tasks.sqlite', MEMBERSHIP_DATABASE_PATH: '/private/beta/members.sqlite',
  EIGOS_MEMBERSHIP_APPROVAL: 'invite-only', EIGOS_EXECUTOR: 'codex', HOST: '127.0.0.1', PORT: '3212',
});
const snapshot = {
  tunnel: { id: frontend.tunnelId, name: frontend.tunnelName, config_src: 'cloudflare', deleted_at: null, status: 'healthy', connections: [{ id: 'fixture-connector' }] },
  configuration: { tunnel_id: frontend.tunnelId, source: 'cloudflare', config: {
    ingress: [{ hostname: frontend.hostname, service: 'http://127.0.0.1:3212' }, { service: 'http_status:404' }],
    'warp-routing': { enabled: false },
  } },
};

test('Cloudflare beta accepts only the current connected tunnel and exact resource identity', () => {
  validateCloudflareFrontend(config, frontend, snapshot);
  for (const patch of [
    { id: 'another-tunnel' }, { name: 'another-application' }, { config_src: 'local' },
    { deleted_at: '2026-10-22T00:00:00Z' }, { status: 'inactive' }, { status: 'degraded' }, { connections: [] },
  ]) assert.throws(() => validateCloudflareFrontend(config, frontend, { ...snapshot, tunnel: { ...snapshot.tunnel, ...patch } }), /exact healthy/);
  for (const patch of [{ tunnel_id: 'another-tunnel' }, { source: 'local' }]) {
    assert.throws(() => validateCloudflareFrontend(config, frontend, { ...snapshot, configuration: { ...snapshot.configuration, ...patch } }), /exact healthy/);
  }
  assert.throws(() => validateCloudflareFrontend(config, { ...frontend, hostname: 'other.example.com' }, snapshot), /exact healthy/);
  assert.throws(() => validateCloudflareFrontend({ ...config, EIGOS_INVITE_BETA: 'false' }, frontend, snapshot), /exact healthy/);
  assert.throws(() => validateCloudflareFrontend({ ...config, HOST: '0.0.0.0' }, frontend, snapshot), /exact healthy/);
  assert.throws(() => validateCloudflareFrontend({ ...config, PUBLIC_URL: 'http://beta.example.com' }, frontend, snapshot), /exact healthy/);
  assert.throws(() => validateCloudflareFrontend({ ...config, PUBLIC_URL: 'https://beta.example.com:8443' }, frontend, snapshot), /exact healthy/);
  assert.throws(() => validateCloudflareFrontend(config, frontend, null), /exact healthy/);
});

test('Cloudflare beta rejects route widening, private-service targets and origin overrides', () => {
  const route = snapshot.configuration.config.ingress[0]!, fallback = { service: 'http_status:404' };
  const routing = snapshot.configuration.config;
  const invalid = [
    { ...routing, ingress: [{ ...route, hostname: '*.example.com' }, fallback] },
    { ...routing, ingress: [{ ...route, service: 'http://127.0.0.1:3210' }, fallback] },
    { ...routing, ingress: [{ ...route, service: 'http://192.0.2.1:3212' }, fallback] },
    { ...routing, ingress: [{ ...route, path: '/mcp' }, fallback] },
    { ...routing, ingress: [{ ...route, originRequest: { httpHostHeader: 'private.example' } }, fallback] },
    { ...routing, ingress: [route, { service: 'http://127.0.0.1:3210' }] },
    { ...routing, ingress: [route, { hostname: '*', ...fallback }] },
    { ...routing, ingress: [route, { hostname: 'private.example', service: 'http://127.0.0.1:3210' }, fallback] },
    { ...routing, ingress: [route] },
    { ...routing, 'warp-routing': { enabled: true } },
    { ...routing, originRequest: { httpHostHeader: 'private.example' } },
    { ...routing, unknownRouting: true },
  ];
  for (const changed of invalid) assert.throws(() => validateCloudflareFrontend(config, frontend, {
    ...snapshot, configuration: { ...snapshot.configuration, config: changed },
  }), /exact healthy/);
});

test('Cloudflare deployment identity is read only from a private owned regular configuration file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-cloudflare-frontend-'));
  const path = join(directory, 'frontend.json');
  try {
    writeFileSync(path, JSON.stringify(frontend), { mode: 0o600 });
    assert.deepEqual(readCloudflareFrontend(path), frontend);
    assert.throws(() => readCloudflareFrontend('frontend.json'), /absolute private/);
    chmodSync(path, 0o644);
    assert.throws(() => readCloudflareFrontend(path), /owned private regular/);
    chmodSync(path, 0o600);
    symlinkSync(path, join(directory, 'symlink.json'));
    assert.throws(() => readCloudflareFrontend(join(directory, 'symlink.json')), /owned private regular/);
    linkSync(path, join(directory, 'hardlink.json'));
    assert.throws(() => readCloudflareFrontend(path), /owned private regular/);
    unlinkSync(join(directory, 'hardlink.json'));
    writeFileSync(path, JSON.stringify({ ...frontend, accountId: '../other-account' }));
    assert.throws(() => readCloudflareFrontend(path));
    writeFileSync(path, JSON.stringify({ ...frontend, operatorToken: 'must-not-be-configured-here' }));
    assert.throws(() => readCloudflareFrontend(path));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
