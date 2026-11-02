import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { MemberStore, MemberAccessError, applicationSchema, profileSchema } from '../packages/members/store.js';
import { MemberAccessError as SharedMemberAccessError } from '../packages/members/contracts.js';
import { nativeInstallationId } from '../packages/members/agents.js';
import { ownerKey, type Principal } from '../packages/core/domain.js';
import { importMembershipSnapshot } from '../packages/postgres/membership-import.js';
import { PostgresMembershipDatabase } from '../packages/postgres/members-database.js';
import { PostgresMemberStore, PostgresMemberAccessError, postgresApplicationSchema, postgresProfileSchema } from '../packages/postgres/member-store.js';

const enabled = process.env.EIGOS_TEST_PG_LOCAL === '1';
const identity = { issuer: 'https://membership.fixture', tenant: 'synthetic', subject: 'alice' };
const principal: Principal = { ...identity, clientId: 'connector', scopes: ['tasks:read', 'tasks:write'] };
const profile = { displayName: 'Synthetic Member', locale: 'en' as const, timezone: 'UTC' };
const credential = () => randomBytes(32).toString('base64url');
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-pg-members-')), path = join(directory, 'members.sqlite');
  const seed = new MemberStore(path), alice = seed.login(identity);
  seed.apply(alice.id, { ...profile, consent: true }, false); seed.authorize(principal);
  const session = seed.createSession(alice.id), token = 'synthetic-imported-native-token';
  const native = seed.agents.authorizeNative(principal, alice.id, token, Date.now() + 600000);
  seed.close();
  const sqlite = new DatabaseSync(path); sqlite.exec('PRAGMA journal_mode=DELETE'); sqlite.close(); chmodSync(path, 0o600);
  const schema = `eigos_membership_${randomUUID().replaceAll('-', '')}`, source = digest(readFileSync(path));
  const admin = new pg.Client(); await admin.connect();
  let database: PostgresMembershipDatabase | undefined;
  try {
    await importMembershipSnapshot(admin, path, schema, source, Number.MAX_SAFE_INTEGER);
    database = new PostgresMembershipDatabase(new pg.Pool({ max: 6 }), schema, source);
    const members = new PostgresMemberStore(database);
    return { members, database, admin, schema, source, alice, session, token, native,
      close: async () => { await members.close(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    await database?.close(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); rmSync(directory, { recursive: true, force: true }); throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function use(action: (f: Fixture) => Promise<void>) { const f = await fixture(); try { await action(f); } finally { await f.close(); } }

test('SQLite and PostgreSQL share the same member errors and validation contracts', () => {
  assert.equal(MemberAccessError, SharedMemberAccessError);
  assert.equal(PostgresMemberAccessError, MemberAccessError);
  assert.equal(postgresApplicationSchema, applicationSchema);
  assert.equal(postgresProfileSchema, profileSchema);
  assert(new PostgresMemberAccessError('membership_inactive') instanceof MemberAccessError);
});

test('PostgreSQL membership retains imported identity, session CSRF and stable native installation', { skip: !enabled }, async () => use(async f => {
  const restored = await f.members.session(f.session.token);
  assert.equal(restored?.member.id, f.alice.id); assert.equal(restored.csrf, f.session.csrf);
  assert.equal((await f.members.agents.authorize(principal, f.token)).id, f.native.id);
  assert.equal((await f.members.agents.ensureNativeInstallation(principal, f.alice.id)).id, nativeInstallationId(principal));
  assert.equal((await f.members.agents.authorizeNative(principal, f.alice.id, 'synthetic-renewed-token', Date.now() + 60000)).id, f.native.id);
  await f.members.update(f.alice.id, { ...profile, displayName: 'Edited profile' });
  const login = await f.members.login({ ...identity, email: 'changed@fixture.invalid', displayName: 'IdP profile' });
  assert.equal(login.id, f.alice.id); assert.equal(login.displayName, 'Edited profile'); assert.equal(login.status, 'active');
  const other = await f.members.login({ ...identity, subject: 'another', email: 'changed@fixture.invalid' });
  assert.notEqual(other.id, login.id, 'Email must never merge issuer/tenant/subject identities');
  assert.equal((await f.members.list()).length, 2);
  const raw = (await f.admin.query(`SELECT hash,csrf FROM "${f.schema}".member_sessions`)).rows;
  assert.equal(raw[0].hash, digest(f.session.token)); assert.equal(raw[0].csrf, f.session.csrf);
  const tokens = (await f.admin.query(`SELECT hash FROM "${f.schema}".agent_access_tokens`)).rows;
  assert(tokens.every(row => row.hash !== f.token && row.hash.length === 64));
  assert.equal((await f.members.connections(f.alice.id))[0]!.blocked, false, 'BIGINT "0" is not truthy revocation');
}));

test('PostgreSQL member lifecycle preserves consent, manual approval, suspension and session expiry', { skip: !enabled }, async () => use(async f => {
  const bob = await f.members.login({ ...identity, subject: 'bob' });
  await assert.rejects(f.members.authorize({ ...principal, subject: 'missing' }), error => error instanceof MemberAccessError && error.code === 'membership_required');
  await assert.rejects(f.members.authorize({ ...principal, subject: 'bob' }), /membership_inactive/);
  await assert.rejects(f.members.setStatus(bob.id, 'active'), /complete the application/);
  await assert.rejects(async () => f.members.apply(bob.id, { ...profile, consent: false }, false));
  assert.equal((await f.members.apply(bob.id, { ...profile, consent: true }, true)).status, 'pending');
  assert.equal((await f.members.setStatus(bob.id, 'active')).status, 'active');
  assert.equal((await f.members.apply(bob.id, { ...profile, displayName: 'Overwrite', consent: true }, false, { preserveActiveProfile: true })).displayName, profile.displayName);
  await f.members.setStatus(bob.id, 'suspended');
  await assert.rejects(f.members.apply(bob.id, { ...profile, consent: true }, false), /suspended/);
  await assert.rejects(f.members.authorize({ ...principal, subject: 'bob' }), /membership_inactive/);
  const session = await f.members.createSession(bob.id); assert.equal((await f.members.session(session.token))?.member.status, 'suspended');
  await f.members.logout(session.token); assert.equal(await f.members.session(session.token), undefined);
  const expired = await f.members.createSession(bob.id);
  await f.admin.query(`UPDATE "${f.schema}".member_sessions SET expires_at=$1 WHERE hash=$2`, [Date.now() - 1, digest(expired.token)]);
  assert.equal(await f.members.session(expired.token), undefined);
  await f.members.createSession(f.alice.id);
  assert.equal((await f.admin.query(`SELECT 1 FROM "${f.schema}".member_sessions WHERE hash=$1`, [digest(expired.token)])).rowCount, 0);
  await assert.rejects(f.members.get(randomUUID()), /Member not found/);
}));

test('PostgreSQL registration and tokens retain owner/client binding through revocation and expiry', { skip: !enabled }, async () => use(async f => {
  const id = randomUUID(), secret = credential(), token = 'synthetic-enrollment-token';
  const created = await f.members.agents.create({ registrationId: id, displayName: 'Agent' }, secret);
  assert.equal(created.revoked, false); assert.equal((await f.members.agents.create({ registrationId: id, displayName: 'Retry' }, secret)).displayName, 'Agent');
  await assert.rejects(f.members.agents.get(id, credential()), /credential_invalid/);
  const otherId = randomUUID(), otherSecret = credential();
  await f.members.agents.create({ registrationId: otherId, displayName: 'Other' }, otherSecret);
  await assert.rejects(f.members.agents.bind(id, secret, principal, f.alice.id, token, Date.now() - 1, Date.now(), true), /fresh_authorization_required/);
  await assert.rejects(f.members.agents.bind(id, secret, principal, f.alice.id, token, Date.now() + 60000, Date.now(), false), /fresh_authorization_required/);
  await assert.rejects(f.members.agents.bind(id, secret, principal, f.alice.id, token, Date.now() + 60000, created.createdAt - 5001, true), /fresh_authorization_required/);
  const bound = await f.members.agents.bind(id, secret, principal, f.alice.id, token, Date.now() + 60000, Date.now(), true);
  assert.equal(await f.members.agents.requireOwner(bound, principal), f.alice.id);
  assert.equal((await f.members.agents.authorize(principal, token)).id, id);
  await assert.rejects(f.members.agents.authorize({ ...principal, clientId: 'wrong' }, token), /another identity or OAuth client/);
  await assert.rejects(f.members.agents.authorize({ ...principal, subject: 'bob' }, token), /another identity or OAuth client/);
  await assert.rejects(f.members.agents.bind(otherId, otherSecret, principal, f.alice.id, token, Date.now() + 60000, Date.now(), true), /already bound/);
  assert.equal((await f.members.agents.get(otherId, otherSecret)).memberId, undefined, 'Conflicting enrollment rolls back its binding');
  await f.members.agents.revoke(f.alice.id, id);
  await assert.rejects(f.members.agents.authorize(principal, token), /revoked/);
  await assert.rejects(f.members.agents.requireOwner(bound, principal), /revoked/);
  assert.equal(await f.members.agents.status((await f.members.agents.lookup(id))!, 'manual'), 'agent_registration_revoked');
  await assert.rejects(f.members.agents.bind(otherId, otherSecret, principal, f.alice.id, token, Date.now() + 60000, Date.now(), true), /already bound/);
  await f.admin.query(`UPDATE "${f.schema}".agent_access_tokens SET expires_at=$1 WHERE hash=$2`, [Date.now() - 1, digest(token)]);
  await assert.rejects(f.members.agents.authorize(principal, token), /agent_registration_required/);
  await f.members.agents.bind(otherId, otherSecret, principal, f.alice.id, token, Date.now() + 60000, Date.now(), true);
  const rows = await f.admin.query(`SELECT credential_hash FROM "${f.schema}".agent_registrations WHERE id=$1`, [id]);
  assert.equal(rows.rows[0].credential_hash, digest(secret));
}));

test('PostgreSQL native installation remains stable and requires current connection and identity', { skip: !enabled }, async () => use(async f => {
  const results = await Promise.all(Array.from({ length: 8 }, () => f.members.agents.ensureNativeInstallation(principal, f.alice.id)));
  assert(results.every(value => value.id === f.native.id)); assert.equal((await f.members.agents.list(f.alice.id)).length, 1);
  await assert.rejects(f.members.agents.get(f.native.id, credential()), /credential_invalid/);
  await assert.rejects(f.members.agents.authorizeNative(principal, f.alice.id, 'far-future', Date.now() + 906000), /fresh_authorization_required/);
  await assert.rejects(f.members.agents.authorizeNative(principal, f.alice.id, 'expired', Date.now() - 1), /fresh_authorization_required/);
  await assert.rejects(f.members.agents.ensureNativeInstallation({ ...principal, subject: 'wrong' }, f.alice.id), /agent_registration_required/);
  const connection = (await f.members.connections(f.alice.id))[0]!;
  await f.members.block(f.alice.id, connection.id, true);
  await assert.rejects(f.members.authorize(principal), /connection_revoked/);
  await assert.rejects(f.members.agents.ensureNativeInstallation(principal, f.alice.id), /agent_registration_required/);
  assert.equal((await f.members.authorizationFacts(f.alice.id, f.native.id)).active, false);
  await f.members.block(f.alice.id, connection.id, false);
  const facts = await f.members.authorizationFacts(f.alice.id, f.native.id);
  assert.deepEqual(facts, { ownerKey: ownerKey(principal), memberId: f.alice.id, installationId: f.native.id, clientId: principal.clientId, active: true });
  await f.admin.query(`DELETE FROM "${f.schema}".member_connections WHERE id=$1`, [connection.id]);
  assert.equal((await f.members.authorizationFacts(f.alice.id, f.native.id)).active, true, 'Preserve the source projection: only an explicitly blocked connection denies an existing installation');
  await assert.rejects(f.members.agents.ensureNativeInstallation(principal, f.alice.id), /agent_registration_required/, 'Native enrollment still requires a current connection');
  await f.members.authorize(principal);
  await f.members.agents.revoke(f.alice.id, f.native.id);
  await assert.rejects(f.members.agents.ensureNativeInstallation(principal, f.alice.id), /revoked/);
  assert.equal((await f.members.authorizationFacts(f.alice.id, f.native.id)).active, false);
  await assert.rejects(f.members.authorizationFacts(f.alice.id, randomUUID()), /not bound/);
}));

test('PostgreSQL invitation activation is consent-bound, one-use, member-bound and cannot bypass suspension', { skip: !enabled }, async () => use(async f => {
  const bob = await f.members.login({ ...identity, subject: 'bob' }), carol = await f.members.login({ ...identity, subject: 'carol' });
  const id = randomUUID(), secret = credential();
  const agent = await f.members.agents.create({ registrationId: id, displayName: 'Pending' }, secret);
  const bound = await f.members.agents.bind(id, secret, { ...principal, subject: 'bob' }, bob.id, 'synthetic-bob-token', Date.now() + 60000, Date.now(), true);
  assert.equal(await f.members.agents.status(bound, 'invite-only'), 'registration_required');
  const invitation = await f.members.agents.invite(bob.id);
  await assert.rejects(f.members.agents.redeemForMember(bob.id, invitation.token), /consent/);
  await f.members.apply(bob.id, { ...profile, consent: true }, true);
  assert.equal(await f.members.agents.status(bound, 'invite-only'), 'waiting_invitation');
  assert.equal(await f.members.agents.status(bound, 'manual'), 'pending_approval');
  await assert.rejects(f.members.agents.redeemForMember(carol.id, invitation.token), /another member/);
  const outcomes = await Promise.allSettled([f.members.agents.redeem(bound, { ...principal, subject: 'bob' }, invitation.token), f.members.agents.redeemForMember(bob.id, invitation.token)]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(value => value.status === 'rejected').length, 1);
  assert.equal((await f.members.get(bob.id)).status, 'active');
  const revoked = await f.members.agents.invite(bob.id); await f.members.agents.revokeInvitation(revoked.id);
  await assert.rejects(f.members.agents.redeemForMember(bob.id, revoked.token), /invalid/);
  const expired = await f.members.agents.invite(bob.id);
  await f.admin.query(`UPDATE "${f.schema}".member_invitations SET expires_at=$1 WHERE id=$2`, [Date.now() - 1, expired.id]);
  await assert.rejects(f.members.agents.redeemForMember(bob.id, expired.token), /expired/);
  const suspended = await f.members.agents.invite(bob.id); await f.members.setStatus(bob.id, 'suspended');
  await assert.rejects(f.members.agents.redeemForMember(bob.id, suspended.token), /suspension/);
  await assert.rejects(f.members.agents.invite(bob.id), /non-suspended/);
  const row = (await f.admin.query(`SELECT hash FROM "${f.schema}".member_invitations WHERE id=$1`, [invitation.id])).rows[0];
  assert.equal(row.hash, digest(invitation.token));
  assert.throws(() => f.members.agents.invite(f.alice.id, 1000), /lifetime/);
  await assert.rejects(f.members.agents.revokeInvitation(randomUUID()), /not found/);
}));

test('PostgreSQL enrollment limits serialize concurrent decisions', { skip: !enabled }, async () => use(async f => {
  const pending = await Promise.all(Array.from({ length: 21 }, async () => {
    const id = randomUUID(), secret = credential(); await f.members.agents.create({ registrationId: id, displayName: 'Synthetic Agent' }, secret); return { id, secret };
  }));
  const results = await Promise.allSettled(pending.map(({ id, secret }) => f.members.agents.bind(id, secret, principal, f.alice.id, `synthetic-token-${id}`, Date.now() + 60000, Date.now(), true)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 19, 'Existing native installation counts toward twenty');
  assert.equal(results.filter(result => result.status === 'rejected').length, 2);
  assert.equal((await f.members.agents.list(f.alice.id)).length, 20);
  const unbound = pending[results.findIndex(result => result.status === 'rejected')]!;
  await f.admin.query(`UPDATE "${f.schema}".agent_registrations SET created_at=$1 WHERE id=$2`, [Date.now() - 1800001, unbound.id]);
  await assert.rejects(f.members.agents.bind(unbound.id, unbound.secret, principal, f.alice.id, 'expired-registration', Date.now() + 60000, Date.now(), true), /registration_expired/);
}));

test('PostgreSQL anonymous registration cap ignores expired enrollments and cannot be raced', { skip: !enabled }, async () => use(async f => {
  await f.admin.query(`INSERT INTO "${f.schema}".agent_registrations(id,credential_hash,display_name,created_at)
    SELECT 'synthetic-anonymous-' || n::text,$1,'Synthetic anonymous',$2 FROM generate_series(1,499) AS n`, [digest(credential()), Date.now()]);
  const created = await Promise.allSettled(Array.from({ length: 3 }, () => f.members.agents.create({ registrationId: randomUUID(), displayName: 'Concurrent anonymous' }, credential())));
  assert.equal(created.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(created.filter(result => result.status === 'rejected').length, 2);
  await f.admin.query(`UPDATE "${f.schema}".agent_registrations SET created_at=$1 WHERE id='synthetic-anonymous-1'`, [Date.now() - 1800001]);
  assert.equal((await f.members.agents.create({ registrationId: randomUUID(), displayName: 'Replacement expired slot' }, credential())).memberId, undefined);
}));

test('PostgreSQL revocation awaits deny publication and aborts mutation if the publisher rejects', { skip: !enabled }, async () => use(async f => {
  let reached!: () => void, proceed!: () => void;
  const observed = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { proceed = resolve; });
  f.members.setRevocationObserver(async change => { assert.equal(change.kind, 'installation'); reached(); await gate; });
  const revoking = f.members.agents.revoke(f.alice.id, f.native.id);
  await observed;
  assert.equal((await f.admin.query(`SELECT revoked FROM "${f.schema}".agent_registrations WHERE id=$1`, [f.native.id])).rows[0].revoked, '0');
  proceed(); await revoking;
  assert.equal((await f.members.agents.lookup(f.native.id))?.revoked, true);
  f.members.setRevocationObserver(async () => { throw new Error('deny publication failed'); });
  await assert.rejects(f.members.setStatus(f.alice.id, 'suspended'), /deny publication failed/);
  assert.equal((await f.members.get(f.alice.id)).status, 'active');
  const connection = (await f.members.connections(f.alice.id))[0]!;
  await assert.rejects(f.members.block(f.alice.id, connection.id, true), /deny publication failed/);
  assert.equal((await f.members.connections(f.alice.id))[0]!.blocked, false);
}));

test('PostgreSQL membership transaction rolls back partial writes and checks import identity', { skip: !enabled }, async () => use(async f => {
  await assert.rejects(f.database.run(async client => { await client.query("UPDATE members SET display_name='Uncommitted'"); throw new Error('synthetic rollback'); }), /synthetic rollback/);
  assert.equal((await f.members.get(f.alice.id)).displayName, profile.displayName);
  await assert.rejects(f.database.run(client => client.query('SELECT * FROM nonexistent_membership_table')), /does not exist/);
  assert.equal((await f.members.get(f.alice.id)).displayName, profile.displayName, 'SQL failure cannot leave an aborted connection in the pool');
  const wrong = new PostgresMembershipDatabase(new pg.Pool(), f.schema, '0'.repeat(64));
  try { await assert.rejects(wrong.run(client => client.query('SELECT 1')), /import identity changed/); } finally { await wrong.close(); }
  assert.throws(() => new PostgresMembershipDatabase(new pg.Pool(), 'public', '0'.repeat(64)), /Invalid PostgreSQL membership/);
  await f.database.run(async client => {
    const names = (await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [f.schema])).rows.map(row => row.tablename).sort();
    assert.deepEqual(names, ['agent_access_tokens', 'agent_registrations', 'eigos_membership_migration_receipt', 'member_connections', 'member_invitations', 'member_sessions', 'members']);
  });
}));

test('PostgreSQL membership discards an uncertain commit without retrying the mutation', { skip: !enabled }, async () => use(async f => {
  const pool = new pg.Pool({ max: 1 }); let commitCalls = 0, evictions = 0;
  const wrapped = {
    connect: async () => {
      const client = await pool.connect(), query = client.query.bind(client), release = client.release.bind(client);
      client.query = (async (sql: string, values?: unknown[]) => {
        const result = await query(sql, values);
        if (sql === 'COMMIT') { commitCalls++; throw new Error('synthetic lost acknowledgement'); }
        return result;
      }) as typeof client.query;
      client.release = (error?: Error | boolean) => { if (error) evictions++; release(error); };
      return client;
    },
    end: () => pool.end(),
  };
  const database = new PostgresMembershipDatabase(wrapped as Pick<pg.Pool, 'connect' | 'end'>, f.schema, f.source);
  try {
    await assert.rejects(database.run(client => client.query("UPDATE members SET display_name='Committed before lost reply' WHERE id=$1", [f.alice.id])), /commit outcome is unknown/);
    assert.equal(commitCalls, 1); assert.equal(evictions, 1);
    assert.equal((await f.members.get(f.alice.id)).displayName, 'Committed before lost reply', 'Caller must inspect state instead of blindly retrying');
  } finally { await database.close(); }
}));
