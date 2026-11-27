import { unprofiled } from '../../core/database-profile.js';
import { canonical } from '../../core/identity.js';
import type { ObjectData } from '../../ontology/schema.js';
import type { Access } from '../access.js';
import { latestCommit } from '../change-feed.js';
import type { Database } from '../database.js';
import type { PublishedOntology } from '../metadata.js';
import { KernelFailed, type KernelClient } from './client.js';
import { defaultKernels, kernelMode, type KernelMode, type KernelRegistry } from './registry.js';

/**
 * How Object Sets and queries use the query kernel: routing, shadow comparisons and kernel cursors, shared by
 * `ObjectSets` and `Objects.query`.
 */

/** Where evaluations find their kernels: the process's registry, or a stand-in for one. */
export type KernelSource = Pick<KernelRegistry, 'kernelFor'> & Partial<Pick<KernelRegistry, 'reload' | 'lost'>>;
/** How an evaluation uses the query kernel: its mode and where it finds its kernels. */
export type KernelUse = { mode: KernelMode; registry: KernelSource };
/** The process's kernel use, from EIGOS_KERNEL and the process's kernels. */
export const defaultKernelUse = (): KernelUse => ({ mode: kernelMode(), registry: defaultKernels() });

/** A kernel cursor: the evaluation it continues, where the next page starts, and the members it was computed over. */
export type KernelCursor = { identity: string; offset: number; membership: string };
export const encodeKernelCursor = (cursor: KernelCursor) => Buffer.from(JSON.stringify({ kernel: cursor })).toString('base64url');
export function kernelCursor(cursor: string): KernelCursor | undefined {
  try {
    const value = (JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { kernel?: Partial<KernelCursor> }).kernel;
    return value && typeof value.identity === 'string' && Number.isInteger(value.offset) && value.offset! >= 0 && typeof value.membership === 'string'
      ? value as KernelCursor : undefined;
  } catch { return undefined; }
}
/** Where a reference cursor's page starts. */
export function referenceOffset(cursor: string) {
  try { return Math.max(0, Number((JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { offset?: number }).offset) || 0); }
  catch { return 0; }
}

/** Runs an operation with a fork of the principal's access in its own egress scope, and reports what it recorded. */
async function isolated<T>(access: Access, operation: (fork: Access) => Promise<T>) {
  const fork = await access.fork();
  const measured = await fork.measureEgress(() => operation(fork));
  return { result: measured.result, classification: measured.classification, requirements: measured.requirements, markings: fork.readMarkingsSnapshot() };
}
type Recorded = Awaited<ReturnType<typeof isolated<unknown>>>;
/** Ontology values of objects: a missing value and null are the same value. */
export const ontologyValues = (items: readonly ObjectData[]) => items.map(item => ({ ref: item.ref, revision: item.revision,
  properties: Object.fromEntries(Object.entries(item.properties).filter(([, value]) => value !== null && value !== undefined)) }));
/**
 * How the kernel's answer differs from the reference's, or undefined: the results; the rows, markings and classification
 * recorded; and the type-level dependencies, of which the kernel may record more (it checks types while planning, also
 * for inputs that turn out empty).
 */
function shadowMismatch(expected: Recorded, actual: Recorded): string | undefined {
  if (canonical(expected.result) !== canonical(actual.result)) return 'result';
  const rows = (recorded: Recorded) => recorded.requirements.flatMap(item => item.row ? [item.row.type + '/' + item.row.id] : []).sort();
  if (canonical(rows(expected)) !== canonical(rows(actual))) return 'row dependencies';
  if (canonical(expected.markings) !== canonical(actual.markings)) return 'read markings';
  if (canonical(expected.classification) !== canonical(actual.classification)) return 'classification';
  const typeLevel = (recorded: Recorded) => new Set(recorded.requirements.filter(item => !item.row && item.permission !== 'view_property').map(item => canonical(item)));
  const recorded = typeLevel(actual);
  if ([...typeLevel(expected)].some(item => !recorded.has(item))) return 'type-level dependencies';
  return undefined;
}
function reportShadow(mismatch: string, input: unknown) {
  const message = `Query kernel shadow mismatch (${mismatch}): ${JSON.stringify(input).slice(0, 2000)}`;
  if (process.env.EIGOS_KERNEL_SHADOW_STRICT === 'true') throw new Error(message);
  console.warn(message);
}
/**
 * How the shadow comparisons of this process went:
 * - compared;
 * - declined, when the kernel left the evaluation to the reference;
 * - skipped, when the owner committed during the comparison;
 * - stale, when the kernel differed until it loaded the projection again, because it missed writes outside the commit
 *   log;
 * - aborted, when a comparison that ran after its request failed, for example because the data was gone;
 * - unavailable, when the runtime could not obtain a kernel for this projection.
 * With EIGOS_KERNEL_SHADOW_REPORT=true, printed once when the process exits.
 */
export type KernelOperation = 'query' | 'follow' | 'evaluate' | 'aggregate';
const emptyShadowCounts = () => ({ compared: 0, declined: 0, skipped: 0, stale: 0, aborted: 0, unavailable: 0 });
const shadowCounts = emptyShadowCounts();
const shadowOperations = new Map<KernelOperation, ReturnType<typeof emptyShadowCounts>>();
let shadowReport = false;
function countShadow(outcome: keyof typeof shadowCounts, operation: KernelOperation) {
  shadowCounts[outcome]++;
  const counts = shadowOperations.get(operation) ?? emptyShadowCounts();
  counts[outcome]++;
  shadowOperations.set(operation, counts);
  if (!shadowReport && process.env.EIGOS_KERNEL_SHADOW_REPORT === 'true') {
    shadowReport = true;
    process.once('exit', () => {
      console.error(JSON.stringify({ event: 'kernel_shadow', ...shadowCounts }));
      for (const [operation, outcomes] of shadowOperations)
        console.error(JSON.stringify({ event: 'kernel_shadow_operation', operation, ...outcomes }));
    });
  }
}

/** The owner's latest commit and, in a Scenario, its revision: a comparison that sees either change is skipped. */
async function versionStamp(db: Database, model: PublishedOntology, owner: string) {
  const commit = await latestCommit(db, owner, db.pool);
  if (!model.scenario) return String(commit);
  const row = (await db.query<{ revision: string }>(`SELECT revision FROM ${db.schema}.scenarios WHERE id=$1 AND owner=$2`, [model.scenario, owner])).rows[0];
  return `${commit}:${row?.revision ?? ''}`;
}

/**
 * Compares the kernel's answer with the reference's, each on a fork of the principal's access, outside every database
 * profile. With EIGOS_KERNEL_SHADOW_STRICT=true the comparison finishes before the request answers, so a mismatch
 * fails it; otherwise it runs after the request answers, adding no latency.
 */
export async function compareWithKernel(db: Database, registry: KernelSource, access: Access, model: PublishedOntology, operation: KernelOperation, input: unknown,
  reference: (fork: Access) => Promise<unknown>, kernel: (client: KernelClient, fork: Access) => Promise<unknown | undefined>) {
  const compare = async () => {
    const client = await registry.kernelFor(db, model, true);
    if (!client) return countShadow('unavailable', operation);
    const before = await versionStamp(db, model, access.principal.owner);
    const expected = await isolated(access, reference);
    const viaKernel = () => isolated(access, fork => kernel(client, fork));
    let actual = await viaKernel();
    if (actual.result === undefined) return countShadow('declined', operation);
    if (await versionStamp(db, model, access.principal.owner) !== before) return countShadow('skipped', operation);
    let mismatch = shadowMismatch(expected, actual);
    if (mismatch && registry.reload) {
      // Writes outside the commit log are invisible to the kernel until it loads the projection again.
      await registry.reload(db, model);
      actual = await viaKernel();
      if (actual.result !== undefined && !shadowMismatch(expected, actual)) return countShadow('stale', operation);
      mismatch = actual.result === undefined ? undefined : shadowMismatch(expected, actual);
    }
    countShadow('compared', operation);
    if (mismatch) reportShadow(mismatch, input);
  };
  if (process.env.EIGOS_KERNEL_SHADOW_STRICT === 'true') {
    const counted = db.queries;
    try { await unprofiled(compare); } finally { db.queries = counted; }
    return;
  }
  void unprofiled(compare).catch(() => countShadow('aborted', operation));
}

/**
 * The kernel's answer, or undefined when the kernel failed, so that the reference answers. A routed query never fails
 * because of the kernel: a lost kernel is set aside until its registry opens it again.
 */
export async function kernelAnswer<T>(db: Database, registry: KernelSource, model: PublishedOntology, answer: () => Promise<T | undefined>): Promise<T | undefined> {
  try { return await answer(); } catch (error) {
    if (!(error instanceof KernelFailed)) throw error;
    console.warn(`Query kernel failed, so the reference answers: ${error.message}`);
    if (error.lost) registry.lost?.(db, model);
    return undefined;
  }
}
