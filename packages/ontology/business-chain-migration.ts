import type { DatabaseSync } from 'node:sqlite';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { OntologyModel } from './model.js';

/** Only the named, additive v9 → v10 transition is permitted. Neither facts,
 * revisions, history nor policy grants are rewritten. Unknown definitions fail
 * atomically rather than being blessed by a new fingerprint. */
export function migrateBusinessChain(db: DatabaseSync, previous: OntologyModel, current: OntologyModel): void {
  const objects = ['Proposal', 'Authorization', 'OutcomeAssessment', 'RequestSpecification'];
  const links = ['ProposalOffer', 'OrderLineVariant'];
  db.exec('SAVEPOINT business_chain_migration');
  try {
    for (const type of objects) {
      const oldDigest = previous.fingerprint(type), newDigest = current.fingerprint(type);
      for (const row of db.prepare('SELECT owner,id,definition_digest,body FROM ontology_objects WHERE type=?').all(type)) {
        if (row.definition_digest === newDigest) continue;
        if (row.definition_digest !== oldDigest) throw new DomainError('CONFLICT', `Unknown predecessor for ${type}; migration refused`);
        const body = JSON.parse(String(row.body));
        const oldProperties = previous.parseProperties(type, body.properties);
        const newProperties = current.parseProperties(type, oldProperties);
        if (digest(oldProperties) !== digest(newProperties) || newProperties[current.object(type).primaryKey] !== row.id) {
          throw new DomainError('CONFLICT', 'Business-chain migration would change recorded facts');
        }
        db.prepare('UPDATE ontology_objects SET definition_digest=? WHERE owner=? AND type=? AND id=?')
          .run(newDigest, row.owner!, type, row.id!);
      }
    }
    for (const type of links) {
      const oldDigest = digest(previous.link(type)), newDigest = digest(current.link(type));
      if (db.prepare('SELECT 1 FROM ontology_links WHERE type=? AND definition_digest NOT IN (?,?) LIMIT 1').get(type, oldDigest, newDigest)) {
        throw new DomainError('CONFLICT', `Unknown predecessor for ${type}; migration refused`);
      }
      db.prepare('UPDATE ontology_links SET definition_digest=? WHERE type=? AND definition_digest=?').run(newDigest, type, oldDigest);
    }
    db.exec('RELEASE business_chain_migration');
  } catch (error) {
    db.exec('ROLLBACK TO business_chain_migration; RELEASE business_chain_migration');
    throw error;
  }
}
