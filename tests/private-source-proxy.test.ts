import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readConfig, assertPersonalSourceConfig } from '../packages/core/config.js';
import { validateSourceProxy } from '../packages/core/private-source-proxy.js';

const origin = 'https://private.example.ts.net:8443';
const config = () => readConfig({ EIGOS_AUTH_MODE: 'jwt', HOST: '127.0.0.1', PORT: '3210', PUBLIC_URL: origin, OAUTH_ISSUER: 'https://idp.test', OAUTH_JWKS_URL: 'https://idp.test/jwks', OAUTH_AUDIENCE: origin, OIDC_CLIENT_ID: 'web', OIDC_AGENT_CLIENT_ID: 'pa', EIGOS_NETWORK_ENABLED: 'true', EIGOS_NETWORK_MEMBER_IDS: JSON.stringify([randomUUID()]), DATABASE_PATH: '/private/tasks.sqlite', EIGOS_PAOTUI_SKILL_DIR: '/private/reader', EIGOS_MEMBER_SOURCE_KEY_FILE: '/private/key', EIGOS_MEMBER_SOURCE_TAILNET_ORIGIN: origin });
const snapshot = () => ({ TCP: { '8443': { HTTPS: true } }, Web: { 'private.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3210' } } } }, AllowFunnel: { 'private.example.ts.net:443': true } });
test('member source private HTTPS requires an explicit exact origin and retains loopback/non-production gates', () => {
  const c = config(); assertPersonalSourceConfig(c);
  for (const change of [{ EIGOS_MEMBER_SOURCE_TAILNET_ORIGIN: undefined }, { EIGOS_MEMBER_SOURCE_TAILNET_ORIGIN: 'https://other.example.ts.net:8443' }, { PUBLIC_URL: 'https://public.test', EIGOS_MEMBER_SOURCE_TAILNET_ORIGIN: 'https://public.test' }, { HOST: '0.0.0.0' }, { EIGOS_MEMBER_SOURCE_KEY_FILE: undefined }]) assert.throws(() => assertPersonalSourceConfig({ ...c, ...change }));
  assert.throws(() => assertPersonalSourceConfig(c, 'production'));
});
test('source proxy proof rejects public Funnel, wrong forwarding target, path overrides and unknown snapshots', () => {
  const c = config(), s = snapshot(); validateSourceProxy(c, s);
  for (const bad of [null, {}, { ...s, TCP: {} }, { ...s, AllowFunnel: { 'private.example.ts.net:8443': true } }, { ...s, Web: { 'private.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3430' } } } } }, { ...s, Web: { 'private.example.ts.net:8443': { Handlers: { ...s.Web['private.example.ts.net:8443'].Handlers, '/sources': { Proxy: 'http://foreign.test' } } } } }]) assert.throws(() => validateSourceProxy(c, bad));
});
