import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemberStore } from '../../packages/members/store.js';
import { JobStore } from '../../packages/core/store.js';

test('offline membership CLI persists a deny fence before suspension and approval does not silently restore network permission', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-network-cli-'));
  const businessPath = join(directory, 'tasks.sqlite'), memberPath = join(directory, 'members.sqlite');
  const jobs = new JobStore(businessPath), members = new MemberStore(memberPath);
  try {
    const member = members.login({ issuer: 'https://fixture.test', subject: 'alice', tenant: 'one' });
    members.apply(member.id, { displayName: 'Fixture', locale: 'en', timezone: 'UTC', consent: true }, false);
    const network = jobs.createNetworkStore();
    // Include cold canonical-model loading in this process-lifecycle bound.
    const run = (action: string) => spawnSync(process.execPath, ['scripts/members.mjs', action, member.id], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: businessPath, MEMBERSHIP_DATABASE_PATH: memberPath, EIGOS_NETWORK_ENABLED: 'false' }, encoding: 'utf8', timeout: 30000,
    });
    const suspended = run('suspend'); assert.equal(suspended.status, 0, suspended.stderr);
    assert.equal(members.get(member.id).status, 'suspended'); assert.throws(() => network.checkFence(member.id), /ACCESS_REVOKED/);
    const restored = run('approve'); assert.equal(restored.status, 0, restored.stderr);
    assert.equal(members.get(member.id).status, 'active'); assert.throws(() => network.checkFence(member.id), /ACCESS_REVOKED/);
  } finally { members.close(); jobs.close(); rmSync(directory, { recursive: true, force: true }); }
});
