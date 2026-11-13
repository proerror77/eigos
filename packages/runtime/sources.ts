import { digest } from '../core/identity.js';
import type { Ontology } from '../ontology/model.js';
import type { ObjectRef } from '../ontology/schema.js';
import { Database } from './database.js';
import { Functions } from './functions.js';
import { Objects } from './objects.js';
import { Tasks, type Task } from './tasks.js';
import { Access } from './access.js';
import type { PublishedOntology } from './metadata.js';

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
  bindings(model: Ontology) {
    return Object.fromEntries(model.resolvedDocument.dataSources.map(source => { this.projection(model, source.apiName); return [source.apiName, digest(source)]; }));
  }
  async read(model: PublishedOntology, name: string, input: Record<string, unknown>, access: Access, task: Task | undefined, tasks: Tasks | undefined, signal: AbortSignal) {
    const principal = access.principal; access.definition(model, 'datasource', name);
    const { mapping, projection } = this.projection(model, name);
    access.function(model, mapping.function);
    const provider = model.functions.get(mapping.function)?.source;
    if (provider) access.source(model, provider);
    await projection.assertCurrent(principal.owner);
    const invoke = () => this.functions.invoke(model, mapping.function, input, { principal, objects: new Objects(this.db, model, access), signal, taskId: task?.id,...(task&&tasks?{execution:{task,tasks}}:{}) });
    // An explicit place selection starts fresh source reads for the resumed task.
    const result = task && tasks ? await tasks.source(task, digest({ source: name, input, places: task.input.places,step:task.execution_step??0 }), input, invoke) : await invoke();
    signal.throwIfAborted();
    return result;
  }
  async project(graph: Objects, name: string, input: Record<string, unknown>, result: unknown, signal: AbortSignal) {
    const { projection } = this.projection(graph.model, name);
    graph.access.definition(graph.model, 'datasource', name);
    signal.throwIfAborted(); await projection.assertCurrent(graph.owner);
    const output = await projection.apply(graph, name, input, result);
    signal.throwIfAborted(); await projection.assertCurrent(graph.owner);
    return output;
  }
  async refresh(model: PublishedOntology, name: string, input: Record<string, unknown>, access: Access, task: Task | undefined, tasks: Tasks | undefined, signal: AbortSignal, view?: { type: string; link: string }) {
    const result = await this.read(model, name, input, access, task, tasks, signal);
    return this.db.transaction(async client => {
      if (task && tasks) await tasks.current(task, client, true);
      const graph = new Objects(this.db, model, access, client);
      const output = await this.project(graph, name, input, result, signal);
      // The caller chooses the published Interface/Object Type and receipt Link.
      // Reading this view in the ingestion transaction avoids a model round trip for opaque IDs.
      const query = view ? await graph.query({ type: view.type, from: { object: output.receipt, link: view.link }, limit: 100 }) : undefined;
      signal.throwIfAborted();
      if (task && tasks) await tasks.current(task, client, true);
      await access.refresh(client);
      return { ...output, ...(query ? { view: query } : {}) };
    });
  }
}
