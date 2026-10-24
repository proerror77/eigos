import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import type { JobStore } from '../core/store.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import { NetworkError, type Publication } from '../network/contracts.js';
import type { Inquiry } from '../network/inquiry-contracts.js';
import { NetworkStore, type Records } from '../network/store.js';
import { NetworkDirectory } from '../network/directory.js';
import { NetworkCollaboration } from '../network/collaboration.js';
import { admittedDirectoryMember, validateTaskNetworkReadAdmission } from '../network/read-admission.js';
import { baseNetworkPublication, readNetworkPublication } from '../network/read-policy.js';
import { networkCandidatePolicy } from '../network/candidate-policy.js';
import { validateInquirySource } from '../network/inquiry-source.js';
import type { NetworkQueryResult } from '../network/service.js';
import { objectQuerySchema, type ObjectQuery, type ObjectView, type ReadBudget, type LinkWrite } from './object-store.js';
import { objectRefSchema, type ObjectRef } from './model.js';
import { isVirtualRef, networkLinkIds, networkTypeIds } from './network-model.js';

export { isVirtualRef, networkTypeIds } from './network-model.js';
export type NetworkOntologyQueryResult = ReturnType<JobStore['ontology']['query']>;
/** A transport-neutral read adapter. Canonical ServiceRequest reads/digests stay
 * in the owned object store; only the declared virtual navigation is handled. */
export interface NetworkOntologyReadAdapter {
  readonly owner: string; readonly taskId?: string;
  readonly ontologyRelease?: import('./definition-contracts.js').OntologyReleaseRef;
  canHandle(input: ObjectQuery): boolean;
  read(ref: ObjectRef, budget?: ReadBudget): ObjectView;
  query(input: ObjectQuery, budget?: ReadBudget): NetworkOntologyQueryResult;
  related(ref: ObjectRef, link: string, budget?: ReadBudget): ObjectView[] | undefined;
  relationshipDigest(ref: ObjectRef, budget?: ReadBudget): string;
  requestMembership(ref: ObjectRef, request: { id: string; revision: number }): 'current' | 'foreign' | 'shared';
  contextDigest(): string;
}
export interface NetworkReadIdentity {
  memberId: string; installationId: string; identityDigest: string; expiresAt?: string;
  publication(pub: Publication): NetworkQueryResult | undefined;
}
interface Snapshot {
  identity: NetworkReadIdentity; objects: Map<string, ObjectView>; links: LinkWrite[]; requests: Map<string, Set<string>>; context: string;
}
interface SnapshotScope {
  types: ReadonlySet<string>; anchor?: ObjectRef; exact?: boolean; links?: ReadonlySet<string>;
}
const key = (ref: ObjectRef) => JSON.stringify([ref.type, ref.id]);
const same = (a: ObjectRef, b: ObjectRef) => a.type === b.type && a.id === b.id;
const revision = (value: unknown) => parseInt(digest(value).slice(0, 12), 16) + 1;
const notFound = (): never => { throw new DomainError('NOT_FOUND', 'Ontology object not found'); };
const invalid = (message: string): never => { throw new DomainError('INVALID_INPUT', message); };
const cursorSchema = z.object({ context: z.string(), query: z.string(), last: objectRefSchema, expires: z.number().finite() }).strict();
function charge(budget: ReadBudget, count = 1) {
  budget.remaining -= count;
  if (budget.remaining < 0) throw new DomainError('CONFLICT', 'Ontology read work budget exhausted; narrow the query');
}
function normalizeError(error: unknown): never {
  if (error instanceof NetworkError) throw new DomainError(error.status === 404 ? 'NOT_FOUND' : error.status === 403 ? 'FORBIDDEN' : 'CONFLICT', error.status === 404 ? 'Ontology object not found' : error.code);
  if (error instanceof Error && 'code' in error && ['agent_registration_required', 'agent_registration_revoked', 'registration_expired', 'fresh_authorization_required', 'registration_credential_invalid'].includes(String(error.code)))
    throw new DomainError('FORBIDDEN', 'Current network installation authorization is required');
  throw error;
}

/** Constructed by a trusted authenticated boundary. authorize is invoked for
 * every operation, including snapshots, related reads and cursor continuation. */
export function createNetworkOntologyReader(options: {
  jobs: JobStore; store: NetworkStore; owner: string; taskId?: string;
  authorize: () => NetworkReadIdentity; catalog?: ExecutionCatalog;
}): NetworkOntologyReadAdapter {
  const { jobs, store, owner, taskId } = options, graph = taskId ? jobs.ontologyForJob(owner, taskId) : jobs.ontology;
  const cursorKey = () => createHash('sha256').update('eigos.network.ontology.cursor@1\0').update(store.activityKey()).digest();
  const guarded = <T>(fn: () => T): T => { try { return store.readSnapshot(fn); } catch (error) { return normalizeError(error); } };
  function snapshot(scope: SnapshotScope, budget: ReadBudget = { remaining: 1000 }): Snapshot {
    const identity = options.authorize();
    if (taskId) jobs.get(owner, taskId);
    const selections = store.list('selection', owner), records = new Map<string, unknown>();
    const record = <K extends keyof Records>(kind: K, id: string, recordOwner?: string): Records[K] => {
      const cacheKey = JSON.stringify([kind, id, recordOwner]);
      if (!records.has(cacheKey)) { charge(budget); records.set(cacheKey, store.get(kind, id, recordOwner)); }
      return records.get(cacheKey) as Records[K];
    };
    const publicationRefs = (inquiry: Inquiry) => [
      [inquiry.provenance.postPublicationId, 'NetworkInquiryOriginalPublication', inquiry.provenance.postPublicationRevision],
      [inquiry.provenance.listingPublicationId, 'NetworkInquiryListingPublication', inquiry.provenance.listingPublicationRevision],
      [inquiry.provenance.messagePublicationId, 'NetworkInquiryMessagePublication', inquiry.provenance.messagePublicationRevision],
    ] as const;
    const publicationRecords = new Map<string, Publication | undefined>();
    const published = (id: string): Publication | undefined => {
      if (!publicationRecords.has(id)) {
        try { publicationRecords.set(id, record('publication', id)); }
        catch (error) { if (!(error instanceof NetworkError && error.status === 404)) throw error; publicationRecords.set(id, undefined); }
      }
      return publicationRecords.get(id);
    };
    const anchor = scope.anchor;
    let inquiries = store.list('inquiry', owner).filter(inquiry => !taskId || inquiry.taskId === taskId);
    // Resolve the anchor against the bounded owned inquiry index before loading
    // its graph. A single-object or relationship read never expands other tasks.
    if (anchor) {
      if (anchor.type === 'ServiceRequest') inquiries = inquiries.filter(inquiry => inquiry.taskId === anchor.id);
      else if (anchor.type === 'NetworkInquiry') inquiries = inquiries.filter(inquiry => inquiry.id === anchor.id);
      else if (anchor.type === 'NetworkNeed') inquiries = inquiries.filter(inquiry => inquiry.postId === anchor.id);
      else if (anchor.type === 'NetworkSelection') inquiries = inquiries.filter(inquiry => selections.some(selection => selection.id === anchor.id && selection.inquiryId === inquiry.id && selection.taskId === inquiry.taskId));
      else if (['NetworkPublication', 'NetworkVisibility'].includes(anchor.type)) inquiries = inquiries.filter(inquiry => publicationRefs(inquiry).some(([id]) => id === anchor.id));
      else if (['NetworkListing', 'NetworkRepresentation'].includes(anchor.type)) inquiries = inquiries.filter(inquiry => inquiry.source.listingId === anchor.id);
      else if (anchor.type === 'NetworkProfile') inquiries = inquiries.filter(inquiry => inquiry.profileId === anchor.id || publicationRefs(inquiry).some(([id]) => id && published(id)?.profileId === anchor.id));
      else {
        const roots = graph.related(owner, anchor, 'request', budget);
        inquiries = inquiries.filter(inquiry => roots?.some(root => root.ref.type === 'ServiceRequest' && root.ref.id === inquiry.taskId));
      }
    }
    const objects = new Map<string, ObjectView>(), links: LinkWrite[] = [], requests = new Map<string, Set<string>>();
    const wants = (type: string) => scope.types.has(type);
    const retains = (ref: ObjectRef) => wants(ref.type) && (!scope.exact || !anchor || same(ref, anchor));
    const add = (ref: ObjectRef, properties: Record<string, unknown>, inquiry: Inquiry) => {
      if (!retains(ref)) return ref;
      const membership = requests.get(key(ref)) ?? new Set<string>(); membership.add(inquiry.taskId); requests.set(key(ref), membership);
      const prior = objects.get(key(ref));
      if (prior) {
        if (digest(prior.properties) !== digest(properties)) throw new DomainError('CONFLICT', 'Network projection changed during reading');
        return ref;
      }
      charge(budget);
      const parsed = graph.model.parseProperties(ref.type, properties);
      const object: ObjectView = { ref, properties: parsed, revision: revision(parsed), createdAt: inquiry.createdAt,
        source: { kind: 'task', id: inquiry.id, observedAt: inquiry.createdAt } };
      // Source time identifies this owned inquiry observation, not publication
      // creation or provider evidence. All source content remains in NetworkStore.
      objects.set(key(ref), object);
      return ref;
    };
    const addCanonical = (ref: ObjectRef, inquiry: Inquiry) => {
      if (!retains(ref)) return ref;
      if (!objects.has(key(ref))) objects.set(key(ref), graph.read(owner, ref, budget));
      const membership = requests.get(key(ref)) ?? new Set<string>(); membership.add(inquiry.taskId); requests.set(key(ref), membership);
      return ref;
    };
    const edge = (type: string, from: ObjectRef, to: ObjectRef) => {
      if (scope.links?.has(type) && (!anchor || same(from, anchor) || same(to, anchor))
        && !links.some(link => link.type === type && same(link.from, from) && same(link.to, to))) links.push({ type, from, to });
    };
    const profile = (profileId: string, inquiry: Inquiry) => {
      const ref = { type: 'NetworkProfile', id: profileId }; if (!retains(ref)) return ref;
      const value = record('profile', profileId), own = value.owner === owner;
      return add(ref, { id: profileId, displayTitle: own ? value.displayName : '已发布的代表身份',
        ...(own ? { displayName: value.displayName, memberId: value.memberId } : {}), identityBasis: own ? 'owned_profile' : 'publication_reference' }, inquiry);
    };
    const visibility = new Map<string, NetworkQueryResult | undefined>();
    const publication = (publicationId: string, inquiry: Inquiry, expectedRevision?: number): ObjectRef | undefined => {
      if (anchor && (['NetworkPublication', 'NetworkVisibility'].includes(anchor.type) && publicationId !== anchor.id
        || ['NetworkListing', 'NetworkRepresentation'].includes(anchor.type) && publicationId !== inquiry.provenance.listingPublicationId
        || anchor.type === 'NetworkNeed' && publicationId !== inquiry.provenance.postPublicationId)) return;
      const pub = published(publicationId); if (!pub) return;
      if (anchor?.type === 'NetworkProfile' && pub.profileId !== anchor.id) return;
      if (!visibility.has(pub.id)) visibility.set(pub.id, identity.publication(pub));
      const visible = visibility.get(pub.id);
      if (!visible || pub.content.kind === 'evidence_card' || expectedRevision !== undefined && pub.revision !== expectedRevision) return;
      const ref = add({ type: 'NetworkPublication', id: pub.id }, { id: pub.id,
        displayTitle: 'title' in pub.content.body ? String(pub.content.body.title) : pub.content.kind === 'profile' ? pub.content.body.displayName : '已批准的询价回复',
        kind: pub.content.kind, revision: pub.revision, content: pub.content, visibleUntil: pub.visibleUntil }, inquiry);
      const publisher = profile(pub.profileId, inquiry); edge('NetworkPublicationProfile', ref, publisher);
      if (wants('NetworkVisibility')) {
        // The admitted public view already carries the readable circle. Only
        // its owner needs the private grant to inspect the exact audience.
        const space = record('space', visible.spaceId!), grant = pub.owner === owner ? record('grant', pub.grantId, owner) : undefined;
        const audience = add({ type: 'NetworkVisibility', id: pub.id }, { id: pub.id, displayTitle: '本次发布的批准范围', spaceId: space.id, spaceName: space.name,
          audienceKind: 'explicit_recipients', viewerIncluded: true, ...(grant ? { recipientMemberIds: [...grant.recipientMemberIds] } : {}),
          visibleUntil: pub.visibleUntil, executionAuthority: false }, inquiry);
        edge('NetworkPublicationVisibility', ref, audience);
      }
      if (pub.content.kind === 'listing' && (wants('NetworkListing') || wants('NetworkRepresentation'))) {
        const listing = record('listing', pub.content.listingId);
        const policy = networkCandidatePolicy(pub.content.body.capabilityRef);
        let sourceAdmission: 'admitted' | 'unavailable' | 'unverified' = 'unverified';
        if (wants('NetworkListing') && options.catalog) {
          try { validateInquirySource(store, options.catalog, owner, inquiry.source); sourceAdmission = 'admitted'; }
          catch { sourceAdmission = 'unavailable'; }
        }
        const listingRef = add({ type: 'NetworkListing', id: listing.id }, { id: listing.id, displayTitle: pub.content.body.title, revision: pub.content.listingRevision,
          providerId: pub.content.body.providerId, role: pub.content.body.role, capabilityRef: pub.content.body.capabilityRef,
          description: pub.content.body.description, coarseAreas: pub.content.body.coarseAreas,
          ...(policy ? { candidateType: policy.candidateType } : {}), readPolicyStatus: policy?.status ?? 'unavailable',
          readPolicyReason: policy?.reason ?? 'No exact quote-only candidate policy is registered for this capability version.', sourceAdmission }, inquiry);
        edge('NetworkPublicationListing', ref, listingRef);
        // This identity is scoped to the approved publication; the private raw
        // representation ID, proofRef, reviewer and note never leave the store.
        const representation = add({ type: 'NetworkRepresentation', id: listing.id }, { id: listing.id, displayTitle: '已核验的服务代表关系', providerId: pub.content.body.providerId,
          role: pub.content.body.role, state: 'verified', capabilityRef: pub.content.body.capabilityRef }, inquiry);
        edge('NetworkListingRepresentation', listingRef, representation); edge('NetworkRepresentationProfile', representation, publisher);
      }
      if (pub.content.kind === 'need') {
        const needRef = { type: 'NetworkNeed', id: pub.needId ?? pub.id };
        if (inquiry.postId === needRef.id) edge('NetworkPublicationNeed', ref, needRef);
      }
      return ref;
    };
    for (const inquiry of inquiries) {
      charge(budget);
      const request = addCanonical({ type: 'ServiceRequest', id: inquiry.taskId }, inquiry);
      const ref = add({ type: 'NetworkInquiry', id: inquiry.id }, { id: inquiry.id, displayTitle: '原始网络询价', taskId: inquiry.taskId, postId: inquiry.postId,
        originalPostPublicationId: inquiry.provenance.postPublicationId, originalPostContentRevision: inquiry.provenance.postContentRevision,
        originalListingPublicationId: inquiry.provenance.listingPublicationId,
        ...(inquiry.provenance.messagePublicationId ? { originalMessagePublicationId: inquiry.provenance.messagePublicationId } : {}),
        selectedAtRequestRevision: inquiry.selectedAtRequestRevision, createdAt: inquiry.createdAt, mode: 'quote_only', businessExecution: 'not_started',
        readAdmission: inquiry.readAdmission ? 'task_bound' : 'legacy_unavailable' }, inquiry);
      edge('NetworkInquiryRequest', ref, request); edge('NetworkInquiryPublisher', ref, profile(inquiry.profileId, inquiry));
      if (wants('NetworkNeed')) {
        const need = record('need', inquiry.postId, owner);
        const needRef = add({ type: 'NetworkNeed', id: need.id }, { id: need.id, displayTitle: '原始需求帖记录', revision: need.revision, contentRevision: need.contentRevision, state: need.state }, inquiry);
        edge('NetworkInquiryNeed', ref, needRef);
      }
      if (['NetworkPublication', 'NetworkProfile', 'NetworkVisibility', 'NetworkListing', 'NetworkRepresentation'].some(wants)) {
        for (const [id, relation, expected] of publicationRefs(inquiry)) if (id) {
          if (anchor?.type === 'NetworkInquiry' && scope.links?.size && !scope.links.has(relation)) continue;
          const target = publication(id, inquiry, expected); if (target) edge(relation, ref, target);
        }
      }
      // Typed candidate navigation is modelling, not a new executable binding.
      // Only an existing exact admitted read policy can supply inquiry candidates.
      const policy = networkCandidatePolicy(inquiry.source.capabilityRef);
      if (policy?.status === 'registered' && wants(policy.candidateType)) {
        const candidates = graph.related(owner, request, 'offers', budget);
        if (!candidates) throw new DomainError('CONFLICT', 'Inquiry candidates exceed the bounded read contract');
        for (const candidate of candidates.filter(value => value.ref.type === policy.candidateType)) {
          addCanonical(candidate.ref, inquiry); edge(`NetworkInquiry${policy.candidateType}`, ref, candidate.ref);
        }
      }
      for (const selection of selections.filter(value => value.inquiryId === inquiry.id && value.taskId === inquiry.taskId
        && (wants('NetworkSelection') || wants(value.quoteRef.type)) && (anchor?.type !== 'NetworkSelection' || value.id === anchor.id))) {
        charge(budget);
        const selected = add({ type: 'NetworkSelection', id: selection.id }, { id: selection.id, displayTitle: '原始候选选择', taskId: selection.taskId,
          candidateType: selection.quoteRef.type, candidateRevision: selection.quoteRevision, requestRevision: selection.requestRevision, kind: selection.kind,
          snapshotDigest: selection.snapshotDigest, snapshot: selection.snapshot, createdAt: selection.createdAt, execution: 'not_started' }, inquiry);
        edge('NetworkSelectionInquiry', selected, ref); edge('NetworkSelectionRequest', selected, request);
        if (wants(selection.quoteRef.type)) try {
          const candidate = graph.read(owner, selection.quoteRef, budget), roots = graph.related(owner, candidate.ref, 'request', budget);
          if (roots?.length === 1 && roots[0]!.ref.id === inquiry.taskId) { addCanonical(candidate.ref, inquiry); edge(`NetworkSelection${candidate.ref.type}`, selected, candidate.ref); }
        } catch (error) { if (!(error instanceof DomainError && error.code === 'NOT_FOUND')) throw error; }
      }
    }
    // No global event sequence, hidden scan counts or private source identifiers
    // enter the public revision. Unrelated hidden activity cannot affect a cursor.
    const context = digest({ owner, identity: identity.identityDigest, taskId, model: graph.model.ref,
      objects: [...objects.values()].sort((a, b) => key(a.ref).localeCompare(key(b.ref))).map(value => ({ ref: value.ref, revision: value.revision, properties: value.properties })),
      links: links.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
    return { identity, objects, links, requests, context };
  }
  function encodeCursor(context: string, query: string, last: ObjectRef, identity: NetworkReadIdentity): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', cursorKey(), iv);
    const expires = Math.min(store.now() + 900000, identity.expiresAt ? Date.parse(identity.expiresAt) : Infinity);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ context, query, last, expires })), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }
  function decodeCursor(value: string, context: string, query: string): ObjectRef {
    try {
      const raw = Buffer.from(value, 'base64url'); if (raw.length < 29 || raw.toString('base64url') !== value) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', cursorKey(), raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28));
      const parsed = cursorSchema.parse(JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString()));
      if (parsed.context !== context || parsed.query !== query || parsed.expires <= store.now()) throw new Error();
      return parsed.last;
    } catch { throw new DomainError('CONFLICT', 'Query context changed; restart the bounded query'); }
  }
  function canHandle(input: ObjectQuery) {
    if ('type' in input) return isVirtualRef({ type: input.type });
    if ('object' in input) return isVirtualRef(input.object);
    if (isVirtualRef(input.from)) return true;
    try { return networkLinkIds.has(graph.model.navigation(input.from.type, input.link).link.id); } catch { return false; }
  }
  function queryScope(input: ObjectQuery): SnapshotScope {
    if ('type' in input) return { types: new Set([input.type]) };
    if ('object' in input) return { types: new Set([input.object.type]), anchor: input.object, exact: true };
    const navigation = graph.model.navigation(input.from.type, input.link);
    return { types: new Set([input.from.type, navigation.other.type]), anchor: input.from, links: new Set([navigation.link.id]) };
  }
  function query(input: ObjectQuery, budget: ReadBudget = { remaining: 1000 }): NetworkOntologyQueryResult {
    return guarded(() => {
      const args = objectQuerySchema.parse(input); if (!canHandle(args)) return invalid('Query is not a network ontology relationship');
      const current = snapshot(queryScope(args), budget); let target: string, values: ObjectView[];
      if ('type' in args) { target = args.type; values = [...current.objects.values()].filter(value => graph.model.implements(value.ref.type, target)); }
      else if ('object' in args) { target = args.object.type; const found = current.objects.get(key(args.object)); if (!found) return notFound(); values = [found]; }
      else {
        // An authorized owner may ask whether an ordinary owned task has a
        // network origin. Its known root remains readable and the relation is
        // empty; an unknown/foreign root still uses the canonical NOT_FOUND.
        const source = current.objects.get(key(args.from)) ?? (!taskId && !isVirtualRef(args.from) ? graph.read(owner, args.from, budget) : undefined);
        if (!source) return notFound();
        const nav = graph.model.navigation(args.from.type, args.link); target = nav.other.type;
        const refs = current.links.filter(value => value.type === nav.link.id && same(nav.direction === 'forward' ? value.from : value.to, args.from))
          .map(value => nav.direction === 'forward' ? value.to : value.from);
        values = refs.flatMap(ref => { const object = current.objects.get(key(ref)); return object ? [object] : []; });
      }
      const properties = graph.model.properties(target);
      const select = args.select ?? Object.keys(properties).filter(name => !properties[name]!.restricted && !properties[name]!.derived);
      for (const name of select) {
        if (!properties[name]) return invalid('Unknown selected property');
        if (properties[name]!.restricted) throw new DomainError('FORBIDDEN', 'Restricted property cannot be selected');
        if (properties[name]!.derived) return invalid('Read derived candidate properties through their canonical owned object');
      }
      for (const filter of args.where) {
        const property = properties[filter.property];
        if (!property || property.derived || ['array', 'struct'].includes(property.kind)) return invalid('Filter requires a registered stored scalar property');
        if (property.restricted) throw new DomainError('FORBIDDEN', 'Restricted property cannot be filtered');
        if (!['eq', 'in'].includes(filter.op) && !['integer', 'decimal', 'timestamp'].includes(property.kind)) return invalid('Unsupported comparison for this property');
        const filterValues = filter.op === 'in' ? filter.value : [filter.value];
        if (!Array.isArray(filterValues) || filterValues.some(value => !property.schema.safeParse(value).success)) return invalid('Filter value does not match property type');
      }
      const normalize = (value: unknown, kind: string): string | number | boolean | bigint => kind === 'timestamp' ? Date.parse(String(value))
        : kind === 'decimal' ? BigInt(String(value).replace('.', '').padEnd(String(value).split('.')[0]!.length + 6, '0')) : value as string | number | boolean;
      values = values.filter(value => args.where.every(filter => {
        const actual = value.properties[graph.model.propertyName(value.ref.type, target, filter.property)]; if (actual === undefined) return false;
        const kind = properties[filter.property]!.kind, left = normalize(actual, kind);
        if (filter.op === 'in') return (filter.value as unknown[]).some(item => left === normalize(item, kind));
        const right = normalize(filter.value, kind);
        return filter.op === 'eq' ? left === right : filter.op === 'lt' ? left < right : filter.op === 'lte' ? left <= right : filter.op === 'gt' ? left > right : left >= right;
      })).sort((a, b) => a.ref.type.localeCompare(b.ref.type) || a.ref.id.localeCompare(b.ref.id));
      const queryDigest = digest({ ...args, cursor: undefined });
      if (args.cursor) { const last = decodeCursor(args.cursor, current.context, queryDigest); values = values.filter(value => value.ref.type.localeCompare(last.type) > 0 || value.ref.type === last.type && value.ref.id.localeCompare(last.id) > 0); }
      const items: ObjectView[] = []; let bytes = 0;
      for (const value of values) {
        const properties = Object.fromEntries(select.flatMap(name => { const actual = graph.model.propertyName(value.ref.type, target, name); return Object.hasOwn(value.properties, actual) ? [[name, value.properties[actual]]] : []; }));
        const projected = { ...value, properties }, size = Buffer.byteLength(JSON.stringify(projected));
        if (items.length >= args.limit || bytes + size > 60000) { if (!items.length) return invalid('Object projection exceeds response limit'); break; }
        items.push(projected); bytes += size;
      }
      const hasMore = values.length > items.length;
      return { model: graph.model.ref, items: structuredClone(items), page: { limit: args.limit, scanned: items.length, hasMore,
        cursor: hasMore ? encodeCursor(current.context, queryDigest, items.at(-1)!.ref, current.identity) : undefined }, datasetRevision: revision(current.context) };
    });
  }
  return { owner, ...(taskId ? { taskId } : {}), ...(graph.releaseRef ? { ontologyRelease: graph.releaseRef } : {}), canHandle, query,
    read(ref, budget) { return guarded(() => { if (!isVirtualRef(ref)) return invalid('Canonical objects must be read through the owned object store'); const current = snapshot(queryScope({ object: ref }), budget); return structuredClone(current.objects.get(key(ref)) ?? notFound()); }); },
    related(ref, link, budget) { const result = query({ from: ref, link, limit: 50 }, budget); return result.page.hasMore ? undefined : result.items; },
    relationshipDigest(ref, budget) { return guarded(() => {
      if (!isVirtualRef(ref)) return invalid('Canonical relationship digests exclude virtual network edges');
      const outgoing = graph.model.sides(ref.type).filter(side => side.direction === 'forward' && networkLinkIds.has(side.link.id));
      const current = snapshot({ anchor: ref, types: new Set([ref.type, ...outgoing.map(side => side.other.type)]), links: new Set(outgoing.map(side => side.link.id)) }, budget);
      if (!current.objects.has(key(ref))) return notFound();
      return digest(current.links.filter(value => same(value.from, ref)).map(value => ({ type: value.type, to: value.to })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    }); },
    requestMembership(ref, request) { return guarded(() => { const current = snapshot(queryScope({ object: ref }));
      const job = jobs.get(owner, request.id); if (job.delegation?.request.revision !== request.revision) return 'foreign';
      return current.requests.get(key(ref))?.has(request.id) ? 'current' : 'foreign'; }); },
    contextDigest() { return guarded(() => snapshot({ types: networkTypeIds, links: networkLinkIds }).context); },
  };
}

export function createTaskNetworkOntologyReader(jobs: JobStore, owner: string, taskId: string, catalog?: ExecutionCatalog): NetworkOntologyReadAdapter {
  jobs.get(owner, taskId);
  const store = jobs.createNetworkReadStore();
  return createNetworkOntologyReader({ jobs, store, owner, taskId, catalog, authorize: () => {
    const checked = validateTaskNetworkReadAdmission(jobs, store, owner, taskId);
    const directory = new NetworkDirectory(store, id => admittedDirectoryMember(store, checked.members, id), [], catalog);
    const base = { store, directory };
    const collaboration = new NetworkCollaboration(store, (pub, viewer) => !!baseNetworkPublication(base, pub, viewer));
    return { memberId: checked.memberId, installationId: checked.installationId, identityDigest: checked.identityDigest, expiresAt: checked.expiresAt,
      publication: pub => readNetworkPublication({ ...base, collaboration }, pub, checked.memberId) };
  } });
}
