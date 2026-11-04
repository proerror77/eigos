import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { runGraphProgram, type GraphProgram, type ProjectionMetadata } from './graph-program.js';
import type { OntologyObjectStore } from './object-store.js';

/** Host-only synchronous optimization. Async storage runs every original
 * operation unless it explicitly supplies an equivalent transactional adapter. */
type ProjectionDeltaMetadata = ProjectionMetadata & {
  projectionFragment?: (key: string, value: unknown, program: () => GraphProgram<void>) => GraphProgram<void>;
};
export function* projectionFragmentProgram(graph: ProjectionDeltaMetadata, key: string, value: unknown, program: () => GraphProgram<void>): GraphProgram<void> {
  if (graph.projectionFragment) yield* graph.projectionFragment(key, value, program);
  else yield* program();
}
export function projectionDeltaMetadata(graph: OntologyObjectStore): ProjectionDeltaMetadata {
  return { model: graph.model, now: () => graph.now(), releaseRef: graph.releaseRef, security: graph.security,
    *projectionFragment(key, value, program) {
      graph.projectFragment(key, value, () => runGraphProgram(graph, program()));
    } };
}

const implementation = 'execution-projection-delta-v1';
type Epoch = { type: string; revision: number };

/** Internal invalidation only. Clocks and checkpoints roll back with graph writes. */
export function initializeProjectionDelta(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ontology_projection_epochs (
      ontology_id TEXT NOT NULL, owner TEXT NOT NULL, type TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(ontology_id,owner,type));
    CREATE TABLE IF NOT EXISTS ontology_projection_checkpoints (
      ontology_id TEXT NOT NULL, owner TEXT NOT NULL, task_id TEXT NOT NULL,
      model_digest TEXT NOT NULL, epochs TEXT NOT NULL, entries TEXT NOT NULL,
      PRIMARY KEY(ontology_id,owner,task_id));
  `);
  for (const table of [
    'ontology_objects',
    'ontology_links',
    'ontology_scoped_objects',
    'ontology_scoped_links',
  ]) {
    const scoped = table.includes('_scoped_');
    const links = table.endsWith('_links');
    const change = (
      row: string,
    ) => `INSERT INTO ontology_projection_epochs VALUES(
      ${scoped ? row + '.ontology_id' : "'eigos.business'"},${row}.owner,
      ${links ? "'link/' || " : "'object/' || "}${row}.type,1)
      ON CONFLICT(ontology_id,owner,type) DO UPDATE SET revision=revision+1;`;
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const rows =
        event === 'UPDATE'
          ? ['OLD', 'NEW']
          : [event === 'DELETE' ? 'OLD' : 'NEW'];
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_projection_${event.toLowerCase()}
        AFTER ${event} ON ${table} BEGIN ${rows.map(change).join('\n')} END`);
    }
  }
}

export function projectionEpochs(
  db: DatabaseSync,
  ontologyId: string,
  owner: string,
): Epoch[] {
  return db
    .prepare(
      'SELECT type,revision FROM ontology_projection_epochs WHERE ontology_id=? AND owner=? ORDER BY type',
    )
    .all(ontologyId, owner)
    .map((row) => ({ type: String(row.type), revision: Number(row.revision) }));
}

export class ProjectionDelta {
  private readonly entries: Map<string, string>;
  constructor(
    private db: DatabaseSync,
    private ontologyId: string,
    private owner: string,
    private taskId: string,
    private modelDigest: string,
    beforeTask?: Epoch[],
  ) {
    const checkpoint = db
      .prepare(
        'SELECT model_digest,epochs,entries FROM ontology_projection_checkpoints WHERE ontology_id=? AND owner=? AND task_id=?',
      )
      .get(ontologyId, owner, taskId);
    const current = projectionEpochs(db, ontologyId, owner);
    const epochs = beforeTask ?? current;
    // The caller may have just updated the root request from the same locked
    // ledger. Any other graph change requires checking all fragments again.
    const unchanged =
      !beforeTask ||
      digest(current.filter((e) => e.type !== 'object/ServiceRequest')) ===
        digest(beforeTask.filter((e) => e.type !== 'object/ServiceRequest'));
    const valid =
      unchanged &&
      checkpoint?.model_digest === modelDigest &&
      String(checkpoint.epochs) === JSON.stringify(epochs);
    this.entries = new Map(
      valid
        ? Object.entries(
            JSON.parse(String(checkpoint.entries)) as Record<string, string>,
          )
        : [],
    );
  }
  apply(key: string, value: unknown, action: () => unknown): void {
    const next = digest({ implementation, value });
    if (this.entries.get(key) === next) return;
    const result = action();
    if (result && typeof result === 'object' && 'then' in result)
      throw new DomainError('FORBIDDEN', 'Projection must remain synchronous');
    this.entries.set(key, next);
  }
  finish(): void {
    // Cache size cannot prevent a valid task from proceeding. A large task may
    // simply require rebuilding its projection on the next checkpoint.
    const entries =
      this.entries.size <= 10000 ? Object.fromEntries(this.entries) : {};
    this.db
      .prepare(
        `INSERT INTO ontology_projection_checkpoints VALUES(?,?,?,?,?,?)
      ON CONFLICT(ontology_id,owner,task_id) DO UPDATE SET model_digest=excluded.model_digest,epochs=excluded.epochs,entries=excluded.entries`,
      )
      .run(
        this.ontologyId,
        this.owner,
        this.taskId,
        this.modelDigest,
        JSON.stringify(projectionEpochs(this.db, this.ontologyId, this.owner)),
        JSON.stringify(entries),
      );
  }
}
