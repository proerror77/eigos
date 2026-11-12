import { digest } from '../core/delegation.js';
import type { OntologyDocument } from './definition-contracts.js';

/**
 * A change to the ontology, expressed as data.
 *
 * Palantir does not grow an ontology by re-running the program that built it: version N+1 is
 * version N plus a set of edits, and the edits are kept. This is that shape. Nothing in this file
 * knows what an object type is for; it records what appeared, what changed and what was withdrawn,
 * and applies it to a document.
 *
 * A document is a tree of keyed collections plus a few scalar fields, so an edit set is the
 * difference between two documents: entries added in full, entries that changed in full, and the
 * identities withdrawn. Storing whole entries rather than field patches keeps replay honest -- what
 * is replayed is what was published.
 */
export interface DocumentEdits {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly scalars: Readonly<Record<string, unknown>>;
  readonly collections: Readonly<Record<string, {
    readonly added: readonly Record<string, unknown>[];
    readonly changed: readonly Record<string, unknown>[];
    readonly removed: readonly string[];
    /** The order the collection was published in; digests are order sensitive. */
    readonly order: readonly string[];
  }>>;
}

export class OntologyEditError extends Error {}

const same = (left: unknown, right: unknown): boolean => (left === undefined || right === undefined ? left === right : digest(left) === digest(right));

const keyOf = (entry: Record<string, unknown>): string => String(entry.id ?? entry.apiName ?? entry.name ?? '');

const isCollection = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null;

/** The difference between two published documents, as data. */
export function deriveEdits(before: OntologyDocument, after: OntologyDocument): DocumentEdits {
  const scalars: Record<string, unknown> = {};
  const collections: Record<string, { added: Record<string, unknown>[]; changed: Record<string, unknown>[]; removed: string[]; order: string[] }> = {};

  for (const [key, value] of Object.entries(after as unknown as Record<string, unknown>)) {
    const previous = (before as unknown as Record<string, unknown>)[key];
    if (!isCollection(value) || !isCollection(previous)) {
      if (!same(value, previous)) scalars[key] = value;
      continue;
    }
    const prior = new Map(previous.map(entry => [keyOf(entry), entry]));
    const added: Record<string, unknown>[] = [];
    const changed: Record<string, unknown>[] = [];
    for (const entry of value) {
      const was = prior.get(keyOf(entry));
      if (!was) { added.push(entry); continue; }
      if (!same(was, entry)) changed.push(entry);
      prior.delete(keyOf(entry));
    }
    const removed = [...prior.keys()];
    if (added.length || changed.length || removed.length) collections[key] = { added, changed, removed, order: value.map(keyOf) };
  }
  return { fromVersion: before.version, toVersion: after.version, scalars, collections };
}

/** Apply an edit set to a document. The input is not mutated. */
export function applyEdits(before: OntologyDocument, edits: DocumentEdits): OntologyDocument {
  const document = structuredClone(before) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(edits.scalars)) document[key] = structuredClone(value);
  for (const [key, change] of Object.entries(edits.collections)) {
    const current = document[key];
    if (!isCollection(current)) throw new OntologyEditError(`The document has no collection ${key}`);
    const byKey = new Map(current.map(entry => [keyOf(entry), entry]));
    for (const identity of change.removed) {
      if (!byKey.has(identity)) throw new OntologyEditError(`Cannot withdraw ${key}/${identity}: it is not there`);
      byKey.delete(identity);
    }
    for (const entry of [...change.added, ...change.changed]) byKey.set(keyOf(entry), structuredClone(entry));
    document[key] = change.order.map(identity => {
      const entry = byKey.get(identity);
      if (!entry) throw new OntologyEditError(`The edit set names ${key}/${identity} but never supplies it`);
      return entry;
    });
  }
  return document as unknown as OntologyDocument;
}

/** Replay a sequence of edit sets, checking each step against the digest it published. */
export function replay(base: OntologyDocument, steps: readonly { edits: DocumentEdits; resultingDigest: string }[]): { document: OntologyDocument; applied: string[] } {
  let document = base;
  const applied: string[] = [];
  for (const step of steps) {
    document = applyEdits(document, step.edits);
    const actual = digest(document);
    if (actual !== step.resultingDigest) throw new OntologyEditError(`Replay diverged at v${step.edits.toVersion}: ${actual} != ${step.resultingDigest}`);
    applied.push(step.edits.toVersion);
  }
  return { document, applied };
}
