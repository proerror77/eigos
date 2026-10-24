import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MemberStore } from '../../packages/members/store.js';
import { JobStore } from '../../packages/core/store.js';
import { readPersonalSource, PersonalSourceAccess, sourceOwner } from '../../packages/core/personal-source.js';

const script = fileURLToPath(new URL('../../../scripts/personal-source.mjs', import.meta.url));
test('operator CLI binds only an explicitly enrolled member, never overwrites a connection, and revokes a running reader without credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-source-cli-')), memberPath = join(directory, 'members.sqlite'), jobs = new JobStore(join(directory, 'tasks.sqlite'));
  const members = new MemberStore(memberPath);
  try {
    const issuer = 'https://issuer.test';
    const alice = members.login({ issuer, tenant: 'one', subject: 'private-operator-subject' }), bob = members.login({ issuer, tenant: 'one', subject: 'other-member' });
    for (const m of [alice, bob]) members.apply(m.id, { displayName: 'Test member', locale: 'en', timezone: 'UTC', consent: true }, false);
    jobs.createNetworkStore();
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, MEMBERSHIP_DATABASE_PATH: memberPath, OAUTH_ISSUER: issuer, EIGOS_NETWORK_MEMBER_IDS: JSON.stringify([alice.id]) } });
    const file = 'data/private/connection.json';
    assert.notEqual(run('bind', '--member', bob.id, '--file', file).status, 0);
    const bound = run('bind', '--member', alice.id, '--file', file); assert.equal(bound.status, 0, bound.stderr); assert(!bound.stdout.includes(alice.subject));
    const path = join(directory, file), record = readPersonalSource(path);
    assert.equal(record.memberId, alice.id); assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.notEqual(run('bind', '--member', alice.id, '--file', file).status, 0);
    const access = new PersonalSourceAccess(path, (c, hash) => jobs.personalSourceAdmitted(c, hash), directory); jobs.admitPersonalSource(record, access.configurationDigest);
    assert(access.permitted(sourceOwner(record)));
    const inspected = run('inspect', '--file', file); assert.equal(inspected.status, 0); assert(!inspected.stdout.includes(alice.subject));
    const revoked = run('revoke', '--file', file); assert.equal(revoked.status, 0, revoked.stderr);
    assert(!access.permitted(sourceOwner(record))); assert.equal(readPersonalSource(path).state, 'revoked');
    assert(!readFileSync(path, 'utf8').includes('access_token'));
  } finally { members.close(); jobs.close(); rmSync(directory, { recursive: true, force: true }); }
});
