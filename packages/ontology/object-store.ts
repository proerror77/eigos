import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { businessModel, businessModelV9 } from './business-model.js';
import { migrateIntegratedOntology } from './integration-migration.js';
import { nameSchema, objectRefSchema, type ObjectRef, type OntologyModel } from './model.js';
import { deriveProperty, evaluateFunction, functionCallSchema } from './object-functions.js';
import { isVirtualRef, networkLinkIds } from './network-model.js';
import type { NetworkOntologyReadAdapter } from './network-read.js';
import { assertIdentityAssertionWrite } from './identity-mapping.js';
import { assertTransactionPartyRoleWrite } from './errand-domain.js';

const sourceSchema = z.object({ kind: z.enum(['synthetic', 'user', 'provider', 'task']), id: z.string().min(1).max(200), observedAt: z.iso.datetime({ offset: true }) }).strict();
export type ObjectSource = z.infer<typeof sourceSchema>;
const filterSchema = z.object({ property: nameSchema, op: z.enum(['eq', 'lt', 'lte', 'gt', 'gte', 'in']), value: z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.array(z.union([z.string().max(1000), z.number().finite(), z.boolean()])).min(1).max(20)]) }).strict();
const queryFields = { select: z.array(nameSchema).min(1).max(20).optional(), where: z.array(filterSchema).max(8).default([]), limit: z.number().int().min(1).max(50).default(20), cursor: z.string().max(4096).optional() };
export const objectQuerySchema = z.union([
  z.object({ type: nameSchema, ...queryFields }).strict(),
  z.object({ from: objectRefSchema, link: nameSchema, ...queryFields }).strict(),
  z.object({ object: objectRefSchema, ...queryFields }).strict(),
]).describe('Each response covers only the requested object, type, or named relationship. Empty results on one relationship do not prove that other relationships or participants are absent. Inspect pagination and state the scope actually read; unqueried information remains unverified.');
export type ObjectQuery = z.input<typeof objectQuerySchema>;
export interface ObjectWrite { ref: ObjectRef; properties: Record<string, unknown>; expectedRevision?: number }
export interface LinkWrite { type: string; from: ObjectRef; to: ObjectRef }
export function linkSnapshotDigest(ref: ObjectRef, links: LinkWrite[]): string {
  const values = links.filter(l => l.from.type === ref.type && l.from.id === ref.id && l.to.type !== 'SourceReceipt').map(l => ({ type: l.type, to: l.to }));
  return digest(values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
export interface ObjectBatch { objects: ObjectWrite[]; links?: LinkWrite[]; removeLinks?: LinkWrite[] }
interface StoredObject { ref: ObjectRef; revision: number; createdAt: string; properties: Record<string, unknown>; source: ObjectSource }
export interface ObjectView extends StoredObject { derived?: Record<string, { status: 'known' | 'unknown'; reason?: string; functionRef: { id: string; version: string }; evidenceRefs: ObjectRef[]; evidenceLevels: string[] }> }
export interface ReadBudget { remaining: number }
export interface OntologyQueryResult {
  model: OntologyModel['ref']; items: ObjectView[];
  page: { limit: number; scanned: number; hasMore: boolean; cursor?: string };
  datasetRevision: number;
}
const batchSchema = z.object({ objects: z.array(z.object({ ref: objectRefSchema, properties: z.record(z.string(), z.unknown()), expectedRevision: z.number().int().min(1).optional() }).strict()).max(200), links: z.array(z.object({ type: nameSchema, from: objectRefSchema, to: objectRefSchema }).strict()).max(500).default([]), removeLinks: z.array(z.object({ type: nameSchema, from: objectRefSchema, to: objectRefSchema }).strict()).max(100).default([]) }).strict();
const cursorSchema = z.object({ owner: z.string(), query: z.string(), model: z.string(), revision: z.number().int(), last: objectRefSchema }).strict();
const key = (ref: ObjectRef) => JSON.stringify([ref.type, ref.id]);
function failure(message: string): never { throw new DomainError('INVALID_INPUT', message); }

/** Owned business objects only. Writes are internal source mappings, never public query operations. */
export class OntologyObjectStore {
  readonly model: OntologyModel;
  private readerFactory?: (owner: string, requestId: string) => NetworkOntologyReadAdapter | undefined;
  private backingStore?: OntologyObjectStore;
  constructor(private db: DatabaseSync, model = businessModel, readonly now: () => number = Date.now, private readOverlay?: NetworkOntologyReadAdapter) {
    this.model = model;
    // A read view shares the existing owned connection, but neither initializes
    // nor migrates it, and cannot import or rewrite source facts.
    if (readOverlay) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ontology_objects (owner TEXT NOT NULL,type TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,definition_digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,type,id));
      CREATE TABLE IF NOT EXISTS ontology_links (owner TEXT NOT NULL,type TEXT NOT NULL,from_type TEXT NOT NULL,from_id TEXT NOT NULL,to_type TEXT NOT NULL,to_id TEXT NOT NULL,definition_digest TEXT NOT NULL,PRIMARY KEY(owner,type,from_type,from_id,to_type,to_id));
      CREATE INDEX IF NOT EXISTS ontology_links_reverse ON ontology_links(owner,type,to_type,to_id,from_type,from_id);
      CREATE INDEX IF NOT EXISTS ontology_links_outgoing ON ontology_links(owner,from_type,from_id,type,to_type,to_id);
      CREATE TABLE IF NOT EXISTS ontology_revisions (owner TEXT PRIMARY KEY,revision INTEGER NOT NULL);
    `);
    if (model === businessModel) migrateIntegratedOntology(this.db, businessModelV9, businessModel);
  }
  setReadOverlayFactory(factory: (owner: string, requestId: string) => NetworkOntologyReadAdapter | undefined): void {
    if (this.readOverlay) throw new DomainError('FORBIDDEN', 'A read view cannot change its authority resolver');
    this.readerFactory = factory;
  }
  withReadOverlay(overlay: NetworkOntologyReadAdapter): OntologyObjectStore {
    const view = new OntologyObjectStore(this.db, this.model, this.now, overlay);
    view.readerFactory = this.readerFactory;
    view.backingStore = this.backingStore ?? this;
    return view;
  }
  forRequestReader(owner: string, requestId: string): OntologyObjectStore {
    if (this.readOverlay) {
      this.assertReaderOwner(owner);
      if (this.readOverlay.taskId && this.readOverlay.taskId !== requestId) throw new DomainError('FORBIDDEN', 'Network read admission belongs to another task');
      return this;
    }
    const overlay = this.readerFactory?.(owner, requestId);
    return overlay ? this.withReadOverlay(overlay) : this;
  }
  virtualMembership(owner: string, request: { id: string; revision: number }, ref: ObjectRef): 'current' | 'foreign' | 'shared' | undefined {
    return isVirtualRef(ref) ? this.overlay(owner).requestMembership(ref, request) : undefined;
  }
  private assertReaderOwner(owner: string) {
    if (this.readOverlay && this.readOverlay.owner !== owner) throw new DomainError('FORBIDDEN', 'Read context belongs to another owner');
  }
  private overlay(owner: string): NetworkOntologyReadAdapter {
    this.assertReaderOwner(owner);
    if (!this.readOverlay) throw new DomainError('FORBIDDEN', 'Network objects require a current authorized read context');
    return this.readOverlay;
  }
  private charge(budget: ReadBudget, count = 1) {
    budget.remaining -= count;
    if (budget.remaining < 0) throw new DomainError('CONFLICT', 'Ontology read work budget exhausted; narrow the query');
  }
  revision(owner: string): number { return Number(this.db.prepare('SELECT revision FROM ontology_revisions WHERE owner=?').get(owner)?.revision ?? 0); }
  private raw(owner: string, ref: ObjectRef, budget: ReadBudget): StoredObject {
    objectRefSchema.parse(ref); this.model.object(ref.type); this.charge(budget);
    this.assertReaderOwner(owner);
    if (isVirtualRef(ref)) return this.overlay(owner).read(ref, budget);
    const row = this.db.prepare('SELECT * FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(owner, ref.type, ref.id);
    if (!row) throw new DomainError('NOT_FOUND', 'Ontology object not found');
    if (row.definition_digest !== this.model.fingerprint(ref.type)) throw new DomainError('CONFLICT', 'Object definition changed; historical data cannot be reinterpreted');
    return { ref, revision: Number(row.revision), ...JSON.parse(String(row.body)) };
  }
  read(owner: string, ref: ObjectRef, budget: ReadBudget = { remaining: 1000 }): ObjectView {
    return this.project(owner, this.raw(owner, ref, budget), ref.type, undefined, budget);
  }
  /** Trusted source validators only. Never expose this through a query or model tool. */
  readPrivate(owner: string, ref: ObjectRef, budget: ReadBudget = { remaining: 1000 }): ObjectView {
    if (this.readOverlay) throw new DomainError('FORBIDDEN', 'Private source facts are unavailable through a read view');
    return structuredClone(this.raw(owner, ref, budget));
  }
  relationshipDigest(owner: string, ref: ObjectRef, budget: ReadBudget): string {
    if (isVirtualRef(ref)) return this.overlay(owner).relationshipDigest(ref, budget);
    this.raw(owner, ref, budget);
    const rows = this.db.prepare("SELECT * FROM ontology_links WHERE owner=? AND from_type=? AND from_id=? AND to_type<>'SourceReceipt' ORDER BY type,to_type,to_id LIMIT 201").all(owner, ref.type, ref.id);
    this.charge(budget, rows.length);
    if (rows.length > 200) throw new DomainError('CONFLICT', 'Relationship evidence exceeds the read bound');
    return linkSnapshotDigest(ref, rows.map(row => {
      if (row.definition_digest !== digest(this.model.link(String(row.type)))) throw new DomainError('CONFLICT', 'Pinned link definition changed');
      return { type: String(row.type), from: ref, to: { type: String(row.to_type), id: String(row.to_id) } };
    }));
  }
  /** Internal projection fast path. Checks exact owner/endpoint/definition
   * membership; this grants no write or execution authority to callers. */
  containsLinks(owner: string, links: LinkWrite[]): boolean {
    const statement = this.db.prepare('SELECT definition_digest FROM ontology_links WHERE owner=? AND type=? AND from_type=? AND from_id=? AND to_type=? AND to_id=?');
    return links.every(link => {
      const row = statement.get(owner, link.type, link.from.type, link.from.id, link.to.type, link.to.id);
      if (!row) return false;
      if (row.definition_digest !== digest(this.model.link(link.type))) throw new DomainError('CONFLICT', 'Pinned link definition changed');
      return true;
    });
  }
  /** Atomic import with schema, identity, revision, endpoint and cardinality checks. */
  ingest(owner: string, input: ObjectBatch, provenance: ObjectSource): void {
    if (this.readOverlay) throw new DomainError('FORBIDDEN', 'Read views cannot import facts');
    z.string().min(1).max(2000).parse(owner);
    if (Buffer.byteLength(JSON.stringify(input)) > 1_000_000) failure('Ontology import byte limit exceeded');
    const batch = batchSchema.parse(input), source = sourceSchema.parse(provenance);
    if (batch.objects.some(o => isVirtualRef(o.ref)) || [...batch.links, ...batch.removeLinks].some(l => isVirtualRef(l.from) || isVirtualRef(l.to) || networkLinkIds.has(l.type))) {
      throw new DomainError('FORBIDDEN', 'Network facts must remain in the authorized network read view');
    }
    if (new Set(batch.objects.map(o => key(o.ref))).size !== batch.objects.length) failure('Duplicate object in import');
    this.db.exec('SAVEPOINT ontology_import');
    let changed = false;
    const touched = new Map<string, ObjectRef>();
    const inserted = new Set<string>();
    try {
      for (const object of batch.objects) {
        assertIdentityAssertionWrite(this, owner, object, source);
        assertTransactionPartyRoleWrite(this, owner, object, source);
        const def = this.model.object(object.ref.type);
        const properties = this.model.parseProperties(object.ref.type, object.properties);
        if (properties[def.primaryKey] !== object.ref.id) failure('Primary key does not match object identity');
        if (object.ref.type === 'SourceReceipt' && source.kind === 'synthetic' && properties.evidenceLevel !== 'synthetic') failure('Synthetic evidence cannot be promoted');
        if (object.ref.type === 'SourceReceipt' && (source.kind === 'task' || source.kind === 'user' && properties.evidenceLevel !== 'user_asserted')) failure('User statements cannot become provider evidence');
        const old = this.db.prepare('SELECT * FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(owner, object.ref.type, object.ref.id);
        const createdAt = old ? String(JSON.parse(String(old.body)).createdAt) : new Date(this.now()).toISOString();
        const body = JSON.stringify({ properties, source, createdAt });
        if (Buffer.byteLength(body) > 48_000) failure('Ontology object byte limit exceeded');
        if (old) {
          if (old.definition_digest !== this.model.fingerprint(object.ref.type)) throw new DomainError('CONFLICT', 'Pinned object definition changed');
          if (String(old.body) === body) { touched.set(key(object.ref), object.ref); continue; }
          const previous = JSON.parse(String(old.body)).properties as Record<string, unknown>;
          if (object.ref.type === 'OrderLine' && (previous.sourceAgreement !== undefined || properties.sourceAgreement !== undefined)) {
            throw new DomainError('CONFLICT', 'An existing order line cannot acquire or replace its sealed source agreement');
          }
          if (object.ref.type === 'Shipment' && digest(previous.expectedAllocation ?? null) !== digest(properties.expectedAllocation ?? null)) {
            throw new DomainError('CONFLICT', 'An existing shipment cannot acquire or replace its original expected allocation');
          }
          if (Number(old.revision) !== object.expectedRevision) throw new DomainError('CONFLICT', 'Object revision changed; explicit current revision required');
        } else if (object.expectedRevision !== undefined) throw new DomainError('CONFLICT', 'Expected object revision does not exist');
        if (!old) inserted.add(key(object.ref));
        this.db.prepare('INSERT INTO ontology_objects VALUES(?,?,?,?,?,?) ON CONFLICT(owner,type,id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(owner, object.ref.type, object.ref.id, Number(old?.revision ?? 0) + 1, this.model.fingerprint(object.ref.type), body);
        changed = true; touched.set(key(object.ref), object.ref);
      }
      for (const [remove, edges] of [[true, batch.removeLinks], [false, batch.links]] as const) for (const edge of edges) {
        if (edge.from.type === 'OrderLine' && !inserted.has(key(edge.from))) {
          const row = this.db.prepare('SELECT body FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(owner, edge.from.type, edge.from.id);
          const agreed = row && JSON.parse(String(row.body)).properties.sourceAgreement !== undefined;
          if (edge.type.startsWith('OrderLineAgreed') || edge.type === 'OrderLineAgreementReceipt' || agreed && ['OrderLineVariant', 'OrderLineOrder'].includes(edge.type)) {
            const present = this.containsLinks(owner, [edge]);
            if (remove && present || !remove && !present) throw new DomainError('CONFLICT', 'Order agreement relationships are immutable');
          }
        }
        if (edge.from.type === 'Shipment' && !inserted.has(key(edge.from))) {
          const row = this.db.prepare('SELECT body FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(owner, edge.from.type, edge.from.id);
          const planned = row && JSON.parse(String(row.body)).properties.expectedAllocation !== undefined;
          if (['ShipmentExpectedOrderLine', 'ShipmentExpectedSourceQuote'].includes(edge.type) || planned && edge.type === 'ShipmentOrder') {
            const present = this.containsLinks(owner, [edge]);
            if (remove && present || !remove && !present) throw new DomainError('CONFLICT', 'Shipment expected-allocation relationships are immutable');
          }
        }
        if (['EntityIdentityAssertion', 'TransactionPartyRole'].includes(edge.from.type)) {
          const existed = this.db.prepare('SELECT 1 FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(owner, edge.from.type, edge.from.id);
          if (existed && !inserted.has(key(edge.from))) {
            const present = this.containsLinks(owner, [edge]);
            if (remove && present || !remove && !present) throw new DomainError('CONFLICT', 'Identity and party-role relationships are immutable; append a successor');
          }
        }
        const def = this.model.link(edge.type);
        if (!this.model.implements(edge.from.type, def.from.type) || !this.model.implements(edge.to.type, def.to.type)) failure('Link endpoint type mismatch');
        for (const ref of [edge.from, edge.to]) { this.raw(owner, ref, { remaining: 1 }); touched.set(key(ref), ref); }
        if (remove) {
          changed = !!this.db.prepare('DELETE FROM ontology_links WHERE owner=? AND type=? AND from_type=? AND from_id=? AND to_type=? AND to_id=?').run(owner, edge.type, edge.from.type, edge.from.id, edge.to.type, edge.to.id).changes || changed;
        } else {
          const existing = this.db.prepare('SELECT definition_digest FROM ontology_links WHERE owner=? AND type=? AND from_type=? AND from_id=? AND to_type=? AND to_id=?').get(owner, edge.type, edge.from.type, edge.from.id, edge.to.type, edge.to.id);
          if (existing && existing.definition_digest !== digest(def)) throw new DomainError('CONFLICT', 'Pinned link definition changed');
          changed = !!this.db.prepare('INSERT OR IGNORE INTO ontology_links VALUES(?,?,?,?,?,?,?)').run(owner, edge.type, edge.from.type, edge.from.id, edge.to.type, edge.to.id, digest(def)).changes || changed;
        }
      }
      for (const object of batch.objects.filter(o => o.ref.type === 'ServiceRequest')) {
        const checkReferences = (value: unknown): void => {
          if (!value || typeof value !== 'object') return;
          const ref = objectRefSchema.safeParse(value);
          if (ref.success) { this.raw(owner, ref.data, { remaining: 1 }); return; }
          for (const child of Object.values(value)) checkReferences(child);
        };
        checkReferences(object.properties.conditions);
      }
      for (const ref of touched.values()) {
        for (const { link, side, direction } of this.model.sides(ref.type)) {
          const prefix = direction === 'forward' ? 'from' : 'to';
          const count = Number(this.db.prepare(`SELECT count(*) AS n FROM ontology_links WHERE owner=? AND type=? AND ${prefix}_type=? AND ${prefix}_id=?`).get(owner, link.id, ref.type, ref.id)!.n);
          if ((!side.many && count > 1) || (side.required && count === 0)) failure('Relationship cardinality violation');
        }
        if (ref.type === 'Proposal') {
          const proposal = this.raw(owner, ref, { remaining: 1 });
          if (!["execution", "read_scope"].includes(String(proposal.properties.kind))) {
            const count = this.db.prepare("SELECT count(*) AS n FROM ontology_links WHERE owner=? AND type='ProposalOffer' AND from_id=?").get(owner, ref.id)!.n;
            if (count !== 1) failure('An offer selection requires exactly one selected offer');
          }
        }
        if (ref.type === 'Payment' || ref.type === 'AfterSalesCase') {
          const relations = ref.type === 'Payment' ? ['PaymentOrder', 'PaymentReservation'] : ['CaseOrder', 'CaseReservation'];
          const count = Number(this.db.prepare('SELECT count(*) AS n FROM ontology_links WHERE owner=? AND from_type=? AND from_id=? AND type IN (?,?)').get(owner, ref.type, ref.id, ...relations)!.n);
          if (count !== 1) failure('Business record requires exactly one original order or reservation');
        }
      }
      if (changed) this.db.prepare('INSERT INTO ontology_revisions VALUES(?,1) ON CONFLICT(owner) DO UPDATE SET revision=revision+1').run(owner);
      this.db.exec('RELEASE ontology_import');
    } catch (error) { this.db.exec('ROLLBACK TO ontology_import; RELEASE ontology_import'); throw error; }
  }
  private project(owner: string, object: StoredObject, target: string, select: string[] | undefined, budget: ReadBudget): ObjectView {
    const properties: Record<string, unknown> = {}, derived: NonNullable<ObjectView['derived']> = {};
    const selected = select ?? Object.keys(this.model.properties(target)).filter(k => { const p = this.model.properties(target)[k]!; return !p.restricted && !p.derived; });
    for (const name of selected) {
      const p = this.model.properties(target)[name];
      if (!p) failure('Unknown property');
      if (p.restricted) throw new DomainError('FORBIDDEN', 'Property is not available through the agent query interface');
      const actual = this.model.propertyName(object.ref.type, target, name);
      if (p.derived) {
        const computation = deriveProperty(this, owner, object.ref, p.derived, budget);
        if (computation.status === 'known') properties[name] = computation.value;
        derived[name] = { status: computation.status, reason: computation.reason, functionRef: { id: p.derived, version: this.model.function(p.derived).version }, evidenceRefs: computation.evidenceRefs, evidenceLevels: computation.evidenceLevels };
      } else if (Object.hasOwn(object.properties, actual)) properties[name] = object.properties[actual];
    }
    return { ...object, properties, ...(Object.keys(derived).length ? { derived } : {}) };
  }
  query(owner: string, input: ObjectQuery, budget: ReadBudget = { remaining: 1000 }): OntologyQueryResult {
    const args = objectQuerySchema.parse(input);
    this.assertReaderOwner(owner);
    const networkQuery = 'object' in args ? isVirtualRef(args.object) : 'type' in args ? isVirtualRef({ type: args.type })
      : isVirtualRef(args.from) || networkLinkIds.has(this.model.navigation(args.from.type, args.link).link.id);
    if (networkQuery) return this.overlay(owner).query(args, budget);
    const revision = this.revision(owner), queryDigest = digest({ ...args, cursor: undefined });
    let last: ObjectRef | undefined;
    if (args.cursor) {
      let cursor: z.infer<typeof cursorSchema>;
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(args.cursor, 'base64url').toString())); } catch { return failure('Invalid ontology cursor'); }
      if (cursor.owner !== digest(owner) || cursor.query !== queryDigest || cursor.model !== this.model.ref.digest || cursor.revision !== revision) throw new DomainError('CONFLICT', 'Query context changed; restart the bounded query');
      last = cursor.last;
    }
    let target: string, sql: string, params: (string | number)[];
    if ('object' in args) {
      this.raw(owner, args.object, budget);
      target = args.object.type;
      sql = 'SELECT o.* FROM ontology_objects o WHERE o.owner=? AND o.type=? AND o.id=?';
      params = [owner, args.object.type, args.object.id];
    } else if ('from' in args) {
      this.raw(owner, args.from, budget);
      const nav = this.model.navigation(args.from.type, args.link);
      target = nav.other.type;
      const side = nav.direction === 'forward' ? 'from' : 'to', other = nav.direction === 'forward' ? 'to' : 'from';
      if (this.db.prepare(`SELECT 1 FROM ontology_links WHERE owner=? AND type=? AND ${side}_type=? AND ${side}_id=? AND definition_digest<>? LIMIT 1`).get(owner, nav.link.id, args.from.type, args.from.id, digest(nav.link))) throw new DomainError('CONFLICT', 'Pinned link definition changed');
      sql = `SELECT o.* FROM ontology_links l JOIN ontology_objects o ON o.owner=l.owner AND o.type=l.${other}_type AND o.id=l.${other}_id WHERE l.owner=? AND l.type=? AND l.${side}_type=? AND l.${side}_id=? AND l.definition_digest=?`;
      params = [owner, nav.link.id, args.from.type, args.from.id, digest(nav.link)];
    } else {
      target = args.type;
      const types = this.model.concreteTypes(target);
      sql = `SELECT o.* FROM ontology_objects o WHERE o.owner=? AND o.type IN (${types.map(() => '?').join(',')})`;
      params = [owner, ...types];
    }
    const properties = this.model.properties(target);
    for (const name of args.select ?? []) {
      if (!Object.hasOwn(properties, name)) failure('Unknown selected property');
      if (properties[name]!.restricted) throw new DomainError('FORBIDDEN', 'Restricted property cannot be selected');
    }
    for (const f of args.where) {
      if (!Object.hasOwn(properties, f.property)) failure('Filter requires a registered property');
      const p = properties[f.property];
      if (!p || p.derived || ['struct', 'array'].includes(p.kind)) failure('Filter requires a registered stored scalar property');
      if (p.restricted) throw new DomainError('FORBIDDEN', 'Restricted property cannot be filtered');
      if (!['eq', 'in'].includes(f.op) && !['integer', 'timestamp', 'decimal'].includes(p.kind)) failure('Unsupported comparison for this property');
      const values = f.op === 'in' ? f.value : [f.value];
      if (!Array.isArray(values) || values.some(v => !p.schema.safeParse(v).success)) failure('Filter value does not match property type');
    }
    if (last) { sql += ' AND (o.type > ? OR (o.type=? AND o.id>?))'; params.push(last.type, last.type, last.id); }
    // Index-bounded scan, not an unbounded JSON predicate scan. Empty pages can have a continuation.
    sql += ' ORDER BY o.type,o.id LIMIT 201';
    const rows = this.db.prepare(sql).all(...params);
    this.charge(budget, rows.length);
    const items: ObjectView[] = []; let scanned = 0, bytes = 0, hasMore = false;
    for (const row of rows) {
      if (scanned === 200 || items.length === args.limit) { hasMore = true; break; }
      scanned++;
      const ref = { type: String(row.type), id: String(row.id) };
      if (row.definition_digest !== this.model.fingerprint(ref.type)) throw new DomainError('CONFLICT', 'Pinned object definition changed');
      const object = { ref, revision: Number(row.revision), ...JSON.parse(String(row.body)) } as StoredObject;
      const matches = args.where.every(f => {
        const value = object.properties[this.model.propertyName(ref.type, target, f.property)];
        if (value === undefined) return false;
        const kind = properties[f.property]!.kind;
        const normalize = (v: unknown) => kind === 'timestamp' ? Date.parse(String(v)) : kind === 'decimal' ? BigInt(String(v).replace('.', '').padEnd(String(v).split('.')[0]!.length + 6, '0')) : v;
        const a = normalize(value) as string | number | bigint | boolean;
        if (f.op === 'in') return (f.value as unknown[]).some(v => a === normalize(v));
        const b = normalize(f.value) as typeof a;
        return f.op === 'eq' ? a === b : f.op === 'lt' ? a < b : f.op === 'lte' ? a <= b : f.op === 'gt' ? a > b : a >= b;
      });
      if (matches) {
        const view = this.project(owner, object, target, args.select, budget), size = Buffer.byteLength(JSON.stringify(view));
        if (bytes + size > 60_000) { if (!items.length) failure('Object projection exceeds response limit'); hasMore = true; break; }
        items.push(view); bytes += size;
      }
      last = ref;
    }
    const cursor = hasMore && last ? Buffer.from(JSON.stringify({ owner: digest(owner), query: queryDigest, model: this.model.ref.digest, revision, last })).toString('base64url') : undefined;
    if (this.revision(owner) !== revision) throw new DomainError('CONFLICT', 'Objects changed during query; retry against the current revision');
    return { model: this.model.ref, items, page: { limit: args.limit, scanned, hasMore, cursor }, datasetRevision: revision };
  }
  /** Single bounded relationship read for registered functions; never follows unlimited pages. */
  related(owner: string, from: ObjectRef, link: string, budget: ReadBudget): ObjectView[] | undefined {
    const result = this.query(owner, { from, link, limit: 50 }, budget);
    return result.page.hasMore ? undefined : result.items;
  }
  evaluate(owner: string, input: unknown, budget: ReadBudget = { remaining: 1000 }) {
    this.assertReaderOwner(owner);
    const revision = this.revision(owner);
    const args = functionCallSchema.parse(input), definition = this.model.function(args.function);
    if (!definition.inputTypes.some(t => this.model.implements(args.object.type, t))) failure('Function requires its registered object type');
    // Registered canonical calculations already own a deliberately narrow
    // private-evidence check. A read overlay must not disable that check or
    // expose it as a general private-read method to query callers.
    const calculationStore = this.backingStore && !isVirtualRef(args.object) ? this.backingStore : this;
    const result = { ...evaluateFunction(calculationStore, owner, args, budget), functionRef: { id: definition.id, version: definition.version }, model: this.model.ref };
    if (Buffer.byteLength(JSON.stringify(result)) > 64000) throw new DomainError('CONFLICT', 'Function response limit exceeded; narrow the investigation');
    if (this.revision(owner) !== revision) throw new DomainError('CONFLICT', 'Objects changed during calculation; retry against the current revision');
    return result;
  }
}
