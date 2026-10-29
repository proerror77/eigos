import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../packages/core/delegation.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { SECURITY_CONTRACT, POLICY_VERSION, securityEnvelopeSchema } from '../packages/security/contracts.js';
import { combineEnvelopes, requireChannel, type SecurityEnvelope } from '../packages/security/envelope.js';
import { withAuthorization } from '../packages/security/context.js';
import { assertModelChannel, secureRequest } from '../packages/security/model.js';
import { securityFixture } from './fixtures/security.js';
import { historicalAttempt } from './fixtures/security-ledger.js';

function leaf(index: number): SecurityEnvelope {
  return { version: SECURITY_CONTRACT, ownerKey: '["issuer","tenant","alice"]', policyVersion: POLICY_VERSION,
    classification: 'private', requiredMarkings: ['member_private'], channels: ['agent_response', 'registered_model'], lineageComplete: true,
    lineage: [{ object: { type: 'Place', id: `place-${index}` }, revision: 1, fields: ['name'], contentDigest: digest({ name: `place-${index}` }) }] };
}

test('cumulative lineage beyond one input batch retains every dependency and restriction', () => {
  const inputs = Array.from({ length: 210 }, (_, index) => leaf(index));
  inputs[209] = { ...inputs[209]!, classification: 'sensitive', requiredMarkings: ['member_private', 'health'], channels: ['registered_model'] };
  const joined = combineEnvelopes([...inputs, ...inputs]);
  assert.deepEqual(joined.lineage, inputs.flatMap(value => value.lineage));
  assert.equal(joined.classification, 'sensitive');
  assert.deepEqual(joined.channels, ['registered_model']);
  assert(joined.requiredMarkings.includes('health'));
  assert.throws(() => requireChannel(joined, 'registered_model', { classification: 'sensitive', markings: ['member_private'] }), /OUTPUT_NOT_ALLOWED/);
  requireChannel(joined, 'registered_model', { classification: 'sensitive', markings: ['member_private', 'health'] });
  assert.throws(() => requireChannel({ ...joined, lineageComplete: false }, 'registered_model', { classification: 'sensitive', markings: ['member_private', 'health'] }), /OUTPUT_NOT_ALLOWED/);
  assert.throws(() => combineEnvelopes([joined, { ...leaf(211), ownerKey: '["issuer","tenant","bob"]' }]), /OUTPUT_NOT_ALLOWED/);
  const submission = { taskId: randomUUID(), requestRevision: 1, contentDigest: digest('original submission') };
  assert.throws(() => combineEnvelopes([{ ...joined, submission }, { ...leaf(211), submission: { ...submission, requestRevision: 2 } }]), /OUTPUT_NOT_ALLOWED/);
});

test('schema and joins share a bounded cumulative lineage capacity without truncation', () => {
  const full = { ...leaf(0), lineage: Array.from({ length: 2000 }, (_, index) => leaf(index).lineage[0]!) };
  assert.equal(securityEnvelopeSchema.parse(full).lineage.length, 2000);
  assert.equal(combineEnvelopes([full, full]).lineage.length, 2000);
  assert.throws(() => combineEnvelopes([full, leaf(2000)]), /OUTPUT_NOT_ALLOWED/);
  assert.throws(() => securityEnvelopeSchema.parse({ ...full, lineage: [...full.lineage, leaf(2000).lineage[0]!] }));
});

test('expired-claim recovery preserves wide read history and still enforces the final dependency and revocation', async () => {
  const f = securityFixture(), db = new DatabaseSync(f.database);
  const raw = new OntologyObjectStore(db, f.jobs.security.model, Date.now, undefined, { skipLegacyMigration: true });
  try {
    const installation = f.installation('Long-running scoped reader'), policy = f.jobs.security.policies;
    const until = new Date(Date.now() + 3600000).toISOString();
    f.coordinator.approveAgentGrant(f.member.id, { installationId: installation.id, capabilityIds: ['brief.prepare'],
      resources: [
        { type: 'ServiceRequest', fields: ['requestId', 'displayTitle', 'originalGoal', 'revision', 'conditions', 'progress', 'createdAt'] },
        { type: 'Place', fields: ['placeId', 'displayTitle', 'name'] },
      ], sourceBindingIds: [], channels: ['agent_response', 'registered_model'], expiresAt: until });
    policy.setRole({ subjectKind: 'installation', subjectId: installation.id,
      resource: { kind: 'namespace', id: policy.model.ref.id, version: policy.model.ref.digest }, role: 'Viewer', expiresAt: until }, policy.revision());
    policy.setRecipient(installation.id, { classification: 'sensitive', markings: ['member_private', 'personal_data'], channels: ['agent_response', 'registered_model'], expiresAt: until }, policy.revision());
    policy.setModelChannel('lineage-test', { classification: 'sensitive', markings: ['member_private', 'personal_data'], expiresAt: until }, policy.revision());
    const fields = ['placeId', 'displayTitle', 'name'];
    const inputs = Array.from({ length: 30 }, (_, index) => {
      const object = { type: 'Place', id: `source-${index}` }, receipt = { type: 'SourceReceipt', id: `receipt-${index}` };
      raw.ingest(f.owner, { objects: [
        { ref: object, properties: { placeId: object.id, displayTitle: object.id, name: `Synthetic ${index}`, address: { text: 'Synthetic address' } } },
        { ref: receipt, properties: { receiptId: receipt.id, displayTitle: 'Synthetic receipt', safeSummary: 'Synthetic receipt', evidenceLevel: 'synthetic' } },
      ], links: [{ type: 'PlaceEvidence', from: object, to: receipt }] }, { kind: 'synthetic', id: 'fixture', observedAt: new Date().toISOString() });
      return { object, objectRevision: 1, fields };
    });
    const initial = f.task(installation.id);
    f.jobs.security.revokeGrant(f.owner, initial.grant.id, initial.grant.revision);
    const grant = f.jobs.security.issueTaskGrant({ ...initial.grant, id: randomUUID(), inputs,
      operations: ['task.process', 'task.query', 'task.result.read', 'member_asset.read'], channels: ['agent_response', 'registered_model'] });
    const authority = f.jobs.security.attachTaskAuthority({ ...initial.authority, id: randomUUID(),
      dataGrant: { id: grant.id, revision: grant.revision }, submittedScopes: ['tasks:read', 'tasks:write', 'member_assets:read'] });
    const first = f.jobs.claim(['eigos.delegate'], 60000)!;
    assert.equal(first.job.id, initial.job.id);
    const scope = f.jobs.security.workerScope(f.owner, initial.job.id, authority.id, first.token);
    withAuthorization(scope, () => {
      for (const input of inputs) {
        const view = f.jobs.ontology.read(f.owner, input.object);
        for (let mask = 1; mask < 8; mask++) {
          const selected = fields.filter((_, index) => mask & (1 << index));
          policy.capture(scope, policy.envelope(f.owner, input.object, view.revision, selected, view.properties, grant.channels));
        }
      }
    });
    const reads = () => db.prepare('SELECT digest,body FROM security_reads WHERE grant_id=? ORDER BY digest').all(grant.id);
    const before = reads(); assert(before.length > 200);
    assert.equal(db.prepare('UPDATE work_claims SET expires_at=? WHERE job_id=? AND token=?').run(Date.now() - 1, initial.job.id, first.token).changes, 1);
    assert.equal(f.jobs.claim(['eigos.delegate'], 60000), undefined);
    const waiting = f.jobs.get(f.owner, initial.job.id);
    assert.equal(waiting.delegation!.recovery!.code, 'worker_interrupted');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, waiting.delegation!.nextAt! - Date.now()) + 5));
    const recovered = f.jobs.claim(['eigos.delegate'], 60000)!;
    assert(recovered, 'The original task must become claimable after its normal recovery delay');
    assert.equal(recovered.job.id, initial.job.id); assert.notEqual(recovered.token, first.token);
    assert.equal(digest(reads()), digest(before), 'Recovery must retain every original read envelope byte');
    assert.throws(() => f.jobs.security.workerScope(f.owner, initial.job.id, authority.id, first.token), /ACCESS_REVOKED/);
    const current = () => f.jobs.security.workerScope(f.owner, initial.job.id, authority.id, recovered.token);
    withAuthorization(current(), () => {
      const envelope = policy.outputEnvelope(f.owner);
      assert(envelope.lineage.length > 200);
      assertModelChannel(f.jobs.ontology, 'lineage-test');
      secureRequest(f.jobs.ontology, f.owner, f.jobs.get(f.owner, initial.job.id).delegation!.request);
      assert(policy.outputEnvelope(f.owner).lineage.length > envelope.lineage.length, 'Further authorized reads remain part of the complete lineage');
      assertModelChannel(f.jobs.ontology, 'lineage-test');
    });
    const afterGrowth = reads();
    for (const row of before) assert(afterGrowth.some(value => value.digest === row.digest && value.body === row.body));
    const last = inputs.at(-1)!;
    policy.restrictObject({ ownerKey: f.owner, object: last.object, expectedObjectRevision: 1, field: 'name',
      classification: 'sensitive', requiredMarkings: ['health'], channels: ['agent_response', 'registered_model'] }, policy.revision());
    assert.throws(() => withAuthorization(current(), () => assertModelChannel(f.jobs.ontology, 'lineage-test')), /OUTPUT_NOT_ALLOWED/,
      'A restriction on the dependency after the old limit must still deny model output');
    f.jobs.security.revokeGrant(f.owner, grant.id, grant.revision);
    assert.throws(current, /ACCESS_REVOKED/);
    assert.equal(digest(reads()), digest(afterGrowth));
  } finally { db.close(); f.close(); }
});

for (const terminal of [false, true]) test(`lineage overflow parks expired recovery without repeated writes${terminal ? ' or reopening a terminal task' : ''}`, () => {
  const f = securityFixture(), db = new DatabaseSync(f.database);
  try {
    const installation = f.installation('Bounded lineage reader'); f.approve(installation.id);
    const initial = f.task(installation.id), claim = f.jobs.claim(['eigos.delegate'], 60000)!;
    const intentId = randomUUID();
    f.jobs.createIntent(f.owner, { id: intentId, owner: f.owner, jobId: initial.job.id, stepId: 'synthetic-read', businessOperationKey: randomUUID(),
      planDigest: 'synthetic-plan', bindingRef: { id: 'synthetic', version: '1' }, inputDigest: 'input', privateDigest: 'private', privateData: {},
      effect: 'read', state: 'dispatching', nextAt: 0, createdAt: new Date().toISOString() });
    const attempt = historicalAttempt(f.database, claim, intentId, 'synthetic-plan');
    const scope = f.jobs.security.workerScope(f.owner, initial.job.id, initial.authority.id, claim.token);
    const root = { type: 'ServiceRequest', id: initial.job.id };
    const properties = JSON.parse(String(db.prepare('SELECT body FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(f.owner, root.type, root.id)!.body)).properties;
    withAuthorization(scope, () => {
      // Distinct historical root revisions remain separate evidence records.
      // Capacity must also be enforced at recovery when this grant has no
      // task-control fields whose binding would otherwise load read history.
      for (let revision = 1; revision <= 2001; revision++) {
        f.jobs.security.policies.capture(scope, f.jobs.security.policies.envelope(f.owner, root, revision, ['originalGoal'], properties, initial.grant.channels));
      }
    });
    if (terminal) {
      const job = f.jobs.get(f.owner, initial.job.id);
      job.state = 'canceled'; job.delegation!.phase = 'canceled'; job.delegation!.recoveryPending = true;
      job.delegation!.agent = { version: '1', programRef: { id: 'brief.prepare.atomic', version: '1' }, programDigest: 'a'.repeat(64),
        scope: root, input: {}, requestRevision: 1, plans: [], observations: [], feedback: [] };
      db.prepare('UPDATE jobs SET state=?,body=? WHERE id=?').run(job.state, JSON.stringify(job), job.id);
    }
    const reads = () => db.prepare('SELECT digest,body FROM security_reads WHERE grant_id=? ORDER BY digest').all(initial.grant.id);
    const originalReads = digest(reads());
    db.prepare('UPDATE work_claims SET expires_at=? WHERE job_id=?').run(Date.now() - 1, initial.job.id);
    assert.equal(f.jobs.claim(['eigos.delegate'], 60000), undefined);
    const parked = f.jobs.get(f.owner, initial.job.id);
    assert.equal(parked.state, terminal ? 'canceled' : 'paused');
    assert.equal(parked.delegation!.recovery!.state, 'blocked');
    assert.equal(parked.delegation!.recovery!.operation, 'security_lineage_capacity');
    assert.equal(parked.delegation!.recoveryPending, undefined);
    assert.equal(db.prepare('SELECT count(*) AS n FROM work_claims WHERE job_id=?').get(initial.job.id)!.n, 0);
    const before = digest(parked);
    for (let poll = 0; poll < 3; poll++) assert.equal(f.jobs.claim(['eigos.delegate'], 60000), undefined);
    assert.equal(digest(f.jobs.get(f.owner, initial.job.id)), before, 'Polling must not repeat projection or append failures');
    const receipt = { kind: 'confirmed' as const, eventId: 'synthetic-late-capacity', sourceVersion: 1, evidenceRefs: [] };
    const observation = f.jobs.recordObservation(f.owner, intentId, attempt.id, receipt, true,
      { claim, apply: () => assert.fail('A parked task cannot apply a late receipt') });
    assert.equal(observation.applied, false);
    assert.deepEqual(f.jobs.observations(f.owner, intentId), [receipt], 'Capacity parking must retain an already returned receipt as audit evidence');
    assert.equal(digest(f.jobs.get(f.owner, initial.job.id)), before, 'Audit-only receipt must not reopen or mutate the parked task');
    assert.equal(digest(reads()), originalReads);
    assert.equal(f.jobs.security.agentGrant(installation.id).revision, 1);
    assert.throws(() => f.jobs.security.workerScope(f.owner, initial.job.id, initial.authority.id, claim.token), /ACCESS_REVOKED/);
  } finally { db.close(); f.close(); }
});
