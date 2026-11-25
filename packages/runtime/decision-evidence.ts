import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import { classificationSchema, type Classification } from '../ontology/classification.js';
import { objectRefSchema, type ObjectRef } from '../ontology/schema.js';
import type { Access } from './access.js';
import type { Database, Sql } from './database.js';
import type { PublishedOntology } from './metadata.js';
import type { Objects } from './objects.js';

const readSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('object'), ref: objectRefSchema }),
  z.strictObject({ kind: z.literal('stored'), ref: objectRefSchema }),
  z.strictObject({ kind: z.literal('follow'), ref: objectRefSchema, link: z.string(), as: z.string(), maximum: z.number().int().min(1).max(1000).optional() }),
  z.strictObject({ kind: z.literal('query'), input: z.record(z.string(), z.unknown()) }),
  z.strictObject({ kind: z.literal('source'), ref: objectRefSchema, source: z.string() }),
  z.strictObject({ kind: z.literal('set'), input: z.record(z.string(), z.unknown()), maximum: z.number().int().min(1).max(10000) }),
  z.strictObject({ kind: z.literal('aggregate'), input: z.record(z.string(), z.unknown()), maximum: z.number().int().min(1).max(10000) }),
  z.strictObject({ kind: z.literal('pa'), requestId: z.uuid() }),
]);
export type DecisionRead = z.infer<typeof readSchema>;
const observationSchema = z.strictObject({
  read: readSchema,
  view: z.enum(['live', 'scenario']),
  step: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  clearance: classificationSchema.optional(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  refs: z.array(z.strictObject({ ref: objectRefSchema, revision: z.number().int().nonnegative() })).max(10000),
  savedSets: z.array(z.uuid()).optional(),
});
const maximumObservations = 3000;
const maximumBytes = 2_000_000;
export const decisionEvidenceSchema = z.array(observationSchema).min(1).max(maximumObservations);
export type DecisionObservation = z.infer<typeof observationSchema>;
export type DecisionRef = { ref: ObjectRef; revision: number };

interface EvidenceScope {
  db: Database;
  owner: string;
  release: string;
  scenarioId: string;
  clearance?: Classification;
  step: number;
  taskId?: string;
  token?: string;
  reads: DecisionObservation[];
  saved: number;
}
const capture = new AsyncLocalStorage<EvidenceScope | undefined>();
/** Whether reads are being recorded as decision evidence, which a retried transaction would record twice. */
export function capturingDecisionReads() { return capture.getStore() !== undefined; }
const inputVersions = new AsyncLocalStorage<{ versions: Set<string>; savedSets: Set<string> }>();

/** A semantic operation can depend on a versioned input beyond its returned page. */
export function observeReadInput(identity: unknown, savedSet?: string) {
  const inputs = inputVersions.getStore();
  if (!inputs) return;
  inputs.versions.add(digest(identity));
  if (savedSet) inputs.savedSets.add(savedSet);
}
type EvidenceView = { db: Database; model: PublishedOntology; access: Access; change?: Objects['change'] };

export async function observeDecisionRead<T>(
  graph: EvidenceView, read: DecisionRead, execute: () => Promise<T>,
  describe: (result: T) => { value: unknown; refs?: DecisionRef[] } = value => ({ value }),
): Promise<T> {
  const scope = capture.getStore();
  if (!scope || scope.db !== graph.db) return execute();
  if (graph.access.principal.owner !== scope.owner || graph.model.release !== scope.release ||
      graph.model.scenario && graph.model.scenario !== scope.scenarioId)
    throw new Conflict('Workflow evidence must use its own publication and Scenario');
  const position = {
    read: structuredClone(read), view: graph.model.scenario ? 'scenario' as const : 'live' as const,
    step: scope.step, offset: graph.change?.scenarioEdits?.length ?? 0, clearance: scope.clearance,
  };
  const inputs = { versions: new Set<string>(), savedSets: new Set<string>() };
  let result: T;
  try {
    // Nested reads are covered by re-running this operation with the same inputs and permissions.
    result = await capture.run(undefined, () => inputVersions.run(inputs, execute));
  } catch (error) {
    if (error instanceof NotFound) scope.reads.push({ ...position, fingerprint: digest({ missing: true }), refs: [] });
    throw error;
  }
  const { value, refs = [] } = describe(result);
  scope.reads.push({
    ...position, refs,
    fingerprint: digest({ value, ...(inputs.versions.size ? { versions: [...inputs.versions].sort() } : {}) }),
    ...(inputs.savedSets.size ? { savedSets: [...inputs.savedSets].sort() } : {}),
  });
  return result;
}

export const observedObjects = <T extends DecisionRef[]>(items: T) => ({ value: items, refs: items.map(({ ref, revision }) => ({ ref, revision })) });
export const observedPage = <T extends { items: DecisionRef[] }>(page: T) => ({ value: page, refs: observedObjects(page.items).refs });
export const observedObject = <T extends DecisionRef>(value: T) => ({ value, refs: [{ ref: value.ref, revision: value.revision }] });

export async function proposalStep(db: Database, owner: string, scenarioId: string, client?: Sql) {
  const { rows } = await db.query<{ journal_steps: number }>(
    `SELECT journal_steps FROM ${db.schema}.scenarios WHERE id=$1 AND owner=$2 AND state='open'`,
    [scenarioId, owner], client);
  if (!rows[0]) throw new Conflict('Workflow evidence Scenario is unavailable');
  return rows[0].journal_steps;
}

export async function captureProposalReads<T>(
  db: Database, task: { id: string; owner: string; release: string; token: string | null }, scenarioId: string,
  clearance: Classification | undefined, execute: () => Promise<T>,
) {
  if (!task.token) throw new Conflict('Workflow evidence requires the current task lease');
  const step = await proposalStep(db, task.owner, scenarioId);
  const scope: EvidenceScope = {
    db, owner: task.owner, release: task.release, scenarioId, taskId: task.id, token: task.token,
    clearance, step, reads: [], saved: 0,
  };
  const result = await capture.run(scope, execute);
  await appendEvidence(scope);
  return result;
}

async function appendEvidence(scope: EvidenceScope, client?: Sql) {
  const reads = scope.reads.slice(scope.saved);
  if (!reads.length) return;
  const encoded = JSON.stringify(reads);
  const result = await scope.db.query(
    `UPDATE ${scope.db.schema}.tasks SET cognitive_evidence=cognitive_evidence || $4::jsonb
      WHERE owner=$1 AND id=$2 AND token=$3 AND state='working' AND lease_until>now()
      AND cognitive_evidence IS NOT NULL
      AND jsonb_array_length(cognitive_evidence) + $5 <= $6
      AND octet_length(cognitive_evidence::text) + $7 <= $8`,
    [scope.owner, scope.taskId, scope.token, encoded, reads.length, maximumObservations, Buffer.byteLength(encoded), maximumBytes], client);
  if (!result.rowCount) throw new Conflict('Workflow evidence exceeds its budget or the task lease ended');
  scope.saved = scope.reads.length;
}

/** Called after recording the Action journal, inside the very same edit transaction. */
export async function persistActionEvidence(graph: Objects) {
  const scope = capture.getStore();
  if (!scope || scope.db !== graph.db) return;
  if (scope.taskId !== graph.change?.taskId || scope.scenarioId !== graph.model.scenario ||
      await proposalStep(graph.db, scope.owner, scope.scenarioId, graph.client) !== scope.step + 1) throw new Conflict('Workflow proposal changed while recording Action evidence');
  await appendEvidence(scope, graph.client);
}

/** Later model observations must see the committed prefix, including after a receipt retry. */
export async function advanceDecisionReadStep() {
  const scope = capture.getStore();
  if (scope?.taskId) scope.step = await proposalStep(scope.db, scope.owner, scope.scenarioId);
}

export function observePAResponse(db: Database, task: { id: string; owner: string }, requestId: string, responseDigest: string) {
  const scope = capture.getStore();
  if (scope?.db !== db || scope.taskId !== task.id || scope.owner !== task.owner) return;
  scope.reads.push({
    read: { kind: 'pa', requestId }, fingerprint: responseDigest, refs: [],
    view: 'live', step: scope.step, offset: 0,
  });
}

/** Re-use the permission-aware read implementation without re-running the computing Function. */
export async function replayRead(
  graph: Objects, scope: Pick<EvidenceScope, 'scenarioId'>, observation: DecisionObservation, execute: () => Promise<unknown>,
) {
  const replay: EvidenceScope = {
    db: graph.db, owner: graph.owner, release: graph.model.release, scenarioId: scope.scenarioId,
    step: observation.step, clearance: observation.clearance, reads: [], saved: 0,
  };
  try {
    await capture.run(replay, () => graph.access.measureEgress(execute, observation.clearance));
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new Conflict('Workflow decision evidence changed; start a new proposal', { cause: error });
    if (!(error instanceof NotFound)) throw error;
  }
  const actual = replay.reads[0];
  if (replay.reads.length !== 1 || actual?.fingerprint !== observation.fingerprint)
    throw new Conflict('Workflow decision evidence changed; start a new proposal');
}
