import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../packages/core/config.js';
import { portalEnv } from './account-env.js';

test('account portal configuration requires secrets and owner isolation for sign-up', () => {
  assert.equal(readConfig(portalEnv).EIGOS_SIGNUP, 'open');
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_ENFORCE_OWNER_RLS: undefined }), /Self sign-up requires EIGOS_ENFORCE_OWNER_RLS=true/);
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_SIGNUP: 'invite', EIGOS_ENFORCE_OWNER_RLS: 'false' }), /Self sign-up requires/);
  assert.equal(readConfig({ ...portalEnv, EIGOS_SIGNUP: 'closed', EIGOS_ENFORCE_OWNER_RLS: undefined }).EIGOS_SIGNUP, 'closed');
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_PORTAL_SECRET: undefined }), /EIGOS_PORTAL_SECRET and EIGOS_ACCOUNT_LINK_SECRET/);
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_ACCOUNT_LINK_SECRET: portalEnv.EIGOS_PORTAL_SECRET }), /separate portal and account link secrets/);
  assert.throws(() => readConfig({ ...portalEnv, OAUTH_MANAGEMENT_CLIENT_ID: 'm2m' }), /both OAUTH_MANAGEMENT_CLIENT_ID and OAUTH_MANAGEMENT_CLIENT_SECRET/);
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_SIGNUP: 'everyone' }));
});
