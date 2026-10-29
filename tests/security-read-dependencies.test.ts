import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { securityFixture } from './fixtures/security.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { currentKernelImplementation } from '../packages/ontology/definition-store.js';
import { SECURITY_CONTRACT } from '../packages/security/contracts.js';
import { authorizationScope } from '../packages/security/context.js';
import { combineEnvelopes, type SecurityEnvelope } from '../packages/security/envelope.js';

// Execution records retain cumulative evidence. Reading the last record must
// check every distinct dependency, without repeating work for each path to it.
function fixture(size: number) {
  const now = Date.now(), f = securityFixture(() => now), db = new DatabaseSync(f.database);
  const model = currentKernelImplementation(), raw = new OntologyObjectStore(db, model, () => now, undefined, { skipLegacyMigration: true });
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
    ...f, db, policy, inputs, grant, envelopes,
    read: () => f.jobs.security.withAgent(principal, task.job.id, 'task.query', () => f.jobs.ontology.read(f.owner, inputs.at(-1)!.object)),
    within: (action: () => void) => f.jobs.security.withAgent(principal, task.job.id, 'task.query', () => policy.readSnapshot(action)),
    close: () => { db.close(); f.close(); },
  };
}

test('cumulative evidence checks database versions in proportion to distinct inputs', t => {
  const f = fixture(48), original = DatabaseSync.prototype.prepare;
  let versionReads = 0, contentReads = 0, statements = 0;
  try {
    t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
      const statement = original.call(this, sql);
      for (const method of ['get', 'all', 'run'] as const) {
        const execute = statement[method].bind(statement);
        t.mock.method(statement, method, (...args: Parameters<typeof execute>) => {
          statements++;
          if (/pragma_data_version|PRAGMA data_version/i.test(sql)) versionReads++;
          if (sql === 'SELECT body,revision FROM ontology_objects WHERE owner=? AND type=? AND id=?') contentReads++;
          return Reflect.apply(execute, statement, args);
        });
      }
      return statement;
    });
    assert.equal(f.read().properties.name, 'dependency-47');
    t.diagnostic(JSON.stringify({ inputs: f.inputs.length, versionReads, contentReads, statements }));
    assert.equal(contentReads, 47, 'Each source content is checked once');
    assert(versionReads <= f.inputs.length * 8 + 40,
      `Shared dependencies caused ${versionReads} version queries for ${f.inputs.length} inputs`);
  } finally { f.close(); }
});

for (const difference of ['digest', 'revision', 'fields'] as const) test(`a repeated dependency with different ${difference} is independently checked`, () => {
  const f = fixture(12);
  try {
    const last = f.inputs.at(-1)!;
    const bad: SecurityEnvelope = structuredClone(combineEnvelopes(f.envelopes.slice(0, -1)));
    const dependency = structuredClone(bad.lineage[0]!);
    if (difference === 'digest') dependency.contentDigest = '0'.repeat(64);
    if (difference === 'revision') dependency.revision++;
    if (difference === 'fields') dependency.fields!.push('address');
    bad.lineage.push(dependency);
    f.policy.bind(f.grant, last.object, last.fields, 'member_asset', bad);
    assert.throws(f.read, /not available|OUTPUT_NOT_ALLOWED/);
  } finally { f.close(); }
});

test('shared dependency proofs do not survive a later content change', () => {
  const f = fixture(12);
  try {
    f.within(() => {
      const scope = authorizationScope()!, last = f.inputs.at(-1)!;
      assert(f.policy.binding(scope, last.object));
      f.db.prepare("UPDATE ontology_objects SET body=json_set(body,'$.properties.name','changed') WHERE owner=? AND type='Place' AND id=?")
        .run(f.owner, f.inputs[0]!.object.id);
      assert.equal(f.policy.binding(scope, last.object), undefined);
    });
  } finally { f.close(); }
});

test('shared dependency proofs cannot conceal a newly restricted ancestor', () => {
  const f = fixture(12);
  try {
    assert.equal(f.read().properties.name, 'dependency-11');
    f.policy.restrictObject({ ownerKey: f.owner, object: f.inputs[0]!.object, expectedObjectRevision: 1,
      field: 'name', classification: 'sensitive', requiredMarkings: ['health'], channels: ['agent_response'] }, f.policy.revision());
    assert.throws(f.read, /not available|INSUFFICIENT_ACCESS|OUTPUT_NOT_ALLOWED/);
  } finally { f.close(); }
});

for (const connection of ['current', 'separate'] as const) test(`a ${connection}-connection write during a dependency read rejects the mixed result`, t => {
  const f = fixture(2), original = DatabaseSync.prototype.prepare;
  let changed = false;
  try {
    t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
      const statement = original.call(this, sql);
      if (sql === 'SELECT body,revision FROM ontology_objects WHERE owner=? AND type=? AND id=?') {
        const get = statement.get.bind(statement), writer = connection === 'current' ? this : f.db;
        t.mock.method(statement, 'get', (...args: Parameters<typeof get>) => {
          const row = Reflect.apply(get, statement, args);
          if (!changed) {
            changed = true;
            original.call(writer, "UPDATE ontology_objects SET body=json_set(body,'$.properties.name','changed during read') WHERE owner=? AND type='Place' AND id=?")
              .run(f.owner, f.inputs[0]!.object.id);
          }
          return row;
        });
      }
      return statement;
    });
    assert.throws(() => f.within(() => { f.policy.binding(authorizationScope()!, f.inputs.at(-1)!.object); }), /POLICY_CHANGED/);
    assert(changed, 'The source changed after its content was read');
    assert.throws(f.read, /not available|OUTPUT_NOT_ALLOWED/, 'A new read must inspect the changed dependency');
  } finally { f.close(); }
});
