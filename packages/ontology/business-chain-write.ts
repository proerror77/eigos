import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ObjectRef } from './model.js';
import type { LinkWrite, ObjectSource, ObjectView, OntologyObjectStore } from './object-store.js';

export const businessRef = (type: string, identity: unknown): ObjectRef => ({ type, id: digest(identity) });
export const businessEdge = (type: string, from: ObjectRef, to: ObjectRef): LinkWrite => ({ type, from, to });
export function optionalObject(graph: OntologyObjectStore, owner: string, ref: ObjectRef): ObjectView | undefined {
  try { return graph.read(owner, ref); } catch (error) {
    if (error instanceof DomainError && error.code === 'NOT_FOUND') return;
    throw error;
  }
}
export function businessRelated(graph: OntologyObjectStore, owner: string, from: ObjectRef, link: string): ObjectView[] {
  const result: ObjectView[] = []; let cursor: string | undefined;
  do {
    const page = graph.query(owner, { from, link, limit: 50, ...(cursor ? { cursor } : {}) }, { remaining: 4000 });
    result.push(...page.items); cursor = page.page.cursor;
    if (result.length > 2000) throw new DomainError('CONFLICT', 'Business chain exceeds the bounded read limit');
  } while (cursor);
  return result;
}
/** Internal, transactional mapping only. Identical facts do not churn revisions. */
export function writeBusiness(graph: OntologyObjectStore, owner: string, ref: ObjectRef, values: Record<string, unknown>, links: LinkWrite[], source: ObjectSource, immutable = false): void {
  const previous = optionalObject(graph, owner, ref);
  const properties = { [graph.model.object(ref.type).primaryKey]: ref.id, displayTitle: ref.type, ...values };
  const unchanged = previous && digest(previous.properties) === digest(properties);
  if (immutable && previous && !unchanged) throw new DomainError('CONFLICT', `Immutable ${ref.type} facts changed`);
  if (unchanged && graph.containsLinks(owner, links)) return;
  graph.ingest(owner, { objects: unchanged ? [] : [{ ref, properties, ...(previous ? { expectedRevision: previous.revision } : {}) }], links }, source);
}
