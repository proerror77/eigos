import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ObjectRef } from './model.js';
import { type LinkWrite, type ObjectWrite, type OntologyObjectStore, type ObjectSource, type ObjectView } from './object-store.js';

export const businessFactsEnabled = (graph: OntologyObjectStore) => graph.model.hasType('ObservedFact') && graph.model.hasType('MonetaryFact');
export const sourceEntityRef = (type: string, source: string, nativeIdentity: unknown): ObjectRef => ({ type, id: digest({ namespace: 'business-entity-v1', type, source, nativeIdentity }) });

/** Builds one atomic source projection. It never reads a different owner or
 * creates authority. An entity and a source observation have separate identity. */
export class BusinessFactProjection {
  readonly objects: ObjectWrite[] = [];
  readonly links: LinkWrite[] = [];
  readonly removeLinks: LinkWrite[] = [];
  private evidenced = new Map<string, ObjectWrite>();
  constructor(private graph: OntologyObjectStore, private owner: string, private observedAt: string, private receipt: ObjectRef, readonly readContext?: ObjectSource['readContext']) {}
  edge(type: string, from: ObjectRef, to: ObjectRef) { this.links.push({ type, from, to }); }
  replaceLink(type: string, from: ObjectRef, to: ObjectRef) {
    let previous: ObjectView[] | undefined;
    try { previous = this.graph.related(this.owner, from, this.graph.model.link(type).from.name, { remaining: 1000 }); }
    catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; previous = []; }
    if (!previous) throw new DomainError('CONFLICT', 'Relationship replacement exceeds its bound');
    for (const old of previous) if (old.ref.type !== to.type || old.ref.id !== to.id) this.removeLinks.push({ type, from, to: old.ref });
    this.edge(type, from, to);
  }
  revision(ref: ObjectRef): number {
    const pending = this.objects.find(value => value.ref.type === ref.type && value.ref.id === ref.id);
    if (!pending) throw new DomainError('INVALID_INPUT', 'The entity must be observed before its revision is pinned');
    return (pending.expectedRevision ?? 0) + (pending.reuseIfUnchanged ? 0 : 1);
  }
  entity(ref: ObjectRef, title: string, fields: Record<string, unknown>, evidenceLink?: string, observedFields?: string[]): ObjectRef {
    const key = JSON.stringify(ref), pending = this.objects.find(o => JSON.stringify(o.ref) === key);
    const definition = this.graph.model.object(ref.type);
    const properties = this.graph.model.parseProperties(ref.type, { [definition.primaryKey]: ref.id, displayTitle: title.slice(0, 500), ...fields });
    if (pending) {
      if (digest(pending.properties) !== digest(properties)) throw new DomainError('CONFLICT', 'One source response disagrees about the same entity');
      return ref;
    }
    let old;
    try { old = this.graph.readPrivate(this.owner, ref); }
    catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; }
    const receipts = old && evidenceLink ? this.graph.related(this.owner, ref, 'sourceReceipts', { remaining: 1000 }) : [];
    if (receipts === undefined) throw new DomainError('CONFLICT', 'Entity evidence exceeds its bound');
    const latest = Math.max(old ? Date.parse(old.source.observedAt) : 0, ...(receipts ?? []).map(r => Date.parse(String(r.properties.observedAt))));
    const changed = !old || digest(old.properties) !== digest(properties);
    const ordered = typeof properties.sourceVersion === 'number' && typeof old?.properties.sourceVersion === 'number';
    if (old && changed && (ordered ? Number(properties.sourceVersion) <= Number(old.properties.sourceVersion) : Date.parse(this.observedAt) <= latest)) throw new DomainError('CONFLICT', 'An older or conflicting source read cannot replace a current entity');
    const object: ObjectWrite = { ref, properties, ...(old ? { expectedRevision: old.revision, reuseIfUnchanged: !changed } : {}), ...(observedFields ? { observedFields } : {}) };
    this.objects.push(object);
    if (evidenceLink && (ordered && changed || Date.parse(this.observedAt) >= latest)) {
      for (const previous of receipts ?? []) this.removeLinks.push({ type: evidenceLink, from: ref, to: previous.ref });
      this.edge(evidenceLink, ref, this.receipt); this.evidenced.set(key, object);
    }
    return ref;
  }
  fact(ref: ObjectRef, title: string, fields: Record<string, unknown>): ObjectRef {
    try { this.graph.readPrivate(this.owner, ref); throw new DomainError('CONFLICT', 'Business observations are immutable'); }
    catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; }
    const definition = this.graph.model.object(ref.type);
    const object = { ref, properties: this.graph.model.parseProperties(ref.type, { [definition.primaryKey]: ref.id, displayTitle: title.slice(0, 500), ...fields }) };
    this.objects.push(object); this.evidenced.set(JSON.stringify(ref), object);
    this.edge(`${ref.type}Evidence`, ref, this.receipt); return ref;
  }
  subjects() {
    return [...this.evidenced.values()].map(o => ({ object: o.ref, digest: digest(o.properties), linksDigest: this.graph.projectedRelationshipDigest(this.owner, o.ref, this.links, this.removeLinks) }));
  }
}
