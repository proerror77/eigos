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
import { assertBusinessTransaction } from '../core/transaction.js';
import type { OntologyReleaseRef } from './definition-contracts.js';
import type { SecurityPolicies } from '../security/policy-store.js';
import { authorizationScope } from '../security/context.js';
import { SecurityError } from '../security/store.js';
import {accessDigest} from '../security/model.js';
import {responseOnlyProjection,projectFunctionValue} from '../security/projections.js';

const sourceSchema = z.object({ kind: z.enum(['synthetic', 'user', 'provider', 'task']), id: z.string().min(1).max(200), observedAt: z.iso.datetime({ offset: true }) }).strict();
export type ObjectSource = z.infer<typeof sourceSchema>;
const filterSchema = z.object({ property: nameSchema, op: z.enum(['eq', 'lt', 'lte', 'gt', 'gte', 'in']), value: z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.array(z.union([z.string().max(1000), z.number().finite(), z.boolean()])).min(1).max(20)]) }).strict();
const queryFields = { select: z.array(nameSchema).min(1).max(20).optional(), where: z.array(filterSchema).max(8).default([]), limit: z.number().int().min(1).max(50).default(20), cursor: z.string().max(4096).optional() };
export const objectQuerySchema = z.union([
  z.object({ type: nameSchema, currentDefinitionsOnly: z.boolean().optional(), ...queryFields }).strict(),
  z.object({ from: objectRefSchema, link: nameSchema, ...queryFields }).strict(),
  z.object({ object: objectRefSchema, ...queryFields }).strict(),
]).describe('Each response covers only the requested object, type, or named relationship. Empty results on one relationship do not prove that other relationships or participants are absent. Inspect pagination and state the scope actually read; unqueried information remains unverified.');
export type ObjectQuery = z.input<typeof objectQuerySchema>;
export interface ObjectWrite { ref: ObjectRef; properties: Record<string, unknown>; expectedRevision?: number; reuseIfUnchanged?: boolean; observedFields?: string[] }
export interface LinkWrite { type: string; from: ObjectRef; to: ObjectRef }
export function linkSnapshotDigest(ref: ObjectRef, links: LinkWrite[]): string {
  const values = links.filter(l => l.from.type === ref.type && l.from.id === ref.id && l.to.type !== 'SourceReceipt').map(l => ({ type: l.type, to: l.to }));
  return digest(values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
export interface ObjectBatch { objects: ObjectWrite[]; links?: LinkWrite[]; removeLinks?: LinkWrite[] }
export interface ObjectTombstone { ref: ObjectRef; expectedRevision: number }
export interface ManagedObjectBatch extends ObjectBatch { creates?: ObjectRef[]; tombstones?: ObjectTombstone[] }
export interface OntologyGraphContext {
  security?: SecurityPolicies;
  ontologyId?: string;
  releaseRef?: OntologyReleaseRef;
  compatibleDefinition?: (args: { kind: 'object' | 'link'; id: string; storedDigest: string; currentDigest: string; properties?: Record<string, unknown> }) => boolean;
  skipLegacyMigration?: boolean;
  pipelineStatus?: (owner: string, programRef: { id: string; version: string }, configurationDigest: string, actionId: string) => import('./pipeline/contracts.js').PipelineStatus;
  pipelineChanges?: (owner: string, jobId: string, requestRevision: number) => import('./pipeline/facts.js').PipelineFactChange[];
}
interface StoredObject { ref: ObjectRef; revision: number; createdAt: string; properties: Record<string, unknown>; source: ObjectSource; tombstone?: { revision: number; deletedAt: string } }
export interface ObjectView extends StoredObject { derived?: Record<string, { status: 'known' | 'unknown'; reason?: string; functionRef: { id: string; version: string }; evidenceRefs: ObjectRef[]; evidenceLevels: string[] }> }
export interface ReadBudget { remaining: number }
export interface OntologyQueryResult {
  model: OntologyModel['ref']; items: ObjectView[];
  page: { limit: number; scanned: number; hasMore: boolean; cursor?: string };
  datasetRevision: number;
  definitionScope?: 'current_definitions_only';
}
const batchSchema = z.object({ objects: z.array(z.object({ ref: objectRefSchema, properties: z.record(z.string(), z.unknown()), expectedRevision: z.number().int().min(1).optional(), reuseIfUnchanged: z.boolean().optional(), observedFields: z.array(nameSchema).min(1).max(100).optional() }).strict()).max(200), links: z.array(z.object({ type: nameSchema, from: objectRefSchema, to: objectRefSchema }).strict()).max(500).default([]), removeLinks: z.array(z.object({ type: nameSchema, from: objectRefSchema, to: objectRefSchema }).strict()).max(100).default([]) }).strict();
const cursorSchema = z.object({ owner: z.string(), ontologyId: z.string().optional(), query: z.string(), model: z.string(), revision: z.number().int(), last: objectRefSchema }).strict();
const key = (ref: ObjectRef) => JSON.stringify([ref.type, ref.id]);
function failure(message: string): never { throw new DomainError('INVALID_INPUT', message); }

/** Owned business objects only. Writes are internal source mappings, never public query operations. */
export class OntologyObjectStore {
  readonly model: OntologyModel;
  readonly ontologyId: string;
  readonly releaseRef?: OntologyReleaseRef;
  private readerFactory?: (owner: string, requestId: string) => NetworkOntologyReadAdapter | undefined;
  private backingStore?: OntologyObjectStore;
  pipelineStatus(owner: string, programRef: { id: string; version: string }, configurationDigest: string, actionId: string): import('./pipeline/contracts.js').PipelineStatus {
    return this.context.pipelineStatus?.(owner, programRef, configurationDigest, actionId) ?? { status: 'unmanaged', reason: 'No intake policy on this historical graph', verificationIds: [], authorization: 'per_action_required', availabilityProof: false };
  }
  pipelineChanges(owner: string, jobId: string, requestRevision: number): import('./pipeline/facts.js').PipelineFactChange[] {
    const changes = this.context.pipelineChanges?.(owner, jobId, requestRevision) ?? [];
    return changes.flatMap(change => {
      try {
        const view = this.read(owner, change.object), guard = this.guard(), binding = guard?.requireObject(owner, change.object, view.revision);
        const stored = this.raw(owner, change.object, { remaining: 1 }), properties = this.properties(change.object.type);
        const fields = change.fields.filter(field => {
          if (Object.hasOwn(view.properties, field)) return true;
          // A readable field can disappear. Keep that removal notice while
          // still hiding restricted, unauthorized and response-only fields.
          const property = properties[field];
          return !Object.hasOwn(stored.properties, field) && property && !property.restricted && !property.derived
            && (!binding || binding.fields.includes(field))
            && !(guard && authorizationScope()?.actor.actorKind === 'worker' && responseOnlyProjection(change.object.type, field));
        });
        return fields.length ? [{ ...change, fields }] : [];
      } catch (error) { if (error instanceof DomainError || error instanceof SecurityError) return []; throw error; }
    });
  }
  constructor(private db: DatabaseSync, model = businessModel, readonly now: () => number = Date.now, private readOverlay?: NetworkOntologyReadAdapter, private context: OntologyGraphContext = {}, initialize = true) {
    this.model = model;
    this.ontologyId = context.ontologyId ?? 'eigos.business';
    if (!this.ontologyId || this.ontologyId.length > 200 || context.releaseRef && context.releaseRef.ontologyId !== this.ontologyId) failure('Invalid ontology graph namespace');
    this.releaseRef = context.releaseRef ? structuredClone(context.releaseRef) : undefined;
    // A read view shares the existing owned connection, but neither initializes
    // nor migrates it, and cannot import or rewrite source facts.
    if (readOverlay || !initialize) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ontology_objects (owner TEXT NOT NULL,type TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,definition_digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,type,id));
      CREATE TABLE IF NOT EXISTS ontology_links (owner TEXT NOT NULL,type TEXT NOT NULL,from_type TEXT NOT NULL,from_id TEXT NOT NULL,to_type TEXT NOT NULL,to_id TEXT NOT NULL,definition_digest TEXT NOT NULL,PRIMARY KEY(owner,type,from_type,from_id,to_type,to_id));
      CREATE INDEX IF NOT EXISTS ontology_links_reverse ON ontology_links(owner,type,to_type,to_id,from_type,from_id);
      CREATE INDEX IF NOT EXISTS ontology_links_outgoing ON ontology_links(owner,from_type,from_id,type,to_type,to_id);
      CREATE TABLE IF NOT EXISTS ontology_revisions (owner TEXT PRIMARY KEY,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ontology_scoped_objects (ontology_id TEXT NOT NULL,owner TEXT NOT NULL,type TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,definition_digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(ontology_id,owner,type,id));
      CREATE TABLE IF NOT EXISTS ontology_scoped_links (ontology_id TEXT NOT NULL,owner TEXT NOT NULL,type TEXT NOT NULL,from_type TEXT NOT NULL,from_id TEXT NOT NULL,to_type TEXT NOT NULL,to_id TEXT NOT NULL,definition_digest TEXT NOT NULL,PRIMARY KEY(ontology_id,owner,type,from_type,from_id,to_type,to_id));
      CREATE INDEX IF NOT EXISTS ontology_scoped_links_reverse ON ontology_scoped_links(ontology_id,owner,type,to_type,to_id,from_type,from_id);
      CREATE INDEX IF NOT EXISTS ontology_scoped_links_outgoing ON ontology_scoped_links(ontology_id,owner,from_type,from_id,type,to_type,to_id);
      CREATE TABLE IF NOT EXISTS ontology_scoped_revisions (ontology_id TEXT NOT NULL,owner TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(ontology_id,owner));
      CREATE TABLE IF NOT EXISTS ontology_tombstones (ontology_id TEXT NOT NULL,owner TEXT NOT NULL,type TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,definition_digest TEXT NOT NULL,body TEXT NOT NULL,deleted_at TEXT NOT NULL,PRIMARY KEY(ontology_id,owner,type,id));
      CREATE TABLE IF NOT EXISTS ontology_object_versions (ontology_id TEXT NOT NULL,owner TEXT NOT NULL,type TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,definition_digest TEXT NOT NULL,release_id TEXT,release_digest TEXT,body TEXT NOT NULL,deleted INTEGER NOT NULL,PRIMARY KEY(ontology_id,owner,type,id,revision));
      CREATE TRIGGER IF NOT EXISTS ontology_object_versions_no_update BEFORE UPDATE ON ontology_object_versions BEGIN SELECT RAISE(ABORT,'Object writer history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ontology_object_versions_no_delete BEFORE DELETE ON ontology_object_versions BEGIN SELECT RAISE(ABORT,'Object writer history is immutable'); END;
    `);
    if (model.ref.id === 'eigos.business' && model.ref.version === '15' && !context.skipLegacyMigration) migrateIntegratedOntology(this.db, businessModelV9, model);
  }
  get security() { return this.context.security; }
  private get scoped() { return this.ontologyId !== 'eigos.business'; }
  private get objectTable() { return this.scoped ? 'ontology_scoped_objects' : 'ontology_objects'; }
  private get linkTable() { return this.scoped ? 'ontology_scoped_links' : 'ontology_links'; }
  private get revisionTable() { return this.scoped ? 'ontology_scoped_revisions' : 'ontology_revisions'; }
  private owned(alias = '') { return this.scoped ? `${alias}ontology_id=? AND ${alias}owner=?` : `${alias}owner=?`; }
  private ownerParameters(owner: string): string[] { return this.scoped ? [this.ontologyId, owner] : [owner]; }
  forModel(model: OntologyModel, context: OntologyGraphContext & { ontologyId: string; releaseRef: OntologyReleaseRef }): OntologyObjectStore {
    const view = new OntologyObjectStore(this.db, model, this.now, this.readOverlay, { ...context, security: this.security, skipLegacyMigration: true }, false);
    view.readerFactory = this.readerFactory;
    if (this.backingStore) view.backingStore = this.backingStore.forModel(model, context);
    return view;
  }
  private assertObjectDefinition(type: string, storedDigest: string, properties: Record<string, unknown>): void {
    const currentDigest = this.model.fingerprint(type);
    if (this.security && (!this.security.model.hasType(type) || currentDigest !== this.security.model.fingerprint(type))) throw new SecurityError('POLICY_CHANGED');
    if (storedDigest === currentDigest) return;
    if (!this.context.compatibleDefinition?.({ kind: 'object', id: type, storedDigest, currentDigest, properties })
      || digest(this.model.parseProperties(type, properties)) !== digest(properties)) throw new DomainError('CONFLICT', 'Object definition changed; historical data cannot be reinterpreted');
  }
  private assertLinkDefinition(type: string, storedDigest: string): void {
    const currentDigest = digest(this.model.link(type));
    if (storedDigest !== currentDigest && !this.context.compatibleDefinition?.({ kind: 'link', id: type, storedDigest, currentDigest })) throw new DomainError('CONFLICT', 'Pinned link definition changed');
  }
  private bumpRevision(owner: string): void {
    if (this.scoped) this.db.prepare('INSERT INTO ontology_scoped_revisions VALUES(?,?,1) ON CONFLICT(ontology_id,owner) DO UPDATE SET revision=revision+1').run(this.ontologyId, owner);
    else this.db.prepare('INSERT INTO ontology_revisions VALUES(?,1) ON CONFLICT(owner) DO UPDATE SET revision=revision+1').run(owner);
  }
  private rememberVersion(owner: string, ref: ObjectRef, revision: number, definitionDigest: string, body: string, deleted = false, releaseRef: OntologyReleaseRef | null = this.releaseRef ?? null): void {
    const previous = this.db.prepare('SELECT definition_digest,body,deleted FROM ontology_object_versions WHERE ontology_id=? AND owner=? AND type=? AND id=? AND revision=?').get(this.ontologyId, owner, ref.type, ref.id, revision);
    if (previous && (previous.definition_digest !== definitionDigest || previous.body !== body || Number(previous.deleted) !== Number(deleted))) throw new DomainError('CONFLICT', 'An immutable object writer version already differs');
    if (!previous) this.db.prepare('INSERT INTO ontology_object_versions VALUES(?,?,?,?,?,?,?,?,?,?)').run(this.ontologyId, owner, ref.type, ref.id, revision, definitionDigest, releaseRef?.releaseId ?? null, releaseRef?.digest ?? null, body, Number(deleted));
  }
  setReadOverlayFactory(factory: (owner: string, requestId: string) => NetworkOntologyReadAdapter | undefined): void {
    if (this.readOverlay) throw new DomainError('FORBIDDEN', 'A read view cannot change its authority resolver');
    this.readerFactory = factory;
  }
  withReadOverlay(overlay: NetworkOntologyReadAdapter): OntologyObjectStore {
    const view = new OntologyObjectStore(this.db, this.model, this.now, overlay, this.context, false);
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
    if (this.security) throw new SecurityError('AUTHORIZATION_REQUIRED');
    if (!this.readOverlay) throw new DomainError('FORBIDDEN', 'Network objects require a current authorized read context');
    return this.readOverlay;
  }
  private guard() {
    if (this.security) {
      if (this.ontologyId !== this.security.model.ref.id) throw new SecurityError('POLICY_CHANGED');
      this.security.assertModel(this.model);
    }
    return authorizationScope()?.projection ? undefined : this.security;
  }
  private properties(type:string) {return this.guard()?.fields(type) ?? this.model.properties(type);}
  private charge(budget: ReadBudget, count = 1) {
    budget.remaining -= count;
    if (budget.remaining < 0) throw new DomainError('CONFLICT', 'Ontology read work budget exhausted; narrow the query');
  }
  revision(owner: string): number { return this.guard()?.visibleRevision(owner) ?? Number(this.db.prepare(`SELECT revision FROM ${this.revisionTable} WHERE ${this.owned()}`).get(...this.ownerParameters(owner))?.revision ?? 0); }
  private raw(owner: string, ref: ObjectRef, budget: ReadBudget, allowTombstone = false): StoredObject {
    objectRefSchema.parse(ref); this.model.object(ref.type); this.charge(budget);
    this.assertReaderOwner(owner);
    if (isVirtualRef(ref)) return this.overlay(owner).read(ref, budget);
    const row = this.db.prepare(`SELECT * FROM ${this.objectTable} WHERE ${this.owned()} AND type=? AND id=?`).get(...this.ownerParameters(owner), ref.type, ref.id);
    if (!row) throw new DomainError('NOT_FOUND', 'Ontology object not found');
    const deleted = this.db.prepare('SELECT revision,deleted_at FROM ontology_tombstones WHERE ontology_id=? AND owner=? AND type=? AND id=?').get(this.ontologyId, owner, ref.type, ref.id);
    if (deleted && !allowTombstone) throw new DomainError('NOT_FOUND', 'Ontology object was tombstoned');
    const body = JSON.parse(String(row.body)); this.assertObjectDefinition(ref.type, String(row.definition_digest), body.properties);
    return { ref, revision: Number(row.revision), ...body, ...(deleted ? { tombstone: { revision: Number(deleted.revision), deletedAt: String(deleted.deleted_at) } } : {}) };
  }
  read(owner: string, ref: ObjectRef, budget: ReadBudget = { remaining: 1000 }): ObjectView {
    const guard=this.guard();
    const read=()=>{
      guard?.requireObject(owner, ref);
      return this.project(owner, this.raw(owner, ref, budget), ref.type, undefined, budget);
    };
    return guard ? guard.readSnapshot(read) : read();
  }
  /** Trusted source validators only. Never expose this through a query or model tool. */
  readPrivate(owner: string, ref: ObjectRef, budget: ReadBudget = { remaining: 1000 }): ObjectView {
    if (this.guard()) { if (!authorizationScope()?.integrity) throw new SecurityError('AUTHORIZATION_REQUIRED'); this.guard()!.requireObject(owner, ref); }
    if (this.readOverlay) throw new DomainError('FORBIDDEN', 'Private source facts are unavailable through a read view');
    return structuredClone(this.raw(owner, ref, budget));
  }
  /** Internal evidence validation returns a digest, never the unprojected body. */
  evidencePropertiesDigest(owner:string,ref:ObjectRef,budget:ReadBudget):string {
    if(this.guard()) {
      if(!authorizationScope()?.integrity) throw new SecurityError('AUTHORIZATION_REQUIRED');
      this.guard()!.requireObject(owner,ref);
    }
    return digest(this.raw(owner,ref,budget).properties);
  }
  relationshipDigest(owner: string, ref: ObjectRef, budget: ReadBudget): string {
    if (isVirtualRef(ref)) return this.overlay(owner).relationshipDigest(ref, budget);
    this.guard()?.requireObject(owner, ref);
    this.raw(owner, ref, budget);
    const rows = this.db.prepare(`SELECT * FROM ${this.linkTable} WHERE ${this.owned()} AND from_type=? AND from_id=? AND to_type<>'SourceReceipt' ORDER BY type,to_type,to_id LIMIT 201`).all(...this.ownerParameters(owner), ref.type, ref.id);
    this.charge(budget, rows.length);
    if (rows.length > 200) throw new DomainError('CONFLICT', 'Relationship evidence exceeds the read bound');
    return linkSnapshotDigest(ref, rows.filter(row => {
      const guard = this.guard(); if (!guard || authorizationScope()?.integrity) return true;
      const scope = guard.scope(owner);
      return guard.resourceAllowed(scope, 'linkType', String(row.type)) && !!guard.binding(scope, { type: String(row.to_type), id: String(row.to_id) });
    }).map(row => {
      this.assertLinkDefinition(String(row.type), String(row.definition_digest));
      return { type: String(row.type), from: ref, to: { type: String(row.to_type), id: String(row.to_id) } };
    }));
  }
  /** Internal projection fast path. Checks exact owner/endpoint/definition
   * membership; this grants no write or execution authority to callers. */
  containsLinks(owner: string, links: LinkWrite[]): boolean {
    const statement = this.db.prepare(`SELECT definition_digest FROM ${this.linkTable} WHERE ${this.owned()} AND type=? AND from_type=? AND from_id=? AND to_type=? AND to_id=?`);
    return links.every(link => {
      const row = statement.get(...this.ownerParameters(owner), link.type, link.from.type, link.from.id, link.to.type, link.to.id);
      if (!row) return false;
      this.assertLinkDefinition(link.type, String(row.definition_digest));
      return true;
    });
  }
  /** Inspect an owned managed target without permitting creation through the source mapper. */
  managedObject(owner: string, ref: ObjectRef): ObjectView | undefined {
    if (this.model.objectWritePolicy(ref.type) !== 'managed' || isVirtualRef(ref)) throw new DomainError('FORBIDDEN', 'Generic actions cannot access protected write targets');
    try { return this.read(owner, ref); } catch (error) { if (error instanceof DomainError && error.code === 'NOT_FOUND') return undefined; throw error; }
  }
  tombstone(owner: string, ref: ObjectRef): { ref: ObjectRef; revision: number; deletedAt: string } | undefined {
    objectRefSchema.parse(ref); this.assertReaderOwner(owner);
    if (this.model.objectWritePolicy(ref.type) !== 'managed') throw new DomainError('FORBIDDEN', 'Protected object tombstones are unavailable');
    const row = this.db.prepare('SELECT revision,deleted_at FROM ontology_tombstones WHERE ontology_id=? AND owner=? AND type=? AND id=?').get(this.ontologyId, owner, ref.type, ref.id);
    return row ? { ref: structuredClone(ref), revision: Number(row.revision), deletedAt: String(row.deleted_at) } : undefined;
  }
  /** Shared-transaction write boundary. Source mappers keep their separate trusted ingest path. */
  applyManaged(owner: string, input: ManagedObjectBatch, source: ObjectSource): void {
    assertBusinessTransaction(this.db);
    this.writeManaged(owner, input, source);
  }
  /** Exercises the same schema, revision and cardinality checks then rolls back all changes. */
  previewManaged(owner: string, input: ManagedObjectBatch, source: ObjectSource): void {
    if (this.readOverlay) throw new DomainError('FORBIDDEN', 'Read views cannot preview data mutations');
    this.db.exec('SAVEPOINT ontology_preview');
    try { this.writeManaged(owner, input, source); }
    finally { this.db.exec('ROLLBACK TO ontology_preview; RELEASE ontology_preview'); }
  }
  private writeManaged(owner: string, input: ManagedObjectBatch, source: ObjectSource): void {
    if (this.readOverlay) throw new DomainError('FORBIDDEN', 'Read views cannot mutate facts');
    if (source.kind !== 'user' && source.kind !== 'task') throw new DomainError('FORBIDDEN', 'Managed actions cannot fabricate provider provenance');
    const batch = batchSchema.parse({ objects: input.objects, links: input.links, removeLinks: input.removeLinks });
    const creates = z.array(objectRefSchema).max(200).parse(input.creates ?? []);
    const tombstones = z.array(z.strictObject({ ref: objectRefSchema, expectedRevision: z.number().int().positive() })).max(64).parse(input.tombstones ?? []);
    const createKeys = new Set(creates.map(key)), deletedKeys = new Set(tombstones.map(item => key(item.ref)));
    if (createKeys.size !== creates.length || deletedKeys.size !== tombstones.length || batch.objects.some(item => deletedKeys.has(key(item.ref)))) failure('Duplicate or contradictory managed mutation');
    for (const ref of creates) {
      if (!batch.objects.some(item => key(item.ref) === key(ref)) || this.managedObject(owner, ref) || this.tombstone(owner, ref)) throw new DomainError('CONFLICT', 'Create requires an unused object identity');
    }
    for (const object of batch.objects) {
      const previous = this.managedObject(owner, object.ref);
      if (!previous && !createKeys.has(key(object.ref))) throw new DomainError('CONFLICT', 'Creation must be explicitly declared');
      if (previous && object.expectedRevision !== previous.revision) throw new DomainError('CONFLICT', 'Managed writes require the exact current revision');
      const stored = previous ? this.raw(owner, object.ref, { remaining: 1 }).properties : {};
      // Managed updates are patches. Preserve private/source fields internally;
      // neither preview nor the caller needs to receive their values.
      for (const field of Object.keys(object.properties)) if (digest(stored[field] ?? null) !== digest(object.properties[field] ?? null) || !Object.hasOwn(stored, field)) {
        const property = this.model.properties(object.ref.type)[field];
        if (!property || property.derived || property.restricted || this.model.propertyAuthority(object.ref.type, field) === 'source') throw new DomainError('FORBIDDEN', 'Managed writes cannot change protected fields');
      }
      if (previous) object.properties = { ...stored, ...object.properties };
    }
    for (const deletion of tombstones) {
      const object = this.managedObject(owner, deletion.ref);
      if (!object || object.revision !== deletion.expectedRevision) throw new DomainError('CONFLICT', 'Tombstone requires the exact current revision');
      if (Object.keys(this.model.properties(deletion.ref.type)).some(field => this.model.propertyAuthority(deletion.ref.type, field) === 'source')) throw new DomainError('FORBIDDEN', 'Objects containing source-authority fields cannot be generically deleted');
    }
    for (const link of [...batch.links, ...batch.removeLinks]) {
      if (this.model.linkWritePolicy(link.type) !== 'managed' || this.model.objectWritePolicy(link.from.type) !== 'managed' || this.model.objectWritePolicy(link.to.type) !== 'managed') throw new DomainError('FORBIDDEN', 'Managed actions cannot change protected relationships');
    }
    this.ingestBatch(owner, batch, source, tombstones);
  }
  /** Atomic import with schema, identity, revision, endpoint and cardinality checks. */
  ingest(owner: string, input: ObjectBatch, provenance: ObjectSource): void { this.ingestBatch(owner, input, provenance); }
  private ingestBatch(owner: string, input: ObjectBatch, provenance: ObjectSource, tombstones: ObjectTombstone[] = []): void {
    if (this.readOverlay) throw new DomainError('FORBIDDEN', 'Read views cannot import facts');
    if (this.security && !authorizationScope()?.projection) throw new SecurityError('AUTHORIZATION_REQUIRED');
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
    const deleted = new Set(tombstones.map(item => key(item.ref)));
    try {
      for (const object of batch.objects) {
        assertIdentityAssertionWrite(this, owner, object, source);
        assertTransactionPartyRoleWrite(this, owner, object, source);
        const def = this.model.object(object.ref.type);
        const properties = this.model.parseProperties(object.ref.type, object.properties);
        if (object.observedFields && (!['provider', 'synthetic'].includes(source.kind) || object.observedFields.some(field => !Object.hasOwn(properties, field))
          || ![def.primaryKey, def.titleKey].every(field => object.observedFields!.includes(field)))) failure('A source observation must cover the exact identity and title fields');
        if (properties[def.primaryKey] !== object.ref.id) failure('Primary key does not match object identity');
        if (object.ref.type === 'SourceReceipt' && source.kind === 'synthetic' && properties.evidenceLevel !== 'synthetic') failure('Synthetic evidence cannot be promoted');
        if (object.ref.type === 'SourceReceipt' && (source.kind === 'task' || source.kind === 'user' && properties.evidenceLevel !== 'user_asserted')) failure('User statements cannot become provider evidence');
        if (this.db.prepare('SELECT 1 FROM ontology_tombstones WHERE ontology_id=? AND owner=? AND type=? AND id=?').get(this.ontologyId, owner, object.ref.type, object.ref.id)) throw new DomainError('CONFLICT', 'Tombstoned object identities cannot be reused');
        const old = this.db.prepare(`SELECT * FROM ${this.objectTable} WHERE ${this.owned()} AND type=? AND id=?`).get(...this.ownerParameters(owner), object.ref.type, object.ref.id);
        const createdAt = old ? String(JSON.parse(String(old.body)).createdAt) : new Date(this.now()).toISOString();
        const body = JSON.stringify({ properties, source, createdAt });
        if (Buffer.byteLength(body) > 48_000) failure('Ontology object byte limit exceeded');
        if (old) {
          this.assertObjectDefinition(object.ref.type, String(old.definition_digest), JSON.parse(String(old.body)).properties);
          if (object.reuseIfUnchanged && Number(old.revision) !== object.expectedRevision) failure('Entity reuse requires an exact source-authoritative revision');
          if (String(old.body) === body) { touched.set(key(object.ref), object.ref); continue; }
          const previous = JSON.parse(String(old.body)).properties as Record<string, unknown>;
          // A fresh authorized source can independently observe the same entity.
          // Keep its semantic revision; recordProjection still binds this read's
          // exact source and lineage to the current task. Managed edits do not use it.
          if (object.reuseIfUnchanged && digest(previous) === digest(properties)) {
            if (source.kind !== 'provider' && source.kind !== 'synthetic' || this.model.objectWritePolicy(object.ref.type) !== 'source'
              || Number(old.revision) !== object.expectedRevision) failure('Entity reuse requires an exact source-authoritative revision');
            touched.set(key(object.ref), object.ref); continue;
          }
          if (object.ref.type === 'OrderLine' && (previous.sourceAgreement !== undefined || properties.sourceAgreement !== undefined)) {
            throw new DomainError('CONFLICT', 'An existing order line cannot acquire or replace its sealed source agreement');
          }
          if (object.ref.type === 'Shipment' && digest(previous.expectedAllocation ?? null) !== digest(properties.expectedAllocation ?? null)) {
            throw new DomainError('CONFLICT', 'An existing shipment cannot acquire or replace its original expected allocation');
          }
          if (Number(old.revision) !== object.expectedRevision) throw new DomainError('CONFLICT', 'Object revision changed; explicit current revision required');
          this.rememberVersion(owner, object.ref, Number(old.revision), String(old.definition_digest), String(old.body), false, null);
        } else if (object.expectedRevision !== undefined) throw new DomainError('CONFLICT', 'Expected object revision does not exist');
        if (!old) inserted.add(key(object.ref));
        if (this.scoped) this.db.prepare('INSERT INTO ontology_scoped_objects VALUES(?,?,?,?,?,?,?) ON CONFLICT(ontology_id,owner,type,id) DO UPDATE SET revision=excluded.revision,definition_digest=excluded.definition_digest,body=excluded.body').run(this.ontologyId, owner, object.ref.type, object.ref.id, Number(old?.revision ?? 0) + 1, this.model.fingerprint(object.ref.type), body);
        else this.db.prepare('INSERT INTO ontology_objects VALUES(?,?,?,?,?,?) ON CONFLICT(owner,type,id) DO UPDATE SET revision=excluded.revision,definition_digest=excluded.definition_digest,body=excluded.body').run(owner, object.ref.type, object.ref.id, Number(old?.revision ?? 0) + 1, this.model.fingerprint(object.ref.type), body);
        this.rememberVersion(owner, object.ref, Number(old?.revision ?? 0) + 1, this.model.fingerprint(object.ref.type), body);
        changed = true; touched.set(key(object.ref), object.ref);
      }
      for (const [remove, edges] of [[true, batch.removeLinks], [false, batch.links]] as const) for (const edge of edges) {
        if (edge.from.type === 'OrderLine' && !inserted.has(key(edge.from))) {
          const row = this.db.prepare(`SELECT body FROM ${this.objectTable} WHERE ${this.owned()} AND type=? AND id=?`).get(...this.ownerParameters(owner), edge.from.type, edge.from.id);
          const agreed = row && JSON.parse(String(row.body)).properties.sourceAgreement !== undefined;
          if (edge.type.startsWith('OrderLineAgreed') || edge.type === 'OrderLineAgreementReceipt' || agreed && ['OrderLineVariant', 'OrderLineOrder'].includes(edge.type)) {
            const present = this.containsLinks(owner, [edge]);
            if (remove && present || !remove && !present) throw new DomainError('CONFLICT', 'Order agreement relationships are immutable');
          }
        }
        if (edge.from.type === 'Shipment' && !inserted.has(key(edge.from))) {
          const row = this.db.prepare(`SELECT body FROM ${this.objectTable} WHERE ${this.owned()} AND type=? AND id=?`).get(...this.ownerParameters(owner), edge.from.type, edge.from.id);
          const planned = row && JSON.parse(String(row.body)).properties.expectedAllocation !== undefined;
          if (['ShipmentExpectedOrderLine', 'ShipmentExpectedSourceQuote'].includes(edge.type) || planned && edge.type === 'ShipmentOrder') {
            const present = this.containsLinks(owner, [edge]);
            if (remove && present || !remove && !present) throw new DomainError('CONFLICT', 'Shipment expected-allocation relationships are immutable');
          }
        }
        if (['EntityIdentityAssertion', 'TransactionPartyRole'].includes(edge.from.type)) {
          const existed = this.db.prepare(`SELECT 1 FROM ${this.objectTable} WHERE ${this.owned()} AND type=? AND id=?`).get(...this.ownerParameters(owner), edge.from.type, edge.from.id);
          if (existed && !inserted.has(key(edge.from))) {
            const present = this.containsLinks(owner, [edge]);
            if (remove && present || !remove && !present) throw new DomainError('CONFLICT', 'Identity and party-role relationships are immutable; append a successor');
          }
        }
        const def = this.model.link(edge.type);
        if (!this.model.implements(edge.from.type, def.from.type) || !this.model.implements(edge.to.type, def.to.type)) failure('Link endpoint type mismatch');
        const historicalEdge = source.kind === 'task' && this.model.linkWritePolicy(edge.type) === 'source' && this.containsLinks(owner, [edge]);
        for (const ref of [edge.from, edge.to]) { this.raw(owner, ref, { remaining: 1 }, historicalEdge); touched.set(key(ref), ref); }
        if (remove) {
          changed = !!this.db.prepare(`DELETE FROM ${this.linkTable} WHERE ${this.owned()} AND type=? AND from_type=? AND from_id=? AND to_type=? AND to_id=?`).run(...this.ownerParameters(owner), edge.type, edge.from.type, edge.from.id, edge.to.type, edge.to.id).changes || changed;
        } else {
          const existing = this.db.prepare(`SELECT definition_digest FROM ${this.linkTable} WHERE ${this.owned()} AND type=? AND from_type=? AND from_id=? AND to_type=? AND to_id=?`).get(...this.ownerParameters(owner), edge.type, edge.from.type, edge.from.id, edge.to.type, edge.to.id);
          if (existing) this.assertLinkDefinition(edge.type, String(existing.definition_digest));
          const result = this.scoped
            ? this.db.prepare('INSERT OR IGNORE INTO ontology_scoped_links VALUES(?,?,?,?,?,?,?,?)').run(this.ontologyId, owner, edge.type, edge.from.type, edge.from.id, edge.to.type, edge.to.id, digest(def))
            : this.db.prepare('INSERT OR IGNORE INTO ontology_links VALUES(?,?,?,?,?,?,?)').run(owner, edge.type, edge.from.type, edge.from.id, edge.to.type, edge.to.id, digest(def));
          changed = !!result.changes || changed;
        }
      }
      for (const deletion of tombstones) {
        const current = this.raw(owner, deletion.ref, { remaining: 1 });
        if (current.revision !== deletion.expectedRevision) throw new DomainError('CONFLICT', 'Object revision changed before tombstone');
        const remaining = this.db.prepare(`SELECT DISTINCT type FROM ${this.linkTable} WHERE ${this.owned()} AND ((from_type=? AND from_id=?) OR (to_type=? AND to_id=?)) LIMIT 201`).all(...this.ownerParameters(owner), deletion.ref.type, deletion.ref.id, deletion.ref.type, deletion.ref.id);
        if (remaining.length > 200 || remaining.some(link => this.model.linkWritePolicy(String(link.type)) !== 'source')) throw new DomainError('CONFLICT', 'Remove all owned links explicitly before tombstoning an object');
        const row = this.db.prepare(`SELECT * FROM ${this.objectTable} WHERE ${this.owned()} AND type=? AND id=?`).get(...this.ownerParameters(owner), deletion.ref.type, deletion.ref.id)!;
        this.rememberVersion(owner, deletion.ref, current.revision, String(row.definition_digest), String(row.body), false, null);
        this.rememberVersion(owner, deletion.ref, current.revision + 1, String(row.definition_digest), String(row.body), true);
        this.db.prepare('INSERT INTO ontology_tombstones VALUES(?,?,?,?,?,?,?,?)').run(this.ontologyId, owner, deletion.ref.type, deletion.ref.id, current.revision + 1, String(row.definition_digest), String(row.body), source.observedAt);
        // Retain the original object behind protected audit edges. Normal reads
        // hide the tombstone; ledger navigation identifies it explicitly.
        this.db.prepare(`UPDATE ${this.objectTable} SET revision=? WHERE ${this.owned()} AND type=? AND id=?`).run(current.revision + 1, ...this.ownerParameters(owner), deletion.ref.type, deletion.ref.id);
        changed = true;
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
        if (deleted.has(key(ref)) || this.db.prepare('SELECT 1 FROM ontology_tombstones WHERE ontology_id=? AND owner=? AND type=? AND id=?').get(this.ontologyId, owner, ref.type, ref.id)) continue;
        for (const { link, side, direction } of this.model.sides(ref.type)) {
          // Optional, unbounded relationships have no cardinality condition to
          // violate. Declaring another such link must not add a database query
          // to every update of either endpoint.
          if (side.many && !side.required) continue;
          const prefix = direction === 'forward' ? 'from' : 'to';
          const count = Number(this.db.prepare(`SELECT count(*) AS n FROM ${this.linkTable} WHERE ${this.owned()} AND type=? AND ${prefix}_type=? AND ${prefix}_id=?`).get(...this.ownerParameters(owner), link.id, ref.type, ref.id)!.n);
          if ((!side.many && count > 1) || (side.required && count === 0)) failure('Relationship cardinality violation');
        }
        if (ref.type === 'Proposal') {
          const proposal = this.raw(owner, ref, { remaining: 1 });
          if (proposal.properties.kind === 'goal') {
            const contexts = this.db.prepare(`SELECT to_id FROM ${this.linkTable} WHERE ${this.owned()} AND type='ProposalExecutionContext' AND from_id=?`).all(...this.ownerParameters(owner), ref.id);
            if (contexts.length !== 1) failure('A whole-goal proposal requires its original execution context');
            const context = this.raw(owner, { type: 'ExecutionContext', id: String(contexts[0]!.to_id) }, { remaining: 1 });
            if (!context.properties.goal || context.properties.requestRevision !== proposal.properties.requestRevision) failure('Whole-goal proposal context does not carry the fixed goal revision');
          } else if (!["execution", "read_scope"].includes(String(proposal.properties.kind))) {
            const count = this.db.prepare(`SELECT count(*) AS n FROM ${this.linkTable} WHERE ${this.owned()} AND type='ProposalOffer' AND from_id=?`).get(...this.ownerParameters(owner), ref.id)!.n;
            if (count !== 1) failure('An offer selection requires exactly one selected offer');
          }
        }
        if (ref.type === 'Payment' || ref.type === 'AfterSalesCase') {
          const relations = ref.type === 'Payment' ? ['PaymentOrder', 'PaymentReservation'] : ['CaseOrder', 'CaseReservation'];
          const count = Number(this.db.prepare(`SELECT count(*) AS n FROM ${this.linkTable} WHERE ${this.owned()} AND from_type=? AND from_id=? AND type IN (?,?)`).get(...this.ownerParameters(owner), ref.type, ref.id, ...relations)!.n);
          if (count !== 1) failure('Business record requires exactly one original order or reservation');
        }
      }
      if (changed) this.bumpRevision(owner);
      this.security?.recordProjection(owner, batch, source);
      this.db.exec('RELEASE ontology_import');
    } catch (error) { this.db.exec('ROLLBACK TO ontology_import; RELEASE ontology_import'); throw error; }
  }
  private project(owner: string, object: StoredObject, target: string, select: string[] | undefined, budget: ReadBudget): ObjectView {
    const properties: Record<string, unknown> = {}, derived: NonNullable<ObjectView['derived']> = {};
    const guard = this.guard(), binding = guard?.requireObject(owner, object.ref, object.revision);
    const selected = select ?? Object.keys(this.properties(target)).filter(k => { const p = this.properties(target)[k]!; return !p.restricted && !p.derived; });
    for (const name of selected) {
      if(guard && authorizationScope()?.actor.actorKind==='worker' && responseOnlyProjection(object.ref.type,name)) {
        if(select?.includes(name))throw new SecurityError('INSUFFICIENT_ACCESS');continue;
      }
      const p = this.properties(target)[name];
      if (!p) failure('Unknown property');
      if (p.restricted) throw new DomainError('FORBIDDEN', 'Property is not available through the agent query interface');
      const actual = this.model.propertyName(object.ref.type, target, name);
      if (binding && !binding.fields.includes(actual)) {
        if(!(authorizationScope()?.integrity && guard!.integrityAllowed(object.ref.type,actual,binding.fields))) {
          if (select || authorizationScope()?.inference && guard!.fieldPolicy(object.ref.type,actual)!=='internal_only') throw new SecurityError('INSUFFICIENT_ACCESS');
          continue;
        }
      }
      if (p.derived) {
        const computation = guard ? guard.infer(owner, p.derived, () => deriveProperty(this, owner, object.ref, p.derived!, budget)) : deriveProperty(this, owner, object.ref, p.derived, budget);
        if (computation.status === 'known') properties[name] = computation.value;
        derived[name] = { status: computation.status, reason: computation.reason, functionRef: { id: p.derived, version: this.model.function(p.derived).version }, evidenceRefs: computation.evidenceRefs, evidenceLevels: computation.evidenceLevels };
      } else {
        const value=guard?guard.value(object.ref.type,actual,object.properties):object.properties[actual];
        if(value!==undefined) properties[name]=value;
      }
    }
    const value = { ...object, properties, ...(Object.keys(derived).length ? { derived } : {}) };
    // Interface names are projected from concrete policy fields, never a second
    // independently visible copy of a hidden concrete field.
    if (guard && target === object.ref.type) return guard.project(owner, value, select);
    if (guard) {
      const safe = guard.project(owner, { ...object, properties: Object.fromEntries(Object.entries(properties).map(([k,v]) => [this.model.propertyName(object.ref.type, target, k), v])) });
      value.properties = Object.fromEntries(Object.entries(properties).filter(([k]) => Object.hasOwn(safe.properties, this.model.propertyName(object.ref.type, target, k))));
    }
    return value;
  }
  query(owner: string, input: ObjectQuery, budget: ReadBudget = { remaining: 1000 }, readScope?: string): OntologyQueryResult {
    return this.security ? this.security.readSnapshot(() => this.queryRaw(owner,input,budget,readScope)) : this.queryRaw(owner,input,budget,readScope);
  }
  private queryRaw(owner: string, input: ObjectQuery, budget: ReadBudget, readScope?: string): OntologyQueryResult {
    const args = objectQuerySchema.parse(input);
    this.assertReaderOwner(owner);
    const networkQuery = 'object' in args ? isVirtualRef(args.object) : 'type' in args ? isVirtualRef({ type: args.type })
      : isVirtualRef(args.from) || networkLinkIds.has(this.model.navigation(args.from.type, args.link).link.id);
    if (networkQuery) return this.overlay(owner).query(args, budget);
    const guard = this.guard(), scope = guard?.scope(owner);
    const revision = this.revision(owner), queryDigest = digest({ ...args, cursor: undefined, ...(readScope ? { readScope } : {}) });
    let last: ObjectRef | undefined;
    if (args.cursor && guard) last = guard.cursor(owner, queryDigest, args.cursor) as ObjectRef;
    else if (args.cursor) {
      let cursor: z.infer<typeof cursorSchema>;
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(args.cursor, 'base64url').toString())); } catch { return failure('Invalid ontology cursor'); }
      if (cursor.owner !== digest(owner) || (cursor.ontologyId ?? 'eigos.business') !== this.ontologyId || cursor.query !== queryDigest || cursor.model !== this.model.ref.digest || cursor.revision !== revision) throw new DomainError('CONFLICT', 'Query context changed; restart the bounded query');
      last = cursor.last;
    }
    let target: string, sql: string, params: (string | number)[], historical = false;
    if ('object' in args) {
      guard?.requireObject(owner, args.object);
      this.raw(owner, args.object, budget);
      target = args.object.type;
      sql = `SELECT o.* FROM ${this.objectTable} o WHERE ${this.owned('o.')} AND o.type=? AND o.id=?`;
      params = [...this.ownerParameters(owner), args.object.type, args.object.id];
    } else if ('from' in args) {
      guard?.requireObject(owner, args.from);
      this.raw(owner, args.from, budget);
      const nav = this.model.navigation(args.from.type, args.link);
      historical = this.model.linkWritePolicy(nav.link.id) === 'source';
      if (guard && scope) guard.requireResource(scope, 'linkType', nav.link.id);
      target = nav.other.type;
      const side = nav.direction === 'forward' ? 'from' : 'to', other = nav.direction === 'forward' ? 'to' : 'from';
      const storedDefinitions = this.db.prepare(`SELECT DISTINCT definition_digest FROM ${this.linkTable} WHERE ${this.owned()} AND type=? AND ${side}_type=? AND ${side}_id=? LIMIT 201`).all(...this.ownerParameters(owner), nav.link.id, args.from.type, args.from.id);
      if (storedDefinitions.length > 200) throw new DomainError('CONFLICT', 'Relationship definition read bound exceeded');
      for (const stored of storedDefinitions) this.assertLinkDefinition(nav.link.id, String(stored.definition_digest));
      sql = `SELECT o.* FROM ${this.linkTable} l JOIN ${this.objectTable} o ON ${this.scoped ? 'o.ontology_id=l.ontology_id AND ' : ''}o.owner=l.owner AND o.type=l.${other}_type AND o.id=l.${other}_id WHERE ${this.owned('l.')} AND l.type=? AND l.${side}_type=? AND l.${side}_id=?`;
      params = [...this.ownerParameters(owner), nav.link.id, args.from.type, args.from.id];
    } else {
      target = args.type;
      const types = this.model.concreteTypes(target);
      sql = `SELECT o.* FROM ${this.objectTable} o WHERE ${this.owned('o.')} AND o.type IN (${types.map(() => '?').join(',')})`;
      params = [...this.ownerParameters(owner), ...types];
      if (args.currentDefinitionsOnly) {
        sql += ` AND (${types.map(() => '(o.type=? AND o.definition_digest=?)').join(' OR ')})`;
        params.push(...types.flatMap(type => [type, this.model.fingerprint(type)]));
      }

    }
    if (!historical) {
      sql += ' AND NOT EXISTS (SELECT 1 FROM ontology_tombstones deleted WHERE deleted.ontology_id=? AND deleted.owner=o.owner AND deleted.type=o.type AND deleted.id=o.id)';
      params.push(this.ontologyId);
    }
    if (guard && scope) {
      guard.requireResource(scope, this.model.isInterface(target) ? 'interface' : 'objectType', target);
      const bound = guard.predicate(owner, 'o', this.model.isInterface(target) ? [] : args.where.map(f => f.property),
        { types: this.model.concreteTypes(target), ...('object' in args ? { objectId: args.object.id } : {}) });
      sql += bound.sql; params.push(...bound.params);
    }
    const properties = this.properties(target);
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
      const object = { ref, revision: Number(row.revision), ...JSON.parse(String(row.body)) } as StoredObject;
      this.assertObjectDefinition(ref.type, String(row.definition_digest), object.properties);
      if (historical) {
        const deleted = this.db.prepare('SELECT revision,deleted_at FROM ontology_tombstones WHERE ontology_id=? AND owner=? AND type=? AND id=?').get(this.ontologyId, owner, ref.type, ref.id);
        if (deleted) object.tombstone = { revision: Number(deleted.revision), deletedAt: String(deleted.deleted_at) };
      }
      const binding = guard?.requireObject(owner, ref, object.revision);
      if (binding && args.where.some(f => !binding.fields.includes(this.model.propertyName(ref.type, target, f.property)))) throw new SecurityError('INSUFFICIENT_ACCESS');
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
    const cursor = hasMore && last ? guard ? guard.cursor(owner, queryDigest, undefined, last) as string : Buffer.from(JSON.stringify({ owner: digest(owner), ontologyId: this.ontologyId, query: queryDigest, model: this.model.ref.digest, revision, last })).toString('base64url') : undefined;
    if (this.revision(owner) !== revision) throw new DomainError('CONFLICT', 'Objects changed during query; retry against the current revision');
    return { model: this.model.ref, items, page: { limit: args.limit, scanned, hasMore, cursor }, datasetRevision: revision,
      ...('type' in args && args.currentDefinitionsOnly ? { definitionScope: 'current_definitions_only' } : {}) };
  }
  /** Single bounded relationship read for registered functions; never follows unlimited pages. */
  related(owner: string, from: ObjectRef, link: string, budget: ReadBudget): ObjectView[] | undefined {
    const result = this.query(owner, { from, link, limit: 50 }, budget);
    if (this.guard()) {
      const nav = this.model.navigation(from.type, link), side = nav.direction === 'forward' ? 'from' : 'to';
      // Completeness is used only inside trusted calculations, never returned as
      // a hidden neighbor count. Missing rows cannot imply a zero/full result.
      const total = Number(this.db.prepare(`SELECT count(*) AS n FROM ontology_links WHERE owner=? AND type=? AND ${side}_type=? AND ${side}_id=?`).get(owner, nav.link.id, from.type, from.id)?.n ?? 0);
      if (total !== result.items.length) return undefined;
    }
    return result.page.hasMore ? undefined : result.items;
  }
  evaluate(owner: string, input: unknown, budget: ReadBudget = { remaining: 1000 }) {
    return this.security?this.security.readSnapshot(()=>this.evaluateRaw(owner,input,budget)):this.evaluateRaw(owner,input,budget);
  }
  private evaluateRaw(owner: string, input: unknown, budget: ReadBudget) {
    this.assertReaderOwner(owner);
    const revision = this.revision(owner);
    const args = functionCallSchema.parse(input), definition = this.model.function(args.function);
    if (!definition.inputTypes.some(t => this.model.implements(args.object.type, t))) failure('Function requires its registered object type');
    const calculationStore = this.backingStore && !isVirtualRef(args.object) ? this.backingStore : this;
    const guard = this.guard();
    if(guard){const scope=guard.scope(owner);guard.requireResource(scope,'function',args.function);guard.requireResource(scope,'function',args.function,'function.invoke');guard.requireObject(owner,args.object);}
    let computation;
    try { computation = guard ? guard.infer(owner, args.function, () => evaluateFunction(calculationStore, owner, args, budget)) : evaluateFunction(calculationStore, owner, args, budget); }
    catch (error) {
      if (!guard || !(error instanceof SecurityError && ['INSUFFICIENT_ACCESS','AUTHORIZATION_REQUIRED','OUTPUT_NOT_ALLOWED'].includes(error.reason) || error instanceof DomainError && error.code === 'NOT_FOUND')) throw error;
      computation = { status: 'unknown' as const, reason: 'insufficient_access', evidenceRefs: [], evidenceLevels: [] };
    }
    const functionRef={id:definition.id,version:definition.version};
    const model=this.security?{id:this.model.ref.id,version:'authorized.v2',digest:digest({functionRef,access:accessDigest()})}:this.model.ref;
    const result = { ...computation,...(guard && computation.status==='known'?{value:projectFunctionValue(args.function,args.object.type,computation.value)}:{}), functionRef, model };
    if (Buffer.byteLength(JSON.stringify(result)) > 64000) throw new DomainError('CONFLICT', 'Function response limit exceeded; narrow the investigation');
    if (this.revision(owner) !== revision) throw new DomainError('CONFLICT', 'Objects changed during calculation; retry against the current revision');
    return result;
  }
}
