import type { DatabaseSync } from 'node:sqlite';
import { digest } from '../core/delegation.js';
import { businessTransaction } from '../core/transaction.js';
import type { OntologyModel } from '../ontology/model.js';

/** Internal implementation for named, code-reviewed migrations only. No HTTP
 * command accepts arbitrary contracts or models for this function. */
export function upgradeReviewedPolicy(db: DatabaseSync, previous: OntologyModel, model: OntologyModel, contracts: { before: string; after: string },
  expected: { digest: string; revision: number }, apply = false, now = Date.now()) {
  return businessTransaction(db, () => {
    const settings = db.prepare('SELECT version,mode FROM security_settings WHERE slot=1').get();
    if (settings?.version !== 2 || settings.mode !== 'foundation') throw new Error('An existing Foundation authority is required');
    const stored = db.prepare('SELECT digest FROM security_policy_definitions WHERE slot=1').get()?.digest;
    const revision = Number(db.prepare('SELECT revision FROM security_policy WHERE slot=1').get()?.revision);
    if (stored === contracts.after && expected.digest === contracts.before && revision >= expected.revision + 1
      && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='security_policy_upgrade_receipts'").get()) {
      const receipt = db.prepare("SELECT body FROM security_policy_upgrade_receipts WHERE json_extract(body,'$.before')=? AND json_extract(body,'$.after')=? AND json_extract(body,'$.revision')=?")
        .get(contracts.before, contracts.after, expected.revision);
      if (receipt) return { ...JSON.parse(String(receipt.body)), alreadyApplied: true };
    }
    if (stored !== contracts.before || expected.digest !== stored || revision !== expected.revision) throw new Error('Reviewed policy digest or revision changed');
    if (db.prepare('SELECT 1 FROM security_manager WHERE expires_at>?').get(now) || db.prepare('SELECT 1 FROM work_claims WHERE expires_at>?').get(now)) throw new Error('Stop Gateway and Worker before the policy upgrade');
    if (db.prepare("SELECT 1 FROM security_fences WHERE state NOT IN ('applied','cleared')").get()) throw new Error('Resolve pending authorization fences first');
    const roles = db.prepare('SELECT body FROM security_roles').all().map(row => JSON.parse(String(row.body)))
      .filter(role => role.resource.kind === 'namespace' && role.resource.id === previous.ref.id && role.resource.version === previous.ref.digest && Date.parse(role.expiresAt) > now);
    const additions = roles.map(role => {
      // Existing permissions must be valid in both releases. No new action or
      // function permission is inferred from a namespace role or new schema.
      for (const id of role.executeActions) if (digest(previous.action(id)) !== digest(model.action(id))) throw new Error('Existing action contract changed; review its permission separately');
      for (const id of role.invokeFunctions) if (digest(previous.function(id)) !== digest(model.function(id))) throw new Error('Existing function contract changed; review its permission separately');
      const next = { ...role, resource: { ...role.resource, version: model.ref.digest } }, id = digest([next.subjectKind, next.subjectId, next.resource]);
      const existing = db.prepare('SELECT body FROM security_roles WHERE id=?').get(id);
      if (existing && digest(JSON.parse(String(existing.body))) !== digest(next)) throw new Error('A current-model role already differs; review it separately');
      return { id, role: next };
    });
    const summary = { before: contracts.before, after: contracts.after, revision, nextRevision: revision + 1, namespaceRolesPreserved: additions.length,
      actionsAdded: 0, functionsAdded: 0, expiryExtended: false, applied: apply };
    if (!apply) return summary;
    db.exec("CREATE TABLE IF NOT EXISTS security_policy_upgrade_receipts(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TRIGGER IF NOT EXISTS security_policy_upgrade_immutable_update BEFORE UPDATE ON security_policy_upgrade_receipts BEGIN SELECT RAISE(ABORT,'Policy upgrade receipts are immutable'); END; CREATE TRIGGER IF NOT EXISTS security_policy_upgrade_immutable_delete BEFORE DELETE ON security_policy_upgrade_receipts BEGIN SELECT RAISE(ABORT,'Policy upgrade receipts are immutable'); END;");
    for (const { id, role } of additions) db.prepare('INSERT OR IGNORE INTO security_roles VALUES(?,?,?)').run(id, role.subjectId, JSON.stringify(role));
    if (db.prepare('UPDATE security_policy_definitions SET digest=? WHERE slot=1 AND digest=?').run(contracts.after, contracts.before).changes !== 1
      || db.prepare('UPDATE security_policy SET revision=revision+1 WHERE slot=1 AND revision=?').run(revision).changes !== 1) throw new Error('Policy changed during upgrade');
    db.prepare('INSERT INTO security_policy_upgrade_receipts VALUES(?,?)').run(digest(summary), JSON.stringify({ ...summary, at: new Date(now).toISOString() }));
    return summary;
  });
}
