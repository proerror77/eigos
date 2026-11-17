import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../packages/core/config.js';
import type { Principal } from '../packages/core/identity.js';
import { Access, businessGrants, setGrants, syncAccountGrants } from '../packages/runtime/access.js';
import { Accounts, accountGroup, emailDigest, initializeAccounts } from '../packages/runtime/accounts.js';
import { accountCommand } from '../scripts/account-command.js';
import { portalEnv } from './account-env.js';
import { fixture } from './fixture.js';

test('account portal configuration requires secrets and owner isolation for sign-up', () => {
  assert.equal(readConfig(portalEnv).EIGOS_SIGNUP, 'open');
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_ENFORCE_OWNER_RLS: undefined }), /Self sign-up requires EIGOS_ENFORCE_OWNER_RLS=true/);
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_SIGNUP: 'invite', EIGOS_ENFORCE_OWNER_RLS: 'false' }), /Self sign-up requires/);
  assert.equal(readConfig({ ...portalEnv, EIGOS_SIGNUP: 'closed', EIGOS_ENFORCE_OWNER_RLS: undefined }).EIGOS_SIGNUP, 'closed');
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_PORTAL_SECRET: undefined }), /EIGOS_PORTAL_SECRET and EIGOS_ACCOUNT_LINK_SECRET/);
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_ACCOUNT_LINK_SECRET: portalEnv.EIGOS_PORTAL_SECRET }), /separate portal and account link secrets/);
  assert.throws(() => readConfig({ ...portalEnv, OAUTH_MANAGEMENT_CLIENT_ID: 'm2m' }), /both OAUTH_MANAGEMENT_CLIENT_ID and OAUTH_MANAGEMENT_CLIENT_SECRET/);
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_SIGNUP: 'everyone' }), /EIGOS_SIGNUP/);
  // Boundaries: the secret length floor, the Management client shape, and closed sign-up still needing both secrets.
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_PORTAL_SECRET: 'q'.repeat(31) }), /EIGOS_PORTAL_SECRET/);
  assert.equal(readConfig({ ...portalEnv, EIGOS_PORTAL_SECRET: 'q'.repeat(32) }).EIGOS_PORTAL_SECRET, 'q'.repeat(32));
  assert.throws(() => readConfig({ ...portalEnv, OAUTH_MANAGEMENT_CLIENT_ID: 'm2m:client', OAUTH_MANAGEMENT_CLIENT_SECRET: 'synthetic-management-secret' }), /OAUTH_MANAGEMENT_CLIENT_ID/);
  assert.throws(() => readConfig({ ...portalEnv, OAUTH_MANAGEMENT_CLIENT_SECRET: 'synthetic-management-secret' }), /both OAUTH_MANAGEMENT_CLIENT_ID and OAUTH_MANAGEMENT_CLIENT_SECRET/);
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_SIGNUP: 'closed', EIGOS_ENFORCE_OWNER_RLS: undefined, EIGOS_ACCOUNT_LINK_SECRET: undefined }), /EIGOS_PORTAL_SECRET and EIGOS_ACCOUNT_LINK_SECRET/);
});

test('accounts provision by sign-up mode and keep operators out', async () => {
  const f = await fixture();
  try {
    const open = new Accounts(f.db, 'open');
    const alice = await open.provision('a'.repeat(64), emailDigest(' Alice@Example.test '));
    assert.equal(typeof alice === 'object' && alice.status, 'active');
    assert.equal(typeof alice === 'object' && alice.email_hash, emailDigest('alice@example.test'));
    assert.equal(await new Accounts(f.db, 'invite').provision('b'.repeat(64)), 'invite_required');
    assert.equal(await new Accounts(f.db, 'closed').provision('c'.repeat(64)), 'signup_closed');
    assert.equal(typeof await new Accounts(f.db, 'closed').provision('a'.repeat(64)), 'object');
    await setGrants(f.db, 'd'.repeat(64), [{ resource: 'Eigos', permission: 'view_definition' }]);
    assert.equal(await open.provision('d'.repeat(64)), 'operator_account');
    assert.equal(await open.account('d'.repeat(64)), undefined);
    assert.equal((await open.find('ALICE@example.test'))?.owner, 'a'.repeat(64));
    assert.equal((await open.find('a'.repeat(64)))?.owner, 'a'.repeat(64));
  } finally { await f.close(); }
});

test('authorization gives a reason, revocation can be undone and suspension removes group grants', async () => {
  const f = await fixture();
  try {
    const accounts = new Accounts(f.db, 'open'), owner = 'e'.repeat(64), now = Math.floor(Date.now() / 1000);
    const grok = (extra: Partial<Principal> = {}): Principal =>
      ({ owner, scopes: ['tasks:read', 'tasks:write'], clientId: 'grok', memberAudience: true, issuedAt: now, ...extra });
    assert.deepEqual(await accounts.authorize(grok(), 'grok', []), { kind: 'denied', reason: 'client_not_authorized' });
    assert.equal((await accounts.account(owner))?.status, 'active');
    assert.equal(await accounts.approve(owner), true);
    // Kept as text with its microseconds: read as a JS Date it is cut to milliseconds, and an unchanged approval time would still compare as later.
    const first = (await f.db.query<{ at: string }>(`SELECT approved_at::text AS at FROM ${f.db.schema}.accounts WHERE owner=$1`, [owner])).rows[0]!.at;
    assert.deepEqual(await accounts.authorize(grok({ issuedAt: now + 5 }), 'grok', []), { kind: 'account' });
    assert.deepEqual(await accounts.authorize(grok({ issuedAt: now + 5, scopes: ['tasks:read'] }), 'grok', []), { kind: 'denied', reason: 'insufficient_scope' });
    assert.deepEqual(await accounts.authorize(grok({ issuedAt: now + 5, clientId: 'other' }), 'grok', []), { kind: 'denied', reason: 'client_not_allowed' });
    await accounts.revoke(owner);
    assert.deepEqual(await accounts.authorize(grok({ issuedAt: now + 5 }), 'grok', []), { kind: 'denied', reason: 'client_not_authorized' });
    assert.equal(await accounts.approve(owner), true);
    const again = (await accounts.account(owner))!;
    assert.equal(again.revoked_at, null);
    assert.equal((await f.db.query<{ later: boolean }>(`SELECT approved_at > $1::timestamptz AS later FROM ${f.db.schema}.accounts WHERE owner=$2`, [first, owner])).rows[0]!.later, true);
    assert.deepEqual(await accounts.authorize(grok({ issuedAt: now - 3600 }), 'grok', []), { kind: 'denied', reason: 'client_not_authorized' });
    // The grant starts in the second of the latest approval: a token issued in that second counts, one issued the second before does not.
    const approvedSecond = Math.floor(again.approved_at!.getTime() / 1000);
    assert.deepEqual(await accounts.authorize(grok({ issuedAt: approvedSecond }), 'grok', []), { kind: 'account' });
    assert.deepEqual(await accounts.authorize(grok({ issuedAt: approvedSecond - 1 }), 'grok', []), { kind: 'denied', reason: 'client_not_authorized' });
    await setGrants(f.db, 'group:' + accountGroup, [{ resource: 'Eigos', permission: 'view_definition' }]);
    const asAccount = { owner, scopes: ['tasks:read'], memberAccess: true as const };
    const canView = async () => (await Access.load(f.db, asAccount)).allows({ ontology: 'Eigos', permission: 'view_definition', resource: 'Eigos' });
    assert.equal(await canView(), true);
    assert.equal(await accounts.suspend(owner, 'synthetic report'), true);
    assert.equal(await canView(), false);
    assert.deepEqual(await accounts.authorize(grok({ issuedAt: now + 5 }), 'grok', []), { kind: 'denied', reason: 'account_suspended' });
    assert.equal(await accounts.approve(owner), false);
    assert.equal(await accounts.restore(owner), true);
    assert.equal(await canView(), true);
    assert.deepEqual(await new Accounts(f.db, 'closed').authorize(grok({ owner: '0'.repeat(64) }), 'grok', []), { kind: 'denied', reason: 'signup_closed' });
    assert.deepEqual(await new Accounts(f.db, 'invite').authorize(grok({ owner: '1'.repeat(64) }), 'grok', []), { kind: 'denied', reason: 'invite_required' });
    await setGrants(f.db, '2'.repeat(64), [{ resource: 'Eigos', permission: 'view_definition' }]);
    assert.deepEqual(await accounts.authorize({ owner: '2'.repeat(64), scopes: [], clientId: 'existing-client' }, 'grok', ['existing-client']), { kind: 'existing' });
  } finally { await f.close(); }
});

test('initialization renames member accounts and moves member group grants', async () => {
  const f = await fixture();
  try {
    const s = f.db.schema;
    await f.db.query(`ALTER TABLE ${s}.accounts RENAME TO member_accounts`);
    await f.db.query(`INSERT INTO ${s}.member_accounts(owner,approved_at) VALUES($1,now())`, ['f'.repeat(64)]);
    await setGrants(f.db, 'group:eigos-member-queries', [{ resource: 'Eigos', permission: 'view_definition' }]);
    await initializeAccounts(f.db);
    const account = await new Accounts(f.db, 'open').account('f'.repeat(64));
    assert.equal(account?.status, 'active');
    assert.ok(account?.approved_at);
    const subjects = (await f.db.query(`SELECT DISTINCT subject FROM ${s}.resource_grants WHERE subject LIKE 'group:eigos-%'`)).rows.map(r => r.subject);
    assert.deepEqual(subjects, ['group:' + accountGroup]);
  } finally { await f.close(); }
});

test('activation, suspension, lookup and concurrent provisioning follow the stored account', async () => {
  const f = await fixture();
  try {
    const open = new Accounts(f.db, 'open'), invite = new Accounts(f.db, 'invite'), closed = new Accounts(f.db, 'closed');
    const owner = '4'.repeat(64), email = emailDigest('dave@example.test'), session = { owner, email_hash: email };
    const code = await invite.invite('Dave@example.test', 1);
    assert.equal(await closed.activate(session, code), 'invalid');
    assert.equal(await invite.activate({ owner, email_hash: emailDigest('other@example.test') }, code), 'invalid');
    assert.equal(await invite.activate(session, 'x'.repeat(43)), 'invalid');
    assert.equal(await invite.account(owner), undefined);
    assert.equal(await invite.activate(session, code), 'activated');
    assert.equal((await invite.account(owner))?.email_hash, email);
    assert.equal(await invite.activate({ owner: '6'.repeat(64), email_hash: email }, code), 'invalid');
    assert.equal(await invite.activate(session, 'x'.repeat(43)), 'activated');
    await setGrants(f.db, '5'.repeat(64), [{ resource: 'Eigos', permission: 'view_definition' }]);
    assert.equal(await invite.activate({ owner: '5'.repeat(64), email_hash: email }, code), 'operator_account');
    assert.equal(await invite.account('5'.repeat(64)), undefined);

    const active = (who: string) => f.db.transaction(client => open.active(who, client));
    assert.equal(await active(owner), false);
    assert.equal(await open.approve(owner), true);
    assert.equal(await active(owner), true);
    await assert.rejects(open.suspend(owner, '   '), /Suspension reason/);
    await assert.rejects(open.suspend(owner, 'x'.repeat(201)), /Suspension reason/);
    assert.equal((await open.account(owner))?.status, 'active');
    // The limit applies to the trimmed reason, so exactly 200 characters is accepted.
    assert.equal(await open.suspend(owner, ' ' + 'y'.repeat(200) + ' '), true);
    assert.equal((await open.account(owner))?.suspended_reason, 'y'.repeat(200));
    assert.equal(await open.restore(owner), true);
    assert.equal(await open.suspend(owner, '  spaced reason  '), true);
    assert.equal(await open.suspend(owner, 'again'), false);
    const suspended = (await open.account(owner))!;
    assert.deepEqual([suspended.status, suspended.suspended_reason, suspended.suspended_at instanceof Date], ['suspended', 'spaced reason', true]);
    assert.equal(await active(owner), false);
    const renamed = await open.provision(owner, emailDigest('dave2@example.test'));
    assert.deepEqual(typeof renamed === 'object' && [renamed.status, renamed.email_hash], ['suspended', emailDigest('dave2@example.test')]);
    assert.equal(await open.restore(owner), true);
    assert.equal(await open.restore(owner), false);
    const restored = (await open.account(owner))!;
    assert.deepEqual([restored.status, restored.suspended_at, restored.suspended_reason], ['active', null, null]);
    assert.equal(await active(owner), true);

    const shared = emailDigest('erin@example.test');
    await open.provision('7'.repeat(64), shared);
    await open.provision('8'.repeat(64), shared);
    assert.equal((await open.find('Erin@Example.test'))?.owner, '8'.repeat(64));
    assert.equal(await open.find('nobody@example.test'), undefined);
    // A first login (with an e-mail) and a first agent request (without one) can race on one new owner, in either order.
    // The later insert must converge on the same row and keep the e-mail hash.
    const [hashFirst, hashLater] = ['9'.repeat(64), 'a'.repeat(64)];
    const { withoutHash, withHash } = await f.db.transaction(async client => {
      await open.provision(hashFirst, shared, client);
      await open.provision(hashLater, undefined, client);
      const withoutHash = open.provision(hashFirst), withHash = open.provision(hashLater, shared);
      withoutHash.catch(() => {}); withHash.catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 150));
      return { withoutHash, withHash };
    });
    for (const [row, who] of [[await withoutHash, hashFirst], [await withHash, hashLater]] as const)
      assert.deepEqual(typeof row === 'object' && [row.owner, row.email_hash], [who, shared]);
  } finally { await f.close(); }
});

test('authorization reports the first failing check and only the account client opens accounts', async () => {
  const f = await fixture();
  try {
    const accounts = new Accounts(f.db, 'open'), owner = 'b'.repeat(64), now = Math.floor(Date.now() / 1000);
    const deny = (reason: string) => ({ kind: 'denied', reason });
    const token = (extra: Partial<Principal> = {}): Principal =>
      ({ owner, scopes: ['tasks:read'], clientId: 'other', memberAudience: true, issuedAt: now - 3600, ...extra });
    // Opening an account needs both the account audience and the account client.
    assert.deepEqual(await accounts.authorize(token(), 'grok', []), deny('client_not_allowed'));
    assert.deepEqual(await accounts.authorize(token({ clientId: 'grok', memberAudience: undefined }), 'grok', []), deny('client_not_allowed'));
    assert.equal(await accounts.account(owner), undefined);
    await accounts.provision(owner);
    // Checks run in order: client, approval (including token age), scope.
    assert.deepEqual(await accounts.authorize(token(), 'grok', []), deny('client_not_allowed'));
    assert.deepEqual(await accounts.authorize(token({ clientId: 'grok' }), 'grok', []), deny('client_not_authorized'));
    await accounts.approve(owner);
    assert.deepEqual(await accounts.authorize(token({ clientId: 'grok', issuedAt: undefined, scopes: ['tasks:read', 'tasks:write'] }), 'grok', []), deny('client_not_authorized'));
    assert.deepEqual(await accounts.authorize(token({ clientId: 'grok', issuedAt: now + 5 }), 'grok', []), deny('insufficient_scope'));
    // Suspension outranks every other check.
    await accounts.suspend(owner, 'synthetic report');
    assert.deepEqual(await accounts.authorize(token(), 'grok', []), deny('account_suspended'));
    assert.deepEqual(await accounts.authorize(token({ clientId: 'grok', issuedAt: now + 5, scopes: ['tasks:read', 'tasks:write'] }), 'grok', []), deny('account_suspended'));
    // An account owner cannot fall back to an existing client, even with operator grants.
    await accounts.restore(owner);
    await setGrants(f.db, owner, [{ resource: 'Eigos', permission: 'view_definition' }]);
    assert.deepEqual(await accounts.authorize({ owner, scopes: [], clientId: 'existing-client' }, 'grok', ['existing-client']), deny('client_not_allowed'));
    // Existing clients need both the client allow-list and operator grants.
    const operator = 'c'.repeat(64);
    assert.deepEqual(await accounts.authorize({ owner: operator, scopes: [], clientId: 'existing-client' }, 'grok', ['existing-client']), deny('client_not_allowed'));
    await setGrants(f.db, operator, [{ resource: 'Eigos', permission: 'manage_definition' }]);
    assert.deepEqual(await accounts.authorize({ owner: operator, scopes: [], clientId: 'unlisted-client' }, 'grok', ['existing-client']), deny('client_not_allowed'));
    assert.deepEqual(await accounts.authorize({ owner: operator, scopes: [] }, 'grok', ['existing-client']), deny('client_not_allowed'));
    assert.deepEqual(await accounts.authorize({ owner: operator, scopes: [], clientId: 'existing-client' }, 'grok', ['existing-client']), { kind: 'existing' });
    assert.deepEqual(await accounts.authorize(token({ owner: operator, clientId: 'grok' }), 'grok', ['existing-client']), deny('operator_account'));
    assert.equal(await accounts.account(operator), undefined);
  } finally { await f.close(); }
});

test('upgrading the legacy member schema keeps accounts and invitations, and can run again', async () => {
  const f = await fixture();
  try {
    const s = f.db.schema, owner = '3'.repeat(64);
    // Rebuild the schema as it was before accounts had a status: the old table name and no new columns.
    await f.db.query(`ALTER TABLE ${s}.accounts DROP COLUMN status, DROP COLUMN suspended_at, DROP COLUMN suspended_reason, DROP COLUMN email_hash`);
    await f.db.query(`ALTER TABLE ${s}.accounts RENAME TO member_accounts`);
    await f.db.query(`INSERT INTO ${s}.member_accounts(owner,approved_at) VALUES($1,now())`, [owner]);
    await f.db.query(`INSERT INTO ${s}.member_invitations(code_hash,email_hash,expires_at,redeemed_by)
      VALUES('legacy-code','legacy-email',now()+interval '1 hour',$1)`, [owner]);
    await initializeAccounts(f.db);
    await initializeAccounts(f.db);
    const account = await new Accounts(f.db, 'open').account(owner);
    assert.deepEqual([account?.status, account?.suspended_at, account?.suspended_reason, account?.email_hash], ['active', null, null, null]);
    assert.ok(account?.approved_at);
    assert.equal((await f.db.query(`SELECT to_regclass($1) AS legacy`, [s + '.member_accounts'])).rows[0]?.legacy, null);
    await assert.rejects(f.db.query(`UPDATE ${s}.accounts SET status='deleted' WHERE owner=$1`, [owner]), /accounts_status_check/);
    await assert.rejects(f.db.query(`UPDATE ${s}.accounts SET status=NULL WHERE owner=$1`, [owner]), /not-null constraint/);
    // The redeemed invitation still references the renamed table.
    await assert.rejects(f.db.query(`DELETE FROM ${s}.accounts WHERE owner=$1`, [owner]), /member_invitations/);
    assert.equal((await f.db.query(`SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname='accounts_email'`, [f.schema])).rowCount, 1);
  } finally { await f.close(); }
});

test('account grants follow the published business resources', async () => {
  const f = await fixture();
  try {
    await syncAccountGrants(f.db, f.model);
    const rows = (await f.db.query(`SELECT resource,permission FROM ${f.db.schema}.resource_grants WHERE subject=$1`, ['group:' + accountGroup])).rows;
    assert.deepEqual(new Set(rows.map(r => r.permission + ':' + r.resource)),
      new Set(businessGrants(f.model, f.db.sandboxEnabled).map(g => g.permission + ':' + g.resource)));
    assert.ok(rows.every(r => !['edit_definition', 'manage_definition'].includes(r.permission)));
  } finally { await f.close(); }
});

test('syncing the account group replaces its grants, follows the sandbox switch and joins a caller transaction', async () => {
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, {}, { sandbox: true });
  try {
    const group = 'group:' + accountGroup, retired = { resource: 'Eigos/object/Retired', permission: 'view_objects' } as const;
    const key = (grant: { resource: string; permission: string }) => grant.permission + ':' + grant.resource;
    const held = async () => new Set((await f.db.query(`SELECT permission||':'||resource AS entry FROM ${f.db.schema}.resource_grants WHERE subject=$1`, [group])).rows.map(r => r.entry));
    await setGrants(f.db, group, [retired]);
    // Inside a caller's transaction the sync is committed or rolled back with it.
    await assert.rejects(f.db.transaction(async client => { await syncAccountGrants(f.db, f.model, client); throw new Error('roll back'); }), /roll back/);
    assert.deepEqual(await held(), new Set([key(retired)]));
    await syncAccountGrants(f.db, f.model);
    // The sync replaces what the group held, and the database's sandbox switch decides which resources count as business grants.
    assert.ok(businessGrants(f.model, true).length > businessGrants(f.model, false).length);
    assert.deepEqual(await held(), new Set(businessGrants(f.model, true).map(key)));
  } finally { await f.close(); }
});

test('operator account commands find accounts by owner or email', async () => {
  const f = await fixture();
  try {
    const owner = '3'.repeat(64), accounts = new Accounts(f.db, 'open');
    await accounts.provision(owner, emailDigest('carol@example.test'));
    assert.equal((await accountCommand(f.db, 'open', ['show', 'Carol@example.test'])).status, 'active');
    assert.equal((await accountCommand(f.db, 'open', ['suspend', owner, 'synthetic', 'report'])).status, 'suspended');
    assert.equal((await accounts.account(owner))?.suspended_reason, 'synthetic report');
    assert.equal((await accountCommand(f.db, 'open', ['restore', owner])).status, 'active');
    await assert.rejects(accountCommand(f.db, 'open', ['show', 'nobody@example.test']), /Account not found/);
    await assert.rejects(accountCommand(f.db, 'open', ['suspend', owner]), /Provide a suspension reason/);
    await assert.rejects(accountCommand(f.db, 'open', ['delete', owner]), /Use account show, suspend or restore/);
  } finally { await f.close(); }
});

test('operator account commands report the stored account and check their arguments', async () => {
  const f = await fixture();
  try {
    const owner = '4'.repeat(64), accounts = new Accounts(f.db, 'open'), run = (...args: string[]) => accountCommand(f.db, 'open', args);
    const iso = (date: Date | null) => date?.toISOString() ?? null;
    await accounts.provision(owner, emailDigest('dana@example.test'));
    await accounts.approve(owner);
    await accounts.revoke(owner);
    const stored = (await accounts.account(owner))!;
    assert.ok(stored.approved_at && stored.revoked_at);
    // Every stored field is reported with dates as ISO strings, and the e-mail hash is left out.
    assert.deepEqual(await run('show', owner), { owner, status: 'active', activatedAt: iso(stored.activated_at), approvedAt: iso(stored.approved_at),
      revokedAt: iso(stored.revoked_at), suspendedAt: null, suspendedReason: null });
    const suspended = await run('suspend', 'Dana@example.test', 'first', 'reason');
    assert.deepEqual([suspended.status, suspended.suspendedReason, suspended.suspendedAt], ['suspended', 'first reason', iso((await accounts.account(owner))!.suspended_at)]);
    // Repeating a command changes nothing: the report shows the stored account, not the request.
    assert.deepEqual(await run('suspend', owner, 'second reason'), suspended);
    const restored = await run('restore', owner);
    assert.deepEqual([restored.status, restored.suspendedAt, restored.suspendedReason], ['active', null, null]);
    assert.deepEqual(await run('restore', 'DANA@example.test'), restored);
    // Arguments are checked before anything changes.
    await assert.rejects(run('suspend', owner, '', '  '), /Provide a suspension reason/);
    await assert.rejects(run('suspend', owner, 'x'.repeat(201)), /Suspension reason must be 1 to 200 characters/);
    assert.equal((await accounts.account(owner))?.status, 'active');
    await assert.rejects(run('suspend', 'nobody@example.test', 'reason'), /Account not found/);
    await assert.rejects(run('restore', 'nobody@example.test'), /Account not found/);
    await assert.rejects(run('show'), /Provide the account owner or e-mail address/);
    await assert.rejects(run(), /Use account show, suspend or restore/);
  } finally { await f.close(); }
});
