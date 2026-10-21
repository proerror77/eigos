import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../core/domain.js';
import { assertBusinessTransaction, businessTransaction } from '../core/transaction.js';
import { digest } from '../core/delegation.js';
import type { OntologyModel } from './model.js';
import { migrateBusinessChain } from './business-chain-migration.js';
import { migrateArchitectureOntology } from './architecture-migration.js';
import { integrationPredecessor, parseHistoricalProperties } from './history-schema.js';

/** Exact committed predecessors: member 52924c1 / effcf66 and main 9a28d37.
 * These changes add optional fields or enum alternatives only. No facts,
 * revisions, source receipts or plan permissions are rewritten. The older UCP
 * CheckoutSession lacks required cost evidence and is deliberately excluded. */
export const INTEGRATION_PREDECESSORS: Readonly<Record<string, readonly string[]>> = {
  "BusinessResult": [
    "0790846d4891497834c2434922909f544d5682b0942bc14b4110ddbf56e2f8cf"
  ],
  "ServiceRequest": [
    "f316a7705aedeae1916494f5fce192ccee10a4b1591e0f431a96f82483cbe33a"
  ],
  "SourceReceipt": [
    "a7047ad0678a1ce005e50164083682bf0dd5d9d58473b36298d50e211e9d3435"
  ],
  "RegisteredActionType": [
    "1889fb389f45f42803a3b3d5399ee727c26b5d9be45dae3c6d8971da25802f43"
  ],
  "RegisteredCapability": [
    "4b03f9f1b4ef93383ffdaeb28f1b6b88a03ddddb7b3346efad19b4a41982b007"
  ]
};

export function migrateIntegratedOntology(db: DatabaseSync, previousBusinessChain: OntologyModel, current: OntologyModel): void {
  let owned = false;
  try { assertBusinessTransaction(db); owned = true; }
  catch (error) { if (!(error instanceof DomainError && error.code === 'CONFLICT')) throw error; }
  const migrate = () => migrateInSavepoint(db, previousBusinessChain, current);
  // A standalone SAVEPOINT starts a deferred transaction. A competing Worker
  // can then commit after our first read, making its later writer upgrade fail
  // immediately even with busy_timeout. Reserve the writer before reading.
  // An existing shared transaction keeps its own commit/rollback authority.
  if (owned) migrate(); else businessTransaction(db, migrate);
}

function migrateInSavepoint(db: DatabaseSync, previousBusinessChain: OntologyModel, current: OntologyModel): void {
  db.exec('SAVEPOINT integrated_ontology_migration');
  try {
    migrateArchitectureOntology(db, current, {
      objects: { ...INTEGRATION_PREDECESSORS, ...Object.fromEntries(['Proposal', 'Authorization', 'OutcomeAssessment', 'RequestSpecification'].map(type => [type, [previousBusinessChain.fingerprint(type)]])) },
      links: Object.fromEntries(['ProposalOffer', 'OrderLineVariant'].map(type => [type, [digest(previousBusinessChain.link(type))]])),
    });
    for (const [type, predecessors] of Object.entries(INTEGRATION_PREDECESSORS)) {
      const currentDigest = current.fingerprint(type);
      for (const row of db.prepare('SELECT owner,id,definition_digest,body FROM ontology_objects WHERE type=?').all(type)) {
        if (row.definition_digest === currentDigest) continue;
        if (!predecessors.includes(String(row.definition_digest))) throw new DomainError('CONFLICT', `Unknown predecessor for ${type}; integration migration refused`);
        const body = JSON.parse(String(row.body));
        const data = parseHistoricalProperties(integrationPredecessor(type, String(row.definition_digest)), body.properties);
        const properties = current.parseProperties(type, data);
        if (digest(data) !== digest(body.properties) || digest(properties) !== digest(body.properties) || properties[current.object(type).primaryKey] !== row.id) {
          throw new DomainError('CONFLICT', 'Integration migration would change recorded facts');
        }
        db.prepare('UPDATE ontology_objects SET definition_digest=? WHERE owner=? AND type=? AND id=?')
          .run(currentDigest, row.owner!, type, row.id!);
      }
    }
    migrateBusinessChain(db, previousBusinessChain, current);
    db.exec('RELEASE integrated_ontology_migration');
  } catch (error) {
    db.exec('ROLLBACK TO integrated_ontology_migration; RELEASE integrated_ontology_migration');
    throw error;
  }
}
