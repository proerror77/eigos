import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Job } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { assertBusinessTransaction } from '../core/transaction.js';
import { ontologyReleaseRefSchema, type OntologyReleaseRef } from './definition-contracts.js';
import { DefinitionStore } from './definition-store.js';

const proofSchema = z.strictObject({ version: z.literal(1), sourceAuthority: z.string().min(1).max(200),
  taskId: z.uuid(), owner: z.string().min(1).max(2000), backend: z.string().min(1), original: ontologyReleaseRefSchema,
  requestDigest: z.string().length(64), artifactDigest: z.string().length(64), target: ontologyReleaseRefSchema,
  verifiedObjectCount: z.number().int().nonnegative(), factDigest: z.string().length(64), createdAt: z.iso.datetime() });

export function initializeTaskReadProjections(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ontology_task_read_projections(owner TEXT NOT NULL,task_id TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(owner,task_id));
    CREATE TRIGGER IF NOT EXISTS ontology_task_read_projections_no_update BEFORE UPDATE ON ontology_task_read_projections BEGIN SELECT RAISE(ABORT,'Historical read projection is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ontology_task_read_projections_no_delete BEFORE DELETE ON ontology_task_read_projections BEGIN SELECT RAISE(ABORT,'Historical read projection is immutable'); END;`);
}

/** Operator-only schema compatibility witness, never a new execution pin or
 * source receipt. Every owned fact must survive the target parser unchanged. */
export function installTaskReadProjection(db: DatabaseSync, owner: string, taskId: string, target: OntologyReleaseRef, sourceAuthority: string): void {
  assertBusinessTransaction(db);
  const row = db.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(owner, taskId);
  if (!row) throw new Error('Historical task is missing');
  const job = JSON.parse(String(row.body)) as Job, original = job.delegation?.ontologyRelease;
  if (!job.delegation || !original) throw new Error('An explicit original release is required for a historical read projection');
  const definitions = new DefinitionStore(db), source = definitions.resolve(original), next = definitions.resolve(target);
  if (original.ontologyId !== target.ontologyId) throw new Error('Historical read projection cannot cross namespaces');
  const objects = db.prepare('SELECT type,id,revision,definition_digest,body FROM ontology_objects WHERE owner=? ORDER BY type,id').all(owner);
  for (const object of objects) {
    const properties = JSON.parse(String(object.body)).properties;
    const currentDigest = next.model.fingerprint(String(object.type));
    if (digest(next.model.parseProperties(String(object.type), properties)) !== digest(properties)
      || currentDigest !== object.definition_digest && !next.compatibleDefinition({ kind: 'object', id: String(object.type), storedDigest: String(object.definition_digest), currentDigest, properties }))
      throw new Error('Historical read projection would reinterpret a stored fact');
  }
  const proof = proofSchema.parse({ version: 1, sourceAuthority, taskId, owner, backend: job.delegation.backendVersion, original: source.ref,
    requestDigest: digest(job.delegation.request), artifactDigest: digest(job.artifact ?? null), target: next.ref,
    verifiedObjectCount: objects.length, factDigest: digest(objects), createdAt: new Date().toISOString() });
  const existing = db.prepare('SELECT body,digest FROM ontology_task_read_projections WHERE owner=? AND task_id=?').get(owner, taskId);
  if (existing) {
    const old = proofSchema.parse(JSON.parse(String(existing.body)));
    if (digest(old) !== existing.digest || digest({ ...old, createdAt: '' }) !== digest({ ...proof, createdAt: '' })) throw new Error('Historical read projection already differs');
    return;
  }
  db.prepare('INSERT INTO ontology_task_read_projections VALUES(?,?,?,?)').run(owner, taskId, JSON.stringify(proof), digest(proof));
}

export function projectedTaskReadRelease(db: DatabaseSync, owner: string, job: Job): OntologyReleaseRef | undefined {
  const row = db.prepare('SELECT body,digest FROM ontology_task_read_projections WHERE owner=? AND task_id=?').get(owner, job.id);
  if (!row) return;
  const proof = proofSchema.parse(JSON.parse(String(row.body)));
  if (digest(proof) !== row.digest || proof.owner !== owner || proof.taskId !== job.id || proof.backend !== job.delegation?.backendVersion
    || digest(proof.original) !== digest(job.delegation?.ontologyRelease ?? null) || proof.requestDigest !== digest(job.delegation?.request)
    || proof.artifactDigest !== digest(job.artifact ?? null)) throw new Error('Historical read projection no longer matches its source task');
  return proof.target;
}

/** Read grants may bind an older writer fingerprint only through the exact
 * reviewed task projection. Dispatch and grants containing task.process never
 * use this exception; the caller must enforce that operation boundary. */
export function compatibleProjectedObject(db: DatabaseSync, owner: string, taskId: string, type: string, storedDigest: string,
  properties: Record<string, unknown>, expectedModelDigest: string): boolean {
  const row=db.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(owner,taskId);
  if(!row)return false;
  const ref=projectedTaskReadRelease(db,owner,JSON.parse(String(row.body)) as Job);if(!ref)return false;
  const release=new DefinitionStore(db).resolve(ref);
  if(release.model.ref.digest!==expectedModelDigest || digest(release.model.parseProperties(type,properties))!==digest(properties))return false;
  const currentDigest=release.model.fingerprint(type);
  return storedDigest===currentDigest || release.compatibleDefinition({kind:'object',id:type,storedDigest,currentDigest,properties});
}
