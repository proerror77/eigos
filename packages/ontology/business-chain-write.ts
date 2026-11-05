import { projectionFragmentProgram, projectionDeltaMetadata } from './projection-delta.js';
import {graphRead,graphQuery,graphIngest,graphContainsLinks,runGraphProgram,type GraphProgram,type ProjectionMetadata} from './graph-program.js';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ObjectRef } from './model.js';
import type { LinkWrite, ObjectSource, ObjectView, OntologyObjectStore } from './object-store.js';

export const businessRef = (type: string, identity: unknown): ObjectRef => ({ type, id: digest(identity) });
export const businessEdge = (type: string, from: ObjectRef, to: ObjectRef): LinkWrite => ({ type, from, to });
export function* optionalObjectProgram(graph: ProjectionMetadata, owner: string, ref: ObjectRef): GraphProgram<ObjectView | undefined> {
  try { return (yield* graphRead(owner, ref)); } catch (error) {
    if (error instanceof DomainError && error.code === 'NOT_FOUND') return;
    throw error;
  }
}
export function* businessRelatedProgram(graph: ProjectionMetadata, owner: string, from: ObjectRef, link: string): GraphProgram<ObjectView[]> {
  const result: ObjectView[] = []; let cursor: string | undefined;
  do {
    const page = (yield* graphQuery(owner, { from, link, limit: 50, ...(cursor ? { cursor } : {}) }, { remaining: 4000 }));
    result.push(...page.items); cursor = page.page.cursor;
    if (result.length > 2000) throw new DomainError('CONFLICT', 'Business chain exceeds the bounded read limit');
  } while (cursor);
  return result;
}
/** Internal, transactional mapping only. Identical facts do not churn revisions. */
export function* writeBusinessProgram(graph: ProjectionMetadata, owner: string, ref: ObjectRef, values: Record<string, unknown>, links: LinkWrite[], source: ObjectSource, immutable = false): GraphProgram<void> {
  yield* projectionFragmentProgram(graph, 'business-write:' + JSON.stringify(ref), [values, links, source.kind, source.id, immutable], function* () {
    const previous = (yield* optionalObjectProgram(graph, owner, ref));
    const properties = { [graph.model.object(ref.type).primaryKey]: ref.id, displayTitle: ref.type, ...values };
    const unchanged = previous && digest(previous.properties) === digest(properties);
    if (immutable && previous && !unchanged) throw new DomainError('CONFLICT', `Immutable ${ref.type} facts changed`);
    if (unchanged && (yield* graphContainsLinks(owner, links))) return;
    (yield* graphIngest(owner, { objects: unchanged ? [] : [{ ref, properties, ...(previous ? { expectedRevision: previous.revision } : {}) }], links }, source));
  });
}

export function optionalObject(graph: OntologyObjectStore, owner: string, ref: ObjectRef): ObjectView | undefined {
  return runGraphProgram(graph,optionalObjectProgram(graph,owner,ref));
}

export function businessRelated(graph: OntologyObjectStore, owner: string, from: ObjectRef, link: string): ObjectView[] {
  return runGraphProgram(graph,businessRelatedProgram(graph,owner,from,link));
}

export function writeBusiness(graph: OntologyObjectStore, owner: string, ref: ObjectRef, values: Record<string, unknown>, links: LinkWrite[], source: ObjectSource, immutable = false): void {
  return runGraphProgram(graph,writeBusinessProgram(projectionDeltaMetadata(graph),owner,ref,values,links,source,immutable));
}
