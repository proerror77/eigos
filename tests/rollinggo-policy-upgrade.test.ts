import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { DefinitionStore } from '../packages/ontology/definition-store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { securityFixture } from './fixtures/security.js';
import { digest } from '../packages/core/delegation.js';
import { rollingGoPolicyContracts } from '../packages/security/policy-store.js';
import { upgradeRollingGoPolicy } from '../packages/security/rollinggo-upgrade.js';
import { JobStore } from '../packages/core/store.js';

test('offline RollingGo policy upgrade preserves existing grants and exact namespace permissions', () => {
  const f = securityFixture(),
    db = new DatabaseSync(f.database),
    policy = f.jobs.security.policies;
  try {
    const install = f.installation('Synthetic policy upgrade'),
      until = new Date(Date.now() + 3600000).toISOString();
    f.coordinator.approveAgentGrant(f.member.id, {
      installationId: install.id,
      capabilityIds: ['ride.estimate.query'],
      resources: [{ type: 'ServiceRequest', fields: ['requestId'] }],
      sourceBindingIds: ['program:ride.estimate.query'],
      channels: ['agent_response', 'registered_model'],
      expiresAt: until,
    });
    policy.setSource(
      f.owner,
      {
        installationId: install.id,
        bindingId: 'program:ride.estimate.query',
        programId: 'ride.estimate.query',
        programDigest: 'a'.repeat(64),
        operations: ['SearchDidiPlaces'],
        outputTypes: ['DidiPlaceObservation'],
        expiresAt: until,
      },
      policy.revision(),
    );
    const role = {
      subjectKind: 'installation' as const,
      subjectId: install.id,
      resource: {
        kind: 'namespace' as const,
        id: policy.model.ref.id,
        version: policy.model.ref.digest,
      },
      role: 'Viewer' as const,
      executeActions: ['SearchDidiPlaces'],
      invokeFunctions: ['rideEstimateStatus'],
      expiresAt: until,
    };
    const current = policy.setRole(role, policy.revision());
    f.coordinator.close();
    const contracts = rollingGoPolicyContracts(policy.model),
      old = {
        ...role,
        resource: {
          ...role.resource,
          version:
            'b800ef526f90c2dfbbb6c82495318bf820145520ce2dd1d63635c8b930c5fca4',
        },
      };
    db.prepare('DELETE FROM security_roles WHERE id=?').run(current.id);
    db.prepare('INSERT INTO security_roles VALUES(?,?,?)').run(
      digest([old.subjectKind, old.subjectId, old.resource]),
      old.subjectId,
      JSON.stringify(old),
    );
    db.prepare(
      'UPDATE security_policy_definitions SET digest=? WHERE slot=1',
    ).run(contracts.before);
    const revision = Number(
        db.prepare('SELECT revision FROM security_policy WHERE slot=1').get()!
          .revision,
      ),
      expected = { digest: contracts.before, revision };
    const grants = db
        .prepare('SELECT * FROM security_grants ORDER BY id')
        .all(),
      sources = db
        .prepare('SELECT * FROM security_sources ORDER BY installation_id')
        .all();
    assert.throws(
      () =>
        upgradeRollingGoPolicy(
          db,
          { ...expected, digest: '0'.repeat(64) },
          true,
        ),
      /changed/,
    );
    db.prepare('UPDATE security_manager SET expires_at=? WHERE slot=1').run(
      Date.now() + 60000,
    );
    assert.throws(
      () => upgradeRollingGoPolicy(db, expected, true),
      /Stop Gateway/,
    );
    db.prepare('UPDATE security_manager SET expires_at=0 WHERE slot=1').run();
    const preview = upgradeRollingGoPolicy(db, expected);
    assert.equal(preview.namespaceRolesPreserved, 1);
    assert.equal(preview.applied, false);
    assert.equal(
      db
        .prepare('SELECT digest FROM security_policy_definitions WHERE slot=1')
        .get()!.digest,
      contracts.before,
    );
    const result = upgradeRollingGoPolicy(db, expected, true);
    assert.equal(result.actionsAdded, 0);
    assert.equal(result.functionsAdded, 0);
    assert.equal(result.expiryExtended, false);
    assert.equal(
      upgradeRollingGoPolicy(db, expected, true).alreadyApplied,
      true,
    );
    assert.equal(
      Number(
        db.prepare('SELECT revision FROM security_policy WHERE slot=1').get()!
          .revision,
      ),
      revision + 1,
    );
    const migrated = JSON.parse(
      String(
        db
          .prepare('SELECT body FROM security_roles WHERE id=?')
          .get(current.id)!.body,
      ),
    );
    assert.deepEqual(migrated, role);
    assert.deepEqual(
      db.prepare('SELECT * FROM security_grants ORDER BY id').all(),
      grants,
    );
    assert.deepEqual(
      db
        .prepare('SELECT * FROM security_sources ORDER BY installation_id')
        .all(),
      sources,
    );
    assert.throws(
      () => db.exec("UPDATE security_policy_upgrade_receipts SET body='{}'"),
      /immutable/,
    );
    const reopened = new JobStore(f.database, { securityMode: 'foundation' });
    try {
      assert.equal(
        reopened.security.policies.definitionDigest,
        contracts.after,
      );
    } finally {
      reopened.close();
    }
  } finally {
    db.close();
    f.close();
  }
});
