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
  private projection(model: Ontology, name: string) {
    const mapping = model.sources.get(name), projection = mapping && this.projections.get(mapping.apiName);
    if (!mapping || !projection) throw new Error('Datasource is unavailable');
    return { mapping, projection };
  }
  async read(model: Ontology, name: string, input: Record<string, unknown>, principal: Principal, task: Task | undefined, tasks: Tasks | undefined, signal: AbortSignal) {
    const { mapping, projection } = this.projection(model, name);
    await projection.assertCurrent(principal.owner);
    const invoke = () => this.functions.invoke(model, mapping.function, input, { principal, objects: new Objects(this.db, model, principal.owner), signal, taskId: task?.id });
    // An explicit place selection starts fresh source reads for the resumed task.
    const result = task && tasks ? await tasks.source(task, digest({ source: name, input, places: task.input.places }), input, invoke) : await invoke();
    signal.throwIfAborted();
    return result;
  }
  async project(graph: Objects, name: string, input: Record<string, unknown>, result: unknown, signal: AbortSignal) {
    const { projection } = this.projection(graph.model, name);
    signal.throwIfAborted(); await projection.assertCurrent(graph.owner);
    const output = await projection.apply(graph, name, input, result);
    signal.throwIfAborted(); await projection.assertCurrent(graph.owner);
    return output;
  }
  async refresh(model: Ontology, name: string, input: Record<string, unknown>, principal: Principal, task: Task | undefined, tasks: Tasks | undefined, signal: AbortSignal, view?: { type: string; link: string }) {
    const result = await this.read(model, name, input, principal, task, tasks, signal);
    return this.db.transaction(async client => {
      if (task && tasks) await tasks.current(task, client, true);
      const graph = new Objects(this.db, model, principal.owner, client);
      const output = await this.project(graph, name, input, result, signal);
      // The caller chooses the published Interface/Object Type and receipt Link.
      // Reading this view in the ingestion transaction avoids a model round trip for opaque IDs.
      const query = view ? await graph.query({ type: view.type, from: { object: output.receipt, link: view.link }, limit: 100 }) : undefined;
      signal.throwIfAborted();
      if (task && tasks) await tasks.current(task, client, true);
      return { ...output, ...(query ? { view: query } : {}) };
    });
  }
}
