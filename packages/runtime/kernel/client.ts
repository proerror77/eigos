import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Conflict, InvalidInput, NotFound, PermissionDenied } from '../../core/identity.js';
import { combineClassification, marksClassification, sensitivityRank, type Classification } from '../../ontology/classification.js';
import type { ObjectData, ObjectRef } from '../../ontology/schema.js';
import type { Access } from '../access.js';
import type { Database } from '../database.js';
import type { PublishedOntology } from '../metadata.js';
import { projectView } from '../object-sets.js';
import type { Objects } from '../objects.js';
import { compileAggregate, compileSet, loadedColumns, showsType, type KernelPlan } from './plan.js';

/** What the kernel read of one type: the rows the reference reads to evaluate the same set. */
type Reads = { type: string; count: number; rank?: number | null; compartments?: string[]; ids?: string[]; overLimit?: true; markings?: string[];
  /** Some rows read are rows the reference reads with their derived values. */
  enriched?: true }[];
type PageResponse = { total: number; refs: ObjectRef[]; types: string[]; reads: Reads; elapsedMs: number };
type AggregateResponse = { count: number; items: { group: Record<string, unknown>; metrics: Record<string, number | null> }[]; reads: Reads; elapsedMs: number };

/**
 * Records what the reference records for every row it reads, or returns false so the reference evaluates the set:
 * - each row's label combines the document, its type, its row classification and its markings, and observing the
 *   combination is the same as observing each;
 * - a policy-bound type records a row dependency for every row; past the limit the kernel reports, the reference
 *   decides whether its complete evaluation can hold them;
 * - the markings of rows read are read markings;
 * - reading a row with its derived values checks the visibility of each derived property.
 */
function observeReads(access: Access, model: PublishedOntology, plan: KernelPlan, reads: Reads) {
  if (reads.some(read => read.count && plan.members.get(read.type)?.track && (read.overLimit || !read.ids))) return false;
  const labels = Object.entries(sensitivityRank) as [Classification['sensitivity'], number][];
  for (const read of reads) {
    if (!read.count) continue;
    if (plan.members.get(read.type)?.track) access.trackRows(model, read.type, read.ids!);
    if (read.markings?.length) access.observeReadMarkings(read.markings);
    const sensitivity = read.rank === null || read.rank === undefined ? undefined : labels.find(([, rank]) => rank === read.rank)?.[0];
    const row = sensitivity || read.compartments?.length ? { sensitivity: sensitivity ?? 'PUBLIC', compartments: read.compartments ?? [] } : undefined;
    access.observeClassification(combineClassification(model.document.classification, model.object(read.type).classification, row,
      read.markings?.length ? marksClassification(read.markings) : undefined));
    if (read.enriched) for (const name of plan.enriched.get(read.type) ?? []) access.cellRule(model, read.type, name);
  }
  return true;
}

/** A running query kernel on the loopback interface. */
export class KernelClient {
  private constructor(readonly url: string, private readonly child?: ChildProcess) {}
  /** Starts the kernel binary on a free loopback port. */
  static async start(binary: string): Promise<KernelClient> {
    const child = spawn(binary, [], { env: { ...process.env, EIGOS_KERNEL_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
    const lines = createInterface({ input: child.stdout! });
    const port = await new Promise<number>((resolve, reject) => {
      child.once('exit', code => reject(new Error('Kernel exited with ' + code)));
      lines.once('line', line => resolve((JSON.parse(line) as { port: number }).port));
    });
    return new KernelClient(`http://127.0.0.1:${port}`, child);
  }
  /** The kernel process ID, when this client started it. */
  get pid() { return this.child?.pid; }
  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    const exited = new Promise(resolve => this.child!.once('exit', resolve));
    this.child.kill('SIGTERM');
    await exited;
  }
  /** Undefined when the kernel answers that the reference's evaluation fails, so the reference reports its own error. */
  private async post<T>(path: string, body: unknown): Promise<T | undefined> {
    const response = await fetch(this.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json() as T & { error?: string };
    if (response.status === 422) return undefined;
    if (!response.ok) throw new Error(`Kernel ${path} failed: ${value.error ?? response.status}`);
    return value;
  }
  /** Loads the projection of `model` from the database the kernel can reach at `database`. */
  async load(db: Database, model: PublishedOntology, database: string) {
    const loaded = await this.post<{ objects: number; edges: number; bytes: number; elapsedMs: number }>('/load', {
      database, schema: db.schema.replaceAll('"', ''), projection: model.projection,
      types: [...model.objects.keys()].map(name => ({ name, columns: loadedColumns(model, name), classification: model.object(name).classificationProperty })),
      links: [...model.links.keys()], ranks: sensitivityRank,
    });
    if (!loaded) throw new Error('Kernel load failed');
    return loaded;
  }
  page(owner: string, plan: KernelPlan, offset: number, limit: number) {
    return this.post<PageResponse>('/query', { owner, set: plan.set, rows: plan.rows, derived: plan.derived, members: [...plan.members.values()],
      output: { kind: 'page', offset, limit } });
  }
  aggregate(owner: string, plan: KernelPlan, output: NonNullable<ReturnType<typeof compileAggregate>>) {
    return this.post<AggregateResponse>('/query', { owner, set: plan.set, rows: plan.rows, derived: plan.derived, members: [...plan.members.values()], output });
  }
}

/**
 * The checks the reference makes on a view before it evaluates a set: true when the principal may see the view, false
 * when the view's label is beyond the clearance (the reference then shows nothing), and undefined when the reference
 * reports an error or the kernel path does not cover the view: an Interface with labelled properties, whose labels the
 * reference observes on each object it projects.
 */
function viewShown(access: Access, model: PublishedOntology, view: string) {
  const contract = model.interfaces.get(view);
  try { access.definition(model, contract ? 'interface' : 'object', view); }
  catch (error) {
    if (error instanceof PermissionDenied || error instanceof NotFound || error instanceof InvalidInput) return undefined;
    throw error;
  }
  if (contract && Object.values(contract.properties).some(property => property.classification)) return undefined;
  const label = (contract ?? model.objects.get(view))?.classification;
  if (!access.canSeeModelData(label)) return false;
  access.observeClassification(label);
  return true;
}

/**
 * Evaluates one page of an Object Set with the kernel and reads the page's objects through `graph`, shown in `view`.
 * Undefined means the set has no kernel plan, or the reference's evaluation would fail, so the caller evaluates it with
 * the reference.
 */
export async function evaluateWithKernel(kernel: KernelClient, model: PublishedOntology, access: Access, graph: Objects,
  input: { set: Parameters<typeof compileSet>[3]; view?: string; offset?: number; limit: number }) {
  const shown = input.view ? viewShown(access, model, input.view) : true;
  if (shown === undefined) return undefined;
  if (!shown) return { items: [] as ObjectData[], total: 0, elapsedMs: 0 };
  const plan = await compileSet(model, access, graph, input.set);
  if (!plan) return undefined;
  const response = await kernel.page(access.principal.owner, plan, input.offset ?? 0, input.limit);
  if (!response || !observeReads(access, model, plan, response.reads)) return undefined;
  // The reference shows every member in the view, and fails for a member of a type the view cannot show.
  if (input.view && response.types.some(type => !showsType(model, input.view!, type))) return undefined;
  const items: ObjectData[] = [];
  for (const ref of response.refs) items.push(projectView(access, model, await graph.read(ref), input.view));
  return { items, total: response.total, elapsedMs: response.elapsedMs };
}

/** Aggregates an Object Set with the kernel. Undefined means the reference aggregates it, as for `evaluateWithKernel`. */
export async function aggregateWithKernel(kernel: KernelClient, model: PublishedOntology, access: Access, graph: Objects,
  input: { set: Parameters<typeof compileSet>[3] } & Parameters<typeof compileAggregate>[3]) {
  const shown = input.view ? viewShown(access, model, input.view) : true;
  if (shown === undefined) return undefined;
  if (!shown) {
    // The reference aggregates no members, after it checks the fields against the view.
    try { for (const field of [...input.groupBy, ...Object.values(input.metrics).flatMap(metric => metric.property ? [metric.property] : [])]) model.propertyPath(input.view!, field); }
    catch (error) { if (error instanceof InvalidInput) return undefined; throw error; }
    return { count: 0, elapsedMs: 0, items: input.groupBy.length ? [] : [{ group: {},
      metrics: Object.fromEntries(Object.entries(input.metrics).map(([name, metric]) => [name, metric.op === 'count' ? 0 : null])) }] };
  }
  const plan = await compileSet(model, access, graph, input.set);
  const output = plan && compileAggregate(model, access, plan, input);
  if (!plan || !output) return undefined;
  const response = await kernel.aggregate(access.principal.owner, plan, output);
  if (!response || !observeReads(access, model, plan, response.reads)) return undefined;
  for (const item of response.items)
    for (const value of Object.values(item.metrics))
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Conflict('Numeric aggregation overflow');
  return { count: response.count, items: response.items, elapsedMs: response.elapsedMs };
}
