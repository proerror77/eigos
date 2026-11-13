import { digest, type Principal } from '../core/identity.js';
import type { Ontology } from '../ontology/model.js';
import { Database } from './database.js';
import { Functions } from './functions.js';
import { Objects } from './objects.js';
import { Tasks, type Task } from './tasks.js';

/** A source projection consumes the server-held Function result, never model-supplied rows. */
export interface SourceProjection {
  assertCurrent(owner: string): Promise<void>;
  apply(objects: Objects, source: string, input: Record<string, unknown>, result: unknown): Promise<unknown>;
}
export class Sources {
  constructor(private readonly db: Database, private readonly functions: Functions, private readonly projections: ReadonlyMap<string, SourceProjection>) {}
  async refresh(model: Ontology, name: string, input: Record<string, unknown>, principal: Principal, task: Task, tasks: Tasks, signal: AbortSignal) {
    const mapping = model.sources.get(name), projection = mapping && this.projections.get(mapping.apiName);
    if (!mapping || !projection) throw new Error('Datasource is unavailable');
    await projection.assertCurrent(principal.owner);
    const result = await tasks.source(task, digest({ source: name, input }), input, () => this.functions.invoke(model, mapping.function, input,
      { principal, objects: new Objects(this.db, model, principal.owner), signal, taskId: task.id }));
    signal.throwIfAborted();
    return this.db.transaction(async client => {
      await tasks.current(task, client, true);
      await projection.assertCurrent(principal.owner);
      const output = await projection.apply(new Objects(this.db, model, principal.owner, client), name, input, result);
      signal.throwIfAborted();
      await projection.assertCurrent(principal.owner);
      return output;
    });
  }
}
