import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { securityFixture } from './fixtures/security.js';
import { securityGatewayFixture } from './fixtures/security-gateway.js';
import { ownerKey } from '../packages/core/domain.js';
import { consentDeadline, minimumConsentExpiry } from '../packages/security/consent-lifetime.js';
import { JobStore } from '../packages/core/store.js';
import { persistentConsentPolicyContracts } from '../packages/security/policy-store.js';
import { upgradePersistentConsentPolicy } from '../packages/security/persistent-consent-upgrade.js';
import { authorizationScope } from '../packages/security/context.js';

test('persistent PA and task consent survives a year and restart, while revocation and Worker leases still stop access', t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = securityFixture(() => now);
  try {
    const install = f.installation('Persistent PA', 3 * 365 * 86400000);
    const parent = f.coordinator.approveAgentGrant(f.member.id, { installationId: install.id, capabilityIds: ['brief.prepare'],
      resources: [{ type: 'ServiceRequest', fields: ['requestId', 'originalGoal'] }], sourceBindingIds: ['synthetic-persistent-source'], channels: ['agent_response', 'registered_model'] });
    assert.equal(parent.expiresAt, null);
    const policy = f.jobs.security.policies;
    policy.setRole({ subjectKind: 'installation', subjectId: install.id, resource: { kind: 'namespace', id: policy.model.ref.id, version: policy.model.ref.digest },
      role: 'Viewer', expiresAt: null }, policy.revision());
    policy.setSource(f.owner, { installationId: install.id, bindingId: 'synthetic-persistent-source', programId: 'brief.prepare', programDigest: 'a'.repeat(64),
      operations: ['synthetic-read'], outputTypes: ['ServiceRequest'], expiresAt: null }, policy.revision());
    policy.setRecipient(install.id, { classification: 'private', markings: [], channels: ['registered_model'], expiresAt: null }, policy.revision());
    policy.setModelChannel('persistent-test', { classification: 'private', markings: [], expiresAt: null }, policy.revision());
    const task = f.task(install.id);
    assert.equal(task.grant.expiresAt, null); assert.equal(task.authority.expiresAt, null);
    f.coordinator.close(); now += 400 * 86400000; f.coordinator.start();
    const actor = f.coordinator.authenticate(f.principal, install.token);
    assert.equal(f.jobs.security.agentGrant(install.id).id, parent.id);
    assert(f.jobs.security.workAuthority(f.owner, task.job.id));
    assert.equal(f.jobs.security.withAgent({ ...f.principal, access: actor }, task.job.id, 'task.process', () => true), true);
    assert.equal(policy.sources(f.owner, install.id).length, 1);
    assert.equal(policy.modelChannel('persistent-test').expiresAt, null);
    assert.equal(f.jobs.security.withAgent({ ...f.principal, access: actor }, task.job.id, 'task.process', () =>
      policy.readSnapshot(() => policy.resourceAllowed(authorizationScope()!, 'objectType', 'ServiceRequest'))), true);
    const claim = f.jobs.claim(['eigos.delegate'], 10000, now)!; assert(claim);
    now += 11000;
    assert.equal(f.jobs.claimActive(claim), false, 'Persistent consent does not extend a Worker lease');
    assert.equal(f.jobs.finish(claim, job => { job.state = 'completed'; }), false);
    f.jobs.release(claim);
    f.coordinator.revokeGrant(f.member.id, task.grant.id, task.grant.revision);
    assert.equal(f.jobs.security.workAuthority(f.owner, task.job.id), undefined);
    assert.throws(() => f.jobs.security.withAgent({ ...f.principal, access: actor }, task.job.id, 'task.process', () => true), /AUTHORIZATION_REQUIRED/);
    assert.equal(f.jobs.security.agentGrant(install.id).id, parent.id);
    policy.revokeSource(f.owner, install.id, 'synthetic-persistent-source', policy.revision());
    assert.equal(policy.sources(f.owner, install.id).length, 0);
    f.coordinator.revokeGrant(f.member.id, parent.id, parent.revision);
    assert.throws(() => f.coordinator.authenticate(f.principal, install.token), /AUTHORIZATION_REQUIRED/);
  } finally { f.close(); }
});

test('persistent consent cannot outlive a finite parent, and bounded validation deadlines remain finite', () => {
  const f = securityFixture();
  try {
    const install = f.installation('Finite parent'); f.approve(install.id);
    const task = f.task(install.id);
    assert.throws(() => f.jobs.security.issueTaskGrant({ ...task.grant, id: randomUUID(), expiresAt: null }), /ACCESS_REVOKED/);
    assert.equal(minimumConsentExpiry(null, task.grant.expiresAt), task.grant.expiresAt);
    assert.equal(minimumConsentExpiry(null, null), null);
    assert.equal(consentDeadline(null), Infinity);
    assert.throws(() => consentDeadline('invalid'), /Invalid consent expiry/);
  } finally { f.close(); }
});

test('default permanent consent provisions one shared task for MCP and A2A, and both reject its revoked grant', async () => {
  const f = await securityGatewayFixture(), install = f.install(), client = new Client({ name: 'persistent-consent', version: '1' });
  try {
    const input = f.grantInput(install.id);
    // This fixture has no provider profiles, so approve the established local
    // task permission directly; all transport and task authorization is real.
    f.gateway.security!.approveAgentGrant(f.member.id, { ...input, expiresAt: null }); f.qualify(install.id);
    const headers = { authorization: `Bearer ${install.token}` };
    await client.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { requestInit: { headers } }));
    const created = await f.post('/tasks', { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Synthetic persistent task' }, headers);
    assert.equal(created.status, 200);
    const taskId = String(created.value.id), security = f.gateway.store.security;
    const grant = security.listGrants(ownerKey(f.p)).find(g => g.kind === 'task_data' && g.taskId === taskId)!;
    assert.equal(grant.expiresAt, null);
    assert.equal(security.workAuthority(ownerKey(f.p), taskId)!.expiresAt, null);
    const mcp = await client.callTool({ name: 'get_task', arguments: { taskId } }); assert(!mcp.isError);
    const a2a = await f.post('/a2a', { jsonrpc: '2.0', id: randomUUID(), method: 'GetTask', params: { id: taskId } }, headers);
    assert.equal(a2a.value.result.id, taskId);
    assert.equal((mcp.structuredContent as { result: { id: string } }).result.id, taskId);
    f.gateway.security!.revokeGrant(f.member.id, grant.id, grant.revision);
    assert((await client.callTool({ name: 'get_task', arguments: { taskId } })).isError);
    assert((await f.post('/a2a', { jsonrpc: '2.0', id: randomUUID(), method: 'GetTask', params: { id: taskId } }, headers)).value.error);
  } finally { await client.close(); await f.close(); }
});

test('legacy policy remains finite until an explicit offline upgrade, which preserves expired and revoked grants', () => {
  const f = securityFixture(), db = new DatabaseSync(f.database);
  try {
    const install = f.installation('Legacy finite consent'), grant = f.approve(install.id);
    f.coordinator.revokeGrant(f.member.id, grant.id, grant.revision);
    f.coordinator.close();
    const contracts = persistentConsentPolicyContracts(f.jobs.ontology.model);
    db.prepare('UPDATE security_policy_definitions SET digest=? WHERE slot=1').run(contracts.before);
    const previous = db.prepare('SELECT id,revision,state,expires_at,body FROM security_grants ORDER BY id').all();
    const legacy = new JobStore(f.database, { securityMode: 'foundation' });
    try {
      assert.equal(legacy.security.policies.persistentConsentEnabled, false);
      assert.throws(() => legacy.security.policies.assertConsentExpiry(null), /Persistent consent requires/);
    } finally { legacy.close(); }
    const expected = { digest: contracts.before, revision: Number(db.prepare('SELECT revision FROM security_policy WHERE slot=1').get()!.revision) };
    const preview = upgradePersistentConsentPolicy(db, expected, false);
    assert.equal(preview.expiryExtended, false);
    assert.equal(db.prepare('SELECT digest FROM security_policy_definitions WHERE slot=1').get()!.digest, contracts.before);
    upgradePersistentConsentPolicy(db, expected, true);
    assert.deepEqual(db.prepare('SELECT id,revision,state,expires_at,body FROM security_grants ORDER BY id').all(), previous);
    const upgraded = new JobStore(f.database, { securityMode: 'foundation' });
    try { assert.equal(upgraded.security.policies.persistentConsentEnabled, true); }
    finally { upgraded.close(); }
    assert.equal(upgradePersistentConsentPolicy(db, expected, true).alreadyApplied, true);
  } finally { db.close(); f.close(); }
});
