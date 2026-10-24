import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobStore } from '../../packages/core/store.js';
import { MemberStore } from '../../packages/members/store.js';
import { SCOPES, ownerKey, type Job } from '../../packages/core/domain.js';
import { BACKEND_VERSION } from '../../packages/ontology/execution.js';
import { SECURITY_CONTRACT, POLICY_VERSION } from '../../packages/security/contracts.js';
import { AuthorizationCoordinator } from '../../packages/security/coordinator.js';

export function securityFixture(now: () => number = Date.now) {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-security-s1-')), database = join(directory, 'tasks.sqlite'), membership = join(directory, 'members.sqlite');
  const jobs = new JobStore(database, { securityMode: 'foundation', securityNow: now }), members = new MemberStore(membership);
  const coordinator = new AuthorizationCoordinator(jobs.security, members); coordinator.start();
  const principal = { issuer: 'https://synthetic-issuer.example', tenant: 'synthetic', subject: 'alice', clientId: 'registered-connector', scopes: [...SCOPES, 'members:write', 'openid'] };
  const member = members.login(principal);
  members.apply(member.id, { displayName: 'Synthetic Alice', locale: 'zh-CN', timezone: 'Asia/Shanghai', consent: true }, false);
  const owner = ownerKey(principal);
  function installation(name: string) {
    const id = randomUUID(), credential = 'a'.repeat(43), token = `synthetic-${randomUUID()}`;
    members.agents.create({ registrationId: id, displayName: name }, credential);
    members.agents.bind(id, credential, principal, member.id, token, Date.now() + 60000, Date.now(), true);
    members.authorize(principal);
    return { id, credential, token };
  }
  const approve = (installationId: string) => coordinator.approveAgentGrant(member.id, {
    installationId, capabilityIds: ['brief.prepare'], resources: [{ type: 'ServiceRequest', fields: ['requestId', 'originalGoal'] }],
    sourceBindingIds: [], channels: ['agent_response', 'registered_model'], expiresAt: new Date(now() + 3600000).toISOString(),
  });
  function task(installationId: string) {
    const id = randomUUID(), at = new Date(now()).toISOString(), parent = jobs.security.agentGrant(installationId);
    const job: Job = { id, contextId: randomUUID(), service: 'eigos.delegate', goal: 'Synthetic scoped processing', state: 'submitted', messages: [], createdAt: at, updatedAt: at, revision: 1, executionMode: 'worker', runs: [],
      delegation: { backendVersion: BACKEND_VERSION, ontologyReadScope: 'request', phase: 'grounding', events: [], request: { id, revision: 1, originalGoal: 'Synthetic scoped processing', requirements: [], messages: [] } } };
    jobs.save(owner, job);
    const grant = jobs.security.issueTaskGrant({ version: SECURITY_CONTRACT, id: randomUUID(), revision: 1, kind: 'task_data', status: 'active', ownerKey: owner,
      memberId: member.id, approvedByMemberId: member.id, installationId, issuedAt: at, expiresAt: parent.expiresAt,
      parentGrant: { id: parent.id, revision: parent.revision }, taskId: id, requestRevision: 1, purpose: 'synthetic_test', operations: ['task.process'], inputs: [], outputs: [], channels: ['registered_model'] });
    const authority = jobs.security.attachTaskAuthority({ version: SECURITY_CONTRACT, id: randomUUID(), revision: 1, ownerKey: owner, memberId: member.id, installationId,
      taskId: id, requestRevision: 1, agentGrant: { id: parent.id, revision: parent.revision }, dataGrant: { id: grant.id, revision: grant.revision },
      submittedScopes: ['tasks:write'], authEpoch: jobs.security.requireSubject(installationId).epoch, policyVersion: POLICY_VERSION, issuedAt: at, expiresAt: grant.expiresAt });
    return { job, grant, authority };
  }
  return { directory, database, membership, jobs, members, coordinator, principal, member, owner, installation, approve, task,
    close: () => { coordinator.close(); members.close(); jobs.close(); rmSync(directory, { recursive: true, force: true }); } };
}
