import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { securityFixture } from './security.js';
import { OntologyObjectStore } from '../../packages/ontology/object-store.js';
import { currentKernelImplementation } from '../../packages/ontology/definition-store.js';
import { SECURITY_CONTRACT } from '../../packages/security/contracts.js';
import { combineEnvelopes } from '../../packages/security/envelope.js';

// Execution records retain cumulative evidence. Reading the last record must
// check every distinct dependency, without repeating work for each path to it.
export function readDependencyFixture(size: number, suppliedClock?: () => number) {
  const now = Date.now(), clock = suppliedClock ?? (() => now), f = securityFixture(clock), db = new DatabaseSync(f.database);
  const model = currentKernelImplementation(), raw = new OntologyObjectStore(db, model, clock, undefined, { skipLegacyMigration: true });
  const installation = f.installation('dependency-reader'), policy = f.jobs.security.policies;
  const fields = ['placeId', 'displayTitle', 'name'];
  f.coordinator.approveAgentGrant(f.member.id, {
    installationId: installation.id, capabilityIds: ['brief.prepare'],
    resources: [{ type: 'ServiceRequest', fields: ['requestId', 'originalGoal'] }, { type: 'Place', fields }],
    sourceBindingIds: [], channels: ['agent_response', 'registered_model'], expiresAt: new Date(now + 3600000).toISOString(),
  });
  policy.setRecipient(installation.id, {
    classification: 'sensitive', markings: ['member_private', 'personal_data'],
    channels: ['agent_response', 'registered_model'], expiresAt: new Date(now + 3600000).toISOString(),
  }, policy.revision());
  policy.setRole({
    subjectKind: 'installation', subjectId: installation.id,
    resource: { kind: 'namespace', id: model.ref.id, version: model.ref.digest }, role: 'Viewer',
    expiresAt: new Date(now + 3600000).toISOString(),
  }, policy.revision());
  const inputs = Array.from({ length: size }, (_, i) => {
    const object = { type: 'Place', id: `dependency-${i}` }, receipt = { type: 'SourceReceipt', id: `receipt-${i}` };
    raw.ingest(f.owner, { objects: [
      { ref: object, properties: { placeId: object.id, displayTitle: object.id, name: object.id } },
      { ref: receipt, properties: { receiptId: receipt.id, displayTitle: 'Synthetic receipt', safeSummary: 'Synthetic receipt', evidenceLevel: 'synthetic' } },
    ], links: [{ type: 'PlaceEvidence', from: object, to: receipt }] },
      { kind: 'synthetic', id: 'dependency-fixture', observedAt: new Date(now).toISOString() });
    return { object, objectRevision: 1, fields };
  });
  const task = f.task(installation.id);
  f.jobs.security.revokeGrant(f.owner, task.grant.id, 1);
  const grant = f.jobs.security.issueTaskGrant({
    ...task.grant, version: SECURITY_CONTRACT, id: randomUUID(), inputs,
    operations: ['task.process', 'task.query', 'member_asset.read'], channels: ['agent_response', 'registered_model'],
  });
  const envelopes = inputs.map(input => policy.envelope(f.owner, input.object, 1, fields, raw.read(f.owner, input.object).properties, grant.channels));
  for (let i = 1; i < inputs.length; i++) {
    policy.bind(grant, inputs[i]!.object, fields, 'member_asset', combineEnvelopes(envelopes.slice(0, i)));
  }
  const principal = { ...f.principal, access: f.coordinator.authenticate(f.principal, installation.token) };
  return {
    ...f, db, policy, inputs, grant, envelopes, taskAuthority: task.authority,
    read: () => f.jobs.security.withAgent(principal, task.job.id, 'task.query', () => f.jobs.ontology.read(f.owner, inputs.at(-1)!.object)),
    within: (action: () => void) => f.jobs.security.withAgent(principal, task.job.id, 'task.query', () => policy.readSnapshot(action)),
    close: () => { db.close(); f.close(); },
  };
}
