import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BUSINESS_MODEL_DEFINITION, businessModel } from '../packages/ontology/business-model.js';
import { JobStore } from '../packages/core/store.js';
import { MemberStore } from '../packages/members/store.js';
import { ownerKey } from '../packages/core/domain.js';
import { digest } from '../packages/core/delegation.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';
import { buildSecurityInventory, schemaPaths, type SecurityBaseline } from '../packages/security/inventory.js';
import { auditMigrationSnapshots } from '../packages/security/migration-audit.js';
import { accessContextSchema, agentAccessGrantSchema, SECURITY_CONTRACT, POLICY_VERSION, taskDataGrantSchema, securityDefaults } from '../packages/security/contracts.js';
import { syntheticOntology } from './fixtures/ontology-objects.js';

const root = resolve('.');
const baseline = (): SecurityBaseline => JSON.parse(readFileSync(join(root, 'packages/security/baseline.json'), 'utf8'));
const principal = { issuer: 'synthetic-issuer', tenant: 'synthetic-tenant', subject: 'PRIVATE_MEMBER_SUBJECT', clientId: 'synthetic-agent', scopes: ['tasks:read', 'tasks:write'] };
const owner = ownerKey(principal);
const issuedAt = '2026-10-24T00:00:00Z', expiresAt = '2026-10-24T01:00:00Z';

test('S0 inventories every definition and nested subtree without changing runtime or granting access', () => {
  const before = structuredClone(businessModel.ref), report = buildSecurityInventory(baseline(), undefined, root);
  assert.deepEqual(report.issues, []);
  assert.equal(report.counts.objectTypes, 193); assert.equal(report.counts.properties, 1769);
  assert(report.counts.nestedPaths > report.counts.properties); assert.equal(report.counts.surfaces, 113);
  assert.equal(report.enforcement, 'not_installed'); assert.equal(report.defaults.automaticLegacyGrant, false);
  assert.equal(report.baselineDigest, digest(baseline()));
  assert.deepEqual(businessModel.ref, before);
  const fields = report.types.flatMap(t => t.properties);
  assert(fields.every(p => p.appliesTo === 'entire_subtree'));
  assert(fields.filter(p => p.openContent || p.restricted).every(p => p.policy === 'internal_only'));
  assert.equal(report.defaults.agentScope, 'task_only');
  assert.equal(report.defaults.automaticMemberResourceRole, 'none');
});

test('S0 rejects unreviewed fields, weakened restrictions, changed nested schemas and stale output paths', () => {
  const b = baseline(); delete b.types.SavedAddress!.fields.address;
  b.types.SavedAddress!.fields.contactInstructions = 'task_private';
  const issues = buildSecurityInventory(b).issues;
  assert(issues.includes('unreviewed_field:SavedAddress.address'));
  assert(issues.includes('restricted_field_weakened:SavedAddress.contactInstructions'));
  const changed = { ...BUSINESS_MODEL_DEFINITION, objects: BUSINESS_MODEL_DEFINITION.objects.map(o => o.id !== 'SavedAddress' ? o : {
    ...o, properties: { ...o.properties, address: { ...o.properties.address!, schema: z.strictObject({ text: z.string(), secretNote: z.string() }) } },
  }) };
  const drift = buildSecurityInventory(baseline(), changed);
  assert(drift.issues.includes('definition_changed:SavedAddress')); assert.equal(drift.passed, false);
  const stale = baseline(); stale.surfaces[0]!.sourceDigest = '0'.repeat(64);
  assert(buildSecurityInventory(stale, undefined, root).issues.includes(`surface_changed:${stale.surfaces[0]!.id}`));
  const path = baseline(); path.surfaces[0]!.file = '../outside.ts';
  assert(buildSecurityInventory(path, undefined, root).issues.includes(`invalid_surface_path:${path.surfaces[0]!.id}`));
});

test('S0 nested coverage includes arrays, unions and unknown record contents', () => {
  const result = schemaPaths(z.toJSONSchema(z.strictObject({ alternatives: z.union([z.strictObject({ address: z.string() }), z.array(z.strictObject({ phone: z.string() }))]), payload: z.record(z.string(), z.unknown()) })));
  assert(result.paths.includes('$.alternatives.address')); assert(result.paths.includes('$.alternatives[].phone'));
  assert(result.openContent); assert(result.paths.some(p => p.startsWith('$.payload.*')));
});

test('S0 contracts distinguish member, installation and worker identities and reject raw credentials', () => {
  const base = { version: SECURITY_CONTRACT, ownerKey: owner, authEpoch: 1, policyVersion: POLICY_VERSION, checkedAt: issuedAt };
  const actor = { ...base, actorKind: 'agent', memberId: randomUUID(), installationId: randomUUID(), clientId: principal.clientId,
    tokenScopes: principal.scopes, agentGrant: { id: randomUUID(), revision: 1 } };
  assert(accessContextSchema.safeParse(actor).success);
  assert(accessContextSchema.safeParse({ ...actor, tokenScopes: [...principal.scopes, 'members:write', 'openid'] }).success);
  assert(accessContextSchema.safeParse({ ...actor, ownerKey: ownerKey({ ...principal, subject: 'opaque*subject' }) }).success);
  assert(!accessContextSchema.safeParse({ ...actor, tokenScopes: ['tasks:read tasks:write'] }).success);
  const { installationId: _installation, ...missing } = actor;
  assert(!accessContextSchema.safeParse(missing).success);
  assert(!accessContextSchema.safeParse({ ...actor, token: 'PRIVATE_TOKEN' }).success);
  assert(!accessContextSchema.safeParse({ ...actor, actorKind: 'member_session' }).success);
  assert(!accessContextSchema.safeParse({ ...actor, actorKind: 'worker' }).success);
  assert(!accessContextSchema.safeParse({ ...actor, ownerKey: 'unverified-owner' }).success);
});

test('S0 grant shapes require exact controller, bounded lifetime and explicit task fields', () => {
  const memberId = randomUUID(), grant = { version: SECURITY_CONTRACT, id: randomUUID(), revision: 1, ownerKey: owner, memberId,
    installationId: randomUUID(), approvedByMemberId: memberId, issuedAt, expiresAt, status: 'active',
    kind: 'agent_access', scope: 'task_only', capabilityIds: ['ride.estimate.query'], resources: [{ type: 'RideEstimateTask', fields: ['id'] }],
    sourceBindingIds: ['didi-readonly'], channels: ['agent_response'] };
  assert(agentAccessGrantSchema.safeParse(grant).success);
  assert(!agentAccessGrantSchema.safeParse({ ...grant, scope: 'owner' }).success);
  assert(!agentAccessGrantSchema.safeParse({ ...grant, sourceBindingIds: ['*'] }).success);
  assert(!agentAccessGrantSchema.safeParse({ ...grant, approvedByMemberId: randomUUID() }).success);
  assert(!agentAccessGrantSchema.safeParse({ ...grant, expiresAt: '2027-01-01T00:00:00Z' }).success);
  const { scope: _scope, capabilityIds: _caps, resources: _resources, sourceBindingIds: _sources, ...common } = grant;
  const task = { ...common, kind: 'task_data', parentGrant: { id: grant.id, revision: 1 }, taskId: randomUUID(), requestRevision: 1,
    operations: ['task.process'], purpose: 'ride_estimate', inputs: [], outputs: [] };
  assert(taskDataGrantSchema.safeParse(task).success);
  assert(!taskDataGrantSchema.safeParse({ ...task, inputs: [{ object: { type: 'SavedAddress', id: 'a' }, objectRevision: 1, fields: ['*'] }] }).success);
  assert.equal(securityDefaults.declassification, 'deny');
});

function snapshots() {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-security-s0-')), dbPath = join(directory, 'tasks.sqlite'), memberPath = join(directory, 'members.sqlite');
  const store = new JobStore(dbPath), f = syntheticOntology(Date.parse(issuedAt));
  store.ontology.ingest(owner, f.batch, f.source); store.close();
  const db = new DatabaseSync(dbPath);
  for (const id of ['D', 'G', 'R']) db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(id, owner, id, 'completed', issuedAt, issuedAt, JSON.stringify({
    id, state: 'completed', goal: 'PRIVATE_GOAL_MARKER', artifact: { data: { markdown: 'PRIVATE_ARTIFACT_MARKER' } }, runs: [{ secret: 'PRIVATE_MODEL_HISTORY' }],
    delegation: { backendVersion: BACKEND_VERSION, request: { id, revision: 1 } },
  }));
  db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(owner, 'submit', 'request', '{}', JSON.stringify({ goal: 'PRIVATE_RESPONSE' }));
  db.close();
  const members = new MemberStore(memberPath), m = members.login(principal);
  members.apply(m.id, { displayName: 'PRIVATE_DISPLAY_NAME', locale: 'zh-CN', timezone: 'Asia/Shanghai', consent: true }, false);
  const first = randomUUID(), second = randomUUID(), credential = 'a'.repeat(43), issued = Date.now();
  for (const id of [first, second]) {
    members.agents.create({ registrationId: id, displayName: 'PRIVATE_INSTALLATION' }, credential);
    members.agents.bind(id, credential, principal, m.id, `PRIVATE_TOKEN_${id}`, issued + 60000, issued, true);
  }
  members.agents.revoke(m.id, second); members.close();
  return { directory, dbPath, memberPath, f, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('S0 dry-run preserves snapshots and distinguishes installation eligibility from historical task authority', () => {
  const f = snapshots();
  try {
    const before = [f.dbPath, f.memberPath].map(p => readFileSync(p));
    const report = auditMigrationSnapshots(f.dbPath, f.memberPath);
    assert.equal(report.tasks.total, 3); assert.equal(report.membership.installations, 2); assert.equal(report.membership.activeInstallations, 1);
    assert.equal(report.membership.revokedInstallations, 1);
    assert.equal(report.tasks.dispositions.requires_new_installation_grant, 3);
    assert(report.objects.dispositions.candidate_requires_evidence_review! > 0);
    assert(report.objects.dispositions.unmapped_requires_explicit_binding! > 0, 'Do not treat graph reachability as task permission');
    assert.equal(report.permissionsGranted, 0); assert.equal(report.writes, 0); assert.equal(report.migrationReady, false);
    assert.equal(report.sourceProvenanceVerified, false); assert.equal(report.crossDatabaseAtomicSnapshot, false);
    const text = JSON.stringify(report);
    assert(!text.includes('PRIVATE_')); assert(!text.includes(owner));
    [f.dbPath, f.memberPath].forEach((p, i) => assert.deepEqual(readFileSync(p), before[i]));
  } finally { f.cleanup(); }
});

test('S0 dry-run quarantines mismatched definitions, stale task revisions and broken links', () => {
  const f = snapshots();
  try {
    const db = new DatabaseSync(f.dbPath);
    db.prepare('UPDATE ontology_objects SET definition_digest=? WHERE type=?').run('changed', 'SavedAddress');
    const row = db.prepare('SELECT body FROM jobs WHERE id=?').get('D')!, job = JSON.parse(String(row.body));
    job.delegation.request.revision = 2; db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(job), 'D');
    const oversized = JSON.parse(String(db.prepare('SELECT body FROM jobs WHERE id=?').get('R')!.body));
    oversized.goal = '界'.repeat(400_000);
    assert(JSON.stringify(oversized).length < 1_000_000 && Buffer.byteLength(JSON.stringify(oversized)) > 1_000_000);
    db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(oversized), 'R');
    db.prepare('UPDATE ontology_links SET definition_digest=? WHERE type=?').run('changed', 'OrderRequest'); db.close();
    const report = auditMigrationSnapshots(f.dbPath);
    assert.equal(report.membership.supplied, false); assert.equal(report.objects.dispositions.definition_mismatch, 2);
    assert(report.objects.dispositions.stale_or_missing_task_evidence! > 0); assert(report.links.requiresReview > 0);
    assert.equal(report.permissionsGranted, 0);
    assert.equal(report.tasks.dispositions.unrecognized_task_contract, 1, 'The per-record limit measures UTF-8 bytes, not characters');
  } finally { f.cleanup(); }
});

test('S0 CLI fails closed on missing schemas and never overwrites an existing output', () => {
  const f = snapshots();
  try {
    const output = join(f.directory, 'report.json');
    const args = ['--import', 'tsx', 'scripts/security-s0.mjs', '--database-snapshot', f.dbPath, '--membership-snapshot', f.memberPath, '--output', output];
    const summary = JSON.parse(execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8' }));
    assert.equal(summary.snapshotInspected, true); assert.equal(summary.enforcement, 'not_installed');
    const original = readFileSync(output);
    const retry = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
    assert.equal(retry.status, 1); assert.deepEqual(readFileSync(output), original); assert(!retry.stderr.includes('PRIVATE_'));
    const missing = join(f.directory, 'missing.sqlite');
    assert.throws(() => auditMigrationSnapshots(missing));
    const db = new DatabaseSync(missing); db.close();
    assert.throws(() => auditMigrationSnapshots(missing), /schema unavailable/);
    const failed = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/security-s0.mjs', '--database-snapshot', missing], { cwd: root, encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.throws(() => auditMigrationSnapshots(f.dbPath, f.dbPath), /separate/);
    writeFileSync(join(f.directory, 'not-db'), 'PRIVATE_SOURCE_MARKER');
    assert.throws(() => auditMigrationSnapshots(join(f.directory, 'not-db')));
  } finally { f.cleanup(); }
});
