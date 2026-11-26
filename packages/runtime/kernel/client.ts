import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Conflict, digest, InvalidInput, NotFound, PermissionDenied } from '../../core/identity.js';
import { combineClassification, marksClassification, sensitivityRank, type Classification } from '../../ontology/classification.js';
import type { ObjectData, ObjectRef } from '../../ontology/schema.js';
import type { Access } from '../access.js';
import { latestCommit } from '../change-feed.js';
import type { Database } from '../database.js';
import type { PublishedOntology } from '../metadata.js';
import { projectView } from '../object-view.js';
import type { Objects } from '../objects.js';
import type { z } from 'zod';
import { nestedValue } from '../query-filter.js';
import type { querySchema } from '../objects.js';
import { compileAggregate, compileQueryOrder, compileSet, loadedColumns, showsType, type KernelPlan } from './plan.js';

/** What the kernel read of one type: the rows the reference reads to evaluate the same set. */
type Reads = { type: string; count: number; rank?: number | null; compartments?: string[]; ids?: string[]; overLimit?: true; markings?: string[];
  /** Some rows read are rows the reference reads with their derived values. */
  enriched?: true }[];
/** `commit` is the owner's last commit the answer reflects. */
/** `membership` digests the members, so a cursor can tell whether they changed between pages. */
type PageResponse = { total: number; refs: ObjectRef[]; types: string[]; membership: string; reads: Reads; commit: number; elapsedMs: number };
type AggregateResponse = { count: number; items: { group: Record<string, unknown>; metrics: Record<string, number | null> }[]; reads: Reads; commit: number; elapsedMs: number };
/** `membership` digests the members and the values they are ordered by. */
type QueryResponse = { total: number; refs: ObjectRef[]; membership: string; reads: Reads; commit: number; elapsedMs: number };
/**
 * The version a query needs: the projection it was compiled for, and the owner's latest commit when it started, which
 * the kernel applies before it answers, waiting at most `waitMs`.
 */
export type KernelVersion = { projection: string; minCommit: number; waitMs?: number };

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

/**
 * The kernel could not answer: it could not be reached, holds no projection, or failed on the query. The reference
 * answers instead. `lost` means the kernel can answer nothing until it loads the projection again.
 */
export class KernelFailed extends Error {
  constructor(message: string, readonly lost: boolean) { super(message); this.name = 'KernelFailed'; }
}

/** A running query kernel on the loopback interface. */
export class KernelClient {
  private constructor(readonly url: string, private readonly child?: ChildProcess) {}
  /** Starts the kernel binary on a free loopback port, with extra environment settings. */
  static async start(binary: string, env: Record<string, string> = {}): Promise<KernelClient> {
    const child = spawn(binary, [], { env: { ...process.env, ...env, EIGOS_KERNEL_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
    const lines = createInterface({ input: child.stdout! });
    const port = await new Promise<number>((resolve, reject) => {
      child.once('exit', code => reject(new Error('Kernel exited with ' + code)));
      lines.once('line', line => resolve((JSON.parse(line) as { port: number }).port));
    });
    // The kernel answers over HTTP, so neither its process nor its output keeps this process running.
    child.unref();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    return new KernelClient(`http://127.0.0.1:${port}`, child);
  }
  /** A client for a kernel service already running at `url`. */
  static connect(url: string) { return new KernelClient(url.replace(/\/$/, '')); }
  /** The kernel process ID, when this client started it. */
  get pid() { return this.child?.pid; }
  /** Asks the kernel process this client started to stop, without waiting for it. */
  kill() { if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM'); }
  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    // Held until the kernel exits, so this process does not end first.
    this.child.ref();
    const exited = new Promise(resolve => this.child!.once('exit', resolve));
    this.child.kill('SIGTERM');
    await exited;
  }
  /**
   * Undefined when the kernel leaves the query to the reference: the reference's evaluation fails, or the kernel cannot
   * read the request (422); or the kernel cannot answer from the version the query needs (409). Throws `KernelFailed`
   * when the kernel cannot be reached or fails.
   */
  private async post<T>(path: string, body: unknown): Promise<T | undefined> {
    let status: number, text: string;
    try {
      const response = await fetch(this.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw new KernelFailed(`Kernel ${path} unreachable: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    if (status === 422 || status === 409) return undefined;
    let value: (T & { error?: string }) | undefined;
    try { value = JSON.parse(text) as T & { error?: string }; } catch { value = undefined; }
    // 503: the kernel holds no projection, after it restarted.
    if (status < 200 || status > 299 || value === undefined) throw new KernelFailed(`Kernel ${path} failed with ${status}: ${value?.error ?? text.slice(0, 300)}`, status === 503);
    return value;
  }
  /**
   * Loads the projection of `model` from the database the kernel can reach at `database`, or restores the kernel's last
   * checkpoint of it when that belongs to the database; `restored` says which.
   */
  async load(db: Database, model: PublishedOntology, database: string) {
    const loaded = await this.post<{ objects: number; edges: number; bytes: number; restored: boolean; elapsedMs: number }>('/load', {
      database, schema: db.schema.replaceAll('"', ''), projection: model.projection,
      types: [...model.objects.keys()].map(name => ({ name, columns: loadedColumns(model, name), classification: model.object(name).classificationProperty })),
      links: [...model.links.keys()], ranks: sensitivityRank,
    });
    if (!loaded) throw new Error('Kernel load failed');
    return loaded;
  }
  page(owner: string, plan: KernelPlan, offset: number, limit: number, version?: KernelVersion) {
    return this.post<PageResponse>('/query', { owner, set: plan.set, rows: plan.rows, derived: plan.derived, members: [...plan.members.values()],
      output: { kind: 'page', offset, limit }, ...version });
  }
  aggregate(owner: string, plan: KernelPlan, output: NonNullable<ReturnType<typeof compileAggregate>>, version?: KernelVersion) {
    return this.post<AggregateResponse>('/query', { owner, set: plan.set, rows: plan.rows, derived: plan.derived, members: [...plan.members.values()],
      output, ...version });
  }
  query(owner: string, plan: KernelPlan, output: NonNullable<ReturnType<typeof compileQueryOrder>>, version?: KernelVersion) {
    return this.post<QueryResponse>('/query', { owner, set: plan.set, rows: plan.rows, derived: plan.derived, members: [...plan.members.values()],
      output, ...version });
  }
  async health() {
    return await (await fetch(this.url + '/health')).json() as { loaded: boolean; loads?: number; projection?: string; objects?: number; edges?: number; changed?: number };
  }
  /** The last commit the kernel has applied for each owner. */
  async positions() { return await (await fetch(this.url + '/positions')).json() as Record<string, number>; }
  /** Writes a checkpoint of the kernel's current version to its data directory. */
  async checkpoint() {
    const written = await this.post<{ checkpoint: string; elapsedMs: number }>('/checkpoint', {});
    if (!written) throw new Error('Kernel checkpoint failed');
    return written;
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
  const version = await versionOf(model, access, graph);
  const plan = await compileSet(model, access, graph, input.set);
  if (!plan) return undefined;
  const response = await kernel.page(access.principal.owner, plan, input.offset ?? 0, input.limit, version);
  if (!response || !observeReads(access, model, plan, response.reads)) return undefined;
  // The reference shows every member in the view, and fails for a member of a type the view cannot show.
  if (input.view && response.types.some(type => !showsType(model, input.view!, type))) return undefined;
  const objects = await hydrate(graph, response.refs);
  // A member deleted or hidden since the kernel answered leaves the page to the reference.
  if (!objects) return undefined;
  const items = objects.map(object => projectView(access, model, object, input.view));
  return { items, total: response.total, membership: response.membership, commit: response.commit, elapsedMs: response.elapsedMs };
}

/** Reads a page's objects as `read` does, together and in page order: undefined when one of them is gone or no longer visible. */
async function hydrate(graph: Objects, refs: readonly ObjectRef[]): Promise<ObjectData[] | undefined> {
  if (!refs.length) return [];
  const found = new Map((await graph.readBatch(refs)).map(object => [digest(object.ref), object]));
  const objects = refs.map(ref => found.get(digest({ type: ref.type, id: ref.id })));
  return objects.every(Boolean) ? objects as ObjectData[] : undefined;
}

/** The version a query needs, read before it starts: every commit of the owner visible then. */
async function versionOf(model: PublishedOntology, access: Access, graph: Objects): Promise<KernelVersion> {
  return { projection: model.projection, minCommit: Number(await latestCommit(graph.db, access.principal.owner, graph.client)) };
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
  const version = await versionOf(model, access, graph);
  const plan = await compileSet(model, access, graph, input.set);
  const output = plan && compileAggregate(model, access, plan, input);
  if (!plan || !output) return undefined;
  const response = await kernel.aggregate(access.principal.owner, plan, output, version);
  if (!response || !observeReads(access, model, plan, response.reads)) return undefined;
  for (const item of response.items)
    for (const value of Object.values(item.metrics))
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Conflict('Numeric aggregation overflow');
  return { count: response.count, items: response.items, commit: response.commit, elapsedMs: response.elapsedMs };
}

/**
 * One page of a query with the kernel, as `Objects.query` gives a query the reference evaluates completely: the members
 * in the reference's order, read through `graph`, each projected into the query's type and its selected fields.
 * Undefined leaves the query to the reference: it has no kernel plan; the reference's evaluation would fail; a member
 * is gone or hidden; or the owner committed after the kernel answered, so the objects read could be newer than the
 * order.
 */
export async function queryWithKernel(kernel: KernelClient, model: PublishedOntology, access: Access, graph: Objects,
  input: { query: z.output<typeof querySchema>; offset: number }) {
  const { query } = input;
  const { limit, cursor: _cursor, select, ...members } = query;
  try { for (const field of select ?? []) model.propertyPath(query.type, field); }
  catch (error) { if (error instanceof InvalidInput || error instanceof NotFound) return undefined; throw error; }
  const version = await versionOf(model, access, graph);
  const plan = await compileSet(model, access, graph, { op: 'query', query: members });
  const output = plan && compileQueryOrder(model, access, plan, query, input.offset, limit);
  if (!plan || !output) return undefined;
  const response = await kernel.query(access.principal.owner, plan, output, version);
  if (!response || !observeReads(access, model, plan, response.reads)) return undefined;
  const objects = await hydrate(graph, response.refs);
  if (!objects || Number(await latestCommit(graph.db, access.principal.owner, graph.client)) !== response.commit) return undefined;
  const contract = model.interfaces.get(query.type);
  const definitions = contract?.properties ?? model.object(query.type).properties;
  const items = objects.map(object => {
    // As the reference projects each match: every field of the query's type, null where the type maps none.
    const projected = { ...object, properties: Object.fromEntries(Object.keys(definitions).map(field => {
      const local = model.propertyName(object.ref.type, query.type, field);
      const label = contract?.properties[field]?.classification;
      const visible = Boolean(local) && access.canSeeModelData(label);
      if (visible) access.observeClassification(label);
      return [field, visible ? object.properties[local!] ?? null : null];
    })) };
    return select ? { ...projected, properties: Object.fromEntries(select.map(field => [field, nestedValue(projected.properties, field)])) } : projected;
  });
  return { items, total: response.total, membership: response.membership, commit: response.commit, elapsedMs: response.elapsedMs };
}
