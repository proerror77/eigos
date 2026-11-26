import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Conflict } from '../../core/identity.js';
import { combineClassification, sensitivityRank, type Classification } from '../../ontology/classification.js';
import type { ObjectData, ObjectRef } from '../../ontology/schema.js';
import type { Access } from '../access.js';
import type { Database } from '../database.js';
import type { PublishedOntology } from '../metadata.js';
import type { Objects } from '../objects.js';
import { compileAggregate, compileSet, loadedColumns, type KernelSet } from './plan.js';

type Members = { type: string; count: number; rank?: number | null; compartments?: string[] }[];
type PageResponse = { total: number; refs: ObjectRef[]; members: Members; elapsedMs: number };
type AggregateResponse = { count: number; items: { group: Record<string, unknown>; metrics: Record<string, number | null> }[]; members: Members; elapsedMs: number };

/**
 * Observes what the reference observes when it reads every member: each member's label combines the document, its
 * type and its row classification, and the combination of all of them is the same as observing each.
 */
function observeMembers(access: Access, model: PublishedOntology, members: Members) {
  const labels = Object.entries(sensitivityRank) as [Classification['sensitivity'], number][];
  for (const member of members) {
    if (!member.count) continue;
    const sensitivity = member.rank === null || member.rank === undefined ? undefined : labels.find(([, rank]) => rank === member.rank)?.[0];
    const row = sensitivity || member.compartments?.length ? { sensitivity: sensitivity ?? 'PUBLIC', compartments: member.compartments ?? [] } : undefined;
    access.observeClassification(combineClassification(model.document.classification, model.object(member.type).classification, row));
  }
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
  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(this.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(`Kernel ${path} failed: ${value.error ?? response.status}`);
    return value;
  }
  /** Loads the projection of `model` from the database the kernel can reach at `database`. */
  load(db: Database, model: PublishedOntology, database: string) {
    return this.post<{ objects: number; edges: number; bytes: number; elapsedMs: number }>('/load', {
      database, schema: db.schema.replaceAll('"', ''), projection: model.projection,
      types: [...model.objects.keys()].map(name => ({ name, columns: loadedColumns(model, name), classification: model.object(name).classificationProperty })),
      links: [...model.links.keys()], ranks: sensitivityRank,
    });
  }
  page(owner: string, set: KernelSet, members: string[], offset: number, limit: number) {
    return this.post<PageResponse>('/query', { owner, set, members, output: { kind: 'page', offset, limit } });
  }
  aggregate(owner: string, set: KernelSet, members: string[], output: NonNullable<ReturnType<typeof compileAggregate>>) {
    return this.post<AggregateResponse>('/query', { owner, set, members, output });
  }
}

/**
 * Evaluates one page of an Object Set with the kernel and reads the page's objects through `graph`, as the reference
 * reads every member. Undefined means the set has no kernel plan.
 */
export async function evaluateWithKernel(kernel: KernelClient, model: PublishedOntology, access: Access, graph: Objects,
  input: { set: Parameters<typeof compileSet>[3]; offset?: number; limit: number }) {
  const plan = await compileSet(model, access, graph, input.set);
  if (!plan) return undefined;
  const response = await kernel.page(access.principal.owner, plan.set, [...plan.types], input.offset ?? 0, input.limit);
  observeMembers(access, model, response.members);
  const items: ObjectData[] = [];
  for (const ref of response.refs) items.push(await graph.read(ref));
  return { items, total: response.total, elapsedMs: response.elapsedMs };
}

/** Aggregates an Object Set with the kernel. Undefined means the set or the aggregation has no kernel plan. */
export async function aggregateWithKernel(kernel: KernelClient, model: PublishedOntology, access: Access, graph: Objects,
  input: { set: Parameters<typeof compileSet>[3] } & Parameters<typeof compileAggregate>[3]) {
  const plan = await compileSet(model, access, graph, input.set);
  const output = plan && compileAggregate(model, access, plan, input);
  if (!plan || !output) return undefined;
  const response = await kernel.aggregate(access.principal.owner, plan.set, [...plan.types], output);
  observeMembers(access, model, response.members);
  for (const item of response.items)
    for (const value of Object.values(item.metrics))
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Conflict('Numeric aggregation overflow');
  return { count: response.count, items: response.items, elapsedMs: response.elapsedMs };
}
