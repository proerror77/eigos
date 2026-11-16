import { digest, NotFound } from '../core/identity.js';
import type { Ontology } from '../ontology/model.js';
import type { ObjectRef } from '../ontology/schema.js';
import { Database } from './database.js';
import { Functions } from './functions.js';
import { Objects } from './objects.js';
import { Tasks, type Task } from './tasks.js';
import { Access } from './access.js';
import type { PublishedOntology } from './metadata.js';
import { appendTrace } from './execution-trace.js';

/** A source projection consumes the server-held Function result, never model-supplied rows. */
export interface SourceProjection {
  assertCurrent(owner: string): Promise<void>;
  apply(objects: Objects, source: string, input: Record<string, unknown>, result: unknown): Promise<{ receipt: ObjectRef; objects: ObjectRef[] }>;
}
export class Sources {
  constructor(private readonly db: Database, private readonly functions: Functions, private readonly projections: ReadonlyMap<string, SourceProjection>) {}
  private projection(model: Ontology, name: string) {
    const mapping = model.sources.get(name), projection = mapping && this.projections.get(mapping.apiName);
    if (!mapping) throw new NotFound('Datasource is unavailable');
    if (!projection) throw new Error('Published datasource implementation is unavailable');
    return { mapping, projection };
  }
  bindings(model: Ontology) {
    return Object.fromEntries(model.resolvedDocument.dataSources.map(source => { this.projection(model, source.apiName); return [source.apiName, digest(source)]; }));
  }
  checkReadAccess(model: PublishedOntology, name: string, access: Access) {
    access.definition(model, 'datasource', name);
    const binding = this.projection(model, name);
    const functionName = binding.mapping.function;
    access.function(model, functionName);
    const provider = model.functions.get(functionName)?.source;
    if (provider) access.source(model, provider);
    return binding;
  }
  async read(model: PublishedOntology, name: string, input: Record<string, unknown>, access: Access, task: Task | undefined, tasks: Tasks | undefined, signal: AbortSignal) {
    const principal = access.principal;
    const { mapping, projection } = this.checkReadAccess(model, name, access);
    await projection.assertCurrent(principal.owner);
    const invoke = () => this.functions.invoke(model, mapping.function, input, { principal, objects: new Objects(this.db, model, access), signal, taskId: task?.id,...(task&&tasks?{execution:{task,tasks}}:{}) });
    // A new execution step can request a fresh read when a saved observation no longer qualifies.
    const result = task && tasks ? await tasks.readSource(task, digest({ source: name, input, places: task.input.places,step:task.execution_step??0 }), input, invoke) : await invoke();
    signal.throwIfAborted();
    return result;
  }
  async project(graph: Objects, name: string, input: Record<string, unknown>, result: unknown, signal: AbortSignal) {
    const { projection } = this.projection(graph.model, name);
    graph.access.definition(graph.model, 'datasource', name);
    signal.throwIfAborted(); await projection.assertCurrent(graph.owner);
    const output = await projection.apply(graph, name, input, result);
    signal.throwIfAborted(); await projection.assertCurrent(graph.owner);
    if (graph.change?.taskId) {
      const taskId = graph.change.taskId;
      const linked = (await this.db.query<{ name: string }>(
        `SELECT name FROM ${this.db.schema}.source_calls
          WHERE task_id=$1 AND state='completed' AND result->'receipt'->>'id'=$2 ORDER BY name LIMIT 1`,
        [taskId, output.receipt.id], graph.client)).rows[0]?.name;
      const callId = linked && /^[a-f0-9]{64}$/.test(linked) ? linked : undefined;
      await appendTrace(this.db, { owner: graph.owner, release: graph.model.release, projection: graph.model.projection,
        taskId, requestId: graph.change.requestId, scenarioId: graph.model.scenario },
        { kind: 'source', source: name, receipt: output.receipt, callId }, graph.client, graph.access.dataRequirements());
    }
    return output;
  }
  async refresh(model: PublishedOntology, name: string, input: Record<string, unknown>, access: Access, task: Task | undefined, tasks: Tasks | undefined, signal: AbortSignal, view?: { type: string; link: string }) {
    const result = await this.read(model, name, input, access, task, tasks, signal);
    return this.db.transaction(async client => {
      if (task && tasks) await tasks.current(task, client, true);
      const executor = task
        ? { kind: 'agent' as const, id: 'eigos-ontology-agent' }
        : { kind: 'client' as const, id: access.principal.clientId ?? access.principal.owner };
      const graph = new Objects(this.db, model, access, client,{taskId:task?.id,executor});
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
