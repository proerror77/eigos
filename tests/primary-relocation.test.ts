import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { JobStore } from '../packages/core/store.js';
import { MemberStore } from '../packages/members/store.js';
import { installRuntimeAuthority, runtimeAuthorityMatches, runtimeAuthorityDigest, claimAuthorityCurrent, type RuntimeAuthority } from '../packages/core/runtime-authority.js';
import { planPrimaryRelocation, relocatePrimarySnapshots } from '../packages/deployment/relocation.js';
import { assertPrimaryStores } from '../packages/deployment/preflight.js';
import { readConfig } from '../packages/core/config.js';
import { ownerKey } from '../packages/core/domain.js';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'eigos-primary-relocation-')), live = join(root, 'live'), archive = join(root, 'archive');
  mkdirSync(live, { mode: 0o700 }); mkdirSync(archive, { mode: 0o700 });
  const original = join(live, 'tasks.sqlite'), membership = join(live, 'members.sqlite');
  const jobs = new JobStore(original, { securityMode: 'foundation' });
  const members = new MemberStore(membership);
  const member = members.login({ issuer: 'https://issuer.example/', tenant: 'fixture', subject: 'private-member' });
  const policy = jobs.security.policies;
  policy.setRole({ subjectKind: 'member', subjectId: member.id, resource: { kind: 'namespace', id: policy.model.ref.id, version: policy.model.ref.digest }, role: 'Viewer', expiresAt: null }, policy.revision());
  members.close(); jobs.close();
  const sourceAuthority: RuntimeAuthority = { version: 1, id: randomUUID(), revision: 1, canonicalOrigin: 'https://primary.example', issuer: 'https://issuer.example/', ontologyId: 'eigos.business',
    databasePath: original, membershipDatabasePath: membership, ingresses: [{ origin: 'https://primary.example', audience: 'https://primary.example/', tenantClaim: 'tenant',
      agentClientId: 'agent', agentClientIds: ['agent'], nativeClientIds: [], browserRedirect: false, newRegistrations: true }] };
  const db = new DatabaseSync(original); installRuntimeAuthority(db, sourceAuthority);
  db.prepare('INSERT INTO security_subjects VALUES(?,?,?,?,?,?,?)').run(randomUUID(), ownerKey({ issuer: 'https://issuer.example/', tenant: 'fixture', subject: 'private-member', clientId: 'snapshot-audit', scopes: [] }), member.id, 'agent', 1, 'active', Date.now() + 3600000);
  const body = JSON.stringify({ id: 'kept-task', state: 'completed', authorityId: sourceAuthority.id, sourceReceipt: 'PRIVATE_RECEIPT', externalOperationKey: 'original-key' });
  db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run('kept-task', 'owner', 'request', 'completed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', body);
  db.exec("CREATE TABLE operator_owned_extra(key TEXT PRIMARY KEY,body TEXT); INSERT INTO operator_owned_extra VALUES('kept','PRIVATE_EXTRA'); PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE"); db.close();
  const md = new DatabaseSync(membership); md.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE'); md.close();
  const businessSnapshot = join(archive, 'business.sqlite'), membershipSnapshot = join(archive, 'members.sqlite');
  copyFileSync(original, businessSnapshot); copyFileSync(membership, membershipSnapshot);
  for (const p of [original, membership, businessSnapshot, membershipSnapshot]) chmodSync(p, 0o600);
  const input = { businessSnapshot, membershipSnapshot, sourceAuthority, targetDirectory: join(root, 'destination') };
  return { root, original, membership, input, body, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('primary relocation preserves tasks, original operation keys, membership, consent and authority identity', t => {
  const f = fixture(); t.after(f.close);
  const before = [hash(f.input.businessSnapshot), hash(f.input.membershipSnapshot)];
  const plan = planPrimaryRelocation(f.input);
  assert.equal(plan.permissionsAdded, 0); assert.equal(plan.operationsReplayed, 0); assert.equal(plan.expirationsExtended, false);
  assert(!JSON.stringify(plan).includes('PRIVATE_RECEIPT')); assert(!JSON.stringify(plan).includes('PRIVATE_EXTRA'));
  assert.deepEqual([hash(f.input.businessSnapshot), hash(f.input.membershipSnapshot)], before);
  const result = relocatePrimarySnapshots(f.input, plan.sourceDigest);
  assert.equal(result.activation, 'not_started'); assert.equal(result.authorityId, f.input.sourceAuthority.id); assert.equal(result.authorityRevision, 2);
  assert.equal(hash(join(result.outputDirectory, 'members.sqlite')), before[1]);
  const descriptor = JSON.parse(readFileSync(join(result.outputDirectory, 'authority.json'), 'utf8'));
  const db = new DatabaseSync(descriptor.databasePath);
  assert(runtimeAuthorityMatches(db, descriptor)); assert.equal(db.prepare('SELECT body FROM jobs WHERE id=?').get('kept-task')!.body, f.body);
  assert.equal(db.prepare('SELECT body FROM operator_owned_extra').get()!.body, 'PRIVATE_EXTRA');
  assert.equal(JSON.parse(String(db.prepare('SELECT body FROM security_roles LIMIT 1').get()!.body)).expiresAt, null);
  assert.equal(db.prepare('SELECT count(*) n FROM runtime_authority_events').get()!.n, 2);
  assert.throws(() => db.exec('DELETE FROM primary_relocation_receipts'), /immutable/); db.close();
  assert.deepEqual([hash(f.input.businessSnapshot), hash(f.input.membershipSnapshot)], before);
  assert.throws(() => relocatePrimarySnapshots(f.input, plan.sourceDigest), /new absolute/);
});

test('a later relocation appends its receipt and keeps the first authority history', t => {
  const f = fixture(); t.after(f.close);
  const firstPlan = planPrimaryRelocation(f.input); relocatePrimarySnapshots(f.input, firstPlan.sourceDigest);
  const nextAuthority = JSON.parse(readFileSync(join(f.input.targetDirectory, 'authority.json'), 'utf8'));
  const businessSnapshot = join(f.root, 'second-business.sqlite'), membershipSnapshot = join(f.root, 'second-members.sqlite');
  copyFileSync(nextAuthority.databasePath, businessSnapshot); copyFileSync(nextAuthority.membershipDatabasePath, membershipSnapshot);
  chmodSync(businessSnapshot, 0o600); chmodSync(membershipSnapshot, 0o600);
  const next = { businessSnapshot, membershipSnapshot, sourceAuthority: nextAuthority, targetDirectory: join(f.root, 'second-destination') };
  const plan = planPrimaryRelocation(next); relocatePrimarySnapshots(next, plan.sourceDigest);
  const db = new DatabaseSync(join(next.targetDirectory, 'tasks.sqlite'));
  assert.equal(db.prepare('SELECT count(*) n FROM primary_relocation_receipts').get()!.n, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM runtime_authority_events').get()!.n, 3); db.close();
});

test('reviewed relocation preserves unpublished drafts and historical lease mappings without reviving them', t => {
  const f = fixture(); t.after(f.close);
  const jobs = new JobStore(f.original, { securityMode: 'foundation', authority: f.input.sourceAuthority });
  const draft = jobs.definitions.createDraft('private-operator', 'eigos.business', 'PRIVATE_UNPUBLISHED_TITLE', true); jobs.close();
  const source = new DatabaseSync(f.original), oldToken = randomUUID();
  source.prepare('INSERT INTO runtime_work_claims VALUES(?,?,?)').run('kept-task', oldToken, runtimeAuthorityDigest(f.input.sourceAuthority));
  const original = source.prepare('SELECT * FROM ontology_definition_drafts WHERE id=?').get(draft.id);
  source.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE'); source.close();
  copyFileSync(f.original, f.input.businessSnapshot);
  assert.throws(() => planPrimaryRelocation(f.input), /explicitly preserve unpublished/);
  const input = { ...f.input, preserveUnpublished: true }, plan = planPrimaryRelocation(input);
  assert.equal(plan.unpublishedDraftCount, 1); assert.equal(plan.historicalClaimMappings, 1);
  assert(!JSON.stringify(plan).includes('PRIVATE_UNPUBLISHED_TITLE'));
  relocatePrimarySnapshots(input, plan.sourceDigest);
  const target = new DatabaseSync(join(input.targetDirectory, 'tasks.sqlite'));
  assert.deepEqual(target.prepare('SELECT * FROM ontology_definition_drafts WHERE id=?').get(draft.id), original);
  assert.equal(target.prepare('SELECT count(*) n FROM runtime_work_claims').get()!.n, 1);
  assert.equal(claimAuthorityCurrent(target, 'kept-task', oldToken), false, 'Retained old mapping cannot authorize a late result at the moved authority'); target.close();
});

test('relocation refuses live paths, unclosed snapshots, changed input and outstanding ownership', t => {
  const f = fixture(); t.after(f.close);
  assert.throws(() => planPrimaryRelocation({ ...f.input, businessSnapshot: f.original }), /declared live/);
  writeFileSync(f.input.businessSnapshot + '-wal', '');
  assert.throws(() => planPrimaryRelocation(f.input), /sidecars/); rmSync(f.input.businessSnapshot + '-wal');
  const plan = planPrimaryRelocation(f.input);
  const db = new DatabaseSync(f.input.businessSnapshot); db.prepare('UPDATE operator_owned_extra SET body=?').run('changed'); db.close();
  assert.throws(() => relocatePrimarySnapshots(f.input, plan.sourceDigest), /changed after/); assert(!existsSync(f.input.targetDirectory));
  const busy = new DatabaseSync(f.input.businessSnapshot);
  busy.prepare('INSERT INTO security_manager VALUES(1,?,?)').run('old-writer', Date.now() + 60000); busy.close();
  assert.throws(() => planPrimaryRelocation(f.input), /Stop source writers/);
});

test('primary deployment preview checks both stores read-only and never creates or qualifies a model', t => {
  const f = fixture(); t.after(f.close);
  const descriptor = join(f.root, 'authority.json'); writeFileSync(descriptor, JSON.stringify(f.input.sourceAuthority), { mode: 0o600 });
  const config = readConfig({ EIGOS_AUTHORITY_FILE: descriptor, EIGOS_SECURITY_MODE: 'foundation', EIGOS_AUTH_MODE: 'jwt', HOST: '127.0.0.1',
    PUBLIC_URL: f.input.sourceAuthority.canonicalOrigin, DATABASE_PATH: f.original, MEMBERSHIP_DATABASE_PATH: f.membership,
    OAUTH_ISSUER: f.input.sourceAuthority.issuer, OAUTH_JWKS_URL: 'https://issuer.example/jwks', OAUTH_AUDIENCE: 'https://primary.example/',
    OAUTH_TENANT_CLAIM: 'tenant', OIDC_AGENT_CLIENT_ID: 'agent' });
  const before = [hash(f.original), hash(f.membership)];
  assertPrimaryStores(config, join(f.root, 'live'));
  assert.deepEqual([hash(f.original), hash(f.membership)], before);
  assert.throws(() => assertPrimaryStores({ ...config, EIGOS_EXECUTOR: 'harness' }, join(f.root, 'live')), /no current channel/);
  assert.deepEqual([hash(f.original), hash(f.membership)], before);
  const jobs = new JobStore(f.original, { securityMode: 'foundation', authority: f.input.sourceAuthority });
  jobs.security.policies.setModelChannel('harness-openai-codex', { classification: 'private', markings: [], expiresAt: null }, jobs.security.policies.revision()); jobs.close();
  const qualified = [hash(f.original), hash(f.membership)];
  assertPrimaryStores({ ...config, EIGOS_EXECUTOR: 'harness' }, join(f.root, 'live'));
  assert.throws(() => assertPrimaryStores({ ...config, EIGOS_EXECUTOR: 'harness', EIGOS_HARNESS_CREDENTIAL_KIND: 'api-key' }, join(f.root, 'live')), /no current channel/);
  assert.deepEqual([hash(f.original), hash(f.membership)], qualified, 'An existing until-revoked qualification is read without rewriting it');
  const unrelated = join(f.root, 'unrelated'); mkdirSync(unrelated, { mode: 0o700 });
  assert.throws(() => assertPrimaryStores(config, unrelated), /owned primary runtime/);
});

test('a different membership snapshot cannot authenticate the original business identities', t => {
  const f = fixture(); t.after(f.close);
  const wrong = join(f.root, 'wrong-members.sqlite'), members = new MemberStore(wrong); members.close(); chmodSync(wrong, 0o600);
  const db = new DatabaseSync(wrong); db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE'); db.close();
  assert.throws(() => planPrimaryRelocation({ ...f.input, membershipSnapshot: wrong }), /identities do not match/);
  assert(!existsSync(f.input.targetDirectory));
});
