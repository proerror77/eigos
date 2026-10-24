import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { securityFixture } from '../fixtures/security.js';

test('E2E: the existing compiled members CLI enforces the same persistent Worker revocation fence', () => {
  const f = securityFixture();
  try {
    const a = f.installation('Compiled CLI test'); f.approve(a.id); const task = f.task(a.id);
    const claim = f.jobs.claim(['eigos.delegate'], 10000)!; assert(claim);
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_PATH: f.database, MEMBERSHIP_DATABASE_PATH: f.membership };
    delete env.EIGOS_SECURITY_MODE;
    const run = spawnSync(process.execPath, [resolve('scripts/members.mjs'), 'suspend', f.member.id], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).status, 'suspended');
    assert.equal(f.jobs.renew(claim, 10000), false); assert.equal(f.jobs.security.workAuthority(f.owner, task.job.id), undefined);
    assert.equal(f.jobs.security.pendingFences().length, 0);
    const restore = spawnSync(process.execPath, [resolve('scripts/members.mjs'), 'approve', f.member.id], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(restore.status, 0, restore.stderr);
    assert.throws(() => f.coordinator.authenticate(f.principal, a.token), /AUTHORIZATION_REQUIRED/);
    assert.equal(f.jobs.security.workAuthority(f.owner, task.job.id), undefined);
  } finally { f.close(); }
});
