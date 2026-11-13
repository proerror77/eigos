import { digest, type Principal } from '../core/identity.js';
import type { Ontology } from '../ontology/model.js';
import type { ObjectRef } from '../ontology/schema.js';
import { Database } from './database.js';
import { Functions } from './functions.js';
import { Objects } from './objects.js';
import { Tasks, type Task } from './tasks.js';

/** A source projection consumes the server-held Function result, never model-supplied rows. */
export interface SourceProjection {
  assertCurrent(owner: string): Promise<void>;
  apply(objects: Objects, source: string, input: Record<string, unknown>, result: unknown): Promise<{ receipt: ObjectRef; objects: ObjectRef[] }>;
}
export class Sources {
  constructor(private readonly db: Database, private readonly functions: Functions, private readonly projections: ReadonlyMap<string, SourceProjection>) {}
  async refresh(model: Ontology, name: string, input: Record<string, unknown>, principal: Principal, task: Task, tasks: Tasks, signal: AbortSignal, view?: { type: string; link: string }) {
    const mapping = model.sources.get(name), projection = mapping && this.projections.get(mapping.apiName);
    if (!mapping || !projection) throw new Error('Datasource is unavailable');
    await projection.assertCurrent(principal.owner);
    const result = await tasks.source(task, digest({ source: name, input }), input, () => this.functions.invoke(model, mapping.function, input,
      { principal, objects: new Objects(this.db, model, principal.owner), signal, taskId: task.id }));
    signal.throwIfAborted();
    return this.db.transaction(async client => {
      await tasks.current(task, client, true);
      await projection.assertCurrent(principal.owner);
      const graph = new Objects(this.db, model, principal.owner, client);
      const output = await projection.apply(graph, name, input, result);
      // The caller chooses the published Interface/Object Type and receipt Link.
      // Reading this view in the ingestion transaction avoids a model round trip for opaque IDs.
      const query = view ? await graph.query({ type: view.type, from: { object: output.receipt, link: view.link }, limit: 100 }) : undefined;
      signal.throwIfAborted();
      await projection.assertCurrent(principal.owner);
      return { ...output, ...(query ? { view: query } : {}) };
    });
  }
}
