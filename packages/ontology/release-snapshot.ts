import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { compileOntologyDocument, type TrustedDefinitionRegistry } from './model-compiler.js';
import type { OntologyDocument } from './definition-contracts.js';

/**
 * A release is a document, not a recipe.
 *
 * The chain in seed-definition.ts rebuilds every past version by running today's TypeScript, which
 * means history is a build artifact: change a provider module and 2015's ontology changes with it.
 * Palantir versions the ontology as data and reads it back, so this is the smallest honest version
 * of that: take the document a release produced, keep it, and rebuild the release from the kept copy
 * without touching the modules at all.
 *
 * Nothing here decides which versions exist; it only makes a version reproducible from what was
 * published rather than from what the source tree looks like today.
 */
export interface ReleaseSnapshot {
  readonly id: string;
  readonly version: string;
  /** Digest of the document itself, so a snapshot can be checked before it is trusted. */
  readonly documentDigest: string;
  readonly document: OntologyDocument;
}

/** Capture what a release actually emitted. */
export function snapshotRelease(document: OntologyDocument): ReleaseSnapshot {
  const body = structuredClone(document);
  return Object.freeze({ id: body.id, version: body.version, documentDigest: digest(body), document: Object.freeze(body) });
}

export class ReleaseSnapshotError extends Error {}

/**
 * Property constraints travel with the document.
 *
 * Palantir keeps a property's type and constraints in the ontology, so a release can be read back
 * without the code that once produced it. Here each property carries its JSON Schema and a ref;
 * the schema is turned back into a validator, which is the half of the release that can be data.
 */
function registerSnapshotValidators(document: OntologyDocument, registry: TrustedDefinitionRegistry) {
  let registered = 0;
  const sources = [...(document.objects as any[]), ...(document.interfaces as any[])];
  for (const item of sources) {
    for (const property of Object.values((item.properties ?? {}) as Record<string, any>)) {
      const ref = property?.validatorRef;
      if (!ref?.id || !ref?.version || !property?.schema) continue;
      registry.registerValidator(ref.id, ref.version, z.fromJSONSchema(property.schema) as never, property.schema);
      registered++;
    }
  }
  return registered;
}

/** Rebuild a release from its snapshot alone: no seed chain, no provider modules. */
export function restoreRelease(snapshot: ReleaseSnapshot, registry: TrustedDefinitionRegistry) {
  const document = structuredClone(snapshot.document) as OntologyDocument;
  if (digest(document) !== snapshot.documentDigest) throw new ReleaseSnapshotError(`Snapshot ${snapshot.id}@${snapshot.version} does not match its recorded digest`);
  const validators = registerSnapshotValidators(document, registry);
  registry.protect(document);
  return { document, model: compileOntologyDocument(document, registry), validators };
}
