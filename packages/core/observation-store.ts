import type { DatabaseSync } from 'node:sqlite';
import { digest } from './delegation.js';
import { DomainError } from './domain.js';
import { assertBusinessTransaction } from './transaction.js';
import { prepareObservationSchema, type ObservationContract, type ObservationPins, type PrepareObservation, type ObservationContractView } from '../ontology/observation-contract.js';

const conflict = (): never => { throw new DomainError('CONFLICT', 'Observation contract integrity or revision changed'); };
/** Contract/control metadata in the single business DB. No source fact copy,
 * polling, model invocation, execution grant or scheduling claim is installed. */
export class ObservationContractStore {
  constructor(private db: DatabaseSync, readonly now: () => number) {
    db.exec(`CREATE TABLE IF NOT EXISTS observation_contracts (
      owner TEXT NOT NULL, task_id TEXT NOT NULL, original_task_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, until_ms INTEGER NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(owner,task_id));
      CREATE INDEX IF NOT EXISTS observation_original_task ON observation_contracts(owner,original_task_id);
      CREATE INDEX IF NOT EXISTS observation_contract_horizon ON observation_contracts(owner,status,until_ms);
      CREATE TABLE IF NOT EXISTS observation_contract_events (owner TEXT NOT NULL,task_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,task_id,revision));`);
    for (const operation of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS observation_contract_event_${operation.toLowerCase()} BEFORE ${operation} ON observation_contract_events BEGIN SELECT RAISE(ABORT,'Observation contract audit is immutable'); END`);
  }
  get(owner: string, id: string): ObservationContract {
    const row = this.db.prepare('SELECT body,revision,status,until_ms FROM observation_contracts WHERE owner=? AND task_id=?').get(owner, id);
    if (!row) throw new DomainError('NOT_FOUND', 'Observation contract is unavailable');
    let value: ObservationContract;
    try { value = JSON.parse(String(row.body)); } catch { return conflict(); }
    if (!value || typeof value !== 'object' || value.version !== '1' || value.owner !== owner || value.id !== id || value.revision !== row.revision || value.status !== row.status
      || !['configured', 'revoked'].includes(value.status) || value.revocationRevision !== (value.status === 'revoked' ? 1 : 0)
      || value.revision !== value.revocationRevision + 1 || !prepareObservationSchema.safeParse(value.declaration).success
      || Date.parse(value.declaration.until) !== row.until_ms || value.digest !== digest({ declaration: value.declaration, pins: value.pins })) conflict();
    return value;
  }
  create(owner: string, id: string, declaration: PrepareObservation, pins: ObservationPins): ObservationContract {
    assertBusinessTransaction(this.db);
    declaration = prepareObservationSchema.parse(declaration);
    const now = this.now(), start = Date.parse(declaration.startsAt), end = Date.parse(declaration.until);
    if (end <= now || end > now + 86400000 || start < now - 60000 || end > Date.parse(pins.expiresAt)) throw new DomainError('CONFLICT', 'The declared observation window exceeds current authority or the 24-hour horizon');
    if (Number(this.db.prepare("SELECT count(*) AS n FROM observation_contracts WHERE owner=? AND status='configured' AND until_ms>?").get(owner, now)!.n) >= 100) throw new DomainError('CONFLICT', 'Observation contract capacity reached');
    const value: ObservationContract = { version: '1', id, owner, revision: 1, revocationRevision: 0, status: 'configured', createdAt: new Date(now).toISOString(),
      declaration, pins, digest: digest({ declaration, pins }), usage: { reads: 0, modelTurns: 0, activeMs: 0, costMinor: '0' } };
    this.db.prepare('INSERT INTO observation_contracts VALUES(?,?,?,?,?,?,?)').run(owner, id, declaration.originalTaskId, value.revision, value.status, end, JSON.stringify(value));
    this.event(value, 'configured'); return value;
  }
  revoke(owner: string, id: string, expectedRevision: number): ObservationContract {
    assertBusinessTransaction(this.db);
    const value = this.get(owner, id);
    if (value.revision !== expectedRevision) conflict();
    if (value.status === 'revoked') return value;
    value.status = 'revoked'; value.revision++; value.revocationRevision++; value.revokedAt = new Date(this.now()).toISOString();
    const result = this.db.prepare('UPDATE observation_contracts SET revision=?,status=?,body=? WHERE owner=? AND task_id=? AND revision=?')
      .run(value.revision, value.status, JSON.stringify(value), owner, id, expectedRevision);
    if (result.changes !== 1) conflict();
    this.event(value, 'revoked'); return value;
  }
  private event(value: ObservationContract, kind: string) {
    this.db.prepare('INSERT INTO observation_contract_events VALUES(?,?,?,?)').run(value.owner, value.id, value.revision,
      JSON.stringify({ kind, at: new Date(this.now()).toISOString(), digest: value.digest, revocationRevision: value.revocationRevision }));
  }
  view(owner: string, id: string, sourcePermission: ObservationContractView['sourcePermission']): ObservationContractView {
    const value = this.get(owner, id), d = value.declaration;
    return { id, revision: value.revision, revocationRevision: value.revocationRevision,
      status: value.status === 'revoked' ? 'revoked' : Date.parse(d.until) <= this.now() ? 'expired' : 'configured',
      monitoring: false, targetIdentity: 'unverified', activation: 'observer_not_installed', sourcePermission,
      startsAt: d.startsAt, until: d.until, nextDueAt: value.status === 'configured' && Date.parse(d.until) > this.now() ? d.startsAt : null,
      maxStalenessMs: d.maxStalenessMs, strategy: structuredClone(d.strategy), perReadBudget: structuredClone(d.perReadBudget),
      lifetimeBudget: structuredClone(d.lifetimeBudget), usage: { ...value.usage } };
  }
}
