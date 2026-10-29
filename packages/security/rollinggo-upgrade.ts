import type { DatabaseSync } from 'node:sqlite';
import { digest } from '../core/delegation.js';
import { businessTransaction } from '../core/transaction.js';
import { currentKernelImplementation } from '../ontology/definition-store.js';
import { rollingGoPolicyContracts } from './policy-store.js';

/** Offline, compare-and-swap operator migration. Never called by startup. */
export function upgradeRollingGoPolicy(
  db: DatabaseSync,
  expected: { digest: string; revision: number },
  apply = false,
  now = Date.now(),
) {
  const model = currentKernelImplementation(),
    contracts = rollingGoPolicyContracts(model);
  if (model.ref.version !== '23')
    throw new Error(
      'This migration supports only the reviewed RollingGo v23 kernel',
    );
  return businessTransaction(db, () => {
    const settings = db
      .prepare('SELECT version,mode FROM security_settings WHERE slot=1')
      .get();
    if (settings?.version !== 2 || settings.mode !== 'foundation')
      throw new Error('An existing Foundation authority is required');
    const stored = db
      .prepare('SELECT digest FROM security_policy_definitions WHERE slot=1')
      .get()?.digest;
    const revision = Number(
      db.prepare('SELECT revision FROM security_policy WHERE slot=1').get()
        ?.revision,
    );
    if (
      stored === contracts.after &&
      expected.digest === contracts.before &&
      revision >= expected.revision + 1 &&
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='security_policy_upgrade_receipts'",
        )
        .get()
    ) {
      const receipt = db
        .prepare(
          "SELECT body FROM security_policy_upgrade_receipts WHERE json_extract(body,'$.before')=? AND json_extract(body,'$.after')=? AND json_extract(body,'$.revision')=?",
        )
        .get(contracts.before, contracts.after, expected.revision);
      if (receipt)
        return { ...JSON.parse(String(receipt.body)), alreadyApplied: true };
    }
    if (
      stored !== contracts.before ||
      expected.digest !== stored ||
      revision !== expected.revision
    )
      throw new Error('Reviewed v22 policy digest or revision changed');
    if (
      db
        .prepare('SELECT 1 FROM security_manager WHERE expires_at>?')
        .get(now) ||
      db.prepare('SELECT 1 FROM work_claims WHERE expires_at>?').get(now)
    )
      throw new Error('Stop Gateway and Worker before the policy upgrade');
    if (
      db
        .prepare(
          "SELECT 1 FROM security_fences WHERE state NOT IN ('applied','cleared')",
        )
        .get()
    )
      throw new Error('Resolve pending authorization fences first');
    const roles = db
      .prepare('SELECT body FROM security_roles')
      .all()
      .map((r) => JSON.parse(String(r.body)))
      .filter(
        (r) =>
          r.resource.kind === 'namespace' &&
          r.resource.id === model.ref.id &&
          r.resource.version ===
            'b800ef526f90c2dfbbb6c82495318bf820145520ce2dd1d63635c8b930c5fca4' &&
          Date.parse(r.expiresAt) > now,
      );
    const additions = roles.map((role) => {
      if (
        role.executeActions.includes('SearchRollingGoHotels') ||
        role.invokeFunctions.includes('rollingGoSearchStatus')
      )
        throw new Error('A v22 role cannot pre-authorize RollingGo');
      for (const action of role.executeActions) model.action(action);
      for (const fn of role.invokeFunctions) model.function(fn);
      const next = {
          ...role,
          resource: { ...role.resource, version: model.ref.digest },
        },
        id = digest([next.subjectKind, next.subjectId, next.resource]);
      const existing = db
        .prepare('SELECT body FROM security_roles WHERE id=?')
        .get(id);
      if (
        existing &&
        digest(JSON.parse(String(existing.body))) !== digest(next)
      )
        throw new Error(
          'A current-model role already differs; review it separately',
        );
      return { id, role: next };
    });
    const summary = {
      before: contracts.before,
      after: contracts.after,
      revision,
      nextRevision: revision + 1,
      namespaceRolesPreserved: additions.length,
      actionsAdded: 0,
      functionsAdded: 0,
      expiryExtended: false,
      applied: apply,
    };
    if (!apply) return summary;
    db.exec(
      "CREATE TABLE IF NOT EXISTS security_policy_upgrade_receipts(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TRIGGER IF NOT EXISTS security_policy_upgrade_immutable_update BEFORE UPDATE ON security_policy_upgrade_receipts BEGIN SELECT RAISE(ABORT,'Policy upgrade receipts are immutable'); END; CREATE TRIGGER IF NOT EXISTS security_policy_upgrade_immutable_delete BEFORE DELETE ON security_policy_upgrade_receipts BEGIN SELECT RAISE(ABORT,'Policy upgrade receipts are immutable'); END;",
    );
    for (const { id, role } of additions)
      db.prepare('INSERT OR IGNORE INTO security_roles VALUES(?,?,?)').run(
        id,
        role.subjectId,
        JSON.stringify(role),
      );
    if (
      db
        .prepare(
          'UPDATE security_policy_definitions SET digest=? WHERE slot=1 AND digest=?',
        )
        .run(contracts.after, contracts.before).changes !== 1 ||
      db
        .prepare(
          'UPDATE security_policy SET revision=revision+1 WHERE slot=1 AND revision=?',
        )
        .run(revision).changes !== 1
    )
      throw new Error('Policy changed during upgrade');
    db.prepare('INSERT INTO security_policy_upgrade_receipts VALUES(?,?)').run(
      digest(summary),
      JSON.stringify({ ...summary, at: new Date(now).toISOString() }),
    );
    return summary;
  });
}
