import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import type { OntologyModel } from './model.js';
import { FROZEN_V14, parseHistoricalProperties } from './history-schema.js';

export interface EarlierPredecessors { objects: Readonly<Record<string, readonly string[]>>; links: Readonly<Record<string, readonly string[]>> }
/** Named v14 → v15 compatibility transition. The integrated migration owns the
 * savepoint, so a failure in a later predecessor pass rolls this pass back too.
 * Only definition hashes change; object/link values, revisions and source bytes
 * remain identical. Task versions, plans, grants and attempts are never replayed. */
export function migrateArchitectureOntology(db: DatabaseSync, current: OntologyModel, earlier: EarlierPredecessors): void {
  if (current.ref.id !== FROZEN_V14.model.id || current.ref.version !== '15') throw new DomainError('CONFLICT', 'Architecture migration requires the named eigos.business v15 target');
  const update = db.prepare('UPDATE ontology_objects SET definition_digest=? WHERE owner=? AND type=? AND id=?');
  for (const [type, old] of Object.entries(FROZEN_V14.objects)) {
    const currentDigest = current.fingerprint(type);
    if (old.fingerprint === currentDigest) continue;
    for (const row of db.prepare('SELECT owner,id,definition_digest,body FROM ontology_objects WHERE type=?').all(type)) {
      if (row.definition_digest === currentDigest) continue;
      if (row.definition_digest !== old.fingerprint) {
        if (earlier.objects[type]?.includes(String(row.definition_digest))) continue;
        throw new DomainError('CONFLICT', `Unknown predecessor for ${type}; architecture migration refused`);
      }
      let data: unknown;
      try { data = JSON.parse(String(row.body)).properties; }
      catch { throw new DomainError('CONFLICT', `Invalid historical object body for ${type}`); }
      const previous = parseHistoricalProperties(old, data), next = current.parseProperties(type, data);
      if (digest(previous) !== digest(data) || digest(next) !== digest(data)
        || previous[old.definition.primaryKey] !== row.id || next[current.object(type).primaryKey] !== row.id)
        throw new DomainError('CONFLICT', 'Architecture migration would change recorded facts');
      update.run(currentDigest, row.owner!, type, row.id!);
    }
  }
  for (const [type, old] of Object.entries(FROZEN_V14.links)) {
    const currentDigest = digest(current.link(type));
    if (old.digest === currentDigest) continue;
    const accepted = [old.digest, currentDigest, ...(earlier.links[type] ?? [])];
    for (const row of db.prepare('SELECT definition_digest FROM ontology_links WHERE type=?').all(type)) {
      if (!accepted.includes(String(row.definition_digest))) throw new DomainError('CONFLICT', `Unknown predecessor for ${type}; architecture migration refused`);
    }
    db.prepare('UPDATE ontology_links SET definition_digest=? WHERE type=? AND definition_digest=?').run(currentDigest, type, old.digest);
  }
}
